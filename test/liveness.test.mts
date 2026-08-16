// The event loop must keep ticking while a native batch runs on rayon
// threads. Zero ticks would mean the batch blocked the loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

test('event loop keeps ticking during a large native batch', async () => {
  // Sized so the batch takes well over a few interval periods even on many cores.
  const N = 3000;
  const A = Array.from({ length: N }, () => 'x'.repeat(400));
  const B = Array.from({ length: N }, () => 'y'.repeat(400));

  let ticks = 0;
  const iv = setInterval(() => ticks++, 5);
  try {
    const started = process.hrtime.bigint();
    const out = await b.levenshteinBatch(A, B);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(out.length, N);
    assert.ok(out.every((d) => d === 400)); // full substitution distance
    assert.ok(
      ticks > 0,
      `event loop never ticked during a ${elapsedMs.toFixed(0)}ms native batch (loop was blocked)`,
    );
  } finally {
    clearInterval(iv);
  }
});
