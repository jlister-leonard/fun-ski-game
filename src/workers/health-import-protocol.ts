/**
 * @file The message contract between the Apple Health import worker and the
 * main thread.
 *
 * ## Why there is an ack at all
 *
 * The obvious design — worker parses, posts batches, main thread writes them —
 * has no brake. `postMessage` never blocks, so a worker that can parse 127,000
 * records a second will happily queue several hundred megabytes of batches in
 * the port while IndexedDB, which has to AES-encrypt every row, falls minutes
 * behind. The flat-memory property the pipeline was benchmarked for
 * (`integration-apple-health.md` §3.7: ~110 MB regardless of file size) is lost
 * in the message queue rather than in the parser.
 *
 * So the worker posts **one batch at a time** and waits for the main thread to
 * confirm it is written. The queue depth is one. As a bonus the progress
 * numbers become true — `rowsWritten` counts rows that are actually in the
 * vault, not rows that are somewhere in a pipe.
 */

import type { CanonicalBatch, ImportProgress } from '@/lib/ingest/types';
import type { ParseOutcome } from '@/lib/ingest/parse-export';

/** Main thread → worker. */
export type ImportRequest =
  /** Begin parsing. The `File` is transferred by structured clone, not copied. */
  | { readonly kind: 'start'; readonly file: Blob }
  /** The batch with this sequence number is durably written. */
  | { readonly kind: 'ack'; readonly seq: number; readonly written: number }
  /**
   * Stop. Sent when the user cancels or the vault locks mid-import; the worker
   * rejects its pending ack, which unwinds the parse at its next await.
   */
  | { readonly kind: 'abort'; readonly reason: string };

/** Worker → main thread. */
export type ImportResponse =
  | { readonly kind: 'progress'; readonly progress: ImportProgress }
  | { readonly kind: 'batch'; readonly seq: number; readonly batch: CanonicalBatch }
  | { readonly kind: 'done'; readonly outcome: ParseOutcome }
  /** A message rather than an `Error`: `Error` does survive structured clone,
   *  but its stack is worthless across the boundary and the copy we want is the
   *  one `ZipError` already wrote for the user. */
  | { readonly kind: 'error'; readonly message: string };
