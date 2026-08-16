use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

/// sortNumbers(items: Float64Array): Promise<Float64Array>
///
/// Parallel sort within the one array. total_cmp order:
/// -NaN < -Infinity < ... < -0 < +0 < ... < +Infinity < +NaN.
#[napi(ts_return_type = "Promise<Float64Array>")]
pub fn sort_numbers<'env>(env: &'env Env, items: Float64Array) -> Result<Object<'env>> {
    // Copy on the JS thread: V8-owned typed-array memory must not be touched off-thread.
    let mut owned = items.to_vec();
    let (deferred, promise) = env.create_deferred::<Float64Array, _>()?;
    rayon::spawn(move || {
        // radsort (LSD radix) orders floats exactly like total_cmp (including
        // ±NaN payloads and ±0) and measured 172ms vs 262ms pdqsort on 14M
        // items, but it is sequential; with more threads the parallel
        // comparison sort wins. Same unique sorted sequence either way.
        // current_num_threads() is safe here: this closure already runs inside
        // the pool, so the lazy-global-pool hazard from lib.rs does not apply.
        if rayon::current_num_threads() == 1 {
            radsort::sort(&mut owned);
        } else {
            owned.par_sort_unstable_by(f64::total_cmp);
        }
        // Float64Array::new needs no Env; the resolve closure runs on the JS thread.
        deferred.resolve(move |_| Ok(Float64Array::new(owned)));
    });
    Ok(promise)
}

/// sortStrings(items: string[]): Promise<string[]>
///
/// Lexicographic by Unicode scalar value (Rust `Ord` on str), not locale collation.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn sort_strings<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let mut items = items;
        items.par_sort_unstable();
        deferred.resolve(move |_| Ok(items));
    });
    Ok(promise)
}
