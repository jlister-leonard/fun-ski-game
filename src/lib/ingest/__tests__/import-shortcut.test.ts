import 'fake-indexeddb/auto';

import { beforeAll, describe, expect, it } from 'vitest';
import { healthMetrics, ingestLog, weights } from '@/lib/db/repos';
import { initializeVault } from '@/lib/vault';
import { applyBatch } from '../apply';
import { importShortcutPayload, shortcutBatchKey } from '../import-shortcut';
import { emptyBatch, emptyReceipt } from '../types';

const PASSPHRASE = 'correct horse battery staple';
const DAILY = JSON.stringify({
  data: {
    metrics: [
      {
        name: 'step_count',
        units: 'count',
        data: [{ date: '2026-08-01 09:30:00 -0400', qty: 7200 }],
      },
      {
        name: 'weight_body_mass',
        units: 'lb',
        data: [{ date: '2026-08-01 09:30:00 -0400', qty: 180 }],
      },
    ],
  },
});

describe('importShortcutPayload', () => {
  beforeAll(async () => {
    await initializeVault(PASSPHRASE, { iterations: 1000, issueRecoveryCode: false });
  });

  it('applies once, records history by content hash, and makes an exact replay a no-op', async () => {
    const first = await importShortcutPayload(DAILY, 'shortcut');
    expect(first.duplicate).toBe(false);
    expect(first.created).toEqual({ healthMetrics: 1, weightEntries: 1 });
    expect(await healthMetrics.count()).toBe(1);
    expect(await weights.count()).toBe(1);

    const key = await shortcutBatchKey(DAILY);
    expect(await ingestLog.hasSeen(key)).toBe(true);
    expect(await ingestLog.recent()).toEqual([
      expect.objectContaining({
        sourceKey: key,
        channel: 'paste',
        provider: 'apple-health',
        recordCount: 2,
        appliedCount: 2,
        status: 'applied',
      }),
    ]);

    const replay = await importShortcutPayload(`\n${DAILY}\n`, 'manual');
    expect(replay.duplicate).toBe(true);
    expect(replay.created).toEqual({});
    expect(replay.updated).toEqual({});
    expect(await healthMetrics.count()).toBe(1);
    expect(await weights.count()).toBe(1);
    expect(await ingestLog.recent()).toHaveLength(1);
  });

  it('never lets a daily aggregate overwrite a richer export value', async () => {
    const batch = emptyBatch();
    batch.metrics.push({
      type: 'steps',
      dateKey: '2026-08-01',
      value: 8000,
      startedAt: null,
      endedAt: null,
      aggregation: 'sum',
      sampleCount: 20,
    });
    await applyBatch(batch, emptyReceipt('export-zip', 'export-zip'));

    const changedDaily = JSON.stringify({
      data: {
        metrics: [
          {
            name: 'step_count',
            units: 'count',
            data: [{ date: '2026-08-01 20:00:00 -0400', qty: 9999 }],
          },
        ],
      },
    });
    const result = await importShortcutPayload(changedDaily, 'shortcut');
    const [steps] = await healthMetrics.getSeries('steps', '2026-08-01', '2026-08-01');
    const stored = await healthMetrics.findBySourceKey('apple-health:metric:steps:2026-08-01');

    expect(result.skipped).toBe(1);
    expect(steps.value).toBe(8000);
    expect(stored?.fidelity).toBe('export-zip');
  });
});
