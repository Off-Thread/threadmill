// Codec kernel tests: brotli, base64, hex, crc32/crc32c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import b from '@offthread/threadmill';

const HEX8 = /^[0-9a-f]{8}$/;

// Lengths 0-5 cover every base64 padding shape and hex parity; then bigger blobs.
const SAMPLES = [
  Buffer.alloc(0),
  Buffer.from('a'),
  Buffer.from('hi'),
  Buffer.from('héllo wörld 🚀'),
  crypto.randomBytes(1),
  crypto.randomBytes(2),
  crypto.randomBytes(3),
  crypto.randomBytes(4),
  crypto.randomBytes(5),
  Buffer.from('hello hello hello hello hello hello'),
  crypto.randomBytes(50_000), // incompressible
];

const isInvalidArg = (re: RegExp) => (err: unknown) => {
  assert.equal((err as NodeJS.ErrnoException).code, 'InvalidArg');
  assert.match((err as Error).message, re);
  return true;
};

// ---------------------------------------------------------------- brotli

test('brotliCompressBatch round-trips through brotliDecompressBatch', async () => {
  const packed = await b.brotliCompressBatch(SAMPLES);
  for (const p of packed) assert.ok(Buffer.isBuffer(p));
  assert.deepEqual(await b.brotliDecompressBatch(packed), SAMPLES);
});

test('brotliCompressBatch output is valid for node:zlib brotliDecompressSync', async () => {
  const packed = await b.brotliCompressBatch(SAMPLES);
  packed.forEach((p, i) => assert.deepEqual(zlib.brotliDecompressSync(p), SAMPLES[i]));
});

test('brotliDecompressBatch decodes node:zlib brotliCompressSync output', async () => {
  const packed = SAMPLES.map((s) => zlib.brotliCompressSync(s));
  assert.deepEqual(await b.brotliDecompressBatch(packed), SAMPLES);
});

test('brotli quality is honored: higher quality shrinks compressible data more', async () => {
  const big = Buffer.from('abcdef'.repeat(10_000));
  const [q0] = await b.brotliCompressBatch([big], { quality: 0 });
  const [q11] = await b.brotliCompressBatch([big], { quality: 11 });
  assert.ok(q11.length < q0.length, `q11 (${q11.length}) should be < q0 (${q0.length})`);
  assert.ok(q11.length < big.length / 10);
  // both still round-trip
  assert.deepEqual(await b.brotliDecompressBatch([q0, q11]), [big, big]);
});

test('brotli lgwin and empty-opts round-trip', async () => {
  const big = Buffer.from(JSON.stringify({ bio: 'é🚀 data '.repeat(500) }));
  for (const opts of [undefined, {}, { lgwin: 10 }, { lgwin: 24, quality: 3 }]) {
    const [p] = await b.brotliCompressBatch([big], opts);
    assert.deepEqual(zlib.brotliDecompressSync(p), big);
  }
});

test('brotliCompressBatch validates quality and lgwin synchronously as InvalidArg', () => {
  const item = [Buffer.from('x')];
  assert.throws(() => b.brotliCompressBatch(item, { quality: 12 }), isInvalidArg(/quality must be 0-11, got 12/));
  assert.throws(() => b.brotliCompressBatch(item, { quality: -1 }), isInvalidArg(/quality must be 0-11, got -1/));
  assert.throws(() => b.brotliCompressBatch(item, { lgwin: 9 }), isInvalidArg(/lgwin must be 10-24, got 9/));
  assert.throws(() => b.brotliCompressBatch(item, { lgwin: 25 }), isInvalidArg(/lgwin must be 10-24, got 25/));
});

test('brotliDecompressBatch: corrupt input rejects and names the failing item', async () => {
  const good = zlib.brotliCompressSync(Buffer.from('fine and dandy'));
  const truncated = good.subarray(0, Math.max(1, Math.floor(good.length / 2)));
  await assert.rejects(b.brotliDecompressBatch([good, truncated]), (err: unknown) => {
    assert.match((err as Error).message, /^item 1: brotliDecompress: /);
    return true;
  });
  // empty input is not a valid brotli stream (node:zlib agrees)
  assert.throws(() => zlib.brotliDecompressSync(Buffer.alloc(0)));
  await assert.rejects(b.brotliDecompressBatch([Buffer.alloc(0)]), /^Error: item 0: brotliDecompress: /);
});

// ---------------------------------------------------------------- base64

test('base64EncodeBatch matches Buffer.toString("base64"), standard padded', async () => {
  const got = await b.base64EncodeBatch(SAMPLES);
  assert.deepEqual(got, SAMPLES.map((s) => s.toString('base64')));
});

test('base64EncodeBatch accepts strings and encodes their UTF-8 bytes', async () => {
  const got = await b.base64EncodeBatch(['hello', '', 'héllo 🚀']);
  assert.deepEqual(got, ['hello', '', 'héllo 🚀'].map((s) => Buffer.from(s, 'utf8').toString('base64')));
});

test('base64DecodeBatch matches Buffer.from(x, "base64") on padded input', async () => {
  const encoded = SAMPLES.map((s) => s.toString('base64'));
  const got = await b.base64DecodeBatch(encoded);
  assert.deepEqual(got, encoded.map((s) => Buffer.from(s, 'base64')));
  assert.deepEqual(got, SAMPLES);
});

