// Extended pipeline stages end-to-end: HTML (sanitize/markdown/text/extract),
// tabular (csvToNdjson/ndjsonTransform), search (multiReplace/multiFind),
// tokens (truncateTokens), codec (brotli/base64/hex/crc32/crc32c), xxh64Hex.
// Per stage: correct output through pipeline(), agreement with the matching
// batch kernel, invalid-chain rejection, sync config validation, and per-item
// runtime failures ("item {i}: {op}: ..."). Run:
//   node --test test/stages.test.mts
// Default-import and destructure (see pipeline.test.mts). `as any` casts
// appear only where a test deliberately exercises a runtime guard the phantom
// typings already reject at compile time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import binding from '@offthread/threadmill';
import mod from '@offthread/threadmill';
import type {
  MultiFindConfig,
  MultiReplaceConfig,
  NdjsonTransformConfig,
  TruncateTokensConfig,
} from '@offthread/threadmill';

const { pipeline } = mod;

function makePlan(stages: object[]): string {
  return JSON.stringify({ stages, mode: 'failFast', terminal: { kind: 'collect' } });
}

describe('sanitizeHtml stage', () => {
  it('strips scripts/handlers with the default policy and agrees with the batch kernel', async () => {
    const input =
      '<b>hi</b><script>alert(1)</script><a href="/x" onclick="p()">link</a>';
    const out = await pipeline().sanitizeHtml().run([input]);
    assert.ok(out[0].includes('<b>hi</b>'));
    assert.ok(!out[0].includes('script'));
    assert.ok(!out[0].includes('onclick'));
    assert.deepEqual(out, await binding.sanitizeHtmlBatch([input]));
  });

  it('honors a custom policy exactly like the batch kernel', async () => {
    const input = '<b>keep</b><i>drop</i><em lang="en">x</em>';
    const policy = { allowedTags: ['b', 'em'] };
    assert.deepEqual(
      await pipeline().sanitizeHtml(policy).run([input]),
      await binding.sanitizeHtmlBatch([input], policy)
    );
  });

  it('config validation throws synchronously, naming the stage', () => {
    assert.throws(
      () => pipeline().sanitizeHtml({ allowedTags: [''] }).run(['x']),
      /stage 0 \(sanitizeHtml\): allowedTags must not contain empty strings/
    );
    assert.throws(
      () => pipeline().sanitizeHtml({ urlSchemes: [''] }).run(['x']),
      /stage 0 \(sanitizeHtml\): urlSchemes must not contain empty strings/
    );
  });
});

describe('markdownToHtml stage', () => {
  it('renders CommonMark and agrees with the batch kernel', async () => {
    const md = '# Title\n\nsome **bold** text';
    const out = await pipeline().markdownToHtml().run([md]);
    assert.match(out[0], /<h1>Title<\/h1>/);
    assert.match(out[0], /<strong>bold<\/strong>/);
    assert.deepEqual(out, await binding.markdownToHtmlBatch([md]));
  });

  it('gfm strikethrough is on by default and off with gfm:false', async () => {
    const md = '~~gone~~';
    const gfm = await pipeline().markdownToHtml().run([md]);
    assert.ok(gfm[0].includes('<del>'));
    const plain = await pipeline().markdownToHtml({ gfm: false }).run([md]);
    assert.ok(!plain[0].includes('<del>'));
    assert.deepEqual(
      plain,
      await binding.markdownToHtmlBatch([md], { gfm: false })
    );
  });
});

describe('htmlToText stage', () => {
  it('renders wrapped plain text and agrees with the batch kernel', async () => {
    const html =
      '<p>Hello <b>world</b>, this sentence is long enough to need wrapping.</p>';
    const out = await pipeline().htmlToText({ width: 20 }).run([html]);
    assert.deepEqual(out, await binding.htmlToTextBatch([html], { width: 20 }));
    assert.ok(out[0].split('\n').every((line) => line.length <= 20));
    // default width matches too
    assert.deepEqual(
      await pipeline().htmlToText().run([html]),
      await binding.htmlToTextBatch([html])
    );
  });

  it('width validation: native range check + builder integer guard, both sync', () => {
    assert.throws(
      () => pipeline().htmlToText({ width: 0 }).run(['x']),
      /stage 0 \(htmlToText\): width must be 1-1000, got 0/
    );
    assert.throws(
      () => pipeline().htmlToText({ width: 1.5 }),
      /htmlToText width must be an integer/
    );
  });
});

