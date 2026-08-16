// Text diff / similarity kernels (src/kernels/diff.rs) and the string/regex
// batch kernels (src/kernels/parity.rs).
// Run: node --test test/textdiff.test.mts
// Note: none of these kernels has per-item runtime failures — diff/similarity
// are total over strings, and regexExtractBatch maps no-match to null — so the
// error surface here is entirely synchronous InvalidArg validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

const { pipeline } = b;

const invalidArg = (re: RegExp) => (err: unknown) => {
  assert.equal((err as { code?: string }).code, 'InvalidArg');
  assert.match((err as Error).message, re);
  return true;
};

// ---------------------------------------------------------------- diffBatch

test('diffBatch known unified diff fixture', async () => {
  const a = 'line1\nline2\nline3\n';
  const c = 'line1\nlineX\nline3\n';
  const [d] = await b.diffBatch([a], [c]);
  assert.equal(d, '@@ -1,3 +1,3 @@\n line1\n-line2\n+lineX\n line3\n');
});

test('diffBatch honors the context option', async () => {
  const a = 'line1\nline2\nline3\n';
  const c = 'line1\nlineX\nline3\n';
  // context 0: no unchanged lines around the hunk
  const [d0] = await b.diffBatch([a], [c], { context: 0 });
  assert.equal(d0, '@@ -2 +2 @@\n-line2\n+lineX\n');
  // context 1 on a longer file: only one unchanged line each side survives
  const big = ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n';
  const bigChanged = ['a', 'b', 'C', 'd', 'e'].join('\n') + '\n';
  const [d1] = await b.diffBatch([big], [bigChanged], { context: 1 });
  assert.equal(d1, '@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n');
});

test('diffBatch: equal inputs yield an empty diff', async () => {
  const out = await b.diffBatch(['same\n', ''], ['same\n', '']);
  assert.deepEqual(out, ['', '']);
});

test('diffBatch marks inputs without a trailing newline', async () => {
  const [d] = await b.diffBatch(['a'], ['b']);
  assert.equal(
    d,
    '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n',
  );
});

test('diffBatch handles unicode lines and empty-vs-content pairs', async () => {
  const [uni] = await b.diffBatch(['héllo 🚀\n'], ['héllo 🛸\n']);
  assert.equal(uni, '@@ -1 +1 @@\n-héllo 🚀\n+héllo 🛸\n');
  const [fromEmpty] = await b.diffBatch([''], ['new line\n']);
  assert.equal(fromEmpty, '@@ -0,0 +1 @@\n+new line\n');
});

test('diffBatch validation: length mismatch and context range are InvalidArg', () => {
  assert.throws(() => b.diffBatch(['a'], []), invalidArg(/equal length/));
  assert.throws(() => b.diffBatch(['a'], ['b'], { context: 101 }), invalidArg(/context must be 0-100, got 101/));
  assert.throws(() => b.diffBatch(['a'], ['b'], { context: -1 }), invalidArg(/context must be 0-100, got -1/));
});

// ---------------------------------------------------------------- similarityBatch

const near = (got: number, want: number, eps = 1e-9) =>
  assert.ok(Math.abs(got - want) < eps, `expected ${got} ≈ ${want}`);

test('similarityBatch known metric values', async () => {
  const [jw] = await b.similarityBatch(['MARTHA'], ['MARHTA'], 'jaroWinkler');
  near(jw, 0.9611111111111111); // classic Winkler paper example
  const [jaro] = await b.similarityBatch(['MARTHA'], ['MARHTA'], 'jaro');
  near(jaro, 0.9444444444444445);
  // sorensen_dice("night","nacht"): bigrams {ni,ig,gh,ht} vs {na,ac,ch,ht} share 1 of 4+4
  const [sd] = await b.similarityBatch(['night'], ['nacht'], 'sorensenDice');
  near(sd, 0.25);
  // kitten/sitting: levenshtein 3 over max len 7 -> 1 - 3/7
  const [nl] = await b.similarityBatch(['kitten'], ['sitting'], 'normalizedLevenshtein');
  near(nl, 1 - 3 / 7);
  // ca/ac: damerau distance 1 (transposition) over len 2 -> 0.5; plain levenshtein would give 0
  const [nd] = await b.similarityBatch(['ca'], ['ac'], 'normalizedDamerau');
  near(nd, 0.5);
  const [ndPlain] = await b.similarityBatch(['ca'], ['ac'], 'normalizedLevenshtein');
  near(ndPlain, 0);
});

test('similarityBatch: identical and empty strings score 1, disjoint scores 0', async () => {
  for (const metric of ['jaro', 'jaroWinkler', 'sorensenDice', 'normalizedLevenshtein', 'normalizedDamerau'] as const) {
    const out = await b.similarityBatch(['same', '', 'héllo 🚀'], ['same', '', 'héllo 🚀'], metric);
    assert.deepEqual(out, [1, 1, 1], metric);
  }
  const [disjoint] = await b.similarityBatch(['abc'], ['xyz'], 'jaro');
  assert.equal(disjoint, 0);
});

