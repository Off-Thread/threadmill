// Multi-pattern search/replace (aho-corasick), regex predicates, byte lengths.
//
// Stage helpers (`MultiReplaceCfg`/`MultiFindCfg` + `compile_*` + `apply_*`)
// are pub(crate) so the pipeline can reuse them: expensive automatons are
// built ONCE and shared across rayon threads (AhoCorasick is Send + Sync).

use aho_corasick::{AhoCorasick, MatchKind};
use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

// ---------------------------------------------------------------- stage helpers

/// One replacement per pattern, or a single string applied to every pattern
/// (the PII-redaction case).
pub(crate) enum Replacements {
    PerPattern(Vec<String>),
    Single(String),
}

/// Compiled once; shared read-only across rayon threads.
pub(crate) struct MultiReplaceCfg {
    ac: AhoCorasick,
    replacements: Replacements,
}

impl MultiReplaceCfg {
    fn replacement(&self, pattern_idx: usize) -> &str {
        match &self.replacements {
            Replacements::PerPattern(v) => &v[pattern_idx],
            Replacements::Single(s) => s,
        }
    }
}

/// Compiled once; shared read-only across rayon threads.
pub(crate) struct MultiFindCfg {
    ac: AhoCorasick,
    limit: Option<usize>,
}

// Leftmost-longest, non-overlapping. `ascii_case_insensitive` folds ASCII
// only ('CAT'~'cat', but 'É' never matches 'é') — documented in the JS API.
fn build_automaton(
    patterns: &[String],
    case_insensitive: bool,
    op: &str,
) -> std::result::Result<AhoCorasick, String> {
    if patterns.is_empty() {
        return Err(format!("{op}: patterns must not be empty"));
    }
    if let Some(i) = patterns.iter().position(|p| p.is_empty()) {
        return Err(format!("{op}: patterns[{i}] must not be empty"));
    }
    AhoCorasick::builder()
        .match_kind(MatchKind::LeftmostLongest)
        .ascii_case_insensitive(case_insensitive)
        .build(patterns)
        .map_err(|e| format!("{op}: {e}"))
}

/// Errors: "multiReplace: {cause}" (empty patterns array, empty pattern
/// string, replacements/patterns length mismatch, automaton build failure).
pub(crate) fn compile_multi_replace(
    patterns: &[String],
    replacements: Replacements,
    case_insensitive: bool,
) -> std::result::Result<MultiReplaceCfg, String> {
    if let Replacements::PerPattern(r) = &replacements {
        if r.len() != patterns.len() {
            return Err(format!(
                "multiReplace: replacements length {} != patterns length {}",
                r.len(),
                patterns.len()
            ));
        }
    }
    let ac = build_automaton(patterns, case_insensitive, "multiReplace")?;
    Ok(MultiReplaceCfg { ac, replacements })
}

/// Errors: "multiFind: {cause}" (empty patterns array, empty pattern string,
/// limit 0, automaton build failure).
pub(crate) fn compile_multi_find(
    patterns: &[String],
    case_insensitive: bool,
    limit: Option<usize>,
) -> std::result::Result<MultiFindCfg, String> {
    if limit == Some(0) {
        return Err("multiFind: limit must be >= 1".to_string());
    }
    let ac = build_automaton(patterns, case_insensitive, "multiFind")?;
    Ok(MultiFindCfg { ac, limit })
}

/// Replace every leftmost-longest match with its pattern's replacement.
/// Infallible; Result-shaped for uniform stage wiring.
pub(crate) fn apply_multi_replace(
    cfg: &MultiReplaceCfg,
    input: &str,
) -> std::result::Result<String, String> {
    let mut out = String::with_capacity(input.len());
    let mut last = 0;
    for m in cfg.ac.find_iter(input) {
        out.push_str(&input[last..m.start()]);
        out.push_str(cfg.replacement(m.pattern().as_usize()));
        last = m.end();
    }
    out.push_str(&input[last..]);
    Ok(out)
}

/// JSON array string of `{"p":patternIndex,"s":startByte,"e":endByte}`,
/// leftmost-longest, at most `limit` matches. Infallible; Result-shaped for
/// uniform stage wiring.
pub(crate) fn apply_multi_find(
    cfg: &MultiFindCfg,
    input: &str,
) -> std::result::Result<String, String> {
    let mut out = String::from("[");
    // Numeric-only fields: no JSON escaping needed. itoa instead of write!:
    // formatting-machinery overhead was ~30% of this kernel on dense matches.
    let mut digits = itoa::Buffer::new();
    let matches = cfg.ac.find_iter(input).take(cfg.limit.unwrap_or(usize::MAX));
    for (n, m) in matches.enumerate() {
        if n > 0 {
            out.push(',');
        }
        out.push_str("{\"p\":");
        out.push_str(digits.format(m.pattern().as_usize()));
        out.push_str(",\"s\":");
        out.push_str(digits.format(m.start()));
        out.push_str(",\"e\":");
        out.push_str(digits.format(m.end()));
        out.push('}');
    }
    out.push(']');
    Ok(out)
}