describe('htmlExtract stage', () => {
  const html = '<ul><li>a</li><li>b</li></ul><a href="/x">link</a>';

  it('extracts attr/text from Buffer and string input alike (either-input stage)', async () => {
    assert.deepEqual(
      await pipeline().htmlExtract({ selector: 'a', extract: { attr: 'href' } }).run([html]),
      ['/x']
    );
    assert.deepEqual(
      await pipeline()
        .htmlExtract({ selector: 'a', extract: { attr: 'href' } })
        .run([Buffer.from(html)]),
      ['/x']
    );
  });

  it('all:true yields a JSON array string and agrees with the batch kernel', async () => {
    const out = await pipeline()
      .htmlExtract({ selector: 'li', extract: 'text', all: true })
      .run([html]);
    assert.deepEqual(JSON.parse(out[0]), ['a', 'b']);
    assert.deepEqual(
      out,
      await binding.htmlExtractBatch([html], { selector: 'li', extract: 'text', all: true })
    );
  });

  it('invalid selector / extract keyword throw synchronously, naming the stage', () => {
    assert.throws(
      () => pipeline().htmlExtract({ selector: '<<', extract: 'text' }).run(['x']),
      /stage 0 \(htmlExtract\): invalid selector '<<'/
    );
    assert.throws(
      () =>
        pipeline()
          .htmlExtract({ selector: 'a', extract: 'bogus' as never })
          .run(['x']),
      /stage 0 \(htmlExtract\): extract must be 'text', 'html', or \{attr\}, got 'bogus'/
    );
  });

  it('non-UTF-8 byte input is an item error with the "item {i}: {op}: " prefix', async () => {
    await assert.rejects(
      pipeline()
        .htmlExtract({ selector: 'a', extract: 'text' })
        .run([Buffer.from('<a>ok</a>'), Buffer.from([0xff, 0xfe])]),
      /^Error: item 1: htmlExtract: invalid utf-8/
    );
  });
});

describe('csvToNdjson stage', () => {
  const csv = 'name,age\nalice,30\nbob,25';

  it('converts CSV chunks from Buffer and string input, matching the batch kernel', async () => {
    const expected = '{"name":"alice","age":"30"}\n{"name":"bob","age":"25"}';
    assert.deepEqual(await pipeline().csvToNdjson().run([csv]), [expected]);
    assert.deepEqual(await pipeline().csvToNdjson().run([Buffer.from(csv)]), [expected]);
    assert.deepEqual(
      await pipeline().csvToNdjson({ select: ['age'] }).run([csv]),
      await binding.csvToNdjsonBatch([csv], { select: ['age'] })
    );
  });

  it('headerless mode names columns col0..colN', async () => {
    assert.deepEqual(
      await pipeline().csvToNdjson({ hasHeader: false }).run(['1,2\n3,4']),
      ['{"col0":"1","col1":"2"}\n{"col0":"3","col1":"4"}']
    );
  });

  it('config validation throws synchronously (bad delimiter, empty select)', () => {
    assert.throws(
      () => pipeline().csvToNdjson({ delimiter: ';;' }).run(['a']),
      /stage 0 \(csvToNdjson\): delimiter must be a single ASCII character/
    );
    assert.throws(
      () => pipeline().csvToNdjson({ select: [] }).run(['a']),
      /stage 0 \(csvToNdjson\): select must not be empty/
    );
  });

  it('unknown select column and ragged rows are item errors', async () => {
    await assert.rejects(
      pipeline().csvToNdjson({ select: ['nope'] }).run(['a,b\n1,2']),
      /^Error: item 0: csvToNdjson: unknown column in select: 'nope'/
    );
    await assert.rejects(
      pipeline().csvToNdjson().run([csv, 'a,b\n1,2,3']),
      /^Error: item 1: csvToNdjson: /
    );
  });
});

