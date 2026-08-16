// Tabular data: CSV -> NDJSON conversion and NDJSON filter/project transforms.
//
// Stage helpers (`CsvToNdjsonCfg`/`NdjsonTransformCfg` + `compile_*` +
// `apply_*`) are pub(crate) so the pipeline can reuse them: config is
// validated/compiled ONCE and shared read-only across rayon threads (both
// cfg structs are plain owned data — Send + Sync for free; the csv reader
// itself is a cheap per-item construction since it consumes its input).

use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;
use std::fmt::Write as _;

// ---------------------------------------------------------------- shared

// Copy on the JS thread: V8-owned Buffer memory must not be touched off-thread.
fn owned_bytes(item: Either<BufferSlice, String>) -> Vec<u8> {
    match item {
        Either::A(buf) => buf.to_vec(),
        Either::B(s) => s.into_bytes(),
    }
}

/// Append `s` as a JSON string literal (quotes, backslashes, control chars
/// escaped). Byte-run copy: only `"`/`\`/control bytes need escaping and all
/// are single-byte ASCII, so clean runs between them are pushed as whole
/// slices (multi-byte UTF-8 is >= 0x80 and never splits) — measurably faster
/// than a per-char loop on field-heavy CSV.
fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &c) in bytes.iter().enumerate() {
        if c == b'"' || c == b'\\' || c < 0x20 {
            out.push_str(&s[start..i]);
            match c {
                b'"' => out.push_str("\\\""),
                b'\\' => out.push_str("\\\\"),
                b'\n' => out.push_str("\\n"),
                b'\r' => out.push_str("\\r"),
                b'\t' => out.push_str("\\t"),
                c => {
                    // write! to a String is infallible.
                    let _ = write!(out, "\\u{c:04x}");
                }
            }
            start = i + 1;
        }
    }
    out.push_str(&s[start..]);
    out.push('"');
}

/// Append the object-position prefix for column `ci` with pre-escaped `name`:
/// `{"name":` for the first column, `,"name":` after.
fn key_prefix(ci: usize, name: &str) -> String {
    let mut p = String::with_capacity(name.len() + 4);
    p.push(if ci == 0 { '{' } else { ',' });
    push_json_str(&mut p, name);
    p.push(':');
    p
}

// ---------------------------------------------------------------- csvToNdjson stage

/// Compiled once; shared read-only across rayon threads (plain data, Send + Sync).
pub(crate) struct CsvToNdjsonCfg {
    delimiter: u8,
    quote: u8,
    has_header: bool,
    select: Option<Vec<String>>,
    /// Pre-escaped `{"name":` / `,"name":` output prefixes for select mode
    /// (select keys don't depend on any header, so they compile once).
    sel_prefixes: Option<Vec<String>>,
}

fn single_ascii(s: &str, what: &str) -> std::result::Result<u8, String> {
    match s.as_bytes() {
        [b] if b.is_ascii() => Ok(*b),
        _ => Err(format!(
            "csvToNdjson: {what} must be a single ASCII character, got {s:?}"
        )),
    }
}

/// Errors: "csvToNdjson: {cause}" (multi-char / non-ASCII delimiter or quote,
/// empty select array). Defaults: delimiter ",", quote "\"", hasHeader true.
pub(crate) fn compile_csv_to_ndjson(
    delimiter: Option<&str>,
    quote: Option<&str>,
    has_header: Option<bool>,
    select: Option<Vec<String>>,
) -> std::result::Result<CsvToNdjsonCfg, String> {
    let delimiter = single_ascii(delimiter.unwrap_or(","), "delimiter")?;
    let quote = single_ascii(quote.unwrap_or("\""), "quote")?;
    if let Some(sel) = &select {
        if sel.is_empty() {
            return Err("csvToNdjson: select must not be empty".to_string());
        }
    }
    let sel_prefixes = select.as_ref().map(|sel| {
        sel.iter()
            .enumerate()
            .map(|(n, name)| key_prefix(n, name))
            .collect()
    });
    Ok(CsvToNdjsonCfg {
        delimiter,
        quote,
        has_header: has_header.unwrap_or(true),
        select,
        sel_prefixes,
    })
}

fn resolve_select(
    sel: &[String],
    header: &[String],
) -> std::result::Result<Vec<usize>, String> {
    sel.iter()
        .map(|name| {
            header
                .iter()
                .position(|h| h == name)
                .ok_or_else(|| format!("csvToNdjson: unknown column in select: '{name}'"))
        })
        .collect()
}

