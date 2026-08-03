// Parser and form-driving tests for "Search for Classes".
//
// The fixtures here are **synthetic** — hand-built from the stock Campus Solutions
// component, not captured from UW (see ADR 0007 and fixtures/README.md). They pin
// how the code handles markup of that *shape*: page-global row indices, near-miss
// ids, arbitrary `$N` suffixes on the criteria fields, a status that only exists as
// an icon's alt text. They cannot pin UW's actual ids, and a real capture should
// replace them — at which point these same assertions become meaningful.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Frame, type Page } from "playwright";

import {
  assertCriteriaMatch,
  clickSearchEntry,
  fillCriteria,
  gotoStudentCenter,
  parseResults,
  readCriteria,
  selectSearchTerm,
  submitSearch,
  waitForCriteriaForm,
} from "./search.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

/** The fixtures are saved frame documents, so the main frame is the content frame. */
async function fixture(name: string): Promise<Page> {
  const page = await browser.newPage();
  const path = new URL(`../../fixtures/html/${name}`, import.meta.url).pathname;
  await page.goto(pathToFileURL(path).href, { waitUntil: "domcontentloaded" });
  return page;
}

const frameOf = (page: Page): Frame => page.mainFrame();

describe("class search results parser", () => {
  let page: Page;

  before(async () => {
    page = await fixture("class-search-results.synthetic.html");
  });

  it("finds one entry per course, not per group divider", async () => {
    // `win0divSSR_CLSRSLT_WRK_GROUPBOX2GP$N` is one character away from the
    // container id; a sloppier prefix would report four courses.
    const parsed = await parseResults(frameOf(page));
    assert.equal(parsed.courses.length, 2);
  });

  it("reads the course heading", async () => {
    const parsed = await parseResults(frameOf(page));
    assert.deepEqual(
      parsed.courses.map((c) => c.title),
      ["ABCD 100 - Placeholder Course Title", "ABCD 100L - Placeholder Lab Course"],
    );
  });

  it("attaches sections to the course that owns them", async () => {
    // Row ids are global across the page: course 0 owns rows 0 and 1, course 1
    // owns row 2. Index arithmetic would give course 1 row 1.
    const parsed = await parseResults(frameOf(page));
    assert.deepEqual(
      parsed.courses.map((c) => c.sections.length),
      [2, 1],
    );
    assert.deepEqual(
      parsed.courses.map((c) => c.sections.map((s) => s.class_number)),
      [["4382", "4383"], ["4390"]],
    );
  });

  it("ignores the inner span of a section cell", async () => {
    // `MTG_CLASSNAME$span$0` matches the prefix and is not a row — the same
    // collision that produced a phantom meeting per course on the schedule page.
    const parsed = await parseResults(frameOf(page));
    assert.equal(parsed.courses[0]?.sections.length, 2);
    assert.equal(parsed.courses[0]?.sections[0]?.class_name, "001-LEC Regular");
  });

  it("reads every field of a section", async () => {
    const parsed = await parseResults(frameOf(page));
    const section = parsed.courses[0]?.sections[1];
    assert.equal(section?.class_name, "002-TUT Regular");
    assert.equal(section?.class_number, "4383");
    assert.equal(section?.days_times, "TTh 2:30PM - 3:20PM");
    assert.equal(section?.room, "MC 2054");
    assert.equal(section?.instructor, "Instructor Name");
    assert.equal(section?.meeting_dates, "09/08/2026 - 12/07/2026");
  });

  it("reads the status out of the icon, which has no text", async () => {
    const parsed = await parseResults(frameOf(page));
    assert.deepEqual(
      parsed.courses.flatMap((c) => c.sections.map((s) => s.status)),
      ["Open", "Closed", "Wait List"],
    );
  });

  it("reads the term it searched, so a mismatch can be caught", async () => {
    const parsed = await parseResults(frameOf(page));
    assert.match(parsed.term_shown ?? "", /Fall 2026/);
  });

  it("returns no courses for a page with no results grid", async () => {
    const blank = await browser.newPage();
    await blank.setContent(
      `<html><body><span id="DERIVED_CLSMSG_ERROR_TEXT">The search returns no results that
       match the criteria specified.</span></body></html>`,
    );
    const parsed = await parseResults(blank.mainFrame());
    assert.deepEqual(parsed.courses, []);
    // "Nothing matched" is an answer, and it comes back as Quest's own words
    // rather than as an empty list the caller has to interpret.
    assert.match(parsed.message ?? "", /no results/);
    await blank.close();
  });
});

