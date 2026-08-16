# Batch kernels

Every batch function takes an array, returns one promise, and spreads the work across all cores.

## Hashing and checksums

```js
const { sha256HexBatch, blake3HexBatch, xxh3HexBatch, crc32cHexBatch } = require('@offthread/threadmill');

const files = await Promise.all(paths.map((p) => fs.promises.readFile(p)));

const sha = await sha256HexBatch(files);      // ['9f86d08...', ...]
const fast = await xxh3HexBatch(files);       // 16-char hex, very fast, not cryptographic
```

## Compression

```js
const { gzipBatch, gunzipBatch, zstdCompressBatch, brotliCompressBatch } = require('@offthread/threadmill');

const compressed = await zstdCompressBatch(buffers, 3);   // level optional
const original = await gunzipBatch(gzippedBuffers);
```

## LLM token counting

Works offline, no API calls. Encodings: `cl100k_base` (GPT-4) and `o200k_base` (GPT-4o).

```js
const { countTokensBatch, truncateTokensBatch, chunkByTokensBatch } = require('@offthread/threadmill');

const counts = await countTokensBatch(documents, 'cl100k_base');

// cut every document to a budget, keeping the start
const trimmed = await truncateTokensBatch(documents, {
  encoding: 'cl100k_base',
  maxTokens: 8000,
});

// split into overlapping chunks for embeddings; each result is a JSON array of strings
const chunked = await chunkByTokensBatch(documents, {
  encoding: 'cl100k_base',
  maxTokens: 512,
  overlap: 64,
});
const chunks = chunked.map((c) => JSON.parse(c));
```

## CSV and NDJSON

One item = one whole file or chunk.

```js
const { csvToNdjsonBatch, ndjsonTransformBatch } = require('@offthread/threadmill');

const ndjson = await csvToNdjsonBatch([csvFileContents], { select: ['id', 'email'] });

// keep only error lines, project two fields; only survivors come back
const errors = await ndjsonTransformBatch(logChunks, {
  filter: [{ path: 'level', op: 'eq', value: 'error' }],
  project: ['ts', 'msg'],
});
```

## Multi-pattern search and replace

Backed by an automaton, so a thousand patterns cost about the same as one. No regex, no ReDoS.

```js
const { multiReplaceBatch, multiFindBatch } = require('@offthread/threadmill');

// redact a list of emails everywhere
const clean = await multiReplaceBatch(documents, {
  patterns: knownEmails,
  replacements: '[redacted]',
});

// find positions: each result is a JSON array of {p: patternIndex, s: start, e: end}
const hits = await multiFindBatch(documents, { patterns: ['error', 'panic', 'fatal'] });
```

## HTML and markdown

```js
const { sanitizeHtmlBatch, markdownToHtmlBatch, htmlExtractBatch } = require('@offthread/threadmill');

// user-generated content: markdown in, safe HTML out
const html = await markdownToHtmlBatch(comments);
const safe = await sanitizeHtmlBatch(html);

// scraping: pull one field out of each page with a CSS selector
const titles = await htmlExtractBatch(pages, { selector: 'h1', extract: 'text' });
const links = await htmlExtractBatch(pages, { selector: 'a.next', extract: { attr: 'href' } });
```

## Text comparison

```js
const { levenshteinBatch, similarityBatch, diffBatch } = require('@offthread/threadmill');

// paired arrays: result[i] compares a[i] with b[i]
const distances = await levenshteinBatch(oldTitles, newTitles);
const scores = await similarityBatch(queries, candidates, 'jaroWinkler');  // 0..1
const patches = await diffBatch(oldDocs, newDocs);                          // unified diff text
```
