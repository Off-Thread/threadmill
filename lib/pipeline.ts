/// <reference types="node" />

// TypeScript source of truth for the fluent pipeline builder. The emitted
// lib/pipeline.js (runtime) and lib/pipeline.d.ts (public phantom-generic
// typings) are generated from this file by `tsc -p tsconfig.json`.
//
// The two chain interfaces (BytesPipeline / StrPipeline) mirror the Rust
// compile_plan type table, so an invalid chain like
// pipeline().gunzip().lowercase() fails at COMPILE time — lowercase does not
// exist on BytesPipeline. The runtime builder below cannot prove those phantom
// types (one class implements every stage; the JS-side STAGES table enforces
// them dynamically), so the public entry points cast. The runtime checks stay
// so untyped JS callers get the same errors.

import type {
  BrotliOptions,
  CsvToNdjsonOptions,
  ExternalObject,
  HtmlExtractConfig,
  HtmlToTextOptions,
  MarkdownHtmlOptions,
  MultiFindConfig,
  MultiReplaceConfig,
  NdjsonFilter,
  NdjsonTransformConfig,
  SanitizeHtmlPolicy,
  SettledItem,
  StreamItem,
  TruncateTokensConfig,
} from '../binding.js';

const binding: typeof import('../binding.js') = require('../binding.js');

// Unique (unregistered) symbol: only files() can produce a FilesSource — an
// input array can't be forged into one via Symbol.for.
const FILES = Symbol('threadmill.files');

type Kind = 'bytes' | 'str';
type NeedKind = Kind | 'any';
type Mode = 'failFast' | 'settled';
type PlanHandle = ExternalObject<'PipelinePlan'>;

const KIND_LABEL: Record<Kind, string> = { bytes: 'Bytes', str: 'Str' };

/** Unicode normalization forms accepted by `.normalize()`. */
export type NormalizeForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

type StageOp =
  | 'gunzip'
  | 'gzip'
  | 'zstdDecompress'
  | 'zstdCompress'
  | 'utf8'
  | 'bytes'
  | 'jsonPluck'
  | 'sha256Hex'
  | 'blake3Hex'
  | 'xxh3Hex'
  | 'xxh64Hex'
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'normalize'
  | 'regexReplace'
  | 'regexExtract'
  | 'sanitizeHtml'
  | 'markdownToHtml'
  | 'htmlToText'
  | 'htmlExtract'
  | 'csvToNdjson'
  | 'ndjsonTransform'
  | 'multiReplace'
  | 'multiFind'
  | 'truncateTokens'
  | 'brotliCompress'
  | 'brotliDecompress'
  | 'base64Encode'
  | 'base64Decode'
  | 'hexEncode'
  | 'hexDecode'
  | 'crc32Hex'
  | 'crc32cHex';

/** One entry of the JSON plan sent to the native compiler. */
interface Stage {
  op: StageOp;
  level?: number;
  path?: string;
  form?: NormalizeForm;
  pattern?: string;
  replacement?: string;
  group?: number;
  // sanitizeHtml
  allowedTags?: string[];
  allowedAttrs?: Record<string, string[]>;
  urlSchemes?: string[];
  stripComments?: boolean;
  // markdownToHtml
  gfm?: boolean;
  tables?: boolean;
  footnotes?: boolean;
  smartPunct?: boolean;
  unsafe?: boolean;
  // htmlToText
  width?: number;
  // htmlExtract
  selector?: string;
  extract?: 'text' | 'html' | { attr: string };
  all?: boolean;
  // csvToNdjson
  delimiter?: string;
  quote?: string;
  hasHeader?: boolean;
  select?: string[];
  // ndjsonTransform
  filter?: NdjsonFilter[];
  project?: string[];
  // multiReplace / multiFind
  patterns?: string[];
  replacements?: string[] | string;
  caseInsensitive?: boolean;
  limit?: number;
  // truncateTokens
  encoding?: 'cl100k_base' | 'o200k_base';
  maxTokens?: number;
  keep?: 'start' | 'end';
  // brotliCompress
  quality?: number;
  lgwin?: number;
}

