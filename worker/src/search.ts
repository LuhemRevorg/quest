// Reaching and reading "Search for Classes" — which sections of a course are
// offered in a term, whether or not you are enrolled in any of them.
//
// **Selector status: NOT yet verified against UW's live page.** Every other module
// here carries a "verified on <date>" line and a captured fixture; this one cannot
// until someone runs it against a real session (see ADR 0007). The ids below are
// the stock Campus Solutions `SSR_CLSRCH_*` names, and the whole module is written
// so that a wrong guess fails *loudly and informatively* rather than quietly: every
// lookup that misses reports the ids the page actually had, and `QUEST_DEBUG_DUMP_DIR`
// saves the markup for the fix.
//
// Route:
//
//   landing page → tile "Class Schedule"
//     → iframe main_target_win0
//       → link "Search for Classes"        (component SSR_CLSRCH_ENTRY)
//         → select CLASS_SRCH_WRK2_STRM    ("Fall 2026")  ← a dropdown, *not* the
//           input  SSR_CLSRCH_WRK_SUBJECT  ("CS")            radio grid the schedule
//           input  SSR_CLSRCH_WRK_CATALOG_NBR ("246")         and grades pages use
//           button CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH ("Search")
//             → one group per course, each holding its sections
//
// The results page repeats the schedule page's two-level shape, and repeats its
// trap with it: section row ids carry a **page-global** index, so rows are gathered
// from each course container's subtree rather than by index arithmetic, and every
// id is matched on an exact suffix (`/^MTG_CLASSNAME\$\d+$/`) rather than a prefix.
// Prefix matching on PeopleSoft ids has now caused three separate bugs — see ADR
// 0005 and 0006.

import type { BrowserContext, Frame, Page } from "playwright";

import { sleep } from "./peoplesoft.js";
import { WorkerError } from "./protocol.js";
import { dumpPage } from "./quest.js";

/**
 * The nav entry that leaves "My Class Schedule" for the search form.
 *
 * `EXACT` is tried before `SEARCH_LINK`, and that ordering is load-bearing. The
 * Class Schedule tile opens an *activity guide* whose sidebar is mostly links to
 * uwaterloo.ca help articles — one of them titled "How to Search for Classes",
 * which contains the phrase, is the shortest such label on the page, and opens a
 * marketing page in a new tab. The first live run clicked exactly that.
 */
const SEARCH_LINK_EXACT = "search for classes";
export const SEARCH_LINK = /search for classes/i;

/**
 * The classic self-service "go to" dropdown and its Go button.
 *
 * The way out of the activity guide: the class schedule's own navigation offers
 * "Student Center", which is where the search lives when the guide does not carry
 * a step for it. Observed on the live page as
 * `DERIVED_SSTSNAV_SSTS_MAIN_GOTO$27$` — the `$27$` being the usual arbitrary
 * suffix — beside `DERIVED_SSTSNAV_GO`.
 */
const GOTO_SELECT_PATTERN = String.raw`^DERIVED_SSTSNAV_SSTS_MAIN_GOTO(\$\d+)?\$?$`;
const GOTO_BUTTON_ID = "DERIVED_SSTSNAV_GO";

/** "Search" on the criteria form; also the marker that the form has loaded. */
export const SEARCH_BUTTON_ID = "CLASS_SRCH_WRK2_SSR_PB_CLASS_SRCH";

/** One container per course in the results. */
export const RESULT_CONTAINER_PREFIX = "win0divSSR_CLSRSLT_WRK_GROUPBOX2$";

/** Where PeopleSoft puts "no results match the criteria specified". */
const MESSAGE_ID_PREFIX = "DERIVED_CLSMSG_ERROR_TEXT";

/**
 * Criteria field ids.
 *
 * Each is a list because two deployments of the same component disagree on some
 * names (`…_SUBJECT` vs `…_SUBJECT_SRCH`), tried in order. The trailing
 * `(\$\d+)?\$?` absorbs the arbitrary suffix PeopleSoft appends — `$31$`, `$0` —
 * which is *not* a row index and differs per page, so neither hardcoding it nor
 * plain prefix matching is right.
 */
