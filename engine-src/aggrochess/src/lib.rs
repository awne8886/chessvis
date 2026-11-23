//! AggroChess 4.6.1 for the web (WebAssembly, `wasm32-unknown-unknown`), as used by ChessVision.
//!
//! The JavaScript side (`engine/aggro-worker.js`) writes UTF-8 text into the I/O buffer (`io_ptr`, `io_size`) and
//! passes its length; functions that answer with text write it into the same buffer and return its length.
//!
//! Exports:
//!   set_position(len) -> 1/0   "<fen>|<uci moves>" or just "<uci moves>" from the standard start position
//!   think(ms), think_clock(soft, hard), think_depth(depth, ms) -> len
//!                              "<uci> <san> <score> <depth> <sacrifice 0|1> <swindle 0|1>", "<uci> <san> book 0 0 0"
//!                              or "none"; score is centipawns for the side to move, or "mate<n>" / "mate-<n>"
//!   analyze(ms) -> len         neutral analysis (personality off): "cp|mate <n> <uci> <san> <depth>", White's view
//!   legal_moves(), fen(), ponder_move() -> len; side_to_move(), in_check(), game_status() -> i32
//!   move_see(len), is_book_move(len) -> i32 for one UCI move; clear_hash(); set_tt_mb(mb) -> mb
//!
//! Reconstructed for ChessVision 2.0.2: the original web package's `lib.rs` was not available, so this file was
//! rebuilt from the shipped binaries' interface (exports, imports, the wasm name section and their behaviour) on top of
//! the unchanged AggroChess 4.6.1 sources. It reproduces the shipped engine exactly (see ../README.md for the checks).

/// Lines the search prints (`info depth ...`); the latest one is kept for the depth in the answers.
macro_rules! out {
    ($($arg:tt)*) => { $crate::record_info(&format!($($arg)*)) };
}

pub mod book;
pub mod eval;
pub mod matesearch;
pub mod nnue;
pub mod search;
pub mod web_clock;

use book::Book;
use cozy_chess::util::{display_san_move, display_uci_move, parse_uci_move};
use cozy_chess::{Board, Color, Move, Piece, Square};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const IO_SIZE: usize = 65536;
static mut IO: [u8; IO_SIZE] = [0; IO_SIZE];

/// The latest `info depth` line of the search.
static LAST_INFO: Mutex<String> = Mutex::new(String::new());

pub(crate) fn record_info(s: &str) {
    if s.starts_with("info depth") {
        *LAST_INFO.lock().unwrap() = s.to_string();
    }
}

#[no_mangle]
pub extern "C" fn io_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(IO) as *mut u8
}

#[no_mangle]
pub extern "C" fn io_size() -> u32 {
    IO_SIZE as u32
}

