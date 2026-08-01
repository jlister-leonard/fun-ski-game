import { describe, expect, it } from 'vitest';

import type { ReadinessRecord } from '@/lib/db/types';
import { decodeCheckIn, encodeCheckIn, readContributions, type RecoveryCheckIn } from '../model';

const CHECK_IN: RecoveryCheckIn = {
  dateKey: '2026-07-25',
  soreness: 4,
  energy: 2,
  sleepQuality: 3,
  painFlag: true,
  illnessFlag: false,
  symptoms: {
    chestPain: false,
    dizzinessOrFainting: true,
    shortnessOfBreath: false,
    unexplainedWeightChange: false,
    painAtRest: true,
  },
};

const DECISION = {
  band: 'low' as const,
  programmingSuppressed: false,
  adjustmentPaused: false,
  referral: false,
  adjustment: {
    applied: true,
    volumeDelta: -0.25,
    setsPerExerciseDelta: -1,
    minSetsPerExercise: 2,
    rirDelta: 1,
    minRir: 3,
    loadDelta: -0.05,
    extraSetOnLastExercise: false,
    conditioning: 'downgrade_intervals' as const,
    reasons: ['Recovery is down.'],
  },
};

function stored(record: ReturnType<typeof encodeCheckIn>): ReadinessRecord {
  return {
    ...record,
    id: 'ready-1',
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
  };
}

describe('recovery check-in persistence', () => {
  it('round-trips typed subjective and safety inputs', () => {
    const row = stored(encodeCheckIn(CHECK_IN, { hrv: 20, energy: 40 }, 42, 0.8, DECISION));
    expect(decodeCheckIn(row)).toEqual(CHECK_IN);
    expect(row.trainingDecision).toEqual(DECISION);
  });

  it('keeps subjective inputs out of scored contributors', () => {
    const row = stored(encodeCheckIn(CHECK_IN, { hrv: 20, energy: 40 }, 42, 0.8, DECISION));
    expect(row.contributors).toEqual({ hrv: 20, energy: 40 });
    expect(Object.keys(row.contributors)).not.toContain('input.energy');
    expect(readContributions(row)).toEqual({ hrv: 20, energy: 40 });
  });

  it('returns no check-in for a vendor row without subjective answers', () => {
    const row = stored(encodeCheckIn(CHECK_IN, {}, 42, null, DECISION));
    row.source = 'oura';
    row.subjective = null;
    expect(decodeCheckIn(row)).toBeNull();
  });
});
