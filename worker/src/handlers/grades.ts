import { progress, type GradesParams } from "../protocol.js";
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
  GRADES_TILE,
  ROW_MARKER_PREFIX,
  TERM_CONTINUE_ID,
  parseGrades,
  type ParsedGrades,
} from "../grades.js";
import { withSession } from "./login.js";

const FRAME_TIMEOUT_MS = 30_000;

export interface GradesResult extends ParsedGrades {
  /** Echoed back so the CLI can confirm it asked for what it got. */
  term_requested: string;
}

/**
 * Grades for one term. Authenticates first, so it inherits the whole
 * `NEEDS_REAUTH`-instead-of-hanging contract from `withSession`.
 */
export async function grades(id: number, params: GradesParams): Promise<GradesResult> {
  return withSession(id, params.login, async (_ctx, page) => {
    progress(id, "verifying", "opening Grades");
    const frame = await openTile(page, GRADES_TILE, FRAME_TIMEOUT_MS);

    const terms = await listTerms(frame);
    const match = requireTerm(terms, params.term_label, "grades");

    progress(id, "verifying", `selecting ${match.label}`);
    await selectTerm(frame, match.radioId, TERM_CONTINUE_ID);

    const loaded = await waitForContent(page, ROW_MARKER_PREFIX, FRAME_TIMEOUT_MS, "the grade rows");
    const parsed = await parseGrades(loaded);
    assertTermMatches(parsed.term_shown ?? (await termShown(loaded)), params.term_label);

    progress(id, "verifying", `read ${parsed.courses.length} courses`);
    return { ...parsed, term_requested: params.term_label };
  });
}
