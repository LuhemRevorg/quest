// Parser tests against the real "View My Grades" page, sanitized.
//
// This is the test the brief asks for: a Quest-side markup change should surface as
// a red test here, not as silently-wrong grades. Every assertion below is keyed to
// an element id that a UW redesign would plausibly move.
//
// The fixture is the real page with every personal value replaced: name, any 8-digit
// ids, `ICSID`, and — unlike a first pass at this — the course codes, descriptions,
// grades and academic standing too. Only structure and element ids are real, which is
// all these tests are about. Real marks in a committed file is not a trade worth
// making for slightly more realistic strings.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Frame, type Page } from "playwright";

import { parseGrades } from "./grades.js";

const FIXTURE = "grades-winter2026.sanitized.html";

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  const path = new URL(`../../fixtures/html/${FIXTURE}`, import.meta.url).pathname;
  await page.goto(pathToFileURL(path).href, { waitUntil: "domcontentloaded" });
});

after(async () => {
  await browser?.close();
});

/** The fixture is a saved frame document, so the main frame *is* the grades frame. */
const frame = (): Frame => page.mainFrame();

describe("grades parser", () => {
  it("finds every course row and stops at the end", async () => {
    const parsed = await parseGrades(frame());
    // Six is what this term actually holds; the loop must not run past it.
    assert.equal(parsed.courses.length, 6);
  });

  it("reads the class code from CLS_LINK, not the term header", async () => {
    // Regression: the class was first read from
    // `DERIVED_REGFRM1_SSR_STDNTKEY_DESCR$N$`, which exists exactly once (as the
    // term header) and collided at N=5 — leaking
    // "Winter 2026 | Undergraduate | …" into the last row's class.
    const parsed = await parseGrades(frame());
    const classes = parsed.courses.map((c) => c.class_name);
    assert.deepEqual(classes, [
      "ABCD 100", "ABCD 200", "EFGH 150", "IJKL 331", "IJKL 332", "IJKL 341",
    ]);
    for (const name of classes) {
      assert.doesNotMatch(name ?? "", /Undergraduate|\|/, "term header leaked into a class");
    }
  });

  it("reads each column of a row", async () => {
    const parsed = await parseGrades(frame());
    const first = parsed.courses[0]!;
    assert.equal(first.class_name, "ABCD 100");
    assert.equal(first.description, "Introductory Placeholder");
    assert.equal(first.units, "0.50");
    assert.equal(first.grade, "88");
    assert.equal(first.grade_points, "44.000");
  });

  it("reads the term it is showing, so a mismatch can be caught", async () => {
    // This guard was inert until this test existed: it read
    // `UW_DRVD_SSS_SCT_SSS_TERM_LINK`, which is present but empty, so `term_shown`
    // was always null and the mismatch check never fired.
    const parsed = await parseGrades(frame());
    assert.match(parsed.term_shown ?? "", /Winter 2026/);
    assert.notEqual(parsed.term_shown, null);
  });

  it("reads academic standing", async () => {
    const parsed = await parseGrades(frame());
    assert.equal(parsed.academic_standing, "Placeholder Standing");
  });

  it("returns no rows for a page with no grade grid", async () => {
    // An empty term must yield zero courses rather than throwing or inventing rows.
    const blank = await browser.newPage();
    await blank.setContent("<html><body><p>Nothing here.</p></body></html>");
    const parsed = await parseGrades(blank.mainFrame());
    assert.deepEqual(parsed.courses, []);
    assert.equal(parsed.term_shown, null);
    await blank.close();
  });
});
