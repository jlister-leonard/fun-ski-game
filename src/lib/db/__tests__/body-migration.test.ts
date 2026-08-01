/**
 * Body-schema migration v1 → v2.
 *
 * The v2 change is the one that removes a whole class of silently-wrong output:
 * `WorkoutSet.reps` used to be meaningful only when the set was counted in
 * reps, so a 30-minute Zone 2 ride and a 20-yard sled push both stored `0` and
 * any screen rendering `set.reps` printed "0 reps" for them. v2 replaces the
 * flat fields with a tagged union, which makes that unrepresentable.
 *
 * Rows written under v1 must therefore land on the *right* magnitude, not a
 * plausible-looking one — a migration that silently defaults everything to
 * `reps` would preserve exactly the bug it is supposed to remove. These tests
 * pin every v1 shape the app has ever written.
 *
 * Bodies cannot be migrated by Dexie's `upgrade()` hook — the database opens
 * before the vault is unlocked, so there is no key. `migrateBody` runs in
 * memory on read instead, and the row is persisted at its new version on its
 * next write. See `docs/kg/specs/vault-schema.md` §3.
 */

import { describe, expect, it } from 'vitest';

import { deriveIndexKey, importContentKey } from '../../crypto';
import { decodeRow, encodeRow, migrateBody } from '../codec';
import { BODY_VERSION } from '../schema';
import {
  magnitudeValue,
  type ReadinessRecord,
  type WorkoutSession,
  type WorkoutSet,
} from '../types';

/** A v1 `workoutSets` body as the *pre-logger* code wrote it: reps only. */
function v1PlainSet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'set-1',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    sessionId: 'sess-1',
    exerciseId: 'ex-1',
    order: 0,
    weightKg: 100,
    reps: 8,
    effortKind: 'rir',
    effort: 2,
    warmup: false,
    technique: 'straight',
    restSeconds: 150,
    durationSec: null,
    note: null,
    estimated1rmKg: 126.7,
    ...over,
  };
}

/**
 * A v1 body as the **workout logger's workaround** wrote it: the declared
 * fields mirrored inconsistently, plus undeclared `repUnit` / `unitValue` /
 * `rom` body keys. This is the shape that actually exists on disk.
 */
function v1LoggerSet(
  repUnit: string,
  unitValue: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return v1PlainSet({
    repUnit,
    unitValue,
    reps: repUnit === 'reps' ? unitValue : 0,
    durationSec: repUnit === 'seconds' ? unitValue : null,
    rom: null,
    ...over,
  });
}

const up = (body: Record<string, unknown>) =>
  migrateBody<WorkoutSet>('workoutSets', body as unknown as WorkoutSet, 1);

