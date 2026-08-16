use napi::bindgen_prelude::*;
use napi::Env;
use napi_derive::napi;
use rayon::prelude::*;

// Copy on the JS thread: V8-owned Buffer memory must not be touched off-thread.
fn owned_bytes(item: Either<BufferSlice, String>) -> Vec<u8> {
    match item {
        Either::A(buf) => buf.to_vec(),
        Either::B(s) => s.into_bytes(),
    }
}

// ---------------------------------------------------------------- validator
//
// Iterative RFC 8259 syntax check over the raw bytes: no value tree is built
// (serde_json::Value materialization was ~1.5x slower than JSON.parse) and no
// recursion happens (containers use an explicit Vec stack), so nesting depth
// is unlimited — deep documents validate true, matching JSON.parse.

/// Scan a string starting at the opening quote; advance `i` past the closing
/// quote. Escapes are the RFC set (`\" \\ \/ \b \f \n \r \t \uXXXX`); raw
/// control bytes < 0x20 are invalid; non-ASCII content must be valid UTF-8
/// (escape sequences are pure ASCII, so checking the raw span is sound).
fn scan_string(b: &[u8], i: &mut usize) -> bool {
    let n = b.len();
    if *i >= n || b[*i] != b'"' {
        return false;
    }
    *i += 1;
    let start = *i;
    let mut non_ascii = false;
    while *i < n {
        match b[*i] {
            b'"' => {
                if non_ascii && std::str::from_utf8(&b[start..*i]).is_err() {
                    return false;
                }
                *i += 1;
                return true;
            }
            b'\\' => {
                *i += 1;
                match b.get(*i) {
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => *i += 1,
                    Some(b'u') => {
                        // 4 hex digits; surrogate pairing is NOT enforced,
                        // matching JSON.parse (which accepts lone surrogates).
                        if *i + 4 >= n || !b[*i + 1..*i + 5].iter().all(u8::is_ascii_hexdigit) {
                            return false;
                        }
                        *i += 5;
                    }
                    _ => return false,
                }
            }
            0x00..=0x1F => return false,
            c => {
                non_ascii |= c >= 0x80;
                *i += 1;
            }
        }
    }
    false // unterminated
}

/// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?` — advances `i` past the
/// longest valid number; any trailing junk ("01", "1.2.3") is left for the
/// caller's delimiter check to reject.
fn scan_number(b: &[u8], i: &mut usize) -> bool {
    let n = b.len();
    if b[*i] == b'-' {
        *i += 1;
    }
    match b.get(*i) {
        Some(b'0') => *i += 1,
        Some(b'1'..=b'9') => while *i < n && b[*i].is_ascii_digit() {
            *i += 1;
        },
        _ => return false,
    }
    if *i < n && b[*i] == b'.' {
        *i += 1;
        if *i >= n || !b[*i].is_ascii_digit() {
            return false;
        }
        while *i < n && b[*i].is_ascii_digit() {
            *i += 1;
        }
    }
    if *i < n && (b[*i] | 0x20) == b'e' {
        *i += 1;
        if *i < n && (b[*i] == b'+' || b[*i] == b'-') {
            *i += 1;
        }
        if *i >= n || !b[*i].is_ascii_digit() {
            return false;
        }
        while *i < n && b[*i].is_ascii_digit() {
            *i += 1;
        }
    }
    true
}

