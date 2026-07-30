// Regression tests against saved real pages.
//
// The point is early warning: when UW changes Quest or ADFS, these go red rather
// than the CLI silently deciding the session is dead (or, worse, live).
//
// These assert on *presence*, not visibility. A saved page has no stylesheets, so
// offline everything computes as hidden — and ADFS ships its password field
// hidden even live. `classifyPage` is presence-based for the same reason; see its
// doc comment.
//
// Run with `npm --prefix worker test`.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

import {
  AUTHENTICATED_SELECTORS,
  CONTINUE_SELECTORS,
  CREDENTIAL_SELECTORS,
  IDP_LINK_SELECTORS,
  PASSWORD_SELECTORS,
  QUEST_LOGIN_URL,
  STAY_SIGNED_IN_SELECTORS,
  SUBMIT_SELECTORS,
  USERNAME_SELECTORS,
  classifyPage,
  firstPresent,
  firstVisible,
} from "./quest.js";

const ADFS = "adfs-signin.2026-07-29.html";
const PEOPLESOFT = "peoplesoft-signin.2026-07-29.html";

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

async function openFixture(name: string): Promise<Page> {
  const path = new URL(`../../fixtures/html/${name}`, import.meta.url).pathname;
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path).href, { waitUntil: "domcontentloaded" });
  return page;
}

describe("ADFS sign-in page", () => {
  it("is classified as a login page", async () => {
    const page = await openFixture(ADFS);
    assert.equal(await classifyPage(page), "login");
    await page.close();
  });

  it("contains no authenticated marker", async () => {
    // The invariant that makes presence-based classification safe: if a sign-in
    // page ever started carrying one of these, `classifyPage` would report a
    // dead session as live.
    const page = await openFixture(ADFS);
    assert.equal(await firstPresent(page, AUTHENTICATED_SELECTORS), null);
    await page.close();
  });

  it("exposes the fields login needs to fill", async () => {
    const page = await openFixture(ADFS);
    assert.ok(await firstPresent(page, USERNAME_SELECTORS), "username field");
    assert.ok(await firstPresent(page, PASSWORD_SELECTORS), "password field");
    assert.ok(await firstPresent(page, SUBMIT_SELECTORS), "submit button");
    await page.close();
  });

  it("still has keep-me-signed-in disabled by UW", async () => {
    // Confirmed by a real login: the checkbox is in the markup but its container
    // carries a server-rendered `display:none`, so it can never be ticked and no
    // persistent SSO cookie is obtainable.
    //
    // Asserting on the inline style, not on visibility: offline every element
    // computes as hidden, so a visibility check here would prove nothing.
    //
    // If this test fails because the style is gone, that is *good news* — UW
    // enabled KMSI, and unattended commands can stop relying on a stored
    // password. See ADR 0003.
    const page = await openFixture(ADFS);
    assert.ok(await firstPresent(page, STAY_SIGNED_IN_SELECTORS), "KMSI checkbox markup");
    const style = await page.locator("#kmsiArea").getAttribute("style");
    assert.match(style ?? "", /display:\s*none/i, "kmsiArea should still be hidden");
    await page.close();
  });
});

describe("PeopleSoft local sign-in page", () => {
  it("is classified as a login page", async () => {
    const page = await openFixture(PEOPLESOFT);
    assert.equal(await classifyPage(page), "login");
    await page.close();
  });

  it("contains no authenticated marker", async () => {
    const page = await openFixture(PEOPLESOFT);
    assert.equal(await firstPresent(page, AUTHENTICATED_SELECTORS), null);
    await page.close();
  });

  it("exposes username and password fields", async () => {
    const page = await openFixture(PEOPLESOFT);
    assert.ok(await firstPresent(page, USERNAME_SELECTORS), "username field");
    assert.ok(await firstPresent(page, PASSWORD_SELECTORS), "password field");
    await page.close();
  });
});

describe("PeopleSoft SSO sign-in page (the post-Duo handoff)", () => {
  const FIXTURE = "peoplesoft-sso-signin.2026-07-30.html";

  it("offers the SSO link a human would click", async () => {
    // This page cost four failed fixes. The control that gets you into Quest is
    // `<a href="javascript:getIdPLink()">Sign In</a>` — an anchor with no id.
    const page = await openFixture(FIXTURE);
    assert.ok(await firstPresent(page, IDP_LINK_SELECTORS), "SSO anchor");
    await page.close();
  });

  it("keeps its local login submit deliberately suppressed", async () => {
    // The trap: the same page carries a local login form whose submit is hidden
    // because this deployment is SSO-only. Clicking it posts empty credentials and
    // returns errorCode=105 — a real failed sign-in against the account.
    const page = await openFixture(FIXTURE);
    const submit = page.locator('input[name="Submit"]');
    assert.equal(await submit.count(), 1, "local submit exists");
    assert.match(
      (await submit.getAttribute("class")) ?? "",
      /ui-btn-hidden/,
      "local submit should be marked hidden — if not, re-check whether clicking it is safe",
    );
    await page.close();
  });

  it("has credential fields present, so it is never an interstitial", async () => {
    const page = await openFixture(FIXTURE);
    assert.ok(await firstPresent(page, CREDENTIAL_SELECTORS), "userid/pwd present");
    await page.close();
  });
});

