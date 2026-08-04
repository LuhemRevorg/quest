// Reaching and downloading the *unofficial* transcript.
//
// This is the one page in the project that can spend money if it is got wrong.
// Quest carries two transcript components, side by side in the same menu, with
// near-identical markup:
//
//   SSS_TSRQST_UNOFF   "View Unofficial Transcript"    free — what this reads
//   SS_TSCRPT_OFF      "Request Official Transcript"   a paid ($20) order
//
// (Both read off UW's live pages. Stock Campus Solutions names these
// `SSR_TSRQST_UNOFF` / `SSR_TSRQST_OFF`; the guards accept either spelling.)
//
// **The component is what decides whether this costs money, not the label.** The
// report-type dropdown on the *unofficial* page is full of options named
// "Undergrad Official", "Grad Official" and the like: `TSCRPT_TYPE` names the
// report template, and PeopleSoft shares those values between both components.
// An early version read the word "official" as a money signal and refused the
// only option that works.
//
// So the guard is on identity, not vocabulary: the content frame's URL must name
// `SS[SR]_TSRQST_UNOFF` immediately before any control is pressed, and a control
// whose label describes an *action* that places an order ("Submit Request",
// "Checkout") is refused. This is the same rule as "never submit a credential form
// we did not fill" (see handlers/login.ts), applied to money.
//
// Unlike grades.ts and schedule.ts there is **no fixture** behind the ids below:
// capturing one needs an account, and the page it produces is a complete academic
// record. The route has been corrected once from a live run; every failure names
// what it actually found on the page. See ADR 0008.
//
// Route (the human paths are Grades → unofficial transcript, and
// Academics → unofficial transcript):
//
//   /psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL
//     → iframe main_target_win0   ← the *inner* one; the portal wrapper around it
//                                   carries the same URL and holds no fields
//       → select   report type    ("Undergrad Official")
//       → button   "View Report"  (appears/rebuilds after the type postback)
//         → the report arrives out-of-band: a download, a PDF response, or a popup

import { createHash } from "node:crypto";

import type { BrowserContext, Download, Frame, Page, Response } from "playwright";

import { CONTENT_FRAME_NAME, openTile, sleep } from "./peoplesoft.js";
import { WorkerError } from "./protocol.js";
import { URLS, dumpPage, gotoAndSettle } from "./quest.js";

/**
 * The Campus Solutions component that renders the *unofficial* transcript
 * request. Every guard in this file keys on this string appearing in the content
 * frame's URL — PeopleSoft puts the component in the path, so it is the one piece
 * of identity the page cannot fake by looking similar.
 *
 * **`SSS_`, not `SSR_`.** UW serves
 * `SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL`, one letter off the name this file
 * was originally written against, read from the live page's own form action. That
 * single letter broke three things at once and none of them looked like a naming
 * problem: the frame filter dropped the very page it was standing on, both direct
 * URLs pointed at a component that does not exist, and the guard below would have
 * refused to press "View Report" on the correct page. Both spellings are accepted
 * so this still works on a stock deployment.
 */
export const UNOFFICIAL_COMPONENT = /SS[SR]_TSRQST_UNOFF/i;

/**
 * Direct component URLs, tried before the homepage tiles.
 *
 * Going straight there avoids depending on a tile label, and a wrong URL fails the
 * component guard below rather than landing somewhere unexpected.
 *
 * Both component spellings through both servlets. `/psc/` is the *content*
 * servlet: it renders the component on its own, with no portal chrome and no
 * iframe, which `waitForRequestForm` handles because it ranks frames rather than
 * requiring a named one. `/psp/` is the portal shell around it. UW's own links are
 * `/psc/`, so that goes first.
 */
export const UNOFFICIAL_COMPONENT_PATHS = [
  "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL",
  "/psp/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL",
  "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL",
  "/psp/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL",
] as const;

/** Kept for callers that want a single canonical path; the list above is the route. */
export const UNOFFICIAL_COMPONENT_PATH = UNOFFICIAL_COMPONENT_PATHS[0];

/**
 * Sections that lead to the transcript, tried in order.
 *
 * Two are known to work at UW — **Grades → unofficial transcript** and
 * **Academics → unofficial transcript** — and neither is named after transcripts,
 * which is why guessing names was never going to be enough on its own.
 *
 * Each is tried as a Fluid tile *and* as an ordinary link, because Quest serves
 * both: the Fluid homepage has `PTNUI_LAND_REC_GROUPLET` tiles, while the classic
 * portal puts `Academics`, `Grades`, `Class Schedule`, `Finances`… in a plain
 * navigation bar. A live run reached the classic portal and reported "no such
 * tile" six times over with all six links sitting in the frame.
 */
export const TRANSCRIPT_SECTIONS = [
  /^grades$/i,
  /^academics$/i,
  /^student center$/i,
  /^unofficial transcript$/i,
  /^transcripts?$/i,
  /^academic records$/i,
] as const;

/**
 * Frames PeopleSoft renders component content into.
 *
 * `main_target_win0` is the Fluid name that grades and schedule use;
 * `TargetContent` is what the classic portal calls it. Observed, not assumed.
 */
const CONTENT_FRAME_NAMES = [CONTENT_FRAME_NAME, "TargetContent"] as const;

/**
 * The way through to the unofficial transcript, once a tile is open.
 *
 * **Word order is not fixed.** PeopleSoft's Student Center calls it
 * "Transcript: View Unofficial"; other pages say "View Unofficial Transcript" or
 * "Unofficial Transcript". A regex spelling one order silently matches nothing on
 * the pages that use another — so this requires both words and takes no view on
 * how they are arranged.
 */
export const UNOFFICIAL_LINK = /^(?=.*\btranscript)(?=.*\bunofficial)/i;

