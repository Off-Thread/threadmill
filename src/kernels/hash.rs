use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

#[derive(Clone, Copy)]
enum HashAlgo {
    Sha256,
    Blake3,
    Xxh3,
    Xxh64,
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 0x0f) as usize]);
    }
    String::from_utf8(out).expect("hex is ascii")
}

fn hash_hex(algo: HashAlgo, data: &[u8]) -> String {
    match algo {
        HashAlgo::Sha256 => {
            use sha2::{Digest, Sha256};
            hex_lower(&Sha256::digest(data))
        }
        HashAlgo::Blake3 => blake3::hash(data).to_hex().to_string(),
        HashAlgo::Xxh3 => format!("{:016x}", xxhash_rust::xxh3::xxh3_64(data)),
        HashAlgo::Xxh64 => format!("{:016x}", xxhash_rust::xxh64::xxh64(data, 0)),
    }
}

// Buffers are copied to owned bytes on the JS thread — V8 memory must not be
// touched from the rayon thread.
fn to_owned_bytes(items: &[BufferSlice]) -> Vec<Vec<u8>> {
    items.iter().map(|b| b.to_vec()).collect()
}

fn hash_batch<'env>(
    env: &'env Env,
    items: Vec<BufferSlice>,
    algo: HashAlgo,
) -> Result<Object<'env>> {
    let owned = to_owned_bytes(&items);
    let (deferred, promise) = env.create_deferred::<Vec<String>, _>()?;
    rayon::spawn(move || {
        let out: Vec<String> = owned.par_iter().map(|item| hash_hex(algo, item)).collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// sha256HexBatch(items: Buffer[]): Promise<string[]> — lowercase hex, 64 chars per item
#[napi(ts_return_type = "Promise<string[]>")]
pub fn sha256_hex_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    hash_batch(env, items, HashAlgo::Sha256)
}

/// blake3HexBatch(items: Buffer[]): Promise<string[]> — lowercase hex, 64 chars per item
#[napi(ts_return_type = "Promise<string[]>")]
pub fn blake3_hex_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    hash_batch(env, items, HashAlgo::Blake3)
}

/// xxh3HexBatch(items: Buffer[]): Promise<string[]> — xxh3_64, lowercase hex, 16 chars per item
#[napi(ts_return_type = "Promise<string[]>")]
pub fn xxh3_hex_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    hash_batch(env, items, HashAlgo::Xxh3)
}

/// xxh64HexBatch(items: Buffer[]): Promise<string[]> — xxh64 seed 0, lowercase hex, 16 chars per item
#[napi(ts_return_type = "Promise<string[]>")]
pub fn xxh64_hex_batch<'env>(env: &'env Env, items: Vec<BufferSlice>) -> Result<Object<'env>> {
    hash_batch(env, items, HashAlgo::Xxh64)
}