describe('ndjsonTransform stage', () => {
  const ndjson =
    '{"user":{"email":"A@x.com"},"n":1}\n{"user":{"email":"b@y.com"},"n":5}\n{"n":9}';

  it('filter + project on Buffer and string input, matching the batch kernel', async () => {
    const cfg: NdjsonTransformConfig = {
      filter: [{ path: 'n', op: 'lt', value: 6 }],
      project: ['user.email'],
    };
    const out = await pipeline().ndjsonTransform(cfg).run([ndjson]);
    assert.deepEqual(out, ['{"email":"A@x.com"}\n{"email":"b@y.com"}']);
    assert.deepEqual(out, await binding.ndjsonTransformBatch([ndjson], cfg));
    assert.deepEqual(
      await pipeline().ndjsonTransform(cfg).run([Buffer.from(ndjson)]),
      out
    );
  });

  it('config validation throws synchronously (empty config, unknown op)', () => {
    assert.throws(
      () => pipeline().ndjsonTransform({}).run(['{}']),
      /stage 0 \(ndjsonTransform\): config must set filter and\/or project/
    );
    assert.throws(
      () =>
        pipeline()
          .ndjsonTransform({ filter: [{ path: 'a', op: 'gte' as never, value: 1 }] })
          .run(['{}']),
      /stage 0 \(ndjsonTransform\): filter\[0\]: unknown op 'gte'/
    );
  });

  it('an invalid JSON line is an item error naming the line', async () => {
    await assert.rejects(
      pipeline().ndjsonTransform({ project: ['a'] }).run(['{"a":1}\nnot json']),
      /^Error: item 0: ndjsonTransform: line 2: invalid JSON/
    );
  });
});

describe('multiReplace stage', () => {
  it('replaces per-pattern and broadcast, agreeing with the batch kernel', async () => {
    const cfg: MultiReplaceConfig = {
      patterns: ['cat', 'dog'],
      replacements: ['feline', 'canine'],
    };
    const out = await pipeline().multiReplace(cfg).run(['cat meets dog']);
    assert.deepEqual(out, ['feline meets canine']);
    assert.deepEqual(out, await binding.multiReplaceBatch(['cat meets dog'], cfg));
    // single-string broadcast
    assert.deepEqual(
      await pipeline()
        .multiReplace({ patterns: ['a@x.com', 'b@y.com'], replacements: '[email]' })
        .run(['a@x.com and b@y.com']),
      ['[email] and [email]']
    );
  });

  it('config validation throws synchronously (empty patterns, length mismatch)', () => {
    assert.throws(
      () => pipeline().multiReplace({ patterns: [], replacements: [] }).run(['x']),
      /stage 0 \(multiReplace\): patterns must not be empty/
    );
    assert.throws(
      () =>
        pipeline().multiReplace({ patterns: ['a'], replacements: ['x', 'y'] }).run(['x']),
      /stage 0 \(multiReplace\): replacements length 2 != patterns length 1/
    );
  });
});

describe('multiFind stage', () => {
  it('emits leftmost-longest matches as JSON, agreeing with the batch kernel', async () => {
    const cfg: MultiFindConfig = { patterns: ['ab', 'b'] };
    const out = await pipeline().multiFind(cfg).run(['xabby']);
    assert.deepEqual(JSON.parse(out[0]), [
      { p: 0, s: 1, e: 3 },
      { p: 1, s: 3, e: 4 },
    ]);
    assert.deepEqual(out, await binding.multiFindBatch(['xabby'], cfg));
  });

  it('limit caps matches per item; no matches yields "[]"', async () => {
    assert.deepEqual(
      await pipeline().multiFind({ patterns: ['b'], limit: 1 }).run(['bbb']),
      ['[{"p":0,"s":0,"e":1}]']
    );
    assert.deepEqual(await pipeline().multiFind({ patterns: ['z'] }).run(['abc']), ['[]']);
  });

  it('config validation: limit 0 native, limit 1.5 builder, both sync', () => {
    assert.throws(
      () => pipeline().multiFind({ patterns: ['a'], limit: 0 }).run(['x']),
      /stage 0 \(multiFind\): limit must be >= 1/
    );
    assert.throws(
      () => pipeline().multiFind({ patterns: ['a'], limit: 1.5 }),
      /multiFind limit must be an integer/
    );
  });
});

