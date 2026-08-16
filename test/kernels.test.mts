// Kernel tests hit the native binding directly; the fluent builder has its own
// tests in pipeline.test.mts.
// Default-import the generated loader and use it namespaced — named ESM
// imports from the CJS binding via the lexer are unreliable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import b from '@offthread/threadmill';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// ---------------------------------------------------------------- hashing

test('sha256HexBatch matches node:crypto for varied inputs', async () => {
  const items = [
    Buffer.alloc(0),
    Buffer.from('abc'),
    Buffer.from('héllo wörld 🚀'),
    crypto.randomBytes(1024),
    crypto.randomBytes(100_000),
  ];
  const got = await b.sha256HexBatch(items);
  const want = items.map((x) => crypto.createHash('sha256').update(x).digest('hex'));
  assert.deepEqual(got, want);
  for (const h of got) assert.match(h, HEX64);
});

test('blake3HexBatch official known-answer vectors', async () => {
  // Official BLAKE3 test vectors (github.com/BLAKE3-team/BLAKE3 test_vectors.json).
  const got = await b.blake3HexBatch([Buffer.alloc(0), Buffer.from('abc')]);
  assert.equal(got[0], 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(got[1], '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
});

test('blake3HexBatch is deterministic and 64 lowercase hex chars', async () => {
  const items = [crypto.randomBytes(64), crypto.randomBytes(64)];
  const [a, c] = [await b.blake3HexBatch(items), await b.blake3HexBatch(items)];
  assert.deepEqual(a, c);
  for (const h of a) assert.match(h, HEX64);
  assert.notEqual(a[0], a[1]);
});

test('xxh64HexBatch: known empty vector + properties', async () => {
  // Known xxh64 value for empty input, seed 0.
  const [empty] = await b.xxh64HexBatch([Buffer.alloc(0)]);
  assert.equal(empty, 'ef46db3751d8e999');

  const items = [Buffer.from('a'), Buffer.from('b'), Buffer.from('a')];
  const got = await b.xxh64HexBatch(items);
  for (const h of got) assert.match(h, HEX16);
  assert.equal(got[0], got[2]); // deterministic
  assert.notEqual(got[0], got[1]); // differs across inputs
  assert.deepEqual(await b.xxh64HexBatch(items), got); // stable across calls
});

test('xxh3HexBatch: deterministic, 16 lowercase hex chars, input-sensitive', async () => {
  const items = [Buffer.alloc(0), Buffer.from('hello'), Buffer.from('hello!'), Buffer.from('hello')];
  const got = await b.xxh3HexBatch(items);
  for (const h of got) assert.match(h, HEX16);
  assert.equal(got[1], got[3]);
  assert.notEqual(got[1], got[2]);
  assert.deepEqual(await b.xxh3HexBatch(items), got);
});

// ---------------------------------------------------------------- compression

const SAMPLES = [
  Buffer.alloc(0),
  Buffer.from('hello hello hello hello'),
  Buffer.from(JSON.stringify({ user: { email: 'A@B.com', bio: 'é🚀'.repeat(50) } })),
  crypto.randomBytes(50_000), // incompressible
];

test('gzipBatch round-trips through gunzipBatch', async () => {
  const packed = await b.gzipBatch(SAMPLES);
  const back = await b.gunzipBatch(packed);
  assert.deepEqual(back, SAMPLES);
  for (const p of packed) assert.ok(Buffer.isBuffer(p));
});

test('gzipBatch output is valid gzip for node:zlib', async () => {
  const packed = await b.gzipBatch(SAMPLES);
  packed.forEach((p, i) => assert.deepEqual(zlib.gunzipSync(p), SAMPLES[i]));
});

test('gunzipBatch decodes node:zlib gzipSync output', async () => {
  const packed = SAMPLES.map((s) => zlib.gzipSync(s));
  assert.deepEqual(await b.gunzipBatch(packed), SAMPLES);
});

test('gzipBatch honors compression level and validates the range', async () => {
  const big = Buffer.from('abcdef'.repeat(10_000));
  const [stored] = await b.gzipBatch([big], 0);
  const [best] = await b.gzipBatch([big], 9);
  assert.ok(stored.length > big.length * 0.9); // level 0 = stored, no real shrink
  assert.ok(best.length < big.length / 10);
  // Param validation happens on the JS thread -> throws synchronously.
  assert.throws(() => b.gzipBatch([big], 12), /level must be 0-9/);
});

test('zstd round-trips, honors level, validates the range', async () => {
  const packed = await b.zstdCompressBatch(SAMPLES);
  assert.deepEqual(await b.zstdDecompressBatch(packed), SAMPLES);
  const big = Buffer.from('abcdef'.repeat(10_000));
  const [lvl19] = await b.zstdCompressBatch([big], 19);
  assert.deepEqual(await b.zstdDecompressBatch([lvl19]), [big]);
  assert.throws(() => b.zstdCompressBatch([big], 99), /level must be 1-22/);
  assert.throws(() => b.zstdCompressBatch([big], 0), /level must be 1-22/);
});

test('corrupt input rejects the batch and names the failing item index', async () => {
  const good = zlib.gzipSync(Buffer.from('fine'));
  await assert.rejects(
    b.gunzipBatch([good, Buffer.from('definitely not gzip')]),
    (err: unknown) => {
      assert.match((err as Error).message, /item 1/);
      assert.match((err as Error).message, /gunzip/);
      return true;
    },
  );
  const goodZ = (await b.zstdCompressBatch([Buffer.from('fine')]))[0];
  await assert.rejects(
    b.zstdDecompressBatch([goodZ, Buffer.from('garbage')]),
    (err: unknown) => {
      assert.match((err as Error).message, /item 1/);
      assert.match((err as Error).message, /zstdDecompress/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- json

test('jsonValidateBatch: per-item verdicts, never rejects, Buffer|string', async () => {
  const got = await b.jsonValidateBatch([
    Buffer.from('{"a":1}'),
    '[1,2,3]',
    '42',
    Buffer.from('{"a":'),
    'not json',
    Buffer.from('"héllo 🚀"'),
  ]);
  assert.deepEqual(got, [true, true, true, false, false, true]);
});

test('jsonValidateBatch has no nesting-depth limit, matching JSON.parse', async () => {
  // The iterative validator uses an explicit stack — depth 10k is far past
  // serde_json's old 128-level recursion limit and fine for JSON.parse too.
  const deep = '['.repeat(10_000) + ']'.repeat(10_000);
  assert.doesNotThrow(() => JSON.parse(deep));
  const unbalanced = '['.repeat(10_000) + ']'.repeat(9_999);
  assert.deepEqual(await b.jsonValidateBatch([deep, Buffer.from(deep), unbalanced]), [
    true,
    true,
    false,
  ]);
});

test('jsonPluckBatch: nested paths, missing path -> null, unicode, objects as JSON', async () => {
  const doc = JSON.stringify({ user: { email: 'A@B.com', name: 'héllo 🚀', tags: ['x', 'y'] } });
  assert.deepEqual(await b.jsonPluckBatch([Buffer.from(doc), doc], 'user.email'), ['A@B.com', 'A@B.com']);
  assert.deepEqual(await b.jsonPluckBatch([doc], 'user.name'), ['héllo 🚀']);
  assert.deepEqual(await b.jsonPluckBatch([doc], 'user.tags.1'), ['y']);
  assert.deepEqual(await b.jsonPluckBatch([doc, '{"x":1}'], 'user.missing'), [null, null]);
  // objects/arrays come back as their JSON text
  assert.deepEqual(await b.jsonPluckBatch(['{"a":{"b":[1,2]}}'], 'a'), ['{"b":[1,2]}']);
});

// ---------------------------------------------------------------- levenshtein

test('levenshteinBatch known distances', async () => {
  const a = ['kitten', 'flaw', '', 'same', 'héllo'];
  const c = ['sitting', 'lawn', 'abc', 'same', 'hello'];
  assert.deepEqual(await b.levenshteinBatch(a, c), [3, 2, 3, 0, 1]);
});

test('levenshteinBatch throws synchronously on length mismatch', () => {
  assert.throws(() => b.levenshteinBatch(['a'], []), /equal length/);
});

test('levenshteinEach returns one promise per pair, works with Promise.all', async () => {
  const promises = b.levenshteinEach(['kitten', 'flaw'], ['sitting', 'lawn']);
  assert.equal(promises.length, 2);
  for (const p of promises) assert.equal(typeof p.then, 'function');
  assert.deepEqual(await Promise.all(promises), [3, 2]);
});

// ---------------------------------------------------------------- normalize

test('normalizeBatch NFC vs NFD', async () => {
  const composed = 'é'; // é as one code point
  const decomposed = 'é'; // e + combining acute
  assert.deepEqual(await b.normalizeBatch([decomposed, composed], 'NFC'), [composed, composed]);
  assert.deepEqual(await b.normalizeBatch([composed, decomposed], 'NFD'), [decomposed, decomposed]);
  // NFKC folds compatibility characters, NFC does not
  assert.deepEqual(await b.normalizeBatch(['ﬁ'], 'NFC'), ['ﬁ']); // ﬁ ligature
  assert.deepEqual(await b.normalizeBatch(['ﬁ'], 'NFKC'), ['fi']);
  assert.throws(() => b.normalizeBatch(['x'], 'BAD' as any), /unknown normalization form/);
});

// ---------------------------------------------------------------- sort

test('sortNumbers matches Array.sort on finite values', async () => {
  const values = Array.from({ length: 10_000 }, () => Math.random() * 2e6 - 1e6);
  const got = await b.sortNumbers(new Float64Array(values));
  assert.ok(got instanceof Float64Array);
  assert.deepEqual(Array.from(got), [...values].sort((x, y) => x - y));
});

test('sortNumbers uses f64::total_cmp order for NaN and ±0/±Infinity', async () => {
  // total_cmp: -NaN < -Inf < ... < -0 < +0 < ... < +Inf < +NaN.
  // JS NaN literals carry a positive sign bit, so they sort to the END.
  const got = Array.from(await b.sortNumbers(new Float64Array([NaN, 3, -Infinity, -0, 0, Infinity, 1])));
  assert.deepEqual(got.slice(0, 6), [-Infinity, -0, 0, 1, 3, Infinity]);
  assert.ok(Object.is(got[1], -0), '-0 sorts before +0');
  assert.ok(Object.is(got[2], 0));
  assert.ok(Number.isNaN(got[6]), 'positive NaN sorts last');
});

test('sortNumbers does not mutate its input', async () => {
  const input = new Float64Array([3, 1, 2]);
  await b.sortNumbers(input);
  assert.deepEqual(Array.from(input), [3, 1, 2]);
});

test('sortStrings sorts by Unicode scalar value, not UTF-16 code units', async () => {
  assert.deepEqual(await b.sortStrings(['b', 'a', 'Z', 'ä']), ['Z', 'a', 'b', 'ä']);
  // U+10000 (surrogate pair, lead 0xD800) vs U+FF61: code-unit order would put
  // U+10000 first; scalar order puts U+FF61 first. Rust Ord on str = scalar order.
  assert.deepEqual(await b.sortStrings(['\u{10000}', '｡']), ['｡', '\u{10000}']);
  const words = ['pear', 'apple', 'Apple', 'banana', ''];
  assert.deepEqual(await b.sortStrings(words), [...words].sort()); // agrees on BMP-only ASCII/Latin
});

// ---------------------------------------------------------------- empty batches

test('empty batches resolve to empty results everywhere', async () => {
  assert.deepEqual(await b.sha256HexBatch([]), []);
  assert.deepEqual(await b.blake3HexBatch([]), []);
  assert.deepEqual(await b.xxh3HexBatch([]), []);
  assert.deepEqual(await b.xxh64HexBatch([]), []);
  assert.deepEqual(await b.gzipBatch([]), []);
  assert.deepEqual(await b.gunzipBatch([]), []);
  assert.deepEqual(await b.zstdCompressBatch([]), []);
  assert.deepEqual(await b.zstdDecompressBatch([]), []);
  assert.deepEqual(await b.jsonValidateBatch([]), []);
  assert.deepEqual(await b.jsonPluckBatch([], 'a.b'), []);
  assert.deepEqual(await b.levenshteinBatch([], []), []);
  assert.deepEqual(b.levenshteinEach([], []), []);
  assert.deepEqual(await b.normalizeBatch([], 'NFC'), []);
  assert.deepEqual(await b.sortStrings([]), []);
  const sorted = await b.sortNumbers(new Float64Array(0));
  assert.ok(sorted instanceof Float64Array);
  assert.equal(sorted.length, 0);
});

// ---------------------------------------------------------------- pool info

test('threadCount reports a positive pool size', () => {
  assert.ok(Number.isInteger(b.threadCount()));
  assert.ok(b.threadCount() >= 1);
});

test('gunzipBatch decodes ALL members of a multi-member gzip file (like node:zlib)', async () => {
  const multi = Buffer.concat([zlib.gzipSync('hello '), zlib.gzipSync('world')]);
  assert.equal(zlib.gunzipSync(multi).toString(), 'hello world');
  const [out] = await b.gunzipBatch([multi]);
  assert.equal(out.toString(), 'hello world');
});

test('gunzipBatch rejects trailing garbage after the gzip stream (like node:zlib)', async () => {
  const garbage = Buffer.concat([zlib.gzipSync('ok'), Buffer.from('NOT GZIP')]);
  assert.throws(() => zlib.gunzipSync(garbage));
  // flate2 rejects header-shaped garbage itself; our strict check catches the rest.
  await assert.rejects(b.gunzipBatch([garbage]), (err: unknown) => {
    assert.match((err as Error).message, /^item 0: gunzip: /);
    return true;
  });
});

test('jsonPluckBatch: JSON null value yields the string "null", missing path yields JS null', async () => {
  const out = await b.jsonPluckBatch(['{"a":null}', '{"b":1}', '{"a":""}'], 'a');
  assert.deepEqual(out, ['null', null, '']);
});

test('package boundary: internal files are not importable subpaths', async () => {
  // Only the root entry (and package.json) are exported — binding.js and
  // lib/pipeline.js are internal layout, not public API.
  for (const sub of ['binding.js', 'lib/pipeline.js']) {
    await assert.rejects(import(`@offthread/threadmill/${sub}`), (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      return true;
    });
  }
});
