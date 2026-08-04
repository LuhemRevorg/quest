# Architecture

How `quest` is put together and why. If you only want to *use* the CLI, see
[README.md](README.md).

---

## The constraint that shapes everything

There is no API for personal student data. UW's Open Data API covers the public
course catalog only — grades, enrolment and transcripts exist solely behind
Quest's authenticated web session (PeopleSoft / Oracle Campus Solutions).

So this is a **browser-automation project, not an HTTP-client project**. Every
design decision downstream follows from that, and from a second constraint: Duo
2FA is mandatory and stays that way. The tool authenticates *through* Duo as a
human would, then reuses Duo's 30-day device trust. It does not bypass, weaken or
auto-approve anything.

## Three layers

1. **Session** — Playwright `launchPersistentContext` against a fixed user-data
   dir. This is where nearly all the risk lives, so it was built and hardened
   first.
2. **Transport** — getting a page's data out of PeopleSoft. Currently DOM reads
   keyed on element ids; see [Transport](#transport) for why not `ICAJAX` replay.
3. **Domain + output** — typed structs, `--json` with a versioned schema,
   meaningful exit codes, and no prompting outside `auth login`.

## Process split: Rust CLI + Node worker

The CLI and domain model are Rust. The browser is driven by a small Node process,
because Playwright's Rust bindings are unmaintained and hand-rolling
persistent-context and iframe handling over raw CDP would put custom code in the
riskiest layer.

```
┌───────────────────────────┐   newline-delimited JSON    ┌──────────────────────┐
│ quest (Rust)              │  ───── stdin/stdout ─────▶  │ worker (Node)        │
│  clap, config, keychain,  │  ◀────────────────────────  │  Playwright, Chromium│
│  exit codes, parsing      │                             │  sign-in chain       │
└───────────────────────────┘                             └──────────────────────┘
```

**stdio, not a unix socket** — no socket file for another local process to
connect to, and the worker's lifetime is exactly the parent's, so no orphaned
Chromium is left holding a lock on the profile dir.

The wire format is one contract in two files, which must be changed together:

- `crates/quest-core/src/session/protocol.rs`
- `worker/src/protocol.ts`

Rust-side tests pin the exact JSON each request serializes to, so drift between
the halves fails the build rather than a live run.

## Layout

```
crates/quest-core/       domain model, config, keychain, worker transport
  src/session/           protocol.rs  ← wire contract, keep in sync with TS
  src/model/             typed, --json-serializable output types
crates/quest-cli/        clap surface, output, exit codes  (binary: `quest`)
worker/                  Node + Playwright session worker
  src/protocol.ts        ← other half of the wire contract
  src/quest.ts           every sign-in URL/selector, in one place
  src/peoplesoft.ts      navigation shared by every self-service page
  src/grades.ts          the grades route + field ids
  src/schedule.ts        the class-schedule route + field ids
  src/search.ts          the class-search route, field ids + form driving
  src/transcript.ts      the unofficial-transcript route + the paid-order guards
  src/handlers/          one file per operation
fixtures/                sanitized HTML for parser tests
docs/adr/                decisions, including the wrong turns
```

Quest-specific selectors are deliberately confined to `quest.ts`, `grades.ts`,
`schedule.ts`, `search.ts` and `transcript.ts`, so a UW-side change has exactly one
place to be fixed.

---

## The sign-in chain

```
quest.pecs.uwaterloo.ca/psp/SS/…   PeopleSoft
  └─ SAML ─▶ adfs.uwaterloo.ca     username screen   (#nextButton; password field hidden)
               └─ ─▶               password screen   (#submitButton)
                      └─ ─▶ Duo    second factor — passes silently on device trust
                             └─ ─▶ ?cmd=login        SSO handoff — follow the IdP link
                                    └─ ─▶ back into Quest
```

It is **staged**, not one form, so `worker/src/handlers/login.ts` drives a loop
keyed on whatever is currently on screen rather than filling a single page. That
is what makes it tolerant of extra or reordered screens.

Three things in that chain cost real debugging time:

- `quest.uwaterloo.ca` (no `.pecs`) now redirects to a marketing page. Hitting it
  returns a valid 200 that says nothing about your session — indistinguishable
  from expiry unless the classifier refuses to guess.
- Both ADFS buttons are `<span role="button">`, not `<input type=submit>`, and
  only one is visible per screen.
- The `?cmd=login` page's way into Quest is an anchor,
  `<a href="javascript:getIdPLink()">Sign In</a>`. The local login form on the
  same page has its submit deliberately suppressed (`ui-btn-hidden`) because this
  deployment is SSO-only — clicking *that* posts empty credentials and returns
  `errorCode=105`.

### Page classification

`classifyPage` returns `authenticated` / `login` / `duo` / `unknown`, matching on
element **presence**, not visibility, and checking Quest's own markers first.

Presence, because ADFS ships its password field hidden and reveals it with its own
CSS/JS — a visibility test would call the live sign-in page `unknown` and would
make offline fixture tests impossible. Quest's markers are checked first so a
hidden password field somewhere inside Quest can never read as "logged out"; a
test asserts no sign-in fixture contains those markers.

`unknown` is an error, never a guess. Reporting a dead session as live, or nagging
for a re-login that isn't needed, are both worse than exiting non-zero.

## What actually persists

Quest's session cookie is **session-scoped**. It cannot be persisted, because
closing the browser context is what flushes the profile to disk. So every command
re-walks the sign-in chain on the way in.

What gets persisted is the ability to do that *silently*, in two independent
layers:

| Layer | Grants | Status at UW |
| ----- | ------ | ------------ |
| Duo device trust (`browsertrust\|…`) | 30 days without a passcode | ✅ works |
| ADFS keep-me-signed-in | no password prompt | ❌ **disabled by UW** |

The second is shipped but wrapped in a server-rendered `display:none`, so no
persistent SSO cookie is obtainable and a password is required on *every*
re-authentication — not monthly. That is the entire reason the password lives in
the OS keychain.

**Working model: keychain password + Duo device trust = 30 days unattended.**
When device trust lapses, commands exit 77 and a human runs `auth login` once.

This replaces an earlier, wrong model ("the persisted session is the credential").

## Auth model

Authentication is split from work. `auth login` is interactive and rare; every
other command is fully non-interactive and never prompts. If a human is required,
they exit `77` so an agent knows to stop rather than hanging.

`withSession` in `worker/src/handlers/login.ts` is the shape every data command
uses: sign in, hand the authenticated context to a body, tear down. Because the
Quest session cannot outlive the process, a command authenticates and does its
work inside one browser lifetime, or not at all.

The keychain is not a plain data store: on macOS a read from a binary without
granted access pops a `SecurityAgent` dialog and blocks indefinitely. Non-blocking
callers use `credentials::get_password_non_blocking`, which reads on a worker
thread with a 10-second deadline and reports a timeout as `NEEDS_REAUTH`.

## Transport

The original intent was replaying PeopleSoft `ICAJAX` postbacks captured from a
HAR, in preference to DOM scraping. In practice, reads are DOM-based — but keyed
on element **ids**, not column positions.

PeopleSoft ids are `record.field` names (`STDNT_ENRL_SSV1_CRSE_GRADE_OFF$N`), so
they survive a column being added or reordered. Column positions do not, which is
how a prior community GPA tool died on a transcript revamp.

Postback replay buys nothing for a page like grades: reaching the grid already
requires a real session, a tile click and a postback, and the grid then arrives as
ordinary HTML with stable ids. Replaying would mean reproducing `ICSID` /
`ICStateNum` handling for no robustness gain. It remains the right call for
anything with pagination or heavy state.

Not every read is a DOM read. The transcript is a *file* PeopleSoft generates and
delivers out-of-band, so `transcript` watches three channels at once — a
`download` event, a PDF response body, and a popup URL refetched through the
context — and saves the bytes verbatim rather than parsing them. Headless
Chromium has no PDF viewer, so in the default mode a PDF popup arrives as a
download; the other two channels exist for headed runs and as a fallback. The
bytes cross the worker protocol base64-encoded and Rust writes the file `0600`,
which keeps the permission discipline in one language and lets a bad output path
fail before the browser starts. See ADR 0008.

PeopleSoft's DOM is otherwise hostile: content sits inside nested
`ptifrmtgtframe` / `main_target_win0` iframes, ids contain `$`, and controls are
`<span role="button">` or `<a href="javascript:…">` rather than form elements.

**Prefix-matching those ids is a trap**, and has now caused three separate bugs —
`DERIVED_…_DESCR$N$` colliding with a one-off element at N=5, `MTG_SECTION$N` also
matching `MTG_SECTION$span$N`, and a term label read from a present-but-empty
element. Match an exact suffix (`/^MTG_SECTION\$\d+$/`) and assert the result in a
fixture test.

Pages also nest: the class schedule is a container per course, each holding a
meeting grid whose row indices are **page-global**, not per course. Collect child
rows by walking the container's subtree; index arithmetic passes for
single-meeting courses and mis-groups the first lecture-plus-tutorial it meets.

## Correctness guards

Silently-wrong data is the worst outcome, worse than an error, so several checks
exist specifically to make wrongness loud:

- **Term confirmation** — the grades page must state the term it rendered, and it
  is compared against the request. A stale postback would otherwise return another
  term's marks under the requested heading.
- **Criteria confirmation** — the class search reads its own form back before
  pressing Search, because the term postback can re-render it between the write and
  the click. Searching on criteria the form is not holding returns real, plausible,
  wrong classes under the heading we asked for.
- **Never submit a credential form we did not fill.** An interstitial safe to
  click through is one with *no* credential field present in the DOM — presence,
  not visibility. Posting a hidden, unfilled login form produced a real failed
  sign-in against the account.
- **Never press a control on a page we cannot identify.** The generalisation of
  the above, and what makes `transcript` safe: Quest's *official* transcript is a
  paid ($20) order on a near-identical page next to the unofficial one, so the
  content frame's URL must name `SSR_TSRQST_UNOFF` immediately before any click,
  and any control whose label describes placing an order is refused. Note the guard
  is on the component's identity, never on the word "official" in a label — the
  unofficial page's own report types are named "Undergrad Official" and similar,
  and an early version filtered those out and so refused the only option that
  works. The only guard here that protects against an irreversible action rather
  than wrong output. See ADR 0008.
- **`unknown` pages are errors**, never a default.

## Testing

Quest changes break scrapers silently, so parsers are tested against saved real
pages in `fixtures/`. A UW-side change should surface as a red test, not as a
wrong grade.

| Suite | What it covers |
| ----- | -------------- |
| `cargo test --workspace` | wire-protocol shapes, exit-code mapping, term codes, typing |
| `npm --prefix worker test` | page classification and parsers, against fixtures |

Two real bugs were caught only by the fixture tests, both of which would have
produced quietly wrong output: a class column read from an element that exists
once and collided at row 5, and a term-confirmation guard reading an element that
is present but empty, leaving the guard permanently inert.

Fixtures are sanitized — see [fixtures/README.md](fixtures/README.md). Anything
captured past sign-in has its record replaced, not just its identifiers.

**`transcript` is the exception, and knows it.** A transcript fixture would be a
complete academic record, so there is none; its tests drive synthetic pages through
Playwright instead, and cover the parts where being wrong is expensive — the
paid-order guard, the component check, report-type selection, and the format sniff
that keeps a sign-in page from being saved as a transcript. `search` is the other
exception, for a different reason: hand-built fixtures, because no capture existed
when it was written (ADR 0007).

## Development

```sh
npm --prefix worker install      # installs Playwright + Chromium
npm --prefix worker run build    # the Rust side spawns worker/dist/index.js
cargo build

cargo test --workspace
npm --prefix worker test
```

Point `QUEST_DATA_DIR` at a throwaway directory so development never touches a
real session profile.

| Variable | Effect |
| -------- | ------ |
| `QUEST_DATA_DIR` | relocate config + profile |
| `QUEST_DOWNLOAD_DIR` | where `transcript` saves with no `--output` (default: the OS Downloads folder) |
| `QUEST_WORKER_JS` | override worker discovery |
| `QUEST_NODE` | override the node binary |
| `QUEST_DEBUG_COOKIES=1` | print the cookie jar — names, domains, expiries; never values |
| `QUEST_DEBUG_PAGES=1` | print per-tick page classification and selector visibility |
| `QUEST_DEBUG_DUMP_DIR` | save the HTML of each distinct page the sign-in reaches |

`QUEST_DEBUG_DUMP_DIR` writes `0600` files into a `0700` directory. Dumps taken
past sign-in contain the full student record — treat them accordingly and delete
them when done.

### Adding a read command

Every remaining read should be a route plus a field table:

1. Find the route with `QUEST_DEBUG_PAGES=1` and a dump. **Read the page before
   theorising about it** — see ADR 0004 and 0005 for what skipping that costs.
2. Put selectors in one module, keyed on element ids.
3. Save a sanitized fixture and write parser tests against it.
4. Add the op to both halves of the protocol; the Rust contract test will fail
   until they agree.
5. Add the typed model and the CLI command.

## Decision records

The ADRs record the wrong turns as well as the conclusions, because the wrong
turns are the expensive part to rediscover.

| ADR | Subject |
| --- | ------- |
| [0001](docs/adr/0001-rust-cli-with-node-session-worker.md) | Rust CLI + Node session worker, and the stdio split |
| [0002](docs/adr/0002-quest-auth-chain.md) | The auth chain, and why page detection works the way it does |
| [0003](docs/adr/0003-what-actually-persists.md) | What actually persists, and why the password is in the keychain |
| [0004](docs/adr/0004-the-post-duo-sso-handoff.md) | The post-Duo handoff — four wrong diagnoses and what found the answer |
| [0005](docs/adr/0005-reading-grades.md) | Reading grades, and why id-based scraping beats column positions |
| [0006](docs/adr/0006-reading-the-class-schedule.md) | Reading the class schedule, and the shared-navigation extraction |
| [0007](docs/adr/0007-searching-for-classes.md) | Searching for classes — the first page we write to, and unverified selectors |
| [0008](docs/adr/0008-downloading-the-unofficial-transcript.md) | Downloading the unofficial transcript, and the guards around a paid page |

## Status and roadmap

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | `auth login` / `status` / `refresh` / `logout` | done, verified end to end |
| 2 | first read command (`grades`) | done |
| 3 | `schedule` and `transcript` done, `search` pending live verification; holds, fees | in progress |
| 4 | enrol / drop, behind dry-run + confirmation tokens + audit log | not started |
| 5 | MCP server over the finished core library | not started |

Known gaps:

- **No lock around the profile dir.** Two concurrent commands both open the same
  Chromium profile; nothing broke in testing, but concurrent writes to that cookie
  DB could lose the device-trust cookie. An advisory lock is the fix.
- **Every command pays a full sign-in** (~10–20s), since no session survives the
  process. A long-lived worker holding one authenticated context would amortise
  it.
- **`--interactive` is not implemented.** It would be inert today; it lands with
  the first command that can actually be gated by it.
