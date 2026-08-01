/** Coordinate a daily clipboard/manual-paste import on the main thread. */

import { sha256, toBase64Url } from '../crypto';
import { ingestLog } from '../db/repos';
import { applyBatch, logImport } from './apply';
import { parseShortcutPayload } from './parse-shortcut';
import { emptyReceipt, type Fidelity, type ImportReceipt } from './types';

/** Stable, non-reversible identity for one exact clipboard payload. */
export async function shortcutBatchKey(text: string): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(text.trim()));
  return `paste:${toBase64Url(digest)}`;
}

/**
 * Parse, idempotently apply, and record a daily Apple Health payload.
 *
 * The caller supplies fidelity so a direct clipboard read is distinguishable
 * in the receipt from the manual-paste fallback. Both use the existing `paste`
 * ingest channel and write through the same canonical repositories as ZIP.
 */
export async function importShortcutPayload(
  text: string,
  fidelity: Extract<Fidelity, 'shortcut' | 'manual'>,
): Promise<ImportReceipt> {
  const batchKey = await shortcutBatchKey(text);
  const receipt = emptyReceipt('paste', fidelity);

  if (await ingestLog.hasSeen(batchKey)) {
    receipt.duplicate = true;
    receipt.warnings.push('This exact Sync Health payload was already imported. Nothing was written twice.');
    return receipt;
  }

  const parsed = parseShortcutPayload(text);
  receipt.rawSamplesSeen = parsed.rawSamplesSeen;
  receipt.unmapped = parsed.unmapped;
  receipt.failures = parsed.failures;
  receipt.warnings = parsed.warnings;

  await applyBatch(parsed.batch, receipt);
  receipt.finishedAt = new Date().toISOString();
  await logImport(receipt, batchKey);
  return receipt;
}
