/**
 * Version-3 binary backups: a signed JSON manifest followed by raw media
 * ciphertexts. Production export streams into OPFS, so the complete file is
 * never assembled in JavaScript memory.
 */

import {
  constantTimeEqual,
  deriveIndexKey,
  fromBase64Url,
  getCrypto,
  importDek,
  isKeyring,
  sha256,
  toArrayBuffer,
  toBase64Url,
  unlockKeyring,
  unlockWithRecoveryCode,
  utf8,
  zeroBytes,
  type Keyring,
} from '../crypto';
import {
  beginRawMediaReplace,
  authenticateRawMediaPair,
  listRawMediaMeta,
  MAX_DEMO_BYTES,
  putRawMediaPair,
  readRawMediaBlob,
  type RawMediaMetaRow,
} from '../video/media';
import {
  BackupFormatError,
  exportVault,
  importVault,
  previewImport,
  recordMediaCleanupComplete,
  suggestBackupFilename,
  type BackupEnvelope,
  type BackupPreview,
  type ExportOptions,
  type ImportOptions,
  type ImportResult,
  type ImportSecret,
} from './backup';

const MAGIC = utf8('HCVLT3\r\n');
const HEADER_BYTES = 12;
const FORMAT_VERSION = 3;
const AUTH_INFO = 'hcvault/backup-integrity/v3';
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_MEDIA_ENTRIES = 10_000;

interface MediaManifestEntry {
  readonly id: string;
  readonly slugHash: string;
  readonly savedAt: number;
  readonly metaIv: string;
  readonly metaCt: string;
  readonly blobIv: string;
  readonly ciphertextBytes: number;
  readonly ciphertextSha256: string;
}

interface PortableManifestBody {
  readonly format: 'hcvault';
  readonly formatVersion: 3;
  readonly createdAt: string;
  readonly vault: BackupEnvelope;
  readonly media: readonly MediaManifestEntry[];
}

interface PortableManifest extends PortableManifestBody {
  readonly integrity: { readonly algorithm: 'HMAC-SHA-256'; readonly tag: string };
}

/** A sequential destination; production uses an OPFS writable, tests use memory. */
export interface PortableBackupSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface PortableBackupPreview extends BackupPreview {
  readonly mediaCount: number;
  readonly mediaBytes: number;
  readonly mediaIntegrityOk: boolean;
}

export interface PortableImportResult extends ImportResult {
  readonly mediaApplied: number;
}

/** Test seam for simulating an iOS termination between per-clip writes. */
export interface PortableImportHooks {
  beforeMediaWrite?(alreadyApplied: number): void | Promise<void>;
}

export interface StagedPortableBackup {
  readonly file: File;
  readonly preview: PortableBackupPreview;
  cleanup(): Promise<void>;
}

export class MediaBackupCapabilityError extends Error {
  constructor() {
    super(
      'This browser cannot stage recorded clips safely without holding the complete backup in memory. Update Safari or use the vault-only backup option.',
    );
    this.name = 'MediaBackupCapabilityError';
  }
}

export class MediaMergeUnsupportedError extends Error {
  constructor() {
    super(
      'This backup contains recorded clips. Clip merge is not supported safely yet; choose Replace everything, or use a vault-only format-2 backup for Merge.',
    );
    this.name = 'MediaMergeUnsupportedError';
  }
}

/** True when a blob begins with the version-3 binary magic. */
export async function isPortableBackup(file: Blob): Promise<boolean> {
  if (file.size < HEADER_BYTES) return false;
  const prefix = new Uint8Array(await file.slice(0, MAGIC.byteLength).arrayBuffer());
  return constantTimeEqual(prefix, MAGIC);
}

/**
 * Write a complete v3 container sequentially. At most one media ciphertext is
 * resident at a time; no ciphertext is base64-expanded.
 */