/**
 * Anything that orders a transcript for money. Matched against component URLs and
 * against the label of any control before it is pressed. Refusing on a match is
 * always correct: this tool has no business placing a paid order, and the
 * unofficial page needs none of these to work.
 */
export const PAID_ORDER_PATTERNS = [
  // UW's paid component is `SS_TSCRPT_OFF.GBL` (page `UW_TSCRPT_OFF`), linked
  // from the unofficial page's own menu — *not* the stock `SSR_TSRQST_OFF` this
  // list originally carried. So the URL half of this guard matched nothing at UW
  // and only the label patterns below were doing any work. Found while chasing the
  // `SSS_`/`SSR_` naming difference; the same one letter hid both.
  /\bSS[SR]?_TSCRPT_OFF\b/i,
  /\bUW_TSCRPT_OFF\b/i,
  /SS[SR]_TSRQST_OFF\b/i,
  /request\s+official/i,
  /order\s+transcript/i,
  /submit\s+request/i,
  /\bcheckout\b/i,
  /\bpayment\b/i,
] as const;

export interface ReportOption {
  /** The `<option>` value PeopleSoft posts back. */
  value: string;
  label: string;
}

export interface ReportPicker {
  /** Element id of the `<select>` holding report types, if one was found. */
  selectId: string | null;
  options: ReportOption[];
  /** Whatever the institution field is showing, reported but never changed. */
  institution: string | null;
}

export type CaptureSource = "download" | "response" | "popup";

export interface CapturedReport {
  bytes: Buffer;
  contentType: string | null;
  suggestedFilename: string | null;
  source: CaptureSource;
}

/** How long to sit on a popup with nothing captured before refetching its URL. */
const POPUP_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 250;

/** Per direct-URL attempt. Short: either the component renders or that path is wrong. */
const DIRECT_URL_TIMEOUT_MS = 10_000;

// --- pure helpers, unit-tested without a browser ---------------------------

/**
 * True for a control whose label reads as *placing an order* — an action, not a
 * document.
 *
 * Deliberately **not** keyed on the word "official". UW's report types are named
 * "Undergrad Official", "Grad Official" and so on *on the unofficial page*:
 * `TSCRPT_TYPE` names the report template, and PeopleSoft shares those values
 * between both components. Officialness is a property of the component you are
 * in, not of the label — so the guard that matters is `assertUnofficialComponent`,
 * and filtering on the word here only ever blocked the one option that works.
 */
export function looksLikePaidOrder(text: string): boolean {
  return PAID_ORDER_PATTERNS.some((p) => p.test(text));
}

/**
 * Pick which report to request.
 *
 * Every option here is safe to select: this list comes from the *unofficial*
 * component, which cannot order anything, and the guarantee that we are on that
 * component is enforced separately by `assertUnofficialComponent`. So there is no
 * filtering on the labels — see `looksLikePaidOrder` for why filtering on the
 * word "official" was actively wrong.
 *
 * What remains is a correctness question rather than a safety one: picking the
 * wrong report means handing back a graduate transcript to an undergraduate. A
 * single option is taken; several without direction is an error listing them,
 * because guessing a career is exactly the silently-wrong output this project
 * refuses to produce.
 */
export function chooseReportType(options: ReportOption[], wanted: string | null): ReportOption {
  const safe = options;

  if (safe.length === 0) {
    throw new WorkerError(
      "unexpected_page",
      "the transcript page offered no report types — Quest's markup may have changed",
    );
  }

  if (wanted !== null && wanted.trim() !== "") {
    const needle = wanted.trim();
    const lower = needle.toLowerCase();
    const word = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");

    // Tiered, because a substring match alone is too blunt to be useful here:
    // "graduate" is a substring of "Undergraduate", so plain `includes` makes the
    // two most likely report types permanently ambiguous. A word-boundary match
    // separates them ("Undergraduate" has no boundary before "graduate") while
    // still accepting a partial label.
    for (const matches of [
      safe.filter((o) => o.label.toLowerCase() === lower),
      safe.filter((o) => word.test(o.label)),
      safe.filter((o) => o.label.toLowerCase().includes(lower)),
    ]) {
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new WorkerError(
          "unexpected_page",
          `"${wanted}" matches several report types: ${matches.map((o) => o.label).join(", ")} — ` +
            "pass a longer --report-type",
        );
      }
    }

    throw new WorkerError(
      "unexpected_page",
      `no report type matching "${wanted}". Quest offers: ${safe.map((o) => o.label).join(", ")}`,
    );
  }

  if (safe.length === 1) return safe[0]!;

  throw new WorkerError(
    "unexpected_page",
    `Quest offers several transcript reports (${safe.map((o) => o.label).join(", ")}) — ` +
      "pick one with --report-type",
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What the bytes actually are, read from their magic number rather than a header. */
export function sniffFormat(bytes: Buffer): "pdf" | "html" | "unknown" {
  const head = bytes.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("%pdf-")) return "pdf";
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml")) {
    return "html";
  }
  return "unknown";
}

/** A response worth reading the body of: the report itself, not the page around it. */
export function isReportResponse(
  contentType: string | null,
  contentDisposition: string | null,
): boolean {
  if (contentDisposition && /attachment/i.test(contentDisposition)) return true;
  if (!contentType) return false;
  return /application\/(pdf|octet-stream)/i.test(contentType);
}

/** `attachment; filename="transcript.pdf"` → `transcript.pdf`. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  const raw = (star?.[1] ?? plain?.[1] ?? "").trim();
  if (raw === "") return null;
  // Never let a server-supplied name reach into the filesystem; the Rust side
  // decides the path, and this value is reported, not obeyed.
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base === "" ? null : decodeURIComponent(base);
}

/**
 * The last gate before anything is pressed: prove the page is the unofficial
 * component, and that the control is not placing an order.
 *
 * Checked immediately before the click rather than only on arrival, because a
 * PeopleSoft postback can move the frame somewhere else in between. Both halves
 * have to hold — a control reading "View Report" on the *official* component
 * would submit a paid order just as happily.
 */
