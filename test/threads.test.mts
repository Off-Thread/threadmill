// Pool-configuration semantics are per-process, so each case runs in a child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = (code: string): string =>
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20_000 }).trim();
// Resolve the INSTALLED package's public entry so child processes exercise it too.
const BINDING = fileURLToPath(import.meta.resolve('@offthread/threadmill'));
const PRELUDE = `const b = require(${JSON.stringify(BINDING)});`;

test('threadCount() is side-effect-free: configureThreads still works after it', () => {
  const out = run(`${PRELUDE}
    const before = b.threadCount();
    b.configureThreads(3);
    console.log(before >= 1, b.threadCount());`);
  assert.equal(out, 'true 3');
});

test('configureThreads rejects out-of-range values with InvalidArg', () => {
  const out = run(`${PRELUDE}
    for (const n of [-1, 0, 1025]) {
      try { b.configureThreads(n); console.log('accepted', n); }
      catch (e) { console.log(e.code, /must be 1-1024/.test(e.message)); }
    }`);
  assert.equal(out, 'InvalidArg true\nInvalidArg true\nInvalidArg true');
});

test('configureThreads after first use fails with a clear message', () => {
  const out = run(`${PRELUDE}
    b.levenshteinBatch(['a'], ['b']).then(() => {
      try { b.configureThreads(2); console.log('accepted'); }
      catch (e) { console.log(/pool already initialized/.test(e.message)); }
    });`);
  assert.equal(out, 'true');
});
