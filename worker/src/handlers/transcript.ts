import type { BrowserContext, Page } from "playwright";

import { WorkerError, progress, type TranscriptParams } from "../protocol.js";
import {
  assertNotASignInPage,
  assertUnofficialComponent,
  captureReport,
  chooseReportType,
  dumpFrames,
  describeSelects,
  ensureReportType,
  openUnofficialTranscript,
  readReportPickerOn,
  selectReportType,
  sha256,
  sniffFormat,
  waitForReportControl,
  type CaptureSource,
} from "../transcript.js";
import { withSession } from "./login.js";

const FRAME_TIMEOUT_MS = 30_000;

/**
 * How long to wait for "View Report" to appear. Generous because selecting a
 * report type fires a postback that rebuilds the frame, and the button can be
 * absent for a moment either side of it.
 */
const CONTROL_TIMEOUT_MS = 20_000;

/**
 * How long to spend getting the report type to stay selected. Short next to the
 * capture window: this is a postback settling, not a report being generated.
 */
const REPORT_TYPE_TIMEOUT_MS = 15_000;

/**
 * Sanity bound on the report, since it crosses the wire base64-encoded on a single
 * NDJSON line. An unofficial transcript is tens to hundreds of kilobytes; anything
 * near this is not a transcript.
 */
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

export interface TranscriptResult {
  /** The report type actually selected, echoed so the caller can see what it got. */
  report_type: string | null;
  institution: string | null;
  format: "pdf" | "html" | "unknown";
  content_type: string | null;
  /** The server's own name for the file, reported but never used as a path. */
  suggested_filename: string | null;
  /** Which of the three delivery channels produced the bytes. */
  source: CaptureSource;
  byte_length: number;
  sha256: string;
  /**
   * The report itself. The Rust side decodes this and owns writing it to disk, so
   * the worker never puts an academic record on the filesystem.
   */
  content_base64: string;
}

/**
 * Download the unofficial transcript. Authenticates first, so it inherits the
 * `NEEDS_REAUTH`-instead-of-hanging contract from `withSession`.
 *
 * Unlike `grades` and `schedule` this is not a term-scoped read: an unofficial
 * transcript covers the whole record, so there is no term to pick and none to
 * confirm. What replaces the term guard is the component guard — see
 * `assertUnofficialComponent`, and ADR 0008 for why it is worth the ceremony.
 */
export async function transcript(id: number, params: TranscriptParams): Promise<TranscriptResult> {
  return withSession(id, params.login, async (ctx, page) => {
    try {
      return await run(id, params, ctx, page);
    } catch (err) {
      // Everything from the report picker onward used to fail leaving no trace at
      // all: a run that reached the request form and then could not choose a
      // report type produced no dump, because only the navigation had any. The
      // page in hand at the moment of failure is the whole diagnosis.
      await dumpFrames(page, "transcript-failure").catch(() => {});
      throw err;
    }
  });
}

async function run(
  id: number,
  params: TranscriptParams,
  ctx: BrowserContext,
  page: Page,
): Promise<TranscriptResult> {
  {
    progress(id, "verifying", "opening the unofficial transcript page");
    await openUnofficialTranscript(page, FRAME_TIMEOUT_MS);
    // The request form is the page every later failure is about; capture it while
    // we are certainly on it rather than after something has moved us.
    await dumpFrames(page, "transcript-request-form").catch(() => {});

    const picker = await readReportPickerOn(page);
    let chosen: string | null = null;

    // Say what Quest offered even on the happy path: `--report-type` is matched
    // against these, and a run that picks the wrong one is otherwise silent.
    progress(
      id,
      "verifying",
      `report types offered: ${picker.options.map((o) => o.label).join(" / ") || "none"}`,
    );

    if (picker.selectId) {
      const option = chooseReportType(picker.options, params.report_type);
      chosen = option.label;
      progress(id, "verifying", `requesting "${option.label}"`);
      await selectReportType(picker.frame, picker.selectId, option.value);
      // The postback that follows rebuilds the form with the type cleared; this
      // waits it out and re-applies, and fails loudly rather than pressing
      // "View Report" on an empty form and timing out on a report Quest was never
      // going to generate.
      await ensureReportType(page, picker.selectId, option.value, REPORT_TYPE_TIMEOUT_MS);
    } else if (params.report_type) {
      // Name the selects that *were* there. Without this the message says only
      // "no dropdown" about a page that has one, which is how a missed id
      // (`_TYPE3` vs `_TYPE`) reads as a markup change.
      const selects = await describeSelects(page);
      throw new WorkerError(
        "unexpected_page",
        `--report-type was given but no report-type dropdown was recognised on the page. ` +
          `Selects present: ${selects.join(" | ") || "none"}`,
      );
    }

    // Find the control, then re-prove where we are before touching it. The URL
    // checked is the *owning component's* — the control may sit in a nested frame
    // whose own URL says nothing, and it is the component that decides whether
    // this costs money.
    const control = await waitForReportControl(page, CONTROL_TIMEOUT_MS);
    assertUnofficialComponent(control.componentUrl, control.label);

    progress(id, "verifying", `pressing "${control.label}"`);
    const report = await captureReport(
      ctx,
      page,
      control.frame,
      params.report_timeout_secs * 1_000,
    );

    if (report.bytes.length > MAX_REPORT_BYTES) {
      throw new WorkerError(
        "unexpected_page",
        `the report is ${report.bytes.length} bytes, far larger than a transcript — refusing it`,
      );
    }

    const format = sniffFormat(report.bytes);
    assertNotASignInPage(report.bytes, format);

    progress(id, "verifying", `got ${report.bytes.length} bytes of ${format} via ${report.source}`);
    return {
      report_type: chosen,
      institution: picker.institution,
      format,
      content_type: report.contentType,
      suggested_filename: report.suggestedFilename,
      source: report.source,
      byte_length: report.bytes.length,
      sha256: sha256(report.bytes),
      content_base64: report.bytes.toString("base64"),
    };
  }
}
