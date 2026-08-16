use std::io::{Read, Write};

use crate::kernels::{codec, html, search, tabular, text, tokens};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValKind {
    Bytes,
    Str,
}

impl ValKind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            ValKind::Bytes => "Bytes",
            ValKind::Str => "Str",
        }
    }
}

/// The value flowing between stages; intermediates never touch V8.
pub(crate) enum Val {
    Bytes(Vec<u8>),
    Str(String),
}

impl Val {
    // Post-chain conversions. The static type-check guarantees the kind; the
    // cross-kind fallbacks are unreachable but total (no panics on rayon threads).
    pub(crate) fn into_string(self) -> String {
        match self {
            Val::Str(s) => s,
            Val::Bytes(b) => String::from_utf8_lossy(&b).into_owned(),
        }
    }

    pub(crate) fn into_byte_vec(self) -> Vec<u8> {
        match self {
            Val::Bytes(b) => b,
            Val::Str(s) => s.into_bytes(),
        }
    }
}

// One definition (and one icu4x-backed apply) shared with the normalizeBatch kernel.
pub(crate) use crate::kernels::text::NormForm;

/// A stage after `compile_plan`: type-checked, regexes/automatons/selectors
/// compiled once. Larger kernel cfgs sit behind a `Box` to keep the enum (and
/// thus every plan's stage array) small.
pub(crate) enum CompiledStage {
    Gunzip,
    Gzip { level: u32 },
    ZstdDecompress,
    ZstdCompress { level: i32 },
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
    Normalize { form: NormForm },
    RegexReplace { re: regex::Regex, replacement: String },
    RegexExtract { re: regex::Regex, group: usize },
    SanitizeHtml { cfg: Box<html::SanitizeHtmlCfg> },
    MarkdownToHtml { cfg: Box<html::MarkdownToHtmlCfg> },
    HtmlToText { cfg: html::HtmlToTextCfg },
    HtmlExtract { cfg: Box<html::HtmlExtractCfg> },
    CsvToNdjson { cfg: tabular::CsvToNdjsonCfg },
    NdjsonTransform { cfg: Box<tabular::NdjsonTransformCfg> },
    MultiReplace { cfg: Box<search::MultiReplaceCfg> },
    MultiFind { cfg: Box<search::MultiFindCfg> },
    TruncateTokens { cfg: tokens::TruncateTokensCfg },
    BrotliCompress { cfg: codec::BrotliCompressCfg },
    BrotliDecompress,
    Base64Encode,
    Base64Decode,
    HexEncode,
    HexDecode,
    Crc32Hex,
    Crc32cHex,
}

fn bytes_in(v: Val, op: &str) -> Result<Vec<u8>, String> {
    match v {
        Val::Bytes(b) => Ok(b),
        Val::Str(_) => Err(format!("{op}: internal: expected Bytes input")),
    }
}

fn str_in(v: Val, op: &str) -> Result<String, String> {
    match v {
        Val::Str(s) => Ok(s),
        Val::Bytes(_) => Err(format!("{op}: internal: expected Str input")),
    }
}