/// One whole CSV file/chunk in -> NDJSON out (one JSON object per row, rows
/// joined with '\n', no trailing newline; zero rows -> ""). Keys come from the
/// header row when `has_header`, else col0..colN. `select` projects named
/// columns in select order; an unknown name is an error. Errors:
/// "csvToNdjson: {cause}" (malformed row, invalid UTF-8, unknown select column).
pub(crate) fn apply_csv_to_ndjson(
    cfg: &CsvToNdjsonCfg,
    input: &[u8],
) -> std::result::Result<String, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(cfg.delimiter)
        .quote(cfg.quote)
        .has_headers(cfg.has_header)
        .from_reader(input);

    let mut header: Vec<String> = Vec::new();
    // Parallel to `header`: pre-escaped `{"key":` / `,"key":` output prefixes,
    // built once per item instead of re-escaping every key on every row.
    let mut prefixes: Vec<String> = Vec::new();
    let mut sel_idx: Option<Vec<usize>> = None;
    if cfg.has_header {
        let h = rdr.headers().map_err(|e| format!("csvToNdjson: {e}"))?;
        header = h.iter().map(str::to_string).collect();
        prefixes = header
            .iter()
            .enumerate()
            .map(|(ci, name)| key_prefix(ci, name))
            .collect();
        // A fully empty chunk yields an empty header record and no rows; only
        // resolve select against a real header (unknown name = error).
        if !header.is_empty() {
            if let Some(sel) = &cfg.select {
                sel_idx = Some(resolve_select(sel, &header)?);
            }
        }
    }

    // Keys repeat per row, so NDJSON output is a small multiple of the input;
    // one up-front reservation avoids the doubling-realloc walk.
    let mut out = String::with_capacity(input.len().saturating_mul(2));
    let mut rec = csv::StringRecord::new();
    loop {
        // Strict (non-flexible) reader: ragged rows and invalid UTF-8 error
        // here. The record is reused across rows — no per-row allocation.
        match rdr.read_record(&mut rec) {
            Err(e) => return Err(format!("csvToNdjson: {e}")),
            Ok(false) => break,
            Ok(true) => {}
        }
        // Headerless files name columns col0..colN from the observed width
        // (strict mode keeps every row the same width as the first).
        if rec.len() > header.len() {
            for ci in header.len()..rec.len() {
                let name = format!("col{ci}");
                prefixes.push(key_prefix(ci, &name));
                header.push(name);
            }
        }
        if sel_idx.is_none() {
            if let Some(sel) = &cfg.select {
                sel_idx = Some(resolve_select(sel, &header)?);
            }
        }
        if !out.is_empty() {
            out.push('\n');
        }
        // The first prefix carries the opening '{' (a yielded record always
        // has >= 1 field; the empty-record arm is defensive only).
        match (&sel_idx, &cfg.sel_prefixes) {
            (Some(idxs), Some(sel_prefixes)) => {
                for (prefix, &ci) in sel_prefixes.iter().zip(idxs) {
                    out.push_str(prefix);
                    push_json_str(&mut out, rec.get(ci).unwrap_or(""));
                }
            }
            _ if rec.is_empty() => out.push('{'),
            _ => {
                for (ci, field) in rec.iter().enumerate() {
                    out.push_str(&prefixes[ci]);
                    push_json_str(&mut out, field);
                }
            }
        }
        out.push('}');
    }
    Ok(out)
}

// ---------------------------------------------------------------- ndjsonTransform stage

#[derive(Clone, Copy)]
enum FilterOp {
    Eq,
    Ne,
    Gt,
    Lt,
    Exists,
}

/// Raw (pre-compile) filter value: a JS string or number, both JSON-serializable.
pub(crate) enum FilterValue {
    Text(String),
    Num(f64),
}

/// Raw (pre-compile) filter spec — plain data so both the batch kernel and the
/// pipeline plan parser can build it.
pub(crate) struct FilterSpec {
    pub(crate) path: String,
    pub(crate) op: String,
    pub(crate) value: Option<FilterValue>,
}

struct CompiledFilter {
    path: String,
    op: FilterOp,
    text: Option<String>, // eq/ne compare against this text
    num: Option<f64>,     // gt/lt compare against this number
}

/// Compiled once; shared read-only across rayon threads (plain data, Send + Sync).
pub(crate) struct NdjsonTransformCfg {
    filters: Vec<CompiledFilter>,
    /// (output key = last path segment or full path, gjson path)
    project: Option<Vec<(String, String)>>,
}

// JS number -> its shortest text ("30", not "30.0") so eq against JSON
// integer text behaves as users expect.
fn num_text(n: f64) -> String {
    format!("{n}")
}