const FIELD_PATTERNS = {
  term: [String.raw`^CLASS_SRCH_WRK2_STRM(\$\d+)?\$?$`],
  subject: [
    String.raw`^SSR_CLSRCH_WRK_SUBJECT(\$\d+)?\$?$`,
    String.raw`^SSR_CLSRCH_WRK_SUBJECT_SRCH(\$\d+)?\$?$`,
  ],
  catalogNumber: [String.raw`^SSR_CLSRCH_WRK_CATALOG_NBR(\$\d+)?\$?$`],
  /** "is exactly" / "contains" / … `E` is "is exactly". */
  numberMatch: [String.raw`^SSR_CLSRCH_WRK_SSR_EXACT_MATCH1(\$\d+)?\$?$`],
} as const;

/** The operator that makes `246` mean 246 and not "starts with 246". */
const EXACT_MATCH_VALUE = "E";

export interface Criteria {
  subject: string;
  catalog_number: string;
}

export interface ParsedSection {
  class_number: string | null;
  /** Raw, e.g. `"001-LEC Regular"`. Split into section and component in Rust. */
  class_name: string | null;
  days_times: string | null;
  room: string | null;
  instructor: string | null;
  meeting_dates: string | null;
  /** `"Open"`, `"Closed"`, `"Wait List"` — read from the status icon's alt text. */
  status: string | null;
}

export interface ParsedSearchCourse {
  /** The group divider, e.g. `"CS 246 - Object-Oriented Software Development"`. */
  title: string | null;
  sections: ParsedSection[];
}

export interface ParsedSearch {
  term_shown: string | null;
  /** PeopleSoft's own message, e.g. the "no results" text. Null when it said nothing. */
  message: string | null;
  courses: ParsedSearchCourse[];
}

/** What `clickSearchEntry` actually pressed, so a wrong guess is visible in the log. */
export interface ClickedEntry {
  label: string;
  /** The anchor's href, truncated. `javascript:submitAction_win0(…)` for a real nav link. */
  href: string;
  frame: string;
}

/**
 * Follow the "Search for Classes" entry, wherever Quest is currently keeping it.
 *
 * Matched on visible text across every frame rather than on an id: the entry is a
 * navigation link, not page content, and which frame (or side panel) renders it is
 * exactly the sort of thing a PeopleTools upgrade rearranges. Returns null if it is
 * not on screen — the caller decides whether that is fatal or just means the term
 * picker has to be cleared first.
 *
 * What it pressed is reported back rather than just "yes": if the link is right and
 * the page afterwards is wrong, those are different bugs with different fixes, and
 * the label is the only thing that tells them apart.
 */
export async function clickSearchEntry(ctx: BrowserContext): Promise<ClickedEntry | null> {
  for (const frame of allFrames(ctx)) {
    const clicked = await frame
      .evaluate(
        ({ pattern, exact }) => {
          const re = new RegExp(pattern, "i");
          const label = (el: Element): string =>
            [el.textContent ?? "", el.getAttribute("value") ?? "", el.getAttribute("title") ?? ""]
              .join(" ")
              .trim()
              .replace(/\s+/g, " ");

          const navigational = (el: Element): boolean => {
            // Documentation, not navigation. The activity guide's sidebar links to
            // uwaterloo.ca help articles, and one of them is titled "How to Search
            // for Classes"; clicking it opens a marketing page in a new tab and
            // leaves Quest exactly where it was.
            const href = el.getAttribute("href") ?? "";
            if (href !== "") {
              // Resolved, not substring-matched: a `javascript:` href stays (that
              // is what every PeopleSoft nav link is), a relative one stays, and
              // anything that resolves to another host does not.
              try {
                const target = new URL(href, location.href);
                if (/^https?:$/.test(target.protocol) && target.host !== location.host) return false;
              } catch {
                // Unparseable href: treat it as relative, i.e. still ours.
              }
            }
            // Note this does not exclude guided-process steps as such: on other
            // routes (the transcript's) the real entry *is* a step pointing at a
            // component. Where the link goes is the discriminator; the help
            // articles above are rejected for being off-host, not for being steps.
            return true;
          };

          const matches = Array.from(
            document.querySelectorAll<HTMLElement>(
              'a, span[role="button"], div[role="link"], input[type="button"], input[type="submit"]',
            ),
          )
            .filter((el) => re.test(label(el)))
            .filter(navigational);
          if (matches.length === 0) return null;

          // Exact label first, then the shortest containing one: "How to Search for
          // Classes" contains the phrase and is shorter than most real nav labels,
          // so shortest-wins alone picks the help article. An ancestor anchor
          // wrapping half a menu also "contains" it, hence still preferring short.
          const target =
            matches.find((el) => label(el).toLowerCase() === exact) ??
            matches.sort((a, b) => label(a).length - label(b).length)[0];
          if (!target) return null;
          target.click();
          return { label: label(target), href: (target.getAttribute("href") ?? "").slice(0, 80) };
        },
        { pattern: SEARCH_LINK.source, exact: SEARCH_LINK_EXACT },
      )
      .catch(() => null);
    if (clicked) return { ...clicked, frame: frame.name() || "(top)" };
  }
  return null;
}

