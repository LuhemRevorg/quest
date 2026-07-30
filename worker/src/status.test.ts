import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Cookie } from "playwright";

import { questSessionExpiry, ssoExpiry, statusFromCookies, trustExpiry } from "./status.js";

const DUO = "api-XXXXXXXX.duosecurity.com";
const ADFS = "adfs.uwaterloo.ca";

const HOUR = 3_600;

function cookie(partial: Partial<Cookie> & { name: string }): Cookie {
  return {
    value: "REDACTED",
    domain: ".pecs.uwaterloo.ca",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...partial,
  };
}

function inHours(hours: number): number {
  return Math.floor(Date.now() / 1000) + hours * HOUR;
}

describe("trustExpiry", () => {
  it("is null when only session cookies are present", () => {
    // This is the real observed state of a signed-out profile.
    const cookies = [
      cookie({ name: "CSPRPDB-PORTAL-PSJSESSIONID" }),
      cookie({ name: "X-Oracle-BMC-LBS-Route" }),
    ];
    assert.equal(trustExpiry(cookies), null);
  });

  it("reads the Duo browsertrust cookie", () => {
    const thirtyDays = inHours(24 * 30);
    const cookies = [
      cookie({ name: "browsertrust|DEVICE|ORG", domain: DUO, expires: thirtyDays }),
    ];
    assert.equal(trustExpiry(cookies), new Date(thirtyDays * 1000).toISOString());
  });

  it("ignores Duo's other, longer-lived cookies", () => {
    // Taken verbatim from a real login: these run to 2027 and would overstate
    // when the next passcode is actually due.
    const cookies = [
      cookie({ name: "trc|DEVICE|ORG", domain: DUO, expires: inHours(24 * 400) }),
      cookie({ name: "lam|A|B", domain: DUO, expires: inHours(24 * 366) }),
      cookie({ name: "hac|DEVICE|ORG", domain: DUO, expires: inHours(24 * 400) }),
      cookie({ name: "fsc|DEVICE", domain: DUO, expires: inHours(24 * 30) }),
    ];
    assert.equal(trustExpiry(cookies), null);
  });

  it("ignores an expired trust cookie", () => {
    const cookies = [
      cookie({ name: "browsertrust|DEVICE|ORG", domain: DUO, expires: inHours(-1) }),
    ];
    assert.equal(trustExpiry(cookies), null);
  });

  it("ignores unrelated persistent cookies such as analytics", () => {
    const cookies = [cookie({ name: "_ga", domain: ".uwaterloo.ca", expires: inHours(24 * 400) })];
    assert.equal(trustExpiry(cookies), null);
  });
});

describe("ssoExpiry", () => {
  it("reads a persistent ADFS SSO cookie", () => {
    const cookies = [
      cookie({ name: "MSISAuthenticated", domain: ADFS, expires: inHours(24 * 7) }),
    ];
    assert.ok(ssoExpiry(cookies));
  });

  it("is null when ADFS set no persistent cookie", () => {
    // The real 2026-07-29 observation: Duo trust persisted, ADFS did not, so the
    // next command would still need a password.
    const cookies = [
      cookie({ name: "browsertrust|DEVICE|ORG", domain: DUO, expires: inHours(24 * 30) }),
      cookie({ name: "CSPRPDB-PORTAL-PSJSESSIONID" }),
    ];
    assert.equal(ssoExpiry(cookies), null);
    assert.ok(trustExpiry(cookies), "duo trust should still be reported");
  });

  it("does not confuse Duo cookies for SSO", () => {
    const cookies = [
      cookie({ name: "browsertrust|DEVICE|ORG", domain: DUO, expires: inHours(24 * 30) }),
    ];
    assert.equal(ssoExpiry(cookies), null);
  });
});

describe("questSessionExpiry", () => {
  it("is null for a session-scoped Quest cookie", () => {
    assert.equal(questSessionExpiry([cookie({ name: "CSPRPDB-PORTAL-PSJSESSIONID" })]), null);
  });

  it("ignores cookies from other domains", () => {
    const cookies = [
      cookie({ name: "MSISAuth", domain: "adfs.uwaterloo.ca", expires: inHours(5) }),
    ];
    assert.equal(questSessionExpiry(cookies), null);
  });
});

describe("statusFromCookies", () => {
  it("distinguishes expired-with-trust from fully expired", () => {
    const withTrust = [
      cookie({ name: "browsertrust|DEVICE|ORG", domain: DUO, expires: inHours(24 * 30) }),
    ];
    assert.equal(statusFromCookies(withTrust, false).state, "expired_trust_valid");
    assert.equal(statusFromCookies([], false).state, "expired");
  });

  it("reports live and stamps last_verified_at only when live", () => {
    assert.equal(statusFromCookies([], true).state, "live");
    assert.ok(statusFromCookies([], true).last_verified_at);
    assert.equal(statusFromCookies([], false).last_verified_at, null);
  });
});