// UW's sign-in is staged: username, then password, then Duo, then a "Sign in"
// interstitial. The login loop picks its next action by asking which of these is
// *visible*, so these tests pin that discrimination. Getting it wrong is not
// theoretical — filling both fields on one page meant the password was never
// entered at all, and the run hung waiting for a Duo that had already passed.
describe("staged sign-in screens", () => {
  async function screen(html: string): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`<html><body>${html}</body></html>`);
    return page;
  }

  it("treats a hidden password field as not-yet-reached", async () => {
    // The real username screen: ADFS ships the password input but keeps its
    // container hidden until the next step.
    const page = await screen(
      '<input id="userNameInput" type="email">' +
        '<div style="display:none"><input id="passwordInput" type="password"></div>' +
        '<span id="submitButton">Next</span>',
    );
    assert.equal(await firstVisible(page, PASSWORD_SELECTORS), null, "password not yet visible");
    assert.ok(await firstVisible(page, USERNAME_SELECTORS), "username is the live field");
    await page.close();
  });

  it("sees the password field once its screen is reached", async () => {
    const page = await screen(
      '<input id="passwordInput" type="password"><span id="submitButton">Sign in</span>',
    );
    assert.ok(await firstVisible(page, PASSWORD_SELECTORS));
    await page.close();
  });

  it("recognises the trailing interstitial as clickable-through", async () => {
    // No credential fields at all — just the button that ends UW's chain.
    const page = await screen('<span id="submitButton">Sign in</span>');
    assert.equal(await firstVisible(page, USERNAME_SELECTORS), null);
    assert.equal(await firstVisible(page, PASSWORD_SELECTORS), null);
    assert.ok(await firstVisible(page, CONTINUE_SELECTORS), "continue control");
    await page.close();
  });

  it("never treats a page with hidden credential fields as an interstitial", async () => {
    // The rule this encodes, learned the hard way: PeopleSoft's `?cmd=login` page
    // carries userid/pwd/Submit all hidden. Dispatching a click at that hidden
    // Submit posted empty credentials and returned `errorCode=105` — a real failed
    // sign-in against the account, and repeating it risks lockout.
    //
    // So an interstitial is defined by having *no credential field present at all*,
    // visibility notwithstanding.
    const page = await screen(
      '<form><input id="userid" type="text" style="display:none">' +
        '<input id="pwd" type="password" style="display:none">' +
        '<input name="Submit" type="submit" value="Sign in" style="display:none"></form>',
    );
    assert.ok(
      await firstPresent(page, CREDENTIAL_SELECTORS),
      "credential fields are present, so this is not an interstitial",
    );
    await page.close();
  });

  it("recognises Quest's own sign-in URL as a stalled handoff", () => {
    for (const url of [
      "https://quest.pecs.uwaterloo.ca/psp/SS/ACADEMIC/SA/?cmd=login&languageCd=ENG",
      "https://quest.pecs.uwaterloo.ca/psp/SS/ACADEMIC/SA/?&cmd=login&errorCode=105&languageCd=ENG",
    ]) {
      assert.ok(QUEST_LOGIN_URL.test(url), url);
    }
    // Not the landing page we are aiming for.
    assert.ok(
      !QUEST_LOGIN_URL.test(
        "https://quest.pecs.uwaterloo.ca/psc/SS/ACADEMIC/SA/c/NUI_FRAMEWORK.PT_LANDINGPAGE.GBL",
      ),
    );
  });

  it("never treats a credential screen as an interstitial", async () => {
    // The ordering guarantee: whenever a continue control shares a page with a
    // live credential field, the credential field must win, or we would submit an
    // empty form.
    for (const html of [
      '<input id="userNameInput" type="email"><span id="submitButton">Next</span>',
      '<input id="passwordInput" type="password"><span id="submitButton">Sign in</span>',
    ]) {
      const page = await screen(html);
      const credential =
        (await firstVisible(page, PASSWORD_SELECTORS)) ??
        (await firstVisible(page, USERNAME_SELECTORS));
      assert.ok(credential, `a credential field should be live for: ${html}`);
      await page.close();
    }
  });
});

describe("classifyPage", () => {
  it("refuses to guess on an unrecognised page", async () => {
    // What hitting the retired `quest.uwaterloo.ca` host looks like: a perfectly
    // valid page that says nothing about our session.
    const page = await browser.newPage();
    await page.setContent("<html><body><p>Quest has moved.</p></body></html>");
    assert.equal(await classifyPage(page), "unknown");
    await page.close();
  });

  it("recognises a Quest page by its PeopleSoft frame", async () => {
    const page = await browser.newPage();
    await page.setContent('<html><body><iframe id="ptifrmtgtframe"></iframe></body></html>');
    assert.equal(await classifyPage(page), "authenticated");
    await page.close();
  });

  it("prefers duo over login when both markers are present", async () => {
    // The real mid-flow state: Duo is up, ADFS's hidden password field lingers.
    const page = await browser.newPage();
    await page.setContent(
      '<html><body><input id="passwordInput" type="password" hidden>' +
        '<button id="trust-browser-button">Yes, trust browser</button></body></html>',
    );
    assert.equal(await classifyPage(page), "duo");
    await page.close();
  });
});
