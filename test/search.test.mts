// Search kernel tests: aho-corasick multi-pattern replace/find, regex
// predicates, byte lengths. Hits the native binding directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

type FindMatch = { p: number; s: number; e: number };
const findAll = async (items: string[], cfg: Parameters<typeof b.multiFindBatch>[1]) =>
  (await b.multiFindBatch(items, cfg)).map((json) => JSON.parse(json) as FindMatch[]);

// ---------------------------------------------------------------- multiReplaceBatch

test('multiReplaceBatch: per-pattern replacements, multiple items', async () => {
  const got = await b.multiReplaceBatch(['the cat sat', 'dog dog', 'no pets here'], {
    patterns: ['cat', 'dog'],
    replacements: ['feline', 'canine'],
  });
  assert.deepEqual(got, ['the feline sat', 'canine canine', 'no pets here']);
});

test('multiReplaceBatch: leftmost-longest wins over pattern order', async () => {
  // "ab" appears FIRST in the list; leftmost-longest still picks "abcd".
  const got = await b.multiReplaceBatch(['abcd!'], {
    patterns: ['ab', 'abcd'],
    replacements: ['SHORT', 'LONG'],
  });
  assert.deepEqual(got, ['LONG!']);
  // Overlap where the longer pattern starts later: leftmost still wins.
  const got2 = await b.multiReplaceBatch(['xhello'], {
    patterns: ['xhe', 'hello'],
    replacements: ['A', 'B'],
  });
  assert.deepEqual(got2, ['Allo']);
});

test('multiReplaceBatch: single-string replacement broadcasts to all patterns', async () => {
  const got = await b.multiReplaceBatch(['a b c'], {
    patterns: ['a', 'b', 'c'],
    replacements: '_',
  });
  assert.deepEqual(got, ['_ _ _']);
});

test('multiReplaceBatch: PII-style redaction fixture', async () => {
  const docs = [
    'Report for John Doe (SSN 123-45-6789).',
    'Email john.doe@example.com about the John Doe account.',
    'Nothing sensitive in this line.',
  ];
  const got = await b.multiReplaceBatch(docs, {
    patterns: ['John Doe', 'john.doe@example.com', '123-45-6789'],
    replacements: '[REDACTED]',
  });
  assert.deepEqual(got, [
    'Report for [REDACTED] (SSN [REDACTED]).',
    'Email [REDACTED] about the [REDACTED] account.',
    'Nothing sensitive in this line.',
  ]);
});

test('multiReplaceBatch: caseInsensitive folds ASCII letters', async () => {
  const got = await b.multiReplaceBatch(['CAT cat CaT', 'catapult'], {
    patterns: ['cat'],
    replacements: 'dog',
    caseInsensitive: true,
  });
  assert.deepEqual(got, ['dog dog dog', 'dogapult']);
  // Off by default: only the exact-case occurrence is replaced.
  const exact = await b.multiReplaceBatch(['CAT cat'], {
    patterns: ['cat'],
    replacements: 'dog',
  });
  assert.deepEqual(exact, ['CAT dog']);
});

test('multiReplaceBatch: unicode content survives, byte-safe splicing', async () => {
  const got = await b.multiReplaceBatch(['héllo 🚀 wörld'], {
    patterns: ['🚀'],
    replacements: ['🛰️'],
  });
  assert.deepEqual(got, ['héllo 🛰️ wörld']);
});