export async function writePortableBackup(
  secret: ImportSecret,
  sink: PortableBackupSink,
  options: ExportOptions = {},
): Promise<{ mediaCount: number; mediaBytes: number }> {
  try {
    const vaultBlob = await exportVault(secret, options);
    const vault = JSON.parse(await vaultBlob.text()) as BackupEnvelope;
    const mediaRows = await listRawMediaMeta();
    if (mediaRows.length > MAX_MEDIA_ENTRIES) {
      throw new BackupFormatError('integrity', 'This device has too many recorded clips to back up safely.');
    }

    const media: MediaManifestEntry[] = [];
    let mediaBytes = 0;
    const mediaKeys = await openMediaKeys(vault.keyring, secret);
    for (const meta of mediaRows) {
      const blob = await readRawMediaBlob(meta.id);
      if (!blob) throw new BackupFormatError('integrity', `Recorded clip ${meta.id} has no ciphertext.`);
      await authenticateRawMediaPair(mediaKeys.dek, mediaKeys.indexKey, meta, blob);
      const digest = await sha256(blob.ct);
      mediaBytes += blob.ct.byteLength;
      media.push({
        id: meta.id,
        slugHash: meta.slugHash,
        savedAt: meta.savedAt,
        metaIv: toBase64Url(meta.iv),
        metaCt: toBase64Url(meta.ct),
        blobIv: toBase64Url(blob.iv),
        ciphertextBytes: blob.ct.byteLength,
        ciphertextSha256: toBase64Url(digest),
      });
    }

    const body: PortableManifestBody = {
      format: 'hcvault',
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      vault,
      media,
    };
    const integrity = await signManifest(body, vault.keyring, secret);
    const manifestBytes = utf8(JSON.stringify({
      ...body,
      integrity: { algorithm: 'HMAC-SHA-256', tag: integrity },
    } satisfies PortableManifest));
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
      throw new BackupFormatError('integrity', 'The backup manifest is too large to process safely.');
    }

    const header = new Uint8Array(HEADER_BYTES);
    header.set(MAGIC);
    new DataView(header.buffer).setUint32(MAGIC.byteLength, manifestBytes.byteLength, false);
    await sink.write(header);
    await sink.write(manifestBytes);

    // Re-read each entry immediately before writing. If a concurrent delete or
    // replacement changed it after manifest construction, abort the container.
    for (const entry of media) {
      const blob = await readRawMediaBlob(entry.id);
      if (!blob || blob.ct.byteLength !== entry.ciphertextBytes) {
        throw new BackupFormatError('integrity', `Recorded clip ${entry.id} changed during backup.`);
      }
      const digest = await sha256(blob.ct);
      if (!constantTimeEqual(digest, fromBase64Url(entry.ciphertextSha256))) {
        throw new BackupFormatError('integrity', `Recorded clip ${entry.id} changed during backup.`);
      }
      await sink.write(blob.ct);
    }
    await sink.close();
    return { mediaCount: media.length, mediaBytes };
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}

/** Stage a disk-backed v3 file in OPFS and verify it before delivery. */
export async function stagePortableBackupAndVerify(
  secret: ImportSecret,
  options: ExportOptions = {},
): Promise<StagedPortableBackup> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage?.getDirectory) throw new MediaBackupCapabilityError();
  const root = await storage.getDirectory();
  const name = suggestBackupFilename();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  let finished = false;
  const sink: PortableBackupSink = {
    write: async (chunk) => writable.write(toArrayBuffer(chunk)),
    close: async () => {
      await writable.close();
      finished = true;
    },
    abort: async () => {
      if (!finished) await writable.abort().catch(() => undefined);
      await root.removeEntry(name).catch(() => undefined);
    },
  };
  await writePortableBackup(secret, sink, options);
  const file = await handle.getFile();
  try {
    const preview = await previewPortableImport(file, secret);
    if (!preview.restorable) throw new BackupFormatError('integrity', 'The staged backup did not verify.');
    return {
      file,
      preview,
      cleanup: async () => root.removeEntry(name).catch(() => undefined),
    };
  } catch (error) {
    await root.removeEntry(name).catch(() => undefined);
    throw error;
  }
}

/** Preview format 2 unchanged, or fully authenticate a format-3 container. */
export async function previewPortableImport(
  file: Blob,
  secret: ImportSecret,
): Promise<PortableBackupPreview> {
  if (!(await isPortableBackup(file))) {
    const preview = await previewImport(file, secret);
    return { ...preview, mediaCount: 0, mediaBytes: 0, mediaIntegrityOk: true };
  }
  const parsed = await parseAndVerify(file, secret);
  const vaultPreview = await previewImport(vaultBlob(parsed.manifest.vault), secret);
  return {
    ...vaultPreview,
    formatVersion: FORMAT_VERSION,
    mediaCount: parsed.manifest.media.length,
    mediaBytes: parsed.mediaBytes,
    mediaIntegrityOk: true,
  };
}

