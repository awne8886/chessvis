//! AggroChess NNUE: (768 -> 256) x 2 -> SCReLU -> 1 with 8 output buckets by piece count.
//!
//! The network is trained only on AggroChess's own self-play games (see `datagen.rs`), so it
//! is AggroChess's judgement, learned. It gives the *objective* part of the evaluation; the
//! personality (extra king danger against the opponent, trade aversion and so on) is still
//! added on top in `eval.rs`, and the sacrifice bonus and contempt still live in the search.
//!
//! Accumulators are updated incrementally as the search makes moves (`Accumulator::apply`),
//! and refreshed from scratch whenever the search enters a position it has no accumulator for.

use cozy_chess::{Board, Color, Move, Piece, Square};
use std::sync::OnceLock;

pub const H: usize = 256;
const INPUTS: usize = 768;
const BUCKETS: usize = 8;
const SCALE: i32 = 400;
const QA: i32 = 255;
const QB: i32 = 64;

static NET_BYTES: &[u8] = include_bytes!("../aggro.nnue");

/// Output scale in percent. The net's evaluations come out larger than the classical
/// evaluation's (it learned from game results too), so they are scaled down to the classical
/// scale that the search margins and the personality layer were tuned for.
pub static OUT_SCALE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(67);

pub struct Net {
    ft_w: Vec<i16>,
    ft_b: Vec<i16>,
    out_w: Vec<i16>,
    out_b: Vec<i32>,
}

static NET: OnceLock<Net> = OnceLock::new();

/// A second net for opposite-coloured bishop endings (one bishop a side, nothing else but
/// pawns) in which a bishop is buried behind its own pawns and cannot move. Then the game is
/// a pawn ending in all but name, one spare pawn tempo can decide it (Salai's 1.f4!!), and
/// the main net, which counts the bishop, is far off. It is the main net trained further on
/// such endings; keeping that in a net of its own leaves the main net's judgement of every
/// other position exactly as it was.
static OCB_BYTES: &[u8] = include_bytes!("../aggro-ocb.nnue");
static OCB: OnceLock<Net> = OnceLock::new();
pub static OCB_NET_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[inline]
fn ocb_net() -> &'static Net {
    OCB.get_or_init(|| match std::env::var("AGGRO_OCBNET") {
        Ok(f) => parse(&std::fs::read(f).expect("AGGRO_OCBNET file")),
        Err(_) => parse(OCB_BYTES),
    })
}

/// Is this an ending the second net is for?
#[inline]
pub fn is_ocb(board: &Board) -> bool {
    OCB_NET_ON.load(std::sync::atomic::Ordering::Relaxed) && crate::eval::ocb_scale(board).is_some() && crate::eval::buried_bishop(board)
}

/// The second net's verdict (side to move's view). Worked out from scratch: these endings
/// have few pieces, and the search keeps no accumulators for them.
pub fn evaluate_ocb(board: &Board) -> i32 {
    let n = ocb_net();
    let mut a = Accumulator::default();
    a.refresh_with(n, board);
    a.evaluate_with(n, board)
}

fn parse(v: &[u8]) -> Net {
    assert_eq!(&v[0..4], b"AGNN", "bad network file");
    let h = u32::from_le_bytes(v[4..8].try_into().unwrap()) as usize;
    assert_eq!(h, H, "network has a different hidden size");
    let mut off = 8;
    let mut rd = |n: usize| -> Vec<i16> {
        let r = (0..n).map(|i| i16::from_le_bytes([v[off + 2 * i], v[off + 2 * i + 1]])).collect();
        off += 2 * n;
        r
    };
    let ft_w = rd(INPUTS * H);
    let ft_b = rd(H);
    let out_w = rd(BUCKETS * 2 * H);
    let out_b = (0..BUCKETS).map(|i| i32::from_le_bytes(v[off + 4 * i..off + 4 * i + 4].try_into().unwrap())).collect();
    Net { ft_w, ft_b, out_w, out_b }
}

#[inline]
pub fn net() -> &'static Net {
    NET.get_or_init(|| match std::env::var("AGGRO_NET") {
        Ok(f) => parse(&std::fs::read(f).expect("AGGRO_NET file")),
        Err(_) => parse(NET_BYTES),
    })
}

#[inline(always)]
fn feature(persp: usize, color: usize, piece: usize, sq: usize) -> usize {
    let s = if persp == 0 { sq } else { sq ^ 56 };
    (if color == persp { 0 } else { 384 }) + piece * 64 + s
}

