import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set(['.git', '.next', '.wrangler', 'node_modules', 'dist', 'coverage']);
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

const forbidden = [
  { name: 'private body-composition handoff', pattern: /(?:21%[\s\S]{0,120}(?:under\s*)?14%|88\s*kg[\s\S]{0,160}(?:21%|<14%))/i },
  { name: 'private trainer schedule shorthand', pattern: /Tue\/?Wed\/?Thu|Tuesday, Wednesday and Thursday/i },
  { name: 'private trainer-emphasis handoff', pattern: /hips?[^\n]{0,40}mid[- ]back[^\n]{0,40}lats?[^\n]{0,40}sled/i },
  { name: 'private diet handoff', pattern: /self[- ]suspected ARFID/i },
  { name: 'private medication-dose handoff', pattern: /sertraline\s+150\s*mg|finasteride\s+1\s*mg[^\n]{0,80}(?:minoxidil|creatine)/i },
  { name: 'private-profile marker', pattern: /the (?:real )?user this was built for|the real user:/i },
  { name: 'deployment project identifier', pattern: /appgprj_[a-z0-9]+/i },
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const findings = [];
for (const file of await filesUnder(root)) {
  if (relative(root, file) === 'scripts/public-data-audit.mjs') continue;
  const text = await readFile(file, 'utf8');
  for (const rule of forbidden) {
    const match = text.match(rule.pattern);
    if (!match || typeof match.index !== 'number') continue;
    const line = text.slice(0, match.index).split('\n').length;
    findings.push(`${relative(root, file)}:${line} ${rule.name}`);
  }
}

if (findings.length > 0) {
  console.error('Public-data audit failed:\n' + findings.map((finding) => `- ${finding}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public-data audit passed: no known private handoff material is bundled.');
}
