//! `pack <quantised.bin> <out.nnue>`: bullet's quantised network -> the AggroChess 2.0.3 network file.
//!
//! bullet writes l0w (i16, [bucket][768][512]), l0b (i16, [512]), l1w (i16, transposed: [output bucket][1024]) and l1b
//! (i16, [8]), each padded to a multiple of 64 bytes. The engine file ("AGNB"):
//!   "AGNB" | u32 version 1 | u32 hidden | u32 input buckets | 32 x u8 bucket layout | u32 output buckets |
//!   u32 number of feature weights | feature weights, packed (below) | ft bias i16 x hidden | out weights i16 |
//!   out bias i32 x output buckets
//! Packed feature weights: one byte (i8) per weight; a weight outside -127..=127 is the byte -128 followed by the i16
//! (little endian). Lossless; nearly every weight is small, so the file is about half the size of plain i16.
use std::io::Write;

#[path = "train.rs"]
#[allow(dead_code)]
mod train;

/// `pack eval <quantised.bin> <fens.txt>`: the raw output (side to move's view, before the engine's OUT_SCALE) of
/// each position, computed independently of the engine from bullet's own feature mapping (ChessBucketsMirrored); the
/// engine's `nn_eval_raw` must give the same numbers (tests/engine-signature.test.js).
fn eval_mode(a: &[String]) {
    use bullet_lib::game::inputs::{ChessBucketsMirrored, SparseInputType};
    let raw = std::fs::read(&a[0]).expect("quantised.bin");
    let nb = *train::BUCKET_LAYOUT.iter().max().unwrap() + 1;
    let hl = train::HL;
    let rd = |off: usize, n: usize| -> Vec<i32> { raw[off..off + 2 * n].chunks_exact(2).map(|c| i32::from(i16::from_le_bytes([c[0], c[1]]))).collect() };
    let pad = |n: usize| (2 * n).div_ceil(64) * 64;
    let (o0, o1) = (0, pad(nb * 768 * hl));
    let (o2, o3) = (o1 + pad(hl), o1 + pad(hl) + pad(8 * 2 * hl));
    let (ft_w, ft_b, out_w, out_b) = (rd(o0, nb * 768 * hl), rd(o1, hl), rd(o2, 8 * 2 * hl), rd(o3, 8));
    let inputs = ChessBucketsMirrored::new(train::BUCKET_LAYOUT);
    for line in std::fs::read_to_string(&a[1]).unwrap().lines().filter(|l| !l.trim().is_empty()) {
        let fen = line.trim();
        let board: bulletformat::ChessBoard = format!("{fen} | 0 | 0.5").parse().expect("fen");
        let (mut stm, mut ntm) = (ft_b.clone(), ft_b.clone());
        inputs.map_features(&board, |s, n| {
            for i in 0..hl {
                stm[i] += ft_w[s * hl + i];
                ntm[i] += ft_w[n * hl + i];
            }
        });
        let bucket = ((board.occ().count_ones() as usize).max(2) - 2) / 4;
        let ow = &out_w[bucket * 2 * hl..(bucket + 1) * 2 * hl];
        let mut sum: i64 = 0;
        for i in 0..hl {
            let (vs, vn) = (i64::from(stm[i].clamp(0, 255)), i64::from(ntm[i].clamp(0, 255)));
            sum += vs * vs * i64::from(ow[i]) + vn * vn * i64::from(ow[hl + i]);
        }
        let y = sum / 255 + i64::from(out_b[bucket]);
        println!("{}", y * 400 / (255 * 64));
    }
}

/// Raw outputs (side to move's view) of the new net (quantised.bin) and of AggroChess 4.6.1's net ("AGNN") for one
/// bulletformat position.
struct Nets {
    new: [Vec<i32>; 4],
    old: [Vec<i32>; 4],
}

fn load_nets(quantised: &str, old_net: &str) -> Nets {
    let raw = std::fs::read(quantised).expect("quantised.bin");
    let nb = *train::BUCKET_LAYOUT.iter().max().unwrap() + 1;
    let hl = train::HL;
    let rd = |v: &[u8], off: usize, n: usize| -> Vec<i32> { v[off..off + 2 * n].chunks_exact(2).map(|c| i32::from(i16::from_le_bytes([c[0], c[1]]))).collect() };
    let pad = |n: usize| (2 * n).div_ceil(64) * 64;
    let (o1, o2) = (pad(nb * 768 * hl), pad(nb * 768 * hl) + pad(hl));
    let o3 = o2 + pad(16 * hl);
    let new = [rd(&raw, 0, nb * 768 * hl), rd(&raw, o1, hl), rd(&raw, o2, 16 * hl), rd(&raw, o3, 8)];
    if old_net.is_empty() {
        return Nets { new, old: [vec![], vec![], vec![], vec![]] };
    }
    let ov = std::fs::read(old_net).expect("old net");
    assert_eq!(&ov[0..4], b"AGNN");
    let oh = 256;
    let (p1, p2) = (8 + 2 * 768 * oh, 8 + 2 * 768 * oh + 2 * oh);
    let p3 = p2 + 2 * 16 * oh;
    let ob: Vec<i32> = (0..8).map(|i| i32::from_le_bytes(ov[p3 + 4 * i..p3 + 4 * i + 4].try_into().unwrap())).collect();
    let old = [rd(&ov, 8, 768 * oh), rd(&ov, p1, oh), rd(&ov, p2, 16 * oh), ob];
    Nets { new, old }
}

