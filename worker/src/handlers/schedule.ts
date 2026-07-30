import { progress, type ScheduleParams } from "../protocol.js";
import {
  assertTermMatches,
  listTerms,
  openTile,
  requireTerm,
  selectTerm,
  termShown,
  waitForContent,
} from "../peoplesoft.js";
import {
  COURSE_CONTAINER_PREFIX,
  SCHEDULE_TILE,
  TERM_CONTINUE_ID,
  parseSchedule,
  type ParsedSchedule,
} from "../schedule.js";
import { withSession } from "./login.js";

const FRAME_TIMEOUT_MS = 30_000;

export interface ScheduleResult extends ParsedSchedule {
  term_requested: string;
}

/**
 * The classes enrolled in for one term. Authenticates first, so it inherits the
 * `NEEDS_REAUTH`-instead-of-hanging contract from `withSession`.
 *
 * Quest only offers a couple of terms here — enrolment exists for the current and
 * upcoming term, not historically — so asking for an old term lists what is
 * actually available rather than returning nothing.
 */
export async function schedule(id: number, params: ScheduleParams): Promise<ScheduleResult> {
  return withSession(id, params.login, async (_ctx, page) => {
    progress(id, "verifying", "opening Class Schedule");
    const frame = await openTile(page, SCHEDULE_TILE, FRAME_TIMEOUT_MS);

    const terms = await listTerms(frame);
    const match = requireTerm(terms, params.term_label, "class schedule");

    progress(id, "verifying", `selecting ${match.label}`);
    await selectTerm(frame, match.radioId, TERM_CONTINUE_ID);

    const loaded = await waitForContent(
      page,
      COURSE_CONTAINER_PREFIX,
      FRAME_TIMEOUT_MS,
      "the class list",
    );
    const parsed = await parseSchedule(loaded);
    assertTermMatches(parsed.term_shown ?? (await termShown(loaded)), params.term_label);

    progress(id, "verifying", `read ${parsed.courses.length} courses`);
    return { ...parsed, term_requested: params.term_label };
  });
}