describe("class search criteria form", () => {
  let page: Page;

  before(async () => {
    page = await fixture("class-search-criteria.synthetic.html");
  });

  it("selects the term by its label", async () => {
    const term = await selectSearchTerm(frameOf(page), { label: "Fall 2026", code: "1269" });
    assert.equal(term.label, "Fall 2026");
    // The fixture opens on Spring 2026, so this is a real change and the caller
    // has to wait out the postback before typing anything.
    assert.equal(term.changed, true);
  });

  it("falls back to the term code when the label is worded differently", async () => {
    const term = await selectSearchTerm(frameOf(page), { label: "Autumn 2026", code: "1269" });
    assert.equal(term.label, "Fall 2026");
  });

  it("lists the terms on offer when the wanted one is not there", async () => {
    await assert.rejects(
      selectSearchTerm(frameOf(page), { label: "Fall 2011", code: "1119" }),
      /no class search for "Fall 2011".*Spring 2026, Fall 2026, Winter 2027/s,
    );
  });

  it("fills the subject and course number, and reads them back", async () => {
    const criteria = { subject: "CS", catalog_number: "246" };
    await fillCriteria(frameOf(page), criteria);
    const shown = await readCriteria(frameOf(page));
    assert.deepEqual(shown, criteria);
    assertCriteriaMatch(shown, criteria);
  });

  it("forces the course number comparison to 'is exactly'", async () => {
    // Left on "contains", `246` would also return 1246 and 2460.
    await frameOf(page).evaluate(() => {
      (document.getElementById("SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$0") as HTMLSelectElement).value =
        "C";
    });
    await fillCriteria(frameOf(page), { subject: "CS", catalog_number: "246" });
    const operator = await frameOf(page).evaluate(
      () => (document.getElementById("SSR_CLSRCH_WRK_SSR_EXACT_MATCH1$0") as HTMLSelectElement).value,
    );
    assert.equal(operator, "E");
  });

  it("refuses to search on criteria the form is not holding", () => {
    // The term postback re-renders the form; landing between the write and the
    // click would otherwise search for something we never asked for.
    assert.throws(
      () => assertCriteriaMatch({ subject: "", catalog_number: "" }, { subject: "CS", catalog_number: "246" }),
      /did not keep the criteria/,
    );
  });

  it("recognises and submits the form by its caption when the button id differs", async () => {
    // The one thing about this page not open to an id-naming difference is what the
    // user sees on the button. Requires the subject field too: a lone "Search"
    // button appears on half of Quest.
    const renamed = await browser.newPage();
    await renamed.setContent(`
      <html><body><form>
        <input id="SSR_CLSRCH_WRK_SUBJECT$7" />
        <input type="button" id="SOMETHING_ELSE" value="Search"
               onclick="document.title = 'submitted'" />
      </form></body></html>
    `);
    const found = await waitForCriteriaForm(renamed.context(), 2_000);
    await submitSearch(found);
    assert.equal(await renamed.title(), "submitted");
    await renamed.close();
  });

  it("says what fields the page did have when the form is not the one we expect", async () => {
    const other = await browser.newPage();
    await other.setContent(
      `<html><body><form><input id="SOME_OTHER_FIELD$0" /></form></body></html>`,
    );
    await assert.rejects(
      fillCriteria(other.mainFrame(), { subject: "CS", catalog_number: "246" }),
      /no subject or course number field.*SOME_OTHER_FIELD\$0/s,
    );
    await other.close();
  });
});

describe("the search entry point", () => {
  it("clicks the shortest matching label, not an ancestor that contains it", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <a id="outer" href="#outer">Enrolment: Add, Drop, Search for Classes and more</a>
        <a id="inner" href="#inner">Search for Classes</a>
      </body></html>
    `);
    const entry = await clickSearchEntry(page.context());
    assert.equal(entry?.label, "Search for Classes");
    assert.match(page.url(), /#inner$/);
    await page.close();
  });

  it("does not mistake the help article for the navigation", async () => {
    // Taken from the live page: the Class Schedule tile opens an activity guide
    // whose sidebar links to uwaterloo.ca help pages, one of them titled "How to
    // Search for Classes". It contains the phrase, it is shorter than most real nav
    // labels, and clicking it opens a marketing page in a new tab — which is what
    // the first live run did.
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <li ptgpid="ADMN_S202407031403039692057855">
          <a id="win1divPTGP_STEP_DVW_PTGP_STEP_BTN_GB$3" role="link"
             steplabel="How to Search for Classes"
             href="https://uwaterloo.ca/the-centre/quest/quest-help/how-do-i-search">How to Search for Classes</a>
        </li>
        <a id="real" href="#found">Search for Classes</a>
      </body></html>
    `);
    const entry = await clickSearchEntry(page.context());
    assert.equal(entry?.label, "Search for Classes");
    assert.match(page.url(), /#found$/);
    await page.close();
  });

  it("takes nothing at all over an off-site link that merely matches", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <html><body>
        <a href="https://uwaterloo.ca/the-centre/quest/quest-help/x">Search for Classes</a>
      </body></html>
    `);
    assert.equal(await clickSearchEntry(page.context()), null);
    await page.close();
  });

  it("crosses to the Student Center when the guide has no search step", async () => {
    // The classic component's own navigation, as it appears on My Class Schedule:
    // a `go to` dropdown whose id carries the usual arbitrary suffix, beside Go.
    const page = await browser.newPage();
    await page.setContent(`
      <html><body><form>
        <select id="DERIVED_SSTSNAV_SSTS_MAIN_GOTO$27$">
          <option value="9999"></option>
          <option value="0200">My Academics</option>
          <option value="0100">Student Center</option>
        </select>
        <a id="DERIVED_SSTSNAV_GO" href="#" onclick="document.title = 'went'">Go</a>
      </form></body></html>
    `);
    assert.equal(await gotoStudentCenter(page.mainFrame()), true);
    assert.equal(await page.title(), "went");
    assert.equal(
      await page.evaluate(
        () =>
          (document.getElementById("DERIVED_SSTSNAV_SSTS_MAIN_GOTO$27$") as HTMLSelectElement).value,
      ),
      "0100",
    );
    await page.close();
  });

  it("reports not finding it rather than clicking something else", async () => {
    const page = await browser.newPage();
    await page.setContent(`<html><body><a href="#">My Class Schedule</a></body></html>`);
    assert.equal(await clickSearchEntry(page.context()), null);
    await page.close();
  });
});
