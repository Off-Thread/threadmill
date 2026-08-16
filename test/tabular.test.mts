// Tabular kernel tests (csvToNdjsonBatch, ndjsonTransformBatch) — hit the
// native binding directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import b from '@offthread/threadmill';

const rows = (ndjson: string) =>
  ndjson === '' ? [] : ndjson.split('\n').map((l) => JSON.parse(l));

// ---------------------------------------------------------------- csvToNdjson

test('csvToNdjson: header row becomes keys, column order preserved', async () => {
  const csv = 'name,age\nalice,30\nbob,25';
  const [out] = await b.csvToNdjsonBatch([csv]);
  // Exact text: keys in column order, all values JSON strings, no trailing \n.
  assert.equal(out, '{"name":"alice","age":"30"}\n{"name":"bob","age":"25"}');
});

test('csvToNdjson: hasHeader false generates col0..colN keys', async () => {
  const [out] = await b.csvToNdjsonBatch(['alice,30\nbob,25'], { hasHeader: false });
  assert.deepEqual(rows(out), [
    { col0: 'alice', col1: '30' },
    { col0: 'bob', col1: '25' },
  ]);
});

test('csvToNdjson: Buffer and string items give identical output', async () => {
  const csv = 'a,b\n1,2\n3,4';
  const [s, buf] = await b.csvToNdjsonBatch([csv, Buffer.from(csv)]);
  assert.equal(s, buf);
});

test('csvToNdjson: select projects named columns in select order', async () => {
  const csv = 'name,age,city\nalice,30,berlin\nbob,25,paris';
  const [out] = await b.csvToNdjsonBatch([csv], { select: ['city', 'name'] });
  assert.equal(out, '{"city":"berlin","name":"alice"}\n{"city":"paris","name":"bob"}');
});

test('csvToNdjson: select works against generated colN names when headerless', async () => {
  const [out] = await b.csvToNdjsonBatch(['alice,30\nbob,25'], {
    hasHeader: false,
    select: ['col1'],
  });
  assert.deepEqual(rows(out), [{ col1: '30' }, { col1: '25' }]);
});

test('csvToNdjson: quoted fields keep embedded delimiters, quotes, newlines', async () => {
  const csv = 'a,b\n"x,y",z\n"say ""hi""","line1\nline2"';
  const [out] = await b.csvToNdjsonBatch([csv]);
  assert.deepEqual(rows(out), [
    { a: 'x,y', b: 'z' },
    { a: 'say "hi"', b: 'line1\nline2' },
  ]);
});

test('csvToNdjson: custom delimiter and quote characters', async () => {
  const csv = "a;b\n'x;y';z";
  const [out] = await b.csvToNdjsonBatch([csv], { delimiter: ';', quote: "'" });
  assert.deepEqual(rows(out), [{ a: 'x;y', b: 'z' }]);
});

test('csvToNdjson: unicode values and headers survive round-trip', async () => {
  const csv = 'wörd,émoji\nhéllo,🚀';
  const [out] = await b.csvToNdjsonBatch([csv]);
  assert.deepEqual(rows(out), [{ 'wörd': 'héllo', 'émoji': '🚀' }]);
});

test('csvToNdjson: empty batch and empty items', async () => {
  assert.deepEqual(await b.csvToNdjsonBatch([]), []);
  // Empty chunk = zero rows = empty NDJSON, with or without header mode.
  assert.deepEqual(await b.csvToNdjsonBatch(['', Buffer.alloc(0)]), ['', '']);
  assert.deepEqual(await b.csvToNdjsonBatch([''], { hasHeader: false }), ['']);
  // Header but zero data rows.
  assert.deepEqual(await b.csvToNdjsonBatch(['a,b\n']), ['']);
});

test('csvToNdjson: delimiter/quote must be single ASCII chars (sync InvalidArg)', () => {
  for (const opts of [{ delimiter: ',,' }, { delimiter: 'é' }, { delimiter: '' }, { quote: '""' }]) {
    assert.throws(
      () => b.csvToNdjsonBatch(['a,b\n1,2'], opts),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
        assert.match((err as Error).message, /must be a single ASCII character/);
        return true;
      },
    );
  }
  assert.throws(() => b.csvToNdjsonBatch(['a\n1'], { select: [] }), (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
    assert.match((err as Error).message, /select must not be empty/);
    return true;
  });
});

