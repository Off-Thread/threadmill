// Token kernel tests (countTokensBatch / truncateTokensBatch / chunkByTokensBatch).
//
// Note on per-item failure coverage: token kernels take JS strings (always
// valid UTF-8 after the napi conversion) and decode only tokens produced by
// the paired encoder, so the "item {i}: {op}: {cause}" path is structurally
// unreachable from JS — there is no input that triggers it. All reachable
// failures are synchronous InvalidArg config errors, asserted below.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

const CL = 'cl100k_base' as const;
const O2 = 'o200k_base' as const;

const TEXTS = [
  'The quick brown fox jumps over the lazy dog. '.repeat(20),
  '🚀🎉😀🐍🔥'.repeat(30), // multi-token emoji
  '这是一个用于测试的中文句子，'.repeat(15), // CJK
  'héllo wörld ünïcode '.repeat(25),
];

function assertInvalidArg(fn: () => unknown, re: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.match((err as Error).message, re);
    assert.equal((err as { code?: string }).code, 'InvalidArg');
    return true;
  });
}

// ---------------------------------------------------------------- counting

test('countTokensBatch: known cl100k_base token counts', async () => {
  // "hello" is a single cl100k token (15339); "hello world" encodes to 2.
  const got = await b.countTokensBatch(['', 'hello', 'hello world', 'a'], CL);
  assert.deepEqual(got, [0, 1, 2, 1]);
});

test('countTokensBatch is stable across calls and monotonic vs repetition', async () => {
  for (const enc of [CL, O2]) {
    const unit = 'The quick brown fox jumps over the lazy dog. ';
    const items = [unit, unit.repeat(4), unit.repeat(16)];
    const first = await b.countTokensBatch(items, enc);
    const second = await b.countTokensBatch(items, enc);
    assert.deepEqual(second, first, `${enc}: unstable counts`);
    assert.ok(first[0] >= 1);
    assert.ok(first[0] < first[1] && first[1] < first[2], `${enc}: not monotonic: ${first}`);
    // Token count never exceeds UTF-16 length for these texts and never hits 0.
    items.forEach((s, i) => assert.ok(first[i] >= 1 && first[i] <= s.length));
  }
});

test('countTokensBatch: the two encodings are independent vocabularies', async () => {
  const [cl] = await b.countTokensBatch(['The quick brown fox'], CL);
  const [o2] = await b.countTokensBatch(['The quick brown fox'], O2);
  assert.ok(cl >= 1 && o2 >= 1); // both count; exact values differ per vocab
});

test('countTokensBatch treats special-token text as plain text', async () => {
  const [n] = await b.countTokensBatch(['<|endoftext|>'], CL);
  assert.ok(n > 1, 'must NOT collapse to the single special token id');
});

// ---------------------------------------------------------------- truncation

test('truncateTokensBatch keep:start — budget respected, result is a prefix', async () => {
  for (const maxTokens of [1, 3, 7, 20]) {
    const out = await b.truncateTokensBatch(TEXTS, { encoding: CL, maxTokens });
    const counts = await b.countTokensBatch(out, CL);
    out.forEach((t, i) => {
      assert.ok(TEXTS[i].startsWith(t), `maxTokens=${maxTokens} item ${i}: not a prefix`);
      assert.ok(counts[i] <= maxTokens, `maxTokens=${maxTokens} item ${i}: count ${counts[i]}`);
      assert.ok(t.isWellFormed(), 'lone surrogates in output');
      assert.ok(!t.includes('�'), 'replacement char leaked into output');
    });
  }
});

test('truncateTokensBatch keep:end — budget respected, result is a suffix', async () => {
  for (const maxTokens of [1, 3, 7, 20]) {
    const out = await b.truncateTokensBatch(TEXTS, { encoding: CL, maxTokens, keep: 'end' });
    const counts = await b.countTokensBatch(out, CL);
    out.forEach((t, i) => {
      assert.ok(TEXTS[i].endsWith(t), `maxTokens=${maxTokens} item ${i}: not a suffix`);
      assert.ok(counts[i] <= maxTokens, `maxTokens=${maxTokens} item ${i}: count ${counts[i]}`);
      assert.ok(t.isWellFormed());
    });
  }
});

