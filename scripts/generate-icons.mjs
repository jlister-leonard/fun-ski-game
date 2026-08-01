/**
 * Generates the PWA icon set from a single vector source.
 *
 * Run: node scripts/generate-icons.mjs
 *
 * The mark is a keel — the weighted spine that keeps a hull upright — drawn so
 * it also reads as a rising trend line. Everything is inline vector; no binary
 * source asset to lose.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "public", "icons");

const INK = "#0b0e13";
const ACCENT_A = "#4ade9a";
const ACCENT_B = "#38bdf8";

/**
 * @param {number} size
 * @param {{ bleed?: boolean }} [opts] maskable icons need the mark inset so
 *   Android's circular crop doesn't clip it.
 */
function markSvg(size, { bleed = false } = {}) {
  const inset = bleed ? size * 0.18 : size * 0.1;
  const w = size - inset * 2;
  const stroke = w * 0.115;

  // A keel curve: deep at the left, sweeping up and out to the right.
  const x0 = inset + w * 0.1;
  const y0 = inset + w * 0.78;
  const x1 = inset + w * 0.42;
  const y1 = inset + w * 0.95;
  const x2 = inset + w * 0.66;
  const y2 = inset + w * 0.52;
  const x3 = inset + w * 0.9;
  const y3 = inset + w * 0.14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="${ACCENT_A}"/>
      <stop offset="100%" stop-color="${ACCENT_B}"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141922"/>
      <stop offset="100%" stop-color="${INK}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${bleed ? 0 : size * 0.223}" fill="url(#bg)"/>
  <path d="M ${x0} ${y0} C ${x1} ${y1}, ${x2} ${y2}, ${x3} ${y3}"
        fill="none" stroke="url(#g)" stroke-width="${stroke}"
        stroke-linecap="round"/>
  <circle cx="${x3}" cy="${y3}" r="${stroke * 0.62}" fill="${ACCENT_B}"/>
</svg>`;
}

const TARGETS = [
  { name: "icon-192.png", size: 192, bleed: false },
  { name: "icon-512.png", size: 512, bleed: false },
  { name: "maskable-192.png", size: 192, bleed: true },
  { name: "maskable-512.png", size: 512, bleed: true },
  // iOS ignores the manifest and reads this one. It must be opaque and
  // square — iOS applies its own corner radius.
  { name: "apple-touch-icon.png", size: 180, bleed: true },
];

await mkdir(OUT, { recursive: true });

for (const { name, size, bleed } of TARGETS) {
  const svg = markSvg(size, { bleed });
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
  console.log(`wrote ${name} (${size}x${size})`);
}

// Keep the vector source alongside the raster output.
await writeFile(path.join(OUT, "mark.svg"), markSvg(512), "utf8");
console.log("wrote mark.svg");
