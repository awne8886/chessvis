//! `convert <out.bin> [--valid <valid.bin> <n>] <in.bin>...`: AggroChess datagen records -> bulletformat ChessBoard
//! (32 bytes each), shuffled; with --valid the first n shuffled positions go to valid.bin instead (a validation set).
//!
//! bullet's DirectSequentialDataLoader reads the file in order, and datagen writes the positions of each game one
//! after the other, so the output is shuffled (Fisher-Yates, a fixed xorshift seed: the same inputs give the same file).
//!
//! AggroChess record (engine-src: upstream src/datagen.rs): occupancy u64 | 16 bytes of 4-bit pieces (colour << 3 |
//! piece, White = 0, pawn..king = 0..5) in occupancy order | score i16 (White's view) | result u8 (0 = Black won,
//! 1 = draw, 2 = White won) | side to move u8 (0 = White) | 4 bytes unused.
use bulletformat::ChessBoard;
use std::io::{BufReader, Read, Write};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    assert!(args.len() >= 2, "usage: convert <out.bin> [--valid <valid.bin> <n>] <in.bin>...");
    let mut valid: Option<(String, usize)> = None;
    if args[1] == "--valid" {
        valid = Some((args[2].clone(), args[3].parse().expect("n")));
        args.drain(1..4);
    }
    let mut all: Vec<[u8; 32]> = Vec::new();
    let (mut n, mut bad) = (0u64, 0u64);
    for path in &args[1..] {
        let mut r = BufReader::new(std::fs::File::open(path).expect("input file"));
        let mut rec = [0u8; 32];
        while r.read_exact(&mut rec).is_ok() {
            let occ = u64::from_le_bytes(rec[0..8].try_into().unwrap());
            let mut bbs = [0u64; 8];
            let (mut it, mut i) = (occ, 0usize);
            while it != 0 {
                let s = it.trailing_zeros();
                it &= it - 1;
                let nib = (rec[8 + i / 2] >> (4 * (i % 2))) & 15;
                bbs[usize::from(nib >> 3)] |= 1 << s;
                bbs[2 + usize::from(nib & 7)] |= 1 << s;
                i += 1;
            }
            let score = i16::from_le_bytes([rec[24], rec[25]]);
            let result = f32::from(rec[26]) / 2.0;
            let stm = usize::from(rec[27]);
            match ChessBoard::from_raw(bbs, stm, score, result) {
                Ok(b) => {
                    // SAFETY: ChessBoard is a plain 32-byte repr(C) record
                    let bytes: [u8; 32] = unsafe { std::mem::transmute(b) };
                    all.push(bytes);
                    n += 1;
                }
                Err(_) => bad += 1,
            }
        }
    }
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    for i in (1..all.len()).rev() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        all.swap(i, (x % (i as u64 + 1)) as usize);
    }
    let mut from = 0;
    if let Some((path, k)) = &valid {
        let mut v = std::io::BufWriter::new(std::fs::File::create(path).expect("valid file"));
        for r in &all[..*k] {
            v.write_all(r).unwrap();
        }
        v.flush().unwrap();
        from = *k;
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(&args[0]).expect("output file"));
    for r in &all[from..] {
        out.write_all(r).unwrap();
    }
    out.flush().unwrap();
    eprintln!("{n} positions written (shuffled), {bad} skipped");
}
