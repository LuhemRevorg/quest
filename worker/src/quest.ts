// Everything Quest-specific and therefore fragile lives here, in one file, so a
// Quest-side change has exactly one place to be fixed.
//
// PeopleSoft's DOM is hostile: nested `ptifrmtgtframe` iframes, hidden
// `ICAction` / `ICSID` / `ICStateNum` state, generated element ids. Phase 2+
// prefers replaying `ICAJAX` postbacks captured from a HAR over selector
// matching; the selectors below are only for the login flow, which is ordinary
// HTML.
//
// Verified against live pages on 2026-07-29; fixtures in `fixtures/html/`.
//
// The sign-in chain, as observed end to end on a real login:
//
//   quest.pecs.uwaterloo.ca/psp/SS/…   PeopleSoft SP
//     -> SAML redirect ->
//   adfs.uwaterloo.ca/adfs/ls/         username screen      (password field hidden)
//                                      -- expects the full UPN, e.g. jdoe@uwaterloo.ca,
//                                         not the bare 8-character userid
//     ->
//                                      password screen
//     ->
//   Duo                                second factor, human-only
//     ->
//                                      "Sign in" interstitial, no fields
//     -> back to Quest
//
// It is *staged*: username and password are separate screens, and the chain ends
// with a button that must be clicked. `handlers/login.ts` therefore drives a loop
// keyed on what is currently visible, rather than filling one form.
//
// Note `quest.uwaterloo.ca` (no `.pecs`) now redirects to a marketing page —
// the service moved hosts. Hitting the old host looks exactly like a dead
// session, which is why `classifyPage` refuses to guess.

import type { Frame, Locator, Page } from "playwright";

const HOST = "https://quest.pecs.uwaterloo.ca";

export const URLS = {
  /**
   * Classic portal home. Used as the authenticated-or-not probe: unauthenticated
   * it SAML-redirects to ADFS, authenticated it renders the portal.
   */
  questHome: `${HOST}/psp/SS/ACADEMIC/SA/h/?tab=DEFAULT`,
  /**
   * The Fluid landing page — **where the tiles are**, and where signing in
   * actually leaves you. `questHome` above is the *classic* portal: a good
   * authenticated-or-not probe, but it renders a `Main Menu` flyout and no
   * `PTNUI_LAND_REC_GROUPLET` tiles whatsoever. Navigating there mid-command
   * throws away the only page `openTile` can work on, which is exactly how
   * `transcript` came to report "no tile and no link" for all six sections it
   * knows. Observed on the live deployment; note `/psc/` (the content servlet),
   * not `/psp/`.
   */
  fluidHome: `${HOST}/psc/SS/ACADEMIC/SA/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL`,
  /**
   * PeopleSoft's *local* sign-in form (`#userid` / `#pwd`), which bypasses SAML.
   * Not the student path — WatIAM + Duo means going through ADFS. Kept only so
   * the selectors below are explainable.
   */
  peopleSoftLocalLogin: `${HOST}/psp/SS/ACADEMIC/SA/?cmd=login&languageCd=ENG`,
} as const;

/** UW ADFS first, then PeopleSoft local, then generic fallbacks. */
export const USERNAME_SELECTORS = [
  "#userNameInput",
  "#userid",
  'input[name="UserName"]',
  'input[name="userid"]',
  'input[autocomplete="username"]',
  'input[type="email"]',
] as const;

export const PASSWORD_SELECTORS = [
  "#passwordInput",
  "#pwd",
  'input[name="Password"]',
  'input[name="pwd"]',
  'input[type="password"]',
] as const;

/**
 * Stage-appropriate submit controls.
 *
 * ADFS paginates with *two* separate controls and shows exactly one at a time:
 * `#nextButton` ("Next") on the username screen, `#submitButton` ("Sign in") on
 * the password screen — the other carries `display:none`. Both are
 * `<span role="button">` driven by `Login.submitLoginRequest()`, **not**
 * `<input type="submit">`, so generic form selectors match nothing here.
 *
 * Verified 2026-07-29. Ordering is irrelevant since `firstVisible` skips the
 * hidden one, but both must be listed: with only `#submitButton`, the username
 * screen had no clickable control and submission fell through to pressing Enter.
 */
export const SUBMIT_SELECTORS = [
  "#nextButton",
  "#submitButton",
  'input[name="Submit"]',
  'input[type="submit"]',
  'button[type="submit"]',
] as const;

/**
 * ADFS "Keep me signed in" — which **UW has disabled.** The markup ships, but
 * inside `<div id="kmsiArea" style="display:none">`, and that inline style is
 * server-rendered, not a quirk of our offline fixture.
 *
 * Consequence: no persistent ADFS SSO cookie is obtainable, so a password is
 * required on every re-authentication. See ADR 0003.
 *
 * Kept, and still attempted via `firstVisible` (which correctly declines to tick
 * a hidden box), because if UW ever enables it that is a free win. A test asserts
 * the current disabled state so the change would be noticed.
 */
