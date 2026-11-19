// Bundles src/main.js into one self-contained index.html (and optionally copies it somewhere for testing).
//   npm run build            minified
//   npm run build:readable   unminified, for debugging in the browser
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const readable = process.argv.includes('--readable');
// optional extra copy of the build (e.g. a network share for testing on another PC): set BACKROOMS_OUT,
// or put the folder path in a local, untracked .out-path file
const outFile = path.join(here, '.out-path');
const NAS = process.env.BACKROOMS_OUT || (existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '');

// version shown in the menu: date + commit (+ "+" when there are uncommitted changes)
let commit = 'dev';
try { commit = execSync('git rev-parse --short HEAD', { cwd: here }).toString().trim() + (execSync('git status --porcelain src template.html', { cwd: here }).toString().trim() ? '+' : ''); } catch {}
const VERSION = new Date().toISOString().slice(0, 10) + ' ' + commit;
const res = await build({
  entryPoints: [path.join(here, 'src/main.js')],
  bundle: true, format: 'iife', target: 'es2022', write: false,
  minify: !readable, legalComments: 'none', define: { __VERSION__: JSON.stringify(VERSION) },
});
const js = res.outputFiles[0].text.trim();
if (js.includes('</script')) throw new Error('bundle contains </script');

const tpl = readFileSync(path.join(here, 'template.html'), 'utf8');
const html = tpl.replace('/*SCRIPT*/', () => js);
const out = path.join(here, 'index.html');
writeFileSync(out, html);
const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
console.log(`index.html: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}, ${(gz / 1024).toFixed(1)} kB gzipped`);
// npm run dist: a folder holding only index.html, which is what butler uploads to itch.io
if (process.argv.includes('--dist')) { mkdirSync(path.join(here, 'dist/itch'), { recursive: true }); copyFileSync(out, path.join(here, 'dist/itch/index.html')); writeFileSync(path.join(here, 'dist/version.txt'), VERSION); console.log('dist/itch/index.html (' + VERSION + ')'); }
if (NAS && existsSync(NAS)) { copyFileSync(out, path.join(NAS, 'index.html')); console.log(`copied to ${NAS}`); }
