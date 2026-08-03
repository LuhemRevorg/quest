//! The session layer — persistent browser context, driven out-of-process.
//!
//! This is ~80% of the project's risk, so it is deliberately the thinnest
//! possible seam: Rust owns policy (when to log in, what counts as live, what
//! exit code results), Node owns only the mechanics of driving Chromium.

pub mod protocol;
pub mod worker;

pub use worker::Worker;
