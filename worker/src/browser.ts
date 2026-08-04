import { chromium, type BrowserContext } from "playwright";

import { WorkerError, type Display } from "./protocol.js";

export interface LaunchOptions {
  profileDir: string;
  display: Display;
}

/**
 * Open the persistent context. This *is* the session: cookies, localStorage and
 * the Duo device-trust cookie all live in `profileDir`, so reusing the same dir
 * is what lets a month-old device trust keep working.
 *
 * Only one context may hold the dir at a time — Chromium takes a lock. A second
 * concurrent `quest` invocation must fail cleanly rather than corrupt it.
 *
 * On `display`: only `auth login` needs a window, for the human at the Duo prompt.
 * The chain itself completes headless — verified end to end. See ADR 0004.
 */
/**
 * Chromium switches every command runs with.
 *
 * **`--disable-popup-blocking` is required, not a preference.** Quest's unofficial
 * transcript page says so in as many words — "To view your Unofficial Transcript,
 * please ensure your pop-up blockers are disabled" — because "View Report" opens a
 * target window with `window.open` and submits the form into it. Chromium blocks
 * that window (the call comes from script, not from a user gesture, so no way of
 * clicking the button changes it), the target never exists, and the submit dies
 * silently: no popup, no download, no response, no error. The run simply waits out
 * its whole capture window.
 *
 * This only re-enables `window.open` for pages we drove to ourselves, in a browser
 * that exists for the duration of one command.
 */
export const LAUNCH_ARGS = ["--disable-popup-blocking"] as const;

export async function launch(opts: LaunchOptions): Promise<BrowserContext> {
  const headless = opts.display === "headless";
  try {
    return await chromium.launchPersistentContext(opts.profileDir, {
      headless,
      args: [...LAUNCH_ARGS],
      // Keep the fingerprint boring and stable across runs; a session that looks
      // like a different device each time invites re-verification.
      viewport: { width: 1280, height: 900 },
      locale: "en-CA",
      timezoneId: "America/Toronto",
    });
  } catch (err) {
    throw new WorkerError(
      "browser_launch_failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
