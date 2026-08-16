# Pipelines

A pipeline chains steps so each item flows through all of them on one native thread. Intermediate results never come back to JS between steps, which is where most of the speed comes from.

## Process a directory of logs

Read, decompress, filter, redact, recompress and write — one expression, nothing crosses into JS.

```js
const { pipeline, files } = require('@offthread/threadmill');

const written = await pipeline()
  .gunzip()
  .ndjsonTransform({
    filter: [{ path: 'status', op: 'gt', value: 499 }],
    project: ['ts', 'path', 'status', 'user.email'],
  })
  .multiReplace({ patterns: internalHosts, replacements: '[internal]' })
  .bytes()
  .zstdCompress()
  .writeFiles(files({ glob: 'logs/2026-08-*/**.gz' }), { dir: 'incidents', ext: '.zst' });

console.log(`wrote ${written.length} files`);
```

## Prepare scraped pages for embedding

Fetch stays in JS (network is not CPU work); everything after runs native.

```js
const pages = await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer())));
const buffers = pages.map((p) => Buffer.from(p));

const prepared = await pipeline()
  .htmlExtract({ selector: 'article', extract: 'text' })
  .normalize('NFC')
  .truncateTokens({ encoding: 'cl100k_base', maxTokens: 8000 })
  .run(buffers);
```

## Count without collecting

When you only need a number, the results never cross back at all.

```js
const errorCount = await pipeline()
  .gunzip()
  .ndjsonTransform({ filter: [{ path: 'level', op: 'eq', value: 'error' }] })
  .count(files({ glob: 'logs/**/*.gz' }));
```

## Stream results as they finish

Items complete in whatever order the threads finish them; `index` tells you which is which.

```js
for await (const { index, value } of pipeline().gunzip().jsonPluck('user.id').stream(buffers)) {
  console.log(`item ${index}: ${value}`);
}
```

## Reuse a pipeline

A pipeline object is immutable and compiles its plan once. Build it at startup and call it per request.

```js
const redact = pipeline()
  .multiReplace({ patterns: piiPatterns, replacements: '[redacted]' })
  .sha256Hex();

app.post('/ingest', async (req, res) => {
  res.json(await redact.run(req.body.records));
});
```