// op -> [required input kind ('bytes' | 'str' | 'any'), output kind]
// Mirrors the Rust compile_plan type table so invalid chains throw at build
// time in JS, with the same wording the native compiler uses.
const STAGES: Record<StageOp, [NeedKind, Kind]> = {
  gunzip: ['bytes', 'bytes'],
  gzip: ['bytes', 'bytes'],
  zstdDecompress: ['bytes', 'bytes'],
  zstdCompress: ['bytes', 'bytes'],
  utf8: ['bytes', 'str'],
  bytes: ['str', 'bytes'],
  jsonPluck: ['any', 'str'],
  sha256Hex: ['any', 'str'],
  blake3Hex: ['any', 'str'],
  xxh3Hex: ['any', 'str'],
  xxh64Hex: ['any', 'str'],
  lowercase: ['str', 'str'],
  uppercase: ['str', 'str'],
  trim: ['str', 'str'],
  normalize: ['str', 'str'],
  regexReplace: ['str', 'str'],
  regexExtract: ['str', 'str'],
  sanitizeHtml: ['str', 'str'],
  markdownToHtml: ['str', 'str'],
  htmlToText: ['str', 'str'],
  htmlExtract: ['any', 'str'],
  csvToNdjson: ['any', 'str'],
  ndjsonTransform: ['any', 'str'],
  multiReplace: ['str', 'str'],
  multiFind: ['str', 'str'],
  truncateTokens: ['str', 'str'],
  brotliCompress: ['bytes', 'bytes'],
  brotliDecompress: ['bytes', 'bytes'],
  base64Encode: ['any', 'str'],
  base64Decode: ['str', 'bytes'],
  hexEncode: ['any', 'str'],
  hexDecode: ['str', 'bytes'],
  crc32Hex: ['any', 'str'],
  crc32cHex: ['any', 'str'],
};

const NORMALIZE_FORMS: NormalizeForm[] = ['NFC', 'NFD', 'NFKC', 'NFKD'];

declare const filesBrand: unique symbol;

/**
 * Opaque source marker returned by `files()`: each resolved path is read on a
 * rayon thread (off libuv) and enters the chain as Bytes.
 */
export interface FilesSource {
  readonly [filesBrand]: string[];
}

/** Internal payload behind the FILES symbol: exactly one of the two. */
interface FilesPayload {
  paths?: string[];
  globs?: string[];
}

/**
 * Marks pipeline file input: an array of explicit paths, or `{glob}` with one
 * or more glob patterns (expanded natively via `expandGlob` when a terminal
 * runs — matching files only, sorted and deduplicated; `*` does not cross
 * path separators, `**` recurses). Each resolved file is read on a rayon
 * thread (off libuv) and enters the chain as Bytes.
 */
export function files(
  input: string[] | { glob: string | string[] }
): FilesSource {
  if (Array.isArray(input)) {
    if (!input.every((p) => typeof p === 'string')) {
      throw new TypeError('files() expects an array of file path strings');
    }
    return { [FILES]: { paths: input.slice() } } as unknown as FilesSource;
  }
  if (input !== null && typeof input === 'object' && 'glob' in input) {
    const glob = (input as { glob: unknown }).glob;
    const globs = typeof glob === 'string' ? [glob] : glob;
    if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string')) {
      throw new TypeError('files() glob must be a string or string[]');
    }
    return { [FILES]: { globs: globs.slice() } } as unknown as FilesSource;
  }
  throw new TypeError(
    'files() expects an array of file path strings or {glob: string | string[]}'
  );
}

function filesSource(input: unknown): FilesPayload | null {
  return input !== null && typeof input === 'object' && FILES in input
    ? (input as Record<typeof FILES, FilesPayload>)[FILES]
    : null;
}

// Resolve a files() source to concrete paths and hand them to `fn`. Explicit
// paths invoke `fn` SYNCHRONOUSLY; glob patterns expand natively first. An
// invalid glob pattern throws synchronously from expandGlob with code
// InvalidArg.
function withFilesPaths<T>(
  src: FilesPayload,
  fn: (paths: string[]) => Promise<T>
): Promise<T> {
  return src.paths !== undefined
    ? fn(src.paths)
    : binding.expandGlob(src.globs!).then(fn);
}

function checkItems(input: unknown): asserts input is Buffer[] | string[] {
  if (!Array.isArray(input)) {
    throw new TypeError(
      'pipeline input must be a Buffer[] or string[], or files([...paths])'
    );
  }
}

