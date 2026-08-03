import type { BrowserContext, Page } from "playwright";

import {
  assertTermMatches,
  contentFrame,
  listTerms,
  openTile,
  requireTerm,
  selectTerm,
  sleep,
  waitForContent,
} from "../peoplesoft.js";
import { WorkerError, progress, type SearchParams } from "../protocol.js";
import { COURSE_CONTAINER_PREFIX, SCHEDULE_TILE, TERM_CONTINUE_ID } from "../schedule.js";
import {
  assertCriteriaMatch,
  clickSearchEntry,
  clickableLabels,
  dumpAllFrames,
  fillCriteria,
  gotoStudentCenter,
  parseResults,
  readCriteria,
  selectSearchTerm,
  submitSearch,
  waitForCriteriaForm,
  waitForResults,
  type Criteria,
  type ParsedSearch,
} from "../search.js";
import { withSession } from "./login.js";

const FRAME_TIMEOUT_MS = 30_000;

/** How long to keep looking for the search link after clearing the term picker. */
const LINK_TIMEOUT_MS = 15_000;

/** Grace for a FieldChange postback to start before we poll for the settled form. */
const POSTBACK_SETTLE_MS = 1_000;

export interface SearchResult extends ParsedSearch {
  /** Echoed back so the CLI can confirm it asked for what it got. */
  term_requested: string;
  subject: string;
  catalog_number: string;
}

/**
 * The sections of one course offered in one term.
 *
 * Unlike `schedule`, this reads the catalog rather than the student's record — it
 * answers "when does CS 246 run in the fall", enrolled or not. It still signs in
 * first: the search lives behind the same authenticated session as everything else
 * in Quest, so it inherits the `NEEDS_REAUTH`-instead-of-hanging contract from
 * `withSession`.
 *
 * Every failure past the sign-in dumps all frames, because the selectors here are
 * still provisional (ADR 0007) and a dump is the whole cost of fixing one.
 */
export async function search(id: number, params: SearchParams): Promise<SearchResult> {
  const criteria: Criteria = {
    subject: params.subject,
    catalog_number: params.catalog_number,
  };

  return withSession(id, params.login, async (ctx, page) => {
    try {
      progress(id, "verifying", "opening Class Schedule");
      await openTile(page, SCHEDULE_TILE, FRAME_TIMEOUT_MS);

      const entry = await openClassSearch(ctx, page, params.term_label);
      progress(id, "verifying", `followed "${entry.label}" in frame ${entry.frame}`);

      const form = await waitForCriteriaForm(ctx, FRAME_TIMEOUT_MS);
      const term = await selectSearchTerm(form, {
        label: params.term_label,
        code: params.term_code,
      });
      // Changing the term is a FieldChange: the form re-renders, and the criteria
      // must be typed into whatever comes back rather than into what was there.
      if (term.changed) await sleep(POSTBACK_SETTLE_MS);
      const settled = await waitForCriteriaForm(ctx, FRAME_TIMEOUT_MS);

      progress(
        id,
        "verifying",
        `searching ${criteria.subject} ${criteria.catalog_number} in ${term.label}`,
      );
      await fillCriteria(settled, criteria);
      assertCriteriaMatch(await readCriteria(settled), criteria);
      await submitSearch(settled);

      const results = await waitForResults(ctx, FRAME_TIMEOUT_MS);
      const parsed = await parseResults(results);
      assertTermMatches(parsed.term_shown, params.term_label);

      const sections = parsed.courses.reduce((n, course) => n + course.sections.length, 0);
      progress(id, "verifying", `read ${parsed.courses.length} courses, ${sections} sections`);

      return {
        ...parsed,
        term_requested: params.term_label,
        subject: criteria.subject,
        catalog_number: criteria.catalog_number,
      };
    } catch (err) {
      await dumpAllFrames(ctx, "class-search-failure").catch(() => {});
      throw err;
    }
  });
}

/**
 * Get from the Class Schedule tile to the search form.
 *
 * Three routes, tried in order, because the tile opens an activity guide whose
 * sidebar carries the schedule itself and six links to uwaterloo.ca help pages —
 * and no step for the search:
 *
 *   1. the link, if it is already on screen;
 *   2. behind the term picker: pick the term, Continue, look again;
 *   3. the classic "go to" dropdown → Student Center, which does carry it.
 *
 * Doing (2) or (3) unconditionally would break the layouts where the link is right
 * there, and skipping them breaks the one observed live.
 */
async function openClassSearch(ctx: BrowserContext, page: Page, termLabel: string) {
  const onScreen = await clickSearchEntry(ctx);
  if (onScreen) return onScreen;

  const frame = contentFrame(page);
  const terms = frame ? await listTerms(frame) : [];
  if (frame && terms.length > 0) {
    const match = requireTerm(terms, termLabel, "class schedule");
    await selectTerm(frame, match.radioId, TERM_CONTINUE_ID);
    await waitForContent(page, COURSE_CONTAINER_PREFIX, FRAME_TIMEOUT_MS, "the class list").catch(
      () => undefined,
    );

    const afterTerm = await pollForSearchEntry(ctx);
    if (afterTerm) return afterTerm;
  }

  const current = contentFrame(page);
  if (current && (await gotoStudentCenter(current))) {
    const fromStudentCentre = await pollForSearchEntry(ctx);
    if (fromStudentCentre) return fromStudentCentre;
  }

  const labels = await clickableLabels(page);
  throw new WorkerError(
    "unexpected_page",
    `no "Search for Classes" link under Class Schedule or the Student Center — Quest's ` +
      `navigation may have changed. Links found: ${labels.join(", ") || "none"}`,
  );
}

/** The link only exists once the postback lands, so give it a moment to arrive. */
async function pollForSearchEntry(ctx: BrowserContext) {
  const deadline = Date.now() + LINK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = await clickSearchEntry(ctx);
    if (entry) return entry;
    await sleep(500);
  }
  return null;
}
