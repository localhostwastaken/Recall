//! Recall witness: the pure, testable parts of the patch on top of the
//! upstream TLSNotary verifier server (see `main.rs` and `verifier.rs`).
//!
//! - [`attest`]: the EIP-712 `Capture` statement, its digest and signature.
//! - [`gates`]: the checks a session must pass before the witness signs.

pub mod attest;
pub mod gates;
