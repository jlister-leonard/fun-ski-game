import { describe, expect, it } from 'vitest';

import type { ReadinessAssessment } from '@/lib/algorithms';
import type {
  Insight,
  Mesocycle,
  Nutrients,
  Program,
  WorkoutSession,
} from '@/lib/db/types';
import {
  nutritionTiles,
  recoverySummary,
  trainingSummary,
  visibleInsights,
} from '../model';

const EATEN: Nutrients = {
  kcal: 1432,
  proteinG: 111,
  carbG: 157,
  fatG: 49,
  fiberG: 22,
  sugarG: 0,
  satFatG: 0,
  sodiumMg: 0,
};

const PROGRAM = {
  id: 'program-1',
  days: [
    { label: 'Lift A', slots: [{ exerciseSlug: 'squat', sets: 3, repMin: 5, repMax: 8, targetRir: 3, restSeconds: 120 }] },
    { label: 'Lift B', slots: [{ exerciseSlug: 'row', sets: 4, repMin: 8, repMax: 12, targetRir: 2, restSeconds: 90 }] },
  ],
} as Program;

const MESO = { id: 'meso-1', programId: PROGRAM.id, name: 'August block' } as Mesocycle;

function session(patch: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 'session-1',
    title: null,
    kind: 'self',
    startedAt: 100,
    endedAt: null,
    mesocycleId: null,
    dayIndex: null,
    ...patch,
  } as WorkoutSession;
}

function insight(patch: Partial<Insight> = {}): Insight {
  return {
    id: 'insight-1',
    title: 'Hold steady',
    body: 'The supported data does not call for a change.',
    type: 'training',
    severity: 'info',
    score: 0.5,
    ...patch,
  } as Insight;
}

describe('Today dashboard model', () => {
  it('removes both eaten and target energy numbers when calories are hidden', () => {
    const targets = {
      kcal: 2200,
      proteinG: 150,
      carbG: 240,
      fatG: 70,
    } as Parameters<typeof nutritionTiles>[1];
    const tiles = nutritionTiles(EATEN, targets, true);

    expect(tiles[0]).toMatchObject({ label: 'Energy', value: 'Hidden', unit: null, target: null });
    expect(JSON.stringify(tiles)).not.toContain('1432');
    expect(JSON.stringify(tiles)).not.toContain('2200');
    expect(tiles[1]).toMatchObject({ value: '111', target: 'Target 150' });
  });

  it('shows a real open session before any program state', () => {
    const summary = trainingSummary({
      open: session({ title: 'Lower body' }),
      todaySessions: [],
      activeMesocycle: MESO,
      programs: [PROGRAM],
      recentSessions: [],
    });
    expect(summary).toMatchObject({ kind: 'active', title: 'Lower body' });
  });

  it('shows a completed session as today’s current training state', () => {
    const summary = trainingSummary({
      open: null,
      todaySessions: [session({ endedAt: 500, title: 'Trainer session', kind: 'personal_trainer' })],
      activeMesocycle: MESO,
      programs: [PROGRAM],
      recentSessions: [],
    });
    expect(summary).toMatchObject({ kind: 'completed', title: 'Trainer session' });
  });

  it('advances to the next stored program day only when session linkage proves the order', () => {
    const summary = trainingSummary({
      open: null,
      todaySessions: [],
      activeMesocycle: MESO,
      programs: [PROGRAM],
      recentSessions: [session({ endedAt: 400, mesocycleId: MESO.id, dayIndex: 0 })],
    });
    expect(summary).toEqual({
      kind: 'next',
      title: 'Lift B',
      subtitle: 'Next in August block',
      detail: '1 movement · 4 sets',
    });
  });

  it('does not guess the next day when logged sessions lack a program-day link', () => {
    const summary = trainingSummary({
      open: null,
      todaySessions: [],
      activeMesocycle: MESO,
      programs: [PROGRAM],
      recentSessions: [session({ endedAt: 400, mesocycleId: MESO.id, dayIndex: null })],
    });
    expect(summary.kind).toBe('block');
    expect(summary.detail).toMatch(/cannot name the next one/i);
  });

  it('keeps readiness empty without a check-in and reports real baseline progress', () => {
    const empty = recoverySummary(null, {
      todayKey: '2026-08-01',
      hrv: [],
      rhr: [],
      nights: [],
      activities: [],
      history: [],
      checkIn: null,
    });
    expect(empty.hasAssessment).toBe(false);
    expect(empty.title).toMatch(/no readiness check-in/i);

    const assessed = recoverySummary(
      {
        band: 'low',
        bandCopy: 'Recovery looks a bit down.',
        baseline: { message: 'Building your baseline — 12/21 days.' },
      } as ReadinessAssessment,
      null,
    );
    expect(assessed).toMatchObject({
      title: 'Low readiness',
      subtitle: 'Recovery looks a bit down.',
      hasAssessment: true,
    });
  });

  it('preserves repository rank while suppressing calorie copy', () => {
    const ranked = [
      insight({ id: 'warning', severity: 'warning', title: 'Energy', body: 'Average 1,500 kcal.' }),
      insight({ id: 'training', severity: 'suggestion' }),
      insight({ id: 'recovery', type: 'recovery' }),
    ];
    expect(visibleInsights(ranked, true).map((item) => item.id)).toEqual([
      'training',
      'recovery',
    ]);
    expect(visibleInsights(ranked, false).map((item) => item.id)).toEqual([
      'warning',
      'training',
      'recovery',
    ]);
  });
});
