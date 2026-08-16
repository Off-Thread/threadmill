// Self-install the library so tests and benchmarks exercise the package AS
// INSTALLED (specifier '@offthread/threadmill'), not via relative imports:
//   1. `npm pack` at the repo root (prepack compiles the TS sources),
//   2. install the tarball into the ROOT node_modules with --no-save,
//   3. copy the locally-built threadmill.*.node binaries from the repo root
//      into node_modules/@offthread/threadmill/ so the generated loader's
//      local-file path finds them (the tarball ships no binaries).
//
// `--if-missing` skips all of it when a previous self-install (with a binary)
// is already present — used by `npm run bench`, which only needs SOME install
// to exist. `npm test`'s pretest always runs the full flow so tests see the
// current sources.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.join(root, 'node_modules', '@offthread', 'threadmill');
const isBinary = (f) => /^threadmill\..+\.node$/.test(f);

if (process.argv.includes('--if-missing')) {
  if (
    fs.existsSync(path.join(installed, 'package.json')) &&
    fs.readdirSync(installed).some(isBinary)
  ) {
    process.exit(0);
  }
}

const binaries = fs.readdirSync(root).filter(isBinary);
if (binaries.length === 0) {
  console.error(
    'install-local: no threadmill.*.node binary at the repo root — run `npm run build` first.'
  );
  process.exit(1);
}

// Scoped name @offthread/threadmill packs as offthread-threadmill-<version>.tgz.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tarball = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
run('npm pack');
fs.rmSync(installed, { recursive: true, force: true }); // never keep a stale install
run(`npm install ./${tarball} --no-save`);
fs.rmSync(path.join(root, tarball), { force: true });

for (const f of binaries) {
  fs.copyFileSync(path.join(root, f), path.join(installed, f));
}
