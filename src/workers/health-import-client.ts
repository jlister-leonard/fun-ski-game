/**
 * @file Main-thread half of the Apple Health import.
 *
 * Owns the worker's lifetime, answers its batches by writing them to the vault,
 * and assembles the {@link ImportReceipt} the UI shows when it finishes.
 *
 * The split of responsibility is the one thing to keep straight:
 *
 * | | worker | main thread |
 * |---|---|---|
 * | reads the zip, scans the XML, parses FHIR | ✅ | |
 * | holds the DEK and writes to IndexedDB | | ✅ |
 *
 * Nothing crosses that line in either direction. The worker never sees a key;
 * the main thread never parses a gigabyte.
 */

import { applyBatch, logImport } from '@/lib/ingest/apply';
import { emptyReceipt, type ImportProgress, type ImportReceipt } from '@/lib/ingest/types';
import type { ImportRequest, ImportResponse } from './health-import-protocol';

/** Options for {@link runAppleHealthImport}. */
export interface RunImportOptions {
  /** Called on every progress tick. Throttling is the caller's business. */
  onProgress?: (progress: ImportProgress) => void;
  /** Abort the run when this fires. */
  signal?: AbortSignal;
}

/** The initial progress state, so the UI has something honest to render at t=0. */
export function initialProgress(): ImportProgress {
  return {
    phase: 'reading-archive',
    bytesRead: 0,
    bytesTotal: null,
    recordsSeen: 0,
    clinicalFilesRead: 0,
    rowsWritten: 0,
    detail: null,
  };
}

/**
 * Import an Apple Health `export.zip` into the vault.
 *
 * @param file the archive the user picked
 * @param options progress sink and abort signal
 * @returns the receipt — what was created, updated, skipped and not understood
 * @throws {Error} with user-facing copy when the archive cannot be read, or
 *   when the vault locks part-way through
 */
export async function runAppleHealthImport(
  file: File,
  options: RunImportOptions = {},
): Promise<ImportReceipt> {
  const receipt = emptyReceipt('export-zip', 'export-zip');
  const worker = new Worker(new URL('./health-import.worker.ts', import.meta.url), {
    type: 'module',
  });

  const send = (message: ImportRequest): void => worker.postMessage(message);

  try {
    return await new Promise<ImportReceipt>((resolve, reject) => {
      const onAbort = (): void => {
        send({ kind: 'abort', reason: 'Import cancelled.' });
        reject(new Error('Import cancelled.'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      worker.onerror = () => {
        reject(new Error('The import worker could not start.'));
      };

      worker.onmessage = (event: MessageEvent<ImportResponse>) => {
        const message = event.data;

        if (message.kind === 'progress') {
          options.onProgress?.(message.progress);
          return;
        }

        if (message.kind === 'batch') {
          // Written here, on the thread that holds the key. Any failure is
          // reported back so the worker unwinds instead of parsing on into a
          // vault that is no longer accepting writes.
          applyBatch(message.batch, receipt)
            .then((written) => send({ kind: 'ack', seq: message.seq, written }))
            .catch((error: unknown) => {
              const reason =
                error instanceof Error ? error.message : 'Writing to the vault failed.';
              send({ kind: 'abort', reason });
              reject(error instanceof Error ? error : new Error(reason));
            });
          return;
        }

        if (message.kind === 'error') {
          reject(new Error(message.message));
          return;
        }

        // Done. Fold the parse outcome into the receipt the UI shows.
        const outcome = message.outcome;
        receipt.finishedAt = new Date().toISOString();
        receipt.exportDate = outcome.exportDate;
        receipt.rawSamplesSeen = outcome.rawSamplesSeen;
        receipt.unmapped = outcome.unmapped;
        receipt.providers = outcome.providers;
        receipt.failures = outcome.failures;
        receipt.warnings = [...receipt.warnings, ...outcome.warnings];
        resolve(receipt);
      };

      send({ kind: 'start', file });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Import, then write the audit-trail entry.
 *
 * Separate from {@link runAppleHealthImport} because the log write must not be
 * able to fail the import that already succeeded.
 *
 * @param file the archive
 * @param options progress sink and abort signal
 * @returns the receipt
 */
export async function importAppleHealthExport(
  file: File,
  options: RunImportOptions = {},
): Promise<ImportReceipt> {
  const receipt = await runAppleHealthImport(file, options);
  try {
    await logImport(receipt);
  } catch {
    // The data is in. A missing audit row is not worth failing the import for.
  }
  return receipt;
}
