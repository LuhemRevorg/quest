// Navigation shared by every Quest self-service page.
//
// The shape is always the same: open a Fluid tile, land in an iframe, pick a term
// from a radio grid, press that page's Continue button, read the result. Only the
// Continue button's id and the payload differ — `UW_DRVD_SSS_SCT_SSR_PB_GO` on
// grades, `DERIVED_SSS_SCT_SSR_PB_GO` on the class schedule, which is exactly the
// kind of near-miss that makes copying a selector across pages a bad habit.

import type { Frame, Page } from "playwright";

import { WorkerError } from "./protocol.js";

/** The iframe every self-service component renders into. */
export const CONTENT_FRAME_NAME = "main_target_win0";

/**
 * Which term a component believes it is showing —
 * "Spring 2026 | Undergraduate | University of Waterloo".
 *
 * Matched by id prefix: the real id carries an arbitrary index
 * (`…_DESCR$5$` on grades, `…_DESCR$11$` on the schedule) that is not a row
 * number, so hardcoding either would be wrong on the other page.
 */
export const TERM_SHOWN_PREFIX = "DERIVED_REGFRM1_SSR_STDNTKEY_DESCR";

export interface TermRow {
  radioId: string;
  label: string;
}

/** The content frame, or null while it is still loading. */
export function contentFrame(page: Page): Frame | null {
  return page.frames().find((f) => f.name() === CONTENT_FRAME_NAME) ?? null;
}

/**
 * Open a Fluid homepage tile by its visible label and wait for its frame.
 *
 * By label rather than index: the tiles are `PTNUI_LAND_REC_GROUPLET$0..N` in
 * whatever order UW arranges the homepage, and that order is not ours to depend on.
 */
export async function openTile(page: Page, label: RegExp, timeoutMs: number): Promise<Frame> {
  const tiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[id^="win0divPTNUI_LAND_REC_GROUPLET$"]')).map((el) => ({
      id: el.id,
      text: (el.textContent ?? "").trim(),
    })),
  );

  const tile = tiles.find((t) => label.test(t.text));
  if (!tile) {
    throw new WorkerError(
      "unexpected_page",
      `no Quest tile matching ${label} — found: ${tiles.map((t) => t.text.slice(0, 20)).join(", ")}`,
    );
  }

  await page.locator(`#${tile.id.replace(/\$/g, "\\$")}`).click({ timeout: 15_000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = contentFrame(page);
    if (frame) {
      // The frame element exists before its document does.
      const ready = await frame
        .evaluate(() => document.readyState !== "loading" && !!document.body)
        .catch(() => false);
      if (ready) return frame;
    }
    await sleep(500);
  }
  throw new WorkerError(
    "unexpected_page",
    `tile ${label} did not open a "${CONTENT_FRAME_NAME}" frame — Quest's navigation may have changed`,
  );
}

/** The terms a component offers, newest first. */
export async function listTerms(frame: Frame): Promise<TermRow[]> {
  const rows = await frame.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type=radio][id^="SSR_DUMMY_RECV1$sels$"]',
      ),
    ).map((radio) => {
      const cells = Array.from(radio.closest("tr")?.querySelectorAll("td") ?? []).map((td) =>
        (td.textContent ?? "").trim().replace(/\s+/g, " "),
      );
      return { radioId: radio.id, label: cells.find((c) => /\b20\d\d\b/.test(c)) ?? "" };
    }),
  );
  return rows.filter((r) => r.label !== "");
}

/**
 * Select a term and press Continue.
 *
 * Clicked via `getElementById().click()` rather than a Playwright locator:
 * PeopleSoft ids contain `$`, and Continue is an `<input type="button">` whose
 * behaviour lives in an `onclick` that a synthetic click does fire.
 */
export async function selectTerm(
  frame: Frame,
  radioId: string,
  continueId: string,
): Promise<void> {
  const selected = await frame.evaluate((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return false;
    el.click();
    return el.checked;
  }, radioId);
  if (!selected) {
    throw new WorkerError("unexpected_page", `could not select the term radio ${radioId}`);
  }

  const pressed = await frame.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.click();
    return true;
  }, continueId);
  if (!pressed) {
    throw new WorkerError(
      "unexpected_page",
      `no "Continue" control (#${continueId}) on the term page — Quest's markup may have changed`,
    );
  }
}

/**
 * Wait for a component's content to replace the term picker.
 *
 * The postback is `ICAJAX`, so content can be swapped in without any navigation
 * event to await — hence polling for a marker the page only has once loaded.
 */
export async function waitForContent(
  page: Page,
  markerIdPrefix: string,
  timeoutMs: number,
  what: string,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = contentFrame(page);
    if (frame) {
      const ready = await frame
        .evaluate((prefix) => !!document.querySelector(`[id^="${prefix}"]`), markerIdPrefix)
        .catch(() => false);
      if (ready) return frame;
    }
    await sleep(500);
  }
  throw new WorkerError(
    "unexpected_page",
    `${what} never appeared after selecting a term — Quest's markup may have changed`,
  );
}

/** The term label the page rendered, for confirming it matches the request. */
export async function termShown(frame: Frame): Promise<string | null> {
  return frame.evaluate((prefix) => {
    const el = document.querySelector(`[id^="${prefix}"]`);
    const text = (el?.textContent ?? "").trim().replace(/\s+/g, " ");
    return text === "" ? null : text;
  }, TERM_SHOWN_PREFIX);
}

/**
 * Find the requested term among those offered, or explain what is available.
 * Not a parse failure — the term genuinely is not on offer.
 */
export function requireTerm(terms: TermRow[], wanted: string, what: string): TermRow {
  if (terms.length === 0) {
    throw new WorkerError(
      "unexpected_page",
      `no terms offered on the ${what} page — Quest's markup may have changed`,
    );
  }
  const match = terms.find((t) => t.label.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    throw new WorkerError(
      "unexpected_page",
      `no ${what} for "${wanted}". Quest offers: ${terms.map((t) => t.label).join(", ")}`,
    );
  }
  return match;
}

/** Refuse to hand back a term we did not ask for. */
export function assertTermMatches(shown: string | null, wanted: string): void {
  if (shown && !shown.toLowerCase().includes(wanted.toLowerCase())) {
    throw new WorkerError(
      "unexpected_page",
      `asked for "${wanted}" but the page is showing "${shown}"`,
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