// Integer check up front: NaN would JSON-serialize to null and silently fall
// back to the default value; fractions reach serde as a stage-less error.
function checkOptionalInt(
  op: string,
  what: string,
  v: number | null | undefined
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new TypeError(`${op} ${what} must be an integer, got ${String(v)}`);
  }
}

function checkOptionalLevel(op: string, level: number | null | undefined): void {
  checkOptionalInt(op, 'level', level);
}

function checkOptionalOpts(op: string, opts: unknown): void {
  if (opts === undefined || opts === null) return;
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError(`${op} expects an options object`);
  }
}

function checkRequiredCfg(op: string, cfg: unknown): void {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new TypeError(`${op} expects a config object`);
  }
}

// Mirror the native input-kind inference: empty batches type-check under
// either kind, otherwise the first item pins Buffer vs string. (Mixed arrays
// still get the native per-item error.)
function itemsInputKind(items: readonly unknown[]): 'bytes' | 'str' | 'either' {
  if (items.length === 0) return 'either';
  return Buffer.isBuffer(items[0]) ? 'bytes' : 'str';
}

/** Options for the `.writeFiles()` terminal: item i lands at `{dir}/{i}{ext}`. */
export interface WriteFilesOptions {
  dir: string;
  ext?: string;
}

/** Item yielded by `.stream()` in failFast mode (errors throw instead). */
export interface StreamValue<V> {
  index: number;
  value: V;
}

// queue entry: { val } (yield) or { err } (throw)
interface QueueEntry {
  val?: unknown;
  err?: unknown;
}

// pending next() promise
interface Pull {
  resolve: (result: IteratorResult<unknown>) => void;
  reject: (err: unknown) => void;
}

// Async-iterable wrapper over runPipelineStream / runPipelineFilesStream:
// `start` kicks off the native stream with our callback, `total` is how many
// callbacks to expect. Items arrive in COMPLETION order, exactly one callback
// per item. In failFast mode the iterator throws at the first failed item and
// ignores every later callback; in settled mode all items are delivered as
// {index, ok, value?, error?}.
function makeStream(
  total: number,
  start: (onItem: (err: Error | null, item: StreamItem) => void) => void,
  settled: boolean
): AsyncIterableIterator<unknown> {
  const queue: QueueEntry[] = []; // FIFO
  const pulls: Pull[] = [];
  let received = 0;
  let ended = total === 0; // no more entries will be enqueued
  let closed = false; // consumer finished (done, threw, or broke out)

  function settle(): void {
    while (pulls.length > 0 && queue.length > 0) {
      const entry = queue.shift()!;
      const pull = pulls.shift()!;
      if (entry.err !== undefined) {
        closed = true;
        pull.reject(entry.err);
      } else {
        pull.resolve({ value: entry.val, done: false });
      }
    }
    if (ended && queue.length === 0) {
      while (pulls.length > 0) {
        pulls.shift()!.resolve({ value: undefined, done: true });
      }
    }
  }

  function onItem(err: Error | null, item: StreamItem): void {
    if (ended || closed) return; // late callbacks after a failFast error
    received += 1;
    if (err) {
      ended = true;
      queue.push({ err });
    } else if (settled) {
      queue.push({ val: item });
      if (received === total) ended = true;
    } else if (item.ok) {
      queue.push({ val: { index: item.index, value: item.value } });
      if (received === total) ended = true;
    } else {
      ended = true;
      queue.push({ err: new Error(item.error) });
    }
    settle();
  }

  // Called eagerly so input-shape errors throw synchronously from .stream().
  start(onItem);

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
      return this;
    },
    next(): Promise<IteratorResult<unknown>> {
      if (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.err !== undefined) {
          closed = true;
          return Promise.reject(entry.err);
        }
        return Promise.resolve({ value: entry.val, done: false });
      }
      if (ended || closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<unknown>>((resolve, reject) => {
        pulls.push({ resolve, reject });
      });
    },
    return(value?: unknown): Promise<IteratorResult<unknown>> {
      closed = true;
      queue.length = 0;
      while (pulls.length > 0) {
        pulls.shift()!.resolve({ value: undefined, done: true });
      }
      return Promise.resolve({ value, done: true });
    },
  };
}