export function assertUnofficialComponent(frameUrl: string, controlLabel: string): void {
  if (!UNOFFICIAL_COMPONENT.test(frameUrl)) {
    throw new WorkerError(
      "unexpected_page",
      `refusing to press "${controlLabel}": the page is ${frameUrl.slice(0, 100)}, which is not ` +
        `the ${UNOFFICIAL_COMPONENT.source} component. This tool never submits a transcript ` +
        "request it cannot prove is the free, unofficial one.",
    );
  }
  if (PAID_ORDER_PATTERNS.some((p) => p.test(frameUrl))) {
    throw new WorkerError(
      "unexpected_page",
      `refusing to act on ${frameUrl.slice(0, 100)} — that URL orders a paid transcript`,
    );
  }
  if (looksLikePaidOrder(controlLabel)) {
    throw new WorkerError(
      "unexpected_page",
      `refusing to press "${controlLabel}" — that control looks like it places a paid ` +
        "transcript order, which this tool never does",
    );
  }
  // Note there is deliberately no check for the word "official" in the label:
  // UW's report types are named "Undergrad Official" *on the unofficial page*.
  // See `looksLikePaidOrder`.
}

/**
 * Refuse a captured report that is really a sign-in page. PeopleSoft answers an
 * expired session with a 200 and HTML, which would otherwise be written to disk
 * as a "transcript".
 */
export function assertNotASignInPage(bytes: Buffer, format: string): void {
  if (format !== "html") return;
  const text = bytes.subarray(0, 4096).toString("utf8");
  if (/signon|cmd=login|errorCode=|passwordInput/i.test(text)) {
    throw new WorkerError(
      "needs_reauth",
      "Quest returned a sign-in page instead of the transcript — the session did not survive",
    );
  }
}

// --- navigation ------------------------------------------------------------

/**
 * Land on the unofficial transcript component, or fail saying where we ended up.
 *
 * Direct component URL first, then walking in from a homepage — `Grades` first
 * among the sections, since that is the route a human takes at UW.
 *
 * **Which homepage is the whole problem.** An earlier version navigated to
 * `URLS.questHome`, the *classic* portal, before looking for tiles. That page has
 * none — it renders a `Main Menu` flyout — so all six sections reported "no tile
 * and no link" while sign-in had already left the browser on the Fluid landing
 * page where every tile lives. So the page we arrived on is now tried first, and
 * kept: `page.url()` is read before anything navigates away from it.
 */
export async function openUnofficialTranscript(page: Page, timeoutMs: number): Promise<Frame> {
  const origin = new URL(URLS.questHome).origin;
  // Read before the first navigation: this is wherever sign-in finished, which on
  // this deployment is the Fluid landing page.
  const landedOn = page.url();
  const tried: string[] = [];

  for (const path of UNOFFICIAL_COMPONENT_PATHS) {
    await gotoAndSettle(page, `${origin}${path}`).catch(() => {});
    const direct = await waitForRequestForm(page, DIRECT_URL_TIMEOUT_MS);
    if (direct) return direct;
    tried.push(`${path}: did not render the component`);
  }

  // Homepages, cheapest first. Duplicates dropped so a deployment whose sign-in
  // lands on one of the known URLs is not walked twice.
  const homes = [...new Set([landedOn, URLS.fluidHome, URLS.questHome])].filter(
    (url) => url !== "" && !url.startsWith("about:"),
  );

  for (const home of homes) {
    await gotoAndSettle(page, home).catch(() => {});
    const where = home === landedOn ? "the page sign-in landed on" : home;
    // What this homepage is actually offering, recorded whether or not it works:
    // "no tile called Grades" and "the Grades tile led nowhere" need different
    // fixes, and only the first is visible without this.
    tried.push(`${where} offers: ${(await tileLabels(page)).join(" / ") || "no tiles"}`);

    // The link may already be in reach without opening anything.
    const here = await followUnofficialLinkAnywhere(page, 2_000);
    if (here) {
      const landed = await waitForRequestForm(page, timeoutMs);
      if (landed) return landed;
    }

    for (const label of TRANSCRIPT_SECTIONS) {
      const opened = await openSection(page, label, timeoutMs);
      if (!opened) {
        tried.push(`${where} → ${String(label)}: no tile and no link`);
        continue;
      }
      const followed = await followUnofficialLinkAnywhere(page, 10_000);
      if (followed) {
        const landed = await waitForRequestForm(page, timeoutMs);
        if (landed) return landed;
        tried.push(`${where} → ${String(label)}: followed "${followed}", did not reach it`);
      } else {
        tried.push(
          `${where} → ${String(label)}: opened via ${opened}, no unofficial link ` +
            `(links here: ${(await linkLabels(page)).join(" / ") || "none"})`,
        );
      }

      // Dump the section we got into, not just the page the search ends on. The
      // section is where the answer is: a run that opens Grades and finds no
      // transcript link needs Grades' markup, and the loop has moved on by the
      // time the final dump is taken.
      await dumpFrames(page, `transcript-section-${String(label)}-${followed ? "followed" : "no-link"}`);

      // Opening the section moved us off the homepage, whichever way it then
      // failed; the next label has to start from the same place this one did.
      await gotoAndSettle(page, home).catch(() => {});
    }
  }

  // The message below promises the markup; write it rather than only offering to.
  for (const [index, frame] of page.frames().entries()) {
    const name = (frame.name() || "top").replace(/[^a-z0-9-]+/gi, "_");
    await dumpPage(frame, `transcript-not-found-${String(index).padStart(2, "0")}-${name}`).catch(
      () => {},
    );
  }

  throw new WorkerError(
    "unexpected_page",
    `could not reach the unofficial transcript (tried: ${tried.join("; ")}). ` +
      `Frames: ${(await describeFrames(page)).join(" ~~ ")}. ` +
      "Re-run with QUEST_DEBUG_DUMP_DIR set to capture the page.",
  );
}