describe('workoutSets v1 → v2', () => {
  it('carries a plain rep set onto the reps arm', () => {
    const set = up(v1PlainSet());
    expect(set.magnitude).toEqual({ repUnit: 'reps', reps: 8 });
    expect(magnitudeValue(set.magnitude)).toBe(8);
  });

  it('reads a rep set written by the logger from unitValue', () => {
    expect(up(v1LoggerSet('reps', 12)).magnitude).toEqual({ repUnit: 'reps', reps: 12 });
  });

  it('puts a 30-minute Zone 2 ride on the seconds arm, NOT at 0 reps', () => {
    const set = up(v1LoggerSet('seconds', 1800));
    expect(set.magnitude).toEqual({ repUnit: 'seconds', seconds: 1800 });
    // The regression this whole migration exists to prevent.
    expect(set.magnitude.repUnit).not.toBe('reps');
    expect(magnitudeValue(set.magnitude)).toBe(1800);
  });

  it('recovers a seconds set from durationSec when unitValue is missing', () => {
    const body = v1PlainSet({ repUnit: 'seconds', durationSec: 45, reps: 0 });
    expect(up(body).magnitude).toEqual({ repUnit: 'seconds', seconds: 45 });
  });

  it('puts a 45-metre sled drag on the meters arm, NOT at 0 reps', () => {
    const set = up(v1LoggerSet('meters', 45));
    expect(set.magnitude).toEqual({ repUnit: 'meters', meters: 45 });
    expect(magnitudeValue(set.magnitude)).toBe(45);
  });

  it('puts a banded lateral walk on the steps arm', () => {
    expect(up(v1LoggerSet('steps', 20)).magnitude).toEqual({ repUnit: 'steps', steps: 20 });
  });

  it('treats a v1 row with no unit at all as reps', () => {
    // Nothing that wrote a v1 row without `repUnit` had any concept but reps,
    // so this is a recovery of intent, not a default.
    const body = v1PlainSet({ reps: 5 });
    delete body.repUnit;
    expect(up(body).magnitude).toEqual({ repUnit: 'reps', reps: 5 });
  });

  it('survives a row missing every magnitude field', () => {
    const body = v1PlainSet();
    delete body.reps;
    delete body.durationSec;
    expect(up(body).magnitude).toEqual({ repUnit: 'reps', reps: 0 });
  });

  it('deletes the legacy fields so the ambiguity cannot come back', () => {
    const set = up(v1LoggerSet('meters', 45)) as unknown as Record<string, unknown>;
    expect(set).not.toHaveProperty('reps');
    expect(set).not.toHaveProperty('durationSec');
    expect(set).not.toHaveProperty('repUnit');
    expect(set).not.toHaveProperty('unitValue');
  });

  it('promotes the logger rom key to the declared field', () => {
    const rom = { value: 12, unit: 'in', note: 'knee to wall' };
    expect(up(v1LoggerSet('reps', 5, { rom })).rom).toEqual(rom);
  });

  it('nulls a malformed rom rather than passing garbage through', () => {
    expect(up(v1LoggerSet('reps', 5, { rom: { unit: 'in' } })).rom).toBeNull();
    expect(up(v1LoggerSet('reps', 5, { rom: 'deep' })).rom).toBeNull();
    expect(up(v1PlainSet()).rom).toBeNull();
  });

  it('preserves every field it does not own', () => {
    const set = up(v1PlainSet({ note: 'left shoulder twinge' }));
    expect(set.weightKg).toBe(100);
    expect(set.effort).toBe(2);
    expect(set.restSeconds).toBe(150);
    expect(set.estimated1rmKg).toBe(126.7);
    expect(set.note).toBe('left shoulder twinge');
    expect(set.sessionId).toBe('sess-1');
  });

  it('is idempotent — a v2 row read again is unchanged', () => {
    const once = up(v1LoggerSet('seconds', 1800));
    const twice = migrateBody<WorkoutSet>('workoutSets', once, 1);
    expect(twice.magnitude).toEqual({ repUnit: 'seconds', seconds: 1800 });
  });

  it('does not re-run once the row is already at the current version', () => {
    const body = v1LoggerSet('meters', 45) as unknown as WorkoutSet;
    expect(migrateBody('workoutSets', body, BODY_VERSION)).toBe(body);
  });

  it('leaves other tables alone', () => {
    const weight = { id: 'w1', kg: 82.4, dateKey: '2026-07-20' } as unknown as WorkoutSet;
    expect(migrateBody('weightEntries', weight, 1)).toEqual(weight);
  });
});

describe('workoutSessions v1 → v2', () => {
  const v1Session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'sess-1',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    dateKey: '2026-07-24',
    startedAt: 10,
    endedAt: 20,
    mesocycleId: null,
    dayIndex: null,
    kind: 'personal_trainer',
    title: 'Trainer session',
    sessionRpe: 8,
    note: 'sled felt heavy',
    coachName: 'Sam',
    ...over,
  });

  const upSession = (body: Record<string, unknown>) =>
    migrateBody<WorkoutSession>('workoutSessions', body as unknown as WorkoutSession, 1);

  it('promotes the logger trainer key to trainerReport', () => {
    const report = {
      durationMin: 60,
      regionEffort: { hips: 3, lats: 2 },
      hardSetsTotal: null,
      perceivedRir: 2,
      sledMeters: 200,
      exerciseNames: ['trap bar deadlift'],
      confirmed: false,
      estimate: { glutes: { meanSets: 4, sdSets: 1.2 } },
    };
    const session = upSession(v1Session({ trainer: report }));
    expect(session.trainerReport).toEqual(report);
    expect(session as unknown as Record<string, unknown>).not.toHaveProperty('trainer');
  });

  it('preserves confirmed:false — an unreported session must still count', () => {
    // Not merely a field copy: if `confirmed` were lost or coerced, volume
    // budgeting would credit the trainer with nothing and stack more work on
    // muscles they already hammered. That inversion is the reason the estimate
    // exists at all.
    const session = upSession(
      v1Session({ trainer: { confirmed: false, estimate: { lats: { meanSets: 6, sdSets: 1.5 } } } }),
    );
    expect(session.trainerReport?.confirmed).toBe(false);
    expect(session.trainerReport?.estimate.lats).toEqual({ meanSets: 6, sdSets: 1.5 });
  });

  it('gives a session with no trainer key an explicit null', () => {
    const session = upSession(v1Session({ kind: 'self' }));
    expect(session.trainerReport).toBeNull();
  });

  it('refuses a malformed report rather than coercing it to an empty one', () => {
    // An empty report would read as "the trainer did nothing", which is the
    // dangerous direction. Null reads as "no data", which the estimator
    // handles by falling back to the prior.
    expect(upSession(v1Session({ trainer: 'yes' })).trainerReport).toBeNull();
    expect(upSession(v1Session({ trainer: null })).trainerReport).toBeNull();
  });

  it('preserves the fields the report deliberately does not duplicate', () => {
    const session = upSession(v1Session({ trainer: { confirmed: true } }));
    expect(session.sessionRpe).toBe(8);
    expect(session.note).toBe('sled felt heavy');
    expect(session.coachName).toBe('Sam');
  });
});