// Async-iterator facade over a stream whose backing iterator only exists once
// glob expansion resolves. Every pull forwards to the real iterator; the
// promise chain preserves pull order.
function deferredStream(
  pending: Promise<AsyncIterableIterator<unknown>>
): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
      return this;
    },
    next(): Promise<IteratorResult<unknown>> {
      return pending.then((it) => it.next());
    },
    return(value?: unknown): Promise<IteratorResult<unknown>> {
      return pending.then((it) =>
        it.return !== undefined
          ? it.return(value)
          : { value, done: true as const }
      );
    },
  };
}

/**
 * Chain whose current value kind is Bytes. `In` is the input pinned by the
 * first stage; `M` is the error mode.
 */
export interface BytesPipeline<In, M extends Mode = 'failFast'> {
  gunzip(): BytesPipeline<In, M>;
  gzip(level?: number): BytesPipeline<In, M>;
  zstdDecompress(): BytesPipeline<In, M>;
  zstdCompress(level?: number): BytesPipeline<In, M>;
  brotliCompress(opts?: BrotliOptions): BytesPipeline<In, M>;
  brotliDecompress(): BytesPipeline<In, M>;
  utf8(): StrPipeline<In, M>;
  jsonPluck(path: string): StrPipeline<In, M>;
  sha256Hex(): StrPipeline<In, M>;
  blake3Hex(): StrPipeline<In, M>;
  xxh3Hex(): StrPipeline<In, M>;
  xxh64Hex(): StrPipeline<In, M>;
  htmlExtract(cfg: HtmlExtractConfig): StrPipeline<In, M>;
  csvToNdjson(opts?: CsvToNdjsonOptions): StrPipeline<In, M>;
  ndjsonTransform(cfg: NdjsonTransformConfig): StrPipeline<In, M>;
  base64Encode(): StrPipeline<In, M>;
  hexEncode(): StrPipeline<In, M>;
  crc32Hex(): StrPipeline<In, M>;
  crc32cHex(): StrPipeline<In, M>;
  settled(): BytesPipeline<In, 'settled'>;
  run(input: In): Promise<M extends 'settled' ? SettledItem[] : Buffer[]>;
  count(input: In): Promise<number>;
  writeFiles(input: In, opts: WriteFilesOptions): Promise<string[]>;
  stream(
    input: In
  ): AsyncIterableIterator<M extends 'settled' ? StreamItem : StreamValue<Buffer>>;
}

/**
 * Chain whose current value kind is Str. `In` is the input pinned by the
 * first stage; `M` is the error mode.
 */
export interface StrPipeline<In, M extends Mode = 'failFast'> {
  lowercase(): StrPipeline<In, M>;
  uppercase(): StrPipeline<In, M>;
  trim(): StrPipeline<In, M>;
  normalize(form: NormalizeForm): StrPipeline<In, M>;
  regexReplace(pattern: string, replacement: string): StrPipeline<In, M>;
  regexExtract(pattern: string, group?: number): StrPipeline<In, M>;
  sanitizeHtml(policy?: SanitizeHtmlPolicy): StrPipeline<In, M>;
  markdownToHtml(opts?: MarkdownHtmlOptions): StrPipeline<In, M>;
  htmlToText(opts?: HtmlToTextOptions): StrPipeline<In, M>;
  htmlExtract(cfg: HtmlExtractConfig): StrPipeline<In, M>;
  csvToNdjson(opts?: CsvToNdjsonOptions): StrPipeline<In, M>;
  ndjsonTransform(cfg: NdjsonTransformConfig): StrPipeline<In, M>;
  multiReplace(cfg: MultiReplaceConfig): StrPipeline<In, M>;
  multiFind(cfg: MultiFindConfig): StrPipeline<In, M>;
  truncateTokens(cfg: TruncateTokensConfig): StrPipeline<In, M>;
  jsonPluck(path: string): StrPipeline<In, M>;
  sha256Hex(): StrPipeline<In, M>;
  blake3Hex(): StrPipeline<In, M>;
  xxh3Hex(): StrPipeline<In, M>;
  xxh64Hex(): StrPipeline<In, M>;
  base64Encode(): StrPipeline<In, M>;
  hexEncode(): StrPipeline<In, M>;
  crc32Hex(): StrPipeline<In, M>;
  crc32cHex(): StrPipeline<In, M>;
  bytes(): BytesPipeline<In, M>;
  base64Decode(): BytesPipeline<In, M>;
  hexDecode(): BytesPipeline<In, M>;
  settled(): StrPipeline<In, 'settled'>;
  run(input: In): Promise<M extends 'settled' ? SettledItem[] : string[]>;
  count(input: In): Promise<number>;
  writeFiles(input: In, opts: WriteFilesOptions): Promise<string[]>;
  stream(
    input: In
  ): AsyncIterableIterator<M extends 'settled' ? StreamItem : StreamValue<string>>;
}