export const STAY_SIGNED_IN_SELECTORS = [
  "#kmsiInput",
  'input[name="Kmsi"]',
] as const;

/**
 * The "remember this device for 30 days" control.
 *
 * Only device-trust controls belong in this list. We never click an
 * authentication method ("Send Me a Push", "Call Me", "Enter a Passcode"): the
 * human chooses and completes their own second factor. In Duo's Universal
 * Prompt this screen appears only *after* the factor has already succeeded, so
 * clicking it is not part of authenticating.
 */
export const TRUST_DEVICE_SELECTORS = [
  "#trust-browser-button",
  'input[name="dampen_choice"]',
  "#remember_me_checkbox",
  "#remember_me_label_text",
] as const;

/**
 * Controls on a pure interstitial — a page with no credential fields that just
 * needs to be clicked through. UW's chain ends with one of these after Duo
 * ("Sign in" → Quest); normally such a page auto-submits via JS, here it does not.
 *
 * Only ever consulted when nothing else is visible: no username field, no password
 * field, no Duo control. That ordering is what keeps this from clicking "submit"
 * on a half-filled login form, or a Duo authentication method.
 */
export const CONTINUE_SELECTORS = [
  "#submitButton",
  "#nextButton",
  'input[type="submit"]',
  'button[type="submit"]',
] as const;

/**
 * Per-tick page trace, enabled with `QUEST_DEBUG_PAGES=1`. Prints where we are and
 * what the loop can see, which is the only practical way to debug a staged flow
 * running headless on someone else's account.
 *
 * URLs only — never field values.
 */
export async function tracePage(page: Page, kind: PageKind): Promise<void> {
  if (!process.env["QUEST_DEBUG_PAGES"]) return;
  const seen: string[] = [];
  for (const [name, selectors] of [
    ["user", USERNAME_SELECTORS],
    ["pass", PASSWORD_SELECTORS],
    ["submit", SUBMIT_SELECTORS],
    ["idp", IDP_LINK_SELECTORS],
    ["trust", TRUST_DEVICE_SELECTORS],
    ["authed", AUTHENTICATED_SELECTORS],
  ] as const) {
    const present = await firstPresent(page, selectors).catch(() => null);
    const visible = await firstVisible(page, selectors).catch(() => null);
    seen.push(`${name}=${visible ? "visible" : present ? "hidden" : "-"}`);
  }
  const url = page.url().replace(/([?&][^=]+=)[^&]{20,}/g, "$1…");
  process.stderr.write(`worker: [${kind}] ${seen.join(" ")} ${url}\n`);
}

/**
 * Save the current page's HTML when `QUEST_DEBUG_DUMP_DIR` is set, so a stalled
 * run yields the actual markup instead of another round-trip. Sign-in pages
 * contain no personal data, but the dump is off by default and opt-in per run.
 *
 * Takes a `Frame` as well as a `Page`, because self-service components render
 * inside `main_target_win0` and the outer document's HTML shows only the iframe
 * tag — a dump of the page is useless for anything past the sign-in chain.
 */
export async function dumpPage(page: Page | Frame, label: string): Promise<void> {
  const dir = process.env["QUEST_DEBUG_DUMP_DIR"];
  if (!dir) return;
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    // 0700/0600. Dumps of pages *past* sign-in contain the student record, and the
    // default 0644 left them readable by every local user — not acceptable for
    // something a debugging flag creates by the dozen.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const safe = label.replace(/[^a-z0-9-]+/gi, "_").slice(0, 60);
    const file = `${dir}/${safe}.html`;
    await writeFile(file, await page.content(), { encoding: "utf8", mode: 0o600 });
    process.stderr.write(`worker: dumped ${page.url().slice(0, 60)} -> ${file}\n`);
  } catch (err) {
    process.stderr.write(`worker: dump failed: ${String(err).slice(0, 120)}\n`);
  }
}

/**
 * The SSO entry point on PeopleSoft's sign-in page, and the thing a human actually
 * clicks to get into Quest:
 *
 * ```html
 * <a style="font-weight: bold" href="javascript:getIdPLink()">Sign In</a>
 * ```
 *
 * Easy to get wrong, and I did: the same page carries a *local* login form whose
 * submit button is deliberately suppressed (`class="ui-btn-hidden"`, inside a
 * `display:none` container) because this deployment is SSO-only. Clicking that
 * instead posts empty credentials and yields `errorCode=105`. This anchor is the
 * only correct target, it has no id, and it is an `<a>` — so no submit-button
 * selector will ever find it.
 *
 * Clicking it starts a SAML redirect and posts no credentials.
 */
