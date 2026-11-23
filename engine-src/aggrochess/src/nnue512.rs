//! AggroChess NNUE, ChessVision 2.0.3 experiment: (768 x 3 mirrored king buckets -> 512) x 2 -> SCReLU -> 1, 8 output
//! buckets by piece count. Built only with `--features net512` (tools/build-aggrochess.sh --net512), in place of
//! `nnue.rs`; NOT shipped: this network lost to 4.6.1's at equal time per move (README.md, "The 2.0.3 network").
//!
//! AggroChess 4.6.1 had (768 -> 256) x 2 with no king buckets, trained by its own trainer on 3.1 million positions of
//! AggroChess self-play. The 2.0.3 net is trained with bullet (engine-src/aggrochess/bullet/) on more positions of the
//! same self-play (`aggro_chess datagen`, personality off), so it is still AggroChess's judgement, learned. It gives the
//! *objective* part of the evaluation; the personality (extra king danger against the opponent, trade aversion and so
//! on) is still added on top in `eval.rs`, and the sacrifice bonus and contempt still live in the search.
//!
//! Inputs: each side sees the board from its own side (Black's view flipped vertically), mirrored left-right when its
//! king stands on files e-h, and its king square picks one of the feature-weight buckets (see `BUCKETS` in the net
//! file: king sheltered in a corner / central on the back two ranks / advanced). Features are bullet's
//! `ChessBucketsMirrored` exactly.
//!
//! Accumulators are updated incrementally as the search makes moves (`Accumulator::apply_from`). A king move into
//! another bucket or across the middle of the board changes every feature of that side: that side is then rebuilt
//! from a per-thread cache of accumulators, one per (side, bucket, mirror) with the pieces it was built for (a "Finny
//! table"), by adding and removing only the pieces that differ, which keeps king moves cheap. Positions the search
//! has no accumulator for are built the same way.
//!
//! A second, older net (4.6.1's, 768 -> 256, no buckets) judges opposite-coloured bishop endings with a buried bishop;
//! it is evaluated from scratch (see `ocb`).

use cozy_chess::{Board, Color, Move, Piece, Square};
use std::cell::RefCell;
use std::sync::OnceLock;

pub const H: usize = 512;
const INPUTS: usize = 768;
const OUT_BUCKETS: usize = 8;
const SCALE: i32 = 400;
const QA: i32 = 255;
const QB: i32 = 64;

/// The network file (`bullet/src/bin/pack.rs` writes it): feature weights packed one byte each (escaped when larger),
/// decoded once when the engine starts.
static NET_BYTES: &[u8] = include_bytes!("../aggro-768x3hm-512.nnue");

/// Output scale in percent. The net's raw evaluations are scaled to the classical evaluation's scale, which the search
/// margins and the personality layer were tuned for (4.6.1's net: 67). Measured for the 2.0.3 net against 4.6.1's
/// scaled evaluation on the 100 000 held-out positions of its data (`pack calibrate`: 55.9%, correlation 0.93).
pub static OUT_SCALE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(56);

pub struct Net {
    ft_w: &'static [i16],
    ft_b: &'static [i16],
    out_w: &'static [i16],
    out_b: Vec<i32>,
    /// number of king buckets
    nb: usize,
    /// king bucket of each square (as seen by the side whose king it is, before mirroring)
    kb: [u8; 64],
}

static NET: OnceLock<Net> = OnceLock::new();

fn le_u32(v: &[u8], off: usize) -> usize {
    u32::from_le_bytes(v[off..off + 4].try_into().unwrap()) as usize
}

