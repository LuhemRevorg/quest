# ADR 0001 — Rust CLI with a Node session worker

Status: accepted
Date: 2026-07-29

## Context

The CLI and domain model should be in Rust. But the session layer needs a
persistent browser context, and needs to survive PeopleSoft's nested
`ptifrmtgtframe` iframes. Playwright gives both for free; its Rust bindings are
unmaintained, and `chromiumoxide` (raw CDP) would mean hand-rolling
persistent-context and iframe handling — in the exact layer that carries ~80% of
the project's risk.

## Decision

Split the process. Rust (`crates/quest-cli`, `crates/quest-core`) owns CLI
parsing, config, keychain access, output formatting, exit codes, and all page
parsing. A small Node worker (`worker/`) owns nothing but driving Chromium
through Playwright. They speak newline-delimited JSON over the worker's
stdin/stdout.

stdio rather than a unix socket: no socket file for another local process to
connect to, and the worker's lifetime is exactly the parent's — no orphaned
Chromium left holding a lock on the profile dir.

## Consequences

- Two toolchains to install and two halves of a wire protocol to keep in sync
  (`session/protocol.rs` ↔ `worker/src/protocol.ts`).
- Parsing stays in Rust and stays testable against fixtures without a browser.
- The worker is small enough to rewrite against `chromiumoxide` later if the
  Rust CDP story improves, without touching the CLI or domain model.

## Fallback

If this split visibly bloats the Phase 1 milestone — auth working end to end —
collapse to all-TypeScript rather than fighting it.
