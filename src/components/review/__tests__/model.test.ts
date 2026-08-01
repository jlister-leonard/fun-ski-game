/**
 * model.test.ts — what the weekly review tells the coach.
 *
 * The screen is wiring; this file is where the wiring is checked. The
 * assertions are all versions of one rule, stated in `model.ts`: **a missing
 * input is passed through as missing.** `reviewWeek` has a whole branch
 * dedicated to saying what it cannot yet tell you, and that branch only ever
 * fires if this layer resists filling gaps in. A defaulted bodyweight or a
 * zero-calorie unlogged day would produce a confident review of data that does
 * not exist, which is precisely what this screen exists to be the antidote to.
 */

import { describe, it, expect } from 'vitest';

import {
  FALLBACK_LANDMARKS,
  UNCONFIRMED_TRAINER_BOUND_MULTIPLIER,
  ageFromBirthDate,
  buildConditioning,
  buildIntake,
  buildReadiness,
  buildReview,
  buildTraining,
  daysApart,
  shiftDateKey,
  toUserProfile,
  weekKeys,
  type ReviewSnapshot,
} from '../model';
import type {
  Activity,
  FoodLog,
  Goal,
  Muscle,
  Profile,
  ReadinessRecord,
  WorkoutSession,
} from '@/lib/db/types';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const END = '2026-07-26';

const PROFILE: Profile = {
  id: 'profile',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  displayName: null,
  birthDate: '1988-03-14',
  sex: 'male',
  heightCm: 180,
  activityLevel: 'moderately_active',
  timeZone: 'America/New_York',
  unitPreference: 'imperial',
};

const GOAL: Goal = {
  id: 'goal',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  direction: 'cut',
  targetRateKgPerWeek: -0.55,
  targetWeightKg: null,
  targetBodyFatPct: 14,
  startDateKey: '2026-06-14',
  endDateKey: null,
  proteinGPerKgOverride: null,
  note: null,
  active: true,
};

function foodLog(dateKey: string, kcal: number, over: Partial<FoodLog['nutrients']> = {}): FoodLog {
  return {
    id: `${dateKey}-${kcal}`,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    dateKey,
    loggedAt: 0,
    slot: 'dinner',
    foodId: 'f',
    label: 'food',
    grams: 100,
    nutrients: { kcal, proteinG: 40, carbG: 50, fatG: 20, fiberG: 6, ...over },
    note: null,
  } as unknown as FoodLog;
}

function session(over: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 's1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    dateKey: '2026-07-21',
    startedAt: 0,
    endedAt: null,
    mesocycleId: null,
    dayIndex: null,
    kind: 'self',
    title: null,
    sessionRpe: null,
    note: null,
    coachName: null,
    trainerReport: null,
    ...over,
  } as unknown as WorkoutSession;
}

function activity(zone: number | null, minutes: number): Activity {
  return {
    id: `a-${zone}-${minutes}`,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    source: 'strava',
    sourceKey: null,
    dateKey: '2026-07-22',
    startedAt: 0,
    endedAt: minutes * 60_000,
    activityType: 'ride',
    durationSec: minutes * 60,
    distanceM: null,
    activeKcal: null,
    averageHeartRate: null,
    maxHeartRate: null,
    elevationGainM: null,
    zone,
    name: null,
    note: null,
  } as unknown as Activity;
}

function readinessRow(dateKey: string, score: number): ReadinessRecord {
  return {
    id: `r-${dateKey}`,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    source: 'derived',
    sourceKey: null,
    dateKey,
    score,
    contributors: {},
    subjective: null,
    loadMultiplier: null,
    note: null,
  } as unknown as ReadinessRecord;
}

/** Sixty days of weigh-ins on a clean 0.65 %BW/week cut. */
function weighIns(): { date: string; kg: number }[] {
  const out: { date: string; kg: number }[] = [];
  let kg = 88;
  for (let i = 59; i >= 0; i--) {
    out.push({ date: shiftDateKey(END, -i), kg: Math.round(kg * 100) / 100 });
    kg -= 0.08;
  }
  return out;
}

function snapshot(over: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  const keys = weekKeys(END);
  return {
    weekEndingDate: END,
    profile: PROFILE,
    goal: GOAL,
    weights: weighIns(),
    intakeSeries: Array.from({ length: 60 }, (_, i) => ({
      date: shiftDateKey(END, -(59 - i)),
      intakeKcal: 2350,
    })),
    weekFoodLogs: keys.map((k) => foodLog(k, 2350)),
    bodyFatPct: 21,
    sessions: [],
    exercisesById: new Map(),
    appSetsByMuscle: {},
    activities: [],
    zoneMinutes: {},
    readiness: [],
    ...over,
  };
}

/* ================================================================== */
/* Dates                                                               */
/* ================================================================== */

