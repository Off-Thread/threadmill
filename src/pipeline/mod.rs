//! Fused pipeline engine: JS sends a compiled plan (JSON, or an `External`
//! from `compilePipelinePlan`), every item flows through all stages on one
//! rayon thread; intermediates never touch V8.
//!
//! Every terminal follows the deferred+rayon pattern: arguments are validated
//! and V8 memory copied on the JS thread, then the batch runs entirely on
//! rayon — no libuv pool thread is ever occupied by CPU work.

mod plan;
mod stages;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

use self::plan::{
    compile_plan, compile_plan_either_kind, compile_plan_for_input, CompiledPlan, Mode, Terminal,
};
use self::stages::{run_chain, CompiledStage, Val, ValKind};

/// The plan argument every terminal accepts: raw plan JSON (compiled per
/// call), or the `External` handle from `compilePipelinePlan` (compiled once,
/// stages shared via `Arc` — nothing is re-parsed or re-compiled per call).
type PlanArg = Either<String, ExternalRef<CompiledPlan>>;

/// Copy JS-owned items to Rust-owned values on the JS thread (V8 memory must
/// not be touched off-thread) and infer the chain input kind. `None` kind for
/// an empty batch.
fn coerce_items(items: Vec<Either<BufferSlice, String>>) -> Result<(Vec<Val>, Option<ValKind>)> {
    let mut kind: Option<ValKind> = None;
    let mut vals = Vec::with_capacity(items.len());
    for (i, item) in items.into_iter().enumerate() {
        let (v, k) = match item {
            Either::A(buf) => (Val::Bytes(buf.to_vec()), ValKind::Bytes),
            Either::B(s) => (Val::Str(s), ValKind::Str),
        };
        match kind {
            None => kind = Some(k),
            Some(first) if first != k => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "items must be all Buffers or all strings; item {i} differs from earlier items"
                    ),
                ));
            }
            Some(_) => {}
        }
        vals.push(v);
    }
    Ok((vals, kind))
}

fn compile_for(plan_json: &str, kind: Option<ValKind>) -> Result<CompiledPlan> {
    match kind {
        Some(k) => compile_plan(plan_json, k),
        None => compile_plan_either_kind(plan_json),
    }
}

/// Resolve the plan argument on the JS thread. The JSON path compiles for the
/// inferred items kind; the `External` path only validates the recorded input
/// kind and clones cheaply (`Arc` bump for the stages).
fn plan_for(plan: PlanArg, kind: Option<ValKind>) -> Result<CompiledPlan> {
    match plan {
        Either::A(json) => compile_for(&json, kind),
        Either::B(ext) => {
            let compiled: &CompiledPlan = &ext;
            if let Some(k) = kind {
                if !compiled.input_kind.accepts(k) {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!(
                            "plan was compiled for {} input but received {} items",
                            compiled.input_kind.name(),
                            k.name()
                        ),
                    ));
                }
            }
            Ok(compiled.clone())
        }
    }
}

/// compilePipelinePlan(planJson: string, inputKind: 'bytes' | 'str' | 'either'): ExternalObject
/// Compile a plan ONCE (JSON parse + regex compilation + chain type-check) and
/// reuse the returned handle across any number of runPipeline* calls.
#[napi(ts_return_type = "ExternalObject<'PipelinePlan'>")]
pub fn compile_pipeline_plan(
    plan_json: String,
    #[napi(ts_arg_type = "'bytes' | 'str' | 'either'")] input_kind: String,
) -> Result<External<CompiledPlan>> {
    Ok(External::new(compile_plan_for_input(
        &plan_json,
        &input_kind,
    )?))
}

/// Chain results kept as plain Rust data until `resolve` on the JS thread.
enum OutVals {
    Strs(Vec<String>),
    Bytes(Vec<Vec<u8>>),
}

fn vals_to_out(vals: Vec<Val>, kind: ValKind) -> OutVals {
    match kind {
        ValKind::Str => OutVals::Strs(vals.into_iter().map(Val::into_string).collect()),
        ValKind::Bytes => OutVals::Bytes(vals.into_iter().map(Val::into_byte_vec).collect()),
    }
}

