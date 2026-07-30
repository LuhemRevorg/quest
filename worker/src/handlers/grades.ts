import { WorkerError, progress, type GradesParams } from "../protocol.js";
import {
  listTerms,
  openGrades,
  parseGrades,
  selectTerm,
  waitForGrades,
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
    const frame = await openGrades(page, FRAME_TIMEOUT_MS);

    const terms = await listTerms(frame);
    if (terms.length === 0) {
      throw new WorkerError(
        "unexpected_page",
        "no terms offered on the grades page — Quest's markup may have changed",
      );
    }

    const wanted = params.term_label.toLowerCase();
    const match = terms.find((t) => t.label.toLowerCase() === wanted);
    if (!match) {
      // Not a parse failure — the term genuinely is not on offer. Listing what is
      // beats making the caller guess.
      throw new WorkerError(
        "unexpected_page",
        `no grades for "${params.term_label}". Quest offers: ${terms.map((t) => t.label).join(", ")}`,
      );
    }

    progress(id, "verifying", `selecting ${match.label}`);
    await selectTerm(frame, match.radioId);

    const gradesFrame = await waitForGrades(page, FRAME_TIMEOUT_MS);
    const parsed = await parseGrades(gradesFrame);

    // Refuse to hand back a term we did not ask for. Silently-wrong grades are the
    // one outcome worse than an error, and a stale postback could produce exactly
    // that.
    if (parsed.term_shown && !parsed.term_shown.toLowerCase().includes(wanted)) {
      throw new WorkerError(
        "unexpected_page",
        `asked for "${params.term_label}" but the page is showing "${parsed.term_shown}"`,
      );
    }

    progress(id, "verifying", `read ${parsed.courses.length} courses`);
    return { ...parsed, term_requested: params.term_label };
  });
}
