// Token counting / truncation / chunking on tiktoken BPE encodings
// (cl100k_base = GPT-4/3.5 family, o200k_base = GPT-4o/o-series family).
//
// Encoders are PER-THREAD (thread_local, built lazily on first use on each
// rayon thread — never on the JS thread, so the event loop stays free).
// Sharing one CoreBPE process-wide looks safe (Send + Sync, and tiktoken-rs
// keeps 128 per-thread-slot regex clones for scratch isolation) but is a
// measured 2.2x-at-5-threads contention trap: fancy-regex 0.17 made the
// compiled program an Arc<Prog>, so ALL of tiktoken's slot "clones" share the
// same delegate regex-automata regexes and their ONE cache pool — every
// non-owner rayon thread then takes the pool's mutex `get_slow` path per
// regex call with a cold transient lazy-DFA cache (profiled: get_slow/
// put_value/pthread_mutex_trylock hot at 5 threads; countTokens t1/t5 only
// 2.2x at 4.9 CPU util). CoreBPE::clone would share the same Arc, so each
// thread builds its own from the vendored vocab. Cost per thread that touches
// an encoding: one vocab parse (tens of ms) and roughly 10-20MB resident —
// acceptable on a 10-core box, and only threads that run token kernels pay.
//
// Stage helper for the pipeline: `TruncateTokensCfg` + `compile_truncate_tokens`
// + `apply_truncate_tokens` (str -> str). countTokens has NO stage form (the
// pipeline has no numeric value kind) and chunkByTokens stays kernel-only (its
// natural stage semantics would be 1->many fan-out; the kernel keeps 1:1 arity
// by returning a JSON array string per item).

use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::CoreBPE;

// ---------------------------------------------------------------- encodings

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenEncoding {
    Cl100kBase,
    O200kBase,
}

fn parse_encoding(op: &str, name: &str) -> std::result::Result<TokenEncoding, String> {
    match name {
        "cl100k_base" => Ok(TokenEncoding::Cl100kBase),
        "o200k_base" => Ok(TokenEncoding::O200kBase),
        other => Err(format!(
            "{op}: unknown encoding '{other}': expected 'cl100k_base' or 'o200k_base'"
        )),
    }
}

/// One encoder per encoding PER THREAD (see the module comment for why
/// sharing contends). The `expect` can only fire if the crate's vendored
/// vocab assets are corrupt (a build-integrity failure — the same condition
/// tiktoken-rs's own singletons unwrap on).
fn with_bpe<R>(enc: TokenEncoding, f: impl FnOnce(&CoreBPE) -> R) -> R {
    with_bpe_and_lens(enc, |bpe, _| f(bpe))
}

/// Per-thread, per-encoding cache of each token's decoded byte length,
/// indexed by token id (`LEN_UNKNOWN` = not yet decoded). truncate/chunk need
/// per-token byte lengths, and `CoreBPE` only exposes them via
/// `decode_bytes(&[t])` — a HashMap lookup plus a fresh `Vec` per call
/// (profiled at ~11% of chunkByTokens single-thread time when done per token
/// per item). The cache decodes each distinct token once per thread; hits are
/// an array load. Lives beside the encoder so both share one thread_local.
const LEN_UNKNOWN: u16 = u16::MAX;

fn with_bpe_and_lens<R>(enc: TokenEncoding, f: impl FnOnce(&CoreBPE, &mut Vec<u16>) -> R) -> R {
    use std::cell::{OnceCell, RefCell};
    thread_local! {
        static CL100K: OnceCell<(CoreBPE, RefCell<Vec<u16>>)> = const { OnceCell::new() };
        static O200K: OnceCell<(CoreBPE, RefCell<Vec<u16>>)> = const { OnceCell::new() };
    }
    match enc {
        TokenEncoding::Cl100kBase => CL100K.with(|cell| {
            let (bpe, lens) = cell.get_or_init(|| {
                (
                    tiktoken_rs::cl100k_base().expect("vendored cl100k_base vocab"),
                    RefCell::new(Vec::new()),
                )
            });
            f(bpe, &mut lens.borrow_mut())
        }),
        TokenEncoding::O200kBase => O200K.with(|cell| {
            let (bpe, lens) = cell.get_or_init(|| {
                (
                    tiktoken_rs::o200k_base().expect("vendored o200k_base vocab"),
                    RefCell::new(Vec::new()),
                )
            });
            f(bpe, &mut lens.borrow_mut())
        }),
    }
}

/// Decoded byte length of one token, via the per-thread cache. The decode on
/// a cache miss can only fail for a token id absent from the vocab —
/// impossible for tokens produced by the paired encode; `op` names the kernel
/// in the error message.
fn token_byte_len(
    bpe: &CoreBPE,
    lens: &mut Vec<u16>,
    t: tiktoken_rs::Rank,
    op: &str,
) -> std::result::Result<usize, String> {
    let idx = t as usize;
    if idx >= lens.len() {
        lens.resize(idx + 1, LEN_UNKNOWN);
    }
    if lens[idx] != LEN_UNKNOWN {
        return Ok(lens[idx] as usize);
    }
    let n = bpe
        .decode_bytes(&[t])
        .map_err(|e| format!("{op}: {e}"))?
        .len();
    if n < LEN_UNKNOWN as usize {
        lens[idx] = n as u16;
    }
    Ok(n)
}