fn out_to_js(out: OutVals) -> Either<Vec<String>, Vec<Buffer>> {
    match out {
        OutVals::Strs(v) => Either::A(v),
        OutVals::Bytes(v) => Either::B(v.into_iter().map(Buffer::from).collect()),
    }
}

fn val_to_either(v: Val) -> Either<String, Buffer> {
    match v {
        Val::Str(s) => Either::A(s),
        Val::Bytes(b) => Either::B(Buffer::from(b)),
    }
}

/// failFast: first item error rejects the whole batch as `"item {i}: {op}: {cause}"`.
fn fail_fast_run(stages: &[CompiledStage], inputs: Vec<Val>) -> Result<Vec<Val>> {
    let res: std::result::Result<Vec<Val>, String> = inputs
        .into_par_iter()
        .enumerate()
        .map(|(i, v)| run_chain(stages, v).map_err(|e| format!("item {i}: {e}")))
        .collect();
    res.map_err(Error::from_reason)
}

/// settled: every item finishes; per-item Ok(value) / Err("item {i}: {op}: {cause}").
fn settled_run(
    stages: &[CompiledStage],
    inputs: Vec<Val>,
) -> Vec<std::result::Result<Val, String>> {
    inputs
        .into_par_iter()
        .enumerate()
        .map(|(i, v)| run_chain(stages, v).map_err(|e| format!("item {i}: {e}")))
        .collect()
}

#[napi(object)]
pub struct SettledItem {
    pub ok: bool,
    pub value: Option<Either<String, Buffer>>,
    pub error: Option<String>,
}

fn settled_to_js(results: Vec<std::result::Result<Val, String>>) -> Vec<SettledItem> {
    results
        .into_iter()
        .map(|r| match r {
            Ok(v) => SettledItem {
                ok: true,
                value: Some(val_to_either(v)),
                error: None,
            },
            Err(e) => SettledItem {
                ok: false,
                value: None,
                error: Some(e),
            },
        })
        .collect()
}

/// runPipelineCollect(plan: string | ExternalObject, items: Array<Buffer> | Array<string>): Promise<string[] | Buffer[]>
/// failFast: rejects with "item {i}: {op}: {cause}" on the first failing item.
#[napi(ts_return_type = "Promise<string[] | Buffer[]>")]
pub fn run_pipeline_collect<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    #[napi(ts_arg_type = "Array<Buffer> | Array<string>")] items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let (inputs, kind) = coerce_items(items)?;
    let plan = plan_for(plan, kind)?;
    let (deferred, promise) = env.create_deferred::<Either<Vec<String>, Vec<Buffer>>, _>()?;
    let stages = plan.stages;
    let output_kind = plan.output_kind;
    rayon::spawn(move || match fail_fast_run(&stages, inputs) {
        Ok(vals) => {
            let out = vals_to_out(vals, output_kind);
            deferred.resolve(move |_| Ok(out_to_js(out)));
        }
        Err(e) => deferred.reject(e),
    });
    Ok(promise)
}

/// runPipelineSettled(plan: string | ExternalObject, items: Array<Buffer> | Array<string>): Promise<SettledItem[]>
/// Never rejects on item errors: each element is {ok, value?, error?}.
#[napi(ts_return_type = "Promise<Array<SettledItem>>")]
pub fn run_pipeline_settled<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    #[napi(ts_arg_type = "Array<Buffer> | Array<string>")] items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let (inputs, kind) = coerce_items(items)?;
    let plan = plan_for(plan, kind)?;
    let (deferred, promise) = env.create_deferred::<Vec<SettledItem>, _>()?;
    let stages = plan.stages;
    rayon::spawn(move || {
        let results = settled_run(&stages, inputs);
        deferred.resolve(move |_| Ok(settled_to_js(results)));
    });
    Ok(promise)
}

