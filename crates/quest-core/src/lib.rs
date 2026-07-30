//! Core library for the Quest CLI: config, secret handling, session-worker
//! transport, and the domain model.
//!
//! Deliberately contains no CLI concerns (no clap, no printing, no
//! `std::process::exit`). The CLI crate and, later, the MCP server both sit on
//! top of this.

pub mod config;
pub mod credentials;
pub mod error;
pub mod model;
pub mod paths;
pub mod session;

pub use error::{Error, Result};