/**
 * Leave the class schedule for the Student Center via the "go to" dropdown.
 *
 * The activity guide the Class Schedule tile opens has no step for the class
 * search — its seven steps are the schedule itself and six external help pages.
 * The classic component's own navigation is the way across, and the Student Center
 * is where the search entry actually lives.
 */
export async function gotoStudentCenter(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(
      ({ selectPattern, buttonId }) => {
        const select = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find(
          (el) => new RegExp(selectPattern).test(el.id),
        );
        const go = document.getElementById(buttonId);
        if (!select || !go) return false;

        const option = Array.from(select.options).find((o) =>
          /student center/i.test(o.textContent ?? ""),
        );
        if (!option) return false;

        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        go.click();
        return true;
      },
      { selectPattern: GOTO_SELECT_PATTERN, buttonId: GOTO_BUTTON_ID },
    )
    .catch(() => false);
}

/**
 * Every frame of every page in the context.
 *
 * Pages plural because a PeopleSoft nav item is free to open a new tab, in which
 * case the page we were driving simply never changes — indistinguishable, from the
 * old page's point of view, from a click that did nothing.
 */
export function allFrames(ctx: BrowserContext): Frame[] {
  return ctx.pages().flatMap((page) => page.frames());
}

/** Name, url and title of every frame — the first thing to look at when content went missing. */
export async function frameInventory(ctx: BrowserContext): Promise<string[]> {
  return Promise.all(
    allFrames(ctx).map(async (frame) => {
      const title = await frame.title().catch(() => "");
      const name = frame.name() || "(top)";
      return `${name} [${title.slice(0, 40)}] ${frame.url().slice(0, 70)}`;
    }),
  );
}

/** Every clickable label on the page, for saying what *was* there when the entry is not. */
export async function clickableLabels(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() =>
          Array.from(document.querySelectorAll('a, span[role="button"], input[type="button"]'))
            .map((el) =>
              ((el.textContent ?? "") || el.getAttribute("value") || "").trim().replace(/\s+/g, " "),
            )
            .filter((text) => text !== "" && text.length < 40),
        )
        .catch((): string[] => []),
    ),
  );
  return [...new Set(perFrame.flat())].slice(0, 30);
}

/**
 * Pick the term in the criteria dropdown.
 *
 * Not `peoplesoft.ts`'s `selectTerm`: this page uses a `<select>`, where grades and
 * the class schedule use a radio grid plus a Continue button. Matched on the option
 * label first (that is what the user asked for and what Quest displays), falling
 * back to the option value, which is the UW term code.
 *
 * A `change` event is dispatched because the real control has a FieldChange handler
 * that reloads the subject list for the term — so the criteria are filled *after*
 * this, never before.
 */
export async function selectSearchTerm(
  frame: Frame,
  wanted: { label: string; code: string },
): Promise<{ label: string; changed: boolean }> {
  const outcome = await frame.evaluate(
    ({ patterns, label, code }) => {
      const select = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find((el) =>
        patterns.some((p) => new RegExp(p).test(el.id)),
      );
      if (!select) {
        return {
          ok: false as const,
          reason: "missing" as const,
          offered: Array.from(document.querySelectorAll<HTMLSelectElement>("select")).map(
            (el) => el.id,
          ),
        };
      }

      const options = Array.from(select.options);
      const text = (o: HTMLOptionElement) => (o.textContent ?? "").trim().replace(/\s+/g, " ");
      const match =
        options.find((o) => text(o).toLowerCase() === label.toLowerCase()) ??
        options.find((o) => text(o).toLowerCase().includes(label.toLowerCase())) ??
        options.find((o) => o.value === code);
      if (!match) {
        return {
          ok: false as const,
          reason: "no-such-term" as const,
          offered: options.map(text).filter((t) => t !== ""),
        };
      }

      const changed = select.value !== match.value;
      select.value = match.value;
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true as const, label: text(match), changed };
    },
    { patterns: [...FIELD_PATTERNS.term], label: wanted.label, code: wanted.code },
  );

  if (!outcome.ok) {
    if (outcome.reason === "no-such-term") {
      throw new WorkerError(
        "unexpected_page",
        `no class search for "${wanted.label}". Quest offers: ${outcome.offered.join(", ")}`,
      );
    }
    throw new WorkerError(
      "unexpected_page",
      `no term dropdown on the class search form — Quest's markup may have changed. ` +
        `Selects present: ${outcome.offered.join(", ") || "none"}`,
    );
  }
  return { label: outcome.label, changed: outcome.changed };
}

