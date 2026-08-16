// Pipeline tests: JS fluent builder (lib/pipeline.js) end-to-end over the
// native engine, plus direct native plan-compile error checks.
// Run: node --test test/pipeline.test.mts
// Default-import and destructure — named ESM imports from the generated CJS
// loaders via the lexer are unreliable.
// `as any` casts appear only where a test deliberately exercises a runtime
// guard that the phantom-generic typings already reject at compile time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import binding from '@offthread/threadmill';
import mod from '@offthread/threadmill';
import type { StreamItem } from '@offthread/threadmill';
import type { StreamValue } from '@offthread/threadmill';

const { pipeline, files } = mod;

const sha256 = (data: string | Buffer) =>
  crypto.createHash('sha256').update(data).digest('hex');

function makePlan(
  stages: object[],
  mode = 'failFast',
  terminal: object = { kind: 'collect' },
): string {
  return JSON.stringify({ stages, mode, terminal });
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('full chain correctness', () => {
  it('gunzip -> jsonPluck -> lowercase -> sha256Hex matches a hand-computed Node equivalent', async () => {
    const emails = ['Alice@Example.COM', 'BOB@test.io', 'carol@x.dev'];
    const docs = emails.map((email, i) =>
      zlib.gzipSync(JSON.stringify({ id: i, user: { email }, pad: 'x'.repeat(50) }))
    );

    const out = await pipeline()
      .gunzip()
      .jsonPluck('user.email')
      .lowercase()
      .sha256Hex()
      .run(docs);

    // Hand-computed equivalent using zlib + JSON.parse + crypto.
    const expected = docs.map((buf) =>
      sha256(JSON.parse(zlib.gunzipSync(buf).toString()).user.email.toLowerCase())
    );
    assert.deepEqual(out, expected);
  });

  it('Bytes-final chain resolves Buffer[] (gzip round-trips through zlib)', async () => {
    const inputs = [Buffer.from('hello pipeline'), Buffer.from('')];
    const out = await pipeline().gzip(9).run(inputs);
    assert.equal(out.length, 2);
    for (let i = 0; i < out.length; i++) {
      assert.ok(Buffer.isBuffer(out[i]));
      assert.deepEqual(zlib.gunzipSync(out[i]), inputs[i]);
    }
  });

  it('immutable chaining: forked builders do not share state', async () => {
    const base = pipeline().trim();
    const upper = base.uppercase();
    const lower = base.lowercase();
    assert.deepEqual(await upper.run(['  Ab ']), ['AB']);
    assert.deepEqual(await lower.run(['  Ab ']), ['ab']);
    assert.deepEqual(await base.run(['  Ab ']), ['Ab']); // base unchanged
  });

  it('empty input resolves an empty array', async () => {
    assert.deepEqual(await pipeline().sha256Hex().run([]), []);
    assert.equal(await pipeline().sha256Hex().count([]), 0);
  });
});

describe('every stage op', () => {
  it('gunzip', async () => {
    const out = await pipeline().gunzip().utf8().run([zlib.gzipSync('unzipped!')]);
    assert.deepEqual(out, ['unzipped!']);
  });

  it('gzip (explicit level) round-trips via gunzip stage', async () => {
    const out = await pipeline().gzip(1).gunzip().run([Buffer.from('roundtrip')]);
    assert.deepEqual(out, [Buffer.from('roundtrip')]);
  });

  it('zstdCompress -> zstdDecompress round-trips', async () => {
    const payload = Buffer.from('zstd payload '.repeat(100));
    const out = await pipeline().zstdCompress(3).zstdDecompress().run([payload]);
    assert.deepEqual(out, [payload]);
    // compression actually happened
    const compressed = await pipeline().zstdCompress().run([payload]);
    assert.ok(compressed[0].length < payload.length);
  });

  it('utf8 decodes Bytes to Str', async () => {
    assert.deepEqual(await pipeline().utf8().run([Buffer.from('héllo')]), ['héllo']);
  });

  it('bytes encodes Str to Bytes', async () => {
    const out = await pipeline().bytes().run(['héllo']);
    assert.ok(Buffer.isBuffer(out[0]));
    assert.deepEqual(out[0], Buffer.from('héllo', 'utf8'));
  });

  it('jsonPluck works on Buffer and string input; string values come out raw', async () => {
    const doc = JSON.stringify({ a: { b: 'Deep Value' }, n: 42 });
    assert.deepEqual(await pipeline().jsonPluck('a.b').run([Buffer.from(doc)]), ['Deep Value']);
    assert.deepEqual(await pipeline().jsonPluck('n').run([doc]), ['42']);
  });

  it('sha256Hex matches node:crypto for Buffer and string input', async () => {
    const buf = Buffer.from('hash me');
    assert.deepEqual(await pipeline().sha256Hex().run([buf]), [sha256(buf)]);
    assert.deepEqual(await pipeline().sha256Hex().run(['abc']), [sha256('abc')]);
  });

  it('blake3Hex and xxh3Hex agree with the batch kernels', async () => {
    const bufs = [Buffer.from(''), Buffer.from('abc'), Buffer.from('threadmill')];
    assert.deepEqual(
      await pipeline().blake3Hex().run(bufs),
      await binding.blake3HexBatch(bufs)
    );
    assert.deepEqual(
      await pipeline().xxh3Hex().run(bufs),
      await binding.xxh3HexBatch(bufs)
    );
  });

  it('lowercase / uppercase / trim', async () => {
    assert.deepEqual(await pipeline().lowercase().run(['MiXeD']), ['mixed']);
    assert.deepEqual(await pipeline().uppercase().run(['MiXeD']), ['MIXED']);
    assert.deepEqual(await pipeline().trim().run(['  padded \t\n']), ['padded']);
  });

  it('normalize NFC/NFD change the code-point length as expected', async () => {
    const nfc = 'é'; // é precomposed (U+00E9)
    const nfd = 'é'; // e + combining acute (U+0065 U+0301)
    assert.deepEqual(await pipeline().normalize('NFC').run([nfd]), [nfc]);
    assert.deepEqual(await pipeline().normalize('NFD').run([nfc]), [nfd]);
  });

  it('regexReplace replaces all matches', async () => {
    const out = await pipeline().regexReplace('[0-9]+', '#').run(['a1b22c333']);
    assert.deepEqual(out, ['a#b#c#']);
  });

  it('regexExtract takes the first match, optionally a capture group', async () => {
    assert.deepEqual(await pipeline().regexExtract('[0-9]+').run(['a12b34']), ['12']);
    assert.deepEqual(
      await pipeline().regexExtract('(a+)(b+)', 2).run(['xaabbby']),
      ['bbb']
    );
  });
});

describe('failFast and settled modes', () => {
  const gzItems = [zlib.gzipSync('ok0'), Buffer.from('not gzip'), zlib.gzipSync('ok2')];

  it('failFast run rejects with stage op and item index', async () => {
    await assert.rejects(
      pipeline().gunzip().utf8().run(gzItems),
      (err: unknown) => {
        assert.match((err as Error).message, /^item 1: gunzip: /);
        return true;
      }
    );
  });

  it('settled run resolves per-item {ok, value} / {ok, error}', async () => {
    const out = await pipeline().gunzip().utf8().settled().run(gzItems);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { ok: true, value: 'ok0' });
    assert.deepEqual(out[2], { ok: true, value: 'ok2' });
    assert.equal(out[1].ok, false);
    assert.equal(out[1].value, undefined);
    assert.match(out[1].error!, /^item 1: gunzip: /);
  });

  it('settled item errors name the failing stage (jsonPluck path not found)', async () => {
    const out = await pipeline().jsonPluck('missing.path').settled().run(['{}']);
    assert.equal(out[0].ok, false);
    assert.match(out[0].error!, /jsonPluck: path not found: missing\.path/);
  });

  it('failFast utf8 error carries the stage op', async () => {
    await assert.rejects(
      pipeline().utf8().run([Buffer.from([0xff, 0xfe])]),
      /item 0: utf8: /
    );
  });
});

