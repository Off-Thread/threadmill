# Controlling threads

## The default

threadmill uses all your logical cores. Nothing to configure:

```js
const { threadCount, sha256HexBatch } = require('@offthread/threadmill');

console.log(threadCount());        // e.g. 10
await sha256HexBatch(buffers);     // runs on 10 threads
```

## Setting the thread count

`configureThreads(n)` works once per process, and only before the first batch runs. After any native call the pool is locked in.

```js
const { configureThreads, threadCount } = require('@offthread/threadmill');

configureThreads(4);
console.log(threadCount());  // 4, for the lifetime of this process
```

## Leave a core for the event loop

On a server that does other work, giving threadmill everything can starve request handling. A good default:

```js
const os = require('node:os');
configureThreads(os.availableParallelism() - 1);
```

Call it once at startup, before anything else touches the library.

## Single thread

Useful for measuring, or for keeping the library polite inside a constrained container:

```js
configureThreads(1);
```

Even at one thread most functions beat their JS equivalents, since the work itself runs as native code. Threads multiply that.

## Comparing 1 thread vs N threads

Because the pool locks after first use, each configuration needs its own process:

```js
// bench.mjs
import { execFileSync } from 'node:child_process';

for (const threads of [1, 2, 5]) {
  const out = execFileSync(process.execPath, ['-e', `
    const { configureThreads, gzipBatch } = require('@offthread/threadmill');
    configureThreads(${threads});
    const items = Array.from({ length: 2000 }, () => Buffer.alloc(65536, 7));
    gzipBatch(items).then(() => {});  // warmup
    (async () => {
      await gzipBatch(items);
      const t = process.hrtime.bigint();
      await gzipBatch(items);
      console.log('${threads} threads:', Number(process.hrtime.bigint() - t) / 1e6, 'ms');
    })();
  `]);
  process.stdout.write(out);
}
```

## In containers

`availableParallelism()` reflects the container's CPU limit on recent Node versions. If you pin CPU quotas, set the pool to match:

```js
configureThreads(Number(process.env.CPU_LIMIT ?? os.availableParallelism()));
```
