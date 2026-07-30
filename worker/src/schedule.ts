// Reading "My Class Schedule" — the classes you are enrolled in for a term.
//
// Verified against the live page on 2026-07-30; fixture in
// `fixtures/html/schedule-spring2026.sanitized.html`.
//
// Route:
//
//   landing page → tile "Class Schedule"
//     → iframe main_target_win0, component SSR_SSENRL_LIST
//       → radio SSR_DUMMY_RECV1$sels$N$$0
//       → button #DERIVED_SSS_SCT_SSR_PB_GO   ("Continue")
//         → one group per course
//
// Note the Continue id differs from the grades page's `UW_DRVD_SSS_SCT_SSR_PB_GO`.
//
// Structure, which is two-level rather than a flat grid:
//
//   win0divDERIVED_REGFRM1_DESCR20$N     ← one container per course
//     .PAGROUPDIVIDER                      "ABCD 100 - Placeholder Work-Study Course"
//     STATUS$N, DERIVED_REGFRM1_UNT_TAKEN$N, GB_DESCR$N
//     CLASS_MTG_VW$scroll$N                ← meeting grid
//       MTG_SECTION$M, MTG_COMP$M, MTG_SCHED$M, MTG_LOC$M, MTG_DATES$M,
//       DERIVED_CLS_DTL_CLASS_NBR$M, DERIVED_CLS_DTL_SSR_INSTR_LONG$M
//
// Meeting indices `M` are global across the page, not per course, so meetings are
// collected by walking each course container's subtree. Index arithmetic would
// happen to work for single-meeting courses and quietly mis-group a course with
// both a lecture and a tutorial.

import type { Frame } from "playwright";

/** Fluid tile that opens the class schedule. */
export const SCHEDULE_TILE = /class schedule/i;

/** Continue on the schedule's term picker — *not* the grades page's id. */
export const TERM_CONTINUE_ID = "DERIVED_SSS_SCT_SSR_PB_GO";

/** One container per enrolled course; also the "loaded" marker. */
export const COURSE_CONTAINER_PREFIX = "win0divDERIVED_REGFRM1_DESCR20$";

export interface ParsedMeeting {
  class_number: string | null;
  section: string | null;
  component: string | null;
  days_times: string | null;
  room: string | null;
  instructor: string | null;
  start_end: string | null;
}

export interface ParsedCourse {
  title: string | null;
  status: string | null;
  units: string | null;
  grading_basis: string | null;
  meetings: ParsedMeeting[];
}

export interface ParsedSchedule {
  term_shown: string | null;
  courses: ParsedCourse[];
}

/** Read every enrolled course. Exported for tests, which run it against a fixture. */
export async function parseSchedule(frame: Frame): Promise<ParsedSchedule> {
  return frame.evaluate(
    ({ containerPrefix, termShownPrefix }) => {
      const clean = (value: string | null | undefined): string | null => {
        const text = (value ?? "").trim().replace(/\s+/g, " ");
        return text === "" ? null : text;
      };
      const textOf = (root: ParentNode, selector: string): string | null =>
        clean(root.querySelector(selector)?.textContent);

      const courses = Array.from(
        document.querySelectorAll(`[id^="${containerPrefix}"]`),
      ).map((container) => {
        // The course index is the container's own suffix; course-level fields
        // share it, while meeting rows carry a page-global index.
        const index = container.id.slice(containerPrefix.length);

        // Meetings, scoped to this course's subtree — see the note above about
        // why index arithmetic is not safe here.
        // Exact `MTG_SECTION$<digits>` only. A plain prefix match also catches
        // `MTG_SECTION$span$N` — the inner span of the same cell — which produced a
        // phantom meeting per course whose every other field resolved to null.
        const meetings = Array.from(container.querySelectorAll('[id^="MTG_SECTION$"]'))
          .filter((el) => /^MTG_SECTION\$\d+$/.test(el.id))
          .map((sectionEl) => {
            const m = sectionEl.id.slice("MTG_SECTION$".length);
            const byId = (id: string) => clean(document.getElementById(id)?.textContent);
            return {
              class_number: byId(`DERIVED_CLS_DTL_CLASS_NBR$${m}`),
              section: clean(sectionEl.textContent),
              component: byId(`MTG_COMP$${m}`),
              days_times: byId(`MTG_SCHED$${m}`),
              room: byId(`MTG_LOC$${m}`),
              instructor: byId(`DERIVED_CLS_DTL_SSR_INSTR_LONG$${m}`),
              start_end: byId(`MTG_DATES$${m}`),
            };
          });

        return {
          // The title sits in the group divider, e.g. "EFGH 200 - Second Placeholder Course".
          title: textOf(container, ".PAGROUPDIVIDER"),
          status: clean(document.getElementById(`STATUS$${index}`)?.textContent),
          units: clean(document.getElementById(`DERIVED_REGFRM1_UNT_TAKEN$${index}`)?.textContent),
          grading_basis: clean(document.getElementById(`GB_DESCR$${index}`)?.textContent),
          meetings,
        };
      });

      const termEl = document.querySelector(`[id^="${termShownPrefix}"]`);
      return { term_shown: clean(termEl?.textContent), courses };
    },
    {
      containerPrefix: COURSE_CONTAINER_PREFIX,
      termShownPrefix: "DERIVED_REGFRM1_SSR_STDNTKEY_DESCR",
    },
  );
}
