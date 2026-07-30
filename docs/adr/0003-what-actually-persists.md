# ADR 0003 — What actually persists between logins

Status: accepted
Date: 2026-07-29

## Context

The design's mental model was "the persisted session is the credential the CLI
lives on". A real login on 2026-07-29 showed that is not quite how it works, and
the difference matters.

The cookie jar after a successful interactive login, via
`QUEST_DEBUG_COOKIES=1`:

```
api-*.duosecurity.com   browsertrust|<device>|<org>   → +30 days
api-*.duosecurity.com   trc| lam| hac| fsc|           → +1 year and beyond
.pecs.uwaterloo.ca      PS_DEVICEFEATURES             → +1 year
.pecs.uwaterloo.ca      CSPRPDB-PORTAL-PSJSESSIONID   → session
.pecs.uwaterloo.ca      X-Oracle-BMC-LBS-Route        → session
(no adfs.uwaterloo.ca cookies at all)
```

Two things follow.

**Quest's session cookie cannot be persisted.** `PSJSESSIONID` is
session-scoped, so Chromium discards it when the context closes — and the context
*must* close, because closing it is what flushes the profile to disk. No amount
of care in the session layer will make the Quest session itself survive.

**So the thing worth persisting is the ability to re-authenticate silently**, and
that lives in two independent cookies:

| Layer | Cookie | Grants | Absent means |
| ----- | ------ | ------ | ------------ |
| Duo device trust | `browsertrust\|…` | 30 days without a passcode | a human must complete Duo |
| ADFS SSO | `MSISAuth*` | no password prompt | a human must type a password |

In the observed login the Duo cookie persisted but **the ADFS cookie did not** —
keep-me-signed-in was not in effect. That state is a trap: it looks like a
successful login, and Duo will not challenge again for 30 days, yet the very next
command still needs a human, because the password step comes back.

## Decisions

**Every command begins by navigating to Quest and letting SSO re-establish the
session.** This is not a fallback, it is the normal path. `gotoAndSettle` waits
out the SAML redirect chain (`networkidle`, since some hops are auto-submitting
forms rather than 302s) before classifying, so a chain that completes silently is
not mistaken for a dead session.

**`login` retries ticking `#kmsiInput` for as long as the form is up**, not once
on the first page it classifies — including while the human is still typing their
password. It is also ticked before submitting when we own the password, since
posting the form settles the question.

**`AuthStatus` reports the two layers separately**, as `device_trust_expires_at`
and `sso_expires_at`. Collapsing them hides exactly the failure above.

**`login` warns when it finishes with no persistent SSO cookie.** Signed in now,
unable to sign in again unattended, is worth saying out loud.

## Consequences

- `device_trust_expires_at` is now read from `browsertrust|` alone. The earlier
  looser pattern also matched `trc|`/`hac|`, reporting trust into 2027 when the
  real answer was 30 days.
- Commands pay a few redirects of latency on every invocation. Acceptable, and
  unavoidable given a session-scoped `PSJSESSIONID`.
- `NEEDS_REAUTH` should be raised only after the silent re-auth attempt has
  failed, not on first sight of an IdP page.

## Addendum, same day: UW disables keep-me-signed-in

Confirmed from the login run and the saved fixture. The markup ships, but wrapped
in a server-rendered hidden container:

```html
<div id="kmsiArea" style="display:none">
  <input type="checkbox" name="Kmsi" id="kmsiInput" …/>
```

So **no persistent ADFS SSO cookie is obtainable**, and a password is required on
every re-authentication — not monthly, but on every command, since
`PSJSESSIONID` cannot persist.

That falsifies the premise behind the original "don't store the password"
default, which was that a cold login is monthly and the passcode is being typed
anyway. The remaining chain is:

```
Quest → ADFS (password) → Duo (silent, browsertrust valid) → Quest
              ↑ the only human step
```

**Decision (owner's call, 2026-07-29): store the password in the OS keychain and
re-authenticate silently.** With the password in Keychain and Duo device trust
valid, the whole chain runs unattended for 30 days; after that Duo wants a
passcode and commands exit 77.

This adds a fourth auth command, `quest auth refresh` — non-interactive, headless,
never prompts, exits 77 the moment a human would be needed. Data commands in
Phase 2 call the same path. It is a deliberate addition to the Phase 1 surface:
without it, "reuse the persisted session, never prompt" is not achievable on this
identity stack, and Phase 1's exit criteria could not be met.

Security consequence, stated plainly: the Keychain entry and the profile dir
*together* grant 30 days of unattended access to the full student record. Both are
crown jewels now, not just the profile dir. `auth logout --forget-password`
revokes both.

### The keychain is not a plain data store

Storing the password introduced a hang, found immediately: on macOS a read from a
binary that has not been granted access pops a `SecurityAgent` dialog and blocks
until somebody clicks it. `auth refresh` sat indefinitely on an invisible prompt —
exactly the failure the non-interactive contract exists to prevent, and worse than
a wrong answer, because an agent waits forever.

So non-interactive callers use `credentials::get_password_non_blocking`, which
reads on a worker thread with a 10-second deadline and reports a timeout as
`NeedsReauth` → exit 77. There is no way to cancel a blocked keychain call, so the
thread is abandoned; it dies with the process. A test asserts the read is bounded.

Practical note: granting "Always Allow" once at the dialog makes subsequent reads
silent. Rebuilding the binary can re-trigger it, since the ACL is tied to the
signed binary — another reason the deadline matters rather than being a one-time
setup nuisance.