test('csvToNdjson: unknown select column rejects with the item index', async () => {
  // Single item: with several failing items, failFast rejects with whichever
  // loses the rayon race — the index is only deterministic when one can fail.
  await assert.rejects(
    b.csvToNdjsonBatch(['a,b\n1,2'], { select: ['nope'] }),
    (err: unknown) => {
      assert.match((err as Error).message, /^item 0: csvToNdjson: unknown column in select: 'nope'/);
      return true;
    },
  );
});

test('csvToNdjson: ragged row rejects the batch naming the failing item', async () => {
  const good = 'a,b\n1,2';
  const bad = 'a,b\n1,2,3';
  await assert.rejects(b.csvToNdjsonBatch([good, bad]), (err: unknown) => {
    assert.match((err as Error).message, /^item 1: csvToNdjson: /);
    return true;
  });
  // The good sibling alone still converts.
  assert.deepEqual(rows((await b.csvToNdjsonBatch([good]))[0]), [{ a: '1', b: '2' }]);
});

test('csvToNdjson: values needing JSON escaping produce parseable lines', async () => {
  const csv = 'k\n"tab\there and ""quote"""';
  const [out] = await b.csvToNdjsonBatch([csv]);
  assert.deepEqual(rows(out), [{ k: 'tab\there and "quote"' }]);
});

// ---------------------------------------------------------------- ndjsonTransform

const LINES = [
  '{"name":"alice","age":30,"city":"berlin"}',
  '{"name":"bob","age":7}',
  '{"name":"carol","age":41,"city":"paris"}',
].join('\n');

test('ndjsonTransform: eq filter keeps matching lines verbatim', async () => {
  const [out] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'name', op: 'eq', value: 'bob' }],
  });
  assert.equal(out, '{"name":"bob","age":7}');
});

test('ndjsonTransform: numeric gt filter (JS number and numeric-string value)', async () => {
  const [byNum] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'age', op: 'gt', value: 10 }],
  });
  assert.deepEqual(rows(byNum).map((r) => r.name), ['alice', 'carol']);
  const [byStr] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'age', op: 'gt', value: '10' }],
  });
  assert.equal(byStr, byNum);
});

test('ndjsonTransform: lt, ne, exists; missing path never passes gt/lt', async () => {
  const [lt] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'age', op: 'lt', value: 10 }],
  });
  assert.deepEqual(rows(lt).map((r) => r.name), ['bob']);
  const [ne] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'name', op: 'ne', value: 'bob' }],
  });
  assert.deepEqual(rows(ne).map((r) => r.name), ['alice', 'carol']);
  const [exists] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'city', op: 'exists' }],
  });
  assert.deepEqual(rows(exists).map((r) => r.name), ['alice', 'carol']);
  // bob has no city: gt on a missing path is false, not 0-compared.
  const [gtMissing] = await b.ndjsonTransformBatch(['{"name":"bob"}'], {
    filter: [{ path: 'age', op: 'gt', value: -1 }],
  });
  assert.equal(gtMissing, '');
});

test('ndjsonTransform: eq with a numeric value compares against JSON number text', async () => {
  const [out] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'age', op: 'eq', value: 30 }],
  });
  assert.deepEqual(rows(out).map((r) => r.name), ['alice']);
});