// ---------------------------------------------------------------- batch kernels

/// Config for multiReplaceBatch. `replacements` as an array must match
/// `patterns` in length; as a single string it applies to every pattern.
/// `caseInsensitive` folds ASCII letters only.
#[napi(object)]
pub struct MultiReplaceConfig {
    pub patterns: Vec<String>,
    pub replacements: Either<Vec<String>, String>,
    pub case_insensitive: Option<bool>,
}

/// Config for multiFindBatch. `limit` (>= 1) caps matches per item.
/// `caseInsensitive` folds ASCII letters only.
#[napi(object)]
pub struct MultiFindConfig {
    pub patterns: Vec<String>,
    pub case_insensitive: Option<bool>,
    pub limit: Option<u32>,
}

/// multiReplaceBatch(items: string[], cfg: MultiReplaceConfig): Promise<string[]>
///
/// Aho-Corasick replace-all with leftmost-longest match semantics; the
/// automaton is built once on the JS thread (invalid config throws
/// synchronously with status InvalidArg).
#[napi(ts_return_type = "Promise<string[]>")]
pub fn multi_replace_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    cfg: MultiReplaceConfig,
) -> Result<Object<'env>> {
    let replacements = match cfg.replacements {
        Either::A(v) => Replacements::PerPattern(v),
        Either::B(s) => Replacements::Single(s),
    };
    let compiled =
        compile_multi_replace(&cfg.patterns, replacements, cfg.case_insensitive.unwrap_or(false))
            .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = items
            .par_iter()
            .enumerate()
            .map(|(i, s)| apply_multi_replace(&compiled, s).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// multiFindBatch(items: string[], cfg: MultiFindConfig): Promise<string[]>
///
/// Per item: a JSON array string of {p: patternIndex, s: startByte, e: endByte},
/// leftmost-longest, non-overlapping, optionally capped at `limit` matches.
/// The automaton is built once on the JS thread (invalid config throws
/// synchronously with status InvalidArg).
#[napi(ts_return_type = "Promise<string[]>")]
pub fn multi_find_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    cfg: MultiFindConfig,
) -> Result<Object<'env>> {
    let compiled = compile_multi_find(
        &cfg.patterns,
        cfg.case_insensitive.unwrap_or(false),
        cfg.limit.map(|n| n as usize),
    )
    .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = items
            .par_iter()
            .enumerate()
            .map(|(i, s)| apply_multi_find(&compiled, s).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

// Compiled once, synchronously: an invalid pattern throws InvalidArg naming it.
fn compile_regex(pattern: &str) -> Result<regex::Regex> {
    regex::Regex::new(pattern).map_err(|e| {
        Error::new(
            Status::InvalidArg,
            format!("invalid regex '{pattern}': {e}"),
        )
    })
}

/// regexTestBatch(items: string[], pattern: string): Promise<boolean[]>
///
/// Rust `regex` syntax (no lookaround/backreferences); compiled once, invalid
/// patterns throw synchronously with status InvalidArg.
#[napi(ts_return_type = "Promise<boolean[]>")]
pub fn regex_test_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    pattern: String,
) -> Result<Object<'env>> {
    let re = compile_regex(&pattern)?;
    let (deferred, promise) = env.create_deferred::<Vec<bool>, _>()?;
    rayon::spawn(move || {
        let out: Vec<bool> = items.par_iter().map(|s| re.is_match(s)).collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// regexCountBatch(items: string[], pattern: string): Promise<number[]>
///
/// Count of non-overlapping matches per item. Rust `regex` syntax; compiled
/// once, invalid patterns throw synchronously with status InvalidArg.
#[napi(ts_return_type = "Promise<number[]>")]
pub fn regex_count_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    pattern: String,
) -> Result<Object<'env>> {
    let re = compile_regex(&pattern)?;
    let (deferred, promise) = env.create_deferred::<Vec<u32>, _>()?;
    rayon::spawn(move || {
        let out: Vec<u32> = items
            .par_iter()
            .map(|s| re.find_iter(s).count() as u32)
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// byteLenBatch(items: Array<Buffer | string>): Promise<number[]>
///
/// UTF-8 byte length per item (a Buffer's byte length as-is; strings measured
/// after UTF-16 -> UTF-8 conversion).
#[napi(ts_return_type = "Promise<number[]>")]
pub fn byte_len_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    // Lengths are read on the JS thread: V8 Buffer memory must not be touched
    // off-thread, and napi has already converted strings to UTF-8 — so the
    // answers exist before spawn; nothing per-item remains to parallelize.
    let lens: Vec<u32> = items
        .iter()
        .map(|item| match item {
            Either::A(buf) => buf.len() as u32,
            Either::B(s) => s.len() as u32,
        })
        .collect();
    let (deferred, promise) = env.create_deferred::<Vec<u32>, _>()?;
    rayon::spawn(move || {
        deferred.resolve(move |_| Ok(lens));
    });
    Ok(promise)
}