/**
 * The Fluid tiles on the current page, as `openTile` sees them.
 *
 * Reported on every failed homepage: the landing page dump showed tiles reading
 * exactly `Grades`, `Class Schedule`, `Academics`… so when a section is not found
 * the useful question is which of those was actually on offer at the time.
 */
/** Every clickable label on the page, for saying what was there instead. */
async function linkLabels(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() =>
          Array.from(document.querySelectorAll("a, [role='link'], option"))
            .map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " "))
            .filter((text) => text !== "" && text.length < 45),
        )
        .catch((): string[] => []),
    ),
  );
  return [...new Set(perFrame.flat())].slice(0, 25);
}

/** Save every frame of the page, labelled. No-ops unless `QUEST_DEBUG_DUMP_DIR` is set. */
export async function dumpFrames(page: Page, label: string): Promise<void> {
  const safe = label.replace(/[^a-z0-9-]+/gi, "_");
  for (const [index, frame] of page.frames().entries()) {
    const name = (frame.name() || "top").replace(/[^a-z0-9-]+/gi, "_");
    await dumpPage(frame, `${safe}-${index}-${name}`).catch(() => {});
  }
}

async function tileLabels(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('[id^="win0divPTNUI_LAND_REC_GROUPLET$"]'))
        .map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30))
        .filter((text) => text !== ""),
    )
    .catch((): string[] => []);
}

/**
 * Open a section by name, as a Fluid tile or as an ordinary link.
 *
 * Returns how it was opened, or null if neither exists. Both are tried because
 * Quest serves both interfaces — see `TRANSCRIPT_SECTIONS`. The link search is
 * anchored on the whole visible text so that `Grades` cannot match
 * `Course Selection` or a breadcrumb mentioning grades in passing.
 */
export async function openSection(
  page: Page,
  label: RegExp,
  timeoutMs: number,
): Promise<string | null> {
  const tile = await openTile(page, label, timeoutMs).catch(() => null);
  if (tile) return "tile";

  for (const frame of page.frames()) {
    const clicked = await frame
      .evaluate((pattern: string) => {
        const re = new RegExp(pattern, "i");
        const text = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ");
        const link = Array.from(document.querySelectorAll("a")).find((a) => re.test(text(a)));
        if (!link) return null;
        link.click();
        return text(link);
      }, label.source)
      .catch(() => null);
    if (clicked !== null) return `link "${clicked}"`;
  }
  return null;
}

/**
 * Look for the way through on every frame until one turns up.
 *
 * Polled: clicking a section navigates, and the link we want does not exist until
 * that has finished.
 */
async function followUnofficialLinkAnywhere(
  page: Page,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      const followed = await followUnofficialLink(frame);
      if (followed) return followed;
    }
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return null;
}

/** How deep in the frame tree, used to prefer content over its wrapper. */
function frameDepth(frame: Frame): number {
  let depth = 0;
  for (let f = frame.parentFrame(); f; f = f.parentFrame()) depth += 1;
  return depth;
}

/**
 * Does this frame hold the request form?
 *
 * **A URL is not evidence of arrival.** We navigate to a URL containing the
 * component name, so seeing it come back proves only that the address bar
 * remembers what we asked for — PeopleSoft can answer with an empty portal shell,
 * a "not authorized", or a redirect, and the URL still matches. Trusting it did
 * exactly that: a live run "arrived", then found nothing but PeopleTools'
 * debug-console buttons (Copy / Clear / Hide / Close), which sit on every page and
 * are not content.
 *
 * Arrival therefore requires something only the real page has: a dropdown, or the
 * report control itself.
 */
async function hasRequestForm(frame: Frame): Promise<boolean> {
  return frame
    .evaluate(
      ({ selector, pattern }) => {
        if (document.readyState === "loading" || !document.body) return false;
        if (document.querySelector("select")) return true;
        const wanted = new RegExp(pattern, "i");
        return Array.from(document.querySelectorAll(selector)).some((el) =>
          wanted.test(((el as HTMLInputElement).value || el.textContent || "").trim()),
        );
      },
      { selector: CONTROL_SELECTOR, pattern: REPORT_CONTROL.source },
    )
    .catch(() => false);
}

/**
 * The frame holding the request form, once its URL names the unofficial
 * component *and* it has content.
 *
 * More than one frame can match on URL: PeopleSoft nests the portal's
 * `ptifrmtgtframe` around the component's `main_target_win0`, and both carry the
 * component in their URL, with `page.frames()` returning the wrapper first.
 * Matches are ranked — a known content frame name, then the deepest — and then have to
 * prove they hold the form.
 */
