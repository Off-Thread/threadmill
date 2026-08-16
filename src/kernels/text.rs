use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

/// Unicode CHAR-level edit distance (`.chars()`, not bytes — "héllo" vs
/// "hello" is 1). rapidfuzz implements Hyyrö's variant of Myers' bit-parallel
/// algorithm (64-char fast path + blockwise for longer inputs), ~word-size
/// faster than the classic DP matrix.
fn levenshtein(a: &str, b: &str) -> u32 {
    rapidfuzz::distance::levenshtein::distance(a.chars(), b.chars()) as u32
}

#[derive(Clone, Copy)]
pub(crate) enum NormForm {
    Nfc,
    Nfd,
    Nfkc,
    Nfkd,
}

/// Unicode normalization via icu4x — measured 3.5x (NFC/NFKC) to 5x (NFD)
/// faster than unicode-normalization's char-iterator pipeline on accented
/// text, byte-identical output. The borrowed constructors are const lookups
/// of compiled data (no per-call cost). Shared by the batch kernel and the
/// pipeline `normalize` stage.
pub(crate) fn apply_normalize(form: NormForm, s: &str) -> String {
    use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};
    // normalize() returns Cow::Borrowed for already-normalized spans; callers
    // need an owned String, so convert (a memcpy at worst).
    match form {
        NormForm::Nfc => ComposingNormalizerBorrowed::new_nfc().normalize(s).into_owned(),
        NormForm::Nfd => DecomposingNormalizerBorrowed::new_nfd().normalize(s).into_owned(),
        NormForm::Nfkc => ComposingNormalizerBorrowed::new_nfkc().normalize(s).into_owned(),
        NormForm::Nfkd => DecomposingNormalizerBorrowed::new_nfkd().normalize(s).into_owned(),
    }
}

/// normalizeBatch(items: string[], form: 'NFC'|'NFD'|'NFKC'|'NFKD'): Promise<string[]>
#[napi(ts_return_type = "Promise<string[]>")]
pub fn normalize_batch<'env>(
    env: &'env Env,
    items: Vec<String>,
    #[napi(ts_arg_type = "'NFC' | 'NFD' | 'NFKC' | 'NFKD'")] form: String,
) -> Result<Object<'env>> {
    let form = match form.as_str() {
        "NFC" => NormForm::Nfc,
        "NFD" => NormForm::Nfd,
        "NFKC" => NormForm::Nfkc,
        "NFKD" => NormForm::Nfkd,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("unknown normalization form '{other}' (expected NFC|NFD|NFKC|NFKD)"),
            ))
        }
    };
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let out: Vec<String> = items
            .par_iter()
            .map(|s| apply_normalize(form, s))
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// levenshteinBatch(a: string[], b: string[]): Promise<number[]>
#[napi(ts_return_type = "Promise<number[]>")]
pub fn levenshtein_batch<'env>(
    env: &'env Env,
    a: Vec<String>,
    b: Vec<String>,
) -> Result<Object<'env>> {
    if a.len() != b.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "arrays must have equal length",
        ));
    }
    let (deferred, promise) = env.create_deferred::<Vec<u32>, _>()?;
    rayon::spawn(move || {
        let out: Vec<u32> = a
            .par_iter()
            .zip(b.par_iter())
            .map(|(x, y)| levenshtein(x, y))
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// levenshteinEach(a: string[], b: string[]): Promise<number>[]
#[napi(ts_return_type = "Promise<number>[]")]
pub fn levenshtein_each<'env>(
    env: &'env Env,
    a: Vec<String>,
    b: Vec<String>,
) -> Result<Vec<Object<'env>>> {
    if a.len() != b.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "arrays must have equal length",
        ));
    }
    let mut promises = Vec::with_capacity(a.len());
    for (x, y) in a.into_iter().zip(b) {
        let (deferred, promise) = env.create_deferred::<u32, _>()?;
        rayon::spawn(move || {
            let d = levenshtein(&x, &y);
            deferred.resolve(move |_| Ok(d));
        });
        promises.push(promise);
    }
    Ok(promises)
}
