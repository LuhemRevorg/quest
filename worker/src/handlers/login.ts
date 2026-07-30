import type { BrowserContext, Locator, Page } from "playwright";

import { launch } from "../browser.js";
import { WorkerError, progress, type LoginParams, type Stage } from "../protocol.js";
import {
  CONTINUE_SELECTORS,
  CREDENTIAL_SELECTORS,
  IDP_LINK_SELECTORS,
  PASSWORD_SELECTORS,
  STAY_SIGNED_IN_SELECTORS,
  SUBMIT_SELECTORS,
  QUEST_LOGIN_URL,
  TRUST_DEVICE_SELECTORS,
  URLS,
  USERNAME_SELECTORS,
  classifyPage,
  firstPresent,
  firstVisible,
  dumpPage,
  gotoAndSettle,
  loginError,
  tracePage,
} from "../quest.js";
import { buildStatus, type AuthStatus } from "../status.js";

const POLL_INTERVAL_MS = 1_000;

/**
 * How long to sit at a Duo screen in unattended mode before concluding a human is
 * required. With device trust valid Duo passes through in a second or two, so
 * anything longer means it wants a passcode and we should surrender the exit code
 * rather than stall.
 */
const SILENT_DUO_PATIENCE_MS = 20_000;

/** Guard against a mis-detected interstitial turning into a click loop. */
const MAX_CONTINUE_CLICKS = 4;
const CONTINUE_COOLDOWN_MS = 2_500;

/**
 * Re-entering Quest to finish a stalled SAML handoff. Bounded: if the front door
 * does not resolve it in a few tries, something is wrong that retrying will not fix.
 */
const MAX_REENTRIES = 3;
const REENTRY_COOLDOWN_MS = 3_000;

/** Following the SSO link. Bounded so a redirect loop cannot spin forever. */
const MAX_IDP_CLICKS = 3;
const IDP_COOLDOWN_MS = 3_000;

/**
 * Establish a session, attended or not.
 *
 * UW's sign-in is a *staged* flow, not one form:
 *
 *   username screen → password screen → Duo → "Sign in" interstitial → Quest
 *
 * So this drives a loop rather than filling one page: each tick, look at what is
 * actually on screen and take the single next step. That is what makes it robust
 * to extra screens, to ADFS reordering them, and to a human doing part of it by
 * hand — and it is why the earlier one-shot fill silently never entered the
 * password (that field lives on a page we had not reached yet).
 *
 * Attended (`allow_human: true`, `auth login`): headed. We fill what we can and
 * the human does the second factor. We never read, generate, or submit a passcode,
 * and never touch a push approval.
 *
 * Unattended (`allow_human: false`, `auth refresh`): headless. Credentials come
 * from the keychain and Duo passes silently on device trust. The moment a human
 * would be needed, this fails with `needs_reauth` — it must never block, because
 * an agent is waiting.
 */
export async function login(id: number, params: LoginParams): Promise<AuthStatus> {
  return withSession(id, params, async (ctx) => {
    progress(id, "persisting_session", "saving the session to the profile directory");
    const status = await buildStatus(ctx, true);

    // Expected on UW's ADFS, which disables keep-me-signed-in. Say it once so the
    // absence of an SSO cookie does not read as a bug.
    if (!status.sso_expires_at && params.allow_human) {
      progress(
        id,
        "persisting_session",
        "note: no persistent SSO cookie (UW disables ADFS keep-me-signed-in), so " +
          "unattended commands rely on the stored password plus Duo device trust",
      );
    }
    return status;
  });
}

/**
 * Sign in, hand the authenticated context to `body`, then tear down.
 *
 * Every data command needs this shape. Quest's session cookie is session-scoped
 * (ADR 0003), so there is no such thing as attaching to a session established by
 * an earlier process: a command authenticates and does its work inside one browser
 * lifetime, or not at all. `login` is just the degenerate case whose body only
 * reports status.
 */
export async function withSession<T>(
  id: number,
  params: LoginParams,
  body: (ctx: BrowserContext, page: Page) => Promise<T>,
): Promise<T> {
  progress(id, "launching_browser", `opening browser (${params.display})`);
  const ctx = await launch({ profileDir: params.profile_dir, display: params.display });
  ctx.setDefaultTimeout(30_000);

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    progress(id, "navigating_to_quest", "loading Quest");
    await gotoAndSettle(page, URLS.questHome);

    const initial = await classifyPage(page);
    if (initial === "unknown") {
      throw new WorkerError(
        "unexpected_page",
        `landed somewhere unrecognised (${page.url()}) — Quest's markup may have changed`,
      );
    }
    if (initial === "authenticated") {
      progress(id, "session_reused", "already signed in — nothing to do");
    } else {
      if (!params.allow_human && !params.password) {
        // Nothing to try, and nobody to ask.
        throw new WorkerError(
          "needs_reauth",
          "no stored password available for unattended sign-in — run `quest auth login --save-password`",
        );
      }
      await driveSignIn(id, page, params);
    }

    return await body(ctx, page);
  } finally {
    // Closing the context is what makes Chromium flush cookies to the profile
    // dir. Without this the Duo device trust would not survive the process.
    await ctx.close();
  }
}