// Bytes|Str-accepting stages hash/pluck the underlying bytes of either kind.
fn any_bytes(v: &Val) -> &[u8] {
    match v {
        Val::Bytes(b) => b,
        Val::Str(s) => s.as_bytes(),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}

// Gunzip capacity hint (gzip ISIZE trailer): one definition, shared with the
// gunzipBatch kernel. Measured ~15% of fused-pipeline gunzip time.
use crate::kernels::compress::gzip_isize_hint;

fn apply_stage(stage: &CompiledStage, v: Val) -> Result<Val, String> {
    match stage {
        CompiledStage::Gunzip => {
            let b = bytes_in(v, "gunzip")?;
            let mut out = Vec::with_capacity(gzip_isize_hint(&b));
            // Same strictness as the gunzipBatch kernel: all members, no trailing garbage.
            let mut dec = flate2::bufread::MultiGzDecoder::new(b.as_slice());
            dec.read_to_end(&mut out)
                .map_err(|e| format!("gunzip: {e}"))?;
            if !dec.into_inner().is_empty() {
                return Err("gunzip: trailing garbage after gzip stream".to_string());
            }
            Ok(Val::Bytes(out))
        }
        CompiledStage::Gzip { level } => {
            let b = bytes_in(v, "gzip")?;
            let mut enc =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(*level));
            enc.write_all(&b).map_err(|e| format!("gzip: {e}"))?;
            enc.finish().map(Val::Bytes).map_err(|e| format!("gzip: {e}"))
        }
        CompiledStage::ZstdDecompress => {
            let b = bytes_in(v, "zstdDecompress")?;
            zstd::decode_all(b.as_slice())
                .map(Val::Bytes)
                .map_err(|e| format!("zstdDecompress: {e}"))
        }
        CompiledStage::ZstdCompress { level } => {
            let b = bytes_in(v, "zstdCompress")?;
            zstd::encode_all(b.as_slice(), *level)
                .map(Val::Bytes)
                .map_err(|e| format!("zstdCompress: {e}"))
        }
        CompiledStage::JsonPluck { path } => {
            let doc = match &v {
                Val::Str(s) => s.as_str(),
                Val::Bytes(b) => std::str::from_utf8(b)
                    .map_err(|e| format!("jsonPluck: invalid utf-8: {e}"))?,
            };
            let found = gjson::get(doc, path);
            if !found.exists() {
                return Err(format!("jsonPluck: path not found: {path}"));
            }
            // JSON null yields its JSON text "null" (consistent with bools/numbers);
            // a bare str() would give "", indistinguishable from an empty string.
            Ok(Val::Str(match found.kind() {
                gjson::Kind::Null => "null".to_string(),
                _ => found.str().to_string(),
            }))
        }
        CompiledStage::Sha256Hex => {
            use sha2::{Digest, Sha256};
            Ok(Val::Str(hex_lower(&Sha256::digest(any_bytes(&v)))))
        }
        CompiledStage::Blake3Hex => Ok(Val::Str(blake3::hash(any_bytes(&v)).to_hex().to_string())),
        CompiledStage::Xxh3Hex => Ok(Val::Str(format!(
            "{:016x}",
            xxhash_rust::xxh3::xxh3_64(any_bytes(&v))
        ))),
        CompiledStage::Xxh64Hex => Ok(Val::Str(format!(
            "{:016x}",
            xxhash_rust::xxh64::xxh64(any_bytes(&v), 0)
        ))),
        CompiledStage::Utf8 => {
            let b = bytes_in(v, "utf8")?;
            String::from_utf8(b)
                .map(Val::Str)
                .map_err(|e| format!("utf8: {e}"))
        }
        CompiledStage::Bytes => Ok(Val::Bytes(str_in(v, "bytes")?.into_bytes())),
        CompiledStage::Lowercase => Ok(Val::Str(str_in(v, "lowercase")?.to_lowercase())),
        CompiledStage::Uppercase => Ok(Val::Str(str_in(v, "uppercase")?.to_uppercase())),
        CompiledStage::Trim => Ok(Val::Str(str_in(v, "trim")?.trim().to_string())),
        CompiledStage::Normalize { form } => {
            let s = str_in(v, "normalize")?;
            Ok(Val::Str(text::apply_normalize(*form, &s)))
        }
        CompiledStage::RegexReplace { re, replacement } => {
            let s = str_in(v, "regexReplace")?;
            Ok(Val::Str(re.replace_all(&s, replacement.as_str()).into_owned()))
        }
        CompiledStage::RegexExtract { re, group } => {
            let s = str_in(v, "regexExtract")?;
            let m = re
                .captures(&s)
                .and_then(|c| c.get(*group))
                .ok_or_else(|| "regexExtract: no match".to_string())?;
            Ok(Val::Str(m.as_str().to_string()))
        }
        // Kernel-backed stages: logic lives once in src/kernels/*; helpers
        // already return "{op}: {cause}" errors.
        CompiledStage::SanitizeHtml { cfg } => {
            let s = str_in(v, "sanitizeHtml")?;
            html::apply_sanitize_html(cfg, &s).map(Val::Str)
        }
        CompiledStage::MarkdownToHtml { cfg } => {
            let s = str_in(v, "markdownToHtml")?;
            html::apply_markdown_to_html(cfg, &s).map(Val::Str)
        }
        CompiledStage::HtmlToText { cfg } => {
            let s = str_in(v, "htmlToText")?;
            html::apply_html_to_text(cfg, &s).map(Val::Str)
        }
        CompiledStage::HtmlExtract { cfg } => {
            html::apply_html_extract(cfg, any_bytes(&v)).map(Val::Str)
        }
        CompiledStage::CsvToNdjson { cfg } => {
            tabular::apply_csv_to_ndjson(cfg, any_bytes(&v)).map(Val::Str)
        }
        CompiledStage::NdjsonTransform { cfg } => {
            tabular::apply_ndjson_transform(cfg, any_bytes(&v)).map(Val::Str)
        }
        CompiledStage::MultiReplace { cfg } => {
            let s = str_in(v, "multiReplace")?;
            search::apply_multi_replace(cfg, &s).map(Val::Str)
        }
        CompiledStage::MultiFind { cfg } => {
            let s = str_in(v, "multiFind")?;
            search::apply_multi_find(cfg, &s).map(Val::Str)
        }
        CompiledStage::TruncateTokens { cfg } => {
            let s = str_in(v, "truncateTokens")?;
            tokens::apply_truncate_tokens(cfg, &s).map(Val::Str)
        }
        CompiledStage::BrotliCompress { cfg } => {
            let b = bytes_in(v, "brotliCompress")?;
            codec::apply_brotli_compress(cfg, &b).map(Val::Bytes)
        }
        CompiledStage::BrotliDecompress => {
            let b = bytes_in(v, "brotliDecompress")?;
            codec::apply_brotli_decompress(&b).map(Val::Bytes)
        }
        CompiledStage::Base64Encode => codec::apply_base64_encode(any_bytes(&v)).map(Val::Str),
        CompiledStage::Base64Decode => {
            let s = str_in(v, "base64Decode")?;
            codec::apply_base64_decode(&s).map(Val::Bytes)
        }
        CompiledStage::HexEncode => codec::apply_hex_encode(any_bytes(&v)).map(Val::Str),
        CompiledStage::HexDecode => {
            let s = str_in(v, "hexDecode")?;
            codec::apply_hex_decode(&s).map(Val::Bytes)
        }
        CompiledStage::Crc32Hex => codec::apply_crc32_hex(any_bytes(&v)).map(Val::Str),
        CompiledStage::Crc32cHex => codec::apply_crc32c_hex(any_bytes(&v)).map(Val::Str),
    }
}

/// Run one item through the whole chain on the current (rayon) thread.
/// Errors are `"{op}: {cause}"`; callers prefix the item index.
pub(crate) fn run_chain(stages: &[CompiledStage], mut v: Val) -> Result<Val, String> {
    for stage in stages {
        v = apply_stage(stage, v)?;
    }
    Ok(v)
}
