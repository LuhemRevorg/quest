# ADR 0005 — Reading grades

Status: accepted
Date: 2026-07-30

## Context

Phase 2 needed one read command working end to end. The brief preferred replaying
`ICAJAX` postbacks over DOM scraping, so the first job was to see what the traffic
and markup actually look like.

The route to grades is not guessable, and every step of it had a trap:

```
landing page → tile #win0divPTNUI_LAND_REC_GROUPLET$0 ("Grades")
  → iframe main_target_win0, component UW_SS_MENU.UW_SSR_SSENRL_GRDE.GBL
    → radio SSR_DUMMY_RECV1$sels$N$$0     (term; index 0 is newest)
    → button #UW_DRVD_SSS_SCT_SSR_PB_GO   ("Continue")
      → grade rows
```

- The vanilla PeopleSoft component `SA_LEARNER_SERVICES.SSR_SSENRL_GRADE.GBL`
  returns **"You are not authorized to access this component"**. UW runs a
  customised `UW_SS_MENU.UW_SSR_SSENRL_GRDE.GBL`, reachable only with the portal
  context the tile supplies.
- Content lives inside an iframe, `main_target_win0`.
- Two attempts were wasted on `DERIVED_SSTSNAV_GO`, a nav-bar arrow. The real
  Continue button is `<input type="button" onclick="submitAction_win0(document.win0,
  this.id, event)">` — it passes `this.id` rather than a literal, so it is invisible
  to any scan for `submitAction_win0(…,'…')`. The same lesson as ADR 0004:
  enumerate the actionable surface, do not pattern-match a guess.

## Decisions

**Scrape by element id, not column position.** PeopleSoft ids are `record.field`
names, so they survive a column being added or reordered — unlike the grid layout,
which is exactly what killed the community GPA tool the brief mentions.

| Field | Element id |
| ----- | ---------- |
| class | `CLS_LINK$span$N` |
| description | `CLASS_TBL_VW_DESCR$N` |
| units | `STDNT_ENRL_SSV1_UNT_TAKEN$N` |
| grading basis | `GRADING_BASIS$N` (column header reads "Formal Description") |
| grade | `STDNT_ENRL_SSV1_CRSE_GRADE_OFF$N` |
| grade points | `STDNT_ENRL_SSV1_GRADE_POINTS$N` |
| term shown | `DERIVED_REGFRM1_SSR_STDNTKEY_DESCR*` (by prefix) |
| standing | `ACAD_STACTN_TBL_DESCRFORMAL` |

**DOM reading, not postback replay.** The brief's preference was `ICAJAX` replay,
and that remains right for anything with pagination or heavy state. It buys nothing
here: reaching the grid already requires a real session, a tile click and a
postback, and the grid arrives as ordinary HTML with stable ids. Replaying the
postback would mean reproducing `ICSID`/`ICStateNum` handling for no gain in
robustness. Revisit if a page needs many round trips.

**Grades stay strings; units and points are numbers.** `"A+"`, `"CR"`, `"IP"` and
`""` are all real grade values — a numeric type would force lossy parsing. Units
and grade points do parse, and a cell that fails to parse becomes `None` rather
than failing the term: Quest legitimately leaves grade points blank on
credit/no-credit rows, as co-op terms show.

**Term codes are computed, not scraped.** No four-digit code appears in the markup,
but UW's scheme is `(year - 1900) * 10 + {Winter 1, Spring 5, Fall 9}`, so
`--term` accepts `1261`, `"Winter 2026"`, `winter2026` or `w2026` and reports both
forms. The worker matches Quest's own label, since that is all the page offers.

**The page must confirm which term it rendered.** Silently-wrong grades are worse
than an error, and a stale postback could produce them. `term_shown` is compared
against the request and a mismatch is an error.

## Consequences

- Two bugs here were caught only by writing the fixture test, and both would have
  produced quietly wrong output:
  - the class was read from `DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$N$`, which exists
    *once* (as the term header) and collided at `N=5`, putting
    "Winter 2026 | Undergraduate | …" in the last row's class column;
  - `term_shown` was read from `UW_DRVD_SSS_SCT_SSS_TERM_LINK`, which is present
    but empty — so the term-mismatch guard above was **inert** and would never have
    fired.
- `fixtures/html/grades-winter2026.sanitized.html` is the real page with every
  personal value replaced: name, 8-digit ids, `ICSID`, and the course codes,
  descriptions, grades and academic standing. Only structure and element ids are
  real, which is all the tests assert on. `fixtures/README.md` permits keeping real
  grades in a local repo, but a committed file is a different bar — the structure is
  the part with test value, so there is no reason to keep the record itself.
- Every other read command (schedule, holds, fees) should now be a matter of a
  route and a field table.
