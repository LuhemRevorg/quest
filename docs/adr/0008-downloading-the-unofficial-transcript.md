# ADR 0008 — Downloading the unofficial transcript

Status: accepted
Date: 2026-07-30

## Context

`quest transcript` is the third Phase 3 read, and the first one whose payload is a
**file** rather than a parsed record. Two things make it unlike `grades` and
`schedule`:

**It can spend money.** Quest carries two transcript components, side by side in
the same menu, with near-identical markup:

```
SSR_TSRQST_UNOFF   "View Unofficial Transcript"    free
SSR_TSRQST_OFF     "Request Official Transcript"   a paid ($20) order
```

README has promised since Phase 1 that official transcripts are never ordered.
That was free to promise while nothing went near the page; it now has to be
enforced in code. Every prior guard in this project protects against
silently-wrong *output* — this one protects against an irreversible *action*, and
the failure mode is a charge on a student account rather than a bad number on a
terminal.

**It has no fixture.** Grades and schedule were built against saved pages
(ADR 0005, 0006). A transcript fixture would be a complete academic record, and
capturing one needs an account this was developed without. So the ids below are
PeopleSoft's documented conventions, **not observations of UW's live page.**

## Decisions

**Save the file; do not parse it.** The transcript is written to disk verbatim.
Parsing it would add a second, richer source of truth for data `grades` already
returns, and a transcript revamp is precisely what killed a prior community GPA
tool. A PDF saved byte-for-byte cannot come back subtly wrong.

**The component guard replaces the term guard.** `grades` and `schedule` confirm
the page states the term that was asked for. There is no term here — an unofficial
transcript covers the whole record — so the equivalent check is on identity:
`assertUnofficialComponent` requires `SSR_TSRQST_UNOFF` in the content frame's
URL, immediately before anything is pressed, and refuses a control whose label
reads like placing an order. Both halves are needed: a button reading "View
Report" on the *official* component would submit a paid order just as happily.

This is the same rule as "never submit a credential form we did not fill"
(ADR 0002), which was written after a hidden PeopleSoft form posted empty
credentials and returned `errorCode=105`. The lesson generalises: never press a
control on a page whose identity we cannot prove.

**The guard is on the component, not on the word "official".** This was got
wrong twice before a live run settled it, and the correction is the most useful
thing in this record.

The unofficial page's report-type dropdown is full of options named **"Undergrad
Official"**. `TSCRPT_TYPE` names the report *template*, and PeopleSoft shares
those values across both components — so at UW the correct thing to select on the
free page has "Official" in its name. Two successive designs read that word as a
money signal:

1. options labelled official were filtered out before matching, so
   `--report-type` could not reach one; then
2. the picker was tightened further to require a label *positively* saying
   "unofficial", refusing anything else as a guess.

Each looked like defence in depth. Together they made the only working option
unreachable, and the second would have failed the page outright. Both are gone.
Nothing filters on the label now: every option on this component is safe, because
**the component cannot order anything**. Ordering happens on `SSR_TSRQST_OFF`,
which is a different page with its own submit, and `assertUnofficialComponent`
already proves we are not on it.

What survives from the label checks is narrower and correct: a control whose text
describes an *action* that places an order — "Submit Request", "Order
Transcript", "Checkout", "Payment" — is still refused, because those name what a
button does rather than which document it produces.

Choosing between several report types is therefore a **correctness** question,
not a safety one: handing an undergraduate a graduate transcript is
silently-wrong output. A sole option is taken; several without direction is an
error listing them, resolved with `--report-type`.

**`--report-type` matches on word boundaries before falling back to substrings.**
"graduate" is a substring of "Undergraduate", so plain `includes` makes Quest's
two most likely report types permanently ambiguous. Matching is tiered — exact
label, then `\bword\b`, then substring — and ambiguity at any tier is an error
listing the choices rather than a guess.