// ---------------------------------------------------------------- stage helpers

#[derive(Clone, Copy)]
pub(crate) enum Keep {
    Start,
    End,
}

/// Compiled once; shared read-only across rayon threads (all fields Copy, so
/// the struct is trivially Send + Sync). Deliberately stores the encoding TAG,
/// not a `&CoreBPE`: compile runs on the JS thread and must stay cheap — the
/// per-thread vocab build happens in `with_bpe()` at first apply, on a rayon
/// thread.
pub(crate) struct TruncateTokensCfg {
    enc: TokenEncoding,
    max_tokens: usize,
    keep: Keep,
}

/// Errors: "truncateTokens: {cause}" (unknown encoding, maxTokens < 1, keep
/// not 'start'/'end').
pub(crate) fn compile_truncate_tokens(
    encoding: &str,
    max_tokens: i64,
    keep: Option<&str>,
) -> std::result::Result<TruncateTokensCfg, String> {
    let enc = parse_encoding("truncateTokens", encoding)?;
    if max_tokens < 1 {
        return Err(format!(
            "truncateTokens: maxTokens must be >= 1, got {max_tokens}"
        ));
    }
    let keep = match keep.unwrap_or("start") {
        "start" => Keep::Start,
        "end" => Keep::End,
        other => {
            return Err(format!(
                "truncateTokens: keep must be 'start' or 'end', got '{other}'"
            ))
        }
    };
    Ok(TruncateTokensCfg {
        enc,
        max_tokens: max_tokens as usize,
        keep,
    })
}

/// Truncate to the first (keep 'start') or last (keep 'end') `max_tokens` BPE
/// tokens and decode. Within-budget inputs pass through byte-identical. A cut
/// that lands inside a multi-byte character drops that character's fragment,
/// so the result is always a valid prefix ('start') or suffix ('end') of the
/// input. Errors: "truncateTokens: {cause}" (decoder misses — practically
/// unreachable for tokens produced by the paired encode). Callers add the
/// "item {i}: " prefix.
pub(crate) fn apply_truncate_tokens(
    cfg: &TruncateTokensCfg,
    input: &str,
) -> std::result::Result<String, String> {
    with_bpe_and_lens(cfg.enc, |enc, lens| {
        let tokens = enc.encode_ordinary(input);
        if tokens.len() <= cfg.max_tokens {
            return Ok(input.to_string()); // within budget: pass through byte-identical
        }
        // The window's decode is a contiguous byte slice of the (valid UTF-8)
        // input — BPE decode inverts encode — so instead of decoding it, sum
        // the per-token byte lengths (thread-cached) and slice the input.
        // A cut inside a multi-byte character snaps to the char boundary
        // INSIDE the window, dropping the fragment (same result as decoding
        // the window and stripping the invalid edge).
        let window = match cfg.keep {
            Keep::Start => &tokens[..cfg.max_tokens],
            Keep::End => &tokens[tokens.len() - cfg.max_tokens..],
        };
        let mut window_bytes = 0usize;
        for &t in window {
            window_bytes += token_byte_len(enc, lens, t, "truncateTokens")?;
        }
        match cfg.keep {
            Keep::Start => {
                let mut end = window_bytes;
                while end > 0 && !input.is_char_boundary(end) {
                    end -= 1; // drop the incomplete trailing character
                }
                Ok(input[..end].to_string())
            }
            Keep::End => {
                let mut start = input.len() - window_bytes;
                while start < input.len() && !input.is_char_boundary(start) {
                    start += 1; // drop leading continuation bytes of a split character
                }
                Ok(input[start..].to_string())
            }
        }
    })
}

// ---------------------------------------------------------------- chunking core

