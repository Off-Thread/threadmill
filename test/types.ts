/// <reference types="node" />
// Compile-only checks for the phantom-generic pipeline typings, run against
// the INSTALLED package (self-installed tarball in the root node_modules).
// Verify with: npm run test:types (after npm test's pretest setup)
// Negative cases are marked @ts-expect-error — tsc fails if any of them
// unexpectedly type-checks (unused directive), so both directions are tested.

import {
  pipeline,
  files,
  sha256HexBatch,
  threadCount,
  compilePipelinePlan,
  runPipelineCollect,
  type ExternalObject,
  type SettledItem,
  type StreamItem,
} from '@offthread/threadmill';

declare const bufs: Buffer[];
declare const strs: string[];

// ---------- positive ----------

// 1. Binding re-exports survive through index.
const hashes: Promise<string[]> = sha256HexBatch(bufs);
const threads: number = threadCount();

// 2. The flagship chain: Bytes -> Str, Buffer input, string results.
const p1: Promise<string[]> = pipeline()
  .gunzip()
  .jsonPluck('user.email')
  .lowercase()
  .sha256Hex()
  .run(bufs);

// 3. Bytes-only chain resolves Buffer[].
const p2: Promise<Buffer[]> = pipeline().gunzip().gzip(9).run(bufs);

// 4. Str-only chain: string input, string results.
const p3: Promise<string[]> = pipeline()
  .trim()
  .normalize('NFC')
  .regexReplace('a+', 'a')
  .uppercase()
  .run(strs);

// 5. Str -> Bytes conversion: input stays string[], results become Buffer[].
const p4: Promise<Buffer[]> = pipeline().lowercase().bytes().zstdCompress(3).run(strs);

// 6. files() source feeds a bytes-consuming chain.
const p5: Promise<string[]> = pipeline()
  .gunzip()
  .sha256Hex()
  .run(files(['/data/a.gz', '/data/b.gz']));

// 7. settled() switches the run result to SettledItem[].
const p6: Promise<SettledItem[]> = pipeline().gunzip().settled().run(bufs);

// 8. Either-input first stage accepts Buffer[] and string[] alike.
const c1: Promise<number> = pipeline().sha256Hex().count(bufs);
const c2: Promise<number> = pipeline().jsonPluck('id').count(strs);

// 9. writeFiles resolves the written paths.
const w1: Promise<string[]> = pipeline()
  .gunzip()
  .writeFiles(bufs, { dir: '/tmp/out', ext: '.bin' });

// 10. stream(): failFast yields {index, value}, settled yields StreamItem.
async function consume(): Promise<void> {
  for await (const item of pipeline().lowercase().stream(strs)) {
    const i: number = item.index;
    const v: string = item.value;
    void i;
    void v;
  }
  for await (const item of pipeline().gunzip().stream(bufs)) {
    const v: Buffer = item.value;
    void v;
  }
  for await (const item of pipeline().lowercase().settled().stream(strs)) {
    const s: StreamItem = item;
    void s;
  }
}

// 11. regexExtract keeps the Str chain going.
const p7: Promise<string[]> = pipeline()
  .utf8()
  .regexExtract('(\\d+)', 1)
  .run(bufs);

// 13. Brotli stages stay on the Bytes chain; Buffer results.
const w2a: Promise<Buffer[]> = pipeline()
  .brotliCompress({ quality: 5, lgwin: 22 })
  .brotliDecompress()
  .run(bufs);

// 14. HTML/search/token Str stages chain on Str and pin string[] input.
const w2b: Promise<string[]> = pipeline()
  .markdownToHtml({ unsafe: true })
  .sanitizeHtml({ allowedTags: ['p', 'strong'] })
  .htmlToText({ width: 40 })
  .multiReplace({ patterns: ['a'], replacements: 'b' })
  .truncateTokens({ encoding: 'cl100k_base', maxTokens: 128, keep: 'end' })
  .run(strs);

// 15. Either-input tabular/extract stages accept Buffer[], string[], and files().
const w2c: Promise<string[]> = pipeline()
  .csvToNdjson({ delimiter: ';', hasHeader: true })
  .ndjsonTransform({ filter: [{ path: 'n', op: 'gt', value: 5 }], project: ['n'] })
  .run(bufs);
const w2d: Promise<number> = pipeline().crc32cHex().count(strs);
const w2e: Promise<string[]> = pipeline()
  .gunzip()
  .htmlExtract({ selector: 'a', extract: { attr: 'href' }, all: true })
  .run(files(['/data/page.gz']));
const w2f: Promise<string[]> = pipeline().xxh64Hex().run(bufs);

// 16. Str -> Bytes decoders: string input pinned, Buffer results, Bytes chain continues.
const w2g: Promise<Buffer[]> = pipeline().base64Decode().gunzip().run(strs);
const w2h: Promise<string[]> = pipeline().hexDecode().utf8().run(strs);