async function waitForRequestForm(page: Page, timeoutMs: number): Promise<Frame | null> {
  const rank = (frame: Frame) =>
    (CONTENT_FRAME_NAMES.some((name) => name === frame.name()) ? 100 : 0) + frameDepth(frame);

  const deadline = Date.now() + timeoutMs;
  do {
    const matches = page
      .frames()
      .filter((f) => UNOFFICIAL_COMPONENT.test(f.url()))
      .sort((a, b) => rank(b) - rank(a));

    for (const frame of matches) {
      if (await hasRequestForm(frame)) return frame;
    }
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return null;
}

/**
 * Click the way through to the unofficial transcript, and report what was
 * clicked. Returns null if this page offers no such route.
 *
 * Anchors *and* `<option>`s: PeopleSoft's "go to" navigation on pages like Grades
 * is often a `<select>` rather than a list of links, so matching only `<a>` would
 * miss the route entirely.
 *
 * It deliberately does **not** decide whether the click worked — the caller
 * re-checks for the request form. An earlier version fell back to "whatever is in
 * the content frame now", which reported success for a click that went nowhere.
 */
export async function followUnofficialLink(frame: Frame): Promise<string | null> {
  return frame
    .evaluate(({ pattern, componentPattern }) => {
      const re = new RegExp(pattern, "i");
      const componentRe = new RegExp(componentPattern, "i");

      // Two label readers, deliberately. Links and options are named by their
      // *text*: an `<option>` also has a `.value` ("TSCRPT"), and reading that
      // first makes every option fail to match the route. Buttons are the other
      // way round — a go arrow is an `<input type="image">` whose name is in
      // `value` or `alt` and whose textContent is empty.
      const text = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ");
      const controlLabel = (el: Element) =>
        (
          (el as HTMLInputElement).value ||
          el.textContent ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ");

      // Documentation is not navigation. The Class Schedule tile opens an activity
      // guide whose sidebar is six uwaterloo.ca help articles, one of them titled
      // "How to Search for Classes" — matching it cost `search` a whole live run
      // (ADR 0007). The Grades guide is built the same way, and a help page called
      // "How do I view my unofficial transcript" matches this pattern exactly.
      const navigational = (el: Element): boolean => {
        const href = el.getAttribute("href") ?? "";
        if (href !== "") {
          try {
            const target = new URL(href, location.href);
            if (/^https?:$/.test(target.protocol) && target.host !== location.host) return false;
          } catch {
            // Unparseable: treat as relative, i.e. still ours.
          }
        }
        // Deliberately *not* excluding guided-process steps. An earlier version
        // did, reasoning from `search` — but there the guide had no search step,
        // so nothing was lost. Here the route a human takes is Grades → Unofficial
        // Transcript, and that entry is itself a guide step pointing at the
        // component. Where the link *goes* is what separates help from navigation;
        // what it is wrapped in is not.
        return true;
      };

      const anchors = Array.from(document.querySelectorAll("a"))
        .filter((a) => re.test(text(a)))
        .filter(navigational);
      // The component's own name in the href beats any wording of the label.
      const link =
        anchors.find((a) => componentRe.test(a.getAttribute("href") ?? "")) ?? anchors[0];
      if (link) {
        link.click();
        return text(link);
      }

      for (const select of Array.from(document.querySelectorAll("select"))) {
        const option = Array.from(select.options).find((o) => re.test(text(o)));
        if (!option) continue;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));

        // The Student Center's "other academic..." dropdown does not navigate on
        // its own — a small go arrow beside it submits the choice. Selecting the
        // option and walking away leaves the page exactly where it was, which
        // looks identical to the route not existing.
        const scope = select.closest("td, tr, div, form") ?? document;
        const go = Array.from(
          scope.querySelectorAll<HTMLElement>(
            'input[type="image"], input[type="button"], input[type="submit"], a, [role="button"], button',
          ),
        ).find((el) => /^(go|»|>>|>)$/i.test(controlLabel(el)) || /_GO(_|\b)/i.test(el.id));
        go?.click();

        return text(option);
      }
      return null;
    }, { pattern: UNOFFICIAL_LINK.source, componentPattern: UNOFFICIAL_COMPONENT.source })
    .catch(() => null);
}

/** Per-frame summary for a failure message: name, url, and what is on it. */
async function describeFrames(page: Page): Promise<string[]> {
  const described: string[] = [];
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate((selector) => {
        const text = (el: Element) =>
          ((el as HTMLInputElement).value || el.textContent || el.getAttribute("alt") || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
        const uniq = (items: string[]) => [...new Set(items.filter((t) => t !== ""))].slice(0, 12);
        return {
          selects: Array.from(document.querySelectorAll("select")).map((s) => s.id || "(no id)"),
          controls: uniq(Array.from(document.querySelectorAll(selector)).map(text)),
          links: uniq(Array.from(document.querySelectorAll("a")).map(text)),
        };
      }, CONTROL_SELECTOR)
      .catch(() => null);

    const name = frame.name() || (frame.parentFrame() ? "(unnamed)" : "(main)");
    // Long enough to show the component at the end of a PeopleSoft path; the last
    // dump truncated at exactly the point where the component name begins.
    const url = frame.url().slice(0, 140);
    described.push(
      info === null
        ? `[${name} ${url}] unreadable`
        : `[${name} ${url}] selects=${info.selects.join(",") || "none"} ` +
            `controls=${info.controls.join("/") || "none"} links=${info.links.join("/") || "none"}`,
    );
  }
  return described;
}

/**
 * Read the report-type dropdown, searching the page rather than one frame.
 *
 * Which frame PeopleSoft renders a component into is not something to stake the
 * run on — the last two failures were both "right page, wrong frame" — and
 * reading a dropdown is a lookup, not an action, so widening the search costs no
 * safety. Frames naming the unofficial component are tried first all the same.
 */
export async function readReportPickerOn(page: Page): Promise<ReportPicker & { frame: Frame }> {
  const frames = page
    .frames()
    .sort((a, b) => Number(UNOFFICIAL_COMPONENT.test(b.url())) - Number(UNOFFICIAL_COMPONENT.test(a.url())));

  let fallback: (ReportPicker & { frame: Frame }) | null = null;
  for (const frame of frames) {
    const picker = await readReportPicker(frame).catch(() => null);
    if (!picker) continue;
    if (picker.selectId) return { ...picker, frame };
    fallback ??= { ...picker, frame };
  }
  return fallback ?? { selectId: null, options: [], institution: null, frame: page.mainFrame() };
}

