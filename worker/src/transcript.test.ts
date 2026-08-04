// Tests for the unofficial-transcript module.
//
// **These do not pin Quest's markup.** Unlike grades.test.ts and
// schedule.test.ts there is no captured fixture here — see ADR 0008 — so the
// pages below are hand-written and deliberately *adversarial*: the official
// component wearing a "View Report" button, a control that places an order, a
// sign-in page returned where a PDF was expected. What they pin is that the
// guards refuse in each of those cases, which is the part that costs $20 to get
// wrong.
//
// They also pin the *inverse*, which a live run corrected: a report type called
// "Undergrad Official" must stay selectable, because that is what UW names the
// report on the unofficial page.
//
// And they pin the two known routes in — Grades and Academics — including the
// Student Center's "other academic..." dropdown, whose go arrow has to be pressed
// and whose option is named "Transcript: View Unofficial".

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { chromium, type Browser, type Page } from "playwright";

import { WorkerError } from "./protocol.js";
import {
  assertNotASignInPage,
  assertUnofficialComponent,
  captureReport,
  chooseReportType,
  filenameFromDisposition,
  followUnofficialLink,
  isReportResponse,
  looksLikePaidOrder,
  openSection,
  readReportPicker,
  readReportPickerOn,
  selectReportType,
  sniffFormat,
  ensureReportType,
  waitForReportControl,
  TRANSCRIPT_SECTIONS,
  UNOFFICIAL_COMPONENT,
  UNOFFICIAL_COMPONENT_PATHS,
  UNOFFICIAL_LINK,
  type ReportOption,
} from "./transcript.js";
import { LAUNCH_ARGS } from "./browser.js";
import { URLS } from "./quest.js";

const UNOFFICIAL_URL =
  "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL?x=1";
const OFFICIAL_URL =
  "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_OFF.GBL?x=1";

const option = (label: string, value = label): ReportOption => ({ value, label });

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

