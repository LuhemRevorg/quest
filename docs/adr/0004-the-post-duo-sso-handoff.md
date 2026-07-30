# ADR 0004 — The post-Duo SSO handoff

Status: accepted (superseding two wrong diagnoses recorded below)
Date: 2026-07-30

## Context

With the staged-form fix in place, an unattended `auth refresh` got further than
before and then stopped. The per-tick trace (`QUEST_DEBUG_PAGES=1`) showed the
whole chain working right up to the last hop:

```
[unknown] … https://api-XXXXXXXX.duosecurity.com/prompt/…      ← Duo
[duo]     … https://api-XXXXXXXX.duosecurity.com/prompt/…      ← passed on device trust
[login]   user=hidden pass=hidden submit=hidden  https://quest.pecs.uwaterloo.ca/…?cmd=login
[login]   user=hidden pass=hidden submit=hidden  https://quest.pecs.uwaterloo.ca/…?cmd=login
[login]   …repeating forever
```

Good news first: **Duo device trust works.** It passed with no passcode, which is
the premise the whole unattended design rests on.

The stall is on PeopleSoft's own transitional page, `?cmd=login`. Its markup is
`<body onload="ptSignon().login();">` around a loader spinner and a login form.
The page is meant to resolve itself from JavaScript — completing the SSO handoff,
or revealing the form for manual entry. Under headless Chromium it does neither:
every control stays `display:none`, so the loop has nothing to click and no field
to fill, and it spins until the deadline.

Measured directly against that page, ten runs, fresh profile each time:

| Mode | `input[name=Submit]` | Advanced past `?cmd=login` |
| ---- | -------------------- | -------------------------- |
| headless (headless-shell) | hidden 3/3 | 0/3 |
| headless (full chromium build) | hidden | 0/1 |
| offscreen (real render, window parked) | hidden 3/3 | 0/3 |
| headed | hidden 2/3 | **1/3** |

Ruled out along the way: the `HeadlessChrome` user-agent (overriding it changes
nothing), the stripped-down `chrome-headless-shell` binary (the full build behaves
the same), and waiting longer (15s is no better than 4s).

Note the honest part of that table: cold-loading `?cmd=login` without any SSO state
is flaky in *every* mode, headed included. So it is not a faithful reproduction of
the page reached after Duo, and the table shows a real headless/headed asymmetry
without fully explaining the mechanism.

## Decision

**Rendering mode is an explicit parameter, and unattended runs are not headless.**
`Display` is `headed` | `offscreen` | `headless`:

- `auth login` → `headed`. A human uses the window.
- `auth refresh` → `offscreen` by default. Real rendering and a real compositor,
  with the window parked at `--window-position=-32000,-32000` so it neither
  appears nor steals focus. `--display` overrides it.
- `auth status` → `headless`. It only reads where a navigation lands and never
  drives the form, and it is verified working that way.

Choosing `offscreen` over `headed` is a judgement call, not a measurement: it
preserves rendering, which is the axis that appears to matter, without a window
flashing on every command. The cold-page table cannot distinguish them, so this
needs confirming against a real post-Duo run.

## Consequences

- `refresh` costs a full browser launch rather than a headless one. Acceptable;
  correctness first.
- **Unverified:** whether `offscreen` clears the stall where `headless` does not.
  If it does not, the fallback is `--display headed`, and the follow-up is the
  long-lived worker from ADR 0003's rejected options, so the window cost is paid
  once per session rather than once per command.
- The underlying reason `ptSignon().login()` is inert without a visible window is
  still unknown.
- Added `QUEST_DEBUG_DUMP_DIR`, which saves the HTML of whatever page a run
  stalled on, so the next failure yields the markup instead of another round-trip.

## Correction, 2026-07-30: `offscreen` hides nothing on macOS, and the run was attended

An `offscreen` run reached `session: live`, and this ADR briefly recorded that as
the fix working. It was not. Two things were wrong.

**`--window-position=-32000,-32000` does not hide a window on macOS.** The window
manager clamps it straight back; measured via `window.screenX/screenY`, it lands
at `(0, 33)` — fully visible. On this platform `offscreen` is just `headed`.

**So the successful run was attended.** The owner confirmed clicking PeopleSoft's
"Sign in" button in that window. The chain completed because a human completed it.
The `?cmd=login` stall was never cleared by rendering.