describe('date helpers', () => {
  it('shifts across a month boundary', () => {
    expect(shiftDateKey('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftDateKey('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
  });

  it('returns seven ascending keys ending on the given day', () => {
    const keys = weekKeys('2026-07-26');
    expect(keys).toHaveLength(7);
    expect(keys[0]).toBe('2026-07-20');
    expect(keys[6]).toBe('2026-07-26');
  });

  it('counts whole days between keys', () => {
    expect(daysApart('2026-06-14', '2026-07-26')).toBe(42);
  });

  it('computes age without rounding a birthday early', () => {
    expect(ageFromBirthDate('1988-03-14', '2026-03-13')).toBe(37);
    expect(ageFromBirthDate('1988-03-14', '2026-03-14')).toBe(38);
    expect(ageFromBirthDate(null, '2026-03-14')).toBeNull();
  });
});

/* ================================================================== */
/* Profile — refuse rather than default                                */
/* ================================================================== */

describe('toUserProfile', () => {
  it('builds a profile when everything it needs is present', () => {
    const p = toUserProfile(PROFILE, GOAL, 85, 21, END);
    expect(p).not.toBeNull();
    expect(p?.bodyweightKg).toBe(85);
    expect(p?.bodyFatPct).toBe(21);
    expect(p?.goal).toBe('cut');
    expect(p?.goalBodyFatPct).toBe(14);
  });

  it('returns null rather than guessing a missing field', () => {
    expect(toUserProfile({ ...PROFILE, sex: null }, GOAL, 85, 21, END)).toBeNull();
    expect(toUserProfile({ ...PROFILE, heightCm: null }, GOAL, 85, 21, END)).toBeNull();
    expect(toUserProfile({ ...PROFILE, birthDate: null }, GOAL, 85, 21, END)).toBeNull();
    expect(toUserProfile(PROFILE, GOAL, null, 21, END)).toBeNull();
    expect(toUserProfile(null, GOAL, 85, 21, END)).toBeNull();
  });

  it('omits body fat entirely rather than sending a placeholder', () => {
    const p = toUserProfile(PROFILE, GOAL, 85, null, END);
    expect(p).not.toBeNull();
    expect('bodyFatPct' in (p as object)).toBe(false);
  });

  it('defaults the goal direction to maintain, never to a cut', () => {
    expect(toUserProfile(PROFILE, null, 85, 21, END)?.goal).toBe('maintain');
  });
});

/* ================================================================== */
/* Intake — unlogged days are missing, not zero                        */
/* ================================================================== */

describe('buildIntake', () => {
  const keys = weekKeys(END);

  it('marks unlogged days null and averages only over logged ones', () => {
    const intake = buildIntake([foodLog(keys[0], 2000), foodLog(keys[1], 3000)], keys, 2300);
    expect(intake).not.toBeNull();
    expect(intake?.days.filter((d) => d.kcal === null)).toHaveLength(5);
    expect(intake?.meanKcal).toBe(2500); // not 5000/7
  });

  it('sums several logs on the same day', () => {
    const intake = buildIntake([foodLog(keys[0], 1000), foodLog(keys[0], 800)], keys, 2300);
    expect(intake?.days[0].kcal).toBe(1800);
    expect(intake?.meanKcal).toBe(1800);
  });

  it('treats a missing fibre field as zero grams, which understates rather than over', () => {
    const noFibre = foodLog(keys[0], 2000);
    delete (noFibre.nutrients as { fiberG?: number }).fiberG;
    expect(buildIntake([noFibre], keys, 2300)?.meanFiberG).toBe(0);
  });

  it('returns null when nothing was logged at all', () => {
    expect(buildIntake([], keys, 2300)).toBeNull();
  });
});

/* ================================================================== */
/* Training — an unreported trainer session is not zero                */
/* ================================================================== */

describe('buildTraining', () => {
  const trainerSession = (confirmed: boolean) =>
    session({
      id: confirmed ? 'sc' : 'su',
      kind: 'personal_trainer',
      trainerReport: {
        durationMin: 60,
        regionEffort: {},
        hardSetsTotal: null,
        perceivedRir: null,
        sledMeters: null,
        exerciseNames: [],
        confirmed,
        estimate: { upper_back: { meanSets: 6, sdSets: 2 } },
      },
    });

  it('rounds an unconfirmed trainer session up, not down', () => {
    const confirmed = buildTraining([trainerSession(true)], {});
    const unconfirmed = buildTraining([trainerSession(false)], {});
    const c = confirmed?.volume[0].trainerSetsUpperBound as number;
    const u = unconfirmed?.volume[0].trainerSetsUpperBound as number;
    expect(c).toBe(8); // mean 6 + 1 SD
    expect(u).toBeCloseTo(8 * UNCONFIRMED_TRAINER_BOUND_MULTIPLIER, 1);
    expect(u).toBeGreaterThan(c);
  });

  it('counts the app\'s own sets separately from the trainer\'s', () => {
    const t = buildTraining([trainerSession(true)], { upper_back: 4 } as Partial<Record<Muscle, number>>);
    const row = t?.volume.find((v) => v.muscle === 'upper_back');
    expect(row?.appSets).toBe(4);
    expect(row?.trainerSetsUpperBound).toBe(8);
  });

  it('reports how many trainer sessions were confirmed', () => {
    const t = buildTraining([trainerSession(true), trainerSession(false)], {});
    expect(t?.trainerSessions).toBe(2);
    expect(t?.trainerSessionsConfirmed).toBe(1);
  });

  it('falls back to generic landmarks rather than omitting the muscle', () => {
    const t = buildTraining([], { quads: 10 } as Partial<Record<Muscle, number>>);
    expect(t?.volume[0].landmarks).toEqual(FALLBACK_LANDMARKS);
  });

  it('returns null when there was no training at all', () => {
    expect(buildTraining([], {})).toBeNull();
  });
});

/* ================================================================== */
/* Conditioning                                                        */
/* ================================================================== */

describe('buildConditioning', () => {
  it('counts zone 2 as zone 2 only — zone 1 is recovery, not aerobic base', () => {
    const c = buildConditioning([activity(1, 40), activity(2, 50)], { 1: 40, 2: 50 });
    expect(c?.zone2Minutes).toBe(50);
    expect(c?.zone2Sessions).toBe(1);
  });

  it('counts Z4 and Z5 as the hard interval dose', () => {
    const c = buildConditioning([activity(4, 30), activity(5, 25), activity(2, 60)], { 2: 60 });
    expect(c?.hardIntervalSessions).toBe(2);
  });

  it('returns null when nothing was logged', () => {
    expect(buildConditioning([], {})).toBeNull();
  });
});

/* ================================================================== */
/* Readiness — band from the raw score, never from the percentage      */
/* ================================================================== */

describe('buildReadiness', () => {
  it('inverts the stored percentage and bands the raw score', () => {
    // readinessPercent maps [-2, +1] onto [0, 100]: 0 → 67, -1 → 33.
    const days = buildReadiness([readinessRow('2026-07-20', 67), readinessRow('2026-07-21', 33)]);
    expect(days[0].band).toBe('normal');
    expect(days[1].band).toBe('poor');
  });

  it('sorts ascending by date', () => {
    const days = buildReadiness([readinessRow('2026-07-22', 60), readinessRow('2026-07-20', 60)]);
    expect(days.map((d) => d.date)).toEqual(['2026-07-20', '2026-07-22']);
  });
});

/* ================================================================== */
/* The assembly                                                        */
/* ================================================================== */

describe('buildReview', () => {
  it('produces a coach input from a full week', () => {
    const build = buildReview(snapshot());
    expect(build).not.toBeNull();
    expect(build?.input.trend).not.toBeNull();
    expect(build?.input.expenditure).not.toBeNull();
    expect(build?.input.intake).not.toBeNull();
    expect(build?.trendSeries.length).toBeGreaterThan(50);
  });

  it('converts the goal rate from kg/week into %bodyweight/week', () => {
    const build = buildReview(snapshot());
    const trendKg = build?.input.trend?.trendKg as number;
    expect(build?.input.goals.targetRatePctBwPerWeek).toBeCloseTo((-0.55 / trendKg) * 100, 1);
  });

  it('passes the goal body-fat target straight through', () => {
    expect(buildReview(snapshot())?.input.goals.targetBodyFatPct).toBe(14);
  });

  it('counts weeks elapsed from the goal start, not from the data', () => {
    expect(buildReview(snapshot())?.input.goals.weeksElapsed).toBe(6);
  });

  it('returns null rather than reviewing a profile it cannot compute energy from', () => {
    expect(buildReview(snapshot({ profile: { ...PROFILE, heightCm: null } }))).toBeNull();
    expect(buildReview(snapshot({ weights: [] }))).toBeNull();
  });

  it('omits the expenditure estimate below the estimator\'s own minimum', () => {
    const short = snapshot({
      weights: [
        { date: shiftDateKey(END, -2), kg: 85 },
        { date: shiftDateKey(END, -1), kg: 84.9 },
        { date: END, kg: 84.8 },
      ],
    });
    expect(buildReview(short)?.input.expenditure).toBeNull();
  });

  it('passes no intake at all rather than a week of zeroes', () => {
    expect(buildReview(snapshot({ weekFoodLogs: [] }))?.input.intake).toBeNull();
  });

  it('carries the readiness week through', () => {
    const build = buildReview(
      snapshot({ readiness: [readinessRow('2026-07-20', 30), readinessRow('2026-07-21', 35)] }),
    );
    expect(build?.input.readiness).toHaveLength(2);
  });

  it('is a pure function of its snapshot', () => {
    const s = snapshot();
    expect(JSON.stringify(buildReview(s)?.input)).toBe(JSON.stringify(buildReview(s)?.input));
  });
});