test('ndjsonTransform: ALL filters must pass', async () => {
  const [out] = await b.ndjsonTransformBatch([LINES], {
    filter: [
      { path: 'age', op: 'gt', value: 10 },
      { path: 'city', op: 'eq', value: 'paris' },
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.name), ['carol']);
});

test('ndjsonTransform: project keys are the last path segment, missing -> null', async () => {
  const doc = '{"user":{"email":"A@B.com","tags":["x","y"]},"n":3}';
  const [out] = await b.ndjsonTransformBatch([doc], {
    project: ['user.email', 'user.missing', 'n', 'user.tags'],
  });
  // Values are spliced as raw JSON: strings quoted, numbers bare, arrays intact.
  assert.equal(out, '{"email":"A@B.com","missing":null,"n":3,"tags":["x","y"]}');
});

test('ndjsonTransform: filter + project combine; only survivors are projected', async () => {
  const [out] = await b.ndjsonTransformBatch([LINES], {
    filter: [{ path: 'age', op: 'gt', value: 10 }],
    project: ['name'],
  });
  assert.equal(out, '{"name":"alice"}\n{"name":"carol"}');
});

test('ndjsonTransform: blank lines and CRLF endings are skipped/normalized', async () => {
  const messy = '\n{"a":1}\r\n\n   \n{"a":2}\n\n';
  const [out] = await b.ndjsonTransformBatch([messy], {
    filter: [{ path: 'a', op: 'exists' }],
  });
  assert.equal(out, '{"a":1}\n{"a":2}');
});

test('ndjsonTransform: empty batch, empty item, Buffer input', async () => {
  const cfg = { filter: [{ path: 'a', op: 'exists' as const }] };
  assert.deepEqual(await b.ndjsonTransformBatch([], cfg), []);
  assert.deepEqual(await b.ndjsonTransformBatch(['', Buffer.alloc(0)], cfg), ['', '']);
  const [out] = await b.ndjsonTransformBatch([Buffer.from('{"a":1}')], cfg);
  assert.equal(out, '{"a":1}');
});

test('ndjsonTransform: invalid JSON line rejects with item index and line number', async () => {
  const bad = '{"ok":1}\nnot json at all';
  await assert.rejects(
    b.ndjsonTransformBatch(['{"ok":2}', bad], { filter: [{ path: 'ok', op: 'exists' }] }),
    (err: unknown) => {
      assert.match((err as Error).message, /^item 1: ndjsonTransform: line 2: invalid JSON$/);
      return true;
    },
  );
});

test('ndjsonTransform: config validation throws synchronously with InvalidArg', () => {
  const one = ['{"a":1}'];
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /must set filter and\/or project/],
    [{ filter: [], project: [] }, /must set filter and\/or project/],
    [{ filter: [{ path: 'a', op: 'like', value: 'x' }] }, /unknown op 'like'/],
    [{ filter: [{ path: 'a', op: 'eq' }] }, /op 'eq' requires a value/],
    [{ filter: [{ path: 'a', op: 'gt', value: 'abc' }] }, /requires a numeric value/],
    [{ filter: [{ path: '', op: 'exists' }] }, /path must not be empty/],
    [{ project: [''] }, /path must not be empty/],
  ];
  for (const [cfg, re] of cases) {
    assert.throws(
      () => b.ndjsonTransformBatch(one, cfg as never),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
        assert.match((err as Error).message, re);
        return true;
      },
    );
  }
});

test('ndjsonTransform: unicode content passes through and projects intact', async () => {
  const doc = '{"name":"héllo 🚀","note":"ñ"}';
  const [verbatim] = await b.ndjsonTransformBatch([doc], {
    filter: [{ path: 'name', op: 'eq', value: 'héllo 🚀' }],
  });
  assert.equal(verbatim, doc);
  const [projected] = await b.ndjsonTransformBatch([doc], { project: ['name'] });
  assert.deepEqual(rows(projected), [{ name: 'héllo 🚀' }]);
});

// ---------------------------------------------------------------- kernel chaining

test('csvToNdjson output feeds ndjsonTransform (the intended chain)', async () => {
  const csv = 'name,age\nalice,30\nbob,7\ncarol,41';
  const [ndjson] = await b.csvToNdjsonBatch([csv]);
  // CSV values are strings; gt coerces numeric strings, so "30" > 10 passes.
  const [out] = await b.ndjsonTransformBatch([ndjson], {
    filter: [{ path: 'age', op: 'gt', value: 10 }],
    project: ['name'],
  });
  assert.equal(out, '{"name":"alice"}\n{"name":"carol"}');
});
