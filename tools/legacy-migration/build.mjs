#!/usr/bin/env node
// Builds the single offline HTML file.
//
// The output is one file with no sibling assets: sql.js's WebAssembly, the
// migrations and the whole screen are inlined. That is the shape the repo
// already uses for the interface mockup, and it is the shape that survives
// being emailed to a shop with no development tools on it.
//
//   node build.mjs      → legacy-migration.html

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmBase64 = readFileSync(wasmPath).toString('base64');

const virtualWasm = {
  name: 'inline-sql-wasm',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^virtual:sql-wasm$/ }, () => ({
      path: 'virtual:sql-wasm',
      namespace: 'inline',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({
      contents: `export default ${JSON.stringify(wasmBase64)};`,
      loader: 'js',
    }));
  },
};

const result = await build({
  entryPoints: [join(here, 'src', 'app.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  // Arabic stays Arabic in the bundle instead of being escaped into \uXXXX:
  // smaller file, and a person who opens the HTML can still read the strings.
  charset: 'utf8',
  legalComments: 'none',
  plugins: [virtualWasm],
  logLevel: 'warning',
});

const script = result.outputFiles[0].text;
const styles = readFileSync(join(here, 'src', 'styles.css'), 'utf8');
const template = readFileSync(join(here, 'src', 'index.html'), 'utf8');

// Replacement *functions*, not strings: minified JavaScript is full of `$&` and
// `$'`, which `String.prototype.replace` would read as substitution patterns and
// quietly corrupt the bundle. The `</script` escape keeps a string inside the
// code from closing the element it lives in.
const safeScript = script.replace(/<\/script/gi, '<\\/script');

const html = template
  .replace('/*__STYLES__*/', () => styles)
  .replace('/*__SCRIPT__*/', () => safeScript);

const outFile = join(here, 'legacy-migration.html');
writeFileSync(outFile, html, 'utf8');
console.log(`built ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