/**
 * Type the subject and course number in, and force the number comparison to
 * "is exactly".
 *
 * Values are assigned without firing `change`: these are deferred-processing
 * fields, so their values reach the server with the Search postback, and firing
 * FieldChange on each one only adds round trips that could re-render the form out
 * from under the next write. What they hold is read back and checked afterwards by
 * [`readCriteria`] — a search run against criteria we did not set would return
 * plausible, wrong classes, which is the failure mode this project cares most about.
 */
export async function fillCriteria(frame: Frame, criteria: Criteria): Promise<void> {
  const missing = await frame.evaluate(
    ({ patterns, subject, catalogNumber, exact }) => {
      const find = <T extends Element>(candidates: readonly string[], selector: string): T | null =>
        (Array.from(document.querySelectorAll<T>(selector)).find((el) =>
          candidates.some((p) => new RegExp(p).test(el.id)),
        ) ?? null);

      const missing: string[] = [];

      const subjectEl = find<HTMLInputElement>(patterns.subject, "input");
      if (subjectEl) subjectEl.value = subject;
      else missing.push("subject");

      const numberEl = find<HTMLInputElement>(patterns.catalogNumber, "input");
      if (numberEl) numberEl.value = catalogNumber;
      else missing.push("course number");

      // Optional: some deployments drop the operator and always mean "is exactly".
      const matchEl = find<HTMLSelectElement>(patterns.numberMatch, "select");
      if (matchEl && Array.from(matchEl.options).some((o) => o.value === exact)) {
        matchEl.value = exact;
      }

      return missing;
    },
    {
      patterns: {
        subject: [...FIELD_PATTERNS.subject],
        catalogNumber: [...FIELD_PATTERNS.catalogNumber],
        numberMatch: [...FIELD_PATTERNS.numberMatch],
      },
      subject: criteria.subject,
      catalogNumber: criteria.catalog_number,
      exact: EXACT_MATCH_VALUE,
    },
  );

  if (missing.length > 0) {
    const ids = await frame.evaluate(() =>
      Array.from(document.querySelectorAll("input, select"))
        .map((el) => el.id)
        .filter((id) => id !== "" && !id.startsWith("IC") && !id.startsWith("win0"))
        .slice(0, 40),
    );
    throw new WorkerError(
      "unexpected_page",
      `the class search form has no ${missing.join(" or ")} field — Quest's markup may have ` +
        `changed. Fields present: ${ids.join(", ") || "none"}`,
    );
  }
}

/** What the form is actually holding, for confirming it is what we asked for. */
export async function readCriteria(frame: Frame): Promise<Criteria> {
  return frame.evaluate(
    ({ subjectPatterns, numberPatterns }) => {
      const value = (candidates: readonly string[]): string =>
        Array.from(document.querySelectorAll<HTMLInputElement>("input")).find((el) =>
          candidates.some((p) => new RegExp(p).test(el.id)),
        )?.value ?? "";
      return {
        subject: value(subjectPatterns).trim(),
        catalog_number: value(numberPatterns).trim(),
      };
    },
    {
      subjectPatterns: [...FIELD_PATTERNS.subject],
      numberPatterns: [...FIELD_PATTERNS.catalogNumber],
    },
  );
}

/**
 * Refuse to search on criteria the form is not holding.
 *
 * The term postback re-renders this form; if it lands between the write and the
 * click, the search runs on an empty or stale subject and returns a different
 * course's sections under the heading we asked for. Silently-wrong data, again.
 */
export function assertCriteriaMatch(shown: Criteria, wanted: Criteria): void {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (!same(shown.subject, wanted.subject) || !same(shown.catalog_number, wanted.catalog_number)) {
    throw new WorkerError(
      "unexpected_page",
      `the search form did not keep the criteria: asked for ` +
        `"${wanted.subject} ${wanted.catalog_number}", form holds ` +
        `"${shown.subject} ${shown.catalog_number}"`,
    );
  }
}

