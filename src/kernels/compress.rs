use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;
use std::io::{Read, Write};

#[derive(Clone, Copy)]
enum CompressOp {
    Gzip(u32),
    Gunzip,
    ZstdCompress(i32),
    ZstdDecompress,
}

fn op_name(op: CompressOp) -> &'static str {
    match op {
        CompressOp::Gzip(_) => "gzip",
        CompressOp::Gunzip => "gunzip",
        CompressOp::ZstdCompress(_) => "zstdCompress",
        CompressOp::ZstdDecompress => "zstdDecompress",
    }
}

/// Capacity hint for gunzip output: the gzip trailer's ISIZE field (last 4
/// bytes, LE, uncompressed size mod 2^32 of the LAST member). Pre-reserving
/// lets `read_to_end` decompress straight into spare capacity instead of its
/// probe-read/regrow cycle. A hint only: multi-member streams under-reserve
/// and grow normally. Capped at deflate's maximum expansion ratio (~1032x) so
/// a corrupt trailer cannot force an absurd allocation.
pub(crate) fn gzip_isize_hint(data: &[u8]) -> usize {
    // Minimum whole gzip stream: 10-byte header + 8-byte trailer.
    if data.len() < 18 {
        return 0;
    }
    let t = &data[data.len() - 4..];
    let isize = u32::from_le_bytes([t[0], t[1], t[2], t[3]]) as usize;
    isize.min(data.len().saturating_mul(1032))
}

fn apply(op: CompressOp, data: &[u8]) -> std::io::Result<Vec<u8>> {
    match op {
        CompressOp::Gzip(level) => {
            let mut enc = GzEncoder::new(Vec::new(), Compression::new(level));
            enc.write_all(data)?;
            enc.finish()
        }
        CompressOp::Gunzip => {
            let mut out = Vec::with_capacity(gzip_isize_hint(data));
            // MultiGz: decode ALL members (matches node:zlib on `cat a.gz b.gz` files).
            // bufread variant so leftover input is detectable: node:zlib rejects
            // trailing garbage and so do we — silent acceptance hides data loss.
            let mut dec = flate2::bufread::MultiGzDecoder::new(data);
            dec.read_to_end(&mut out)?;
            if !dec.into_inner().is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "trailing garbage after gzip stream",
                ));
            }
            Ok(out)
        }
        CompressOp::ZstdCompress(level) => zstd::encode_all(data, level),
        CompressOp::ZstdDecompress => zstd::decode_all(data),
    }
}

// V8 memory must not be touched off-thread: copy on the JS thread before rayon::spawn.
fn to_owned(items: &[BufferSlice]) -> Vec<Vec<u8>> {
    items.iter().map(|b| b.to_vec()).collect()
}

fn compress_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
    op: CompressOp,
) -> Result<Object<'env>> {
    let owned = to_owned(&items);
    let (deferred, promise) = env.create_deferred::<Vec<Buffer>, _>()?;
    rayon::spawn(move || {
        let result: std::result::Result<Vec<Vec<u8>>, String> = owned
            .into_par_iter()
            .enumerate()
            .map(|(i, data)| {
                apply(op, &data).map_err(|e| format!("item {i}: {}: {e}", op_name(op)))
            })
            .collect();
        match result {
            // Buffer::from needs no Env; the resolve closure runs on the JS thread.
            Ok(v) => deferred.resolve(move |_| Ok(v.into_iter().map(Buffer::from).collect())),
            Err(e) => deferred.reject(Error::from_reason(e)),
        }
    });
    Ok(promise)
}

/// gzipBatch(items: Buffer[], level?: number): Promise<Buffer[]> — level 0-9, default 6
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn gzip_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
    level: Option<i64>,
) -> Result<Object<'env>> {
    let level = level.unwrap_or(6);
    if !(0..=9).contains(&level) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("gzip level must be 0-9, got {level}"),
        ));
    }
    compress_batch(env, items, CompressOp::Gzip(level as u32))
}

/// gunzipBatch(items: Buffer[]): Promise<Buffer[]>
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn gunzip_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    compress_batch(env, items, CompressOp::Gunzip)
}

/// zstdCompressBatch(items: Buffer[], level?: number): Promise<Buffer[]> — level 1-22, default 3
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn zstd_compress_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
    level: Option<i64>,
) -> Result<Object<'env>> {
    let level = level.unwrap_or(3);
    if !(1..=22).contains(&level) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("zstd level must be 1-22, got {level}"),
        ));
    }
    compress_batch(env, items, CompressOp::ZstdCompress(level as i32))
}

/// zstdDecompressBatch(items: Buffer[]): Promise<Buffer[]>
#[napi(ts_return_type = "Promise<Buffer[]>")]
pub fn zstd_decompress_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    compress_batch(env, items, CompressOp::ZstdDecompress)
}
