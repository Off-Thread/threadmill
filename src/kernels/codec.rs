use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

// ---------------------------------------------------------------------------
// Stage helpers — pub(crate) so the pipeline wiring can reuse them. The batch
// kernels below call the SAME functions, so each codec exists exactly once.
// Errors are "{op}: {cause}"; callers prefix the item index.
// ---------------------------------------------------------------------------

/// Compiled config for the brotliCompress stage. Plain ints — trivially
/// Send + Sync. The BrotliEncoderParams value is rebuilt per item; it is a
/// plain struct literal (no allocation, no compilation), so per-item cost
/// is negligible.
pub(crate) struct BrotliCompressCfg {
    /// 0..=11 (validated by callers before construction)
    pub(crate) quality: i32,
    /// log2 of the ring-buffer window, 10..=24 (validated by callers)
    pub(crate) lgwin: i32,
}

pub(crate) fn apply_brotli_compress(
    cfg: &BrotliCompressCfg,
    input: &[u8],
) -> std::result::Result<Vec<u8>, String> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: cfg.quality,
        lgwin: cfg.lgwin,
        ..Default::default()
    };
    let mut out = Vec::new();
    brotli::BrotliCompress(&mut &input[..], &mut out, &params)
        .map_err(|e| format!("brotliCompress: {e}"))?;
    Ok(out)
}

pub(crate) fn apply_brotli_decompress(input: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::new();
    brotli::BrotliDecompress(&mut &input[..], &mut out)
        .map_err(|e| format!("brotliDecompress: {e}"))?;
    Ok(out)
}

/// Standard alphabet, padded (RFC 4648 §4) — matches Buffer.toString('base64').
/// Infallible; Result-shaped for uniform stage wiring.
/// base64-simd emits bytes identical to data-encoding at ~3.5x the throughput
/// (measured 9.2 vs 2.6 GB/s on M-series).
pub(crate) fn apply_base64_encode(input: &[u8]) -> std::result::Result<String, String> {
    Ok(base64_simd::STANDARD.encode_to_string(input))
}

/// Accepts padded or unpadded standard-alphabet input: any '=' routes to the
/// strict padded decoder, none routes to the no-pad decoder. Canonical only —
/// wrong padding, whitespace, non-alphabet bytes, or nonzero trailing bits are
/// errors (stricter than Buffer.from(x, 'base64'), which silently skips junk).
///
/// Fast path is base64-simd (measured 8.8 vs 3.2 GB/s), which is strict-
/// compatible: every input it accepts, data-encoding accepts with identical
/// bytes. On any simd error we re-decode with data-encoding, which either
/// yields its exact error message or succeeds on the one shape simd rejects
/// but data-encoding supports: concatenated padded streams ("QQ==QQ==").
pub(crate) fn apply_base64_decode(input: &str) -> std::result::Result<Vec<u8>, String> {
    if input.contains('=') {
        if let Ok(v) = base64_simd::STANDARD.decode_to_vec(input.as_bytes()) {
            return Ok(v);
        }
        data_encoding::BASE64
            .decode(input.as_bytes())
            .map_err(|e| format!("base64Decode: {e}"))
    } else {
        if let Ok(v) = base64_simd::STANDARD_NO_PAD.decode_to_vec(input.as_bytes()) {
            return Ok(v);
        }
        data_encoding::BASE64_NOPAD
            .decode(input.as_bytes())
            .map_err(|e| format!("base64Decode: {e}"))
    }
}

/// Lowercase hex — matches Buffer.toString('hex'). Infallible; Result-shaped
/// for uniform stage wiring. hex-simd emits bytes identical to data-encoding
/// at ~10x the throughput (measured 19.8 vs 1.9 GB/s on M-series).
pub(crate) fn apply_hex_encode(input: &[u8]) -> std::result::Result<String, String> {
    Ok(hex_simd::encode_to_string(input, hex_simd::AsciiCase::Lower))
}

