// The worker is created with `new Worker(new URL('./pdfiumWorkerMain.ts', import.meta.url))`.
// Vite only recognises that pattern when the path names a real file, and the
// app bundles this package from source, so the source must say `.ts`.
// `tsc` does not rewrite string literals, so the compiled `dist` would point at
// a `.ts` file that does not exist there. This step fixes the compiled copy.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'dist/engine/pdfiumEngine.js');
const from = "new URL('./pdfiumWorkerMain.ts', import.meta.url)";
const to = "new URL('./pdfiumWorkerMain.js', import.meta.url)";
const text = readFileSync(target, 'utf8');
if (!text.includes(from) && !text.includes(to)) {
  throw new Error(`worker URL not found in ${target}`);
}
writeFileSync(target, text.replace(from, to));
if (!existsSync(resolve(root, 'dist/engine/pdfiumWorkerMain.js'))) {
  throw new Error('dist/engine/pdfiumWorkerMain.js was not emitted');
}
console.log('[pdfgpu] worker URL -> ./pdfiumWorkerMain.js');
