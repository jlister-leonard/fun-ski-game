/**
 * Prepare the pinned, self-hosted ZXing barcode decoder.
 *
 * barcode-detector delegates to zxing-wasm, whose distributed JavaScript
 * contains a jsDelivr default. Keel always supplies locateFile at runtime, but
 * leaving the remote fallback in the shipped bundle would weaken both the CSP
 * audit and our local-only guarantee. This postinstall step fails closed on a
 * changed dependency, verifies the exact binary, copies it into public, and
 * rewrites every decoder fallback to the corresponding same-origin path.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const VERSION = '3.1.1';
const EXPECTED_SIZE = 1_065_634;
const EXPECTED_SHA256 = '6a858c01e076bab3a1bd413e4f2cf5e5e45f819a0d9441d83c66993bc48ed38f';
const REMOTE_BASE = `https://fastly.jsdelivr.net/npm/zxing-wasm@${VERSION}/dist/`;
const LOCAL_BASE = '/wasm/';

const root = process.cwd();
const sourceWasm = path.join(root, 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
const publicWasm = path.join(root, 'public/wasm/reader/zxing_reader.wasm');
const runtimeDirs = [
  path.join(root, 'node_modules/barcode-detector/dist'),
  path.join(root, 'node_modules/zxing-wasm/dist'),
];

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(target));
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

const wasm = await readFile(sourceWasm);
const digest = createHash('sha256').update(wasm).digest('hex');
if (wasm.byteLength !== EXPECTED_SIZE || digest !== EXPECTED_SHA256) {
  throw new Error(
    `Refusing an unreviewed ZXing decoder: received ${wasm.byteLength} bytes with SHA-256 ${digest}`,
  );
}

let replacements = 0;
let preparedFiles = 0;
for (const directory of runtimeDirs) {
  for (const file of await javascriptFiles(directory)) {
    const before = await readFile(file, 'utf8');
    const occurrences = before.split(REMOTE_BASE).length - 1;
    const after = before.replaceAll(REMOTE_BASE, LOCAL_BASE);
    if (occurrences > 0) {
      await writeFile(file, after);
      replacements += occurrences;
    }
    if (after.includes('zxing_reader.wasm') && after.includes(LOCAL_BASE)) preparedFiles += 1;
  }
}
if (preparedFiles === 0) {
  throw new Error('The pinned decoder fallback was not recognized; review the dependency before updating it.');
}

await mkdir(path.dirname(publicWasm), { recursive: true });
await copyFile(sourceWasm, publicWasm);
console.log(
  `Prepared verified local ZXing decoder (${replacements} new fallback replacements; ${preparedFiles} runtime files verified).`,
);