#[derive(Clone)]
#[repr(C, align(64))]
pub struct Accumulator {
    /// [white perspective, black perspective]
    pub v: [[i16; H]; 2],
}

impl Default for Accumulator {
    fn default() -> Self {
        Accumulator { v: [[0; H]; 2] }
    }
}

#[inline(always)]
fn add(acc: &mut [i16; H], w: &[i16]) {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return wasm_simd::add(acc, w);
    }
    #[allow(unreachable_code)]
    for (a, b) in acc.iter_mut().zip(w) {
        *a = a.wrapping_add(*b);
    }
}

#[inline(always)]
fn sub(acc: &mut [i16; H], w: &[i16]) {
    for (a, b) in acc.iter_mut().zip(w) {
        *a = a.wrapping_sub(*b);
    }
}

impl Accumulator {
    pub fn refresh(&mut self, board: &Board) {
        self.refresh_with(net(), board)
    }

    fn refresh_with(&mut self, n: &Net, board: &Board) {
        for persp in 0..2 {
            self.v[persp].copy_from_slice(&n.ft_b);
        }
        for color in [Color::White, Color::Black] {
            for piece in Piece::ALL {
                for sq in board.colored_pieces(color, piece) {
                    for persp in 0..2 {
                        let f = feature(persp, color as usize, piece as usize, sq as usize);
                        add(&mut self.v[persp], &n.ft_w[f * H..f * H + H]);
                    }
                }
            }
        }
    }

    #[inline(always)]
    fn toggle(&mut self, on: bool, color: Color, piece: Piece, sq: Square) {
        let n = net();
        for persp in 0..2 {
            let f = feature(persp, color as usize, piece as usize, sq as usize);
            let w = &n.ft_w[f * H..f * H + H];
            if on {
                add(&mut self.v[persp], w);
            } else {
                sub(&mut self.v[persp], w);
            }
        }
    }

    /// Update `self` (a copy of the parent's accumulator) for `mv` played on `board` (the
    /// position *before* the move).
    pub fn apply(&mut self, board: &Board, mv: Move) {
        let src = self.clone();
        self.apply_from(&src, board, mv);
    }

    /// `self` = `parent` updated for `mv` played on `board` (the position before the move),
    /// in one pass over the weights (no separate copy, one add/sub sweep per perspective).
    pub fn apply_from(&mut self, parent: &Accumulator, board: &Board, mv: Move) {
        let us = board.side_to_move();
        let piece = match board.piece_on(mv.from) {
            Some(p) => p,
            None => {
                self.v = parent.v;
                return;
            }
        };
        // (color, piece, square) features to add and to remove
        let mut adds: [(Color, Piece, Square); 2] = [(us, piece, mv.to); 2];
        let mut subs: [(Color, Piece, Square); 2] = [(us, piece, mv.from); 2];
        let (na, ns);
        if piece == Piece::King && board.colors(us).has(mv.to) {
            // castling: cozy-chess encodes it as the king capturing its own rook
            let rank = mv.from.rank();
            let short = mv.to.file() > mv.from.file();
            let (kf, rf) = if short {
                (cozy_chess::File::G, cozy_chess::File::F)
            } else {
                (cozy_chess::File::C, cozy_chess::File::D)
            };
            subs = [(us, Piece::King, mv.from), (us, Piece::Rook, mv.to)];
            adds = [(us, Piece::King, Square::new(kf, rank)), (us, Piece::Rook, Square::new(rf, rank))];
            na = 2;
            ns = 2;
        } else {
            adds[0] = (us, mv.promotion.unwrap_or(piece), mv.to);
            na = 1;
            if let Some(cap) = board.piece_on(mv.to) {
                subs[1] = (!us, cap, mv.to);
                ns = 2;
            } else if piece == Piece::Pawn && mv.from.file() != mv.to.file() {
                subs[1] = (!us, Piece::Pawn, Square::new(mv.to.file(), mv.from.rank()));
                ns = 2;
            } else {
                ns = 1;
            }
        }
        let n = net();
        for persp in 0..2 {
            let w = |(c, p, sq): (Color, Piece, Square)| {
                let f = feature(persp, c as usize, p as usize, sq as usize);
                &n.ft_w[f * H..f * H + H]
            };
            let a0 = w(adds[0]);
            let s0 = w(subs[0]);
            let a1 = if na > 1 { Some(w(adds[1])) } else { None };
            let s1 = if ns > 1 { Some(w(subs[1])) } else { None };
            update(&mut self.v[persp], &parent.v[persp], a0, s0, a1, s1);
        }
    }