/// Accepts upper, lower, or mixed case. Odd length or non-hex bytes are errors.
/// hex-simd accepts exactly the same inputs as HEXLOWER_PERMISSIVE (even-length
/// [0-9A-Fa-f]) at 15.4 vs 3.4 GB/s; on error we re-decode with data-encoding
/// for its exact error message.
pub(crate) fn apply_hex_decode(input: &str) -> std::result::Result<Vec<u8>, String> {
    if let Ok(v) = hex_simd::decode_to_vec(input.as_bytes()) {
        return Ok(v);
    }
    data_encoding::HEXLOWER_PERMISSIVE
        .decode(input.as_bytes())
        .map_err(|e| format!("hexDecode: {e}"))
}

/// CRC-32/IEEE (the zlib/PNG/gzip polynomial), 8 lowercase hex chars.
/// Infallible; Result-shaped for uniform stage wiring. crc-fast's carryless-
/// multiply folding measured 41.9 GB/s vs crc32fast's 8.4 (identical values).
pub(crate) fn apply_crc32_hex(input: &[u8]) -> std::result::Result<String, String> {
    let crc = crc_fast::checksum(crc_fast::CrcAlgorithm::Crc32IsoHdlc, input) as u32;
    Ok(format!("{crc:08x}"))
}

/// CRC-32C (Castagnoli, the iSCSI/ext4 polynomial), 8 lowercase hex chars.
/// Infallible; Result-shaped for uniform stage wiring. crc-fast measured
/// 43 GB/s vs the crc32c crate's 17 (identical values).
pub(crate) fn apply_crc32c_hex(input: &[u8]) -> std::result::Result<String, String> {
    let crc = crc_fast::checksum(crc_fast::CrcAlgorithm::Crc32Iscsi, input) as u32;
    Ok(format!("{crc:08x}"))
}

// ---------------------------------------------------------------------------
// Batch plumbing
// ---------------------------------------------------------------------------

// V8 memory must not be touched off-thread: copy on the JS thread before rayon::spawn.
fn owned_bytes(item: Either<BufferSlice, String>) -> Vec<u8> {
    match item {
        Either::A(buf) => buf.to_vec(),
        Either::B(s) => s.into_bytes(),
    }
}

fn owned_buffers(items: &[BufferSlice]) -> Vec<Vec<u8>> {
    items.iter().map(|b| b.to_vec()).collect()
}

// Deferred+rayon runners shared by every kernel below. `f` receives each owned
// item and returns the stage-helper Result, whose message is already
// "{op}: {cause}" — the runner prefixes "item {i}: " and rejects the batch.
fn run_to_buffers<'env, I, F>(env: &'env Env, owned: Vec<I>, f: F) -> Result<Object<'env>>
where
    I: Send + Sync + 'static,
    F: Fn(&I) -> std::result::Result<Vec<u8>, String> + Send + Sync + 'static,
{
    let (deferred, promise) = env.create_deferred::<Vec<Buffer>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<Vec<u8>>, String> = owned
            .par_iter()
            .enumerate()
            .map(|(i, item)| f(item).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            // Buffer::from needs no Env; the resolve closure runs on the JS thread.
            Ok(v) => deferred.resolve(move |_| Ok(v.into_iter().map(Buffer::from).collect())),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

fn run_to_strings<'env, I, F>(env: &'env Env, owned: Vec<I>, f: F) -> Result<Object<'env>>
where
    I: Send + Sync + 'static,
    F: Fn(&I) -> std::result::Result<String, String> + Send + Sync + 'static,
{
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<String>, String> = owned
            .par_iter()
            .enumerate()
            .map(|(i, item)| f(item).map_err(|e| format!("item {i}: {e}")))
            .collect();
        match result {
            Ok(v) => deferred.resolve(move |_| Ok(v)),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

// ---------------------------------------------------------------------------
// Brotli
// ---------------------------------------------------------------------------

/// Options for brotliCompressBatch. quality 0-11 (default 5); lgwin — log2 of
/// the sliding window — 10-24 (default 22).
#[napi(object)]
pub struct BrotliOptions {
    pub quality: Option<i64>,
    pub lgwin: Option<i64>,
}

/// brotliCompressBatch(items: Buffer[], opts?: { quality?: number, lgwin?: number }): Promise<Buffer[]>
/// — quality 0-11 (default 5), lgwin 10-24 (default 22)
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn brotli_compress_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
    opts: Option<BrotliOptions>,
) -> Result<Object<'env>> {
    let (quality, lgwin) = match opts {
        Some(o) => (o.quality.unwrap_or(5), o.lgwin.unwrap_or(22)),
        None => (5, 22),
    };
    if !(0..=11).contains(&quality) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("brotli quality must be 0-11, got {quality}"),
        ));
    }
    if !(10..=24).contains(&lgwin) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("brotli lgwin must be 10-24, got {lgwin}"),
        ));
    }
    let cfg = BrotliCompressCfg {
        quality: quality as i32,
        lgwin: lgwin as i32,
    };
    run_to_buffers(env, owned_buffers(&items), move |d| {
        apply_brotli_compress(&cfg, d)
    })
}