### Revised decision

**The fix is to nudge hidden controls directly.** That page keeps its submit
control in the DOM while hiding it, and Playwright's `click()` refuses hidden
elements by design. `locator.dispatchEvent("click")` is the same action at the DOM
level and carries no visibility precondition — the automation equivalent of the
click a human performs on the rendered button. The sign-in loop now tries a
*visible* continue control first, then falls back to dispatching on a hidden one.

**`refresh` now defaults to `headless`.** Not for speed: with no window, a passing
run cannot have been rescued by hand, so "unattended" becomes a claim the test can
actually support. Defaulting to `offscreen` on macOS would put a clickable window
on screen and make every result ambiguous. `--display headed` remains for
debugging.

### Second correction: dispatching the click was the wrong fix

The `dispatchEvent("click")` nudge was tried and is now removed. Headless, it
reached the hidden control and posted the form, and Quest answered
`?cmd=login&errorCode=105` — invalid signon — then looped.

Of course it did. That page's hidden control belongs to PeopleSoft's **local login
form**, complete with `userid` and `pwd` fields the loop never filled (they were
hidden, so it correctly skipped them). Clicking submit posted empty credentials.
That is a real failed sign-in attempt against the account, and repeating it every
few seconds is a way to trip lockout.

**Rule now encoded, with a test:** never submit a credential form whose fields we
did not populate. An "interstitial" safe to click through is one with *no
credential field present in the DOM at all* — presence, not visibility, because
hidden-but-present is exactly the trap here.

**Replacement fix — re-enter through the front door.** Landing on `?cmd=login`
means the SAML handoff did not complete. But ADFS is holding a live session from
the sign-in completed seconds earlier *in this same browser context*, so simply
navigating to the Quest entry URL again should mint a fresh assertion with no human
involved. Bounded to 3 attempts. This needs no magic constants and posts nothing.

### Lesson

Two claims of success here were wrong because a human was in the loop without it
being visible in the evidence — first a manual click, earlier a keychain dialog.
When verifying "unattended", the mode that admits no human intervention is the
only one whose success means anything.


## Resolution, 2026-07-30: it was never about rendering

`auth refresh` now completes the entire chain **headless, unattended**, confirmed by
the owner ("ran without me doing anything") — and with no window in existence, there
was nothing anyone could have clicked.

The cause was embarrassingly simple, and visible the moment the page was actually
dumped rather than inferred from selector probes:

```html
<div class="ps_box-button" style="display: none;">
  <input name="Submit" type="submit" class="ps-button ui-btn-hidden" value="Sign In">
</div>
<a style="font-weight: bold" href="javascript:getIdPLink()">Sign In</a>
```

The control that enters Quest is an **anchor calling `getIdPLink()`**. The local
login form's submit is suppressed on purpose, because this deployment is SSO-only.
Every selector list here held submit-button patterns, so none of them could match an
`<a>` with no id. The trace faithfully reported `submit=hidden`, and that was read as
"nothing to click" when the thing to click was an element never looked for.

The fix is one selector and a click. The instrumented run shows `idp=visible` on that
page — **the anchor was visible in headless the whole time.**

### What this retracts

- **"Headless stalls the sign-in chain."** False. Headless was never the problem, and
  the title of this ADR was wrong.
- **The mode comparison table above.** It measured cold-loading `?cmd=login` with no
  SSO state, a page that waits for a click and therefore never self-advances in any
  mode. The headed 1/3 was noise. The table is left in place because it is what led
  the investigation astray, and deleting it would hide that.
- **`Display::Offscreen`.** Introduced solely to serve the rendering theory, and on
  macOS it never even hid the window. Removed; `Display` is now `Headed` (for
  `auth login`) and `Headless` (everything else, the default).

### Lesson, restated

Four fixes failed, each targeting a mechanism inferred from indirect signals —
user-agent, browser binary, compositor, DOM event dispatch. The fifth succeeded
immediately once the page was read. Selector-visibility probes describe what you
thought to ask about; they are silent on what you did not. **Dump the page before
theorising about it.** `QUEST_DEBUG_DUMP_DIR` now writes every distinct page as it is
reached, at `0600` inside a `0700` directory — the first version left dumps of
authenticated pages world-readable.