fn json_valid(b: &[u8]) -> bool {
    #[derive(Clone, Copy)]
    enum Ctx {
        Obj,
        Arr,
    }
    macro_rules! skip_ws {
        ($i:ident) => {
            while $i < b.len() && matches!(b[$i], b' ' | b'\t' | b'\n' | b'\r') {
                $i += 1;
            }
        };
    }
    let n = b.len();
    let mut i = 0usize;
    let mut stack: Vec<Ctx> = Vec::new();
    'value: loop {
        // ---- parse one value starting at i ----
        skip_ws!(i);
        if i >= n {
            return false;
        }
        match b[i] {
            b'{' => {
                i += 1;
                skip_ws!(i);
                if i < n && b[i] == b'}' {
                    i += 1; // empty object = a completed value
                } else {
                    stack.push(Ctx::Obj);
                    if !scan_string(b, &mut i) {
                        return false;
                    }
                    skip_ws!(i);
                    if i >= n || b[i] != b':' {
                        return false;
                    }
                    i += 1;
                    continue 'value;
                }
            }
            b'[' => {
                i += 1;
                skip_ws!(i);
                if i < n && b[i] == b']' {
                    i += 1; // empty array = a completed value
                } else {
                    stack.push(Ctx::Arr);
                    continue 'value;
                }
            }
            b'"' => {
                if !scan_string(b, &mut i) {
                    return false;
                }
            }
            b't' => {
                if !b[i..].starts_with(b"true") {
                    return false;
                }
                i += 4;
            }
            b'f' => {
                if !b[i..].starts_with(b"false") {
                    return false;
                }
                i += 5;
            }
            b'n' => {
                if !b[i..].starts_with(b"null") {
                    return false;
                }
                i += 4;
            }
            b'-' | b'0'..=b'9' => {
                if !scan_number(b, &mut i) {
                    return false;
                }
            }
            _ => return false,
        }
        // ---- a value just ended: close containers / expect separators ----
        loop {
            skip_ws!(i);
            match stack.last() {
                None => return i >= n, // whole input must be consumed
                Some(Ctx::Obj) => {
                    if i >= n {
                        return false;
                    }
                    match b[i] {
                        b',' => {
                            i += 1;
                            skip_ws!(i);
                            if !scan_string(b, &mut i) {
                                return false;
                            }
                            skip_ws!(i);
                            if i >= n || b[i] != b':' {
                                return false;
                            }
                            i += 1;
                            continue 'value;
                        }
                        b'}' => {
                            i += 1;
                            stack.pop();
                        }
                        _ => return false,
                    }
                }
                Some(Ctx::Arr) => {
                    if i >= n {
                        return false;
                    }
                    match b[i] {
                        b',' => {
                            i += 1;
                            continue 'value;
                        }
                        b']' => {
                            i += 1;
                            stack.pop();
                        }
                        _ => return false,
                    }
                }
            }
        }
    }
}

/// jsonValidateBatch(items: Array<Buffer | string>): Promise<boolean[]>
///
/// Iterative RFC 8259 syntax check — no value tree is built and no recursion
/// happens, so nesting depth is unlimited (deep documents validate true,
/// matching JSON.parse). String content must be valid UTF-8; `\uXXXX` escapes
/// need 4 hex digits (lone surrogates are accepted, as JSON.parse does).
#[napi(ts_return_type = "Promise<boolean[]>")]
pub fn json_validate_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
) -> Result<Object<'env>> {
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    let (deferred, promise) = env.create_deferred::<Vec<bool>, _>()?;
    rayon::spawn(move || {
        let out: Vec<bool> = owned.par_iter().map(|b| json_valid(b)).collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}

/// jsonPluckBatch(items: Array<Buffer | string>, path: string): Promise<Array<string | null>>
///
/// Lazy gjson path extraction; `null` when the path does not exist. Strings
/// yield their raw content; objects/arrays/booleans/numbers and JSON null
/// yield their JSON text (a JSON null value is the string "null", NOT JS null).
#[napi(ts_return_type = "Promise<Array<string | null>>")]
pub fn json_pluck_batch<'env>(
    env: &'env Env,
    items: Vec<Either<BufferSlice, String>>,
    path: String,
) -> Result<Object<'env>> {
    if path.is_empty() {
        return Err(Error::new(Status::InvalidArg, "path must not be empty"));
    }
    let owned: Vec<Vec<u8>> = items.into_iter().map(owned_bytes).collect();
    let (deferred, promise) = env.create_deferred::<Vec<Option<String>>, _>()?;
    rayon::spawn(move || {
        let out: Vec<Option<String>> = owned
            .par_iter()
            .map(|b| {
                // Invalid UTF-8 cannot match any path -> null.
                let s = std::str::from_utf8(b).ok()?;
                let v = gjson::get(s, &path);
                if v.exists() {
                    // JSON null -> its JSON text "null" (bare str() would give "",
                    // indistinguishable from an empty string value).
                    Some(match v.kind() {
                        gjson::Kind::Null => "null".to_owned(),
                        _ => v.str().to_owned(),
                    })
                } else {
                    None
                }
            })
            .collect();
        deferred.resolve(move |_| Ok(out));
    });
    Ok(promise)
}