describe('truncateTokens stage', () => {
  const cfg: TruncateTokensConfig = { encoding: 'cl100k_base', maxTokens: 3 };

  it('truncates over-budget items, passes short ones through, agrees with the batch kernel', async () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const out = await pipeline().truncateTokens(cfg).run([text]);
    assert.deepEqual(out, await binding.truncateTokensBatch([text], cfg));
    assert.ok(text.startsWith(out[0]));
    assert.ok(out[0].length < text.length);
    assert.deepEqual(await pipeline().truncateTokens(cfg).run(['hi']), ['hi']);
  });

  it("keep:'end' keeps a suffix instead", async () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const out = await pipeline()
      .truncateTokens({ ...cfg, keep: 'end' })
      .run([text]);
    assert.ok(text.endsWith(out[0]));
    assert.deepEqual(
      out,
      await binding.truncateTokensBatch([text], { ...cfg, keep: 'end' })
    );
  });

  it('config validation: encoding/maxTokens/keep native, NaN builder, all sync', () => {
    assert.throws(
      () =>
        pipeline().truncateTokens({ encoding: 'bogus' as never, maxTokens: 2 }).run(['x']),
      /stage 0 \(truncateTokens\): unknown encoding 'bogus'/
    );
    assert.throws(
      () => pipeline().truncateTokens({ encoding: 'cl100k_base', maxTokens: 0 }).run(['x']),
      /stage 0 \(truncateTokens\): maxTokens must be >= 1, got 0/
    );
    assert.throws(
      () =>
        pipeline()
          .truncateTokens({ encoding: 'cl100k_base', maxTokens: 2, keep: 'middle' as never })
          .run(['x']),
      /stage 0 \(truncateTokens\): keep must be 'start' or 'end', got 'middle'/
    );
    assert.throws(
      () => pipeline().truncateTokens({ encoding: 'cl100k_base', maxTokens: NaN }),
      /truncateTokens maxTokens must be an integer/
    );
  });
});

describe('brotli stages', () => {
  const payload = Buffer.from('brotli payload '.repeat(50));

  it('round-trips via the pipeline, node:zlib, and the batch kernels', async () => {
    const out = await pipeline().brotliCompress({ quality: 5 }).brotliDecompress().run([payload]);
    assert.deepEqual(out, [payload]);
    const compressed = await pipeline().brotliCompress().run([payload]);
    assert.ok(compressed[0].length < payload.length);
    assert.deepEqual(zlib.brotliDecompressSync(compressed[0]), payload);
    // identical params -> byte-identical with the batch kernel
    assert.deepEqual(compressed, await binding.brotliCompressBatch([payload]));
    // node:zlib-compressed input decodes through the stage
    const nodeBr = zlib.brotliCompressSync(payload);
    assert.deepEqual(await pipeline().brotliDecompress().run([nodeBr]), [payload]);
  });

  it('config validation: quality/lgwin ranges native, integer guard builder, all sync', () => {
    assert.throws(
      () => pipeline().brotliCompress({ quality: 12 }).run([Buffer.from('x')]),
      /stage 0 \(brotliCompress\): quality must be 0-11, got 12/
    );
    assert.throws(
      () => pipeline().brotliCompress({ lgwin: 9 }).run([Buffer.from('x')]),
      /stage 0 \(brotliCompress\): lgwin must be 10-24, got 9/
    );
    assert.throws(
      () => pipeline().brotliCompress({ quality: 1.5 }),
      /brotliCompress quality must be an integer/
    );
  });

  it('corrupt input is an item error with the "item {i}: {op}: " prefix', async () => {
    await assert.rejects(
      pipeline().brotliDecompress().run([zlib.brotliCompressSync('ok'), Buffer.from('junk!')]),
      /^Error: item 1: brotliDecompress: /
    );
  });
});