/// runPipelineCount(plan: string | ExternalObject, items: Array<Buffer> | Array<string>): Promise<number>
/// failFast mode: an item error still rejects; settled mode: count of successful items.
#[napi(ts_return_type = "Promise<number>")]
pub fn run_pipeline_count<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    #[napi(ts_arg_type = "Array<Buffer> | Array<string>")] items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let (inputs, kind) = coerce_items(items)?;
    let plan = plan_for(plan, kind)?;
    let (deferred, promise) = env.create_deferred::<u32, _>()?;
    let stages = plan.stages;
    let mode = plan.mode;
    rayon::spawn(move || {
        let res = match mode {
            Mode::FailFast => fail_fast_run(&stages, inputs).map(|vals| vals.len() as u32),
            Mode::Settled => Ok(inputs
                .into_par_iter()
                .map(|v| u32::from(run_chain(&stages, v).is_ok()))
                .sum()),
        };
        match res {
            Ok(n) => deferred.resolve(move |_| Ok(n)),
            Err(e) => deferred.reject(e),
        }
    });
    Ok(promise)
}

/// Shared writeFiles driver, run on rayon threads — off libuv. `produce` maps
/// (i, item) to the chain output (or an "item {i}: ..." error string); output
/// i lands at `{dir}/{i}{ext}`. failFast: the first item error rejects the
/// batch; settled: failed items are skipped, written paths keep their indexes.
fn write_outputs<T, F>(
    items: Vec<T>,
    mode: Mode,
    dir: &str,
    ext: &str,
    produce: F,
) -> Result<Vec<String>>
where
    T: Send,
    F: Fn(usize, T) -> std::result::Result<Val, String> + Sync,
{
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::from_reason(format!("writeFiles: cannot create dir '{dir}': {e}")))?;
    let dir = std::path::Path::new(dir);
    let write_one = |(i, item): (usize, T)| -> std::result::Result<String, String> {
        let val = produce(i, item)?;
        let path = dir.join(format!("{i}{ext}"));
        std::fs::write(&path, val.into_byte_vec())
            .map_err(|e| format!("item {i}: writeFiles: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    };
    match mode {
        Mode::FailFast => {
            let res: std::result::Result<Vec<String>, String> =
                items.into_par_iter().enumerate().map(write_one).collect();
            res.map_err(Error::from_reason)
        }
        // settled: failed items are skipped; only written paths come back.
        Mode::Settled => Ok(items
            .into_par_iter()
            .enumerate()
            .map(write_one)
            .filter_map(std::result::Result::ok)
            .collect()),
    }
}

/// runPipelineWriteFiles(plan: string | ExternalObject, items: Array<Buffer> | Array<string>): Promise<string[]>
/// Plan terminal must be {kind: "writeFiles", dir, ext?}. Writes item i to `{dir}/{i}{ext}`
/// on rayon threads and resolves with the written paths.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn run_pipeline_write_files<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    #[napi(ts_arg_type = "Array<Buffer> | Array<string>")] items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let (inputs, kind) = coerce_items(items)?;
    let plan = plan_for(plan, kind)?;
    let (dir, ext) = match plan.terminal {
        Terminal::WriteFiles { dir, ext } => (dir, ext),
        _ => {
            return Err(Error::from_reason(
                "runPipelineWriteFiles requires plan terminal {\"kind\": \"writeFiles\", \"dir\": ..., \"ext\": ...}",
            ))
        }
    };
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    let stages = plan.stages;
    let mode = plan.mode;
    rayon::spawn(move || {
        let res = write_outputs(inputs, mode, &dir, &ext, |i, v| {
            run_chain(&stages, v).map_err(|e| format!("item {i}: {e}"))
        });
        match res {
            Ok(paths) => deferred.resolve(move |_| Ok(paths)),
            Err(e) => deferred.reject(e),
        }
    });
    Ok(promise)
}

fn read_and_run(
    stages: &[CompiledStage],
    i: usize,
    path: &str,
) -> std::result::Result<Val, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("item {i}: readFile '{path}': {e}"))?;
    run_chain(stages, Val::Bytes(bytes)).map_err(|e| format!("item {i}: {e}"))
}