test('similarityBatch validation: unknown metric lists valid ones, mismatch is InvalidArg', () => {
  assert.throws(
    () => b.similarityBatch(['a'], ['b'], 'bogus' as never),
    invalidArg(/unknown metric 'bogus' \(expected jaro\|jaroWinkler\|sorensenDice\|normalizedLevenshtein\|normalizedDamerau\)/),
  );
  assert.throws(() => b.similarityBatch(['a'], [], 'jaro'), invalidArg(/equal length/));
});

// ---------------------------------------------------------------- string/regex batch kernels

test('lowercase/uppercase/trim batch kernels: unicode-aware known answers', async () => {
  assert.deepEqual(await b.lowercaseBatch(['HÉLLO 🚀', 'MiXeD', '']), ['héllo 🚀', 'mixed', '']);
  assert.deepEqual(await b.uppercaseBatch(['héllo', 'straße', '']), ['HÉLLO', 'STRASSE', '']);
  assert.deepEqual(await b.trimBatch(['  x  ', '\t\ntabs\n', 'no-trim', '   ']), ['x', 'tabs', 'no-trim', '']);
});

test('string batch kernels agree with their pipeline stages on the same inputs', async () => {
  const items = ['  Ab C  ', 'HÉLLO 🚀', 'İstanbul', 'straße', '', ' nbsp '];
  assert.deepEqual(await b.lowercaseBatch(items), await pipeline().lowercase().run(items));
  assert.deepEqual(await b.uppercaseBatch(items), await pipeline().uppercase().run(items));
  assert.deepEqual(await b.trimBatch(items), await pipeline().trim().run(items));

  const logs = ['user=Alice id=42', 'user=Bob id=7', 'no match here'];
  const pat = String.raw`user=(\w+)`;
  assert.deepEqual(
    await b.regexReplaceBatch(logs, pat, 'user=<$1>'),
    await pipeline().regexReplace(pat, 'user=<$1>').run(logs),
  );
});

test('regexReplaceBatch uses Rust replacement syntax ($1, named groups)', async () => {
  assert.deepEqual(
    await b.regexReplaceBatch(['2026-08-15', 'x 1999-01-02 y'], String.raw`(\d{4})-(\d{2})-(\d{2})`, '$3/$2/$1'),
    ['15/08/2026', 'x 02/01/1999 y'],
  );
  assert.deepEqual(
    await b.regexReplaceBatch(['ab ab'], String.raw`(?P<c>a)b`, '${c}!'),
    ['a! a!'], // replace_all replaces every match
  );
  assert.deepEqual(await b.regexReplaceBatch(['keep'], 'z', 'x'), ['keep']); // no match = unchanged
});

test('regexExtractBatch: group capture, default whole match, null on no match', async () => {
  const items = ['foo123bar', 'nope', '9', ''];
  assert.deepEqual(await b.regexExtractBatch(items, String.raw`(\d+)`, 1), ['123', null, '9', null]);
  // default group 0 = whole match
  assert.deepEqual(await b.regexExtractBatch(['a12b'], String.raw`\d+`), ['12']);
  // first match only
  assert.deepEqual(await b.regexExtractBatch(['1 then 2'], String.raw`\d`), ['1']);
  // unicode input and pattern
  assert.deepEqual(await b.regexExtractBatch(['mail: héllo🚀@x.dev'], String.raw`(\S+)@`, 1), ['héllo🚀']);
});

test('regexExtractBatch diverges from the stage on no-match: kernel null, stage rejects', async () => {
  // Kernel convention (like jsonPluckBatch missing->null): null, batch resolves.
  assert.deepEqual(await b.regexExtractBatch(['no digits'], String.raw`\d+`), [null]);
  // The pipeline STAGE treats no-match as a per-item error instead.
  await assert.rejects(
    pipeline().regexExtract(String.raw`\d+`).run(['no digits']),
    (err: unknown) => {
      assert.match((err as Error).message, /item 0: regexExtract: no match/);
      return true;
    },
  );
});

test('regexReplaceBatch/regexExtractBatch validate pattern and group synchronously (InvalidArg)', () => {
  assert.throws(() => b.regexReplaceBatch(['a'], '(', 'x'), invalidArg(/invalid regex/));
  assert.throws(() => b.regexExtractBatch(['a'], '(', 0), invalidArg(/invalid regex/));
  assert.throws(
    () => b.regexExtractBatch(['a'], '(a)', 2),
    invalidArg(/group 2 out of range \(pattern has 1 capture groups\)/),
  );
  assert.throws(() => b.regexExtractBatch(['a'], '(a)', -1), invalidArg(/group -1 out of range/));
});

// ---------------------------------------------------------------- empty batches

test('empty batches resolve to empty results for every kernel here', async () => {
  assert.deepEqual(await b.diffBatch([], []), []);
  assert.deepEqual(await b.similarityBatch([], [], 'jaro'), []);
  assert.deepEqual(await b.lowercaseBatch([]), []);
  assert.deepEqual(await b.uppercaseBatch([]), []);
  assert.deepEqual(await b.trimBatch([]), []);
  assert.deepEqual(await b.regexReplaceBatch([], 'a', 'b'), []);
  assert.deepEqual(await b.regexExtractBatch([], 'a'), []);
});