describe('base64 stages', () => {
  it('base64Encode matches Buffer.toString("base64") and the batch kernel on either input kind', async () => {
    const buf = crypto.randomBytes(64);
    assert.deepEqual(await pipeline().base64Encode().run([buf]), [buf.toString('base64')]);
    assert.deepEqual(await pipeline().base64Encode().run(['héllo']), [
      Buffer.from('héllo', 'utf8').toString('base64'),
    ]);
    assert.deepEqual(
      await pipeline().base64Encode().run([buf]),
      await binding.base64EncodeBatch([buf])
    );
  });

  it('base64Decode yields Bytes (chains into utf8) and agrees with the batch kernel', async () => {
    assert.deepEqual(await pipeline().base64Decode().run(['aGVsbG8=']), [Buffer.from('hello')]);
    assert.deepEqual(await pipeline().base64Decode().utf8().run(['aGVsbG8=']), ['hello']);
    assert.deepEqual(
      await pipeline().base64Decode().run(['aGVsbG8=']),
      await binding.base64DecodeBatch(['aGVsbG8='])
    );
  });

  it('junk input is an item error; settled mode settles it per item', async () => {
    await assert.rejects(
      pipeline().base64Decode().run(['aGk=', '!!!not base64!!!']),
      /^Error: item 1: base64Decode: /
    );
    const out = await pipeline().base64Decode().settled().run(['aGk=', '!!!']);
    assert.equal(out[0].ok, true);
    assert.equal(out[1].ok, false);
    assert.match(out[1].error!, /^item 1: base64Decode: /);
  });
});

describe('hex stages', () => {
  it('hexEncode/hexDecode round-trip, match Buffer and the batch kernels', async () => {
    const buf = Buffer.from('café');
    assert.deepEqual(await pipeline().hexEncode().run([buf]), [buf.toString('hex')]);
    assert.deepEqual(
      await pipeline().hexEncode().run([buf]),
      await binding.hexEncodeBatch([buf])
    );
    // mixed case accepted on decode
    assert.deepEqual(
      await pipeline().hexDecode().run([buf.toString('hex').toUpperCase()]),
      [buf]
    );
    assert.deepEqual(
      await pipeline().hexDecode().run([buf.toString('hex')]),
      await binding.hexDecodeBatch([buf.toString('hex')])
    );
  });

  it('odd-length input is an item error', async () => {
    await assert.rejects(
      pipeline().hexDecode().run(['abc']),
      /^Error: item 0: hexDecode: /
    );
  });
});

describe('crc32 / crc32c / xxh64 stages', () => {
  it('crc32Hex and crc32cHex known check vectors, batch agreement, either input kind', async () => {
    assert.deepEqual(await pipeline().crc32Hex().run(['123456789']), ['cbf43926']);
    assert.deepEqual(await pipeline().crc32cHex().run(['123456789']), ['e3069283']);
    const buf = Buffer.from('123456789');
    assert.deepEqual(
      await pipeline().crc32Hex().run([buf]),
      await binding.crc32HexBatch([buf])
    );
    assert.deepEqual(
      await pipeline().crc32cHex().run([buf]),
      await binding.crc32cHexBatch([buf])
    );
    // empty input keeps the 8-char zero padding
    assert.deepEqual(await pipeline().crc32Hex().run(['']), ['00000000']);
  });

  it('xxh64Hex agrees with xxh64HexBatch, hashes string/Buffer alike, differs from xxh3', async () => {
    const buf = Buffer.from('hello xxh64');
    const out = await pipeline().xxh64Hex().run([buf]);
    assert.deepEqual(out, await binding.xxh64HexBatch([buf]));
    assert.deepEqual(await pipeline().xxh64Hex().run(['hello xxh64']), out);
    assert.match(out[0], /^[0-9a-f]{16}$/);
    assert.notEqual(out[0], (await pipeline().xxh3Hex().run([buf]))[0]);
  });
});

