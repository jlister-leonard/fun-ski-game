/**
 * @file A streaming ZIP reader built on `Blob` + `DecompressionStream`.
 *
 * ## Why not a library
 *
 * `DecompressionStream` understands **raw deflate streams**, not the ZIP
 * container. So something has to read the archive's directory structure, and
 * the browser will not do it. This is that something: ~200 lines, zero
 * dependencies, and it never holds more than one 64 KB chunk of any entry in
 * memory. `integration-apple-health.md` §3.7 benchmarks the resulting pipeline
 * at 1.37 GB / 3M records in 21 s at ~110 MB flat.
 *
 * ## Three traps this implementation avoids
 *
 * 1. **Sizes come from the Central Directory, never the Local File Header.**
 *    Apple's zip writer uses data descriptors (general-purpose flag bit 3),
 *    which leaves the LFH sizes as zeros. Reading them yields an empty file.
 * 2. **ZIP64 is handled, not ignored.** An `export.xml` over 4 GB is not
 *    hypothetical for a heavy user with years of workout data. The 32-bit
 *    fields saturate at `0xFFFFFFFF` and the real values live in the ZIP64
 *    records; truncating silently would produce a *partial* import that looks
 *    complete, which is the worst possible failure.
 * 3. **The LFH's own name/extra lengths decide where the data starts**, and
 *    they routinely differ from the Central Directory's. Using the CD's extra
 *    length puts the read a few bytes into the compressed stream, which
 *    inflates to garbage rather than failing loudly.
 */

/** One file inside the archive. */
export interface ZipEntry {
  /** Path as stored, e.g. `apple_health_export/export.xml`. */
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is unsupported. */
  method: number;
  /** Compressed byte length, from the Central Directory. */
  compressedSize: number;
  /** Uncompressed byte length, from the Central Directory. */
  uncompressedSize: number;
  /** Offset of this entry's Local File Header within the archive. */
  localHeaderOffset: number;
}

/** Raised when an archive cannot be read. Always says what to do next. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Read a slice of the blob as a `DataView`. */
async function view(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

/** Read a 64-bit little-endian integer as a JS number, refusing to lie. */
function getU64(dv: DataView, offset: number): number {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  const value = hi * 0x1_0000_0000 + lo;
  if (!Number.isSafeInteger(value)) {
    throw new ZipError('This archive declares a file larger than 8 exabytes; it is not readable.');
  }
  return value;
}

/**
 * Scan backwards from the end of the archive for the End-of-Central-Directory
 * record.
 *
 * The record is 22 bytes plus a comment of up to 65,535 bytes, so the search
 * window is bounded at 64 KB + 22.
 *
 * @param blob the archive
 * @returns the absolute offset of the EOCD signature
 */
async function findEocd(blob: Blob): Promise<number> {
  const windowSize = Math.min(blob.size, 0xffff + 22);
  const start = blob.size - windowSize;
  const dv = await view(blob, start, blob.size);
  for (let i = dv.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIGNATURE) return start + i;
  }
  throw new ZipError(
    'That file is not a zip archive. Pick the export.zip that Health produced, not an unzipped folder.',
  );
}

/**
 * Read the archive's Central Directory.
 *
 * @param blob the `export.zip` the user picked
 * @returns every entry, in directory order
 * @throws {ZipError} when the archive is not readable
 */
export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipError('That file is empty or truncated.');

  const eocdOffset = await findEocd(blob);
  const eocd = await view(blob, eocdOffset, Math.min(eocdOffset + 22, blob.size));
  let entryCount = eocd.getUint16(10, true);
  let directoryOffset = eocd.getUint32(16, true);
  let directorySize = eocd.getUint32(12, true);

  // ZIP64: the 32-bit fields saturate, and the truth is in a separate record.
  const saturated =
    entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff;
  if (saturated && eocdOffset >= 20) {
    const loc = await view(blob, eocdOffset - 20, eocdOffset);
    if (loc.getUint32(0, true) === EOCD64_LOCATOR_SIGNATURE) {
      const eocd64Offset = getU64(loc, 8);
      const e64 = await view(blob, eocd64Offset, Math.min(eocd64Offset + 56, blob.size));
      if (e64.getUint32(0, true) !== EOCD64_SIGNATURE) {
        throw new ZipError('This archive claims to be ZIP64 but its directory is unreadable.');
      }
      entryCount = getU64(e64, 32);
      directorySize = getU64(e64, 40);
      directoryOffset = getU64(e64, 48);
    }
  }
  if (saturated && directoryOffset === 0xffffffff) {
    throw new ZipError(
      'This export is larger than 4 GB and its ZIP64 directory is missing. Re-export from Health and try again.',
    );
  }

  const dir = await view(blob, directoryOffset, directoryOffset + directorySize);
  const entries: ZipEntry[] = [];
  let p = 0;
  const nameDecoder = new TextDecoder('utf-8');

  for (let n = 0; n < entryCount && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL_SIGNATURE) break;
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    let uncompressedSize = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    let localHeaderOffset = dir.getUint32(p + 42, true);

    const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen);
    const name = nameDecoder.decode(nameBytes);

    // ZIP64 extended information extra field, id 0x0001. Present fields appear
    // in a fixed order, and *only* those whose 32-bit counterpart saturated.
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = dir.getUint16(e, true);
        const size = dir.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = getU64(dir, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = getU64(dir, q);
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = getU64(dir, q);
          }
          break;
        }
        e += 4 + size;
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (entries.length === 0) {
    throw new ZipError('That archive has no readable file directory. Try exporting again.');
  }
  return entries;
}