/// Errors: "ndjsonTransform: {cause}" (no filter AND no project, unknown op,
/// empty path, missing/non-numeric value for ops that need one). Empty slices
/// count as absent.
pub(crate) fn compile_ndjson_transform(
    filters: &[FilterSpec],
    project: &[String],
) -> std::result::Result<NdjsonTransformCfg, String> {
    if filters.is_empty() && project.is_empty() {
        return Err("ndjsonTransform: config must set filter and/or project".to_string());
    }
    let compiled = filters
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let op = match f.op.as_str() {
                "eq" => FilterOp::Eq,
                "ne" => FilterOp::Ne,
                "gt" => FilterOp::Gt,
                "lt" => FilterOp::Lt,
                "exists" => FilterOp::Exists,
                other => {
                    return Err(format!(
                        "ndjsonTransform: filter[{i}]: unknown op '{other}' (expected eq|ne|gt|lt|exists)"
                    ))
                }
            };
            if f.path.is_empty() {
                return Err(format!("ndjsonTransform: filter[{i}]: path must not be empty"));
            }
            let (text, num) = match op {
                FilterOp::Exists => (None, None),
                FilterOp::Eq | FilterOp::Ne => {
                    let t = match &f.value {
                        Some(FilterValue::Text(s)) => s.clone(),
                        Some(FilterValue::Num(n)) => num_text(*n),
                        None => {
                            return Err(format!(
                                "ndjsonTransform: filter[{i}]: op '{}' requires a value",
                                f.op
                            ))
                        }
                    };
                    (Some(t), None)
                }
                FilterOp::Gt | FilterOp::Lt => {
                    let n = match &f.value {
                        Some(FilterValue::Num(n)) => *n,
                        Some(FilterValue::Text(s)) => s.parse::<f64>().map_err(|_| {
                            format!(
                                "ndjsonTransform: filter[{i}]: op '{}' requires a numeric value, got '{s}'",
                                f.op
                            )
                        })?,
                        None => {
                            return Err(format!(
                                "ndjsonTransform: filter[{i}]: op '{}' requires a value",
                                f.op
                            ))
                        }
                    };
                    (None, Some(n))
                }
            };
            Ok(CompiledFilter {
                path: f.path.clone(),
                op,
                text,
                num,
            })
        })
        .collect::<std::result::Result<Vec<_>, String>>()?;

    let project_cfg = if project.is_empty() {
        None
    } else {
        Some(
            project
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    if p.is_empty() {
                        return Err(format!(
                            "ndjsonTransform: project[{i}]: path must not be empty"
                        ));
                    }
                    // Output key = last path segment ("user.email" -> "email"),
                    // or the full path when there is no dot.
                    let key = p.rsplit('.').next().unwrap_or(p).to_string();
                    Ok((key, p.clone()))
                })
                .collect::<std::result::Result<Vec<_>, String>>()?,
        )
    };
    Ok(NdjsonTransformCfg {
        filters: compiled,
        project: project_cfg,
    })
}

fn filter_passes(f: &CompiledFilter, line: &str) -> bool {
    let v = gjson::get(line, &f.path);
    match f.op {
        FilterOp::Exists => v.exists(),
        // eq/ne compare gjson's text form: strings unquoted, numbers/bools as
        // their JSON text, JSON null and missing paths both read as "".
        FilterOp::Eq => v.str() == f.text.as_deref().unwrap_or(""),
        FilterOp::Ne => v.str() != f.text.as_deref().unwrap_or(""),
        // Numeric compares require the path to exist (a missing field is never
        // greater or less than anything); gjson coerces numeric strings.
        FilterOp::Gt => v.exists() && v.f64() > f.num.unwrap_or(f64::NAN),
        FilterOp::Lt => v.exists() && v.f64() < f.num.unwrap_or(f64::NAN),
    }
}