fn parse(v: &[u8]) -> Net {
    assert_eq!(&v[0..4], b"AGNB", "bad network file");
    assert_eq!(le_u32(v, 4), 1, "unknown network file version");
    assert_eq!(le_u32(v, 8), H, "network has a different hidden size");
    let nb = le_u32(v, 12);
    let layout = &v[16..48];
    assert!(nb >= 1 && layout.iter().all(|&b| (b as usize) < nb));
    assert_eq!(le_u32(v, 48), OUT_BUCKETS);
    let n_ft = le_u32(v, 52);
    assert_eq!(n_ft, nb * INPUTS * H);
    let mut kb = [0u8; 64];
    for (sq, b) in kb.iter_mut().enumerate() {
        *b = layout[(sq / 8) * 4 + [0, 1, 2, 3, 3, 2, 1, 0][sq % 8]];
    }
    let mut off = 56;
    let mut ft_w = Vec::with_capacity(n_ft);
    while ft_w.len() < n_ft {
        let b = v[off] as i8;
        if b == -128 {
            ft_w.push(i16::from_le_bytes([v[off + 1], v[off + 2]]));
            off += 3;
        } else {
            ft_w.push(b as i16);
            off += 1;
        }
    }
    let mut rd = |n: usize| -> &'static [i16] {
        let r: Vec<i16> = v[off..off + 2 * n].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        off += 2 * n;
        Box::leak(r.into_boxed_slice())
    };
    let ft_b = rd(H);
    let out_w = rd(OUT_BUCKETS * 2 * H);
    let out_b = (0..OUT_BUCKETS).map(|i| i32::from_le_bytes(v[off + 4 * i..off + 4 * i + 4].try_into().unwrap())).collect();
    assert_eq!(off + 4 * OUT_BUCKETS, v.len(), "network file has trailing bytes");
    Net { ft_w: Box::leak(ft_w.into_boxed_slice()), ft_b, out_w, out_b, nb, kb }
}

#[inline]
pub fn net() -> &'static Net {
    NET.get_or_init(|| match std::env::var("AGGRO_NET") {
        Ok(f) => parse(&std::fs::read(f).expect("AGGRO_NET file")),
        Err(_) => parse(NET_BYTES),
    })
}

/// A side's view: (offset of its king bucket's features, 7 when its king is on files e-h = mirrored, else 0).
type View = (usize, usize);

#[inline(always)]
fn view_of(n: &Net, persp: usize, king: Square) -> View {
    let k = if persp == 0 { king as usize } else { king as usize ^ 56 };
    (INPUTS * n.kb[k] as usize, if k % 8 > 3 { 7 } else { 0 })
}

#[inline(always)]
fn feature(view: View, persp: usize, color: usize, piece: usize, sq: usize) -> usize {
    let s = if persp == 0 { sq } else { sq ^ 56 };
    view.0 + (if color == persp { 0 } else { 384 }) + piece * 64 + (s ^ view.1)
}

#[inline(always)]
fn weights(n: &Net, f: usize) -> &'static [i16] {
    &n.ft_w[f * H..f * H + H]
}

#[derive(Clone)]
#[repr(C, align(64))]
pub struct Accumulator {
    /// [white's view, black's view]
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
    for (a, b) in acc.iter_mut().zip(&w[..H]) {
        *a = a.wrapping_add(*b);
    }
}

#[inline(always)]
fn sub(acc: &mut [i16; H], w: &[i16]) {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        return wasm_simd::sub(acc, w);
    }
    #[allow(unreachable_code)]
    for (a, b) in acc.iter_mut().zip(&w[..H]) {
        *a = a.wrapping_sub(*b);
    }
}

// ---- the Finny table ----

struct FinnyEntry {
    acc: [i16; H],
    /// the pieces `acc` was built for: [colour][piece]
    bb: [[u64; 6]; 2],
}

/// Per thread: [side][bucket][mirrored] entries, made on first use.
struct Finny {
    entries: Vec<FinnyEntry>,
}

thread_local! {
    static FINNY: RefCell<Option<Box<Finny>>> = const { RefCell::new(None) };
}