/** Read the report-type dropdown and whatever institution one frame is showing. */
export async function readReportPicker(frame: Frame): Promise<ReportPicker> {
  return frame.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("select"));

    const optionsOf = (select: HTMLSelectElement) =>
      Array.from(select.options)
        .map((o) => ({ value: o.value, label: (o.textContent ?? "").trim() }))
        .filter((o) => o.label !== "");

    // The report-type select, identified by what it *contains* rather than by an
    // exact id. PeopleSoft names it `…TSCRPT_TYPE` in stock Campus Solutions, but
    // that id is precisely what has not been verified here, whereas "a dropdown
    // whose options mention transcripts" is unambiguous on this page.
    //
    // The institution and career pickers are excluded first. A loose
    // `/TSCRPT|RQST/` also matches `SSS_TSRQST_UNOFF_INSTITUTION` — the component
    // name is embedded in the id of every field on the page — which is the same
    // near-miss id collision as ADR 0005 and 0006. Anchor on the `_TYPE` suffix.
    // The trailing `\d*` is load-bearing: UW's select is
    // `DERIVED_SSTSRPT_TSCRPT_TYPE3`, and anchoring on `_TYPE$` missed it — the
    // page has no report-type dropdown as far as this function was concerned.
    // PeopleSoft appends those indices freely (see the class-search fields, which
    // carry `$31$`, `$0`), so a `$`-anchored id is a guess about numbering, not
    // about naming.
    const candidates = selects.filter((s) => !/INSTITUTION|CAREER/i.test(s.id));
    const byId = candidates.find((s) => /(TSCRPT|TRANSCRIPT|RPT)_TYPE\d*$/i.test(s.id));
    // And the labels are `Undergrad Unofficial` / `Graduate Unofficial`: neither
    // says "transcript" or "report", so the fallback matched nothing either. On a
    // page that *is* the transcript request, "unofficial" identifies the dropdown.
    const byOptions = candidates.find((s) =>
      optionsOf(s).some((o) => /transcript|report|unofficial/i.test(o.label)),
    );
    const report = byId ?? byOptions ?? null;

    const institutionSelect = selects.find((s) => /INSTITUTION/i.test(s.id));
    const institution =
      institutionSelect?.selectedOptions[0]?.textContent?.trim() ??
      document.querySelector('[id*="INSTITUTION"]')?.textContent?.trim() ??
      null;

    return {
      selectId: report?.id ?? null,
      options: report ? optionsOf(report) : [],
      institution: institution === "" ? null : institution,
    };
  });
}

/**
 * Select a report type by value.
 *
 * PeopleSoft rebuilds the page from the posted form, so the value has to be set
 * *and* the change dispatched — assigning `.value` alone leaves the component
 * believing nothing was picked.
 */
export async function selectReportType(
  frame: Frame,
  selectId: string,
  value: string,
): Promise<void> {
  const ok = await frame.evaluate(
    ({ id, wanted }) => {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      if (!select) return false;
      select.value = wanted;
      if (select.value !== wanted) return false;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { id: selectId, wanted: value },
  );
  if (!ok) {
    throw new WorkerError(
      "unexpected_page",
      `could not select report type "${value}" on #${selectId} — Quest's markup may have changed`,
    );
  }
}

/**
 * Make the report type stick, and prove it before anything is pressed.
 *
 * Selecting a type fires a FieldChange postback that rebuilds the frame, and the
 * rebuilt form comes back with the type **blank**. `selectReportType` verifies the
 * assignment in the same tick, which is true and useless — the value is gone a
 * moment later. Pressing "View Report" with no type selected is not an error
 * PeopleSoft reports usefully: it simply generates nothing, so the run spent the
 * whole 120-second capture window waiting for a report that was never coming, and
 * failed as a timeout. Same shape as the class-search criteria form (ADR 0007):
 * write, let the postback land, read back, and refuse to continue on a mismatch.
 *
 * The select is re-found on every attempt rather than reused, because the postback
 * replaces the element and often the frame around it.
 */
export async function ensureReportType(
  page: Page,
  selectId: string,
  value: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last: string | null = null;

  while (Date.now() < deadline) {
    const current = await readSelectValue(page, selectId);
    if (current === value) return;
    last = current;

    // Bounded: each write costs a postback, and hammering one would be a way to
    // make Quest angry rather than a way to make it agree.
    if (current !== null && attempts < 3) {
      attempts += 1;
      const frame = await frameWithSelect(page, selectId);
      if (frame) await selectReportType(frame, selectId, value).catch(() => {});
    }
    await sleep(POLL_INTERVAL_MS * 4);
  }

  throw new WorkerError(
    "unexpected_page",
    `the report type would not stay selected: asked for "${value}", #${selectId} holds ` +
      `"${last ?? "(the field is gone)"}" after ${attempts} attempts. Pressing "View Report" ` +
      "now would generate nothing and time out.",
  );
}

/** Every select on the page as `id: first few option labels`, for failure messages. */
export async function describeSelects(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() =>
          Array.from(document.querySelectorAll("select")).map((s) => {
            const labels = Array.from(s.options)
              .map((o) => (o.textContent ?? "").trim())
              .filter((t) => t !== "")
              .slice(0, 4);
            return `${s.id || "(no id)"}: ${labels.join(", ")}`;
          }),
        )
        .catch((): string[] => []),
    ),
  );
  return [...new Set(perFrame.flat())].slice(0, 10);
}

/** The frame currently holding a given select, since postbacks move it. */
async function frameWithSelect(page: Page, selectId: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate((id) => !!document.getElementById(id), selectId)
      .catch(() => false);
    if (has) return frame;
  }
  return null;
}

/** The select's current value, or null if it is not on the page at all. */
async function readSelectValue(page: Page, selectId: string): Promise<string | null> {
  for (const frame of page.frames()) {
    const value = await frame
      .evaluate((id) => {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        return el ? el.value : null;
      }, selectId)
      .catch(() => null);
    if (value !== null) return value;
  }
  return null;
}