test('base64DecodeBatch accepts unpadded input too', async () => {
  const unpadded = SAMPLES.map((s) => s.toString('base64').replace(/=+$/, ''));
  assert.deepEqual(await b.base64DecodeBatch(unpadded), SAMPLES);
});

test('base64DecodeBatch is strictly canonical: junk, whitespace, bad trailing bits reject with the item index', async () => {
  // 'aGl' has non-zero trailing bits ('aGk' is the canonical spelling);
  // Buffer.from forgives all of these — we document strictness instead.
  for (const bad of ['!!!', ' aGk=', 'aGl', 'aG=k']) {
    await assert.rejects(b.base64DecodeBatch(['aGk=', bad]), (err: unknown) => {
      assert.match((err as Error).message, /^item 1: base64Decode: /);
      return true;
    });
  }
});

// ---------------------------------------------------------------- hex

test('hexEncodeBatch matches Buffer.toString("hex"), lowercase', async () => {
  const got = await b.hexEncodeBatch(SAMPLES);
  assert.deepEqual(got, SAMPLES.map((s) => s.toString('hex')));
  for (const h of got) assert.doesNotMatch(h, /[A-Z]/);
});

test('hexEncodeBatch accepts strings and encodes their UTF-8 bytes', async () => {
  assert.deepEqual(await b.hexEncodeBatch(['hi', '', 'é🚀']), [
    Buffer.from('hi').toString('hex'),
    '',
    Buffer.from('é🚀').toString('hex'),
  ]);
});

test('hexDecodeBatch accepts upper, lower, and mixed case; matches Buffer.from(x, "hex")', async () => {
  const lower = SAMPLES.map((s) => s.toString('hex'));
  assert.deepEqual(await b.hexDecodeBatch(lower), SAMPLES);
  assert.deepEqual(await b.hexDecodeBatch(lower.map((s) => s.toUpperCase())), SAMPLES);
  assert.deepEqual(await b.hexDecodeBatch(['DeadBEEF']), [Buffer.from('deadbeef', 'hex')]);
});

test('hexDecodeBatch: odd length or non-hex characters reject with the item index', async () => {
  for (const bad of ['abc', 'zz', '12 34']) {
    await assert.rejects(b.hexDecodeBatch(['ab', bad, 'cd']), (err: unknown) => {
      assert.match((err as Error).message, /^item 1: hexDecode: /);
      return true;
    });
  }
});

test('base64/hex round-trip: encode then decode is identity', async () => {
  assert.deepEqual(await b.base64DecodeBatch(await b.base64EncodeBatch(SAMPLES)), SAMPLES);
  assert.deepEqual(await b.hexDecodeBatch(await b.hexEncodeBatch(SAMPLES)), SAMPLES);
});

// ---------------------------------------------------------------- crc32

test('crc32HexBatch: known check vector and node:zlib cross-check', async () => {
  // CRC-32/IEEE check value: crc32("123456789") = cbf43926.
  assert.deepEqual(await b.crc32HexBatch(['123456789', Buffer.from('123456789')]), ['cbf43926', 'cbf43926']);
  const got = await b.crc32HexBatch(SAMPLES);
  assert.deepEqual(got, SAMPLES.map((s) => (zlib.crc32(s) >>> 0).toString(16).padStart(8, '0')));
  for (const h of got) assert.match(h, HEX8);
});

test('crc32cHexBatch: known check vector (Castagnoli)', async () => {
  // CRC-32C check value: crc32c("123456789") = e3069283.
  assert.deepEqual(await b.crc32cHexBatch(['123456789', Buffer.from('123456789')]), ['e3069283', 'e3069283']);
  const got = await b.crc32cHexBatch(SAMPLES);
  for (const h of got) assert.match(h, HEX8);
  assert.deepEqual(await b.crc32cHexBatch(SAMPLES), got); // deterministic
  assert.notEqual(got[1], got[2]); // input-sensitive
});

test('crc32/crc32c of empty input is 00000000 (shows zero-padding to 8 chars)', async () => {
  assert.deepEqual(await b.crc32HexBatch([Buffer.alloc(0), '']), ['00000000', '00000000']);
  assert.deepEqual(await b.crc32cHexBatch([Buffer.alloc(0), '']), ['00000000', '00000000']);
});

test('crc32 and crc32c are different polynomials (differ on the same input)', async () => {
  const [ieee] = await b.crc32HexBatch(['123456789']);
  const [castagnoli] = await b.crc32cHexBatch(['123456789']);
  assert.notEqual(ieee, castagnoli);
});

// ---------------------------------------------------------------- empty batches

test('empty batches resolve to empty results for every codec kernel', async () => {
  assert.deepEqual(await b.brotliCompressBatch([]), []);
  assert.deepEqual(await b.brotliCompressBatch([], { quality: 11 }), []);
  assert.deepEqual(await b.brotliDecompressBatch([]), []);
  assert.deepEqual(await b.base64EncodeBatch([]), []);
  assert.deepEqual(await b.base64DecodeBatch([]), []);
  assert.deepEqual(await b.hexEncodeBatch([]), []);
  assert.deepEqual(await b.hexDecodeBatch([]), []);
  assert.deepEqual(await b.crc32HexBatch([]), []);
  assert.deepEqual(await b.crc32cHexBatch([]), []);
});
