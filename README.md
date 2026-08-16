# threadmill

Run batches of CPU-heavy work on native threads, from Node.js. One call processes a whole batch in parallel across your cores while the event loop keeps running.

```js
const { sha256HexBatch, pipeline } = require('@offthread/threadmill');

// one call, all cores
const hashes = await sha256HexBatch(buffers);

// or chain steps into a pipeline; intermediate results never touch JS
const emails = await pipeline()
  .gunzip()
  .jsonPluck('user.email')
  .lowercase()
  .sha256Hex()
  .run(gzippedDocs);
```

## Install

```
npm install @offthread/threadmill
```

Prebuilt binaries for macOS (x64/arm64), Linux (glibc and musl, x64/arm64) and Windows. Nothing compiles on install.

## Benchmarks

Times in ms, lower is better. The Node.js column is the fastest common way to do the same job in Node (a built-in module or the most popular package for that task). Same inputs everywhere, median of 5 runs after warmup, outputs verified identical. 10-core M-series MacBook, Node 26.

| task | Node.js | threadmill, 1 thread | threadmill, 5 threads | speedup |
|---|---|---|---|---|
| JSON field extraction | 873 | 164 | 40 | **22x** |
| markdown to HTML | 965 | 214 | 45 | **21x** |
| CSV to NDJSON | 879 | 164 | 44 | **20x** |
| levenshtein distance | 89 | 22 | 6 | **15x** |
| sort 14M floats | 1488 | 175 | 106 | **14x** |
| HTML extraction (CSS selectors) | 625 | 193 | 44 | **14x** |
| JSON validation | 216 | 68 | 15 | **14x** |
| token chunking (cl100k) | 395 | 149 | 31 | **13x** |
| token counting (cl100k) | 348 | 140 | 29 | **12x** |
| text diff | 919 | 344 | 86 | **11x** |
| HTML sanitization | 672 | 345 | 75 | **9x** |
| gzip | 511 | 297 | 63 | **8x** |
| NDJSON filter + project | 393 | 236 | 55 | **7x** |
| sha256 | 226 | 265 | 69 | **3x** |

The 1-thread column shows most of the engine is faster than Node before parallelism even starts. And the default is all your cores, not 5, so real numbers are usually better than the last column.

A few trivial byte-level ops (base64/hex encode, unicode normalize, trim) are faster as Node built-ins than as standalone calls here: copying data to native memory costs more than the work itself. Use those as pipeline steps instead, where data stays native between steps.

## What's included

| group | functions |
|---|---|
| HTML | `sanitizeHtmlBatch`, `markdownToHtmlBatch`, `htmlToTextBatch`, `htmlExtractBatch` (CSS selectors) |
| data | `csvToNdjsonBatch`, `ndjsonTransformBatch` (per-line filter + project), `jsonValidateBatch`, `jsonPluckBatch` |
| search | `multiReplaceBatch` / `multiFindBatch` (multi-pattern, ReDoS-immune), `regexTestBatch`, `regexCountBatch`, `regexReplaceBatch`, `regexExtractBatch` |
| LLM tokens | `countTokensBatch`, `truncateTokensBatch`, `chunkByTokensBatch` (`cl100k_base` / `o200k_base`, offline) |
| text | `levenshteinBatch`, `similarityBatch`, `diffBatch`, `normalizeBatch`, `lowercaseBatch` / `uppercaseBatch` / `trimBatch` |
| hashing | `sha256HexBatch`, `blake3HexBatch`, `xxh3HexBatch`, `xxh64HexBatch`, `crc32HexBatch`, `crc32cHexBatch` |
| compression | `gzipBatch` / `gunzipBatch`, `zstdCompressBatch` / `zstdDecompressBatch`, `brotliCompressBatch` / `brotliDecompressBatch` |
| encoding | `base64EncodeBatch` / `base64DecodeBatch`, `hexEncodeBatch` / `hexDecodeBatch` |
| sorting | `sortNumbers`, `sortStrings` |

Every batch function takes an array, returns one promise, and runs on all cores.

## Pipelines

Chain steps so each item flows through all of them on one native thread. No intermediate arrays back in JS, no GC pressure between steps.

```js
const { pipeline, files } = require('@offthread/threadmill');

// redact and recompress a day of logs
await pipeline()
  .gunzip()
  .ndjsonTransform({ filter: [{ path: 'level', op: 'eq', value: 'error' }], project: ['ts', 'msg'] })
  .multiReplace({ patterns: emails, replacements: '[redacted]' })
  .bytes()
  .zstdCompress()
  .writeFiles(files({ glob: 'logs/**/*.gz' }), { dir: 'out', ext: '.zst' });
```

Chains are type-checked: in TypeScript at compile time, in JS when you build the chain. `pipeline().gunzip().lowercase()` fails immediately, since gunzip outputs bytes and lowercase needs a string.

Inputs: `run(buffers)`, `run(strings)`, or `run(files([...paths]))` / `run(files({ glob: '...' }))` to read files off the main thread.

Endings: `run()` collects results, `count()` returns a number, `writeFiles()` writes results to disk natively, `stream()` gives an async iterator that yields results as they finish.

Errors: the first failing item rejects the batch with its index (`"item 3: gunzip: ..."`). Add `.settled()` for per-item `{ ok, value | error }` results instead. Bad arguments throw synchronously with `error.code === 'InvalidArg'`.

## Examples

- [Batch kernels](examples/batch-kernels.md) — hashing, compression, tokens, CSV/NDJSON, search, HTML, text comparison
- [Pipelines](examples/pipelines.md) — log processing, embedding prep, counting, streaming, reuse
- [Error handling](examples/error-handling.md) — sync validation, item errors, settled mode
- [Controlling threads](examples/threads.md) — defaults, 1 vs N threads, servers and containers
- [TypeScript](examples/typescript.md) — typed chains, compile-time checks, settled and streaming types

## Notes

- Default thread count is your logical core count. `configureThreads(n)` changes it, once, before first use. On a busy server leave a core free: `configureThreads(os.cpus().length - 1)`.
- `regexReplace` uses Rust regex replacement syntax: `$1` or `${1}` for groups, `$0` for the whole match.
- `jsonPluck` returns raw text for string values and JSON text otherwise. A JSON `null` value comes back as the string `"null"`, a missing path as JS `null`.
- Strings convert to UTF-8 at the boundary. Batches of Buffers are cheaper than batches of strings.