/**
 * Where an entry's compressed bytes actually begin.
 *
 * The Local File Header's own name and extra lengths are authoritative for
 * this — the Central Directory's extra field is a *different* field with a
 * different length, and using it lands the read inside the deflate stream.
 *
 * @param blob the archive
 * @param entry the entry to locate
 * @returns the absolute byte offset of the entry's data
 */
async function dataOffset(blob: Blob, entry: ZipEntry): Promise<number> {
  const lfh = await view(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (lfh.getUint32(0, true) !== 0x04034b50) {
    throw new ZipError(`The archive entry ${entry.name} is corrupt. Re-export from Health.`);
  }
  const nameLen = lfh.getUint16(26, true);
  const extraLen = lfh.getUint16(28, true);
  return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

/**
 * Open one entry as a byte stream, decompressing on the fly.
 *
 * @param blob the archive
 * @param entry the entry to read
 * @returns a stream of the entry's decompressed bytes
 * @throws {ZipError} for a compression method the browser cannot undo
 */
export async function openZipEntry(
  blob: Blob,
  entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
  const start = await dataOffset(blob, entry);
  const raw = blob.slice(start, start + entry.compressedSize).stream();
  if (entry.method === 0) return raw as ReadableStream<Uint8Array>;
  if (entry.method !== 8) {
    throw new ZipError(
      `${entry.name} uses an unsupported compression method (${entry.method}). Re-export from Health.`,
    );
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError(
      'This browser cannot decompress zip files. iOS 16.4 or newer is required for Health imports.',
    );
  }
  // `DecompressionStream.writable` is typed `WritableStream<BufferSource>`,
  // which is wider than `Uint8Array` and therefore not assignable in either
  // direction. The runtime contract is exact; only the declaration is loose.
  return (raw as unknown as ReadableStream<BufferSource>).pipeThrough(
    new DecompressionStream('deflate-raw'),
  ) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Read one entry fully into a string.
 *
 * Only for the small JSON payloads in `clinical-records/` — never for
 * `export.xml`, which is the whole reason the streaming path exists.
 *
 * @param blob the archive
 * @param entry the entry to read
 * @returns the entry's contents as UTF-8 text
 */
export async function readZipEntryText(blob: Blob, entry: ZipEntry): Promise<string> {
  const stream = await openZipEntry(blob, entry);
  const reader = (stream as unknown as ReadableStream<BufferSource>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

/**
 * Locate an entry by path, tolerating the two archive layouts in the wild.
 *
 * Some exports nest everything under `apple_health_export/` and some do not,
 * and `resourceFilePath` in the `<ClinicalRecord>` index carries a **leading
 * slash** that is relative to the export root rather than the filesystem
 * (`integration-health-records.md` §1.3). Matching on the normalised suffix
 * handles all three cases without probing.
 *
 * @param entries the archive directory
 * @param path a path such as `/clinical-records/Observation-1.json`
 * @returns the matching entry, or `null`
 */
export function findEntry(entries: readonly ZipEntry[], path: string): ZipEntry | null {
  const wanted = path.replace(/^\/+/, '').replace(/^apple_health_export\//, '').toLowerCase();
  for (const e of entries) {
    const name = e.name.replace(/^\/+/, '').replace(/^apple_health_export\//, '').toLowerCase();
    if (name === wanted) return e;
  }
  // Fall back to a basename match: one published layout uses `clinical_records`
  // with an underscore rather than a hyphen.
  const base = wanted.slice(wanted.lastIndexOf('/') + 1);
  for (const e of entries) {
    const name = e.name.toLowerCase();
    if (name.slice(name.lastIndexOf('/') + 1) === base) return e;
  }
  return null;
}