/**
 * Walk the sign-in chain one screen at a time until we are inside Quest.
 *
 * Everything here is idempotent per screen: a field already holding the right
 * value is not retyped, and each stage is submitted once. That matters because the
 * loop re-inspects the same page many times while a redirect is in flight.
 */
async function driveSignIn(id: number, page: Page, params: LoginParams): Promise<void> {
  const attended = params.allow_human;
  const deadline = Date.now() + params.duo_timeout_secs * 1_000;

  let usernameSubmitted = false;
  let passwordSubmitted = false;
  let trustClicked = false;
  let kmsiTicked = false;
  let continueClicks = 0;
  let lastContinueAt = 0;
  let reentries = 0;
  let lastReentryAt = 0;
  let idpClicks = 0;
  let lastIdpClickAt = 0;
  let duoSince: number | null = null;
  let lastSaid: string | null = null;
  let lastDumpedUrl: string | null = null;
  let dumpSeq = 0;

  /**
   * Emit once per distinct message, so the log reads as a sequence without
   * repeating every tick.
   *
   * Keyed on stage *and* message, not stage alone: several steps share the
   * `filling_credentials` stage, and deduplicating on stage silently swallowed
   * "entering password" whenever "entering username" had just been reported —
   * which made a working password step look like it never ran.
   */
  const say = (stage: Stage, message: string) => {
    const key = `${stage}:${message}`;
    if (key === lastSaid) return;
    lastSaid = key;
    progress(id, stage, message);
  };

  while (Date.now() < deadline) {
    // Mid-navigation reads throw; a failed read is just "not yet".
    const kind = await classifyPage(page).catch(() => "unknown" as const);
    await tracePage(page, kind).catch(() => {});

    // Dump each distinct page as we reach it, not just on timeout — an interrupted
    // run left no artifact at all, which wasted a debugging round trip.
    const currentUrl = page.url();
    if (currentUrl !== lastDumpedUrl) {
      lastDumpedUrl = currentUrl;
      await dumpPage(page, `${String(++dumpSeq).padStart(2, "0")}-${kind}`).catch(() => {});
    }

    if (kind === "authenticated") return;

    // ADFS's visible error text is the only signal we trust for "rejected". We
    // deliberately do *not* infer rejection from still-looking-like-a-login-page:
    // while Duo is up, ADFS's hidden password field is often still in the DOM,
    // and a human takes their time at the passcode prompt.
    if (passwordSubmitted) {
      const error = await loginError(page).catch(() => null);
      if (error) throw new WorkerError("bad_credentials", error);
    }

    // Opportunistic, wherever it appears. A no-op on UW, which ships the checkbox
    // hidden, but free if that ever changes.
    if (!kmsiTicked) {
      const kmsi = await firstVisible(page, STAY_SIGNED_IN_SELECTORS).catch(() => null);
      if (kmsi) {
        kmsiTicked = await kmsi
          .check({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (kmsiTicked) say("filling_credentials", 'ticked "keep me signed in"');
      }
    }

    // Duo's device-trust screen. Appears only after the factor already succeeded,
    // so clicking it is not part of authenticating.
    if (!trustClicked) {
      const trust = await firstVisible(page, TRUST_DEVICE_SELECTORS).catch(() => null);
      if (trust) {
        say("remembering_device", "opting into 30-day device trust");
        trustClicked = await trust
          .click({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (trustClicked) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
      }
    }

    // --- the staged form, most specific screen first -----------------------

    const passwordField = await firstVisible(page, PASSWORD_SELECTORS).catch(() => null);
    if (passwordField) {
      if (params.password && !passwordSubmitted && (await isEmpty(passwordField))) {
        say("filling_credentials", "entering password");
        // Only an actual step resets the Duo clock. Resetting it merely on *seeing*
        // a field let a flickering page keep the patience window from elapsing, so
        // an unattended run that should fail in 20s appeared to hang.
        duoSince = null;
        await passwordField.fill(params.password);
        passwordSubmitted = await submitFrom(page, passwordField);
      } else if (!params.password) {
        say("filling_credentials", "type your password in the browser window");
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const usernameField = await firstVisible(page, USERNAME_SELECTORS).catch(() => null);
    if (usernameField) {
      if (params.username && !usernameSubmitted) {
        say("filling_credentials", "entering username");
        duoSince = null;
        if ((await usernameField.inputValue().catch(() => "")) !== params.username) {
          await usernameField.fill(params.username);
        }
        usernameSubmitted = await submitFrom(page, usernameField);
      } else if (!params.username) {
        say("filling_credentials", "type your username in the browser window");
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (kind === "duo") {
      say(
        "awaiting_duo",
        attended
          ? "complete Duo in the browser window — enter your own passcode; this " +
              "tool never generates or submits one"
          : "waiting for Duo to pass on device trust",
      );
      // Unattended, a lingering Duo means it wants a passcode nobody can type.
      if (!attended) {
        duoSince ??= Date.now();
        if (Date.now() - duoSince > SILENT_DUO_PATIENCE_MS) {
          throw new WorkerError(
            "needs_reauth",
            "Duo is asking for a passcode — device trust has expired or was never " +
              "established. Run `quest auth login`.",
          );
        }
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Stuck on Quest's own sign-in URL: the SAML handoff did not complete and
    // PeopleSoft fell back to offering its *local* login form.
    //
    // Do **not** submit that form. It is a credential form we did not fill, and
    // dispatching a click at its hidden submit control did exactly what you would
    // expect — posted empty credentials and came back `errorCode=105`, an invalid
    // signon. That is a genuine failed sign-in attempt against the account, and
    // repeating it risks tripping lockout. Never submit a credential form whose
    // fields we did not populate.
    //
    // Re-enter through the front door instead: ADFS is holding a live session from
    // the sign-in we completed moments ago *in this same browser context*, so an
    // SP-initiated round trip should mint a fresh assertion with no human at all.
    if (QUEST_LOGIN_URL.test(page.url())) {
      // The page's own SSO link — what a human clicks. Try it before anything else.
      const idp = await firstPresent(page, IDP_LINK_SELECTORS).catch(() => null);
      if (idp && idpClicks < MAX_IDP_CLICKS && Date.now() - lastIdpClickAt > IDP_COOLDOWN_MS) {
        say("continuing", "following the SSO sign-in link");
        idpClicks += 1;
        lastIdpClickAt = Date.now();
        // `click()` if it is rendered; otherwise invoke the same handler the anchor
        // would. Either way this only triggers a SAML redirect.
        const clicked = await idp
          .click({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!clicked) {
          await page
            .evaluate(() => {
              const fn = (window as unknown as { getIdPLink?: () => void }).getIdPLink;
              if (typeof fn === "function") fn();
            })
            .catch(() => {});
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // No SSO link to follow: fall back to re-entering through the front door.
      if (reentries < MAX_REENTRIES && Date.now() - lastReentryAt > REENTRY_COOLDOWN_MS) {
        say("continuing", "re-entering Quest to complete the SSO handoff");
        reentries += 1;
        lastReentryAt = Date.now();
        await gotoAndSettle(page, URLS.questHome).catch(() => {});
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // A genuine interstitial: no credential field anywhere in the DOM, just a
    // control to click through. Checking *presence* rather than visibility is the
    // guard — a hidden password field means this is a login form mid-render, not a
    // confirmation page.
    if (continueClicks < MAX_CONTINUE_CLICKS && Date.now() - lastContinueAt > CONTINUE_COOLDOWN_MS) {
      const credentials = await firstPresent(page, CREDENTIAL_SELECTORS).catch(() => null);
      const control = credentials
        ? null
        : await firstVisible(page, CONTINUE_SELECTORS).catch(() => null);
      if (control) {
        say("continuing", "clicking through the sign-in confirmation");
        continueClicks += 1;
        lastContinueAt = Date.now();
        await control.click({ timeout: 5_000 }).catch(() => {});
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Whatever we were stuck on is the interesting page; capture it before giving up.
  await dumpPage(page, "stalled-at-timeout").catch(() => {});

  if (!attended) {
    throw new WorkerError(
      "needs_reauth",
      `could not sign in unattended within ${params.duo_timeout_secs}s (stuck at ${page.url().slice(0, 80)}) — run \`quest auth login\``,
    );
  }
  throw new WorkerError(
    "duo_timeout",
    `not signed in after ${params.duo_timeout_secs}s` +
      (trustClicked ? " (device trust was already accepted)" : ""),
  );
}

/** Submit the form owning `field`. Returns whether a submit was actually issued. */
async function submitFrom(page: Page, field: Locator): Promise<boolean> {
  const submit = await firstVisible(page, SUBMIT_SELECTORS).catch(() => null);
  if (submit) {
    const clicked = await submit
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return true;
  }
  return field
    .press("Enter")
    .then(() => true)
    .catch(() => false);
}

async function isEmpty(field: Locator): Promise<boolean> {
  return (await field.inputValue().catch(() => "")) === "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