/// Chunk into windows of `max_tokens` tokens advancing by `max_tokens -
/// overlap`, then slice the ORIGINAL string at the windows' byte ranges
/// (boundaries snapped DOWN to char boundaries, so with overlap 0 the chunks
/// tile the input exactly and their concatenation round-trips). Chunks that
/// snap to empty are dropped. Returns a JSON array string of chunk strings.
fn chunk_one(
    enc: &CoreBPE,
    lens: &mut Vec<u16>,
    input: &str,
    max_tokens: usize,
    overlap: usize,
) -> std::result::Result<String, String> {
    let tokens = enc.encode_ordinary(input);
    if tokens.is_empty() {
        return Ok("[]".to_string());
    }
    // Cumulative byte offset of every token boundary within `input` (BPE
    // decode is the exact inverse of encode, so offsets index the original).
    // Token byte lengths come from the per-thread cache — decoding each token
    // fresh here was ~11% of single-thread chunk time.
    let mut offsets = Vec::with_capacity(tokens.len() + 1);
    let mut acc = 0usize;
    offsets.push(acc);
    for &t in &tokens {
        acc += token_byte_len(enc, lens, t, "chunkByTokens")?;
        offsets.push(acc);
    }
    let snap = |mut i: usize| {
        while i > 0 && !input.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    let stride = max_tokens - overlap; // >= 1: caller validated overlap < maxTokens
    let mut chunks: Vec<&str> = Vec::new();
    let mut start = 0usize;
    loop {
        let end = (start + max_tokens).min(tokens.len());
        let (a, b) = (snap(offsets[start]), snap(offsets[end]));
        if a < b {
            chunks.push(&input[a..b]);
        }
        if end == tokens.len() {
            break;
        }
        start += stride;
    }
    serde_json::to_string(&chunks).map_err(|e| format!("chunkByTokens: {e}"))
}

// ---------------------------------------------------------------- batch kernels

/// countTokensBatch(items: string[], encoding: 'cl100k_base' | 'o200k_base'): Promise<number[]>
///
/// BPE token count per item. Uses ordinary encoding: special-token text like
/// "<|endoftext|>" counts as plain text. Unknown encodings throw synchronously
/// with status InvalidArg. Each rayon thread pays a one-time vocab build at
/// its first use of an encoding — the event loop never blocks.
#[napi(ts_return_type = "Promise<number[]>")]
pub fn count_tokens_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    #[napi(ts_arg_type = "'cl100k_base' | 'o200k_base'")] encoding: String,
) -> Result<Object<'env>> {
    let enc =
        parse_encoding("countTokens", &encoding).map_err(|e| Error::new(Status::InvalidArg, e))?;
    let (deferred, promise) = env.create_deferred::<Vec<u32>, _>()?;
    rayon::spawn(move || {
        let out: Vec<u32> = items
            .par_iter()
            .map(|s| with_bpe(enc, |bpe| bpe.encode_ordinary(s).len() as u32))
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// Config for truncateTokensBatch. `keep: 'start'` (default) keeps the first
/// `maxTokens` tokens, `'end'` the last.
#[napi(object)]
pub struct TruncateTokensConfig {
    #[napi(ts_type = "'cl100k_base' | 'o200k_base'")]
    pub encoding: String,
    pub max_tokens: i64,
    #[napi(ts_type = "'start' | 'end'")]
    pub keep: Option<String>,
}

/// truncateTokensBatch(items: string[], cfg: TruncateTokensConfig): Promise<string[]>
///
/// Per item: the decode of the first (keep 'start', default) or last ('end')
/// `maxTokens` BPE tokens. Items already within budget pass through
/// byte-identical. A cut inside a multi-byte character drops the fragment, so
/// results are always valid prefixes ('start') / suffixes ('end') of the
/// input. Invalid config throws synchronously with status InvalidArg;
/// per-item failures reject the batch as "item {i}: truncateTokens: {cause}".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn truncate_tokens_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    cfg: TruncateTokensConfig,
) -> Result<Object<'env>> {
    let compiled = compile_truncate_tokens(&cfg.encoding, cfg.max_tokens, cfg.keep.as_deref())
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = items
            .par_iter()
            .enumerate()
            .map(|(i, s)| apply_truncate_tokens(&compiled, s).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// Config for chunkByTokensBatch. Windows of `maxTokens` tokens advance by
/// `maxTokens - overlap` tokens; `overlap` defaults to 0 and must be < maxTokens.
#[napi(object)]
pub struct ChunkByTokensConfig {
    #[napi(ts_type = "'cl100k_base' | 'o200k_base'")]
    pub encoding: String,
    pub max_tokens: i64,
    pub overlap: Option<i64>,
}

/// chunkByTokensBatch(items: string[], cfg: ChunkByTokensConfig): Promise<string[]>
///
/// Per item: a JSON array string of chunk strings — windows of `maxTokens`
/// BPE tokens advancing by `maxTokens - overlap`, sliced from the original
/// string with window edges snapped down to character boundaries (so with
/// overlap 0 the chunks concatenate back to the exact input). An empty item
/// yields "[]". Invalid config throws synchronously with status InvalidArg;
/// per-item failures reject the batch as "item {i}: chunkByTokens: {cause}".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn chunk_by_tokens_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    cfg: ChunkByTokensConfig,
) -> Result<Object<'env>> {
    let enc = parse_encoding("chunkByTokens", &cfg.encoding)
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
    if cfg.max_tokens < 1 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("chunkByTokens: maxTokens must be >= 1, got {}", cfg.max_tokens),
        ));
    }
    let overlap = cfg.overlap.unwrap_or(0);
    if !(0..cfg.max_tokens).contains(&overlap) {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "chunkByTokens: overlap must be >= 0 and < maxTokens ({}), got {overlap}",
                cfg.max_tokens
            ),
        ));
    }
    let (max_tokens, overlap) = (cfg.max_tokens as usize, overlap as usize);
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = items
            .par_iter()
            .enumerate()
            .map(|(i, s)| {
                with_bpe_and_lens(enc, |bpe, lens| chunk_one(bpe, lens, s, max_tokens, overlap))
                    .map_err(|e| format!("item {i}: {e}"))
            })
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}