// 17. Either->Str encoders keep the Str chain going after a Bytes chain.
const w2i: Promise<string[]> = pipeline()
  .bytes()
  .brotliCompress()
  .base64Encode()
  .lowercase()
  .run(strs);
const w2j: Promise<string[]> = pipeline().multiFind({ patterns: ['x'], limit: 3 }).run(strs);

// 18. files() sources flow through every terminal, and accept {glob} with a
// single pattern or a pattern array.
const f1: Promise<string[]> = pipeline()
  .gunzip()
  .sha256Hex()
  .writeFiles(files(['/data/a.gz']), { dir: '/tmp/out', ext: '.sha' });
const f2: Promise<string[]> = pipeline().sha256Hex().run(files({ glob: 'logs/**' }));
const f3: Promise<number> = pipeline()
  .gunzip()
  .count(files({ glob: ['a/*.gz', 'b/*.gz'] }));
async function consumeFiles(): Promise<void> {
  for await (const item of pipeline().gunzip().utf8().stream(files({ glob: '*.gz' }))) {
    const i: number = item.index;
    const v: string = item.value;
    void i;
    void v;
  }
  for await (const item of pipeline().gunzip().settled().stream(files(['/a.gz']))) {
    const s: StreamItem = item;
    void s;
  }
}

// 12. compilePipelinePlan returns a plan handle every runPipeline* accepts
// alongside raw plan JSON.
const compiledPlan: ExternalObject<'PipelinePlan'> = compilePipelinePlan(
  '{"stages":[]}',
  'bytes'
);
const r1: Promise<string[] | Buffer[]> = runPipelineCollect(compiledPlan, bufs);
const r2: Promise<string[] | Buffer[]> = runPipelineCollect('{"stages":[]}', bufs);

// ---------- negative ----------

// N1. Str-only stage on a Bytes chain.
// @ts-expect-error lowercase does not exist on BytesPipeline
pipeline().gunzip().lowercase();

// N2. Bytes-only stage on a Str chain.
// @ts-expect-error gunzip does not exist on StrPipeline
pipeline().lowercase().gunzip();

// N3. A str-consuming first stage pins string[] input.
// @ts-expect-error Buffer[] is not assignable to string[]
pipeline().lowercase().run(bufs);

// N4. A bytes-consuming first stage rejects string[] input.
// @ts-expect-error string[] is not assignable to Buffer[] | FilesSource
pipeline().gunzip().run(strs);

// N5. files() glob form is a string or string[], nothing else.
// @ts-expect-error glob must be a string or string[]
files({ glob: 42 });

// N6. After settled(), run no longer resolves plain string[].
// @ts-expect-error Promise<SettledItem[]> is not Promise<string[]>
const bad1: Promise<string[]> = pipeline().lowercase().settled().run(strs);

// N7. normalize only accepts the four Unicode forms.
// @ts-expect-error 'NFX' is not a NormalizeForm
pipeline().normalize('NFX');

// N8. compilePipelinePlan's inputKind is a closed union.
// @ts-expect-error 'buffers' is not a valid inputKind
compilePipelinePlan('{"stages":[]}', 'buffers');

// N9. Config-taking Str-only stage on a Bytes chain.
// @ts-expect-error multiReplace does not exist on BytesPipeline
pipeline().gunzip().multiReplace({ patterns: ['a'], replacements: 'b' });

// N10. Bytes-only codec stage on a Str chain.
// @ts-expect-error brotliCompress does not exist on StrPipeline
pipeline().lowercase().brotliCompress();

// N11. Str -> Bytes decoder pins string[] input.
// @ts-expect-error Buffer[] is not assignable to string[]
pipeline().base64Decode().run(bufs);

// N12. Bad config types are rejected.
// @ts-expect-error 'bogus' is not a TruncateTokensConfig encoding
pipeline().truncateTokens({ encoding: 'bogus', maxTokens: 4 });
// @ts-expect-error 'attr' alone is not a valid extract keyword
pipeline().htmlExtract({ selector: 'a', extract: 'attr' });
// @ts-expect-error quality must be a number
pipeline().brotliCompress({ quality: '5' });
// @ts-expect-error 'gte' is not an NdjsonFilter op
pipeline().ndjsonTransform({ filter: [{ path: 'n', op: 'gte', value: 1 }] });

// N13. Decoded Bytes chain no longer offers Str-only stages.
// @ts-expect-error lowercase does not exist on BytesPipeline
pipeline().base64Decode().lowercase();

void hashes;
void threads;
void p1;
void p2;
void p3;
void p4;
void p5;
void p6;
void p7;
void compiledPlan;
void r1;
void r2;
void c1;
void c2;
void w1;
void consume;
void f1;
void f2;
void f3;
void consumeFiles;
void w2a;
void w2b;
void w2c;
void w2d;
void w2e;
void w2f;
void w2g;
void w2h;
void w2i;
void w2j;