export const IDP_LINK_SELECTORS = [
  'a[href*="getIdPLink"]',
  'a[href^="javascript:getIdP"]',
] as const;

/**
 * Any field that takes a credential, visible or not. Used to prove a page is
 * *not* a credential form before clicking anything on it.
 */
export const CREDENTIAL_SELECTORS = [...USERNAME_SELECTORS, ...PASSWORD_SELECTORS] as const;

/**
 * Quest's own sign-in URL. Landing here means the SAML handoff did not complete —
 * PeopleSoft fell back to offering its local login form.
 */
export const QUEST_LOGIN_URL = /quest\.pecs\.uwaterloo\.ca\/psp\/.*cmd=login/i;

/** ADFS renders sign-in failures here; empty and hidden when all is well. */
export const LOGIN_ERROR_SELECTORS = ["#errorText", ".error-text"] as const;

/** Present only once we are past login, inside Quest proper. */
export const AUTHENTICATED_SELECTORS = [
  "#ptifrmtgtframe",
  'a[href*="cmd=logout"]',
  "#pthdr2logout",
  "#pt_envinfo",
] as const;

/** URLs that mean we were bounced out to an identity provider. */
const IDP_URL_PATTERNS = [
  /adfs\.uwaterloo\.ca/i,
  /\/adfs\/ls/i,
  /login\.microsoftonline\.com/i,
  /shibboleth|\/idp\//i,
  /cmd=login/i,
  /\/signin/i,
] as const;

const DUO_URL_PATTERNS = [/duosecurity\.com/i, /\/duo(\/|$)/i] as const;

export type PageKind =
  /** Inside Quest, past login. */
  | "authenticated"
  /** At a sign-in form. */
  | "login"
  /** At the second-factor / device-trust step. */
  | "duo"
  /** Nothing recognisable — Quest may have changed. Never guess from here. */
  | "unknown";

/**
 * Decide where we are. Deliberately returns `unknown` rather than defaulting to
 * a guess: a silently-wrong answer here would mean either a bogus "session is
 * live" or a spurious re-login prompt.
 *
 * Matching is by *presence*, not visibility, and the order matters.
 *
 * Presence, because ADFS ships `#passwordInput` hidden and reveals it with its
 * own CSS/JS — so a visibility test would call the sign-in page `unknown`, and
 * would also make offline fixture tests impossible (a saved page has no
 * stylesheets). Verified against both fixtures: neither sign-in page contains
 * any of `AUTHENTICATED_SELECTORS`, so checking those first means a hidden
 * password field somewhere inside Quest can never be mistaken for a login page.
 */
export async function classifyPage(page: Page): Promise<PageKind> {
  const url = page.url();

  if (await firstPresent(page, AUTHENTICATED_SELECTORS)) return "authenticated";

  // Before `login`: while Duo is showing, ADFS's own hidden password field is
  // often still in the DOM.
  if (await firstPresent(page, TRUST_DEVICE_SELECTORS)) return "duo";
  if (DUO_URL_PATTERNS.some((p) => p.test(url))) return "duo";

  if (await firstPresent(page, PASSWORD_SELECTORS)) return "login";
  if (IDP_URL_PATTERNS.some((p) => p.test(url))) return "login";

  return "unknown";
}

/**
 * Load a Quest URL and wait out the SAML redirect chain before judging the page.
 *
 * Quest -> ADFS -> (Duo) -> Quest involves several hops, some of them
 * auto-submitting forms rather than 302s. Classifying on `domcontentloaded`
 * catches an intermediate page and reads as a dead session even when SSO is
 * about to complete silently. `networkidle` is normally a smell, but settling a
 * redirect chain is exactly what it is for.
 */
export async function gotoAndSettle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {
    // Chatty page, or a hop still in flight. Classify what we have.
  });
}

/** Visible, non-empty sign-in error text, if the IdP is showing one. */
export async function loginError(page: Page): Promise<string | null> {
  const element = await firstVisible(page, LOGIN_ERROR_SELECTORS);
  if (!element) return null;
  const text = (await element.textContent().catch(() => null))?.trim();
  return text ? text : null;
}

/**
 * First selector that matches anything at all, visible or not. Used for
 * classification — see `classifyPage`.
 */
export async function firstPresent(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0) return locator;
    } catch {
      // Navigating mid-check detaches the frame. Treat as "not found".
    }
  }
  return null;
}

/**
 * First selector that matches something *visible*. Used for anything we intend
 * to type into or click, where acting on a hidden element would be a bug.
 */
export async function firstVisible(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible()) return locator;
    } catch {
      // Navigating mid-check detaches the frame. Treat as "not found".
    }
  }
  return null;
}