/**
 * Press Search. `<input type=button>` with the behaviour in an `onclick`.
 *
 * Falls back to the control captioned "Search", for the same reason
 * [`waitForCriteriaForm`] accepts it: the caption is the stable part. The fallback
 * is safe here because it runs on a frame already proven to be the criteria form,
 * and "Search" submits a form we have just filled and read back.
 */
export async function submitSearch(frame: Frame): Promise<void> {
  const pressed = await frame.evaluate((id) => {
    const byId = document.getElementById(id);
    if (byId) {
      byId.click();
      return true;
    }
    const byCaption = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[type=button], input[type=submit]"),
    ).find((el) => (el.value ?? "").trim().toLowerCase() === "search");
    if (!byCaption) return false;
    byCaption.click();
    return true;
  }, SEARCH_BUTTON_ID);
  if (!pressed) {
    throw new WorkerError(
      "unexpected_page",
      `no "Search" control (#${SEARCH_BUTTON_ID}) on the class search form — ` +
        `Quest's markup may have changed`,
    );
  }
}

/**
 * Wait for whichever of the two endings arrives.
 *
 * "No classes match" is a perfectly ordinary answer, and it renders a message
 * instead of a result grid — so waiting only for the grid would turn "CS 999 does
 * not run in the fall" into a 30-second timeout reported as a markup change.
 */
export async function waitForResults(ctx: BrowserContext, timeoutMs: number): Promise<Frame> {
  const frame = await findFrame(
    ctx,
    (f) =>
      f.evaluate(
        ({ containerPrefix, messagePrefix }) => {
          if (document.querySelector(`[id^="${containerPrefix}"]`)) return true;
          const message = document.querySelector(`[id^="${messagePrefix}"]`);
          return (message?.textContent ?? "").trim() !== "";
        },
        { containerPrefix: RESULT_CONTAINER_PREFIX, messagePrefix: MESSAGE_ID_PREFIX },
      ),
    timeoutMs,
  );
  if (frame) return frame;
  throw new WorkerError(
    "unexpected_page",
    `the class search returned neither results nor a message. Frames: ` +
      `${(await frameInventory(ctx)).join(" | ")}`,
  );
}

/**
 * Wait for a postback to settle back into a form that still has its Search button.
 *
 * Recognised by the button id *or* by a subject field next to a control captioned
 * "Search" — the caption is what the user sees and what the screenshot shows, so it
 * is the one thing about this page not open to an id-naming difference. Both are
 * required in the caption case: a lone "Search" button appears on half of Quest.
 */
export async function waitForCriteriaForm(ctx: BrowserContext, timeoutMs: number): Promise<Frame> {
  const frame = await findFrame(
    ctx,
    (f) =>
      f.evaluate(
        ({ buttonId, subjectPatterns }) => {
          if (document.getElementById(buttonId)) return true;
          const hasSubject = Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
            (el) => subjectPatterns.some((p) => new RegExp(p).test(el.id)),
          );
          const hasSearch = Array.from(
            document.querySelectorAll<HTMLInputElement>("input[type=button], input[type=submit]"),
          ).some((el) => (el.value ?? "").trim().toLowerCase() === "search");
          return hasSubject && hasSearch;
        },
        { buttonId: SEARCH_BUTTON_ID, subjectPatterns: [...FIELD_PATTERNS.subject] },
      ),
    timeoutMs,
  );
  if (frame) return frame;
  throw new WorkerError(
    "unexpected_page",
    `the class search form (#${SEARCH_BUTTON_ID}) never appeared. Frames: ` +
      `${(await frameInventory(ctx)).join(" | ")}`,
  );
}

/**
 * Poll every frame of every page until one satisfies `probe`.
 *
 * Frame-agnostic on purpose. `peoplesoft.ts` can key on `main_target_win0` because
 * grades and the schedule are classic components reached by a tile; the class search
 * is navigated to, and a nav item may re-target the whole window, open a tab, or land
 * in a differently-named frame. Waiting on one frame by name turns any of those into
 * "the page never loaded", which is what the first live run reported.
 */