fn raw_eval(net: &[Vec<i32>; 4], hl: usize, board: &bulletformat::ChessBoard, feats: &[(usize, usize)]) -> i64 {
    let (mut stm, mut ntm) = (net[1].clone(), net[1].clone());
    for &(s, n) in feats {
        for i in 0..hl {
            stm[i] += net[0][s * hl + i];
            ntm[i] += net[0][n * hl + i];
        }
    }
    let bucket = ((board.occ().count_ones() as usize).max(2) - 2) / 4;
    let ow = &net[2][bucket * 2 * hl..(bucket + 1) * 2 * hl];
    let mut sum: i64 = 0;
    for i in 0..hl {
        let (vs, vn) = (i64::from(stm[i].clamp(0, 255)), i64::from(ntm[i].clamp(0, 255)));
        sum += vs * vs * i64::from(ow[i]) + vn * vn * i64::from(ow[hl + i]);
    }
    (sum / 255 + i64::from(net[3][bucket])) * 400 / (255 * 64)
}

/// `pack calibrate <quantised.bin> <aggro.nnue of 4.6.1> <data.bf> [positions] [old-scale %]`: the engine's OUT_SCALE
/// (percent) for the new net, so that its scaled evaluations match 4.6.1's (its raw net output x 67%) in the least-
/// squares sense over positions of the data file where 4.6.1's scaled evaluation is within +-1000; also prints how well
/// the two nets agree (correlation) and the new net's raw scale against the data's search scores.
fn calibrate(a: &[String]) {
    use bullet_lib::game::inputs::{Chess768, ChessBucketsMirrored, SparseInputType};
    let nets = load_nets(&a[0], &a[1]);
    let data = std::fs::read(&a[2]).expect("data");
    let want: usize = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(20_000);
    let old_scale: f64 = a.get(4).map(|s| s.parse().unwrap()).unwrap_or(67.0);
    let n_all = data.len() / 32;
    let step = (n_all / want).max(1);
    let inputs = ChessBucketsMirrored::new(train::BUCKET_LAYOUT);
    let (mut sxy, mut sxx, mut syy, mut sx, mut sy, mut n) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    let (mut s_score_new, mut s_new_new) = (0f64, 0f64);
    let (mut so, mut ss, mut soo, mut sss, mut sos) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for rec in data.chunks_exact(32).step_by(step) {
        // SAFETY: a bulletformat record is a plain 32-byte repr(C) ChessBoard
        let board: bulletformat::ChessBoard = unsafe { std::mem::transmute::<[u8; 32], _>(rec.try_into().unwrap()) };
        let mut f_new = Vec::with_capacity(32);
        inputs.map_features(&board, |s, n| f_new.push((s, n)));
        let mut f_old = Vec::with_capacity(32);
        Chess768.map_features(&board, |s, n| f_old.push((s, n)));
        let x = raw_eval(&nets.new, train::HL, &board, &f_new) as f64;
        let y = raw_eval(&nets.old, 256, &board, &f_old) as f64 * old_scale / 100.0;
        if y.abs() > 1000.0 {
            continue;
        }
        let score = f64::from(board.score);
        sxy += x * y;
        sxx += x * x;
        syy += y * y;
        sx += x;
        sy += y;
        n += 1.0;
        s_score_new += score * x;
        s_new_new += x * x;
        so += y;
        ss += score;
        soo += y * y;
        sss += score * score;
        sos += y * score;
    }
    let corr = (n * sxy - sx * sy) / ((n * sxx - sx * sx).sqrt() * (n * syy - sy * sy).sqrt());
    let corr_old = (n * sos - so * ss) / ((n * soo - so * so).sqrt() * (n * sss - ss * ss).sqrt());
    println!("positions {n}, OUT_SCALE {:.1} %, correlation new/old {:.3}, old/search score {:.3}, search score / new raw {:.3}", 100.0 * sxy / sxx, corr, corr_old, s_score_new / s_new_new);
}

