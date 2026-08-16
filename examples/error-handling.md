# Error handling

## Bad arguments throw synchronously

Argument problems (wrong ranges, bad patterns, invalid chains) never reach the thread pool. They throw right away with `error.code === 'InvalidArg'`.

```js
const { gzipBatch, pipeline } = require('@offthread/threadmill');

try {
  await gzipBatch(buffers, 99);
} catch (e) {
  console.log(e.code);     // 'InvalidArg'
  console.log(e.message);  // 'gzip level must be 0-9, got 99'
}

// invalid chains fail at build time, before any data is touched
pipeline().gunzip().lowercase();  // throws: stage 1 (lowercase) expects Str input but receives Bytes
```

In TypeScript the invalid chain above does not even compile.

## Runtime failures reject with the item index

By default a batch is all-or-nothing: the first item that fails rejects the whole promise, and the message tells you which one.

```js
try {
  await gunzipBatch(mixedBuffers);
} catch (e) {
  console.log(e.message);  // 'item 3: gunzip: invalid gzip header'
}
```

## Per-item results with settled()

When some items are allowed to fail, switch the pipeline to settled mode and get a result per item instead of one rejection.

```js
const results = await pipeline()
  .gunzip()
  .jsonPluck('user.email')
  .settled()
  .run(buffers);

for (const [i, r] of results.entries()) {
  if (r.ok) save(r.value);
  else console.warn(`skipped ${i}: ${r.error}`);
}
```

`settled()` works with `stream()` too — failed items arrive as `{ index, ok: false, error }` instead of ending the iteration.