/** The control that generates the report. `View Report` at UW. */
export const REPORT_CONTROL = /view\s+report|view\s+unofficial|^submit$|^go$/i;

/** Every control on the page, with the text a human would read off it. */
const CONTROL_SELECTOR =
  'input[type="button"], input[type="submit"], input[type="image"], a, [role="button"], button, [onclick]';

/** The component URL owning this frame — itself or an ancestor — if any. */
function owningComponentUrl(frame: Frame): string | null {
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    if (UNOFFICIAL_COMPONENT.test(f.url())) return f.url();
  }
  return null;
}

/**
 * Find the control that produces the report, and tag it so the click can happen
 * later without re-running the search.
 *
 * Polled rather than tried once — selecting a report type fires an `ICAJAX`
 * postback that rebuilds the frame, and looking immediately afterwards can search
 * the pre-postback DOM.
 *
 * Searched across **every** frame, not one subtree. Twice now the failure has
 * been "right page, wrong frame", and narrowing the search by a guess about
 * PeopleSoft's frame layout has not earned the trust. Safety does not come from
 * the narrow search: it comes from `componentUrl` below, which is the URL of the
 * frame or the nearest ancestor naming the unofficial component. A control with
 * no such ancestor is refused outright rather than skipped, because "View Report"
 * sitting outside the unofficial component is exactly the case worth shouting
 * about.
 *
 * On failure it describes every frame. A bare "markup may have changed" costs a
 * whole round trip against a live account to learn what is on the page.
 */
export async function waitForReportControl(
  page: Page,
  timeoutMs: number,
): Promise<{ frame: Frame; label: string; componentUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const candidate of page.frames()) {
      const label = await candidate
        .evaluate(
          ({ selector, pattern }) => {
            const wanted = new RegExp(pattern, "i");
            const textOf = (el: Element) =>
              (
                (el as HTMLInputElement).value ||
                el.textContent ||
                el.getAttribute("title") ||
                el.getAttribute("alt") ||
                el.getAttribute("aria-label") ||
                ""
              )
                .trim()
                .replace(/\s+/g, " ");

            const found = Array.from(document.querySelectorAll(selector)).find((el) =>
              wanted.test(textOf(el)),
            );
            if (!found) return null;
            found.setAttribute("data-quest-report-control", "1");
            return textOf(found);
          },
          { selector: CONTROL_SELECTOR, pattern: REPORT_CONTROL.source },
        )
        .catch(() => null);

      if (label === null) continue;

      const componentUrl = owningComponentUrl(candidate);
      if (componentUrl === null) {
        throw new WorkerError(
          "unexpected_page",
          `found a "${label}" control at ${candidate.url().slice(0, 100)}, which is not inside ` +
            `the ${UNOFFICIAL_COMPONENT.source} component. Refusing to press it.`,
        );
      }
      return { frame: candidate, label, componentUrl };
    }
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  throw new WorkerError(
    "unexpected_page",
    `no "View Report" control anywhere on the unofficial transcript page. ` +
      `Frames: ${(await describeFrames(page)).join(" ~~ ")}. ` +
      "Re-run with QUEST_DEBUG_DUMP_DIR set to capture the page.",
  );
}

/** Press the tagged control. Separate from finding it so listeners are up first. */
/**
 * Press "View Report".
 *
 * A real Playwright click first, because this control opens a window: the click
 * arrives as a trusted input event, which is the only kind a popup can be
 * attributed to. Elsewhere in this project a synthetic `el.click()` is the right
 * tool — PeopleSoft ids contain `$`, and its buttons carry their behaviour in an
 * `onclick` that a synthetic click fires perfectly well — but a postback and a
 * `window.open` are not the same thing, and only one of them cares who clicked.
 *
 * The marker attribute is set by `waitForReportControl`, which is also what makes
 * a plain CSS selector possible here.
 *
 * The synthetic click stays as a fallback: if the element is not actionable
 * (covered, off-screen, in a frame Playwright will not scroll) it is better to
 * press it the other way than to fail, and a deployment that delivers the report
 * inline needs no popup at all.
 */
async function pressReportControl(frame: Frame): Promise<void> {
  const selector = '[data-quest-report-control="1"]';
  try {
    await frame.locator(selector).click({ timeout: 10_000 });
    return;
  } catch {
    // Fall through to the synthetic press.
  }

  const pressed = await frame.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  if (!pressed) {
    throw new WorkerError("unexpected_page", "the report control vanished before it could be pressed");
  }
}

/**
 * Press "View Report" and capture whatever comes back.
 *
 * PeopleSoft delivers the report out-of-band and the exact channel varies by
 * deployment and by browser settings, so all three are watched at once:
 *
 *   1. a `download` event      — the server sent `Content-Disposition: attachment`
 *   2. a PDF response body     — Chromium rendered it in its own viewer
 *   3. a popup's URL, refetched through the context so it carries the session
 *
 * 1 and 2 hand back the original bytes. 3 is a refetch and therefore last: some
 * PeopleSoft report URLs are single-use, so it can return an error page where the
 * first two return the report.
 */
