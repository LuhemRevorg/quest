//! Typed domain model. Everything here is `--json`-serializable and versioned.

pub mod auth;
pub mod grades;
pub mod schedule;
pub mod search;
pub mod term;

/// Bumped on any breaking change to a `--json` payload shape. Emitted as
/// `schema_version` in every JSON response so consumers can pin.
///
/// The worker emits this too — see `SCHEMA_VERSION` in `worker/src/status.ts`.
pub const SCHEMA_VERSION: u32 = 1;
