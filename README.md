# quest

A personal CLI for reading and managing my own University of Waterloo academic
record through Quest. Single user, local only, my own account.

There is no API for personal student data — UW's Open Data API covers the public
course catalog only. Grades, enrollment, and transcripts exist solely behind
Quest's authenticated web session (PeopleSoft / Oracle Campus Solutions. So this
is a browser-automation project, not an HTTP-client project.

Duo 2FA is mandatory and stays that way. The design authenticates *through* Duo
like a human, then persists Duo's 30-day device trust so later runs need no
passcode. It does not persist a Quest session — that turns out to be impossible
(ADR 0003).

## Status: Phase 2 — first read command working

```
quest auth login     # interactive, headed; you type the Duo passcode
quest auth status    # is the session live? when does device trust expire?
quest auth refresh   # non-interactive re-auth; exit 77 if a human is needed
quest auth logout    # clear the persisted session
quest grades --term <t> [--json]    # one term's grades, fully non-interactive
```

`--term` takes a code or a name: `1261`, `"Winter 2026"`, `winter2026`, `w2026`.
UW's code is `(year - 1900) * 10 + {Winter 1, Spring 5, Fall 9}`, computed rather
than scraped — no code appears in Quest's markup.

`refresh` is a fourth command beyond the three originally scoped, added because
UW disables ADFS keep-me-signed-in — see [ADR 0003](docs/adr/0003-what-actually-persists.md).
Without it, "reuse the persisted session, never prompt" isn't achievable on this
identity stack. Phase 2's data commands call the same path.

All four commands are verified end to end against the live service, including
`refresh` completing the whole sign-in chain **headless and unattended** — no window
exists during that run, so nothing could have been clicked by hand.

Decisions are recorded in
[ADR 0001](docs/adr/0001-rust-cli-with-node-session-worker.md) (language split),
[ADR 0002](docs/adr/0002-quest-auth-chain.md) (the auth chain, and why page
detection works the way it does), and
[ADR 0003](docs/adr/0003-what-actually-persists.md) (what actually persists, and
why the password is in the keychain), and
[ADR 0004](docs/adr/0004-the-post-duo-sso-handoff.md) (the post-Duo handoff — four
wrong diagnoses and what finally found the answer), and
[ADR 0005](docs/adr/0005-reading-grades.md) (reading grades, and why id-based
scraping beats column positions).

## The sign-in chain

```
quest.pecs.uwaterloo.ca/psp/SS/…   PeopleSoft
  └─ SAML ─▶ adfs.uwaterloo.ca     username screen   (#nextButton; password field hidden)
               └─ ─▶               password screen   (#submitButton)
                      └─ ─▶ Duo    second factor — passes silently on device trust
                             └─ ─▶ ?cmd=login        SSO handoff — follow the IdP link
                                    └─ ─▶ back into Quest
```

Two traps in there, both cost real debugging time:

- Both ADFS buttons are `<span role="button">`, not `<input type=submit>`, and only
  one is visible per screen (`#nextButton`, then `#submitButton`).
- The `?cmd=login` page's way into Quest is an anchor,
  `<a href="javascript:getIdPLink()">Sign In</a>`. The local login form on that same
  page has its submit deliberately suppressed (`ui-btn-hidden`) because this
  deployment is SSO-only — clicking *that* posts empty credentials and returns
  `errorCode=105`. See [ADR 0004](docs/adr/0004-the-post-duo-sso-handoff.md).

Because the chain is staged, `worker/src/handlers/login.ts` drives a loop keyed on
whatever is currently on screen rather than filling a single form — which is what
makes it tolerant of extra or reordered screens.

Note `quest.uwaterloo.ca` (without `.pecs`) now redirects to a marketing page;
the service moved.

Quest's own session cookie is **session-scoped** — it cannot be persisted, since
closing the browser context is what flushes the profile to disk. So every command
re-establishes the session by walking that chain on the way in. What gets
persisted is the ability to do that *silently*, in two independent layers:

| Layer | Grants | Status at UW |
| ----- | ------ | ------------ |
| Duo device trust (`browsertrust\|…`) | 30 days without a passcode | ✅ works |
| ADFS keep-me-signed-in | no password prompt | ❌ **disabled by UW** |

`status` reports both. The second being unavailable is why the password has to
live in the keychain: it is the only remaining human step, and it recurs on every
command rather than monthly.

So the working model is: **keychain password + Duo device trust = 30 days
unattended.** When device trust lapses, commands exit 77 and a human runs
`quest auth login` once. That is the ~monthly human touch the design wanted,
just anchored on Duo's cookie instead of a session cookie.

## Layout