test('truncateTokensBatch defaults keep to start', async () => {
  const explicit = await b.truncateTokensBatch(TEXTS, { encoding: CL, maxTokens: 5, keep: 'start' });
  const implicit = await b.truncateTokensBatch(TEXTS, { encoding: CL, maxTokens: 5 });
  assert.deepEqual(implicit, explicit);
});

test('truncateTokensBatch passes within-budget items through byte-identical', async () => {
  const items = ['', 'hello world', 'héllo 🚀', '中文'];
  const counts = await b.countTokensBatch(items, CL);
  const budget = Math.max(...counts);
  // generous budget: everything passes through untouched
  assert.deepEqual(await b.truncateTokensBatch(items, { encoding: CL, maxTokens: 10_000 }), items);
  // exact budget: still untouched
  assert.deepEqual(await b.truncateTokensBatch(items, { encoding: CL, maxTokens: budget }), items);
});

test('truncateTokensBatch works on o200k_base too', async () => {
  const out = await b.truncateTokensBatch(TEXTS, { encoding: O2, maxTokens: 6 });
  const counts = await b.countTokensBatch(out, O2);
  out.forEach((t, i) => {
    assert.ok(TEXTS[i].startsWith(t));
    assert.ok(counts[i] <= 6);
    assert.ok(t.isWellFormed());
  });
});

