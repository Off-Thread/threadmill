use std::collections::HashMap;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use serde::Deserialize;

use super::stages::{CompiledStage, NormForm, ValKind};
use crate::kernels::{codec, html, search, tabular, tokens};

#[derive(Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    #[default]
    FailFast,
    Settled,
}

#[derive(Deserialize, Clone, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Terminal {
    #[default]
    Collect,
    Count,
    WriteFiles {
        dir: String,
        #[serde(default)]
        ext: String,
    },
}

/// The `extract` field of htmlExtract: `'text' | 'html' | {attr: string}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum ExtractJson {
    Keyword(String),
    Attr { attr: String },
}

/// multiReplace's `replacements`: one per pattern, or a single broadcast string.
#[derive(Deserialize)]
#[serde(untagged)]
enum ReplacementsJson {
    Many(Vec<String>),
    One(String),
}

/// An ndjsonTransform filter value: a JS string or number.
#[derive(Deserialize)]
#[serde(untagged)]
enum FilterValueJson {
    Num(f64),
    Text(String),
}

/// One ndjsonTransform filter entry, as serialized by the JS builder.
#[derive(Deserialize)]
struct FilterJson {
    path: String,
    op: String,
    value: Option<FilterValueJson>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum StageJson {
    Gunzip,
    Gzip { level: Option<u32> },
    ZstdDecompress,
    ZstdCompress { level: Option<i32> },
    JsonPluck { path: String },
    Sha256Hex,
    Blake3Hex,
    Xxh3Hex,
    Xxh64Hex,
    Utf8,
    Bytes,
    Lowercase,
    Uppercase,
    Trim,
    Normalize { form: String },
    RegexReplace { pattern: String, replacement: String },
    RegexExtract { pattern: String, group: Option<u32> },
    #[serde(rename_all = "camelCase")]
    SanitizeHtml {
        allowed_tags: Option<Vec<String>>,
        allowed_attrs: Option<HashMap<String, Vec<String>>>,
        url_schemes: Option<Vec<String>>,
        strip_comments: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    MarkdownToHtml {
        gfm: Option<bool>,
        tables: Option<bool>,
        footnotes: Option<bool>,
        smart_punct: Option<bool>,
        #[serde(rename = "unsafe")]
        unsafe_: Option<bool>,
    },
    HtmlToText { width: Option<i64> },
    HtmlExtract {
        selector: String,
        extract: ExtractJson,
        all: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    CsvToNdjson {
        delimiter: Option<String>,
        quote: Option<String>,
        has_header: Option<bool>,
        select: Option<Vec<String>>,
    },
    NdjsonTransform {
        filter: Option<Vec<FilterJson>>,
        project: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    MultiReplace {
        patterns: Vec<String>,
        replacements: ReplacementsJson,
        case_insensitive: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    MultiFind {
        patterns: Vec<String>,
        case_insensitive: Option<bool>,
        limit: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    TruncateTokens {
        encoding: String,
        max_tokens: i64,
        keep: Option<String>,
    },
    BrotliCompress {
        quality: Option<i64>,
        lgwin: Option<i64>,
    },
    BrotliDecompress,
    Base64Encode,
    Base64Decode,
    HexEncode,
    HexDecode,
    Crc32Hex,
    Crc32cHex,
}

#[derive(Deserialize)]
struct PlanJson {
    stages: Vec<StageJson>,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    terminal: Terminal,
}

/// Which item kind a compiled plan was type-checked against. Recorded so a
/// plan handed back as an `External` can be validated against the actual
/// items kind at call time.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanInput {
    Bytes,
    Str,
    /// Type-checks under both kinds (any-input first stage, or no stages).
    Either,
}

impl PlanInput {
    pub(crate) fn accepts(self, kind: ValKind) -> bool {
        match self {
            PlanInput::Bytes => kind == ValKind::Bytes,
            PlanInput::Str => kind == ValKind::Str,
            PlanInput::Either => true,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            PlanInput::Bytes => "Bytes",
            PlanInput::Str => "Str",
            PlanInput::Either => "Bytes|Str",
        }
    }
}

/// A compiled plan. `stages` sits behind an `Arc` so a plan compiled once
/// (via `compilePipelinePlan` -> `External`) is reused across calls with no
/// per-call cloning of stage data (regexes included).
#[derive(Clone)]
pub(crate) struct CompiledPlan {
    pub(crate) stages: Arc<[CompiledStage]>,
    pub(crate) mode: Mode,
    pub(crate) terminal: Terminal,
    pub(crate) output_kind: ValKind,
    pub(crate) input_kind: PlanInput,
}

/// Parse the plan JSON, precompile every regex once, and statically type-check
/// the chain from `input_kind` through every stage. Any problem rejects the
/// whole call before an item runs.
pub(crate) fn compile_plan(plan_json: &str, input_kind: ValKind) -> Result<CompiledPlan> {
    let plan: PlanJson = serde_json::from_str(plan_json)
        .map_err(|e| Error::from_reason(format!("invalid plan JSON: {e}")))?;
    let mut cur = input_kind;
    let mut stages = Vec::with_capacity(plan.stages.len());
    for (i, stage) in plan.stages.into_iter().enumerate() {
        let (compiled, out) = compile_stage(i, stage, cur)?;
        stages.push(compiled);
        cur = out;
    }
    Ok(CompiledPlan {
        stages: stages.into(),
        mode: plan.mode,
        terminal: plan.terminal,
        output_kind: cur,
        input_kind: match input_kind {
            ValKind::Bytes => PlanInput::Bytes,
            ValKind::Str => PlanInput::Str,
        },
    })
}

/// For an empty batch the input kind cannot be inferred from the items; accept
/// the plan if it type-checks under either input kind.
pub(crate) fn compile_plan_either_kind(plan_json: &str) -> Result<CompiledPlan> {
    match compile_plan(plan_json, ValKind::Bytes) {
        Ok(plan) => Ok(plan),
        Err(bytes_err) => compile_plan(plan_json, ValKind::Str).map_err(|_| bytes_err),
    }
}

/// Compile for `compilePipelinePlan`'s `inputKind` argument. `'either'` probes
/// both kinds so the plan records exactly what it accepts; on double failure
/// the Bytes error wins (matching `compile_plan_either_kind`).
pub(crate) fn compile_plan_for_input(plan_json: &str, input_kind: &str) -> Result<CompiledPlan> {
    match input_kind {
        "bytes" => compile_plan(plan_json, ValKind::Bytes),
        "str" => compile_plan(plan_json, ValKind::Str),
        "either" => match (
            compile_plan(plan_json, ValKind::Bytes),
            compile_plan(plan_json, ValKind::Str),
        ) {
            (Ok(mut plan), Ok(_)) => {
                plan.input_kind = PlanInput::Either;
                Ok(plan)
            }
            (Ok(plan), Err(_)) => Ok(plan),
            (Err(_), Ok(plan)) => Ok(plan),
            (Err(bytes_err), Err(_)) => Err(bytes_err),
        },
        other => Err(Error::new(
            Status::InvalidArg,
            format!("inputKind must be 'bytes', 'str', or 'either', got '{other}'"),
        )),
    }
}

fn compile_stage(i: usize, stage: StageJson, cur: ValKind) -> Result<(CompiledStage, ValKind)> {
    let expect = |op: &str, expected: ValKind| -> Result<()> {
        if cur == expected {
            Ok(())
        } else {
            Err(Error::from_reason(format!(
                "stage {i} ({op}) expects {} input but receives {}",
                expected.name(),
                cur.name()
            )))
        }
    };
    let stage_err = |op: &str, msg: String| Error::from_reason(format!("stage {i} ({op}): {msg}"));
    // Kernel compile_* errors already read "{op}: {cause}" — strip the op so
    // the stage wrapper doesn't repeat it: "stage {i} ({op}): {cause}".
    let kernel_err = |op: &str, msg: String| {
        let cause = match msg.strip_prefix(op).and_then(|m| m.strip_prefix(": ")) {
            Some(c) => c.to_string(),
            None => msg,
        };
        stage_err(op, cause)
    };
    match stage {
        StageJson::Gunzip => {
            expect("gunzip", ValKind::Bytes)?;
            Ok((CompiledStage::Gunzip, ValKind::Bytes))
        }
        StageJson::Gzip { level } => {
            expect("gzip", ValKind::Bytes)?;
            let level = level.unwrap_or(6);
            if level > 9 {
                return Err(stage_err("gzip", format!("level must be 0-9, got {level}")));
            }
            Ok((CompiledStage::Gzip { level }, ValKind::Bytes))
        }
        StageJson::ZstdDecompress => {
            expect("zstdDecompress", ValKind::Bytes)?;
            Ok((CompiledStage::ZstdDecompress, ValKind::Bytes))
        }
        StageJson::ZstdCompress { level } => {
            expect("zstdCompress", ValKind::Bytes)?;
            let level = level.unwrap_or(3);
            if !(1..=22).contains(&level) {
                return Err(stage_err(
                    "zstdCompress",
                    format!("level must be 1-22, got {level}"),
                ));
            }
            Ok((CompiledStage::ZstdCompress { level }, ValKind::Bytes))
        }
        // jsonPluck and the hashes accept Bytes|Str — no input check needed.
        StageJson::JsonPluck { path } => Ok((CompiledStage::JsonPluck { path }, ValKind::Str)),
        StageJson::Sha256Hex => Ok((CompiledStage::Sha256Hex, ValKind::Str)),
        StageJson::Blake3Hex => Ok((CompiledStage::Blake3Hex, ValKind::Str)),
        StageJson::Xxh3Hex => Ok((CompiledStage::Xxh3Hex, ValKind::Str)),
        StageJson::Xxh64Hex => Ok((CompiledStage::Xxh64Hex, ValKind::Str)),
        StageJson::Utf8 => {
            expect("utf8", ValKind::Bytes)?;
            Ok((CompiledStage::Utf8, ValKind::Str))
        }
        StageJson::Bytes => {
            expect("bytes", ValKind::Str)?;
            Ok((CompiledStage::Bytes, ValKind::Bytes))
        }
        StageJson::Lowercase => {
            expect("lowercase", ValKind::Str)?;
            Ok((CompiledStage::Lowercase, ValKind::Str))
        }
        StageJson::Uppercase => {
            expect("uppercase", ValKind::Str)?;
            Ok((CompiledStage::Uppercase, ValKind::Str))
        }
        StageJson::Trim => {
            expect("trim", ValKind::Str)?;
            Ok((CompiledStage::Trim, ValKind::Str))
        }
        StageJson::Normalize { form } => {
            expect("normalize", ValKind::Str)?;
            let form = match form.as_str() {
                "NFC" => NormForm::Nfc,
                "NFD" => NormForm::Nfd,
                "NFKC" => NormForm::Nfkc,
                "NFKD" => NormForm::Nfkd,
                other => {
                    return Err(stage_err(
                        "normalize",
                        format!("unknown form '{other}' (expected NFC|NFD|NFKC|NFKD)"),
                    ))
                }
            };
            Ok((CompiledStage::Normalize { form }, ValKind::Str))
        }
        StageJson::RegexReplace {
            pattern,
            replacement,
        } => {
            expect("regexReplace", ValKind::Str)?;
            let re = regex::Regex::new(&pattern)
                .map_err(|e| stage_err("regexReplace", format!("invalid regex: {e}")))?;
            Ok((CompiledStage::RegexReplace { re, replacement }, ValKind::Str))
        }
        StageJson::RegexExtract { pattern, group } => {
            expect("regexExtract", ValKind::Str)?;
            let re = regex::Regex::new(&pattern)
                .map_err(|e| stage_err("regexExtract", format!("invalid regex: {e}")))?;
            let group = group.unwrap_or(0) as usize;
            if group >= re.captures_len() {
                return Err(stage_err(
                    "regexExtract",
                    format!(
                        "group {group} out of range (pattern has {} capture groups)",
                        re.captures_len() - 1
                    ),
                ));
            }
            Ok((CompiledStage::RegexExtract { re, group }, ValKind::Str))
        }
        StageJson::SanitizeHtml {
            allowed_tags,
            allowed_attrs,
            url_schemes,
            strip_comments,
        } => {
            expect("sanitizeHtml", ValKind::Str)?;
            let cfg =
                html::compile_sanitize_html(allowed_tags, allowed_attrs, url_schemes, strip_comments)
                    .map_err(|e| kernel_err("sanitizeHtml", e))?;
            Ok((CompiledStage::SanitizeHtml { cfg: Box::new(cfg) }, ValKind::Str))
        }
        StageJson::MarkdownToHtml {
            gfm,
            tables,
            footnotes,
            smart_punct,
            unsafe_,
        } => {
            expect("markdownToHtml", ValKind::Str)?;
            let cfg = html::compile_markdown_to_html(gfm, tables, footnotes, smart_punct, unsafe_);
            Ok((CompiledStage::MarkdownToHtml { cfg: Box::new(cfg) }, ValKind::Str))
        }
        StageJson::HtmlToText { width } => {
            expect("htmlToText", ValKind::Str)?;
            let cfg = html::compile_html_to_text(width).map_err(|e| kernel_err("htmlToText", e))?;
            Ok((CompiledStage::HtmlToText { cfg }, ValKind::Str))
        }
        // htmlExtract accepts Bytes|Str (bytes must be UTF-8) — no input check.
        StageJson::HtmlExtract {
            selector,
            extract,
            all,
        } => {
            let mode = match extract {
                ExtractJson::Keyword(k) => html::parse_html_extract_mode(Some(&k), None),
                ExtractJson::Attr { attr } => html::parse_html_extract_mode(None, Some(attr)),
            }
            .map_err(|e| kernel_err("htmlExtract", e))?;
            let cfg = html::compile_html_extract(&selector, mode, all.unwrap_or(false))
                .map_err(|e| kernel_err("htmlExtract", e))?;
            Ok((CompiledStage::HtmlExtract { cfg: Box::new(cfg) }, ValKind::Str))
        }
        // csvToNdjson and ndjsonTransform accept Bytes|Str — no input check.
        StageJson::CsvToNdjson {
            delimiter,
            quote,
            has_header,
            select,
        } => {
            let cfg = tabular::compile_csv_to_ndjson(
                delimiter.as_deref(),
                quote.as_deref(),
                has_header,
                select,
            )
            .map_err(|e| kernel_err("csvToNdjson", e))?;
            Ok((CompiledStage::CsvToNdjson { cfg }, ValKind::Str))
        }
        StageJson::NdjsonTransform { filter, project } => {
            let filters: Vec<tabular::FilterSpec> = filter
                .unwrap_or_default()
                .into_iter()
                .map(|f| tabular::FilterSpec {
                    path: f.path,
                    op: f.op,
                    value: f.value.map(|v| match v {
                        FilterValueJson::Num(n) => tabular::FilterValue::Num(n),
                        FilterValueJson::Text(s) => tabular::FilterValue::Text(s),
                    }),
                })
                .collect();
            let cfg = tabular::compile_ndjson_transform(&filters, &project.unwrap_or_default())
                .map_err(|e| kernel_err("ndjsonTransform", e))?;
            Ok((CompiledStage::NdjsonTransform { cfg: Box::new(cfg) }, ValKind::Str))
        }
        StageJson::MultiReplace {
            patterns,
            replacements,
            case_insensitive,
        } => {
            expect("multiReplace", ValKind::Str)?;
            let replacements = match replacements {
                ReplacementsJson::Many(v) => search::Replacements::PerPattern(v),
                ReplacementsJson::One(s) => search::Replacements::Single(s),
            };
            let cfg = search::compile_multi_replace(
                &patterns,
                replacements,
                case_insensitive.unwrap_or(false),
            )
            .map_err(|e| kernel_err("multiReplace", e))?;
            Ok((CompiledStage::MultiReplace { cfg: Box::new(cfg) }, ValKind::Str))
        }
        StageJson::MultiFind {
            patterns,
            case_insensitive,
            limit,
        } => {
            expect("multiFind", ValKind::Str)?;
            let cfg = search::compile_multi_find(&patterns, case_insensitive.unwrap_or(false), limit)
                .map_err(|e| kernel_err("multiFind", e))?;
            Ok((CompiledStage::MultiFind { cfg: Box::new(cfg) }, ValKind::Str))
        }
        StageJson::TruncateTokens {
            encoding,
            max_tokens,
            keep,
        } => {
            expect("truncateTokens", ValKind::Str)?;
            let cfg = tokens::compile_truncate_tokens(&encoding, max_tokens, keep.as_deref())
                .map_err(|e| kernel_err("truncateTokens", e))?;
            Ok((CompiledStage::TruncateTokens { cfg }, ValKind::Str))
        }
        StageJson::BrotliCompress { quality, lgwin } => {
            expect("brotliCompress", ValKind::Bytes)?;
            let quality = quality.unwrap_or(5);
            if !(0..=11).contains(&quality) {
                return Err(stage_err(
                    "brotliCompress",
                    format!("quality must be 0-11, got {quality}"),
                ));
            }
            let lgwin = lgwin.unwrap_or(22);
            if !(10..=24).contains(&lgwin) {
                return Err(stage_err(
                    "brotliCompress",
                    format!("lgwin must be 10-24, got {lgwin}"),
                ));
            }
            Ok((
                CompiledStage::BrotliCompress {
                    cfg: codec::BrotliCompressCfg {
                        quality: quality as i32,
                        lgwin: lgwin as i32,
                    },
                },
                ValKind::Bytes,
            ))
        }
        StageJson::BrotliDecompress => {
            expect("brotliDecompress", ValKind::Bytes)?;
            Ok((CompiledStage::BrotliDecompress, ValKind::Bytes))
        }
        // base64Encode/hexEncode/crc32Hex/crc32cHex accept Bytes|Str — no input check.
        StageJson::Base64Encode => Ok((CompiledStage::Base64Encode, ValKind::Str)),
        StageJson::Base64Decode => {
            expect("base64Decode", ValKind::Str)?;
            Ok((CompiledStage::Base64Decode, ValKind::Bytes))
        }
        StageJson::HexEncode => Ok((CompiledStage::HexEncode, ValKind::Str)),
        StageJson::HexDecode => {
            expect("hexDecode", ValKind::Str)?;
            Ok((CompiledStage::HexDecode, ValKind::Bytes))
        }
        StageJson::Crc32Hex => Ok((CompiledStage::Crc32Hex, ValKind::Str)),
        StageJson::Crc32cHex => Ok((CompiledStage::Crc32cHex, ValKind::Str)),
    }
}