function legacyReadiness(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ready-1', createdAt: 1, updatedAt: 2, deletedAt: null,
    source: 'derived', sourceKey: 'derived:checkin:2026-07-25', dateKey: '2026-07-25',
    score: 42,
    contributors: {
      hrv: 20, 'input.energy': 2, 'input.pain': 1, 'input.illness': 0,
      'input.symptom.chestPain': 0, 'input.symptom.dizzinessOrFainting': 1,
      'input.symptom.shortnessOfBreath': 0, 'input.symptom.unexplainedWeightChange': 0,
      'input.symptom.painAtRest': 1,
    },
    subjective: { soreness: 4, motivation: null, stress: null, sleepQuality: 2 },
    loadMultiplier: 0.8, note: null, ...over,
  };
}

describe('readinessRecords v2 → v3', () => {
  const up = (body: Record<string, unknown>, from = 2) =>
    migrateBody<ReadinessRecord>('readinessRecords', body as unknown as ReadinessRecord, from);

  it('promotes every subjective and safety input and removes workaround keys', () => {
    const record = up(legacyReadiness());
    expect(record.subjective).toEqual({
      soreness: 4, energy: 2, motivation: null, stress: null, sleepQuality: 2,
      painFlag: true, illnessFlag: false,
      symptoms: {
        chestPain: false, dizzinessOrFainting: true, shortnessOfBreath: false,
        unexplainedWeightChange: false, painAtRest: true,
      },
    });
    expect(record.contributors).toEqual({ hrv: 20 });
    expect(record.loadMultiplier).toBe(0.8);
    expect(record.trainingDecision).toBeNull();
  });

  it('also migrates the oldest v1 readiness rows', () => {
    expect(up(legacyReadiness(), 1).subjective?.energy).toBe(2);
  });

  it('leaves a vendor row without a check-in at subjective:null', () => {
    const record = up(legacyReadiness({ source: 'oura', contributors: { vendor: 88 }, subjective: null }));
    expect(record.subjective).toBeNull();
    expect(record.contributors).toEqual({ vendor: 88 });
  });

  it('is idempotent if the v2 step is retried', () => {
    const once = up(legacyReadiness());
    expect(up(once as unknown as Record<string, unknown>).subjective).toEqual(once.subjective);
  });

  it('migrates an actual encrypted v2 row after decryption', async () => {
    const rawKey = new Uint8Array(32).fill(7);
    const keys = { dek: await importContentKey(rawKey), indexKey: await deriveIndexKey(rawKey) };
    const row = await encodeRow(keys, 'readinessRecords', legacyReadiness() as unknown as ReadinessRecord);
    row.v = 2;
    const decoded = await decodeRow<ReadinessRecord>(keys, 'readinessRecords', row);
    expect(decoded.subjective?.energy).toBe(2);
    expect(decoded.subjective?.symptoms.dizzinessOrFainting).toBe(true);
    expect(decoded.contributors).toEqual({ hrv: 20 });
  });

  it('round-trips a new typed row through AES-GCM unchanged', async () => {
    const rawKey = new Uint8Array(32).fill(11);
    const keys = { dek: await importContentKey(rawKey), indexKey: await deriveIndexKey(rawKey) };
    const record = up(legacyReadiness());
    const row = await encodeRow(keys, 'readinessRecords', record);
    expect(row.v).toBe(BODY_VERSION);
    expect(await decodeRow<ReadinessRecord>(keys, 'readinessRecords', row)).toEqual(record);
  });
});
