# ADR 0006 — Reading the class schedule

Status: accepted
Date: 2026-07-30

## Context

`quest schedule` answers "what am I enrolled in for term X" — which `grades`
cannot, because a future term has enrolment but no marks.

The route mirrors grades closely enough to be dangerous:

```
landing page → tile "Class Schedule"
  → iframe main_target_win0, component SSR_SSENRL_LIST
    → radio SSR_DUMMY_RECV1$sels$N$$0
    → button #DERIVED_SSS_SCT_SSR_PB_GO   ("Continue")
      → one group per enrolled course
```

**The Continue button is `DERIVED_SSS_SCT_SSR_PB_GO`, not grades'
`UW_DRVD_SSS_SCT_SSR_PB_GO`.** Near-identical, different page, and copying the
selector across would have failed in a way that looks like "the page didn't load".

Quest also offers only **two terms** here — the current and upcoming one — because
enrolment is not retained historically the way grades are.

## Decisions

**Extract the shared navigation.** `worker/src/peoplesoft.ts` now owns opening a
tile, listing terms, selecting one, waiting for content, and the term-mismatch
guard. Grades was refactored onto it. Every self-service page has the same shape,
and the only per-page differences are the tile label, the Continue id and the
payload — so those are the only things each module supplies.

**Open tiles by label, not index.** Grades previously hardcoded
`PTNUI_LAND_REC_GROUPLET$0`. The tiles are in whatever order UW arranges the
homepage, which is not ours to depend on, so both pages now match on visible text.

**Meetings are gathered per course subtree, not by index arithmetic.** The page is
two-level — a container per course, each holding a meeting grid — but meeting ids
carry a page-global index:

```
win0divDERIVED_REGFRM1_DESCR20$N     ← course container
  .PAGROUPDIVIDER                      "EFGH 200 - Second Placeholder Course"
  STATUS$N, DERIVED_REGFRM1_UNT_TAKEN$N, GB_DESCR$N
  CLASS_MTG_VW$scroll$N
    MTG_SECTION$M, MTG_COMP$M, MTG_SCHED$M, MTG_LOC$M, MTG_DATES$M,
    DERIVED_CLS_DTL_CLASS_NBR$M, DERIVED_CLS_DTL_SSR_INSTR_LONG$M
```

With one meeting per course, `M` happens to equal `N` — so index arithmetic would
pass every test written against a co-op term and silently mis-group the first
course that has both a lecture and a tutorial. Meetings are therefore read from
each container's subtree.

**Split `"EFGH 200 - Second Placeholder Course"` on the *first* ` - ` only.** Course titles
contain their own hyphens ("Placeholder Work-Study Course"), so a greedy split mangles
them.

## Consequences

- A third bug in the same family as ADR 0005's: `[id^="MTG_SECTION$"]` also matches
  `MTG_SECTION$span$N`, the inner span of the same cell, which produced a phantom
  meeting per course with every field but `section` null. Prefix matching on
  PeopleSoft ids needs an exact-suffix check — `/^MTG_SECTION\$\d+$/`. That is now
  three separate near-miss id collisions; treat prefix matches as suspect.
- Asking for a term Quest does not offer lists the available ones, rather than
  returning an empty schedule that reads like "not enrolled in anything".
- `fixtures/html/schedule-spring2026.sanitized.html` also scrubs the
  **instructor's name** — third-party personal data, which the grades page did not
  contain.
