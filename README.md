# quest

A command-line tool for reading your own University of Waterloo academic record —
grades, class schedule, class search, and eventually transcript, holds and fees — from
[Quest](https://uwaterloo.ca/the-centre/quest).

Built so that scripts and AI agents can use it: every command supports `--json`
with a versioned schema, exits with meaningful codes, and **never prompts or
hangs**. If a human is genuinely required, it exits `77` and says so.

```console
$ quest grades --term w2026
Winter 2026 (1261)
standing: Good Standing

CLASS        DESCRIPTION                         UNITS  GRADE  POINTS
ABCD 100     Introduction to Something            0.50     88   44.00
ABCD 200     Something, Continued                 0.50     91   45.50
EFGH 150     An Elective                          0.50     79   39.50

3 courses, 1.50 units, 129.00 grade points
```

> [!IMPORTANT]
> **Unofficial.** Not affiliated with, endorsed by, or supported by the
> University of Waterloo. It works by driving a real browser against Quest's web
> interface, so a UW-side redesign can break it at any time.
>
> **For your own account only.** It is built for one person reading their own
> record. Do not point it at anyone else's credentials.

---

## Why a browser, not an API

UW's Open Data API covers the public course catalog — it has nothing about *your*
record. Grades, enrolment and transcripts exist only behind Quest's authenticated
web session, so this drives a real browser.

Duo 2FA is mandatory and stays that way. `quest` authenticates *through* Duo as
you would, then reuses Duo's 30-day "remember this device" trust so later runs
need no passcode. It does not bypass, weaken, or auto-approve any part of it, and
it never stores a passcode.

## Requirements

- **Rust** (stable; the toolchain is pinned in `rust-toolchain.toml`)
- **Node.js 22+**
- **macOS** — should work on Linux/Windows via the `keyring` crate's backends,
  but only macOS is tested
- A UW account with Duo enrolled

## Install

```sh
git clone https://github.com/LuhemRevorg/quest.git && cd quest
npm --prefix worker install     # downloads Playwright's Chromium (~150 MB)
npm --prefix worker run build
cargo build --release
```

The binary lands at `target/release/quest`.

> **Note on installing elsewhere:** the binary spawns the Node worker from
> `worker/dist/index.js`, found relative to the executable or the repo. `cargo
> install` alone will not work — either run from the repo, or set
> `QUEST_WORKER_JS=/path/to/worker/dist/index.js`.

## Quickstart

```sh
# One interactive login. A browser opens; type your password at the prompt and
# complete Duo yourself. Tick nothing else — it drives the rest.
quest auth login --username you@uwaterloo.ca --save-password

# Everything after this is non-interactive.
quest auth status
quest grades --term w2026 --json
```

On the first non-interactive run, macOS asks for Keychain access — choose
**"Always Allow"**, or every read will wait on that dialog. (`quest` bounds the
wait at 10s and exits `77` rather than hanging, but it can't succeed unattended
until access is granted. Rebuilding the binary can re-trigger the prompt.)

Your username must be the **full address** UW's ADFS expects
(`you@uwaterloo.ca`), not the bare 8-character userid.

## Commands

### `quest auth login`

Interactive, opens a real browser. The only command that ever waits on a human.
Run it about once a month, when Duo device trust lapses.

| Flag | |
| ---- | --- |
| `--username <USER@uwaterloo.ca>` | defaults to the saved value |
| `--save-password` | store the password in the OS keychain (required for unattended use) |
| `--duo-timeout <SECS>` | how long to wait for you at Duo (default 300) |

### `quest auth status`

Reports whether a session is usable and when Duo device trust expires. Never
prompts. **Always exits 0** — it is a report, and it answered the question.

### `quest auth refresh`

Establishes a session with no human involved, using the keychain password and Duo
device trust. Exits `77` the moment a human would be needed. This is what data
commands call internally; run it directly to check the unattended path works.

| Flag | |
| ---- | --- |
| `--timeout <SECS>` | give up after this long (default 60) |
| `--display <headless\|headed>` | `headed` opens a visible window, for watching it work |

### `quest auth logout`

Deletes the stored session. Idempotent.

| Flag | |
| ---- | --- |
| `--forget-password` | also remove the password from the OS keychain |

Note this discards Duo device trust too, so the next login needs a fresh passcode.

### `quest grades --term <TERM>`

One term's grades. Fully non-interactive.

`--term` accepts a UW code or a name — `1261`, `"Winter 2026"`, `winter2026`,
`w2026` are equivalent. The code is `(year - 1900) * 10 + {Winter 1, Spring 5,
Fall 9}`.

If the term isn't available, the error lists the ones Quest does offer.

### `quest schedule --term <TERM>`

The classes you are enrolled in for a term — including a term that has not started
yet, which `grades` cannot show. Fully non-interactive.

Lists each course with its status, units and grading basis, then every meeting
(component, section, days/times, room, instructor).

Quest only offers the **current and upcoming term** here; enrolment is not kept
historically. Ask for an older term and the error lists what is available — use
`grades` for terms that are over.

Same `--term`, `--timeout` and `--display` flags as `grades`.

### `quest search --term <TERM> --subject <SUBJECT> --number <NUMBER>`

Which sections of a course run in a term — the catalog, not your record, so it
works for courses you are not enrolled in. This is Quest's *Search for Classes*,
reached the same way a human reaches it (Class Schedule → Search for Classes).
Fully non-interactive.

```console
$ quest search --term f2026 --subject CS --number 246
Fall 2026 (1269) — CS 246

ABCD 100 — Placeholder Course Title
  001 LEC  4382   MWF 10:30AM - 11:20AM     MC 4021        Instructor Name      Open
  002 TUT  4383   TTh 2:30PM - 3:20PM       MC 2054        Instructor Name      Closed

1 courses, 2 sections
```

Both `--subject` and `--number` are required: Quest's search demands at least two
criteria beyond the term, so a subject on its own is rejected by the page itself.
The number is matched with *is exactly* — `246` will not return 1246.

If nothing matches, that is a successful run reporting Quest's own message, not an
error. Same `--term`, `--timeout` and `--display` flags as `grades`.

> [!NOTE]
> The selectors behind this command are the stock PeopleSoft class-search names and
> have **not yet been confirmed against UW's live page** — every other read here has
> been. If it fails, it fails loudly and says which fields the page actually had;
> run it once with `QUEST_DEBUG_DUMP_DIR=/tmp/quest-dump` and the saved markup has
> everything needed to correct it. See [ADR 0007](docs/adr/0007-searching-for-classes.md).

### Global

`--json` prints a single JSON document on stdout, with `schema_version` for
pinning. Progress and errors go to stderr, so stdout stays clean for piping.

## Exit codes

Stable, and safe to branch on.

| Code | Meaning |
| ---- | ------- |
| 0  | success |
| 1  | generic failure |
| 2  | usage error |
| 66 | input was required but stdin is not a terminal |
| 67 | credentials rejected |
| 69 | session worker or browser unavailable |
| 70 | a Quest page failed to parse — Quest probably changed |
| 75 | timed out waiting for Duo; retryable |
| 77 | **`NEEDS_REAUTH`** — a human must run `quest auth login` |
| 78 | config or profile-directory problem |

In `--json` mode, failures print `{"error": …, "exit_code": …, "needs_reauth": …}`
to stderr, so a caller never has to parse prose.

## What is stored, and where

| What | Where | Notes |
| ---- | ----- | ----- |
| Browser profile | `~/Library/Application Support/ca.uwaterloo.quest/profile` | `0700`, checked on every use |
| Config (username, preferences) | `…/config.toml` | `0600`, no secrets |
| Password | OS keychain, service `ca.uwaterloo.quest` | opt-in only |
| Duo passcodes | **nowhere** | never stored or cached |

Override the location with `QUEST_DATA_DIR`.

**The profile directory and the keychain entry together grant 30 days of
unattended access to your full record.** Treat them as you would a password.
`quest auth logout --forget-password` revokes both. The profile is gitignored and
should never be synced to cloud storage.

Other guarantees, by design:

- **Official transcripts are never ordered** — that's a paid ($20) request.
- **Mutations** (enrol/drop, not yet implemented) will be dry-run by default and
  require an explicit confirmation token, with every change appended to a local
  audit log.

## Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| exit `77`, "no stored password" | run `auth login --save-password` |
| exit `77`, Duo wants a passcode | device trust lapsed; run `auth login` |
| exit `77`, keychain timeout | the macOS dialog is waiting — answer it, choose "Always Allow" |
| exit `70`, "may have changed" | Quest changed its markup; please [open an issue](https://github.com/LuhemRevorg/quest/issues) |
| exit `69`, worker not built | `npm --prefix worker install && npm --prefix worker run build` |
| `sso: not persisted` in `status` | **normal.** UW disables ADFS keep-me-signed-in |

Every command takes ~10–20s, because no Quest session survives between
invocations and each run re-walks the full sign-in chain. That is a property of
the identity stack, not a bug — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | `auth login` / `status` / `refresh` / `logout` | ✅ done |
| 2 | first read command (`grades`) | ✅ done |
| 3 | `schedule` done, `search` pending live verification; unofficial transcript, holds, fees | in progress |
| 4 | enrol / drop, behind dry-run + confirmation tokens | planned |
| 5 | MCP server exposing the same core library to agents | planned |

## Contributing

Read [ARCHITECTURE.md](ARCHITECTURE.md) first — particularly the decision records
in `docs/adr/`, which document the wrong turns as well as the conclusions.

```sh
cargo test --workspace       # protocol contracts, exit codes, term codes
npm --prefix worker test     # page classification and parsers, against fixtures
```

Set `QUEST_DATA_DIR` to a throwaway directory so development never touches a real
session.

Parsers are tested against saved pages in `fixtures/`, so a UW-side change shows
up as a red test rather than a wrong grade. If you add a fixture, sanitize it
first — [fixtures/README.md](fixtures/README.md) has the rules, and anything
captured past sign-in must have its record replaced, not just its identifiers.

## License

MIT — see [LICENSE](LICENSE).