/// runPipelineFiles(plan: string | ExternalObject, paths: string[]): Promise<string[] | Buffer[]>
/// Source variant: reads each file on a rayon thread (bytes input), then runs the chain.
/// failFast: a read or stage error rejects as "item {i}: ...".
#[napi(ts_return_type = "Promise<string[] | Buffer[]>")]
pub fn run_pipeline_files<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    paths: Vec<String>,
) -> Result<Object<'env>> {
    let plan = plan_for(plan, Some(ValKind::Bytes))?;
    let (deferred, promise) = env.create_deferred::<Either<Vec<String>, Vec<Buffer>>, _>()?;
    let stages = plan.stages;
    let output_kind = plan.output_kind;
    rayon::spawn(move || {
        // File reads happen here, on the rayon thread — off libuv.
        let res: std::result::Result<Vec<Val>, String> = paths
            .into_par_iter()
            .enumerate()
            .map(|(i, p)| read_and_run(&stages, i, &p))
            .collect();
        match res {
            Ok(vals) => {
                let out = vals_to_out(vals, output_kind);
                deferred.resolve(move |_| Ok(out_to_js(out)));
            }
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// runPipelineFilesSettled(plan: string | ExternalObject, paths: string[]): Promise<SettledItem[]>
/// Settled source variant: read/stage errors land in per-item {ok: false, error}.
#[napi(ts_return_type = "Promise<Array<SettledItem>>")]
pub fn run_pipeline_files_settled<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    paths: Vec<String>,
) -> Result<Object<'env>> {
    let plan = plan_for(plan, Some(ValKind::Bytes))?;
    let (deferred, promise) = env.create_deferred::<Vec<SettledItem>, _>()?;
    let stages = plan.stages;
    rayon::spawn(move || {
        let results: Vec<std::result::Result<Val, String>> = paths
            .into_par_iter()
            .enumerate()
            .map(|(i, p)| read_and_run(&stages, i, &p))
            .collect();
        deferred.resolve(move |_| Ok(settled_to_js(results)));
    });
    Ok(promise)
}

/// runPipelineFilesCount(plan: string | ExternalObject, paths: string[]): Promise<number>
/// Count source variant: reads and runs every file on rayon threads; only the
/// count crosses the boundary. failFast mode: any read or stage error rejects
/// as "item {i}: ..."; settled mode: count of successful items.
#[napi(ts_return_type = "Promise<number>")]
pub fn run_pipeline_files_count<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    paths: Vec<String>,
) -> Result<Object<'env>> {
    let plan = plan_for(plan, Some(ValKind::Bytes))?;
    let (deferred, promise) = env.create_deferred::<u32, _>()?;
    let stages = plan.stages;
    let mode = plan.mode;
    rayon::spawn(move || {
        let total = paths.len() as u32;
        let res: std::result::Result<u32, String> = match mode {
            Mode::FailFast => paths
                .into_par_iter()
                .enumerate()
                .try_for_each(|(i, p)| read_and_run(&stages, i, &p).map(drop))
                .map(|()| total),
            Mode::Settled => Ok(paths
                .into_par_iter()
                .enumerate()
                .map(|(i, p)| u32::from(read_and_run(&stages, i, &p).is_ok()))
                .sum()),
        };
        match res {
            Ok(n) => deferred.resolve(move |_| Ok(n)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// runPipelineFilesWriteFiles(plan: string | ExternalObject, paths: string[]): Promise<string[]>
/// WriteFiles source variant: plan terminal must be {kind: "writeFiles", dir, ext?}.
/// Reads AND writes happen on rayon threads; input file i lands at `{dir}/{i}{ext}`.
/// Read failures are item errors: "item {i}: readFile '{path}': {cause}".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn run_pipeline_files_write_files<'env>(
    env: &'env Env,
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    paths: Vec<String>,
) -> Result<Object<'env>> {
    let plan = plan_for(plan, Some(ValKind::Bytes))?;
    let (dir, ext) = match plan.terminal {
        Terminal::WriteFiles { dir, ext } => (dir, ext),
        _ => {
            return Err(Error::from_reason(
                "runPipelineFilesWriteFiles requires plan terminal {\"kind\": \"writeFiles\", \"dir\": ..., \"ext\": ...}",
            ))
        }
    };
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    let stages = plan.stages;
    let mode = plan.mode;
    rayon::spawn(move || {
        let res = write_outputs(paths, mode, &dir, &ext, |i, p: String| {
            read_and_run(&stages, i, &p)
        });
        match res {
            Ok(out) => deferred.resolve(move |_| Ok(out)),
            Err(e) => deferred.reject(e),
        }
    });
    Ok(promise)
}

#[napi(object)]
pub struct StreamItem {
    pub index: u32,
    pub ok: bool,
    pub value: Option<Either<String, Buffer>>,
    pub error: Option<String>,
}

/// runPipelineStream(plan: string | ExternalObject, items: Array<Buffer> | Array<string>, onItem: (err, item) => void): void
/// Exactly one callback per item, fired in COMPLETION order; no call after the
/// last one. The JS layer wraps this into an async iterator.
#[napi]
pub fn run_pipeline_stream(
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    #[napi(ts_arg_type = "Array<Buffer> | Array<string>")] items: Vec<Either<BufferSlice, String>>,
    #[napi(ts_arg_type = "(err: Error | null, item: StreamItem) => void")]
    on_item: ThreadsafeFunction<StreamItem>,
) -> Result<()> {
    let (inputs, kind) = coerce_items(items)?;
    let plan = plan_for(plan, kind)?;
    let stages = plan.stages;
    rayon::spawn(move || {
        inputs.into_par_iter().enumerate().for_each(|(i, v)| {
            let item = match run_chain(&stages, v) {
                Ok(val) => StreamItem {
                    index: i as u32,
                    ok: true,
                    value: Some(val_to_either(val)),
                    error: None,
                },
                Err(e) => StreamItem {
                    index: i as u32,
                    ok: false,
                    value: None,
                    error: Some(format!("item {i}: {e}")),
                },
            };
            on_item.call(Ok(item), ThreadsafeFunctionCallMode::NonBlocking);
        });
        // `on_item` drops here: the TSFN is released after queued calls flush.
    });
    Ok(())
}

/// runPipelineFilesStream(plan: string | ExternalObject, paths: string[], onItem: (err, item) => void): void
/// Stream source variant: each file is read on a rayon thread, then run through
/// the chain. Exactly one callback per path, fired in COMPLETION order; read
/// failures arrive as {ok: false, error: "item {i}: readFile '{path}': ..."}.
#[napi]
pub fn run_pipeline_files_stream(
    #[napi(ts_arg_type = "string | ExternalObject<'PipelinePlan'>")] plan: PlanArg,
    paths: Vec<String>,
    #[napi(ts_arg_type = "(err: Error | null, item: StreamItem) => void")]
    on_item: ThreadsafeFunction<StreamItem>,
) -> Result<()> {
    let plan = plan_for(plan, Some(ValKind::Bytes))?;
    let stages = plan.stages;
    rayon::spawn(move || {
        paths.into_par_iter().enumerate().for_each(|(i, p)| {
            let item = match read_and_run(&stages, i, &p) {
                Ok(val) => StreamItem {
                    index: i as u32,
                    ok: true,
                    value: Some(val_to_either(val)),
                    error: None,
                },
                Err(e) => StreamItem {
                    index: i as u32,
                    ok: false,
                    value: None,
                    error: Some(e),
                },
            };
            on_item.call(Ok(item), ThreadsafeFunctionCallMode::NonBlocking);
        });
        // `on_item` drops here: the TSFN is released after queued calls flush.
    });
    Ok(())
}

/// True if `pattern` contains glob syntax. Patterns without metacharacters
/// pass through `expandGlob` as literal paths (existence NOT required — the
/// per-item file read reports missing files).
fn has_glob_meta(pattern: &str) -> bool {
    pattern
        .bytes()
        .any(|b| matches!(b, b'*' | b'?' | b'[' | b'{'))
}

/// Longest leading run of `/`-separated components with no glob metacharacter:
/// the directory the filesystem walk starts from. Empty means the process's
/// current directory. (Plans use `/` separators, same as globset itself.)
fn glob_literal_base(pattern: &str) -> String {
    let mut base: Vec<&str> = Vec::new();
    for comp in pattern.split('/') {
        if has_glob_meta(comp) {
            break;
        }
        base.push(comp);
    }
    let joined = base.join("/");
    if joined.is_empty() && pattern.starts_with('/') {
        "/".to_string()
    } else {
        joined
    }
}

/// Recursive walk with std::fs (no walkdir): `fs_dir` is the directory read
/// from disk, `cand_prefix` the same directory as it must appear in matched
/// candidates (kept separate so a relative pattern never grows a `./` prefix,
/// which would defeat matching). Only FILES match — directories never do;
/// symlinks to files match, symlinked directories are not followed (cycle
/// safety, same default as walkdir). Unreadable directories are skipped.
fn walk_glob(
    fs_dir: &std::path::Path,
    cand_prefix: &str,
    set: &GlobSet,
    out: &mut std::collections::BTreeSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(fs_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let cand = match cand_prefix {
            "" => name.into_owned(),
            "/" => format!("/{name}"),
            _ => format!("{cand_prefix}/{name}"),
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_glob(&entry.path(), &cand, set, out);
        } else {
            let is_file = if file_type.is_symlink() {
                std::fs::metadata(entry.path()).is_ok_and(|m| m.is_file())
            } else {
                file_type.is_file()
            };
            if is_file && set.is_match(&cand) {
                out.insert(cand);
            }
        }
    }
}

/// expandGlob(patterns: string[]): Promise<string[]>
/// Expands glob patterns to the FILE paths matching them; the filesystem walk
/// runs on a rayon thread — off libuv. The GlobSet is built ONCE up front on
/// the JS thread, so an invalid pattern throws synchronously as InvalidArg,
/// naming the pattern. `*` does not cross `/` (use `**` to recurse). Patterns
/// without metacharacters pass through as literal paths without touching the
/// filesystem. Resolves the union of all matches, sorted and deduplicated.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn expand_glob<'env>(env: &'env Env, patterns: Vec<String>) -> Result<Object<'env>> {
    let mut literals: Vec<String> = Vec::new();
    let mut globs: Vec<String> = Vec::new();
    for p in patterns {
        if has_glob_meta(&p) {
            globs.push(p);
        } else {
            literals.push(p);
        }
    }
    let mut builder = GlobSetBuilder::new();
    for pat in &globs {
        let glob = GlobBuilder::new(pat)
            .literal_separator(true)
            .build()
            .map_err(|e| {
                Error::new(
                    Status::InvalidArg,
                    format!("expandGlob: invalid pattern '{pat}': {e}"),
                )
            })?;
        builder.add(glob);
    }
    let set = builder
        .build()
        .map_err(|e| Error::new(Status::InvalidArg, format!("expandGlob: {e}")))?;
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        // One walk per DISTINCT literal base; every walked file is matched
        // against the full set, so overlapping patterns just deduplicate.
        let mut bases: Vec<String> = globs.iter().map(|p| glob_literal_base(p)).collect();
        bases.sort();
        bases.dedup();
        let mut out = std::collections::BTreeSet::new();
        for base in &bases {
            let fs_dir = if base.is_empty() {
                std::path::Path::new(".")
            } else {
                std::path::Path::new(base)
            };
            walk_glob(fs_dir, base, &set, &mut out);
        }
        out.extend(literals);
        let paths: Vec<String> = out.into_iter().collect();
        deferred.resolve(move |_| Ok(paths));
    });
    Ok(promise)
}