/** Restore format 2 unchanged; restore v3 media only in fail-closed replace mode. */
export async function importPortableBackup(
  file: Blob,
  secret: ImportSecret,
  options: ImportOptions,
  hooks: PortableImportHooks = {},
): Promise<PortableImportResult> {
  if (!(await isPortableBackup(file))) {
    const result = await importVault(file, secret, options);
    if (!options.dryRun && options.mode === 'replace') {
      await beginRawMediaReplace();
      await recordMediaCleanupComplete();
    }
    return { ...result, mediaApplied: 0 };
  }
  const parsed = await parseAndVerify(file, secret);
  if (options.mode === 'merge' && parsed.manifest.media.length > 0) {
    throw new MediaMergeUnsupportedError();
  }

  const result = await importVault(vaultBlob(parsed.manifest.vault), secret, options);
  if (options.dryRun || options.mode === 'merge') return { ...result, mediaApplied: 0 };

  // importVault's replace transaction has adopted the backup keyring and set
  // pendingMediaCleanup=true. Leave that marker set on every failure below.
  await beginRawMediaReplace();
  let offset = parsed.mediaOffset;
  let applied = 0;
  for (const entry of parsed.manifest.media) {
    await hooks.beforeMediaWrite?.(applied);
    const ct = new Uint8Array(
      await file.slice(offset, offset + entry.ciphertextBytes).arrayBuffer(),
    );
    offset += entry.ciphertextBytes;
    await putRawMediaPair(decodeMeta(entry), {
      id: entry.id,
      iv: fromBase64Url(entry.blobIv),
      ct,
    });
    applied++;
  }
  await recordMediaCleanupComplete();
  return { ...result, mediaApplied: applied };
}

interface ParsedPortable {
  manifest: PortableManifest;
  mediaOffset: number;
  mediaBytes: number;
}

async function parseAndVerify(file: Blob, secret: ImportSecret): Promise<ParsedPortable> {
  if (file.size < HEADER_BYTES) throw new BackupFormatError('not-hcvault', 'That file is truncated.');
  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  if (!constantTimeEqual(header.slice(0, MAGIC.byteLength), MAGIC)) {
    throw new BackupFormatError('not-hcvault', 'That file is not a Keel backup.');
  }
  const manifestLength = new DataView(header.buffer).getUint32(MAGIC.byteLength, false);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES || HEADER_BYTES + manifestLength > file.size) {
    throw new BackupFormatError('integrity', 'That backup has an invalid or truncated manifest.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await file.slice(HEADER_BYTES, HEADER_BYTES + manifestLength).text());
  } catch {
    throw new BackupFormatError('integrity', 'That backup has an unreadable manifest.');
  }
  const manifest = validateManifest(value);
  const { integrity, ...body } = manifest;
  if (!(await verifyManifest(body, integrity.tag, manifest.vault.keyring, secret))) {
    throw new BackupFormatError('integrity', 'The backup manifest failed its keyed integrity check.');
  }

  const mediaKeys = await openMediaKeys(manifest.vault.keyring, secret);
  let offset = HEADER_BYTES + manifestLength;
  let mediaBytes = 0;
  for (const entry of manifest.media) {
    const end = offset + entry.ciphertextBytes;
    if (end > file.size) throw new BackupFormatError('integrity', `Recorded clip ${entry.id} is truncated.`);
    const ct = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const digest = await sha256(ct);
    if (!constantTimeEqual(digest, fromBase64Url(entry.ciphertextSha256))) {
      throw new BackupFormatError('integrity', `Recorded clip ${entry.id} failed its integrity check.`);
    }
    await authenticateRawMediaPair(mediaKeys.dek, mediaKeys.indexKey, decodeMeta(entry), {
      id: entry.id,
      iv: fromBase64Url(entry.blobIv),
      ct,
    });
    mediaBytes += entry.ciphertextBytes;
    offset = end;
  }
  if (offset !== file.size) throw new BackupFormatError('integrity', 'The backup has unauthenticated trailing data.');
  return { manifest, mediaOffset: HEADER_BYTES + manifestLength, mediaBytes };
}

