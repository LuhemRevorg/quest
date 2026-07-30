import { launch } from "../browser.js";
import { WorkerError, progress, type StatusParams } from "../protocol.js";
import { URLS, classifyPage, gotoAndSettle } from "../quest.js";
import { buildStatus, type AuthStatus } from "../status.js";

/**
 * Headless probe. Loads exactly one authenticated Quest page and decides
 * live / expired-trust-valid / expired from where we land plus the cookie jar.
 *
 * Never prompts, never opens a window, and never follows through into a login
 * flow — reporting "expired" is the whole job.
 */
export async function status(id: number, params: StatusParams): Promise<AuthStatus> {
  progress(id, "launching_browser", "opening headless browser");
  // Headless is fine here: `status` only reads where a navigation lands, and never
  // drives the sign-in form that headless leaves inert.
  const ctx = await launch({ profileDir: params.profile_dir, display: "headless" });
  ctx.setDefaultTimeout(30_000);

  try {
    const page = await ctx.newPage();
    progress(id, "verifying", "loading Quest to check the session");
    // If the ADFS SSO cookie is still good this re-authenticates silently on the
    // way through — no human, no prompt. That is the normal path for a healthy
    // session, since Quest's own cookie is session-scoped and never survives.
    await gotoAndSettle(page, URLS.questHome);

    const kind = await classifyPage(page);
    if (kind === "unknown") {
      // Loud, not silent: if we cannot tell, Quest has probably changed, and
      // guessing either way would be worse than failing.
      throw new WorkerError(
        "unexpected_page",
        `could not tell whether we are signed in at ${page.url()} — Quest's markup may have changed`,
      );
    }

    return await buildStatus(ctx, kind === "authenticated");
  } finally {
    await ctx.close();
  }
}