/// `pack loss <quantised.bin> <valid.bf> [wdl]`: the training loss (sigmoid(output / 400) against
/// wdl x result + (1 - wdl) x sigmoid(score / 400), squared error) of the quantised network on held-out positions
/// (bullet's CPU backend does not compute a validation loss itself). With 4.6.1's aggro.nnue as a fourth argument, also
/// that network's loss on the same positions (its raw output, the unit it was trained in), for comparison.
fn loss(a: &[String]) {
    use bullet_lib::game::inputs::{Chess768, ChessBucketsMirrored, SparseInputType};
    let old_path = a.get(3).map(String::as_str).unwrap_or("");
    let nets = load_nets(&a[0], old_path);
    let data = std::fs::read(&a[1]).expect("valid.bf");
    let wdl: f64 = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(0.3);
    let inputs = ChessBucketsMirrored::new(train::BUCKET_LAYOUT);
    let sig = |x: f64| 1.0 / (1.0 + (-x / 400.0).exp());
    let (mut sum, mut sum_old, mut n) = (0f64, 0f64, 0f64);
    for rec in data.chunks_exact(32) {
        // SAFETY: a bulletformat record is a plain 32-byte repr(C) ChessBoard
        let board: bulletformat::ChessBoard = unsafe { std::mem::transmute::<[u8; 32], _>(rec.try_into().unwrap()) };
        let mut f = Vec::with_capacity(32);
        inputs.map_features(&board, |s, n| f.push((s, n)));
        let out = raw_eval(&nets.new, train::HL, &board, &f) as f64;
        let target = wdl * f64::from(board.result) / 2.0 + (1.0 - wdl) * sig(f64::from(board.score));
        sum += (sig(out) - target).powi(2);
        if !old_path.is_empty() {
            let mut fo = Vec::with_capacity(32);
            Chess768.map_features(&board, |s, n| fo.push((s, n)));
            sum_old += (sig(raw_eval(&nets.old, 256, &board, &fo) as f64) - target).powi(2);
        }
        n += 1.0;
    }
    if old_path.is_empty() {
        println!("positions {n}, loss {:.6}", sum / n);
    } else {
        println!("positions {n}, loss {:.6} (4.6.1's network: {:.6})", sum / n, sum_old / n);
    }
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.first().map(String::as_str) == Some("loss") {
        return loss(&a[1..]);
    }
    if a.first().map(String::as_str) == Some("eval") {
        return eval_mode(&a[1..]);
    }
    if a.first().map(String::as_str) == Some("calibrate") {
        return calibrate(&a[1..]);
    }
    assert!(a.len() == 2, "usage: pack <quantised.bin> <out.nnue> | pack eval <quantised.bin> <fens.txt>");
    let raw = std::fs::read(&a[0]).expect("quantised.bin");
    let nb = *train::BUCKET_LAYOUT.iter().max().unwrap() + 1;
    let (hl, ob) = (train::HL, 8usize);
    let mut off = 0usize;
    let mut take = |n: usize| -> Vec<i16> {
        let v: Vec<i16> = raw[off..off + 2 * n].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        off += (2 * n).div_ceil(64) * 64;
        v
    };
    let ft_w = take(nb * 768 * hl);
    let ft_b = take(hl);
    let out_w = take(ob * 2 * hl);
    let out_b = take(ob);
    assert!(off >= raw.len() && off - raw.len() < 64, "unexpected file size {} (read {off})", raw.len());

    let mut out = Vec::new();
    out.extend_from_slice(b"AGNB");
    for v in [1u32, hl as u32, nb as u32] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend(train::BUCKET_LAYOUT.iter().map(|&b| b as u8));
    out.extend_from_slice(&(ob as u32).to_le_bytes());
    out.extend_from_slice(&(ft_w.len() as u32).to_le_bytes());
    let mut escapes = 0usize;
    for &w in &ft_w {
        if (-127..=127).contains(&w) {
            out.push(w as i8 as u8);
        } else {
            out.push(0x80);
            out.extend_from_slice(&w.to_le_bytes());
            escapes += 1;
        }
    }
    for &w in ft_b.iter().chain(&out_w) {
        out.extend_from_slice(&w.to_le_bytes());
    }
    for &b in &out_b {
        out.extend_from_slice(&i32::from(b).to_le_bytes());
    }
    std::fs::File::create(&a[1]).unwrap().write_all(&out).unwrap();
    let max = ft_w.iter().map(|w| w.unsigned_abs()).max().unwrap_or(0);
    eprintln!("{} bytes ({} feature weights, {} escaped, max |w| {}), {} buckets x {} hidden", out.len(), ft_w.len(), escapes, max, nb, hl);
}