/**
 * Empty builder: the first stage pins the input kind. Bytes-consuming first
 * stages accept `Buffer[] | FilesSource` at the terminal, Str-consuming ones
 * `string[]`, and either-input stages (jsonPluck/hashes) leave both open.
 */
export interface FreshPipeline<M extends Mode = 'failFast'> {
  gunzip(): BytesPipeline<Buffer[] | FilesSource, M>;
  gzip(level?: number): BytesPipeline<Buffer[] | FilesSource, M>;
  zstdDecompress(): BytesPipeline<Buffer[] | FilesSource, M>;
  zstdCompress(level?: number): BytesPipeline<Buffer[] | FilesSource, M>;
  brotliCompress(opts?: BrotliOptions): BytesPipeline<Buffer[] | FilesSource, M>;
  brotliDecompress(): BytesPipeline<Buffer[] | FilesSource, M>;
  utf8(): StrPipeline<Buffer[] | FilesSource, M>;
  bytes(): BytesPipeline<string[], M>;
  base64Decode(): BytesPipeline<string[], M>;
  hexDecode(): BytesPipeline<string[], M>;
  lowercase(): StrPipeline<string[], M>;
  uppercase(): StrPipeline<string[], M>;
  trim(): StrPipeline<string[], M>;
  normalize(form: NormalizeForm): StrPipeline<string[], M>;
  regexReplace(pattern: string, replacement: string): StrPipeline<string[], M>;
  regexExtract(pattern: string, group?: number): StrPipeline<string[], M>;
  sanitizeHtml(policy?: SanitizeHtmlPolicy): StrPipeline<string[], M>;
  markdownToHtml(opts?: MarkdownHtmlOptions): StrPipeline<string[], M>;
  htmlToText(opts?: HtmlToTextOptions): StrPipeline<string[], M>;
  multiReplace(cfg: MultiReplaceConfig): StrPipeline<string[], M>;
  multiFind(cfg: MultiFindConfig): StrPipeline<string[], M>;
  truncateTokens(cfg: TruncateTokensConfig): StrPipeline<string[], M>;
  jsonPluck(path: string): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  sha256Hex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  blake3Hex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  xxh3Hex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  xxh64Hex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  htmlExtract(cfg: HtmlExtractConfig): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  csvToNdjson(opts?: CsvToNdjsonOptions): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  ndjsonTransform(cfg: NdjsonTransformConfig): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  base64Encode(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  hexEncode(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  crc32Hex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  crc32cHex(): StrPipeline<Buffer[] | string[] | FilesSource, M>;
  settled(): FreshPipeline<'settled'>;
}

type PipelineInput = Buffer[] | string[] | FilesSource;
type Terminal =
  | { kind: 'collect' }
  | { kind: 'count' }
  | { kind: 'writeFiles'; dir: string; ext: string };

// Immutable fluent builder: every stage method returns a NEW Pipeline (cheap
// array copy), so partial chains can be reused and forked safely. This one
// runtime class backs all three phantom interfaces; pipeline() casts.
class Pipeline {
  private readonly _stages: Stage[];
  private readonly _mode: Mode; // 'failFast' | 'settled'
  private readonly _cur: Kind | null; // value kind flowing out of the last stage, null if none
  private readonly _input: NeedKind | null; // input kind pinned by the first stage ('any' = either)
  // planJson+inputKind -> native compiled-plan External. Builders are
  // immutable, so a compiled plan stays valid for the builder's lifetime;
  // repeat terminal calls skip JSON parsing and regex compilation entirely.
  private readonly _compiled: Map<string, PlanHandle>;

  constructor(
    stages: Stage[],
    mode: Mode,
    cur: Kind | null,
    input: NeedKind | null
  ) {
    this._stages = stages;
    this._mode = mode;
    this._cur = cur;
    this._input = input;
    this._compiled = new Map();
  }

  private _compiledPlan(
    planJson: string,
    inputKind: 'bytes' | 'str' | 'either'
  ): PlanHandle {
    const key = inputKind + ' ' + planJson;
    let plan = this._compiled.get(key);
    if (plan === undefined) {
      plan = binding.compilePipelinePlan(planJson, inputKind);
      this._compiled.set(key, plan);
    }
    return plan;
  }

  private _add(stage: Stage): Pipeline {
    const [need, out] = STAGES[stage.op];
    if (this._cur !== null && need !== 'any' && need !== this._cur) {
      throw new Error(
        `stage ${this._stages.length} (${stage.op}) expects ` +
          `${KIND_LABEL[need]} input but receives ${KIND_LABEL[this._cur]}`
      );
    }
    const input =
      this._input !== null ? this._input : need === 'any' ? 'any' : need;
    return new Pipeline(this._stages.concat([stage]), this._mode, out, input);
  }

  // ---- stages: Bytes -> Bytes ----
  gunzip(): Pipeline {
    return this._add({ op: 'gunzip' });
  }
  gzip(level?: number): Pipeline {
    checkOptionalLevel('gzip', level);
    return this._add(level == null ? { op: 'gzip' } : { op: 'gzip', level });
  }
  zstdDecompress(): Pipeline {
    return this._add({ op: 'zstdDecompress' });
  }
  zstdCompress(level?: number): Pipeline {
    checkOptionalLevel('zstdCompress', level);
    return this._add(
      level == null ? { op: 'zstdCompress' } : { op: 'zstdCompress', level }
    );
  }

  brotliCompress(opts?: BrotliOptions): Pipeline {
    checkOptionalOpts('brotliCompress', opts);
    checkOptionalInt('brotliCompress', 'quality', opts?.quality);
    checkOptionalInt('brotliCompress', 'lgwin', opts?.lgwin);
    return this._add({ op: 'brotliCompress', ...opts });
  }
  brotliDecompress(): Pipeline {
    return this._add({ op: 'brotliDecompress' });
  }

  // ---- stages: kind conversions ----
  utf8(): Pipeline {
    return this._add({ op: 'utf8' });
  }
  bytes(): Pipeline {
    return this._add({ op: 'bytes' });
  }
  base64Decode(): Pipeline {
    return this._add({ op: 'base64Decode' });
  }
  hexDecode(): Pipeline {
    return this._add({ op: 'hexDecode' });
  }

  // ---- stages: Bytes|Str -> Str ----
  jsonPluck(path: string): Pipeline {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('jsonPluck expects a non-empty path string');
    }
    return this._add({ op: 'jsonPluck', path });
  }
  sha256Hex(): Pipeline {
    return this._add({ op: 'sha256Hex' });
  }
  blake3Hex(): Pipeline {
    return this._add({ op: 'blake3Hex' });
  }
  xxh3Hex(): Pipeline {
    return this._add({ op: 'xxh3Hex' });
  }
  xxh64Hex(): Pipeline {
    return this._add({ op: 'xxh64Hex' });
  }
  base64Encode(): Pipeline {
    return this._add({ op: 'base64Encode' });
  }
  hexEncode(): Pipeline {
    return this._add({ op: 'hexEncode' });
  }
  crc32Hex(): Pipeline {
    return this._add({ op: 'crc32Hex' });
  }
  crc32cHex(): Pipeline {
    return this._add({ op: 'crc32cHex' });
  }
  htmlExtract(cfg: HtmlExtractConfig): Pipeline {
    checkRequiredCfg('htmlExtract', cfg);
    if (typeof cfg.selector !== 'string' || cfg.selector.length === 0) {
      throw new TypeError('htmlExtract expects a non-empty selector string');
    }
    return this._add({ op: 'htmlExtract', ...cfg });
  }
  csvToNdjson(opts?: CsvToNdjsonOptions): Pipeline {
    checkOptionalOpts('csvToNdjson', opts);
    return this._add({ op: 'csvToNdjson', ...opts });
  }
  ndjsonTransform(cfg: NdjsonTransformConfig): Pipeline {
    checkRequiredCfg('ndjsonTransform', cfg);
    return this._add({ op: 'ndjsonTransform', ...cfg });
  }

  // ---- stages: Str -> Str ----
  lowercase(): Pipeline {
    return this._add({ op: 'lowercase' });
  }
  uppercase(): Pipeline {
    return this._add({ op: 'uppercase' });
  }
  trim(): Pipeline {
    return this._add({ op: 'trim' });
  }
  normalize(form: NormalizeForm): Pipeline {
    if (!NORMALIZE_FORMS.includes(form)) {
      throw new TypeError(
        `normalize form must be one of ${NORMALIZE_FORMS.join('|')}`
      );
    }
    return this._add({ op: 'normalize', form });
  }
  regexReplace(pattern: string, replacement: string): Pipeline {
    if (typeof pattern !== 'string' || typeof replacement !== 'string') {
      throw new TypeError('regexReplace expects (pattern, replacement) strings');
    }
    return this._add({ op: 'regexReplace', pattern, replacement });
  }
  regexExtract(pattern: string, group?: number | null): Pipeline {
    if (typeof pattern !== 'string') {
      throw new TypeError('regexExtract expects a pattern string');
    }
    if (
      group !== undefined &&
      group !== null &&
      (typeof group !== 'number' || !Number.isInteger(group))
    ) {
      throw new TypeError(`regexExtract group must be an integer, got ${String(group)}`);
    }
    return this._add(
      group == null
        ? { op: 'regexExtract', pattern }
        : { op: 'regexExtract', pattern, group }
    );
  }
  sanitizeHtml(policy?: SanitizeHtmlPolicy): Pipeline {
    checkOptionalOpts('sanitizeHtml', policy);
    return this._add({ op: 'sanitizeHtml', ...policy });
  }
  markdownToHtml(opts?: MarkdownHtmlOptions): Pipeline {
    checkOptionalOpts('markdownToHtml', opts);
    return this._add({ op: 'markdownToHtml', ...opts });
  }
  htmlToText(opts?: HtmlToTextOptions): Pipeline {
    checkOptionalOpts('htmlToText', opts);
    checkOptionalInt('htmlToText', 'width', opts?.width);
    return this._add({ op: 'htmlToText', ...opts });
  }
  multiReplace(cfg: MultiReplaceConfig): Pipeline {
    checkRequiredCfg('multiReplace', cfg);
    if (!Array.isArray(cfg.patterns)) {
      throw new TypeError('multiReplace expects {patterns: string[]}');
    }
    return this._add({ op: 'multiReplace', ...cfg });
  }
  multiFind(cfg: MultiFindConfig): Pipeline {
    checkRequiredCfg('multiFind', cfg);
    if (!Array.isArray(cfg.patterns)) {
      throw new TypeError('multiFind expects {patterns: string[]}');
    }
    checkOptionalInt('multiFind', 'limit', cfg.limit);
    return this._add({ op: 'multiFind', ...cfg });
  }
  truncateTokens(cfg: TruncateTokensConfig): Pipeline {
    checkRequiredCfg('truncateTokens', cfg);
    if (typeof cfg.maxTokens !== 'number' || !Number.isInteger(cfg.maxTokens)) {
      throw new TypeError(
        `truncateTokens maxTokens must be an integer, got ${String(cfg.maxTokens)}`
      );
    }
    return this._add({ op: 'truncateTokens', ...cfg });
  }

  // ---- mode ----
  settled(): Pipeline {
    return new Pipeline(this._stages, 'settled', this._cur, this._input);
  }

  // ---- terminals ----
  private _plan(terminal: Terminal): string {
    return JSON.stringify({
      stages: this._stages,
      mode: this._mode,
      terminal,
    });
  }

  private _checkFilesInput(): void {
    if (this._input === 'str') {
      throw new Error(
        'files() source provides Bytes input but the chain expects Str'
      );
    }
  }

  /** Collect terminal: resolves every item's final value. */
  run(input: PipelineInput): Promise<string[] | Buffer[] | SettledItem[]> {
    const src = filesSource(input);
    const planJson = this._plan({ kind: 'collect' });
    if (src !== null) {
      this._checkFilesInput();
      const plan = this._compiledPlan(planJson, 'bytes');
      return this._mode === 'settled'
        ? withFilesPaths(src, (paths) =>
            binding.runPipelineFilesSettled(plan, paths)
          )
        : withFilesPaths(src, (paths) => binding.runPipelineFiles(plan, paths));
    }
    checkItems(input);
    const plan = this._compiledPlan(planJson, itemsInputKind(input));
    return this._mode === 'settled'
      ? binding.runPipelineSettled(plan, input)
      : binding.runPipelineCollect(plan, input);
  }

  /** Count terminal: number of successful items; results never cross the boundary. */
  count(input: PipelineInput): Promise<number> {
    const src = filesSource(input);
    const planJson = this._plan({ kind: 'count' });
    if (src !== null) {
      this._checkFilesInput();
      const plan = this._compiledPlan(planJson, 'bytes');
      return withFilesPaths(src, (paths) =>
        binding.runPipelineFilesCount(plan, paths)
      );
    }
    checkItems(input);
    return binding.runPipelineCount(
      this._compiledPlan(planJson, itemsInputKind(input)),
      input
    );
  }

  /** WriteFiles terminal: writes item i to `{dir}/{i}{ext}`, resolves written paths. */
  writeFiles(input: PipelineInput, opts: WriteFilesOptions): Promise<string[]> {
    if (
      opts === null ||
      typeof opts !== 'object' ||
      typeof opts.dir !== 'string' ||
      opts.dir.length === 0
    ) {
      throw new TypeError('writeFiles() requires {dir: string}');
    }
    const ext = opts.ext === undefined ? '' : opts.ext;
    if (typeof ext !== 'string') {
      throw new TypeError('writeFiles() ext must be a string');
    }
    const src = filesSource(input);
    const planJson = this._plan({ kind: 'writeFiles', dir: opts.dir, ext });
    if (src !== null) {
      this._checkFilesInput();
      const plan = this._compiledPlan(planJson, 'bytes');
      return withFilesPaths(src, (paths) =>
        binding.runPipelineFilesWriteFiles(plan, paths)
      );
    }
    checkItems(input);
    return binding.runPipelineWriteFiles(
      this._compiledPlan(planJson, itemsInputKind(input)),
      input
    );
  }

  /**
   * Stream terminal: async iterable of per-item results in completion order.
   * failFast yields {index, value} and throws at the first failed item;
   * settled yields every item as {index, ok, value?, error?}.
   */
  stream(input: PipelineInput): AsyncIterableIterator<unknown> {
    const settled = this._mode === 'settled';
    const src = filesSource(input);
    const planJson = this._plan({ kind: 'collect' });
    if (src !== null) {
      this._checkFilesInput();
      const plan = this._compiledPlan(planJson, 'bytes');
      const start = (paths: string[]) =>
        makeStream(
          paths.length,
          (onItem) => binding.runPipelineFilesStream(plan, paths, onItem),
          settled
        );
      if (src.paths !== undefined) return start(src.paths);
      // Glob source: the item count is the EXPANDED path count, so the real
      // stream can only start once expansion resolves.
      return deferredStream(binding.expandGlob(src.globs!).then(start));
    }
    checkItems(input);
    const plan = this._compiledPlan(planJson, itemsInputKind(input));
    return makeStream(
      input.length,
      (onItem) => binding.runPipelineStream(plan, input, onItem),
      settled
    );
  }
}

/**
 * Start a new (empty, failFast) pipeline builder.
 *
 * Conventions shared by every chain:
 * - Invalid stage arguments and invalid chains THROW SYNCHRONOUSLY from the
 *   stage method or terminal (`error.code === 'InvalidArg'` for native ones);
 *   per-item runtime failures reject/settle async as `"item {i}: {op}: {cause}"`.
 * - `regexReplace` uses Rust regex replacement syntax: `$1`/`${1}` for capture
 *   groups (prefer `${1}` — `$1x` parses as the group named "1x") and `$0` for
 *   the whole match. JS-style `$&` is NOT special and stays literal.
 * - `jsonPluck` yields raw content for strings and JSON text otherwise; a JSON
 *   null VALUE is the string "null" (a missing path is an item error; the
 *   `jsonPluckBatch` kernel maps missing paths to JS null instead).
 * - `files()` sources accept explicit paths or `{glob}` patterns (expanded
 *   natively — sorted, deduplicated, files only — before the batch runs) and
 *   work with every terminal: run, count, writeFiles, and stream. `count()`
 *   counts natively for arrays and files alike; results never cross the
 *   native boundary.
 * - A reused builder compiles its plan once and memoizes the native handle.
 */
export function pipeline(): FreshPipeline {
  return new Pipeline([], 'failFast', null, null) as unknown as FreshPipeline;
}
