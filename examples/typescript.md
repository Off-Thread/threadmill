# TypeScript

The package ships full typings. Pipelines carry their value type through the chain, so mistakes fail at compile time, not at runtime.

## Typed chains

```ts
import { pipeline, files } from '@offthread/threadmill';

// ok: bytes -> bytes -> string -> string
const out = await pipeline()
  .gunzip()
  .jsonPluck('user.email')
  .lowercase()
  .run(buffers);          // typed as string[]

// compile error: gunzip outputs bytes, lowercase needs a string
pipeline().gunzip().lowercase();
//                  ~~~~~~~~~ Property 'lowercase' does not exist ...
```

The result type follows the chain too:

```ts
const bufs = await pipeline().gzip().run(buffers);       // Buffer[]
const strs = await pipeline().sha256Hex().run(buffers);  // string[]
const n = await pipeline().sha256Hex().count(buffers);   // number
```

## Input types follow the first step

A chain that starts with a bytes step accepts `Buffer[]` or `files(...)`; one that starts with a string step accepts `string[]`:

```ts
pipeline().gunzip().run(['not bytes']);
//                       ~~~~~~~~~~~ Type 'string' is not assignable to 'Buffer'
```

## Settled mode is typed

```ts
const results = await pipeline().gunzip().settled().run(buffers);
// Array<{ ok: true, value: Buffer } | { ok: false, error: string }>

for (const r of results) {
  if (r.ok) use(r.value);   // narrowed to Buffer
  else log(r.error);        // narrowed to string
}
```

## Streaming

```ts
for await (const item of pipeline().sha256Hex().stream(buffers)) {
  // item: { index: number, value: string }
}
```