/// brotliDecompressBatch(items: Buffer[]): Promise<Buffer[]> — corrupt input
/// rejects the batch with "item {i}: brotliDecompress: {cause}"
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn brotli_decompress_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
) -> Result<Object<'env>> {
    run_to_buffers(env, owned_buffers(&items), |d| apply_brotli_decompress(d))
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/// base64EncodeBatch(items: Array<Buffer | string>): Promise<string[]> —
/// standard alphabet, padded (matches Buffer.toString('base64')); strings are
/// encoded from their UTF-8 bytes
#[napi(ts_return_type = "Promise<string[]>")]
pub fn base64_encode_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    run_to_strings(env, owned, |d| apply_base64_encode(d))
}

/// base64DecodeBatch(items: string[]): Promise<Buffer[]> — accepts padded or
/// unpadded standard-alphabet input, but strictly canonical: wrong padding,
/// whitespace, or non-alphabet characters reject the batch with
/// "item {i}: base64Decode: {cause}"
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn base64_decode_batch<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    run_to_buffers(env, items, |s| apply_base64_decode(s))
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

/// hexEncodeBatch(items: Array<Buffer | string>): Promise<string[]> — lowercase
/// (matches Buffer.toString('hex')); strings are encoded from their UTF-8 bytes
#[napi(ts_return_type = "Promise<string[]>")]
pub fn hex_encode_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    run_to_strings(env, owned, |d| apply_hex_encode(d))
}

/// hexDecodeBatch(items: string[]): Promise<Buffer[]> — accepts upper, lower,
/// or mixed case; odd length or non-hex characters reject the batch with
/// "item {i}: hexDecode: {cause}"
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn hex_decode_batch<'env>(env: &'env Env, items: Vec<String>) -> Result<Object<'env>> {
    run_to_buffers(env, items, |s| apply_hex_decode(s))
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

/// crc32HexBatch(items: Array<Buffer | string>): Promise<string[]> —
/// CRC-32/IEEE (zlib/gzip/PNG polynomial), 8 lowercase hex chars per item
#[napi(ts_return_type = "Promise<string[]>")]
pub fn crc32_hex_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    run_to_strings(env, owned, |d| apply_crc32_hex(d))
}

/// crc32cHexBatch(items: Array<Buffer | string>): Promise<string[]> —
/// CRC-32C (Castagnoli, iSCSI/ext4 polynomial), 8 lowercase hex chars per item
// js_name: napi's auto-camelCase would produce crc32CHexBatch (capital C).
#[napi(js_name = "crc32cHexBatch", ts_return_type = "Promise<string[]>")]
pub fn crc32c_hex_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    run_to_strings(env, owned, |d| apply_crc32c_hex(d))
}