function validateManifest(value: unknown): PortableManifest {
  if (!value || typeof value !== 'object') throw new BackupFormatError('not-hcvault', 'Invalid backup manifest.');
  const manifest = value as Partial<PortableManifest>;
  if (manifest.format !== 'hcvault' || manifest.formatVersion !== FORMAT_VERSION) {
    throw new BackupFormatError('version', 'This binary backup format is not supported by this version of Keel.');
  }
  if (!manifest.vault || !isKeyring(manifest.vault.keyring) || !Array.isArray(manifest.media)) {
    throw new BackupFormatError('not-hcvault', 'Invalid backup manifest.');
  }
  if (manifest.media.length > MAX_MEDIA_ENTRIES) throw new BackupFormatError('integrity', 'Too many media entries.');
  if (!manifest.integrity || manifest.integrity.algorithm !== 'HMAC-SHA-256' || typeof manifest.integrity.tag !== 'string') {
    throw new BackupFormatError('integrity', 'The backup manifest has no keyed authenticator.');
  }
  const ids = new Set<string>();
  for (const item of manifest.media as unknown[]) {
    validateMediaEntry(item);
    const id = (item as MediaManifestEntry).id;
    if (ids.has(id)) throw new BackupFormatError('integrity', 'The media manifest contains a duplicate id.');
    ids.add(id);
  }
  return manifest as PortableManifest;
}

function validateMediaEntry(value: unknown): void {
  if (!value || typeof value !== 'object') throw new BackupFormatError('integrity', 'Invalid media entry.');
  const e = value as Partial<MediaManifestEntry>;
  if (
    typeof e.id !== 'string' || !e.id || typeof e.slugHash !== 'string' || e.slugHash.length !== 22 ||
    !Number.isFinite(e.savedAt) || typeof e.metaIv !== 'string' || typeof e.metaCt !== 'string' ||
    typeof e.blobIv !== 'string' || !Number.isSafeInteger(e.ciphertextBytes) || (e.ciphertextBytes ?? 0) < 16 ||
    (e.ciphertextBytes ?? 0) > MAX_DEMO_BYTES + 16 ||
    typeof e.ciphertextSha256 !== 'string'
  ) throw new BackupFormatError('integrity', 'Invalid media entry.');
  try {
    if (fromBase64Url(e.metaIv).byteLength !== 12 || fromBase64Url(e.blobIv).byteLength !== 12 || fromBase64Url(e.ciphertextSha256).byteLength !== 32) throw new Error();
    fromBase64Url(e.metaCt);
  } catch {
    throw new BackupFormatError('integrity', 'Invalid media entry encoding.');
  }
}

function decodeMeta(entry: MediaManifestEntry): RawMediaMetaRow {
  return {
    id: entry.id,
    slugHash: entry.slugHash,
    savedAt: entry.savedAt,
    iv: fromBase64Url(entry.metaIv),
    ct: fromBase64Url(entry.metaCt),
  };
}

function vaultBlob(vault: BackupEnvelope): Blob {
  return new Blob([JSON.stringify(vault)], { type: 'application/json' });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function withRawDek<T>(keyring: Keyring, secret: ImportSecret, fn: (raw: Uint8Array) => Promise<T>): Promise<T> {
  const opened = secret.kind === 'recovery-code'
    ? await unlockWithRecoveryCode(keyring, secret.value)
    : await unlockKeyring(keyring, 'passphrase', secret.value);
  try {
    return await fn(opened.rawDek);
  } finally {
    zeroBytes(opened.rawDek);
  }
}

async function openMediaKeys(
  keyring: Keyring,
  secret: ImportSecret,
): Promise<{ dek: CryptoKey; indexKey: CryptoKey }> {
  return withRawDek(keyring, secret, async (raw) => ({
    dek: await importDek(raw, false),
    indexKey: await deriveIndexKey(raw),
  }));
}

async function authKey(rawDek: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const base = await subtle.importKey('raw', toArrayBuffer(rawDek), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(new Uint8Array()), info: toArrayBuffer(utf8(AUTH_INFO)) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    [usage],
  );
}

async function signManifest(body: PortableManifestBody, keyring: Keyring, secret: ImportSecret): Promise<string> {
  return withRawDek(keyring, secret, async (raw) => {
    const signature = await getCrypto().subtle.sign(
      'HMAC', await authKey(raw, 'sign'), toArrayBuffer(utf8(canonicalJson(body))),
    );
    return toBase64Url(new Uint8Array(signature));
  });
}

async function verifyManifest(body: PortableManifestBody, tag: string, keyring: Keyring, secret: ImportSecret): Promise<boolean> {
  let bytes: Uint8Array;
  try { bytes = fromBase64Url(tag); } catch { return false; }
  if (bytes.byteLength !== 32) return false;
  return withRawDek(keyring, secret, async (raw) => getCrypto().subtle.verify(
    'HMAC', await authKey(raw, 'verify'), toArrayBuffer(bytes), toArrayBuffer(utf8(canonicalJson(body))),
  ));
}