test('truncateTokensBatch unicode safety: every tiny budget yields a valid string', async () => {
  const tricky = ['🚀🎉😀', '👨‍👩‍👧‍👦 family', '中文字符串测试', 'Ā̈stral \u{10348} mix'];
  for (let maxTokens = 1; maxTokens <= 8; maxTokens++) {
    for (const keep of ['start', 'end'] as const) {
      const out = await b.truncateTokensBatch(tricky, { encoding: CL, maxTokens, keep });
      out.forEach((t, i) => {
        assert.ok(t.isWellFormed(), `budget ${maxTokens} keep ${keep} item ${i}`);
        assert.ok(
          keep === 'start' ? tricky[i].startsWith(t) : tricky[i].endsWith(t),
          `budget ${maxTokens} keep ${keep} item ${i}: not a clean cut of the input`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------- chunking

test('chunkByTokensBatch overlap 0: chunks concatenate back to the exact input', async () => {
  for (const enc of [CL, O2]) {
    const out = await b.chunkByTokensBatch(TEXTS, { encoding: enc, maxTokens: 8 });
    out.forEach((json, i) => {
      const chunks: string[] = JSON.parse(json);
      assert.ok(chunks.length > 1, `${enc} item ${i}: expected multiple chunks`);
      assert.equal(chunks.join(''), TEXTS[i], `${enc} item ${i}: coverage broken`);
      for (const c of chunks) assert.ok(c.isWellFormed());
    });
  }
});

test('chunkByTokensBatch overlap 0: ASCII chunks respect the token budget', async () => {
  const [json] = await b.chunkByTokensBatch([TEXTS[0]], { encoding: CL, maxTokens: 8 });
  const chunks: string[] = JSON.parse(json);
  const counts = await b.countTokensBatch(chunks, CL);
  for (const n of counts) assert.ok(n <= 8, `chunk exceeded budget: ${n}`);
});

test('chunkByTokensBatch within-budget input yields a single chunk of the whole item', async () => {
  const items = ['hello world', 'héllo 🚀'];
  const out = await b.chunkByTokensBatch(items, { encoding: CL, maxTokens: 10_000 });
  assert.deepEqual(out.map((j) => JSON.parse(j)), [['hello world'], ['héllo 🚀']]);
});

test('chunkByTokensBatch with overlap: gapless, progressing, genuinely overlapping windows', async () => {
  // unique words -> every chunk locates unambiguously in the source
  const text = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
  const [json] = await b.chunkByTokensBatch([text], { encoding: CL, maxTokens: 12, overlap: 4 });
  const chunks: string[] = JSON.parse(json);
  assert.ok(chunks.length > 2);
  let prevStart = -1;
  let prevEnd = 0;
  for (const c of chunks) {
    const start = text.indexOf(c);
    assert.ok(start >= 0, 'chunk is not a substring of the input');
    assert.ok(start > prevStart, 'windows must advance');
    assert.ok(start <= prevEnd, 'gap between consecutive chunks');
    if (prevStart >= 0) assert.ok(start < prevEnd, 'consecutive chunks must overlap');
    prevStart = start;
    prevEnd = start + c.length;
  }
  assert.equal(chunks[0].slice(0, 5), text.slice(0, 5), 'first chunk starts at the beginning');
  assert.ok(text.endsWith(chunks[chunks.length - 1]), 'last chunk reaches the end');
  const counts = await b.countTokensBatch(chunks, CL);
  for (const n of counts) assert.ok(n <= 12);
});

// ---------------------------------------------------------------- edges

test('token kernels: empty batches and empty items', async () => {
  assert.deepEqual(await b.countTokensBatch([], CL), []);
  assert.deepEqual(await b.truncateTokensBatch([], { encoding: CL, maxTokens: 5 }), []);
  assert.deepEqual(await b.chunkByTokensBatch([], { encoding: CL, maxTokens: 5 }), []);
  assert.deepEqual(await b.countTokensBatch([''], CL), [0]);
  assert.deepEqual(await b.truncateTokensBatch([''], { encoding: CL, maxTokens: 1 }), ['']);
  assert.deepEqual(await b.chunkByTokensBatch([''], { encoding: CL, maxTokens: 1 }), ['[]']);
});

// ---------------------------------------------------------------- validation

test('token kernels: unknown encoding throws InvalidArg listing both options', () => {
  const re = /unknown encoding 'gpt2'.*'cl100k_base' or 'o200k_base'/;
  assertInvalidArg(() => b.countTokensBatch(['x'], 'gpt2' as never), re);
  assertInvalidArg(() => b.truncateTokensBatch(['x'], { encoding: 'gpt2' as never, maxTokens: 5 }), re);
  assertInvalidArg(() => b.chunkByTokensBatch(['x'], { encoding: 'gpt2' as never, maxTokens: 5 }), re);
});

test('truncateTokensBatch validates maxTokens and keep synchronously', () => {
  assertInvalidArg(
    () => b.truncateTokensBatch(['x'], { encoding: CL, maxTokens: 0 }),
    /truncateTokens: maxTokens must be >= 1, got 0/,
  );
  assertInvalidArg(
    () => b.truncateTokensBatch(['x'], { encoding: CL, maxTokens: -3 }),
    /maxTokens must be >= 1/,
  );
  assertInvalidArg(
    () => b.truncateTokensBatch(['x'], { encoding: CL, maxTokens: 5, keep: 'middle' as never }),
    /truncateTokens: keep must be 'start' or 'end', got 'middle'/,
  );
});

test('chunkByTokensBatch validates maxTokens and overlap synchronously', () => {
  assertInvalidArg(
    () => b.chunkByTokensBatch(['x'], { encoding: CL, maxTokens: 0 }),
    /chunkByTokens: maxTokens must be >= 1, got 0/,
  );
  assertInvalidArg(
    () => b.chunkByTokensBatch(['x'], { encoding: CL, maxTokens: 4, overlap: 4 }),
    /chunkByTokens: overlap must be >= 0 and < maxTokens \(4\), got 4/,
  );
  assertInvalidArg(
    () => b.chunkByTokensBatch(['x'], { encoding: CL, maxTokens: 4, overlap: 9 }),
    /overlap must be >= 0 and < maxTokens/,
  );
  assertInvalidArg(
    () => b.chunkByTokensBatch(['x'], { encoding: CL, maxTokens: 4, overlap: -1 }),
    /overlap must be >= 0 and < maxTokens/,
  );
});
