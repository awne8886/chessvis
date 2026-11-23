//! Clock and random numbers for WebAssembly. `wasm32-unknown-unknown` has neither a clock nor a source of randomness,
//! so both come from JavaScript: the page supplies `env.js_now` (milliseconds, e.g. `performance.now()`) and
//! `env.js_random` (a float in [0, 1), e.g. `Math.random()`).
//!
//! `Instant` replaces `std::time::Instant` in `search.rs` and `matesearch.rs` (it is the only part of std::time they use
//! besides `Duration`). It is a point in time in milliseconds as an f64.
//!
//! Reconstructed for ChessVision 2.0.2 from the shipped AggroChess 4.6.1 web build (see ../README.md): `elapsed()` is
//! `Duration::from_micros(((now - start).max(0.0) * 1000.0) as u64)` and `seed()` combines two random numbers exactly as
//! that build does, so the rebuilt engine searches the same tree and picks the same book moves.

use std::time::Duration;

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_now() -> f64;
    fn js_random() -> f64;
}

#[inline]
fn now_ms() -> f64 {
    // SAFETY: a plain import without arguments or memory access
    unsafe { js_now() }
}

/// A float in [0, 1) from JavaScript.
#[inline]
pub fn random() -> f64 {
    // SAFETY: a plain import without arguments or memory access
    unsafe { js_random() }
}

/// A 64-bit seed from two random numbers.
pub fn seed() -> u64 {
    let hi = (random() * 4294967296.0) as u64;
    let lo = (random() * 4294967296.0) as u64;
    ((hi << 32) ^ lo) ^ 0x9E37_79B9_7F4A_7C15
}

#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub struct Instant(f64);

impl Instant {
    #[inline]
    pub fn now() -> Instant {
        Instant(now_ms())
    }

    #[inline]
    pub fn elapsed(&self) -> Duration {
        let ms = (now_ms() - self.0).max(0.0);
        Duration::from_micros((ms * 1000.0) as u64)
    }
}

impl std::ops::Add<Duration> for Instant {
    type Output = Instant;
    #[inline]
    fn add(self, d: Duration) -> Instant {
        Instant(self.0 + d.as_secs_f64() * 1000.0)
    }
}
