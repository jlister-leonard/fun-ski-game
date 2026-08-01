/**
 * @file The Apple Health import worker.
 *
 * Deliberately thin. All of the parsing lives in `@/lib/ingest`, where it can
 * be unit-tested without a `Worker`; this file is the message loop and nothing
 * else.
 *
 * It **cannot write to the vault**, and that is by design rather than by
 * omission — see `health-import-protocol.ts` and `lib/ingest/apply.ts`. It has
 * no Dexie import, no session, and no key.
 *
 * ## Why every import here goes through the `@/` alias
 *
 * Turbopack resolves `new Worker(new URL('./x.worker.ts', import.meta.url))`
 * into a real worker chunk **and**, separately, emits the raw source into
 * `out/_next/static/media/` as a plain URL asset. That stray `.ts` is matched
 * by the recursive TypeScript include in the project `tsconfig.json`, so the
 * *next* typecheck compiles it from its new location — where a relative import
 * would no longer resolve and the build would fail on the second run. Alias
 * specifiers resolve from the project root, so the copy typechecks wherever it
 * lands.
 */

import { parseAppleExport } from '@/lib/ingest/parse-export';
import type { CanonicalBatch } from '@/lib/ingest/types';
import type { ImportRequest, ImportResponse } from '@/workers/health-import-protocol';

/**
 * The bit of `DedicatedWorkerGlobalScope` this file uses.
 *
 * Declared locally rather than pulled in with `/// <reference lib="webworker" />`
 * because that directive swaps the DOM lib out for the worker one **across the
 * whole compilation unit as TypeScript resolves it**, and the project's
 * `tsconfig.json` is shared with the app. Three members are cheaper than a
 * lib-level conflict.
 */
interface WorkerScope {
  postMessage(message: ImportResponse): void;
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

/** Resolvers for the batch currently awaiting an ack. At most one. */
let pending: {
  seq: number;
  resolve: (written: number) => void;
  reject: (error: Error) => void;
} | null = null;

let nextSeq = 1;
let running = false;

/** Post a typed response. */
function reply(message: ImportResponse): void {
  ctx.postMessage(message);
}

/**
 * Post one batch and wait for the main thread to confirm it is written.
 *
 * @param batch the rows to write
 * @returns how many rows the main thread actually wrote
 */
function postBatch(batch: CanonicalBatch): Promise<number> {
  const seq = nextSeq++;
  return new Promise<number>((resolve, reject) => {
    pending = { seq, resolve, reject };
    reply({ kind: 'batch', seq, batch });
  });
}

ctx.onmessage = (event: MessageEvent<ImportRequest>): void => {
  const message = event.data;

  if (message.kind === 'ack') {
    const waiting = pending;
    if (waiting && waiting.seq === message.seq) {
      pending = null;
      waiting.resolve(message.written);
    }
    return;
  }

  if (message.kind === 'abort') {
    const waiting = pending;
    pending = null;
    running = false;
    waiting?.reject(new Error(message.reason));
    return;
  }

  if (message.kind !== 'start') return;
  if (running) {
    reply({ kind: 'error', message: 'An import is already running.' });
    return;
  }
  running = true;

  void parseAppleExport(message.file, {
    onProgress: (progress) => reply({ kind: 'progress', progress }),
    onBatch: postBatch,
  })
    .then((outcome) => {
      reply({ kind: 'done', outcome });
    })
    .catch((error: unknown) => {
      reply({
        kind: 'error',
        message:
          error instanceof Error && error.message
            ? error.message
            : 'The import failed while reading the archive.',
      });
    })
    .finally(() => {
      running = false;
      pending = null;
    });
};