describe('invalid chains (extended stages)', () => {
  it('every Str-only extended stage on a Bytes chain throws sync, naming stage and kinds', () => {
    // A cfg that satisfies every builder guard, so the CHAIN check is what fires.
    const cfg = {
      patterns: ['x'],
      replacements: 'y',
      encoding: 'cl100k_base',
      maxTokens: 1,
    };
    for (const op of [
      'sanitizeHtml',
      'markdownToHtml',
      'htmlToText',
      'multiReplace',
      'multiFind',
      'truncateTokens',
      'base64Decode',
      'hexDecode',
    ]) {
      assert.throws(
        () => (pipeline().gunzip() as any)[op](cfg),
        new RegExp(`stage 1 \\(${op}\\) expects Str input but receives Bytes`),
        op
      );
    }
  });

  it('Bytes-only extended stages on a Str chain throw sync', () => {
    assert.throws(
      () => (pipeline().lowercase() as any).brotliCompress(),
      /stage 1 \(brotliCompress\) expects Bytes input but receives Str/
    );
    assert.throws(
      () => (pipeline().lowercase() as any).brotliDecompress(),
      /stage 1 \(brotliDecompress\) expects Bytes input but receives Str/
    );
  });

  it('native compile_plan enforces the same type table when the builder is bypassed', () => {
    assert.throws(
      () =>
        binding.runPipelineCollect(
          makePlan([{ op: 'gunzip' }, { op: 'sanitizeHtml' }]),
          [Buffer.from('x')]
        ),
      /stage 1 \(sanitizeHtml\) expects Str input but receives Bytes/
    );
    assert.throws(
      () => binding.runPipelineCollect(makePlan([{ op: 'base64Decode' }]), [Buffer.from('x')]),
      /stage 0 \(base64Decode\) expects Str input but receives Bytes/
    );
    assert.throws(
      () => binding.runPipelineCollect(makePlan([{ op: 'brotliCompress' }]), ['str input']),
      /stage 0 \(brotliCompress\) expects Bytes input but receives Str/
    );
  });

  it('builder guards: missing/invalid required configs throw TypeError sync', () => {
    assert.throws(() => (pipeline() as any).multiReplace('cat'), TypeError);
    assert.throws(() => (pipeline() as any).ndjsonTransform(), TypeError);
    assert.throws(() => (pipeline() as any).htmlExtract({ extract: 'text' }), TypeError);
    assert.throws(
      () => (pipeline() as any).truncateTokens({ encoding: 'cl100k_base' }),
      TypeError
    );
    assert.throws(() => (pipeline() as any).multiFind({ patterns: 'a' }), TypeError);
  });
});

describe('composition chains (extended stages)', () => {
  it('markdownToHtml(unsafe) -> sanitizeHtml strips injected HTML, matching batch composition', async () => {
    // Note the blank line after the script block: raw-HTML blocks swallow the
    // rest of their paragraph in CommonMark, so **bold** needs its own one.
    const md = '# Hello\n\n<script>alert(1)</script>\n\n**bold** [link](https://x.dev)';
    const out = await pipeline().markdownToHtml({ unsafe: true }).sanitizeHtml().run([md]);
    const viaBatch = await binding.sanitizeHtmlBatch(
      await binding.markdownToHtmlBatch([md], { unsafe: true })
    );
    assert.deepEqual(out, viaBatch);
    assert.ok(!out[0].includes('<script>'));
    assert.ok(out[0].includes('<strong>bold</strong>'));
  });

  it('csvToNdjson -> ndjsonTransform -> count (and run) over multiple CSV chunks', async () => {
    const csvA = 'name,score\nalice,10\nbob,3';
    const csvB = 'name,score\ncarol,7';
    const chain = pipeline()
      .csvToNdjson()
      .ndjsonTransform({ filter: [{ path: 'score', op: 'gt', value: 5 }] });
    assert.equal(await chain.count([csvA, csvB]), 2);
    assert.deepEqual(await chain.run([csvA, csvB]), [
      '{"name":"alice","score":"10"}',
      '{"name":"carol","score":"7"}',
    ]);
  });

  it('gunzip -> ndjsonTransform -> multiReplace -> bytes -> zstdCompress round-trips', async () => {
    const lines = [
      '{"user":{"email":"a@example.com"},"keep":true}',
      '{"user":{"email":"b@example.com"},"keep":false}',
      '{"user":{"email":"c@example.com"},"keep":true}',
    ];
    const gz = zlib.gzipSync(lines.join('\n'));
    const out = await pipeline()
      .gunzip()
      .ndjsonTransform({
        filter: [{ path: 'keep', op: 'eq', value: 'true' }],
        project: ['user.email'],
      })
      .multiReplace({ patterns: ['@example.com'], replacements: '@redacted.io' })
      .bytes()
      .zstdCompress()
      .run([gz]);
    assert.ok(Buffer.isBuffer(out[0]));
    const back = await pipeline().zstdDecompress().utf8().run(out);
    assert.deepEqual(back, ['{"email":"a@redacted.io"}\n{"email":"c@redacted.io"}']);
  });
});
