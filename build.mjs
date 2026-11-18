// Bundles src/main.js into one self-contained index.html (and optionally copies it somewhere for testing).
//   npm run build            minified
//   npm run build:readable   unminified, for debugging in the browser
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const readable = process.argv.includes('--readable');
// optional extra copy of the build (e.g. a network share for testing on another PC): set BACKROOMS_OUT,
// or put the folder path in a local, untracked .out-path file
const outFile = path.join(here, '.out-path');
const NAS = process.env.BACKROOMS_OUT || (existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '');

const res = await build({
  entryPoints: [path.join(here, 'src/main.js')],
  bundle: true, format: 'iife', target: 'es2022', write: false,
  minify: !readable, legalComments: 'none',
});
const js = res.outputFiles[0].text.trim();
if (js.includes('</script')) throw new Error('bundle contains </script');

const tpl = readFileSync(path.join(here, 'template.html'), 'utf8');
const html = tpl.replace('/*SCRIPT*/', () => js);
const out = path.join(here, 'index.html');
writeFileSync(out, html);
const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`index.html: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}, ${(gz / 1024).toFixed(1)} kB gzipped`);
if (NAS && existsSync(NAS)) { copyFileSync(out, path.join(NAS, 'index.html')); console.log(`copied to ${NAS}`); }