/// `out` = side `persp`'s accumulator for `board`, from the cached accumulator of the same bucket and mirroring:
/// only the pieces that differ from the ones it was built for are added or removed (wrapping i16 sums, so the result
/// is exactly a from-scratch build).
fn finny_refresh(out: &mut [i16; H], n: &Net, board: &Board, persp: usize) {
    let color = if persp == 0 { Color::White } else { Color::Black };
    let view = view_of(n, persp, board.king(color));
    FINNY.with(|cell| {
        let mut slot = cell.borrow_mut();
        let finny = slot.get_or_insert_with(|| {
            let mut entries = Vec::with_capacity(2 * n.nb * 2);
            for _ in 0..2 * n.nb * 2 {
                let mut acc = [0i16; H];
                acc.copy_from_slice(n.ft_b);
                entries.push(FinnyEntry { acc, bb: [[0; 6]; 2] });
            }
            Box::new(Finny { entries })
        });
        let idx = (persp * n.nb + view.0 / INPUTS) * 2 + usize::from(view.1 != 0);
        let e = &mut finny.entries[idx];
        for (c, col) in [Color::White, Color::Black].into_iter().enumerate() {
            for (p, piece) in Piece::ALL.into_iter().enumerate() {
                let cur = board.colored_pieces(col, piece).0;
                let old = e.bb[c][p];
                let mut on = cur & !old;
                while on != 0 {
                    let sq = on.trailing_zeros() as usize;
                    on &= on - 1;
                    add(&mut e.acc, weights(n, feature(view, persp, c, p, sq)));
                }
                let mut off = old & !cur;
                while off != 0 {
                    let sq = off.trailing_zeros() as usize;
                    off &= off - 1;
                    sub(&mut e.acc, weights(n, feature(view, persp, c, p, sq)));
                }
                e.bb[c][p] = cur;
            }
        }
        *out = e.acc;
    });
}

impl Accumulator {
    pub fn refresh(&mut self, board: &Board) {
        let n = net();
        for persp in 0..2 {
            finny_refresh(&mut self.v[persp], n, board, persp);
        }
    }

    /// From scratch, without the Finny table (tests: must equal `refresh`).
    pub fn refresh_scratch(&mut self, board: &Board) {
        let n = net();
        for persp in 0..2 {
            let color = if persp == 0 { Color::White } else { Color::Black };
            let view = view_of(n, persp, board.king(color));
            self.v[persp].copy_from_slice(n.ft_b);
            for (c, col) in [Color::White, Color::Black].into_iter().enumerate() {
                for (p, piece) in Piece::ALL.into_iter().enumerate() {
                    for sq in board.colored_pieces(col, piece) {
                        add(&mut self.v[persp], weights(n, feature(view, persp, c, p, sq as usize)));
                    }
                }
            }
        }
    }

    /// Update `self` (a copy of the parent's accumulator) for `mv` played on `board` (the position *before* the move).
    pub fn apply(&mut self, board: &Board, mv: Move) {
        let src = self.clone();
        self.apply_from(&src, board, mv);
    }

    /// `self` = `parent` updated for `mv` played on `board` (the position before the move), in one pass over the
    /// weights. A king move that changes its side's bucket or mirroring rebuilds that side from the Finny table.
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
        let mut king_to = mv.to;
        if piece == Piece::King && board.colors(us).has(mv.to) {
            // castling: cozy-chess encodes it as the king capturing its own rook
            let rank = mv.from.rank();
            let short = mv.to.file() > mv.from.file();
            let (kf, rf) = if short {
                (cozy_chess::File::G, cozy_chess::File::F)
            } else {
                (cozy_chess::File::C, cozy_chess::File::D)
            };
            king_to = Square::new(kf, rank);
            subs = [(us, Piece::King, mv.from), (us, Piece::Rook, mv.to)];
            adds = [(us, Piece::King, king_to), (us, Piece::Rook, Square::new(rf, rank))];
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
            let side = if persp == 0 { Color::White } else { Color::Black };
            let view = if side == us && piece == Piece::King {
                let v = view_of(n, persp, king_to);
                if v != view_of(n, persp, mv.from) {
                    let mut child = board.clone();
                    child.play_unchecked(mv);
                    finny_refresh(&mut self.v[persp], n, &child, persp);
                    continue;
                }
                v
            } else {
                view_of(n, persp, board.king(side))
            };
            let w = |(c, p, sq): (Color, Piece, Square)| weights(n, feature(view, persp, c as usize, p as usize, sq as usize));
            let a0 = w(adds[0]);
            let s0 = w(subs[0]);
            let a1 = if na > 1 { Some(w(adds[1])) } else { None };
            let s1 = if ns > 1 { Some(w(subs[1])) } else { None };
            update(&mut self.v[persp], &parent.v[persp], a0, s0, a1, s1);
        }
    }

    /// The net's output before OUT_SCALE (side to move's view, centipawns of the training scale).
    pub fn evaluate_raw(&self, board: &Board) -> i32 {
        let n = net();
        let stm = board.side_to_move() as usize;
        let count = board.occupied().len() as usize;
        let bucket = ((count.max(2) - 2) / 4).min(OUT_BUCKETS - 1);
        let ow = &n.out_w[bucket * 2 * H..(bucket + 1) * 2 * H];
        let sum = screlu_dot(&self.v[stm], &ow[..H]) + screlu_dot(&self.v[1 - stm], &ow[H..]);
        let y = sum / QA as i64 + n.out_b[bucket] as i64;
        (y * SCALE as i64 / (QA * QB) as i64) as i32
    }

    /// Evaluation from the side to move's point of view, centipawns.
    pub fn evaluate(&self, board: &Board) -> i32 {
        let raw = self.evaluate_raw(board) as i64;
        (raw * OUT_SCALE.load(std::sync::atomic::Ordering::Relaxed) as i64 / 100) as i32
    }
}