export async function captureReport(
  ctx: BrowserContext,
  page: Page,
  frame: Frame,
  timeoutMs: number,
): Promise<CapturedReport> {
  const captured: CapturedReport[] = [];
  // Held on one object rather than in three `let`s: these are only ever written
  // from event handlers, and TypeScript's flow analysis narrows a `let` it cannot
  // see being assigned down to `null`.
  const seen: { download: Download | null; popup: Page | null; popupSince: number } = {
    download: null,
    popup: null,
    popupSince: 0,
  };

  const onDownload = (d: Download) => {
    seen.download ??= d;
  };
  const onPopup = (p: Page) => {
    // A popup can be the one that downloads, so it gets the listener too. In
    // practice headless Chromium attributes a `window.open` to a PDF back to the
    // opener — but that is a Chromium detail, not a contract.
    p.on("download", onDownload);
    if (seen.popup) return;
    seen.popup = p;
    seen.popupSince = Date.now();
  };
  const onResponse = (res: Response) => {
    const headers = res.headers();
    const contentType = headers["content-type"] ?? null;
    const disposition = headers["content-disposition"] ?? null;
    if (!isReportResponse(contentType, disposition)) return;
    // Bodies are read off the event loop; a body that is gone (a download, say)
    // just means another channel owns this one.
    void res
      .body()
      .then((bytes) => {
        if (bytes.length > 0) {
          captured.push({
            bytes,
            contentType,
            suggestedFilename: filenameFromDisposition(disposition),
            source: "response",
          });
        }
      })
      .catch(() => {});
  };

  page.on("download", onDownload);
  ctx.on("page", onPopup);
  ctx.on("response", onResponse);

  /** What a popup handed back that was not a report, for the failure message. */
  let rejected: string | null = null;

  try {
    await pressReportControl(frame);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const first = captured[0];
      if (first) return first;

      if (seen.download) return await readDownload(seen.download);

      // A popup that has been sitting there with nothing else captured is
      // Chromium's PDF viewer showing the transcript. Two ways to get the bytes
      // out, in order of least interference: refetch the URL through the context,
      // then ask the tab itself. The second handles a `blob:` viewer URL and a
      // one-shot report URL, neither of which the first can.
      if (seen.popup && Date.now() - seen.popupSince > POPUP_GRACE_MS) {
        for (const attempt of [
          () => refetchPopup(ctx, seen.popup!),
          () => readPopupBytes(seen.popup!),
        ]) {
          const got = await attempt().catch(() => null);
          if (!got) continue;
          if (looksLikeTheReport(got)) return got;
          // Not the report — almost always a one-shot URL serving an error page
          // the second time. Say so rather than saving it as a transcript.
          rejected = `${got.contentType ?? "unknown type"}, ${sniffFormat(got.bytes)}`;
        }
        seen.popupSince = Date.now();
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new WorkerError(
      "unexpected_page",
      `no report arrived within ${Math.round(timeoutMs / 1000)}s of pressing "View Report"` +
        (seen.popup ? ` (a window opened at ${seen.popup.url().slice(0, 80)}` : "") +
        (seen.popup && rejected ? `, which yielded ${rejected} rather than a PDF)` : "") +
        (seen.popup && !rejected ? " but yielded no bytes)" : "") +
        ". Re-run with QUEST_DEBUG_DUMP_DIR set to capture the page.",
    );
  } finally {
    page.off("download", onDownload);
    ctx.off("page", onPopup);
    ctx.off("response", onResponse);
  }
}

async function readDownload(download: Download): Promise<CapturedReport> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return {
    bytes: Buffer.concat(chunks),
    contentType: null,
    suggestedFilename: download.suggestedFilename() || null,
    source: "download",
  };
}

async function refetchPopup(ctx: BrowserContext, popup: Page): Promise<CapturedReport | null> {
  const url = popup.url();
  if (!url || url === "about:blank") return null;
  // `ctx.request` speaks http(s) only, and a viewer tab is often on a blob: URL.
  if (!/^https?:/i.test(url)) return null;

  const response = await ctx.request.get(url);
  if (!response.ok()) return null;

  const bytes = await response.body();
  if (bytes.length === 0) return null;

  const headers = response.headers();
  return {
    bytes,
    contentType: headers["content-type"] ?? null,
    suggestedFilename: filenameFromDisposition(headers["content-disposition"] ?? null),
    source: "popup",
  };
}

/**
 * Read the report out of the tab that is displaying it.
 *
 * Pressing "View Report" opens the transcript in a new tab, in Chrome's PDF
 * viewer. Refetching that tab's URL from the outside is the first thing tried, but
 * it can fail in two ways this does not: PeopleSoft report URLs are frequently
 * one-shot, so a second GET returns an error page rather than the PDF, and a
 * viewer tab is often on a `blob:` URL that no external request can reach at all.
 *
 * Fetching from *inside* the tab has neither problem — it is the same origin, the
 * same session, and `blob:` resolves — and for a document already fetched it is
 * usually served from cache rather than re-requested.
 */
async function readPopupBytes(popup: Page): Promise<CapturedReport | null> {
  const url = popup.url();
  if (!url || url === "about:blank") return null;

  const result = await popup
    .evaluate(async () => {
      const response = await fetch(location.href, { credentials: "include" });
      if (!response.ok) return null;
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length === 0) return null;
      // Chunked: `String.fromCharCode(...buf)` blows the argument limit on a
      // transcript-sized file.
      let binary = "";
      for (let i = 0; i < buffer.length; i += 0x8000) {
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      }
      return { base64: btoa(binary), contentType: response.headers.get("content-type") };
    })
    .catch(() => null);

  if (!result) return null;
  return {
    bytes: Buffer.from(result.base64, "base64"),
    contentType: result.contentType,
    suggestedFilename: null,
    source: "popup",
  };
}

/**
 * Is this actually the report, or a page that merely arrived where one was due?
 *
 * A one-shot report URL fetched twice returns HTML — an error page, a "your
 * session has expired", a menu. All of those have a 200 and a non-empty body, so
 * without this the run would save one under the transcript's name and call it a
 * success. Sniffed from the bytes, not from the header, for the same reason
 * `sniffFormat` exists.
 */
function looksLikeTheReport(report: CapturedReport): boolean {
  return sniffFormat(report.bytes) === "pdf" || /application\/pdf/i.test(report.contentType ?? "");
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
