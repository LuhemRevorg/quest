# ADR 0007 — Searching for classes

Status: accepted (selectors provisional — see Consequences)
Date: 2026-08-03

## Context

`quest search --term f2026 --subject CS --number 246` answers "which sections of
this course run in this term", which neither `grades` nor `schedule` can: both of
those read the student's own record, and this reads the catalog. It is also the
first read that reaches a page nobody is *on* by default — it has to be navigated
to, and it has to be told what to look for before it will show anything.

The route, per the page a human reaches by Quest homepage → Class Schedule →
Search for Classes:

```
landing page → tile "Class Schedule"
  → iframe main_target_win0
    → link "Search for Classes"                (component SSR_CLSRCH_ENTRY)
      → select CLASS_SRCH_WRK2_STRM            ("Fall 2026")
        input  SSR_CLSRCH_WRK_SUBJECT          ("CS")
        input  SSR_CLSRCH_WRK_CATALOG_NBR      ("246")
        button CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH
          → one group per course, each holding its sections
```

Three things make it different from every read already implemented:

1. **The term is a `<select>`, not a radio grid.** `peoplesoft.ts`'s `listTerms` /
   `selectTerm` — radio `SSR_DUMMY_RECV1$sels$N$$0` plus a Continue button — do not
   apply. The shared navigation stops being shared at exactly this page.
2. **We write to the page**, where every previous read only clicked and scraped.
3. **"Nothing matched" is a legitimate answer** with no result grid at all.

## Decisions

**Write the criteria without firing FieldChange, then read them back and refuse to
search if they did not stick.** Subject and course number are deferred-processing
fields, so their values reach the server with the Search postback; firing a change
event on each only adds round trips, each of which can re-render the form out from
under the next write. The term dropdown is the exception — it genuinely reloads the
form — so it is set first, its postback is waited out, and the criteria are typed
into whatever comes back.

The read-back guard (`assertCriteriaMatch`) is the same family as the grades page's
term confirmation: searching on criteria the form is not holding returns real,
plausible, *wrong* classes under the heading we asked for, and that is the failure
mode this project treats as worse than an error.

**Force the number comparison to "is exactly".** The operator dropdown defaults
to "is exactly" but is user-settable and sticky within a session. Left on
"contains", `246` also returns 1246 and 2460.

**Send the term twice — label and code.** The dropdown is matched on its option
label first, since that is what the user asked for and what Quest displays, and
falls back to the option *value*, which is the UW term code (`Term::code`, see
`model/term.rs`). One spelling change to the label and the search still resolves.

**Wait for either ending.** `waitForResults` polls for the result grid *or* a
non-empty `DERIVED_CLSMSG_ERROR_TEXT`. Waiting only for the grid would turn "CS 999
does not run in the fall" into a 30-second timeout reported as a markup change —
an error where Quest gave a perfectly good answer. Quest's own message is carried
through to the output rather than being flattened into an empty list.

**Find the "Search for Classes" entry by visible text, across every frame.** It is
navigation, not content, and which frame renders it is exactly what a PeopleTools
upgrade rearranges. Among matches the *shortest* label wins: an ancestor anchor
wrapping half a menu also "contains" the words and clicking it goes elsewhere. If
the link is not on screen the term picker is cleared first and it is looked for
again, because which of the two layouts you land on depends on whether the
component opens on its picker.

**Results are grouped by container subtree**, and every id is matched on an exact
suffix. This is the third page with page-global row indices under a per-course
container, and the fixture carries both traps deliberately:
`win0divSSR_CLSRSLT_WRK_GROUPBOX2GP$N` (one character off the container id) and
`MTG_CLASSNAME$span$N` (the inner span of a section cell). See ADR 0005 and 0006 for
the three bugs that earned this rule.

## What the live runs changed

**The Class Schedule tile does not open the class schedule.** It opens a PeopleSoft
*activity guide* — a sidebar of seven steps, of which one is the schedule component
and **six are links to uwaterloo.ca help articles**. Two of those are titled "How to
Search for Classes" and "Understanding Class Search". The first is shorter than most
real navigation labels and contains the phrase being matched, so "shortest matching
label wins" clicked it, opened a marketing page in a new tab, and left Quest exactly
where it was. The frame dump of that new tab is what identified it.

So matching visible text needs two guards, both now in `clickSearchEntry`:

- an **exact** label match is preferred over a containing one;
- a candidate whose href resolves to **another host** is documentation, not
  navigation, as is anything inside a guided-process step (`[ptgpid]`,
  `[steplabel]`).

And a third route was needed, since the guide has no step for the search at all:
the classic component's own **"go to" dropdown → Student Center**
(`DERIVED_SSTSNAV_SSTS_MAIN_GOTO$27$` beside `DERIVED_SSTSNAV_GO`, both read off the
live page). The three routes are tried in order — link on screen, behind the term
picker, then across to the Student Center.

## What the first live run changed

The first run against a real session reached the Class Schedule tile, found and
clicked something matching "Search for Classes", and then never saw the criteria
form. Three corrections came out of it:

- **Waits are frame-agnostic.** `peoplesoft.ts` can key on `main_target_win0`
  because grades and the schedule are classic components reached by a tile. The
  class search is *navigated to*, and a nav item is free to re-target the window,
  open a tab, or land in a differently-named frame — all of which a wait on one
  named frame reports as "the page never loaded". `findFrame` now polls every frame
  of every page in the context.
- **The criteria form is recognised by caption as well as by id.** `Search` on the
  button is what the user sees and what the screenshot shows; it is the one part of
  the page not open to an id-naming difference. Accepted only alongside a subject
  field, since a lone "Search" button appears on half of Quest.
- **Everything past sign-in dumps every frame on failure, and the click is logged.**
  The first run's failure produced no dump at all, because the throw was outside the
  handler's try. "The link was wrong" and "the link was right, the page after it was
  not" are different bugs, and the label that was clicked is what separates them.

## Consequences

- **The selectors in `worker/src/search.ts` are not yet verified against UW's live
  page**, and this is the first module here of which that is true. They are the stock
  Campus Solutions `SSR_CLSRCH_*` names; UW's deployment may index or name some
  differently. The module is therefore built to fail *informatively* rather than
  quietly: field lookups match an exact-suffix regex against a small list of known
  spellings, every miss reports the ids the page actually had, and both failure
  paths dump the component's frame under `QUEST_DEBUG_DUMP_DIR`. One live run with
  that variable set produces everything needed to correct them.
- Fixtures are correspondingly **synthetic** — hand-built, marked as such in the
  file, in `fixtures/README.md` and in the test header. They pin the parser's
  handling of the page's *shape*, which is the part that has broken before; they
  cannot pin UW's ids. A real sanitized capture should replace them, and the same
  assertions should survive it.
- `--subject` and `--number` are both required. Quest demands at least two criteria
  beyond the term, so "every CS class in the fall" is a request the page itself
  rejects; the CLI does not offer a flag combination that cannot work.
- PeopleSoft caps the result grid and says so in its own words. That message is
  passed through, so a truncated list does not read as the whole offering.
