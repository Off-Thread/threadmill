// Batch forms of the string ops that also exist as pipeline stages
// (lowercase/uppercase/trim/regexReplace/regexExtract). Semantics match
// src/pipeline/stages.rs, with one deliberate divergence noted on
// regexExtractBatch.

use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

#[derive(Clone, Copy)]
enum MapOp {
    Lowercase,
    Uppercase,
    Trim,
}

fn map_str(op: MapOp, s: &str) -> String {
    match op {
        MapOp::Lowercase => s.to_lowercase(),
        MapOp::Uppercase => s.to_uppercase(),
        MapOp::Trim => s.trim().to_string(),
    }
}

fn map_batch<'env>(env: &'env Env, items: Vec<String>, op: MapOp) -> Result<Object<'env>> {
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let out: Vec<String> = items.par_iter().map(|s| map_str(op, s)).collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// lowercaseBatch(items: string[]): Promise<string[]> — Unicode-aware full lowercasing
#[napi(ts_return_type = "Promise<string[]>")]
pub fn lowercase_batch<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    map_batch(env, items, MapOp::Lowercase)
}

/// uppercaseBatch(items: string[]): Promise<string[]> — Unicode-aware full uppercasing
#[napi(ts_return_type = "Promise<string[]>")]
pub fn uppercase_batch<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    map_batch(env, items, MapOp::Uppercase)
}

/// trimBatch(items: string[]): Promise<string[]> — trims Unicode whitespace from both ends
#[napi(ts_return_type = "Promise<string[]>")]
pub fn trim_batch<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    map_batch(env, items, MapOp::Trim)
}

fn compile_regex(pattern: &str) -> Result<regex::Regex> {
    regex::Regex::new(pattern)
        .map_err(|e| Error::new(Status::InvalidArg, format!("invalid regex: {e}")))
}

/// regexReplaceBatch(items: string[], pattern: string, replacement: string): Promise<string[]>
///
/// `replace_all` with Rust regex replacement syntax (`$1`, `${name}`; `$&` is
/// literal) — identical to the regexReplace pipeline stage. The pattern is
/// compiled once for the whole batch.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn regex_replace_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    pattern: String,
    replacement: String,
) -> Result<Object<'env>> {
    let re = compile_regex(&pattern)?;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let out: Vec<String> = items
            .par_iter()
            .map(|s| re.replace_all(s, replacement.as_str()).into_owned())
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// regexExtractBatch(items: string[], pattern: string, group?: number): Promise<Array<string | null>>
///
/// First match per item, optionally a capture group (default 0 = whole match).
/// NO MATCH -> `null` — the kernel convention (like jsonPluckBatch's
/// missing-path null). This deliberately diverges from the regexExtract STAGE,
/// which treats no-match as a per-item error. The pattern is compiled once for
/// the whole batch; `group` is validated against its capture count.
#[napi(ts_return_type = "Promise<Array<string | null>>")]
pub fn regex_extract_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    pattern: String,
    group: Option<i64>,
) -> Result<Object<'env>> {
    let re = compile_regex(&pattern)?;
    let group = group.unwrap_or(0);
    if !(0..re.captures_len() as i64).contains(&group) {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "group {group} out of range (pattern has {} capture groups)",
                re.captures_len() - 1
            ),
        ));
    }
    let group = group as usize;
    let (deferred, promise) = env.create_deferred::<Vec<Option<String>>, _>()?;
    rayon::spawn(move || {
        let out: Vec<Option<String>> = items
            .par_iter()
            .map(|s| {
                re.captures(s)
                    .and_then(|c| c.get(group))
                    .map(|m| m.as_str().to_string())
            })
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}