    /// Evaluation from the side to move's point of view, centipawns.
    pub fn evaluate(&self, board: &Board) -> i32 {
        self.evaluate_with(net(), board)
    }

    fn evaluate_with(&self, n: &Net, board: &Board) -> i32 {
        let stm = board.side_to_move() as usize;
        let count = board.occupied().len() as usize;
        let bucket = ((count.max(2) - 2) / 4).min(BUCKETS - 1);
        let ow = &n.out_w[bucket * 2 * H..(bucket + 1) * 2 * H];
        let sum = screlu_dot(&self.v[stm], &ow[..H]) + screlu_dot(&self.v[1 - stm], &ow[H..]);
        let y = sum / QA as i64 + n.out_b[bucket] as i64;
        let scale = OUT_SCALE.load(std::sync::atomic::Ordering::Relaxed) as i64;
        (y * SCALE as i64 * scale / (100 * (QA * QB) as i64)) as i32
    }
}

static AVX2: OnceLock<bool> = OnceLock::new();

#[inline(always)]
fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        *AVX2.get_or_init(|| std::is_x86_feature_detected!("avx2"))
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[inline(always)]
fn update_body(out: &mut [i16; H], src: &[i16; H], a0: &[i16], s0: &[i16], a1: Option<&[i16]>, s1: Option<&[i16]>) {
    let (a0, s0) = (&a0[..H], &s0[..H]);
    match (a1, s1) {
        (None, None) => {
            for i in 0..H {
                out[i] = src[i].wrapping_add(a0[i]).wrapping_sub(s0[i]);
            }
        }
        (None, Some(s1)) => {
            let s1 = &s1[..H];
            for i in 0..H {
                out[i] = src[i].wrapping_add(a0[i]).wrapping_sub(s0[i]).wrapping_sub(s1[i]);
            }
        }
        (Some(a1), Some(s1)) => {
            let (a1, s1) = (&a1[..H], &s1[..H]);
            for i in 0..H {
                out[i] = src[i].wrapping_add(a0[i]).wrapping_add(a1[i]).wrapping_sub(s0[i]).wrapping_sub(s1[i]);
            }
        }
        (Some(a1), None) => {
            let a1 = &a1[..H];
            for i in 0..H {
                out[i] = src[i].wrapping_add(a0[i]).wrapping_add(a1[i]).wrapping_sub(s0[i]);
            }
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn update_avx2(out: &mut [i16; H], src: &[i16; H], a0: &[i16], s0: &[i16], a1: Option<&[i16]>, s1: Option<&[i16]>) {
    update_body(out, src, a0, s0, a1, s1)
}

#[inline(always)]
fn update(out: &mut [i16; H], src: &[i16; H], a0: &[i16], s0: &[i16], a1: Option<&[i16]>, s1: Option<&[i16]>) {
    #[cfg(target_arch = "x86_64")]
    {
        if has_avx2() {
            // SAFETY: AVX2 support was checked at run time
            return unsafe { update_avx2(out, src, a0, s0, a1, s1) };
        }
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return wasm_simd::update(out, src, a0, s0, a1, s1);
    }
    #[allow(unreachable_code)]
    update_body(out, src, a0, s0, a1, s1)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn screlu_dot_avx2(acc: &[i16; H], w: &[i16]) -> i64 {
    screlu_dot_body(acc, w)
}

#[inline(always)]
fn screlu_dot(acc: &[i16; H], w: &[i16]) -> i64 {
    #[cfg(target_arch = "x86_64")]
    {
        if has_avx2() {
            // SAFETY: AVX2 support was checked at run time
            return unsafe { screlu_dot_avx2(acc, w) };
        }
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return wasm_simd::screlu_dot(acc, w);
    }
    #[allow(unreachable_code)]
    screlu_dot_body(acc, w)
}

/// Explicit WebAssembly SIMD (ChessVision 2.0.2) for the simd128 build. Bit-exact with the scalar code:
/// - the accumulator updates are wrapping i16 adds / subs, as in `update_body` / `add`;
/// - `screlu_dot`: v = clamp(acc, 0, QA), vw = v * w (wrapping i16, as `wrapping_mul`), then v * vw summed as i32 with
///   `i32x4.dot_i16x8_s` (pairs of exact i32 products). Each lane of each of the two accumulators sums 32 products of
///   at most 255 * 32767 in magnitude (< 2^23), so no i32 sum can overflow and the i64 total is the scalar one.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod wasm_simd {
    use super::{H, QA};
    use core::arch::wasm32::*;

    #[inline(always)]
    fn ld(p: &[i16], i: usize) -> v128 {
        debug_assert!(i + 8 <= p.len());
        // SAFETY: i + 8 <= p.len() for every caller (slices of H = 256 values, i a multiple of 8 below H);
        // wasm loads have no alignment requirement
        unsafe { v128_load(p.as_ptr().add(i) as *const v128) }
    }

    #[inline(always)]
    fn st(p: &mut [i16], i: usize, v: v128) {
        debug_assert!(i + 8 <= p.len());
        // SAFETY: as in ld
        unsafe { v128_store(p.as_mut_ptr().add(i) as *mut v128, v) }
    }

    #[inline(always)]
    pub(super) fn add(acc: &mut [i16; H], w: &[i16]) {
        let w = &w[..H];
        for i in (0..H).step_by(8) {
            let v = i16x8_add(ld(acc, i), ld(w, i));
            st(acc, i, v);
        }
    }

    #[inline(always)]
    pub(super) fn update(out: &mut [i16; H], src: &[i16; H], a0: &[i16], s0: &[i16], a1: Option<&[i16]>, s1: Option<&[i16]>) {
        let (a0, s0) = (&a0[..H], &s0[..H]);
        match (a1, s1) {
            (None, None) => {
                for i in (0..H).step_by(8) {
                    st(out, i, i16x8_sub(i16x8_add(ld(src, i), ld(a0, i)), ld(s0, i)));
                }
            }
            (None, Some(s1)) => {
                let s1 = &s1[..H];
                for i in (0..H).step_by(8) {
                    st(out, i, i16x8_sub(i16x8_sub(i16x8_add(ld(src, i), ld(a0, i)), ld(s0, i)), ld(s1, i)));
                }
            }
            (Some(a1), Some(s1)) => {
                let (a1, s1) = (&a1[..H], &s1[..H]);
                for i in (0..H).step_by(8) {
                    let v = i16x8_add(i16x8_add(ld(src, i), ld(a0, i)), ld(a1, i));
                    st(out, i, i16x8_sub(i16x8_sub(v, ld(s0, i)), ld(s1, i)));
                }
            }
            (Some(a1), None) => {
                let a1 = &a1[..H];
                for i in (0..H).step_by(8) {
                    st(out, i, i16x8_sub(i16x8_add(i16x8_add(ld(src, i), ld(a0, i)), ld(a1, i)), ld(s0, i)));
                }
            }
        }
    }

    #[inline(always)]
    pub(super) fn screlu_dot(acc: &[i16; H], w: &[i16]) -> i64 {
        let w = &w[..H];
        let zero = i16x8_splat(0);
        let qa = i16x8_splat(QA as i16);
        let mut sum0 = i32x4_splat(0);
        let mut sum1 = i32x4_splat(0);
        for i in (0..H).step_by(16) {
            let v0 = i16x8_min(i16x8_max(ld(acc, i), zero), qa);
            let v1 = i16x8_min(i16x8_max(ld(acc, i + 8), zero), qa);
            sum0 = i32x4_add(sum0, i32x4_dot_i16x8(v0, i16x8_mul(v0, ld(w, i))));
            sum1 = i32x4_add(sum1, i32x4_dot_i16x8(v1, i16x8_mul(v1, ld(w, i + 8))));
        }
        let lanes = |s: v128| {
            i32x4_extract_lane::<0>(s) as i64 + i32x4_extract_lane::<1>(s) as i64 + i32x4_extract_lane::<2>(s) as i64 + i32x4_extract_lane::<3>(s) as i64
        };
        lanes(sum0) + lanes(sum1)
    }
}

#[inline(always)]
fn screlu_dot_body(acc: &[i16; H], w: &[i16]) -> i64 {
    // (v * w) fits in i16 because |w| <= 127 and v <= 255; multiply by v again in i32
    let mut total: i64 = 0;
    for (ca, cw) in acc.chunks_exact(32).zip(w.chunks_exact(32)) {
        let mut s: i32 = 0;
        for (a, b) in ca.iter().zip(cw) {
            let v = (*a).clamp(0, QA as i16);
            let vw = v.wrapping_mul(*b);
            s += vw as i32 * v as i32;
        }
        total += s as i64;
    }
    total
}

/// One-off evaluation (refreshes an accumulator from scratch).
pub fn evaluate_fresh(board: &Board) -> i32 {
    if is_ocb(board) {
        return evaluate_ocb(board);
    }
    let mut a = Accumulator::default();
    a.refresh(board);
    a.evaluate(board)
}
