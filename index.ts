/// <reference types="node" />

// Public entry point. Native kernels (batch + pipeline exports,
// platform-loader in binding.js) plus the JS-side fluent pipeline builder and
// its phantom-generic typings. The emitted index.js / index.d.ts are
// generated from this file by `tsc -p tsconfig.json`.
export * from './binding.js';
export * from './lib/pipeline.js';
