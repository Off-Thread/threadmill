// Text diff + string similarity kernels (paired string inputs).
// Kernel-only: paired `(a[i], b[i])` inputs don't fit the single-value
// pipeline, so there are no stage helpers here.

use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

fn check_equal_len(a: usize, b: usize) -> Result<()> {
    if a != b {
        return Err(Error::new(
            Status::InvalidArg,
            "arrays must have equal length",
        ));
    }
    Ok(())
}

#[napi(object)]
pub struct DiffOptions {
    /// Unchanged-line radius around each hunk (0-100, default 3).
    pub context: Option<i64>,
}

/// diffBatch(a: string[], b: string[], opts?: { context?: number }): Promise<string[]>
///
/// Unified-diff text per pair: hunks only (`@@ -l,n +l,n @@` headers, no
/// `---`/`+++` file header). Equal inputs yield an empty string. Inputs not
/// ending in a newline get the standard `\ No newline at end of file` marker.
/// `context` is the unchanged-line radius around each hunk (0-100, default 3).
#[napi(ts_return_type = "Promise<string[]>")]
pub fn diff_batch<'env>(
    env: &'env Env,
    a: Vec<String>,
    b: Vec<String>,
    opts: Option<DiffOptions>,
) -> Result<Object<'env>> {
    check_equal_len(a.len(), b.len())?;
    let context = opts.and_then(|o| o.context).unwrap_or(3);
    if !(0..=100).contains(&context) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("context must be 0-100, got {context}"),
        ));
    }
    let context = context as usize;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let out: Vec<String> = a
            .par_iter()
            .zip(b.par_iter())
            .map(|(x, y)| {
                similar::TextDiff::from_lines(x.as_str(), y.as_str())
                    .unified_diff()
                    .context_radius(context)
                    .to_string()
            })
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

#[derive(Clone, Copy)]
enum Metric {
    Jaro,
    JaroWinkler,
    SorensenDice,
    NormalizedLevenshtein,
    NormalizedDamerau,
}

fn similarity(metric: Metric, a: &str, b: &str) -> f64 {
    match metric {
        Metric::Jaro => strsim::jaro(a, b),
        Metric::JaroWinkler => strsim::jaro_winkler(a, b),
        Metric::SorensenDice => strsim::sorensen_dice(a, b),
        Metric::NormalizedLevenshtein => strsim::normalized_levenshtein(a, b),
        Metric::NormalizedDamerau => strsim::normalized_damerau_levenshtein(a, b),
    }
}

/// similarityBatch(a: string[], b: string[], metric: 'jaro' | 'jaroWinkler' | 'sorensenDice' | 'normalizedLevenshtein' | 'normalizedDamerau'): Promise<number[]>
///
/// Per-pair similarity score in [0, 1] (1 = identical). All metrics operate on
/// Unicode scalar values (chars), not bytes.
#[napi(ts_return_type = "Promise<number[]>")]
pub fn similarity_batch<'env>(
    env: &'env Env,
    a: Vec<String>,
    b: Vec<String>,
    #[napi(
        ts_arg_type = "'jaro' | 'jaroWinkler' | 'sorensenDice' | 'normalizedLevenshtein' | 'normalizedDamerau'"
    )]
    metric: String,
) -> Result<Object<'env>> {
    let metric = match metric.as_str() {
        "jaro" => Metric::Jaro,
        "jaroWinkler" => Metric::JaroWinkler,
        "sorensenDice" => Metric::SorensenDice,
        "normalizedLevenshtein" => Metric::NormalizedLevenshtein,
        "normalizedDamerau" => Metric::NormalizedDamerau,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!(
                    "unknown metric '{other}' (expected jaro|jaroWinkler|sorensenDice|normalizedLevenshtein|normalizedDamerau)"
                ),
            ))
        }
    };
    check_equal_len(a.len(), b.len())?;
    let (deferred, promise) = env.create_deferred::<Vec<f64>, _>()?;
    rayon::spawn(move || {
        let out: Vec<f64> = a
            .par_iter()
            .zip(b.par_iter())
            .map(|(x, y)| similarity(metric, x, y))
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}