async function findFrame(
  ctx: BrowserContext,
  probe: (frame: Frame) => Promise<boolean>,
  timeoutMs: number,
): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of allFrames(ctx)) {
      if (await probe(frame).catch(() => false)) return frame;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Save every frame of every page. One dump per run of a failing selector is not
 * enough when the open question is *where the content went*.
 */
export async function dumpAllFrames(ctx: BrowserContext, label: string): Promise<void> {
  const frames = allFrames(ctx);
  for (const [index, frame] of frames.entries()) {
    const name = (frame.name() || "top").replace(/[^a-z0-9-]+/gi, "_");
    await dumpPage(frame, `${label}-${String(index).padStart(2, "0")}-${name}`).catch(() => {});
  }
  process.stderr.write(`worker: frames: ${(await frameInventory(ctx)).join(" | ")}\n`);
}

/** Read every course and its sections. Exported for tests, which run it against a fixture. */
export async function parseResults(frame: Frame): Promise<ParsedSearch> {
  return frame.evaluate(
    ({ containerPrefix, messagePrefix, termShownPrefix, termPatterns }) => {
      const clean = (value: string | null | undefined): string | null => {
        const text = (value ?? "").trim().replace(/\s+/g, " ");
        return text === "" ? null : text;
      };
      const byId = (id: string): string | null => clean(document.getElementById(id)?.textContent);

      const courses = Array.from(document.querySelectorAll(`[id^="${containerPrefix}"]`)).map(
        (container) => {
          // Section rows carry a page-global index, so they are collected from this
          // course's subtree. Exact suffix only: a prefix match on `MTG_CLASSNAME$`
          // also catches the inner `MTG_CLASSNAME$span$N` of the same cell, which is
          // how the schedule page grew a phantom meeting per course (ADR 0006).
          let rows = Array.from(container.querySelectorAll('[id^="MTG_CLASSNAME$"]')).filter((el) =>
            /^MTG_CLASSNAME\$\d+$/.test(el.id),
          );
          let indexOf = (el: Element) => el.id.slice("MTG_CLASSNAME$".length);
          if (rows.length === 0) {
            // Older markup names the section link differently; same grid otherwise.
            rows = Array.from(
              container.querySelectorAll('[id^="DERIVED_CLSRCH_SSR_CLASSNAME_LONG$"]'),
            ).filter((el) => /^DERIVED_CLSRCH_SSR_CLASSNAME_LONG\$\d+$/.test(el.id));
            indexOf = (el: Element) => el.id.slice("DERIVED_CLSRCH_SSR_CLASSNAME_LONG$".length);
          }

          const sections = rows.map((row) => {
            const n = indexOf(row);
            // The status is an icon; its meaning is in the alt text, not in any text node.
            const statusEl = document.getElementById(`win0divDERIVED_CLSRCH_SSR_STATUS_LONG$${n}`);
            const statusImg = statusEl?.querySelector("img");
            return {
              class_number: byId(`MTG_CLASS_NBR$${n}`),
              class_name: clean(row.textContent),
              days_times: byId(`MTG_DAYTIME$${n}`),
              room: byId(`MTG_ROOM$${n}`),
              instructor: byId(`MTG_INSTR$${n}`),
              meeting_dates: byId(`MTG_TOPIC$${n}`),
              status:
                clean(statusImg?.getAttribute("alt")) ??
                clean(statusImg?.getAttribute("title")) ??
                clean(statusEl?.textContent),
            };
          });

          return {
            title:
              clean(
                container.querySelector('[id^="SSR_CLSRSLT_WRK_GROUPBOX2GP$"]')?.textContent,
              ) ?? clean(container.querySelector(".PAGROUPDIVIDER")?.textContent),
            sections,
          };
        },
      );

      // The term the results are for: the criteria dropdown if the page still
      // carries it, else the header every self-service component renders.
      const termSelect = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find(
        (el) => termPatterns.some((p) => new RegExp(p).test(el.id)),
      );
      const termShown =
        clean(termSelect?.selectedOptions[0]?.textContent) ??
        clean(document.querySelector(`[id^="${termShownPrefix}"]`)?.textContent);

      return {
        term_shown: termShown,
        message: clean(document.querySelector(`[id^="${messagePrefix}"]`)?.textContent),
        courses,
      };
    },
    {
      containerPrefix: RESULT_CONTAINER_PREFIX,
      messagePrefix: MESSAGE_ID_PREFIX,
      termShownPrefix: "DERIVED_REGFRM1_SSR_STDNTKEY_DESCR",
      termPatterns: [...FIELD_PATTERNS.term],
    },
  );
}