async function pageWith(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

describe("paid-order detection", () => {
  it("flags controls that place an order", () => {
    for (const label of [
      "Request Official Transcript",
      "Order Transcript",
      "Submit Request",
      "Proceed to Checkout",
      "Payment",
    ]) {
      assert.equal(looksLikePaidOrder(label), true, label);
    }
    assert.equal(looksLikePaidOrder("View Report"), false);
  });

  it('does not treat the word "official" as a paid action', () => {
    // UW names its report types "Undergrad Official" *on the unofficial page*:
    // TSCRPT_TYPE names the report template and PeopleSoft shares those values
    // between both components. Treating the word as a money signal blocked the
    // only option that works. Officialness is the component's property, not the
    // label's — which is what `assertUnofficialComponent` is for.
    assert.equal(looksLikePaidOrder("Undergrad Official"), false);
    assert.equal(looksLikePaidOrder("Graduate Official"), false);
  });
});

describe("choosing a report type", () => {
  it("takes a sole option, whatever it is called", () => {
    assert.equal(chooseReportType([option("Undergrad Official")], null).label, "Undergrad Official");
  });

  it("refuses to guess a career when several reports are offered", () => {
    // Not a safety question — nothing on this component can order anything — but
    // handing an undergraduate a graduate transcript is silently-wrong output.
    assert.throws(
      () => chooseReportType([option("Undergrad Official"), option("Grad Official")], null),
      (err: unknown) => err instanceof WorkerError && /--report-type/.test(err.message),
    );
    assert.equal(
      chooseReportType([option("Undergrad Official"), option("Grad Official")], "undergrad").label,
      "Undergrad Official",
    );
  });

  it("reports an empty dropdown as a page change", () => {
    assert.throws(
      () => chooseReportType([], null),
      (err: unknown) => err instanceof WorkerError && /no report types/.test(err.message),
    );
  });

  it("refuses to guess between two similarly-named types", () => {
    const options = [
      option("Unofficial Transcript - Undergraduate"),
      option("Unofficial Transcript - Graduate"),
    ];
    assert.throws(
      () => chooseReportType(options, null),
      (err: unknown) => err instanceof WorkerError && /--report-type/.test(err.message),
    );
    // ...but takes direction. "graduate" is a substring of "Undergraduate", so a
    // plain substring match would make these two permanently ambiguous; the
    // word-boundary tier is what separates them.
    assert.equal(chooseReportType(options, "graduate").label, "Unofficial Transcript - Graduate");
    assert.equal(
      chooseReportType(options, "undergraduate").label,
      "Unofficial Transcript - Undergraduate",
    );
  });

  it("lists what is available when nothing matches", () => {
    assert.throws(
      () => chooseReportType([option("Unofficial Transcript")], "diploma"),
      (err: unknown) =>
        err instanceof WorkerError && /Quest offers: Unofficial Transcript/.test(err.message),
    );
  });

  it("reports an ambiguous --report-type rather than picking one", () => {
    assert.throws(
      () =>
        chooseReportType(
          [option("Unofficial Transcript A"), option("Unofficial Transcript B")],
          "unofficial transcript",
        ),
      (err: unknown) => err instanceof WorkerError && /matches several/.test(err.message),
    );
  });
});

describe("the component guard", () => {
  it("allows the unofficial component", () => {
    assert.doesNotThrow(() => assertUnofficialComponent(UNOFFICIAL_URL, "View Report"));
  });

  it("refuses the official component even when the button reads View Report", () => {
    assert.throws(
      () => assertUnofficialComponent(OFFICIAL_URL, "View Report"),
      (err: unknown) => err instanceof WorkerError && /not the/.test(err.message),
    );
  });

  it("refuses a control that looks like an order on the right page", () => {
    assert.throws(
      () => assertUnofficialComponent(UNOFFICIAL_URL, "Request Official Transcript"),
      (err: unknown) => err instanceof WorkerError && /paid/.test(err.message),
    );
  });

  it("refuses a page it cannot identify at all", () => {
    assert.throws(
      () => assertUnofficialComponent("https://quest.pecs.uwaterloo.ca/psp/SS/", "View Report"),
      (err: unknown) => err instanceof WorkerError,
    );
  });
});

describe("the route in", () => {
  // Both known UW routes end at a control naming the transcript, but they name it
  // differently and reach it differently.
  it("recognises the link whichever way round it is worded", () => {
    for (const label of [
      "Transcript: View Unofficial", // Student Center's "other academic..." dropdown
      "View Unofficial Transcript",
      "Unofficial Transcript",
      "unofficial transcript (opens in a new window)",
    ]) {
      assert.ok(UNOFFICIAL_LINK.test(label), label);
    }
  });

  it("does not match a transcript link that is not the unofficial one", () => {
    for (const label of ["Request Official Transcript", "Transcript Status", "Unofficial Grades"]) {
      assert.equal(UNOFFICIAL_LINK.test(label), false, label);
    }
  });

  it("recognises UW's component, which is spelled SSS_ not SSR_", () => {
    // Read from the live page's own form action. The `SSR_` spelling this file was
    // written against does not exist at UW, and matching only it meant the frame
    // filter discarded the transcript page while standing on it.
    const uw =
      "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL";
    assert.ok(UNOFFICIAL_COMPONENT.test(uw));
    // Still works on a stock deployment.
    assert.ok(UNOFFICIAL_COMPONENT.test("/c/SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL"));
  });

  it("does not mistake either official component for the unofficial one", () => {
    for (const paid of [
      "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SS_TSCRPT_OFF.GBL?Page=UW_TSCRPT_OFF",
      "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_OFF.GBL",
    ]) {
      assert.equal(UNOFFICIAL_COMPONENT.test(paid), false, paid);
      // And the paid guard must actually fire on it: UW's official component is
      // `SS_TSCRPT_OFF`, so a list carrying only the stock `SSR_TSRQST_OFF` left
      // the URL half of this guard inert here.
      assert.ok(looksLikePaidOrder(paid), paid);
    }
  });

  it("refuses to press a control on the paid component, and allows the free one", () => {
    assert.throws(
      () =>
        assertUnofficialComponent(
          "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SS_TSCRPT_OFF.GBL",
          "View Report",
        ),
      WorkerError,
    );
    assertUnofficialComponent(
      "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSS_TSRQST_UNOFF.GBL",
      "View Report",
    );
  });

  it("finds UW's report-type dropdown, whose id ends _TYPE3 and whose labels say neither 'transcript' nor 'report'", async () => {
    // The three selects of the live request page, verbatim. Anchoring the id on
    // `_TYPE$` missed `DERIVED_SSTSRPT_TSCRPT_TYPE3`, and the option-label fallback
    // looked for "transcript"/"report" against labels reading "Undergrad
    // Unofficial" — so the page appeared to have no report-type dropdown at all.
    const page = await pageWith(
      `<html><body>
         <select id="DERIVED_SSTSNAV_SSTS_MAIN_GOTO$27$">
           <option value="0200">My Academics</option><option value="0100">Student Center</option>
         </select>
         <select id="SA_REQUEST_HDR_INSTITUTION">
           <option value="UWATR" selected>University of Waterloo</option>
         </select>
         <select id="DERIVED_SSTSRPT_TSCRPT_TYPE3">
           <option value="" selected>&nbsp;</option>
           <option value="GRDUN">Graduate Unofficial</option>
           <option value="UGUN">Undergrad Unofficial</option>
         </select>
       </body></html>`,
    );
    const picker = await readReportPicker(page.mainFrame());
    assert.equal(picker.selectId, "DERIVED_SSTSRPT_TSCRPT_TYPE3");
    assert.deepEqual(
      picker.options.map((o) => o.value),
      ["GRDUN", "UGUN"],
    );
    assert.equal(picker.institution, "University of Waterloo");
    // And the navigation dropdown must not be mistaken for it.
    assert.equal(chooseReportType(picker.options, "undergrad").value, "UGUN");
    await page.close();
  });

  it("refuses to press View Report when the type will not stay selected", async () => {
    // Exactly what UW's page does: selecting a type fires a postback that rebuilds
    // the form with the field cleared. Pressing on regardless generates nothing and
    // burns the whole capture window before failing as a timeout.
    const page = await pageWith(
      `<html><body><select id="TSCRPT_TYPE" onchange="this.value=''">
         <option value=""></option>
         <option value="UGUN">Undergrad Unofficial</option>
       </select></body></html>`,
    );
    await assert.rejects(
      ensureReportType(page, "TSCRPT_TYPE", "UGUN", 1_500),
      /would not stay selected.*Pressing "View Report"/s,
    );
    await page.close();
  });

  it("accepts a report type that survives the postback", async () => {
    const page = await pageWith(
      `<html><body><select id="TSCRPT_TYPE">
         <option value=""></option>
         <option value="UGUN">Undergrad Unofficial</option>
       </select></body></html>`,
    );
    await page.evaluate(() => {
      (document.getElementById("TSCRPT_TYPE") as HTMLSelectElement).value = "UGUN";
    });
    await ensureReportType(page, "TSCRPT_TYPE", "UGUN", 1_500);
    await page.close();
  });

  it("matches UW's real report labels", () => {
    // "Undergrad Unofficial", not "Undergraduate" — `undergraduate` matches none of
    // them, which is what the documented example used to say.
    const options: ReportOption[] = [
      { value: "GRDUN", label: "Graduate Unofficial" },
      { value: "UGUN", label: "Undergrad Unofficial" },
    ];
    assert.equal(chooseReportType(options, "undergrad").value, "UGUN");
    assert.equal(chooseReportType(options, "graduate").value, "GRDUN");
    assert.throws(() => chooseReportType(options, "undergraduate"), /no report type matching/);
    assert.throws(() => chooseReportType(options, null), /offers several/);
  });

  it("tries the content servlet before the portal one", () => {
    // A live run showed `/psp/` alone failing to render the component. `/psc/` is
    // what this deployment serves — its own Fluid landing page is a `/psc/` URL.
    assert.match(UNOFFICIAL_COMPONENT_PATHS[0], /^\/psc\//);
    assert.match(UNOFFICIAL_COMPONENT_PATHS[1] ?? "", /^\/psp\//);
    for (const path of UNOFFICIAL_COMPONENT_PATHS) {
      assert.match(path, UNOFFICIAL_COMPONENT);
    }
  });

  it("knows the homepage that actually has tiles", () => {
    // The classic portal has none, which is what made `transcript` report "no tile
    // and no link" for every section it knows while the tiles sat one URL away.
    assert.match(URLS.fluidHome, /NUI_FRAMEWORK\.PT_LANDINGPAGE/);
    assert.notEqual(URLS.fluidHome, URLS.questHome);
  });

  it("finds no section on the classic portal, rather than a wrong one", async () => {
    // The classic portal's menu, as the failing run reported it. `Self Service`
    // leads to the transcript eventually, but none of these *are* a section, and
    // matching one loosely would click into the wrong place.
    const page = await pageWith(
      `<html><body>
         <a href="#">Favorites</a><a href="#">Main Menu</a><a href="#">Self Service</a>
         <a href="#">Waterloo Student Admin</a><a href="#">Curriculum Management</a>
         <a href="#">PeopleTools</a><a href="#">Home</a>
       </body></html>`,
    );
    for (const label of TRANSCRIPT_SECTIONS) {
      assert.equal(await openSection(page, label, 200), null, String(label));
    }
    await page.close();
  });

  it("ignores a help article that matches, and takes the real link", async () => {
    // The shape observed in the Class Schedule guide, which cost `search` a live
    // run: guided-process steps pointing at uwaterloo.ca help pages, whose titles
    // match the pattern as well as the real control does.
    const page = await pageWith(
      `<html><body>
         <li ptgpid="ADMN_S202407031403039692057855">
           <a steplabel="How do I view my unofficial transcript"
              href="https://uwaterloo.ca/the-centre/quest/quest-help/unofficial-transcript">
             How do I view my unofficial transcript</a>
         </li>
         <a href="https://uwaterloo.ca/help/view-unofficial-transcript">View Unofficial Transcript</a>
         <a id="real" href="#SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL"
            onclick="document.body.setAttribute('data-went','1')">View Unofficial Transcript</a>
       </body></html>`,
    );
    assert.equal(await followUnofficialLink(page.mainFrame()), "View Unofficial Transcript");
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-went")), "1");
    await page.close();
  });

  it("follows a guided-process step that points at the component", async () => {
    // The regression this guards: rejecting every `[ptgpid]` step to dodge the
    // help articles also rejected the real route, since Grades → Unofficial
    // Transcript *is* a step. Off-host is the discriminator, not the wrapper.
    const page = await pageWith(
      `<html><body>
         <li ptgpid="ADMN_S202407031403039692057855">
           <a steplabel="Unofficial Transcript" href="#SSR_TSRQST_UNOFF"
              onclick="document.body.setAttribute('data-went','1')">Unofficial Transcript</a>
         </li>
       </body></html>`,
    );
    assert.equal(await followUnofficialLink(page.mainFrame()), "Unofficial Transcript");
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-went")), "1");
    await page.close();
  });

  it("follows a plain link", async () => {
    const page = await pageWith(
      `<html><body>
         <a id="l" href="#" onclick="document.body.setAttribute('data-went','1')">
           View Unofficial Transcript
         </a>
       </body></html>`,
    );
    assert.equal(await followUnofficialLink(page.mainFrame()), "View Unofficial Transcript");
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-went")), "1");
    await page.close();
  });

  it("presses the go arrow beside the Student Center dropdown", async () => {
    // Selecting the option is not enough — "other academic..." needs the adjacent
    // go arrow to submit it. Leaving that out looks exactly like the route not
    // existing: the page simply stays where it is.
    const page = await pageWith(
      `<html><body><table><tr><td>
         <select id="DERIVED_SSS_SCL_SSS_MORE_ACAD_INFO">
           <option value="">other academic...</option>
           <option value="TSCRPT">Transcript: View Unofficial</option>
         </select>
         <input type="image" id="DERIVED_SSS_SCL_SSS_GO_1" alt="go"
                onclick="document.body.setAttribute('data-went','1')">
       </td></tr></table></body></html>`,
    );

    assert.equal(await followUnofficialLink(page.mainFrame()), "Transcript: View Unofficial");
    assert.equal(
      await page.evaluate(
        () =>
          (document.getElementById("DERIVED_SSS_SCL_SSS_MORE_ACAD_INFO") as HTMLSelectElement).value,
      ),
      "TSCRPT",
    );
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-went")), "1");
    await page.close();
  });

  it("opens a section from the classic portal's navigation links", async () => {
    // The live portal has no Fluid tiles at all — the sections are plain links in
    // a nav bar. Six "no such tile" failures were reported with all six links
    // sitting right there in the frame.
    const page = await pageWith(
      `<html><body>
         <a href="#">Skip to Main Content</a>
         <a href="#">Favorites</a>
         <a href="#" onclick="document.body.setAttribute('data-opened','academics')">Academics</a>
         <a href="#" onclick="document.body.setAttribute('data-opened','grades')">Grades</a>
         <a href="#">Class Schedule</a>
         <a href="#">Course Selection</a>
       </body></html>`,
    );

    assert.equal(await openSection(page, /^grades$/i, 1_000), 'link "Grades"');
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-opened")), "grades");

    assert.equal(await openSection(page, /^academics$/i, 1_000), 'link "Academics"');
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-opened")), "academics");
    await page.close();
  });

  it("reports no section rather than clicking a near-miss", async () => {
    const page = await pageWith(
      `<html><body><a href="#">Course Selection</a><a href="#">Financial Aid</a></body></html>`,
    );
    assert.equal(await openSection(page, /^grades$/i, 1_000), null);
    await page.close();
  });

  it("reports no route rather than clicking something else", async () => {
    const page = await pageWith(
      `<html><body><a href="#">Request Official Transcript</a></body></html>`,
    );
    assert.equal(await followUnofficialLink(page.mainFrame()), null);
    await page.close();
  });
});

describe("reading the request page", () => {
  // Hand-written, PeopleSoft-shaped. Pins that the finders key on content rather
  // than on an exact id, not that Quest's page looks like this.
  const REQUEST_PAGE = `
    <html><body>
      <select id="SSR_TSRQST_UNOFF_INSTITUTION">
        <option value="UWATR" selected>University of Waterloo</option>
      </select>
      <select id="SA_REQUEST_HDR_TSCRPT_TYPE">
        <option value=""></option>
        <option value="UGRD">Unofficial Transcript - Undergraduate</option>
        <option value="GRAD">Unofficial Transcript - Graduate</option>
      </select>
      <input type="button" id="DERIVED_SSTSRQST_SSR_PB_SUBMIT$0" value="View Report">
    </body></html>`;

  it("finds the report-type dropdown and the institution", async () => {
    const page = await pageWith(REQUEST_PAGE);
    const picker = await readReportPicker(page.mainFrame());

    // Not `SSR_TSRQST_UNOFF_INSTITUTION`: PeopleSoft embeds the component name in
    // every field's id, so a loose `/TSCRPT|RQST/` match picks the institution
    // dropdown instead. Same near-miss id collision as ADR 0005 and 0006.
    assert.equal(picker.selectId, "SA_REQUEST_HDR_TSCRPT_TYPE");
    assert.deepEqual(
      picker.options.map((o) => o.label),
      ["Unofficial Transcript - Undergraduate", "Unofficial Transcript - Graduate"],
    );
    assert.equal(picker.institution, "University of Waterloo");
    await page.close();
  });

  it("selects a report type so the component sees the change", async () => {
    const page = await pageWith(REQUEST_PAGE);
    // PeopleSoft rebuilds the page from the posted form, so a `change` event has
    // to fire — assigning `.value` alone leaves the component unaware.
    await page.evaluate(() => {
      const select = document.getElementById("SA_REQUEST_HDR_TSCRPT_TYPE")!;
      select.addEventListener("change", () => {
        document.body.setAttribute("data-changed", "1");
      });
    });

    await selectReportType(page.mainFrame(), "SA_REQUEST_HDR_TSCRPT_TYPE", "GRAD");

    assert.equal(
      await page.evaluate(
        () => (document.getElementById("SA_REQUEST_HDR_TSCRPT_TYPE") as HTMLSelectElement).value,
      ),
      "GRAD",
    );
    assert.equal(await page.evaluate(() => document.body.getAttribute("data-changed")), "1");
    await page.close();
  });

  it("rejects a report type the dropdown does not offer", async () => {
    const page = await pageWith(REQUEST_PAGE);
    await assert.rejects(
      selectReportType(page.mainFrame(), "SA_REQUEST_HDR_TSCRPT_TYPE", "NOPE"),
      (err: unknown) => err instanceof WorkerError,
    );
    await page.close();
  });

  it("refuses a View Report control that is not inside the unofficial component", async () => {
    // This page has the right button and the wrong provenance: `setContent` leaves
    // it at about:blank, so no frame up the tree names the component. Finding the
    // control is not permission to press it.
    const page = await pageWith(REQUEST_PAGE);
    await assert.rejects(
      waitForReportControl(page, 1_000),
      (err: unknown) => err instanceof WorkerError && /not inside/.test(err.message),
    );
    await page.close();
  });

  it("describes the frames it searched when there is no such control", async () => {
    const page = await pageWith("<html><body><p>Nothing here.</p><a>test</a></body></html>");
    await assert.rejects(
      waitForReportControl(page, 1_000),
      (err: unknown) =>
        // The message that a bare "markup may have changed" should have been: it
        // names the frame and what was on it.
        err instanceof WorkerError && /Frames: /.test(err.message) && /test/.test(err.message),
    );
    await page.close();
  });

  it("finds the dropdown without being told which frame holds it", async () => {
    const page = await pageWith(REQUEST_PAGE);
    const picker = await readReportPickerOn(page);
    assert.equal(picker.selectId, "SA_REQUEST_HDR_TSCRPT_TYPE");
    await page.close();
  });
});

describe("capturing the report", () => {
  // A stand-in for PeopleSoft, not a copy of it. Quest delivers the report
  // out-of-band and which channel it uses is a deployment detail, so both of the
  // plausible ones get exercised here against a local server: a popup rendering a
  // PDF, and a navigation that comes back as an attachment. Without this the
  // capture path — the riskiest code in the module — would have no coverage at all
  // until someone ran it against a real account.
  const PDF = Buffer.from("%PDF-1.4\n% a placeholder transcript\n%%EOF\n");

  /** The component name has to be in the URL, or the guard refuses to press. */
  const COMPONENT_PATH = "/psc/SS/ACADEMIC/SA/c/SA_LEARNER_SERVICES.SSR_TSRQST_UNOFF.GBL";

  let server: Server;
  let origin: string;
  let servedOnce = false;

  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/report-inline.pdf")) {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(PDF);
        return;
      }
      // A one-shot report URL: the PDF once, an error page to anyone who asks
      // again. PeopleSoft report links behave this way, and the second GET is
      // exactly what refetching a viewer tab from the outside performs.
      if (url.startsWith("/report-once.pdf")) {
        if (servedOnce) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>Your session has expired. Please try again.</body></html>");
          return;
        }
        servedOnce = true;
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(PDF);
        return;
      }
      if (url.startsWith("/report-attachment.pdf")) {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="unofficial_transcript.pdf"',
        });
        res.end(PDF);
        return;
      }
      // The request page. `target` decides which delivery channel it uses.
      const target = url.includes("attachment")
        ? "/report-attachment.pdf"
        : url.includes("once")
          ? "/report-once.pdf"
          : "/report-inline.pdf";
      const opener = url.includes("attachment")
        ? `window.location = '${target}'`
        : url.includes("trusted")
          ? // Only a real click opens this one, the way a popup-opening control
            // behaves: a window attributed to script rather than to a person is
            // what Chromium's popup blocker exists to stop.
            `if (event.isTrusted) { window.open('${target}', '_blank') }`
          : `window.open('${target}', '_blank')`;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<html><body>
           <select id="SA_REQUEST_HDR_TSCRPT_TYPE">
             <option value="UGRD">Unofficial Transcript</option>
           </select>
           <input type="button" value="View Report" onclick="${opener}">
         </body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function capture(query: string) {
    const page = await browser.newPage();
    await page.goto(`${origin}${COMPONENT_PATH}?${query}`);

    // The real sequence: find the control anywhere, prove the component owns it,
    // then press.
    const control = await waitForReportControl(page, 5_000);
    assert.equal(control.label, "View Report");
    assertUnofficialComponent(control.componentUrl, control.label);

    const report = await captureReport(page.context(), page, control.frame, 15_000);
    await page.close();
    return report;
  }

  it("captures a report that opens in a new window", async () => {
    const report = await capture("mode=popup");
    assert.equal(sniffFormat(report.bytes), "pdf");
    assert.deepEqual(report.bytes, PDF);
  });

  it("captures a report sent as an attachment, and reports its filename", async () => {
    const report = await capture("mode=attachment");
    assert.equal(sniffFormat(report.bytes), "pdf");
    assert.deepEqual(report.bytes, PDF);
    assert.equal(report.suggestedFilename, "unofficial_transcript.pdf");
  });

  it("gets the report out of a viewer tab whose URL only works once", async () => {
    // The described behaviour: "View Report" opens a new tab and Chrome renders
    // the PDF in it. Refetching that URL from outside the browser returns the
    // *error page*, because the link was one-shot — so the bytes have to come from
    // the tab itself, and a non-PDF must never be accepted in their place.
    servedOnce = false;
    const report = await capture("mode=once");
    assert.equal(sniffFormat(report.bytes), "pdf");
    assert.deepEqual(report.bytes, PDF);
    // *Which* channel wins is a browser-mode detail, not a contract: headless
    // Chromium has no PDF viewer and downloads the file, while a headed run
    // renders it in a tab and the bytes come back from inside that tab. Both are
    // correct; asserting one of them would pin the mode rather than the outcome.
    assert.ok(["download", "popup", "response"].includes(report.source), report.source);
  });

  it("presses View Report with a real click, as a window-opening control needs", async () => {
    // Quest's own page: "To view your Unofficial Transcript, please ensure your
    // pop-up blockers are disabled." The report arrives through a `window.open`,
    // and a synthetic `el.click()` is not a user gesture — the window never opens,
    // the form submits into a target that does not exist, and the run waits out its
    // whole capture window having produced no popup, no download and no error.
    const report = await capture("mode=trusted");
    assert.equal(sniffFormat(report.bytes), "pdf");
    assert.deepEqual(report.bytes, PDF);
  });

  it("fails with a useful message when nothing is produced", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}${COMPONENT_PATH}?mode=none`);
    // Neutralise the button so pressing it does nothing at all.
    await page.evaluate(() => {
      document.querySelector("input")?.setAttribute("onclick", "void 0");
    });

    await waitForReportControl(page, 5_000);
    await assert.rejects(
      captureReport(page.context(), page, page.mainFrame(), 1_500),
      (err: unknown) =>
        err instanceof WorkerError && /no report arrived within/.test(err.message),
    );
    await page.close();
  });
});

describe("the captured bytes", () => {
  it("identifies the format from the magic number, not the header", () => {
    assert.equal(sniffFormat(Buffer.from("%PDF-1.7\n...")), "pdf");
    assert.equal(sniffFormat(Buffer.from("  \n<!DOCTYPE html><html>")), "html");
    assert.equal(sniffFormat(Buffer.from("<html><body>x")), "html");
    assert.equal(sniffFormat(Buffer.from([0x00, 0x01, 0x02])), "unknown");
  });

  it("recognises which responses are worth reading", () => {
    assert.equal(isReportResponse("application/pdf", null), true);
    assert.equal(isReportResponse("application/octet-stream", null), true);
    assert.equal(isReportResponse("text/html", 'attachment; filename="t.pdf"'), true);
    assert.equal(isReportResponse("text/html", null), false);
    assert.equal(isReportResponse(null, null), false);
  });

  it("reads a filename without letting it reach into the filesystem", () => {
    assert.equal(filenameFromDisposition('attachment; filename="transcript.pdf"'), "transcript.pdf");
    assert.equal(filenameFromDisposition("attachment; filename=transcript.pdf"), "transcript.pdf");
    assert.equal(
      filenameFromDisposition("attachment; filename*=UTF-8''my%20transcript.pdf"),
      "my transcript.pdf",
    );
    // Only ever reported, never used as a path — but stripped regardless.
    assert.equal(
      filenameFromDisposition('attachment; filename="../../../etc/passwd"'),
      "passwd",
    );
    assert.equal(filenameFromDisposition(null), null);
    assert.equal(filenameFromDisposition("attachment"), null);
  });

  it("refuses a sign-in page dressed up as a transcript", () => {
    const signin = Buffer.from(
      '<html><body><form><input id="passwordInput"></form></body></html>',
    );
    assert.throws(
      () => assertNotASignInPage(signin, "html"),
      (err: unknown) => err instanceof WorkerError && err.code === "needs_reauth",
    );
    // A real HTML transcript is left alone.
    assert.doesNotThrow(() =>
      assertNotASignInPage(Buffer.from("<html><body>Academic Record</body></html>"), "html"),
    );
    assert.doesNotThrow(() => assertNotASignInPage(Buffer.from("%PDF-1.4"), "pdf"));
  });
});

describe("the browser the report needs", () => {
  it("launches with popup blocking off", () => {
    // Not a preference. Quest delivers the transcript through `window.open`, and
    // says so on the page; with the blocker on, "View Report" produces nothing at
    // all — no window, no download, no error — and the run times out. Removing
    // this flag as tidying would reintroduce a failure that looks like a hang.
    assert.ok(LAUNCH_ARGS.includes("--disable-popup-blocking"));
  });
});