```
crates/quest-core/       domain model, config, keychain, worker transport
  src/session/           protocol.rs  <-- wire contract, keep in sync with TS
  src/model/             typed, --json-serializable output types
crates/quest-cli/        clap surface, output, exit codes  (binary: `quest`)
worker/                  Node + Playwright session worker
  src/protocol.ts        <-- other half of the wire contract
  src/quest.ts           every sign-in URL/selector, in one place
  src/grades.ts          the grades route + field ids, in one place
fixtures/                sanitized HTML + HAR for parser tests
docs/adr/                decisions
```

## Architecture

Three layers:

1. **Session** — Playwright `launchPersistentContext` against a fixed
   user-data dir. ~80% of the risk; hardened first.
2. **Transport** — replay PeopleSoft `ICAJAX` postbacks captured from a HAR in
   preference to DOM scraping. Scrape only where necessary.
3. **Domain + output** — typed structs, `--json` with a versioned schema,
   meaningful exit codes, and no prompting outside `auth login`.

### Auth model

Authentication is split from work. `auth login` is interactive and rare
(~monthly); every other command is fully non-interactive and never prompts. If a
human is required they exit `77` (`NEEDS_REAUTH`) so an agent knows to stop —
rather than hanging.

**What the CLI lives on is the ability to re-authenticate silently, not a
persisted session.** Quest's session cookie is session-scoped and cannot survive,
so every command re-walks the sign-in chain; what makes that unattended is the
keychain password plus Duo's 30-day device trust. When the trust lapses, a human
runs `auth login` once. See [ADR 0003](docs/adr/0003-what-actually-persists.md) —
this replaces the original "the persisted session is the credential" model.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0  | success |
| 1  | generic failure |
| 2  | usage error |
| 66 | input was required but stdin is not a terminal |
| 67 | WatIAM rejected the credentials |
| 69 | session worker / browser unavailable |
| 70 | a Quest page failed to parse — Quest probably changed |
| 75 | timed out waiting for Duo; retryable |
| 77 | `NEEDS_REAUTH` — no usable session, a human must log in |
| 78 | config or profile-dir problem |

`auth status` exits **0** whether the session is live or dead — it is a report,
and it answered the question. Exit 77 is for commands that needed a session and
could not proceed.

## Security

- **The profile dir is the crown jewel** — a bearer token for the entire student
  record. `0700`, verified on every use, never cloud-synced, gitignored.
- **The password is stored in the OS keychain**, opt-in via
  `auth login --save-password`, using the `keyring` crate — never a dotfile, never
  plaintext. This is a change from the original "don't store it" default, forced by
  UW disabling ADFS keep-me-signed-in; the reasoning is in ADR 0003.
  Consequence, stated plainly: the keychain entry and the profile dir *together*
  grant 30 days of unattended access to the full record. `auth logout
  --forget-password` revokes both.
- **Duo passcodes are never stored, cached, or automated.** No push
  auto-approval, no MFA-fatigue tricks, no bypass.
- **Mutations** (phase 4) are dry-run by default, require a confirmation token an
  agent cannot self-generate (`--confirm-drop CS486`), and append to an audit log.
- **Official transcripts are never automated** — that's a paid ($20) order.

## Development

```sh
npm --prefix worker install      # installs Playwright + Chromium
npm --prefix worker run build    # the Rust side spawns worker/dist/index.js
cargo build

cargo test --workspace           # wire-protocol contract tests
npm --prefix worker test         # fixture + cookie-logic tests
```

Point `QUEST_DATA_DIR` at a throwaway directory to avoid touching the real
session profile while developing.

| Variable | Effect |
| -------- | ------ |
| `QUEST_DATA_DIR` | relocate config + profile |
| `QUEST_WORKER_JS` | override worker discovery |
| `QUEST_NODE` | override the node binary |
| `QUEST_DEBUG_COOKIES=1` | print the cookie jar — names, domains, expiries; never values |
| `QUEST_DEBUG_PAGES=1` | print per-tick page classification and selector visibility |
| `QUEST_DEBUG_DUMP_DIR` | save the HTML of a page the sign-in stalled on |

### Verifying the unattended path

```sh
export QUEST_DATA_DIR=/tmp/quest-dev
cargo run -- auth login --username you@uwaterloo.ca --save-password
cargo run -- auth refresh          # must reach `live` with no prompt at all
```

`login` opens a browser; type your password at the terminal prompt (so it reaches
the keychain) and complete Duo yourself if asked. `refresh` then proves the
unattended path: headless, no prompt, `live` on success or exit 77.

**On the first `refresh`, macOS shows a Keychain access dialog — choose "Always
Allow."** Otherwise every read waits on that prompt. `refresh` bounds the read at
10s and exits 77 rather than hanging, but until access is granted it can never
succeed unattended. Rebuilding the binary can re-trigger the dialog, since the ACL
is tied to the signed binary.

Expect `sso: not persisted` in `status` — that is normal here, not a failure.