/// Per line: skip blank lines; a line survives only if ALL filters pass; with
/// `project`, the surviving line is rebuilt as {key: gjson value (raw JSON),
/// missing path -> null}; without, it passes through verbatim (minus any
/// trailing '\r'). Survivors are joined with '\n' (no trailing newline; none
/// survive -> ""). Errors: "ndjsonTransform: {cause}" (invalid UTF-8,
/// "line {n}: invalid JSON" with 1-based n).
pub(crate) fn apply_ndjson_transform(
    cfg: &NdjsonTransformCfg,
    input: &[u8],
) -> std::result::Result<String, String> {
    let text = std::str::from_utf8(input)
        .map_err(|e| format!("ndjsonTransform: invalid utf-8: {e}"))?;
    let mut out = String::new();
    for (ln, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.trim().is_empty() {
            continue;
        }
        // gjson is lax on its own; validate so garbage lines fail loudly.
        if !gjson::valid(line) {
            return Err(format!("ndjsonTransform: line {}: invalid JSON", ln + 1));
        }
        if !cfg.filters.iter().all(|f| filter_passes(f, line)) {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        match &cfg.project {
            None => out.push_str(line),
            Some(proj) => {
                out.push('{');
                for (n, (key, path)) in proj.iter().enumerate() {
                    if n > 0 {
                        out.push(',');
                    }
                    push_json_str(&mut out, key);
                    out.push(':');
                    let v = gjson::get(line, path);
                    if v.exists() {
                        // Raw JSON slice of the (validated) line: safe to splice.
                        out.push_str(v.json());
                    } else {
                        out.push_str("null");
                    }
                }
                out.push('}');
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- batch kernels

/// Options for csvToNdjsonBatch. `delimiter` (default ",") and `quote`
/// (default "\"") must be single ASCII characters. `hasHeader` defaults to
/// true. `select` projects the named columns in the given order.
#[napi(object)]
#[derive(Default)]
pub struct CsvToNdjsonOptions {
    pub delimiter: Option<String>,
    pub has_header: Option<bool>,
    pub quote: Option<String>,
    pub select: Option<Vec<String>>,
}

/// csvToNdjsonBatch(items: Array<Buffer | string>, opts?: CsvToNdjsonOptions): Promise<string[]>
///
/// One item = one whole CSV file/chunk; each resolves to NDJSON (one JSON
/// object per row, '\n'-joined, all values as JSON strings). Keys come from
/// the header row when hasHeader (default), else col0..colN. Invalid options
/// throw synchronously with status InvalidArg; a malformed row, invalid UTF-8,
/// or unknown select column rejects the batch as "item {i}: csvToNdjson: {cause}".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn csv_to_ndjson_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
    opts: Option<CsvToNdjsonOptions>,
) -> Result<Object<'env>> {
    let opts = opts.unwrap_or_default();
    let cfg = compile_csv_to_ndjson(
        opts.delimiter.as_deref(),
        opts.quote.as_deref(),
        opts.has_header,
        opts.select,
    )
    .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = owned
            .par_iter()
            .enumerate()
            .map(|(i, b)| apply_csv_to_ndjson(&cfg, b).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// One NDJSON filter: gjson `path`, comparison `op`, and the value to compare
/// against (required for eq/ne/gt/lt, ignored for exists).
#[napi(object)]
pub struct NdjsonFilter {
    pub path: String,
    #[napi(ts_type = "'eq' | 'ne' | 'gt' | 'lt' | 'exists'")]
    pub op: String,
    pub value: Option<Either<String, f64>>,
}

/// Config for ndjsonTransformBatch: `filter` keeps only lines where ALL
/// predicates pass; `project` rebuilds each surviving line from gjson paths.
/// At least one of the two must be set.
#[napi(object)]
pub struct NdjsonTransformConfig {
    pub filter: Option<Vec<NdjsonFilter>>,
    pub project: Option<Vec<String>>,
}

/// ndjsonTransformBatch(items: Array<Buffer | string>, cfg: NdjsonTransformConfig): Promise<string[]>
///
/// One item = one NDJSON chunk. Per line: blank lines are skipped; all
/// `filter` predicates must pass (eq/ne compare gjson text, gt/lt compare
/// numerically, exists checks presence); `project` rebuilds the line as
/// {last path segment or full path: value, missing -> null}, otherwise the
/// line passes through verbatim. Survivors are '\n'-joined per item. Invalid
/// config throws synchronously with status InvalidArg; an invalid JSON line
/// rejects the batch as "item {i}: ndjsonTransform: line {n}: invalid JSON".
#[napi(ts_return_type = "Promise<string[]>")]
pub fn ndjson_transform_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
    cfg: NdjsonTransformConfig,
) -> Result<Object<'env>> {
    let filters: Vec<FilterSpec> = cfg
        .filter
        .unwrap_or_default()
        .into_iter()
        .map(|f| FilterSpec {
            path: f.path,
            op: f.op,
            value: f.value.map(|v| match v {
                Either::A(s) => FilterValue::Text(s),
                Either::B(n) => FilterValue::Num(n),
            }),
        })
        .collect();
    let project = cfg.project.unwrap_or_default();
    let compiled = compile_ndjson_transform(&filters, &project)
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = owned
            .par_iter()
            .enumerate()
            .map(|(i, b)| {
                apply_ndjson_transform(&compiled, b).map_err(|e| format!("item {i}: {e}"))
            })
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}