#[cfg_attr(not(target_arch = "x86_64"), allow(dead_code))]
static AVX2: OnceLock<bool> = OnceLock::new();

#[cfg_attr(not(target_arch = "x86_64"), allow(dead_code))]
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

/// v = clamp(acc, 0, QA); sum of v * (v * w) with v * w as wrapping i16 (|w| <= 127, v <= 255: it fits), summed in
/// i32 over chunks of 32 (< 2^28 each) and then in i64.
#[inline(always)]
fn screlu_dot_n(acc: &[i16], w: &[i16]) -> i64 {
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

#[inline(always)]
fn screlu_dot_body(acc: &[i16; H], w: &[i16]) -> i64 {
    screlu_dot_n(acc, &w[..H])
}

/// Explicit WebAssembly SIMD (ChessVision 2.0.2) for the simd128 build. Bit-exact with the scalar code:
/// - the accumulator updates are wrapping i16 adds / subs, as in `update_body` / `add` / `sub`;
/// - `screlu_dot`: v = clamp(acc, 0, QA), vw = v * w (wrapping i16, as `wrapping_mul`), then v * vw summed as i32 with
///   `i32x4.dot_i16x8_s` (pairs of exact i32 products). Each lane of each of the two accumulators sums 2 x H / 16 = 64
///   products of at most 255 * 32767 in magnitude (< 2^23), so no i32 sum can overflow (< 2^29) and the i64 total is
///   the scalar one.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod wasm_simd {
    use super::{H, QA};
    use core::arch::wasm32::*;

    #[inline(always)]
    fn ld(p: &[i16], i: usize) -> v128 {
        debug_assert!(i + 8 <= p.len());
        // SAFETY: i + 8 <= p.len() for every caller (slices of H values, i a multiple of 8 below H);
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
    pub(super) fn sub(acc: &mut [i16; H], w: &[i16]) {
        let w = &w[..H];
        for i in (0..H).step_by(8) {
            let v = i16x8_sub(ld(acc, i), ld(w, i));
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

/// One-off evaluation (no accumulator kept).
pub fn evaluate_fresh(board: &Board) -> i32 {
    if is_ocb(board) {
        return evaluate_ocb(board);
    }
    let mut a = Accumulator::default();
    a.refresh(board);
    a.evaluate(board)
}

// ---- opposite-coloured bishop endings: AggroChess 4.6.1's second net, unchanged ----

pub static OCB_NET_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Is this an ending the second net is for?
#[inline]
pub fn is_ocb(board: &Board) -> bool {
    OCB_NET_ON.load(std::sync::atomic::Ordering::Relaxed) && crate::eval::ocb_scale(board).is_some() && crate::eval::buried_bishop(board)
}

/// The second net's verdict (side to move's view).
pub fn evaluate_ocb(board: &Board) -> i32 {
    ocb::evaluate(board)
}

/// AggroChess 4.6.1's net for opposite-coloured bishop endings in which a bishop is buried behind its own pawns and
/// cannot move: the game is a pawn ending in all but name, one spare pawn tempo can decide it (Salai's 1.f4!!), and the
/// main net, which counts the bishop, is far off. 4.6.1's main net trained further on such endings, in 4.6.1's format
/// ("AGNN": 768 -> 256, no buckets) and with its output scale (67%). These endings have few pieces and the search keeps
/// no accumulators for them: every evaluation is worked out from scratch, exactly as 4.6.1 did.
mod ocb {
    use super::{screlu_dot_n, OUT_BUCKETS, QA, QB, SCALE};
    use cozy_chess::{Board, Color, Piece};
    use std::sync::OnceLock;

    const H: usize = 256;
    const INPUTS: usize = 768;
    const OUT_SCALE: i64 = 67;

    #[repr(C, align(64))]
    struct Aligned<const N: usize>([u8; N]);
    static OCB_DATA: Aligned<{ include_bytes!("../aggro-ocb.nnue").len() }> = Aligned(*include_bytes!("../aggro-ocb.nnue"));

    struct Net {
        ft_w: Vec<i16>,
        ft_b: Vec<i16>,
        out_w: Vec<i16>,
        out_b: Vec<i32>,
    }
    static NET: OnceLock<Net> = OnceLock::new();

    fn parse(v: &[u8]) -> Net {
        assert_eq!(&v[0..4], b"AGNN", "bad network file");
        assert_eq!(u32::from_le_bytes(v[4..8].try_into().unwrap()) as usize, H, "network has a different hidden size");
        let mut off = 8;
        let mut rd = |n: usize| -> Vec<i16> {
            let r = v[off..off + 2 * n].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
            off += 2 * n;
            r
        };
        let ft_w = rd(INPUTS * H);
        let ft_b = rd(H);
        let out_w = rd(OUT_BUCKETS * 2 * H);
        let out_b = (0..OUT_BUCKETS).map(|i| i32::from_le_bytes(v[off + 4 * i..off + 4 * i + 4].try_into().unwrap())).collect();
        Net { ft_w, ft_b, out_w, out_b }
    }

    fn net() -> &'static Net {
        NET.get_or_init(|| match std::env::var("AGGRO_OCBNET") {
            Ok(f) => parse(&std::fs::read(f).expect("AGGRO_OCBNET file")),
            Err(_) => parse(&OCB_DATA.0),
        })
    }

    pub(super) fn evaluate(board: &Board) -> i32 {
        let n = net();
        let mut v = [[0i16; H]; 2];
        for (persp, acc) in v.iter_mut().enumerate() {
            acc.copy_from_slice(&n.ft_b);
            for color in [Color::White, Color::Black] {
                for piece in Piece::ALL {
                    for sq in board.colored_pieces(color, piece) {
                        let s = if persp == 0 { sq as usize } else { sq as usize ^ 56 };
                        let f = (if color as usize == persp { 0 } else { 384 }) + piece as usize * 64 + s;
                        for (a, w) in acc.iter_mut().zip(&n.ft_w[f * H..f * H + H]) {
                            *a = a.wrapping_add(*w);
                        }
                    }
                }
            }
        }
        let stm = board.side_to_move() as usize;
        let count = board.occupied().len() as usize;
        let bucket = ((count.max(2) - 2) / 4).min(OUT_BUCKETS - 1);
        let ow = &n.out_w[bucket * 2 * H..(bucket + 1) * 2 * H];
        let sum = screlu_dot_n(&v[stm], &ow[..H]) + screlu_dot_n(&v[1 - stm], &ow[H..]);
        let y = sum / QA as i64 + n.out_b[bucket] as i64;
        (y * SCALE as i64 * OUT_SCALE / (100 * (QA * QB) as i64)) as i32
    }
}