describe('count terminal', () => {
  it('counts all items when everything succeeds', async () => {
    assert.equal(await pipeline().sha256Hex().count(['a', 'b', 'c']), 3);
  });

  it('settled mode counts only successes', async () => {
    const items = ['a1', 'zz', 'b2', 'yy'];
    assert.equal(
      await pipeline().regexExtract('[0-9]').settled().count(items),
      2
    );
  });

  it('failFast mode still rejects on an item error', async () => {
    await assert.rejects(
      pipeline().regexExtract('[0-9]').count(['a1', 'zz']),
      /item 1: regexExtract: no match/
    );
  });
});

describe('writeFiles terminal', () => {
  it('writes item i to {dir}/{i}{ext} and resolves the paths', async () => {
    const dir = makeTmpDir('bp-write-');
    try {
      const paths = await pipeline()
        .uppercase()
        .writeFiles(['first', 'second'], { dir, ext: '.txt' });
      assert.deepEqual(paths, [path.join(dir, '0.txt'), path.join(dir, '1.txt')]);
      assert.equal(fs.readFileSync(paths[0], 'utf8'), 'FIRST');
      assert.equal(fs.readFileSync(paths[1], 'utf8'), 'SECOND');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['0.txt', '1.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settled mode skips failed items (paths keep original indexes)', async () => {
    const dir = makeTmpDir('bp-write-settled-');
    try {
      const paths = await pipeline()
        .regexExtract('^[ab]+$')
        .settled()
        .writeFiles(['a', 'b', 'nope', 'zz'], { dir, ext: '.out' });
      assert.deepEqual(paths.sort(), [path.join(dir, '0.out'), path.join(dir, '1.out')]);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['0.out', '1.out']);
      assert.equal(fs.readFileSync(path.join(dir, '0.out'), 'utf8'), 'a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('failFast mode rejects when any item fails', async () => {
    const dir = makeTmpDir('bp-write-ff-');
    try {
      await assert.rejects(
        pipeline().regexExtract('^[ab]+$').writeFiles(['a', 'zz'], { dir }),
        /item 1: regexExtract: no match/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a {dir} option', () => {
    assert.throws(() => pipeline().uppercase().writeFiles(['a'], {} as any), TypeError);
  });
});

describe('files() source', () => {
  async function withTempFiles<T>(
    contents: string[],
    fn: (paths: string[], dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = makeTmpDir('bp-src-');
    try {
      const paths = contents.map((c, i) => {
        const p = path.join(dir, `f${i}.txt`);
        fs.writeFileSync(p, c);
        return p;
      });
      return await fn(paths, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads files as Bytes input and runs the chain', async () => {
    await withTempFiles(['Hello', 'World'], async (paths) => {
      const out = await pipeline().utf8().lowercase().run(files(paths));
      assert.deepEqual(out, ['hello', 'world']);
      // hand-computed equivalent
      const hashes = await pipeline().sha256Hex().run(files(paths));
      assert.deepEqual(hashes, [sha256('Hello'), sha256('World')]);
    });
  });

  it('failFast: a missing file rejects with its item index', async () => {
    await withTempFiles(['x'], async (paths, dir) => {
      await assert.rejects(
        pipeline().utf8().run(files([paths[0], path.join(dir, 'missing.txt')])),
        /item 1: readFile /
      );
    });
  });

  it('settled: read errors land per-item', async () => {
    await withTempFiles(['x'], async (paths, dir) => {
      const out = await pipeline()
        .utf8()
        .settled()
        .run(files([path.join(dir, 'missing.txt'), paths[0]]));
      assert.equal(out[0].ok, false);
      assert.match(out[0].error!, /^item 0: readFile /);
      assert.deepEqual(out[1], { ok: true, value: 'x' });
    });
  });

  it('count over files() runs natively in both modes', async () => {
    await withTempFiles(['a', 'b'], async (paths, dir) => {
      assert.equal(await pipeline().sha256Hex().count(files(paths)), 2);
      assert.equal(
        await pipeline()
          .utf8()
          .settled()
          .count(files([paths[0], path.join(dir, 'missing.txt'), paths[1]])),
        2
      );
    });
  });

  it('count over files() failFast rejects on an unreadable file', async () => {
    await withTempFiles(['ok'], async (paths, dir) => {
      await assert.rejects(
        pipeline()
          .sha256Hex()
          .count(files([paths[0], path.join(dir, 'gone.bin')])),
        /item 1: readFile /
      );
    });
  });

  it('writeFiles over files(): reads and writes on rayon, content verified', async () => {
    await withTempFiles(['alpha', 'beta'], async (paths) => {
      const outDir = makeTmpDir('bp-fw-out-');
      try {
        const written = await pipeline()
          .sha256Hex()
          .writeFiles(files(paths), { dir: outDir, ext: '.sha' });
        assert.deepEqual(written, [
          path.join(outDir, '0.sha'),
          path.join(outDir, '1.sha'),
        ]);
        assert.equal(fs.readFileSync(written[0], 'utf8'), sha256('alpha'));
        assert.equal(fs.readFileSync(written[1], 'utf8'), sha256('beta'));
        assert.deepEqual(fs.readdirSync(outDir).sort(), ['0.sha', '1.sha']);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  it('writeFiles over files() settled: failed reads are skipped, indexes kept', async () => {
    await withTempFiles(['keep'], async (paths, dir) => {
      const outDir = makeTmpDir('bp-fw-settled-');
      try {
        const written = await pipeline()
          .utf8()
          .uppercase()
          .settled()
          .writeFiles(files([path.join(dir, 'missing.txt'), paths[0]]), {
            dir: outDir,
            ext: '.txt',
          });
        assert.deepEqual(written, [path.join(outDir, '1.txt')]);
        assert.deepEqual(fs.readdirSync(outDir), ['1.txt']);
        assert.equal(fs.readFileSync(written[0], 'utf8'), 'KEEP');
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  it('writeFiles over files() failFast: unreadable file rejects with the readFile item error', async () => {
    await withTempFiles(['ok'], async (paths, dir) => {
      const outDir = makeTmpDir('bp-fw-ff-');
      try {
        await assert.rejects(
          pipeline()
            .sha256Hex()
            .writeFiles(files([paths[0], path.join(dir, 'nope.gz')]), {
              dir: outDir,
            }),
          /item 1: readFile '.*nope\.gz': /
        );
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  it('stream over files(): every path exactly once, values correct per index', async () => {
    const contents = Array.from({ length: 8 }, (_, i) => `doc-${i}`);
    await withTempFiles(contents, async (paths) => {
      const seen = new Map<number, string>();
      const arrivalOrder: number[] = [];
      for await (const { index, value } of pipeline().sha256Hex().stream(files(paths))) {
        assert.ok(!seen.has(index), `index ${index} delivered twice`);
        seen.set(index, value);
        arrivalOrder.push(index);
      }
      assert.equal(seen.size, paths.length);
      for (let i = 0; i < contents.length; i++) {
        assert.equal(seen.get(i), sha256(contents[i]));
      }
      // completion order: a permutation of 0..n-1, not necessarily sorted
      assert.deepEqual(
        [...arrivalOrder].sort((a, b) => a - b),
        contents.map((_, i) => i)
      );
    });
  });

  it('stream over files() failFast: throws at the unreadable file and stops', async () => {
    await withTempFiles(['good'], async (paths, dir) => {
      const missing = path.join(dir, 'nope.bin');
      const got: number[] = [];
      await assert.rejects(
        (async () => {
          for await (const item of pipeline().sha256Hex().stream(files([paths[0], missing]))) {
            got.push(item.index);
          }
        })(),
        /item 1: readFile '.*nope\.bin': /
      );
      assert.ok(got.length <= 1);
      for (const index of got) assert.equal(index, 0);
    });
  });

  it('stream over files() settled: read errors arrive as {ok: false} items', async () => {
    await withTempFiles(['x'], async (paths, dir) => {
      const missing = path.join(dir, 'gone.txt');
      const byIndex = new Map<number, StreamItem>();
      for await (const item of pipeline().utf8().settled().stream(files([missing, paths[0]]))) {
        assert.ok(!byIndex.has(item.index), `index ${item.index} delivered twice`);
        byIndex.set(item.index, item);
      }
      assert.equal(byIndex.size, 2);
      const bad = byIndex.get(0)!;
      assert.equal(bad.ok, false);
      assert.equal(bad.value, undefined);
      assert.match(bad.error!, /^item 0: readFile /);
      assert.deepEqual(byIndex.get(1), { index: 1, ok: true, value: 'x' });
    });
  });

  it('a Str-pinned chain rejects files() input with a clear JS error', () => {
    assert.throws(
      () => pipeline().lowercase().run(files(['/tmp/whatever']) as any),
      /files\(\) source provides Bytes input but the chain expects Str/
    );
  });

  it('files() validates its argument', () => {
    assert.throws(() => files('not-an-array' as any), TypeError);
    assert.throws(() => files([1, 2] as any), TypeError);
    assert.throws(() => files({} as any), TypeError);
    assert.throws(() => files({ glob: 42 } as any), TypeError);
    assert.throws(() => files({ glob: ['ok', 7] } as any), TypeError);
  });
});

describe('files({glob}) source', () => {
  // Fixture tree:
  //   {dir}/a.txt  {dir}/b.md
  //   {dir}/sub/c.txt  {dir}/sub/e.log
  //   {dir}/sub/deep/d.txt
  async function withGlobTree<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = makeTmpDir('bp-glob-');
    try {
      fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
      fs.writeFileSync(path.join(dir, 'b.md'), 'B');
      fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'C');
      fs.writeFileSync(path.join(dir, 'sub', 'e.log'), 'E');
      fs.writeFileSync(path.join(dir, 'sub', 'deep', 'd.txt'), 'D');
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('expandGlob: **/*.txt matches recursively; output sorted and deduplicated', async () => {
    await withGlobTree(async (dir) => {
      const out = await binding.expandGlob([
        `${dir}/**/*.txt`,
        `${dir}/*.txt`, // overlaps the first pattern: dedup must collapse it
      ]);
      assert.deepEqual(out, [
        `${dir}/a.txt`,
        `${dir}/sub/c.txt`,
        `${dir}/sub/deep/d.txt`,
      ]);
    });
  });

  it('expandGlob: * does not cross directories; dirs never match', async () => {
    await withGlobTree(async (dir) => {
      // matches only the top-level .txt — never sub/ (a dir) or nested files
      assert.deepEqual(await binding.expandGlob([`${dir}/*.txt`]), [`${dir}/a.txt`]);
      // `sub` itself is a directory: a pattern matching it yields nothing
      assert.deepEqual(await binding.expandGlob([`${dir}/s*b`]), []);
    });
  });

  it('expandGlob: literal (meta-free) patterns pass through, existence not required', async () => {
    await withGlobTree(async (dir) => {
      const ghost = path.join(dir, 'not-there.gz');
      const out = await binding.expandGlob([ghost, `${dir}/*.md`, ghost]);
      assert.deepEqual(out, [`${dir}/b.md`, ghost]); // sorted, deduplicated
    });
  });

  it('invalid glob pattern throws synchronously with code InvalidArg, naming it', () => {
    const isInvalidArg = (err: unknown) => {
      assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
      assert.match((err as Error).message, /expandGlob: invalid pattern '\[unclosed'/);
      return true;
    };
    assert.throws(() => binding.expandGlob(['[unclosed']), isInvalidArg);
    // same convention through the builder terminals
    assert.throws(
      () => pipeline().sha256Hex().count(files({ glob: '[unclosed' })),
      isInvalidArg
    );
    assert.throws(
      () => pipeline().sha256Hex().stream(files({ glob: '[unclosed' })),
      isInvalidArg
    );
  });

  it('files({glob}) end-to-end: run, count, writeFiles, and stream agree', async () => {
    await withGlobTree(async (dir) => {
      const src = () => files({ glob: `${dir}/**/*.txt` });
      const contents = ['A', 'C', 'D']; // sorted path order: a, sub/c, sub/deep/d

      // run (collect)
      assert.deepEqual(await pipeline().utf8().lowercase().run(src()), ['a', 'c', 'd']);

      // count (native)
      assert.equal(await pipeline().sha256Hex().count(src()), 3);

      // writeFiles
      const outDir = makeTmpDir('bp-glob-out-');
      try {
        const written = await pipeline().utf8().writeFiles(src(), { dir: outDir, ext: '.txt' });
        assert.deepEqual(
          written,
          contents.map((_, i) => path.join(outDir, `${i}.txt`))
        );
        assert.deepEqual(
          written.map((p) => fs.readFileSync(p, 'utf8')),
          contents
        );
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }

      // stream (item count = expanded path count)
      const seen = new Map<number, string>();
      for await (const { index, value } of pipeline().utf8().stream(src())) {
        assert.ok(!seen.has(index), `index ${index} delivered twice`);
        seen.set(index, value);
      }
      assert.deepEqual(
        [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
        contents
      );
    });
  });

  it('files({glob}) accepts an array of patterns; settled run reports per item', async () => {
    await withGlobTree(async (dir) => {
      const out = await pipeline()
        .utf8()
        .run(files({ glob: [`${dir}/*.md`, `${dir}/sub/*.log`] }));
      assert.deepEqual(out, ['B', 'E']); // sorted: b.md then sub/e.log
      const settled = await pipeline()
        .utf8()
        .settled()
        .run(files({ glob: [`${dir}/*.md`] }));
      assert.deepEqual(settled, [{ ok: true, value: 'B' }]);
    });
  });

  it('a glob matching nothing behaves as an empty batch on every terminal', async () => {
    await withGlobTree(async (dir) => {
      const src = () => files({ glob: `${dir}/*.nope` });
      assert.deepEqual(await pipeline().sha256Hex().run(src()), []);
      assert.equal(await pipeline().sha256Hex().count(src()), 0);
      const seen: unknown[] = [];
      for await (const item of pipeline().sha256Hex().stream(src())) seen.push(item);
      assert.deepEqual(seen, []);
    });
  });
});

describe('stream terminal', () => {
  it('failFast: yields {index, value}, every index exactly once, values correct per index', async () => {
    const inputs = Array.from({ length: 16 }, (_, i) => `item-${i}`);
    const seen = new Map<number, string>();
    const arrivalOrder: number[] = [];
    for await (const { index, value } of pipeline().sha256Hex().stream(inputs)) {
      assert.ok(!seen.has(index), `index ${index} delivered twice`);
      seen.set(index, value);
      arrivalOrder.push(index);
    }
    assert.equal(seen.size, inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      assert.equal(seen.get(i), sha256(inputs[i]));
    }
    // completion order: a permutation of 0..n-1, not necessarily sorted
    assert.deepEqual([...arrivalOrder].sort((a, b) => a - b),
      inputs.map((_, i) => i));
  });

  it('failFast: throws mid-stream at the first failed item and stops', async () => {
    const inputs = ['a1', 'b2', 'zz', 'c3', 'dd'];
    const got: StreamValue<string>[] = [];
    await assert.rejects(
      (async () => {
        for await (const item of pipeline().regexExtract('[0-9]').stream(inputs)) {
          got.push(item);
        }
      })(),
      (err: unknown) => {
        assert.match((err as Error).message, /^item [24]: regexExtract: no match$/);
        return true;
      }
    );
    // only successful items were yielded before the throw
    for (const { index, value } of got) {
      assert.equal(value, inputs[index].match(/[0-9]/)![0]);
    }
    assert.ok(got.length <= 3);
  });

  it('settled: delivers ALL items as {index, ok, value?, error?}, exactly once each', async () => {
    const inputs = ['a1', 'zz', 'b2', 'yy'];
    const byIndex = new Map<number, StreamItem>();
    for await (const item of pipeline().regexExtract('[0-9]').settled().stream(inputs)) {
      assert.ok(!byIndex.has(item.index), `index ${item.index} delivered twice`);
      byIndex.set(item.index, item);
    }
    assert.equal(byIndex.size, 4);
    assert.deepEqual(byIndex.get(0), { index: 0, ok: true, value: '1' });
    assert.deepEqual(byIndex.get(2), { index: 2, ok: true, value: '2' });
    for (const i of [1, 3]) {
      const item = byIndex.get(i)!;
      assert.equal(item.ok, false);
      assert.equal(item.value, undefined);
      assert.match(item.error!, new RegExp(`^item ${i}: regexExtract: no match$`));
    }
  });

  it('empty input completes immediately', async () => {
    const seen: StreamValue<string>[] = [];
    for await (const item of pipeline().sha256Hex().stream([])) seen.push(item);
    assert.deepEqual(seen, []);
  });
});

describe('invalid chains and bad plans', () => {
  it('JS builder throws synchronously on an invalid chain, naming stage and kinds', () => {
    assert.throws(
      () => (pipeline().gunzip() as any).lowercase(),
      /stage 1 \(lowercase\) expects Str input but receives Bytes/
    );
    assert.throws(
      () => (pipeline().lowercase() as any).gunzip(),
      /stage 1 \(gunzip\) expects Bytes input but receives Str/
    );
    assert.throws(
      () => (pipeline().sha256Hex() as any).gzip(),
      /stage 1 \(gzip\) expects Bytes input but receives Str/
    );
    assert.throws(
      () => (pipeline().bytes() as any).trim(),
      /stage 1 \(trim\) expects Str input but receives Bytes/
    );
  });

  it('JS builder validates stage arguments synchronously', () => {
    assert.throws(() => pipeline().jsonPluck(''), TypeError);
    assert.throws(() => pipeline().normalize('NFX' as any), TypeError);
    assert.throws(() => (pipeline() as any).regexReplace('a'), TypeError);
    assert.throws(() => pipeline().regexExtract('a', 'g' as any), TypeError);
  });

  it('native compile_plan rejects an invalid chain synchronously', () => {
    assert.throws(
      () =>
        binding.runPipelineCollect(
          makePlan([{ op: 'gunzip' }, { op: 'lowercase' }]),
          [Buffer.from('x')]
        ),
      /stage 1 \(lowercase\) expects Str input but receives Bytes/
    );
  });

  it('native compile_plan rejects a bad regex synchronously, naming the stage', () => {
    assert.throws(
      () => binding.runPipelineCollect(makePlan([{ op: 'regexExtract', pattern: '(' }]), ['a']),
      /stage 0 \(regexExtract\)/
    );
  });

  it('bad plan JSON rejects (malformed JSON and unknown op)', () => {
    assert.throws(
      () => binding.runPipelineCollect('this is not json', [Buffer.from('x')]),
      /invalid plan JSON/
    );
    assert.throws(
      () => binding.runPipelineCollect(makePlan([{ op: 'frobnicate' }]), ['x']),
      /invalid plan JSON: unknown variant `frobnicate`/
    );
  });

  it('non-array pipeline input throws a TypeError synchronously', () => {
    assert.throws(() => pipeline().sha256Hex().run('not an array' as any), TypeError);
    assert.throws(() => pipeline().sha256Hex().count(null as any), TypeError);
  });
});

describe('regressions', () => {
  it('gunzip: multi-member decodes fully, trailing garbage is an item error', async () => {
    const multi = Buffer.concat([zlib.gzipSync('hello '), zlib.gzipSync('world')]);
    assert.deepEqual(await pipeline().gunzip().utf8().run([multi]), ['hello world']);
    const garbage = Buffer.concat([zlib.gzipSync('ok'), Buffer.from('JUNK')]);
    // flate2 rejects header-shaped garbage itself; our strict check catches the rest —
    // either way it must be an item 0 gunzip error, matching node:zlib's rejection.
    await assert.rejects(pipeline().gunzip().run([garbage]), (err: unknown) => {
      assert.match((err as Error).message, /^item 0: gunzip: /);
      return true;
    });
  });

  it('regexReplace uses Rust replacement syntax: ${1} and $0 work, $& stays literal', async () => {
    assert.deepEqual(await pipeline().regexReplace('(\\w+)@x', '${1}!').run(['ab@x']), ['ab!']);
    assert.deepEqual(await pipeline().regexReplace('b+', '<$0>').run(['abbc']), ['a<bb>c']);
    assert.deepEqual(await pipeline().regexReplace('b', '[$&]').run(['abc']), ['a[$&]c']);
  });

  it('jsonPluck: JSON null value yields the string "null"', async () => {
    assert.deepEqual(await pipeline().jsonPluck('a').run(['{"a":null}']), ['null']);
  });

  it('builder rejects non-integer numeric stage args synchronously with the op name', () => {
    assert.throws(() => pipeline().gzip(NaN), /gzip level must be an integer/);
    assert.throws(() => pipeline().gzip(1.5), /gzip level must be an integer/);
    assert.throws(() => pipeline().zstdCompress(Infinity), /zstdCompress level must be an integer/);
    assert.throws(() => pipeline().regexExtract('(a)', 1.5 as never), /regexExtract group must be an integer/);
  });
});
