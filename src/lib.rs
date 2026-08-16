#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod kernels;
mod pipeline;

// Library-wide allocator. Profiling token kernels at 5 rayon threads showed
// ~40% of on-CPU samples in macOS's zone-locked system allocator; mimalloc's
// per-thread heaps remove that contention for every kernel. Gated off
// linux-gnu, where napi-rs's cross-toolchain GCC is too old to build its C
// sources — glibc malloc profiled fine there.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
#[global_allocator]
static GLOBAL_ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

// Set by configure_threads. thread_count must NOT ask rayon directly:
// current_num_threads() lazily builds the global pool, which would make a
// later configure_threads fail ("pool already initialized").
static CONFIGURED_THREADS: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

/// How many threads rayon will fan work across (side-effect-free).
#[napi]
pub fn thread_count() -> u32 {
    match CONFIGURED_THREADS.get() {
        Some(n) => *n,
        None => std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
    }
}

/// Configure the global rayon pool size (1-1024). Call once, before first use.
#[napi]
pub fn configure_threads(n: i64) -> Result<()> {
    // Validate before rayon sees it: e.g. -1 as usize would try to spawn 2^64 threads.
    if !(1..=1024).contains(&n) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("thread count must be 1-1024, got {n}"),
        ));
    }
    rayon::ThreadPoolBuilder::new()
        .num_threads(n as usize)
        .build_global()
        .map_err(|e| Error::from_reason(format!("pool already initialized: {e}")))?;
    let _ = CONFIGURED_THREADS.set(n as u32);
    Ok(())
}
