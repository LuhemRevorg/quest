// Reaching and reading "View My Grades".
//
// Verified against the live page on 2026-07-30; fixture in
// `fixtures/html/grades-winter2026.sanitized.html`.
//
// Route (none of it guessable — see ADR 0005):
//
//   landing page → tile #win0divPTNUI_LAND_REC_GROUPLET$0 ("Grades")
//     → iframe main_target_win0, component UW_SS_MENU.UW_SSR_SSENRL_GRDE.GBL
//       → radio SSR_DUMMY_RECV1$sels$N$$0   (term; index 0 is the newest)
//       → button #UW_DRVD_SSS_SCT_SSR_PB_GO ("Continue")
//         → the grade rows
//
// Everything is read by element id rather than column position. PeopleSoft ids are
// `record.field` names — far more stable than a grid's column order, which shifts
// whenever someone adds a column.

import type { Frame } from "playwright";

/** Fluid homepage tile that opens grades. */
export const GRADES_TILE = /^grades$/i;

/** Continue on the grades term picker — *not* the class schedule's id. */
export const TERM_CONTINUE_ID = "UW_DRVD_SSS_SCT_SSR_PB_GO";

/** First per-row field; also the "loaded" marker. */
export const ROW_MARKER_PREFIX = "CLASS_TBL_VW_DESCR$";

/** Per-row field ids; `$N` is the zero-based row index. */
const ROW_FIELDS = {
  // `CLS_LINK$span$N`, not `DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$N$`. The latter is a
  // single element holding the term header ("Winter 2026 | Undergraduate | …") and a
  // per-row template over it happened to match at N=5, leaking the header into the
  // last row's class. Verified: only `$5$` of that id exists on the page.
  className: (n: number) => `CLS_LINK$span$${n}`,
  description: (n: number) => `CLASS_TBL_VW_DESCR$${n}`,
  units: (n: number) => `STDNT_ENRL_SSV1_UNT_TAKEN$${n}`,
  gradingBasis: (n: number) => `GRADING_BASIS$${n}`,
  grade: (n: number) => `STDNT_ENRL_SSV1_CRSE_GRADE_OFF$${n}`,
  gradePoints: (n: number) => `STDNT_ENRL_SSV1_GRADE_POINTS$${n}`,
} as const;

/**
 * Which term the page believes it is showing — "Winter 2026 | Undergraduate |
 * University of Waterloo".
 *
 * Matched by id *prefix*. The element is
 * `DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$5$`, and that `$5$` is not a row index —
 * it is wherever PeopleSoft happened to place the field, so hardcoding it would be
 * fragile. `UW_DRVD_SSS_SCT_SSS_TERM_LINK` looks like the obvious candidate and is
 * the wrong one: it exists but carries no text, which left the term-mismatch guard
 * silently inert until a fixture test caught it.
 */
const TERM_SHOWN_PREFIX = "DERIVED_REGFRM1_SSR_STDNTKEY_DESCR";
const STANDING_ID = "ACAD_STACTN_TBL_DESCRFORMAL";

/** Sanity bound: nobody enrols in 60 courses in a term. */
const MAX_ROWS = 60;

export interface TermRow {
  radioId: string;
  label: string;
}

export interface ParsedCourse {
  class_name: string | null;
  description: string | null;
  units: string | null;
  grading_basis: string | null;
  grade: string | null;
  grade_points: string | null;
}

export interface ParsedGrades {
  term_shown: string | null;
  academic_standing: string | null;
  courses: ParsedCourse[];
}

/** Read every row. Exported for tests, which run it against a saved fixture. */
export async function parseGrades(frame: Frame): Promise<ParsedGrades> {
  return frame.evaluate(
    ({ fieldNames, termShownPrefix, standingId, maxRows }) => {
      const text = (id: string): string | null => {
        const el = document.getElementById(id);
        if (!el) return null;
        const value = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        return value === "" ? null : value;
      };

      const courses = [];
      for (let n = 0; n < maxRows; n += 1) {
        // The description cell is the row's anchor: no cell, no row.
        const description = text(fieldNames.description.replace("$N", `$${n}`));
        if (description === null) break;
        courses.push({
          class_name: text(fieldNames.className.replace("$N", `$${n}`)),
          description,
          units: text(fieldNames.units.replace("$N", `$${n}`)),
          grading_basis: text(fieldNames.gradingBasis.replace("$N", `$${n}`)),
          grade: text(fieldNames.grade.replace("$N", `$${n}`)),
          grade_points: text(fieldNames.gradePoints.replace("$N", `$${n}`)),
        });
      }

      const termEl = document.querySelector(`[id^="${termShownPrefix}"]`);
      const termShown = (termEl?.textContent ?? "").trim().replace(/\s+/g, " ");

      return {
        term_shown: termShown === "" ? null : termShown,
        academic_standing: text(standingId),
        courses,
      };
    },
    {
      // Templates rather than functions, since these cross into the page.
      fieldNames: {
        className: ROW_FIELDS.className(0).replace("$span$0", "$span$N"),
        description: ROW_FIELDS.description(0).replace("$0", "$N"),
        units: ROW_FIELDS.units(0).replace("$0", "$N"),
        gradingBasis: ROW_FIELDS.gradingBasis(0).replace("$0", "$N"),
        grade: ROW_FIELDS.grade(0).replace("$0", "$N"),
        gradePoints: ROW_FIELDS.gradePoints(0).replace("$0", "$N"),
      },
      termShownPrefix: TERM_SHOWN_PREFIX,
      standingId: STANDING_ID,
      maxRows: MAX_ROWS,
    },
  );
}

