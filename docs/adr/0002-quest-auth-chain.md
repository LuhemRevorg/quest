# ADR 0002 — The Quest auth chain, and how we detect where we are

Status: accepted
Date: 2026-07-29

## Context

Phase 1 needed the real sign-in flow, not an assumed one. Probing it live turned
up four things worth writing down, because each one shaped the code.

**1. Quest moved hosts.** `quest.uwaterloo.ca` now 302s to a marketing page at
`uwaterloo.ca/the-centre/quest`. The service lives at
**`quest.pecs.uwaterloo.ca`**. This matters more than it looks: hitting the old
host returns a perfectly valid HTTP 200 page that says nothing about our session,
which is indistinguishable from a dead session unless you refuse to guess.

**2. There are two sign-in forms.** `?cmd=login` serves PeopleSoft's *local*
form (`#userid` / `#pwd` / `name="Submit"`), which bypasses SAML. The portal
landing page instead SAML-redirects to **`adfs.uwaterloo.ca/adfs/ls/`** — that is
the WatIAM + Duo path, and the one a student actually uses. We drive the ADFS
path; the local selectors stay only as fallbacks.

**3. ADFS offers "Keep me signed in" (`#kmsiInput`, `name="Kmsi"`).** This is a
*second*, independent persistence layer alongside Duo's 30-day device trust: it
makes the ADFS SSO cookie persistent. It is what actually keeps later
non-interactive commands working, so `login` ticks it.

**4. ADFS ships `#passwordInput` hidden** and reveals it with its own CSS/JS.

## Decisions

**Classify by element presence, not visibility, and check Quest's own markers
first.** Finding (4) rules out visibility: a visibility test calls the live ADFS
sign-in page `unknown`, and makes offline fixture tests impossible, since a saved
page has no stylesheets. Presence alone would risk the reverse error — a hidden
password field somewhere inside Quest reading as "logged out" — so
`AUTHENTICATED_SELECTORS` is checked first, and a test asserts neither sign-in
fixture contains any of those markers. `duo` is checked before `login` because
ADFS's hidden password field lingers in the DOM while Duo is on screen.

**`unknown` is an error, never a guess.** Given finding (1), guessing would mean
either reporting a dead session as live or nagging for a re-login that isn't
needed. `status` fails with `unexpected_page` → exit 70 instead.

**Rejected credentials are only ever inferred from ADFS's visible `#errorText`.**
The tempting heuristic — "we submitted a password and still see a login page, so
it was wrong" — is a false-positive machine: per finding (4) that description
also fits a human taking their time at the Duo prompt. A silent rejection instead
falls through to the Duo timeout, with the browser still on screen to explain
itself.

**`device_trust_expires_at` reports the longest-lived persisted auth artifact**,
whether that is Duo's trust cookie or the ADFS KMSI cookie, because the question
it answers is "when will I next have to type a passcode".

## Consequences

- The Duo cookie names in `worker/src/status.ts` are still a heuristic — Duo's
  own screens can't be reached without credentials. `QUEST_DEBUG_COOKIES=1`
  prints the jar (names, domains, expiries; never values) after a real login so
  the list can be narrowed to the actual names.
- Fixtures for both sign-in pages are committed and tested against. They are
  unauthenticated public pages, so they carry no cookies or personal data.
