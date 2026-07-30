// Parser tests against the real "My Class Schedule" page, sanitized.
//
// Every personal value is a placeholder — the student's name, the enrolled course
// codes and titles, the class numbers, and the **instructor's name**, which is a
// third party's data and gets the same treatment. Only structure and element ids
// are real, which is all these tests assert on.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Frame, type Page } from "playwright";

import { parseSchedule } from "./schedule.js";

const FIXTURE = "schedule-spring2026.sanitized.html";

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

/** The fixture is a saved frame document, so the main frame is the content frame. */
const frame = (): Frame => page.mainFrame();

describe("schedule parser", () => {
  it("finds one entry per enrolled course", async () => {
    const parsed = await parseSchedule(frame());
    assert.equal(parsed.courses.length, 2);
  });

  it("reads the course title from the group divider", async () => {
    const parsed = await parseSchedule(frame());
    assert.deepEqual(
      parsed.courses.map((c) => c.title),
      ["ABCD 100 - Placeholder Work-Study Course", "EFGH 200 - Second Placeholder Course"],
    );
  });

  it("reads course-level status, units and grading basis", async () => {
    const parsed = await parseSchedule(frame());
    const first = parsed.courses[0]!;
    assert.equal(first.status, "Enrolled");
    assert.equal(first.units, "0.50");
    assert.equal(first.grading_basis, "Placeholder Grading Basis");
  });

  it("attaches meetings to the course that owns them", async () => {
    // Meeting ids are global across the page, not per course, so meetings are
    // gathered from each course container's subtree. Index arithmetic would work by
    // luck here — one meeting each — and mis-group a course with a lecture *and* a
    // tutorial. This asserts the grouping, not just the count.
    const parsed = await parseSchedule(frame());
    assert.deepEqual(
      parsed.courses.map((c) => c.meetings.length),
      [1, 1],
    );
    assert.deepEqual(
      parsed.courses.map((c) => c.meetings[0]?.class_number),
      ["1000", "1001"],
    );
  });

  it("reads every field of a meeting", async () => {
    const parsed = await parseSchedule(frame());
    const meeting = parsed.courses[1]!.meetings[0]!;
    assert.equal(meeting.class_number, "1001");
    assert.equal(meeting.section, "081");
    assert.equal(meeting.component, "LEC");
    assert.equal(meeting.days_times, "TBA");
    assert.equal(meeting.room, "ONLN - Online");
    assert.equal(meeting.instructor, "Instructor Name");
    assert.equal(meeting.start_end, "11/05/2026 - 05/08/2026");
  });

  it("reads the term it is showing, so a mismatch can be caught", async () => {
    const parsed = await parseSchedule(frame());
    assert.match(parsed.term_shown ?? "", /Spring 2026/);
  });

  it("returns no courses for a page with no class list", async () => {
    const blank = await browser.newPage();
    await blank.setContent("<html><body><p>Nothing here.</p></body></html>");
    const parsed = await parseSchedule(blank.mainFrame());
    assert.deepEqual(parsed.courses, []);
    assert.equal(parsed.term_shown, null);
    await blank.close();
  });
});
