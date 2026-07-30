// Wire format between the Rust CLI and this worker.
//
// **This file and `crates/quest-core/src/session/protocol.rs` are two halves of
// one contract.** Change them together.

export type Request =
  | { id: number; op: "login"; params: LoginParams }
  | { id: number; op: "status"; params: StatusParams }
  | { id: number; op: "grades"; params: GradesParams }
  | { id: number; op: "schedule"; params: ScheduleParams }
  // No `logout` op: dropping the session means deleting the profile dir, which
  // the Rust side does directly. Nothing there needs a browser.
  | { id: number; op: "shutdown" };

/** How the browser window is rendered. See `browser.ts` for why it matters. */
export type Display = "headed" | "headless";

export interface LoginParams {
  profile_dir: string;
  username: string | null;
  /** Never log this. */
  password: string | null;
  duo_timeout_secs: number;
  display: Display;
  /** False means no waiting on a human — fail with needs_reauth instead. */
  allow_human: boolean;
}

export interface StatusParams {
  profile_dir: string;
}

export interface ScheduleParams {
  login: LoginParams;
  /** Term as Quest labels it, e.g. "Spring 2026". Matched case-insensitively. */
  term_label: string;
}

export interface GradesParams {
  /** Grades authenticate first, so they carry the full sign-in parameters. */
  login: LoginParams;
  /** Term as Quest labels it, e.g. "Winter 2026". Matched case-insensitively. */
  term_label: string;
}

export type Stage =
  | "launching_browser"
  | "navigating_to_quest"
  | "session_reused"
  | "filling_credentials"
  | "awaiting_duo"
  | "continuing"
  | "remembering_device"
  | "persisting_session"
  | "verifying";

export type ErrorCode =
  | "needs_reauth"
  | "bad_credentials"
  | "duo_timeout"
  | "unexpected_page"
  | "browser_launch_failed"
  | "internal";

export type Response =
  | { kind: "progress"; id: number; stage: Stage; message: string }
  | { kind: "result"; id: number; data: unknown }
  | { kind: "error"; id: number; code: ErrorCode; message: string };

/** Thrown by handlers to produce a typed `error` response. */
export class WorkerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

/** The single writer to stdout. Handlers must never `console.log`. */
export function send(response: Response): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export function progress(id: number, stage: Stage, message: string): void {
  send({ kind: "progress", id, stage, message });
}
