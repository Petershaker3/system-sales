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

// The app's Arabic face, inlined. A shop PC is offline and may have no Arabic
// font installed at all; an HTML file that renders its own words as boxes is a
// file nobody can review. Changa is the app's face (SIL OFL 1.1), so the tool and
// the program look like the same product.
const fontsDir = join(here, '..', '..', 'src', 'assets', 'fonts');
const FACES = [
  ['changa-arabic-400-normal.woff2', 400, 'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200E,U+2010-2011'],
  ['changa-latin-400-normal.woff2', 400, 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2190-21FF,U+2212,U+FEFF'],
  ['changa-arabic-700-normal.woff2', 700, 'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200E,U+2010-2011'],
  ['changa-latin-700-normal.woff2', 700, 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2190-21FF,U+2212,U+FEFF'],
];
const fontCss = FACES
  .map(([name, weight, range]) => {
    const bytes = readFileSync(join(fontsDir, name)).toString('base64');
    return `@font-face{font-family:"Changa";font-style:normal;font-weight:${weight};font-display:swap;`
      + `src:url(data:font/woff2;base64,${bytes}) format("woff2");unicode-range:${range};}`;
  })
  .join('\n')
  + '\n/* Changa — Copyright 2018 The Changa Project Authors, SIL Open Font License 1.1. */';
const template = readFileSync(join(here, 'src', 'index.html'), 'utf8');

// Replacement *functions*, not strings: minified JavaScript is full of `$&` and
// `$'`, which `String.prototype.replace` would read as substitution patterns and
// quietly corrupt the bundle. The `</script` escape keeps a string inside the
// code from closing the element it lives in.
const safeScript = script.replace(/<\/script/gi, '<\\/script');

const html = template
  .replace('/*__STYLES__*/', () => styles.replace('/*__FONTS__*/', () => fontCss))
  .replace('/*__SCRIPT__*/', () => safeScript);

const outFile = join(here, 'legacy-migration.html');
writeFileSync(outFile, html, 'utf8');
console.log(`built ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