fn read_input(len: u32) -> String {
    let len = (len as usize).min(IO_SIZE);
    // SAFETY: single-threaded; the buffer is only touched by these exports, one call at a time
    let bytes = unsafe { core::slice::from_raw_parts(core::ptr::addr_of!(IO) as *const u8, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

fn write_output(s: &str) -> u32 {
    let b = s.as_bytes();
    let n = b.len().min(IO_SIZE);
    // SAFETY: as in read_input
    unsafe { core::slice::from_raw_parts_mut(core::ptr::addr_of_mut!(IO) as *mut u8, n).copy_from_slice(&b[..n]) };
    n as u32
}

struct Game {
    board: Board,
    /// position hashes from the start of the game up to and including the current position
    history: Vec<u64>,
    book: Book,
    /// plies in the previous set_position (a shorter game = a new game: the remembered score is reset)
    prev_plies: usize,
}

static GAME: Mutex<Option<Game>> = Mutex::new(None);

fn with_game<R>(f: impl FnOnce(&mut Game) -> R) -> R {
    let mut lock = GAME.lock().unwrap();
    let g = lock.get_or_insert_with(|| {
        search::TT_SIZE_MB.store(32, Ordering::Relaxed);
        let board = Board::default();
        Game { history: vec![board.hash()], board, book: Book { book: None }, prev_plies: 0 }
    });
    f(g)
}

fn legal_moves_of(board: &Board) -> Vec<Move> {
    let mut v = Vec::new();
    board.generate_moves(|mvs| {
        v.extend(mvs);
        false
    });
    v
}

/// The depth of the latest `info depth` line ("0" when there is none).
fn last_depth() -> String {
    let info = LAST_INFO.lock().unwrap();
    let t: Vec<&str> = info.split_whitespace().collect();
    match t.iter().position(|&w| w == "depth") {
        Some(i) if i + 1 < t.len() => t[i + 1].to_string(),
        _ => "0".to_string(),
    }
}

// ---- position ----

/// Material from White's point of view (pawn 100, knight 320, bishop 330, rook 500, queen 900).
fn sac_material(board: &Board) -> i32 {
    const VAL: [i32; 6] = [100, 320, 330, 500, 900, 0];
    let mut s = 0;
    for p in Piece::ALL {
        s += VAL[p as usize] * (board.colored_pieces(Color::White, p).len() as i32 - board.colored_pieces(Color::Black, p).len() as i32);
    }
    s
}

/// Is move `k` a sacrifice by `sign`'s side? (the rule of AggroChess's uci.rs)
fn is_sacrifice(mat_hist: &[i32], caps: &[Option<Square>], k: usize, sign: i32) -> bool {
    if k + 2 >= mat_hist.len() {
        return false;
    }
    let before = mat_hist[k] * sign;
    if mat_hist[k + 2] * sign > before - 150 {
        return false;
    }
    let traded = k + 3 < mat_hist.len() && caps[k + 1].is_some() && caps[k + 2] == caps[k + 1] && mat_hist[k + 3] * sign > before - 150;
    !traded
}

/// Sacrifices per side, and for each side the ply index of its latest sacrifice (-1: none).
fn count_sacrifices_ex(mat_hist: &[i32], movers: &[Color], caps: &[Option<Square>]) -> ([i32; 2], [i64; 2]) {
    let mut sacs = [0; 2];
    let mut last = [-1i64; 2];
    for side in [Color::White, Color::Black] {
        let sign = if side == Color::White { 1 } else { -1 };
        let mut k = 0;
        while k < movers.len() {
            if movers[k] == side && is_sacrifice(mat_hist, caps, k, sign) {
                sacs[side as usize] += 1;
                last[side as usize] = k as i64;
                if k + 2 < movers.len() && is_sacrifice(mat_hist, caps, k + 2, sign) {
                    last[side as usize] = (k + 2) as i64;
                }
                k += 4;
                continue;
            }
            k += 1;
        }
    }
    (sacs, last)
}

/// "<fen>|<uci moves>" or "<uci moves>" (from the standard start). Returns 1, or 0 when the FEN or a move is bad: a bad
/// FEN gives the standard start position, and the moves before the first bad one are kept (as AggroChess's `position`).
#[no_mangle]
pub extern "C" fn set_position(len: u32) -> i32 {
    let input = read_input(len);
    let input = input.trim();
    with_game(|g| {
        let mut ok = 1;
        let (fen, moves) = match input.split_once('|') {
            Some((f, m)) => (Some(f.trim()), m),
            None => (None, input),
        };
        let mut board = match fen {
            Some(f) if !f.is_empty() => match Board::from_fen(f, false) {
                Ok(b) => b,
                Err(_) => {
                    ok = 0;
                    Board::default()
                }
            },
            _ => Board::default(),
        };
        let mut history = vec![board.hash()];
        let mut mat_hist = vec![sac_material(&board)];
        let mut movers = Vec::new();
        let mut caps: Vec<Option<Square>> = Vec::new();
        let moves = if ok == 1 { moves } else { "" };
        for tok in moves.split_whitespace() {
            match parse_uci_move(&board, tok) {
                Ok(mv) if board.is_legal(mv) => {
                    movers.push(board.side_to_move());
                    let takes = board.color_on(mv.to) == Some(!board.side_to_move())
                        || (board.piece_on(mv.from) == Some(Piece::Pawn) && mv.from.file() != mv.to.file());
                    caps.push(if takes { Some(mv.to) } else { None });
                    board.play_unchecked(mv);
                    history.push(board.hash());
                    mat_hist.push(sac_material(&board));
                }
                _ => {
                    ok = 0;
                    break;
                }
            }
        }
        let (sacs, last_sac) = count_sacrifices_ex(&mat_hist, &movers, &caps);
        search::GAME_SACS[0].store(sacs[0], Ordering::Relaxed);
        search::GAME_SACS[1].store(sacs[1], Ordering::Relaxed);
        for side in 0..2 {
            let ago = if last_sac[side] < 0 { 1000 } else { ((movers.len() as i64 - last_sac[side]) + 1) / 2 };
            search::LAST_SAC_AGO[side].store(ago as i32, Ordering::Relaxed);
        }
        if movers.len() < g.prev_plies || movers.len() < 2 {
            search::LAST_SCORE.store(0, Ordering::Relaxed);
            search::LAST_OBJ.store(0, Ordering::Relaxed);
        }
        g.prev_plies = movers.len();
        g.board = board;
        g.history = history;
        ok
    })
}

#[no_mangle]
pub extern "C" fn fen() -> u32 {
    let s = with_game(|g| format!("{}", g.board));
    write_output(&s)
}

/// 0 = White, 1 = Black.
#[no_mangle]
pub extern "C" fn side_to_move() -> i32 {
    with_game(|g| g.board.side_to_move() as i32)
}

#[no_mangle]
pub extern "C" fn in_check() -> i32 {
    with_game(|g| !g.board.checkers().is_empty() as i32)
}

/// 0 = playing on, 1 = checkmate, 2 = stalemate, 3 = fifty-move rule, 4 = insufficient material, 5 = threefold repetition.
#[no_mangle]
pub extern "C" fn game_status() -> i32 {
    with_game(|g| {
        if legal_moves_of(&g.board).is_empty() {
            return if g.board.checkers().is_empty() { 2 } else { 1 };
        }
        if g.board.halfmove_clock() >= 100 {
            return 3;
        }
        if eval::is_insufficient_material(&g.board) {
            return 4;
        }
        let h = g.board.hash();
        if g.history.iter().filter(|&&x| x == h).count() >= 3 {
            return 5;
        }
        0
    })
}

/// "<uci>:<san> <uci>:<san> ..."
#[no_mangle]
pub extern "C" fn legal_moves() -> u32 {
    let s = with_game(|g| {
        legal_moves_of(&g.board)
            .iter()
            .map(|&m| format!("{}:{}", display_uci_move(&g.board, m), display_san_move(&g.board, m)))
            .collect::<Vec<_>>()
            .join(" ")
    });
    write_output(&s)
}

// ---- search ----

fn score_text(score: i32) -> String {
    if score >= search::MATE_BOUND {
        format!("mate{}", (search::MATE - score + 1) / 2)
    } else if score <= -search::MATE_BOUND {
        format!("mate-{}", (score + search::MATE + 1) / 2)
    } else {
        score.to_string()
    }
}

/// The shortest search `think`, `think_clock` and `think_depth` run (ms).
const THINK_FLOOR_MS: u32 = 30;
/// The shortest search `analyze` runs (ms).
const ANALYZE_FLOOR_MS: u32 = 20;

fn think_limits(soft_ms: u32, hard_ms: u32) -> u32 {
    think_limits_depth(soft_ms, hard_ms, None)
}

fn think_limits_depth(soft_ms: u32, hard_ms: u32, depth: Option<i32>) -> u32 {
    think_limits_floor(soft_ms, hard_ms, depth, THINK_FLOOR_MS)
}

fn think_limits_floor(soft_ms: u32, hard_ms: u32, depth: Option<i32>, floor_ms: u32) -> u32 {
    let s = with_game(|g| {
        let board = g.board.clone();
        if legal_moves_of(&board).is_empty() {
            return "none".to_string();
        }
        if let Some(bm) = g.book.get_move(&board) {
            if let Ok(mv) = parse_uci_move(&board, &bm) {
                if board.is_legal(mv) {
                    return format!("{} {} book 0 0 0", display_uci_move(&board, mv), display_san_move(&board, mv));
                }
            }
        }
        LAST_INFO.lock().unwrap().clear();
        let soft = Duration::from_millis(soft_ms.max(floor_ms) as u64);
        let hard = Duration::from_millis(hard_ms.max(floor_ms) as u64);
        let limits = search::Limits { depth, soft: Some(soft), hard: Some(hard), nodes: None, asked: None };
        let stop = Arc::new(AtomicBool::new(false));
        let (best, score) = search::search_position(&board, &g.history, limits, stop, true);
        let depth = last_depth();
        match best {
            None => "none".to_string(),
            Some(mv) => {
                let sc = score_text(score);
                let sacrifice = !search::see_ge(&board, mv, -90);
                let swindle = search::LAST_SWINDLE.load(Ordering::Relaxed);
                format!(
                    "{} {} {} {} {} {}",
                    display_uci_move(&board, mv),
                    display_san_move(&board, mv),
                    sc,
                    depth,
                    sacrifice as u8,
                    swindle as u8
                )
            }
        }
    });
    write_output(&s)
}

/// Search the current position for `ms` milliseconds (at least 30).
#[no_mangle]
pub extern "C" fn think(ms: u32) -> u32 {
    think_limits(ms, ms)
}

/// Search with a soft and a hard limit in milliseconds (from the game clock).
#[no_mangle]
pub extern "C" fn think_clock(soft_ms: u32, hard_ms: u32) -> u32 {
    think_limits(soft_ms, hard_ms.max(soft_ms))
}

/// ChessVision 2.0.2: `think_clock` with its own time floor (1-30 ms instead of 30), for short searches the page wants
/// to stay short.
#[no_mangle]
pub extern "C" fn think_floor(soft_ms: u32, hard_ms: u32, floor_ms: u32) -> u32 {
    think_limits_floor(soft_ms, hard_ms.max(soft_ms), None, floor_ms.clamp(1, THINK_FLOOR_MS))
}

/// One step of a search that can be cancelled between steps (for pondering): search to `depth` plies, at most `hard_ms`
/// milliseconds, and answer like `think`. The hash table is kept between calls, so calling it with depth 1, 2, 3 ...
/// resumes where the last call ended. The page decides when to stop; nothing here runs between two calls.
#[no_mangle]
pub extern "C" fn think_depth(depth: u32, hard_ms: u32) -> u32 {
    think_limits_depth(hard_ms, hard_ms, Some((depth as i32).clamp(1, 64)))
}

/// Set the size of the hash table in MB (1-256, default 32). Takes effect at the next search (the table is then re-made
/// empty). Returns the size in use. Call it before the first search.
#[no_mangle]
pub extern "C" fn set_tt_mb(mb: u32) -> u32 {
    with_game(|_| ());
    let mb = (mb as usize).clamp(1, 256);
    search::TT_SIZE_MB.store(mb, Ordering::Relaxed);
    mb as u32
}

/// Neutral analysis of the current position for the game review: the Tal personality
/// (aggression, sacrifice appetite, contempt) is switched off so the evaluation is objective, and so are the
/// swindles and the "finish beautifully" mates (search.rs: "Analysis turns it off").
/// Output: "cp <n> <best-uci> <best-san> <depth>" or "mate <n> <best-uci> <best-san> <depth>",
/// from White's point of view, or "none" when there is no legal move.
#[no_mangle]
pub extern "C" fn analyze(ms: u32) -> u32 {
    analyze_ms(ms.max(ANALYZE_FLOOR_MS))
}

/// ChessVision 2.0.2: `analyze` with its own time floor (1-20 ms instead of 20). The ponder job ranks the opponent's
/// moves with one very short analysis after each (5-12 ms); with the 20 ms floor every one of them took 20 ms.
#[no_mangle]
pub extern "C" fn analyze_floor(ms: u32, floor_ms: u32) -> u32 {
    analyze_ms(ms.max(floor_ms.clamp(1, ANALYZE_FLOOR_MS)))
}

fn analyze_ms(ms: u32) -> u32 {
    let s = with_game(|g| {
        let board = g.board.clone();
        if legal_moves_of(&board).is_empty() {
            return "none".to_string();
        }
        let aggression = eval::AGGRESSION.load(Ordering::Relaxed);
        eval::AGGRESSION.store(100, Ordering::Relaxed);
        let sac_bonus = search::SACRIFICE_BONUS.load(Ordering::Relaxed);
        search::SACRIFICE_BONUS.store(0, Ordering::Relaxed);
        let contempt = search::CONTEMPT.load(Ordering::Relaxed);
        search::CONTEMPT.store(0, Ordering::Relaxed);
        let beautiful = search::BEAUTIFUL_MATES.load(Ordering::Relaxed);
        search::BEAUTIFUL_MATES.store(false, Ordering::Relaxed);
        let swindle = search::SWINDLE.load(Ordering::Relaxed);
        search::SWINDLE.store(false, Ordering::Relaxed);
        let last_score = search::LAST_SCORE.load(Ordering::Relaxed);
        let last_obj = search::LAST_OBJ.load(Ordering::Relaxed);
        LAST_INFO.lock().unwrap().clear();
        let t = Duration::from_millis(ms as u64);
        let limits = search::Limits { depth: None, soft: Some(t), hard: Some(t), nodes: None, asked: None };
        let stop = Arc::new(AtomicBool::new(false));
        let (best, score) = search::search_position(&board, &g.history, limits, stop, true);
        eval::AGGRESSION.store(aggression, Ordering::Relaxed);
        search::SACRIFICE_BONUS.store(sac_bonus, Ordering::Relaxed);
        search::CONTEMPT.store(contempt, Ordering::Relaxed);
        search::BEAUTIFUL_MATES.store(beautiful, Ordering::Relaxed);
        search::SWINDLE.store(swindle, Ordering::Relaxed);
        search::LAST_SCORE.store(last_score, Ordering::Relaxed);
        search::LAST_OBJ.store(last_obj, Ordering::Relaxed);
        let depth = last_depth();
        let Some(mv) = best else { return "none".to_string() };
        let sign = if board.side_to_move() == Color::White { 1 } else { -1 };
        let kind_value = if score.abs() < search::MATE_BOUND {
            format!("cp {}", sign * score)
        } else {
            let n = (search::MATE - score.abs() + 1) / 2 * sign;
            format!("mate {}", if score > 0 { n } else { -n })
        };
        format!("{} {} {} {}", kind_value, display_uci_move(&board, mv), display_san_move(&board, mv), depth)
    });
    write_output(&s)
}

/// The move the hash table holds for the current position (after a search that went through it), or "none".
#[no_mangle]
pub extern "C" fn ponder_move() -> u32 {
    let s = with_game(|g| {
        let tt = search::get_global_tt(search::TT_SIZE_MB.load(Ordering::Relaxed));
        match tt.probe(g.board.hash()).and_then(|d| d.mv) {
            Some(mv) if g.board.is_legal(mv) => format!("{}", display_uci_move(&g.board, mv)),
            _ => "none".to_string(),
        }
    });
    write_output(&s)
}

/// Static exchange value (centipawns) of one UCI move in the current position; 0 when it is not legal.
#[no_mangle]
pub extern "C" fn move_see(len: u32) -> i32 {
    let input = read_input(len);
    with_game(|g| match parse_uci_move(&g.board, input.trim()) {
        Ok(mv) if g.board.is_legal(mv) => search::see(&g.board, mv),
        _ => 0,
    })
}

/// 1 when the UCI move is a theory move of the curated book in the current position (either side), else 0.
#[no_mangle]
pub extern "C" fn is_book_move(len: u32) -> i32 {
    let input = read_input(len);
    with_game(|g| g.book.is_curated_move(&g.board, input.trim()) as i32)
}

/// Empty the hash table (new game).
#[no_mangle]
pub extern "C" fn clear_hash() {
    search::clear_global_tt();
}

/// Benchmarks and tests only (ChessVision 2.0.2): the latest `info depth ...` line of the last search, "" when there is
/// none. A book move does not search, so the line is then still the one of the search before.
#[no_mangle]
pub extern "C" fn last_info() -> u32 {
    let s = LAST_INFO.lock().unwrap().clone();
    write_output(&s)
}
