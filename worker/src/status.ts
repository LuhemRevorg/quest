// Building the AuthStatus payload from the cookie jar.
//
// Shape must match `AuthStatus` in `crates/quest-core/src/model/auth.rs`.

import type { BrowserContext, Cookie } from "playwright";

/** Keep in sync with `SCHEMA_VERSION` in `crates/quest-core/src/model/mod.rs`. */
export const SCHEMA_VERSION = 1;

export type SessionState =
  | "live"
  | "expired_trust_valid"
  | "expired"
  | "never_logged_in";

export interface AuthStatus {
  schema_version: number;
  state: SessionState;
  profile_present: boolean;
  /** Filled in by the Rust side from config; the worker does not know it. */
  username: null;
  device_trust_expires_at: string | null;
  sso_expires_at: string | null;
  session_expires_at: string | null;
  last_verified_at: string | null;
}

/**
 * Duo's "remember this device for 30 days" cookie, confirmed from a real login on
 * 2026-07-29: `browsertrust|<device>|<org>` on `api-*.duosecurity.com`, expiring
 * exactly 30 days out.
 *
 * Narrow on purpose. Duo also sets `trc|`, `lam|`, `hac|` and `fsc|` cookies with
 * expiries out to 2027; a looser pattern matches those and overstates when the
 * next passcode is due, which is the one number this field exists to report.
 */
const TRUST_COOKIE_PATTERNS = [/^browsertrust\|/i] as const;

/**
 * ADFS's SSO cookies. Persistent only when "keep me signed in" was ticked, which
 * is the difference between a silent re-auth and a password prompt.
 */
const SSO_COOKIE_PATTERNS = [/^MSISAuth/i, /^MSISSamlSession/i] as const;

const QUEST_DOMAIN = /quest\.uwaterloo\.ca$/i;

export async function buildStatus(
  ctx: BrowserContext,
  live: boolean,
): Promise<AuthStatus> {
  const cookies = await ctx.cookies();
  maybeDumpCookies(cookies);
  return statusFromCookies(cookies, live);
}

/** The decision logic, split out from the browser so it can be tested directly. */
export function statusFromCookies(cookies: Cookie[], live: boolean): AuthStatus {
  const trust = trustExpiry(cookies);
  return {
    schema_version: SCHEMA_VERSION,
    state: live ? "live" : trust ? "expired_trust_valid" : "expired",
    profile_present: true,
    username: null,
    device_trust_expires_at: trust,
    sso_expires_at: ssoExpiry(cookies),
    session_expires_at: questSessionExpiry(cookies),
    last_verified_at: live ? new Date().toISOString() : null,
  };
}

/** When Duo will next demand a passcode. */
export function trustExpiry(cookies: Cookie[]): string | null {
  return latestExpiry(cookies.filter((c) => TRUST_COOKIE_PATTERNS.some((p) => p.test(c.name))));
}

/**
 * When ADFS will next demand a password. Null means keep-me-signed-in was not in
 * effect, so the *next* command needs a human even though Duo trust may be fine.
 */
export function ssoExpiry(cookies: Cookie[]): string | null {
  return latestExpiry(cookies.filter((c) => SSO_COOKIE_PATTERNS.some((p) => p.test(c.name))));
}

/**
 * Quest's own session cookie is usually session-scoped (`expires === -1`), so
 * this is legitimately null most of the time.
 */
export function questSessionExpiry(cookies: Cookie[]): string | null {
  return earliestExpiry(
    cookies.filter((c) => QUEST_DOMAIN.test(c.domain.replace(/^\./, ""))),
  );
}

/** `expires` is a unix timestamp in seconds, or -1 for a session cookie. */
function persistent(cookies: Cookie[]): Cookie[] {
  const now = Date.now() / 1000;
  return cookies.filter((c) => c.expires > now);
}

function latestExpiry(cookies: Cookie[]): string | null {
  const live = persistent(cookies);
  if (live.length === 0) return null;
  return isoSeconds(Math.max(...live.map((c) => c.expires)));
}

function earliestExpiry(cookies: Cookie[]): string | null {
  const live = persistent(cookies);
  if (live.length === 0) return null;
  return isoSeconds(Math.min(...live.map((c) => c.expires)));
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Names, domains and expiries only — never values. A cookie value here is a live
 * bearer token for the whole student record.
 */
function maybeDumpCookies(cookies: Cookie[]): void {
  if (!process.env["QUEST_DEBUG_COOKIES"]) return;
  process.stderr.write(`worker: ${cookies.length} cookies in the jar\n`);
  for (const c of cookies) {
    const expiry = c.expires > 0 ? isoSeconds(c.expires) : "session";
    process.stderr.write(`worker:   ${c.domain}${c.path} ${c.name} → ${expiry}\n`);
  }
}