test('multiReplaceBatch validation: sync InvalidArg errors', () => {
  // Empty patterns array.
  assert.throws(
    () => b.multiReplaceBatch(['x'], { patterns: [], replacements: 'y' }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /multiReplace: patterns must not be empty/);
      return true;
    },
  );
  // Replacements array length mismatch.
  assert.throws(
    () => b.multiReplaceBatch(['x'], { patterns: ['a', 'b'], replacements: ['only-one'] }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /replacements length 1 != patterns length 2/);
      return true;
    },
  );
  // Empty pattern string, named by index.
  assert.throws(
    () => b.multiReplaceBatch(['x'], { patterns: ['ok', ''], replacements: 'y' }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /patterns\[1\] must not be empty/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- multiFindBatch

test('multiFindBatch: JSON matches with pattern index and byte offsets', async () => {
  const [m] = await findAll(['the cat saw the dog'], { patterns: ['cat', 'dog'] });
  assert.deepEqual(m, [
    { p: 0, s: 4, e: 7 },
    { p: 1, s: 16, e: 19 },
  ]);
});

test('multiFindBatch: leftmost-longest, non-overlapping', async () => {
  // "abcd" (p=1) beats the earlier-listed "ab"; the consumed span is not re-matched.
  const [m] = await findAll(['abcdab'], { patterns: ['ab', 'abcd'] });
  assert.deepEqual(m, [
    { p: 1, s: 0, e: 4 },
    { p: 0, s: 4, e: 6 },
  ]);
});

test('multiFindBatch: offsets are BYTE offsets in UTF-8', async () => {
  // 'é' is 2 bytes, so "cat" starts at byte 2 (JS string index would be 1).
  const [m] = await findAll(['écat'], { patterns: ['cat'] });
  assert.deepEqual(m, [{ p: 0, s: 2, e: 5 }]);
});

test('multiFindBatch: caseInsensitive and limit per item', async () => {
  const [m] = await findAll(['Cat CAT cat'], { patterns: ['cat'], caseInsensitive: true });
  assert.equal(m.length, 3);
  const [capped] = await findAll(['Cat CAT cat'], {
    patterns: ['cat'],
    caseInsensitive: true,
    limit: 2,
  });
  assert.deepEqual(capped, [
    { p: 0, s: 0, e: 3 },
    { p: 0, s: 4, e: 7 },
  ]);
});

test('multiFindBatch: no matches and empty items yield "[]"', async () => {
  assert.deepEqual(await b.multiFindBatch(['nothing here', ''], { patterns: ['zzz'] }), ['[]', '[]']);
});

test('multiFindBatch validation: sync InvalidArg errors', () => {
  assert.throws(
    () => b.multiFindBatch(['x'], { patterns: [] }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /multiFind: patterns must not be empty/);
      return true;
    },
  );
  assert.throws(
    () => b.multiFindBatch(['x'], { patterns: ['a'], limit: 0 }),
    (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /multiFind: limit must be >= 1/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- regex kernels

test('regexTestBatch: per-item booleans', async () => {
  const got = await b.regexTestBatch(['user@example.com', 'not-an-email', 'x@y.io', ''], '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$');
  assert.deepEqual(got, [true, false, true, false]);
});

test('regexCountBatch: non-overlapping match counts', async () => {
  const got = await b.regexCountBatch(['a1b22c333', 'no digits', '', '007'], '\\d+');
  assert.deepEqual(got, [3, 0, 0, 1]);
  // Non-overlapping: "aaaa" contains two disjoint "aa" matches, not three.
  assert.deepEqual(await b.regexCountBatch(['aaaa'], 'aa'), [2]);
});

test('regexTestBatch/regexCountBatch: unicode-aware classes', async () => {
  assert.deepEqual(await b.regexTestBatch(['héllo', '12345'], '^\\p{L}+$'), [true, false]);
  assert.deepEqual(await b.regexCountBatch(['é é é'], 'é'), [3]);
});

test('regex kernels: invalid pattern throws sync InvalidArg naming the pattern', () => {
  for (const call of [
    () => b.regexTestBatch(['x'], '(unclosed'),
    () => b.regexCountBatch(['x'], '(unclosed'),
  ]) {
    assert.throws(call, (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /invalid regex '\(unclosed'/);
      return true;
    });
  }
});

// ---------------------------------------------------------------- byteLenBatch

test('byteLenBatch: UTF-8 byte lengths for strings and raw lengths for Buffers', async () => {
  const got = await b.byteLenBatch([
    '', // 0
    'abc', // 3
    'é', // 2 bytes in UTF-8
    '🚀', // 4 bytes
    'héllo 🚀', // 5 ascii + 2 + space... = Buffer.byteLength
    Buffer.alloc(0),
    Buffer.from([1, 2, 3, 4, 5]),
    Buffer.from('é'),
  ]);
  assert.deepEqual(got, [0, 3, 2, 4, Buffer.byteLength('héllo 🚀'), 0, 5, 2]);
});

// ---------------------------------------------------------------- empty batches

test('empty batches resolve to empty results', async () => {
  assert.deepEqual(await b.multiReplaceBatch([], { patterns: ['a'], replacements: 'b' }), []);
  assert.deepEqual(await b.multiFindBatch([], { patterns: ['a'] }), []);
  assert.deepEqual(await b.regexTestBatch([], 'x'), []);
  assert.deepEqual(await b.regexCountBatch([], 'x'), []);
  assert.deepEqual(await b.byteLenBatch([]), []);
});