**A URL you navigated to is not evidence of where you are.** The most expensive
mistake here, and the least obvious. Arrival was judged by "a frame whose URL
contains `SSR_TSRQST_UNOFF`" — but that string is in the URL *because we put it
there*. PeopleSoft can answer with an empty portal shell, a "not authorized", or a
redirect, and the check still passes: it reads back our own request. Two live runs
reported "no View Report control", which reads like a selector problem and was
nothing of the kind — the second run's diagnostics listed `Copy | Clear | Hide |
Close`, PeopleTools' debug-console overlay, which is present on *every* page. That
was the tell: there was no page content at all.

Arrival now requires something only the real page has — a dropdown, or the report
control itself. The URL check remains, but demoted to what it actually is: a
necessary condition for pressing, never sufficient for having arrived.

The same class of error, twice more:

- **Frame ranking.** PeopleSoft nests the portal's `ptifrmtgtframe` around the
  component's `main_target_win0`, and both carry the component in their URL, with
  `page.frames()` returning the wrapper first. Matches are now ranked —
  `main_target_win0`, then the deepest — and then must prove they hold the form.
- **Following a link and assuming it worked.** The tile route clicked through and
  fell back to "whatever is in the content frame now", reporting success for a
  click that went nowhere. It now reports only *what* it clicked; the caller
  re-checks for the form.

**Search every frame; let the guard do the narrowing.** Both the dropdown and the
report control are now looked for across the whole page rather than in a frame
chosen by a guess about PeopleSoft's layout — a guess that has been wrong twice.
Safety does not come from searching narrowly. It comes from `componentUrl`: the
URL of the control's frame or nearest ancestor naming the unofficial component. A
control with no such ancestor is refused loudly, because a "View Report" button
outside the unofficial component is precisely the case worth shouting about.

**Three capture channels, because the delivery mechanism is a deployment
detail.** PeopleSoft hands the report over out-of-band, and how depends on
headers, on Chromium, and on whether a window is open:

| Channel | Fires when |
| ------- | ---------- |
| `download` event | the server sends `Content-Disposition: attachment`, **or** headless Chromium meets a PDF |
| PDF response body | Chromium rendered it in its own viewer (headed) |
| popup URL, refetched | last resort |

All three are watched at once. Measured against a local server standing in for
PeopleSoft, **both** a `window.open` to a PDF and an attachment navigation arrive
as `download` events in ~270 ms: headless Chromium has no PDF viewer, so it
downloads what it cannot render. Since headless is the default and the only mode
where "unattended" means anything, that is the channel that matters — but it is a
Chromium behaviour, not a contract, so the other two stay.

The refetch is deliberately last: it re-requests the URL rather than reading the
original response, and some PeopleSoft report URLs are single-use.

**The bytes cross the wire base64-encoded and Rust writes the file.** The worker
never puts an academic record on the filesystem (its only other disk write is the
opt-in `QUEST_DEBUG_DUMP_DIR`), and the `0600` discipline that already governs the
profile dir stays in one language. It also puts the destination check *before* the
browser launch: a path that cannot be written fails in 8 ms instead of after a
twenty-second sign-in.

Base64 on one NDJSON line is fine for a document of this size, and is bounded at
32 MB. The decoder is thirty hand-rolled lines rather than a new dependency in a
tool whose whole premise is holding a credential.

## The homepage that has no tiles

A live run reported `no tile and no link` for all six sections it knows, with the
frame inventory showing one frame at `/psp/SS/ACADEMIC/SA/h/?tab=DEFAULT` and links
reading `Favorites / Main Menu / Self Service / Waterloo Student Admin / …`.

That is the **classic portal**, and it has no `PTNUI_LAND_REC_GROUPLET` tiles at
all — it renders a `Main Menu` flyout instead. `URLS.questHome` points there
because it is a good authenticated-or-not probe, which is a different job from
being a place to navigate from. Sign-in had already left the browser on the Fluid
landing page, `/psc/SS/ACADEMIC/SA/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL`, where every
tile lives and where `grades`, `schedule` and `search` all work — and this function
navigated away from it before looking.

Three corrections:

- **The page sign-in landed on is tried first**, and `page.url()` is captured
  before anything navigates. Homepages are then tried cheapest-first: where we
  already were, the Fluid landing page, the classic portal.
- **`URLS.fluidHome` exists**, so no command has to rediscover which homepage has
  tiles. Note it is served from `/psc/`, the content servlet, not `/psp/`.
- **The direct component URL is tried through both servlets**, `/psc/` first. The
  `/psp/` path alone did not render the component on this deployment.

Failure messages now name the homepage as well as the section
(`the page sign-in landed on → /^grades$/i: no tile and no link`), because "that
section is not here" and "that section is not here *either*" are different facts.

## The component is `SSS_`, not `SSR_`

Stock Campus Solutions names these components `SSR_TSRQST_UNOFF` and
`SSR_TSRQST_OFF`. **UW serves neither.** Read off the live page's own form action:

| | UW | stock |
| --- | --- | --- |
| unofficial (free) | `SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL` | `SSR_TSRQST_UNOFF` |
| official (paid) | `SA_LEARNER_SERVICES.SS_TSCRPT_OFF.GBL` (page `UW_TSCRPT_OFF`) | `SSR_TSRQST_OFF` |

One letter, and it broke three things at once, none of which looked like a naming
problem:

- `waitForRequestForm` filters frames by that string, so it **discarded the
  transcript page while standing on it** — the run reached the request form, with
  its report-type dropdown and "View Report" button, and reported "did not reach
  it";
- both direct component URLs pointed at a component that does not exist, so the
  fast path could never work and every run fell through to the tile walk;
- `assertUnofficialComponent` would have refused to press "View Report" on the
  correct page, so fixing only the first two would have moved the failure rather
  than removed it.

It also hid a **safety gap in the opposite direction**: `PAID_ORDER_PATTERNS`
carried only `SSR_TSRQST_OFF`, which matches nothing at UW, so the URL half of the
paid-order guard was inert here and only the label patterns were doing any work.
UW's paid component is now matched by name.

Both spellings are accepted everywhere, so this still works against a stock
deployment. The lesson is the one this project keeps relearning: **a name read off
a live page beats a name from documentation**, and a guard keyed on the wrong name
fails silently in whichever direction costs more.

## The report-type dropdown was never found

UW offers two reports here: `Undergrad Unofficial` (`UGUN`) and `Graduate
Unofficial` (`GRDUN`) — note **"Undergrad", not "Undergraduate"**, so
`--report-type undergraduate` matches neither.

`readReportPicker` identified the dropdown two ways, and UW defeats both:

- **by id**, anchored `/(TSCRPT|TRANSCRIPT|RPT)_TYPE$/` — UW's is
  `DERIVED_SSTSRPT_TSCRPT_TYPE**3**`, so the anchor missed it. A `$`-anchored
  PeopleSoft id is a guess about *numbering*, not naming; the class-search fields
  carry `$31$` and `$0` for the same reason. Now `_TYPE\d*$`.
- **by option labels**, matching `/transcript|report/` — but the labels are
  "Undergrad Unofficial" and "Graduate Unofficial", and neither word appears. Now
  also matches `unofficial`.

So `selectId` came back `null`, and that single fact produced two failures that
looked unrelated:

- **with `--report-type`**: an immediate "the page offers no report-type dropdown",
  on a page that visibly has one;
- **without it**: `null` skips selection *silently*, "View Report" is pressed with
  nothing chosen, Quest generates nothing, and the run dies 120 seconds later as a
  capture timeout.

Two dumps taken 2 minutes apart were **byte-identical**, which is what showed no
postback had ever fired. Worth recording that an intermediate diagnosis — "the
postback clears the selection" — was wrong, and wrong in a way the evidence could
not have supported: `select.value` is a *property*, and assigning it never appears
in serialized HTML, so a dump can never distinguish "set and held" from "never
set". `ensureReportType` was added under that theory. It is kept, because writing a
PeopleSoft field and pressing on without reading it back is exactly the class-search
bug (ADR 0007), and a wrong precondition should cost a clear error in seconds
rather than the whole capture window — but it was not the bug here.

## The report is a popup, and Chromium blocks popups

Quest's own page says it:

> To view your Unofficial Transcript, please ensure your pop-up blockers are
> disabled.

"View Report" (`GO1`) opens a target window with `window.open` and submits the form
into it. Chromium's popup blocker stops that window, the target never exists, and
the submit dies **silently** — no window, no download, no response, no error. The
run waited out its full 120-second capture window and reported a timeout, which
reads like Quest being slow rather than like a browser policy.

The diff between the request form and the failure page is what showed it:
`ICStateNum` went 3 → 4 for the report-type postback (so the selection stuck, and
`ensureReportType` was doing its job), and then **nothing** — pressing `GO1`
produced no further postback at all.

Two changes, because there are two ways to lose a popup:

- **`--disable-popup-blocking`** in the Chromium launch args. This is a
  requirement of the page, not a preference, and it only re-enables `window.open`
  for pages we drove to ourselves in a browser that lives for one command.
- **A real Playwright click** on the report control, so the window is attributed
  to a trusted input event. Everywhere else here a synthetic `el.click()` is
  correct — PeopleSoft ids contain `$` and its behaviour lives in `onclick` — but a
  postback and a `window.open` are not the same thing, and only one of them cares
  who clicked. The synthetic press remains as a fallback for a control Playwright
  cannot reach.

## Getting the bytes out of a PDF viewer tab

Pressing "View Report" opens the transcript in a **new tab**, rendered by Chrome's
PDF viewer. That is the headed experience; headless Chromium has no viewer and
downloads the file instead, which is why the `download` channel usually wins and
why all three are watched rather than one being chosen.

The viewer case has two failure modes that refetching the tab's URL from outside
cannot survive:

- **one-shot URLs** — PeopleSoft report links commonly serve the PDF once and an
  error page afterwards, and refetching *is* the second request;
- **`blob:` URLs** — a viewer tab is often on one, and no external request can
  reach it.

So the tab is now asked for its own bytes (`fetch(location.href)` from inside it,
chunked to base64) when refetching fails. Same origin, same session, `blob:`
resolves, and a document already fetched normally comes from cache.

And anything a popup hands back is checked with `sniffFormat` before it is
accepted. Without that, the one-shot case ends with an HTML "your session has
expired" page saved under the transcript's name, reported as a success — the exact
silently-wrong output this project treats as worse than an error.

## Consequences

- **Failure messages name what was on the page, and that is not decoration.** The
  first live run returned a bare "no View Report control … markup may have
  changed", which said nothing about whether the route, the frame or the selector
  was at fault — and cost a round trip to learn nothing. Listing the controls
  found (`Copy | Clear | Hide | Close`) is what identified the real fault on the
  next run. Failures now describe every frame: name, URL, dropdowns, controls,
  links. One round trip against a real account is expensive; one extra `map` is
  not.
- **Two human routes, neither via a tile named after transcripts:** Grades →
  unofficial transcript, and Academics → unofficial transcript. That is why
  tile-name guessing was never sufficient alone. Navigation tries PeopleSoft's
  direct component URL first, then walks in from the homepage. All paths funnel
  into the same gate, so a wrong guess fails closed.
- **Quest serves two interfaces, and the transcript route is on the classic one.**
  Grades and schedule reach their pages through Fluid tiles
  (`PTNUI_LAND_REC_GROUPLET`), so `openTile` was reused here without question. A
  live run then reported "no such tile" six times over — with `Academics`,
  `Grades`, `Class Schedule`, `Finances`, `Holds` and the rest sitting in the
  frame as ordinary `<a>` links in a classic portal navigation bar. Each section
  is now tried as a tile *and* as a link. Reusing a working mechanism from a
  neighbouring page is how three of the faults in this record started.
- **The classic portal calls its content frame `TargetContent`**, not
  `main_target_win0`. Both are accepted; both were observed rather than assumed.
- **The link is not always worded the same way.** The Student Center's "other
  academic..." dropdown calls it *"Transcript: View Unofficial"*; other pages say
  *"View Unofficial Transcript"*. A regex spelling one order matches nothing on
  the pages using the other, so the matcher requires both words and takes no view
  on their arrangement.
- **A `<select>` route needs its go arrow pressed.** "other academic..." does not
  navigate on `change`; the adjacent arrow submits it. Selecting the option and
  walking away leaves the page where it was, which is indistinguishable from the
  route not existing.
- **`<option>.value` is truthy, and that is a trap.** A label reader written
  `value || textContent` — correct for an `<input type="image">` go arrow, whose
  text is empty — returns `"TSCRPT"` for an option and never matches its visible
  text. Links and options are read by text; buttons by value. Caught by a test
  before it reached Quest, unlike the three id collisions above.
- The "View Report" control is polled for rather than looked for once: selecting a
  report type fires an `ICAJAX` postback that rebuilds the frame, and the button
  can be absent either side of it.
- **Still no fixture.** Capturing one means committing a complete academic record.
  The ids are now corrected by one live run rather than verified by a test, which
  is weaker than grades and schedule and should be treated that way.
- `worker/src/transcript.test.ts` carries **no captured fixture**. Its pages are
  hand-written and adversarial — an official option beside an unofficial one, an
  official component that looks identical, a sign-in page returned where a PDF was
  expected — and what they pin is that the guards refuse. Live capture is
  additionally exercised against a local HTTP server.
- A fourth near-miss id collision, found by those tests: a loose
  `/TSCRPT|RQST/` match on select ids picks `SSR_TSRQST_UNOFF_INSTITUTION`,
  because PeopleSoft embeds the component name in the id of every field on the
  page. Anchored on a `_TYPE` suffix instead. ADR 0005 and 0006 each record one of
  these; treat any prefix match on a PeopleSoft id as guilty until tested.
- The transcript lands `0600` and dated (`quest-unofficial-transcript-<date>.pdf`),
  so re-running does not silently overwrite the last one and a file sitting in a
  downloads folder cannot be mistaken for an official document.
- Still no way to order an official transcript, and no flag that could grow into
  one. If that is ever wanted it is a Phase 4 mutation — dry-run, confirmation
  token, audit log — not a read command.
