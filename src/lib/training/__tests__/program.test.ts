/**
 * Program generation (A5).
 *
 * The central assertion of this file is the one that looks like a bug report
 * and is not: with several trainer sessions a week,
 * the app must prescribe **zero** rows, zero pulldowns, zero hinging and zero
 * direct lower-back work. That is the correct output. Everything else here
 * exists to make sure the zero is arrived at honestly — that the budget really
 * subtracts an *upper* bound, that prehab and conditioning come off the top,
 * and that the tradeoffs are stated rather than absorbed.
 */

import { describe, expect, it } from 'vitest';

import { exerciseBySlug } from '../library';
import {
  allProgramSlugs,
  budgetWeek,
  DEFAULT_PACE,
  estimatePace,
  expectedTrainerWeek,
  generateWeek,
  GOAL_CONFLICTS,
  INDICATOR_MAX_SETS,
  PROGRAM_TEMPLATES,
  SYNTHETIC_PROFILE,
  SESSION_TIME,
  slugsInPlan,
  TRADEOFF_COPY,
  WEEK_SKELETON,
  type MuscleBudget,
  type ProgramProfile,
  type WeekPlan,
} from '../program';
import { DEFAULT_MESO } from '../mesocycle';
import { SEED_CONFIDENCE, priorFromFocus, trainerLoadFor } from '../trainer-estimate';
import { ALL_MUSCLES, type TrainerWeekLoad } from '../volume';
import type { Muscle } from '../../db/types';
import type { TrainerSessionReport } from '../types';

/** Three unconfirmed trainer sessions at the seed prior — the week-1 state. */
function seedTrainerWeek(sessions = 3): Partial<Record<Muscle, TrainerWeekLoad>> {
  const syntheticPrior = priorFromFocus(SYNTHETIC_PROFILE.trainerFocus ?? '');
  const reports: TrainerSessionReport[] = Array.from({ length: sessions }, () => ({
    durationMin: 60,
    regionEffort: {},
    hardSetsTotal: null,
    perceivedRir: null,
    sledMeters: 220,
    exerciseNames: [],
    confirmed: false,
    estimate: { ...syntheticPrior },
  }));

  const out: Partial<Record<Muscle, TrainerWeekLoad>> = {};
  for (const muscle of ALL_MUSCLES) {
    const load = trainerLoadFor(reports, muscle, SEED_CONFIDENCE);
    out[muscle] = {
      stimulusMean: load.stimulusMean,
      stimulusUpperBound: load.stimulusUpperBound,
      fatigueUpperBound: load.fatigueUpperBound,
    };
  }
  return out;
}

function budgetFor(plan: WeekPlan, muscle: Muscle): MuscleBudget {
  const found = plan.budgets.find((b) => b.muscle === muscle);
  if (!found) throw new Error(`no budget for ${muscle}`);
  return found;
}

function setsOf(plan: WeekPlan, slug: string): number {
  let total = 0;
  for (const day of plan.days) {
    for (const item of day.items) if (item.slug === slug) total += item.sets;
  }
  return total;
}

/** Total app-side hard-set charge on a muscle across the week. */
function appCharge(plan: WeekPlan, muscle: Muscle): number {
  let total = 0;
  for (const day of plan.days) {
    for (const item of day.items) total += item.charges[muscle] ?? 0;
  }
  return total;
}

const trainer = seedTrainerWeek();
const week1 = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer });
const week3 = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer });
const deload = generateWeek(SYNTHETIC_PROFILE, { week: 4, trainer });

// ---------------------------------------------------------------------------

describe('slug integrity', () => {
  it('resolves every slug the generator can ever emit', () => {
    const dangling = allProgramSlugs().filter((slug) => exerciseBySlug(slug) === null);
    expect(dangling).toEqual([]);
  });

  it('resolves every slug in a generated plan, in every week of the block', () => {
    for (let week = 1; week <= DEFAULT_MESO.accumulationWeeks + DEFAULT_MESO.deloadWeeks; week += 1) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week, trainer });
      for (const slug of slugsInPlan(plan)) {
        expect(exerciseBySlug(slug), `${slug} (week ${week})`).not.toBeNull();
      }
    }
  });

  it('resolves the athlete’s current ladder rungs', () => {
    for (const ladder of SYNTHETIC_PROFILE.ladders) {
      expect(exerciseBySlug(ladder.currentSlug), ladder.ladder).not.toBeNull();
    }
  });

  it('reads rep units off the library rather than inferring them', () => {
    for (const day of week1.days) {
      for (const item of day.items) {
        expect(item.repUnit).toBe(exerciseBySlug(item.slug)?.rep_unit);
      }
    }
    // The two that break every naive inference.
    expect(week1.days.flatMap((d) => d.items).find((i) => i.slug === 'sled-push-forward')?.repUnit)
      .toBe('meters');
    expect(week1.days.flatMap((d) => d.items).find((i) => i.slug === 'zone2-incline-walk')?.repUnit)
      .toBe('seconds');
  });
});

describe('the trainer budget — the crux', () => {
  it('prescribes nothing for the muscles the trainer already covers', () => {
    for (const muscle of ['upper_back', 'lats', 'glutes', 'hamstrings', 'spinal_erectors'] as const) {
      expect(budgetFor(week1, muscle).sets, muscle).toBe(0);
    }
  });

  it('writes no rows, no pulldowns, no hinging and no direct lower-back work', () => {
    const banned = [
      'barbell-row', 'seated-cable-row', 'chest-supported-row', 'lat-pulldown',
      'neutral-grip-lat-pulldown', 'romanian-deadlift', 'conventional-deadlift',
      'hip-thrust', 'good-morning', 'seated-good-morning', 'jefferson-curl',
      '45-degree-back-extension', 'back-squat',
    ];
    for (let week = 1; week <= 4; week += 1) {
      const slugs = new Set(slugsInPlan(generateWeek(SYNTHETIC_PROFILE, { week, trainer })));
      for (const slug of banned) expect(slugs.has(slug), `${slug} in week ${week}`).toBe(false);
    }
  });

  it('still owns pressing, delts, arms, calves, tibialis and core from week 1', () => {
    for (const muscle of ['chest', 'side_delts', 'triceps'] as const) {
      expect(budgetFor(week1, muscle).sets, muscle).toBeGreaterThan(0);
    }
    const slugs = new Set(slugsInPlan(week1));
    expect(slugs.has('incline-dumbbell-press')).toBe(true);
    expect(slugs.has('cable-lateral-raise')).toBe(true);
    expect(slugs.has('tibialis-raise')).toBe(true);
    expect(slugs.has('cable-crunch')).toBe(true);
  });

  it('budgets against the upper bound, not the mean', () => {
    const lats = budgetFor(week1, 'lats');
    const mean = trainer.lats?.stimulusMean ?? 0;
    expect(lats.trainerStimulus).toBeGreaterThan(mean);
  });

  it('hands sets back as confirmations sharpen the estimate', () => {
    const confident: Partial<Record<Muscle, TrainerWeekLoad>> = {};
    for (const muscle of ALL_MUSCLES) {
      const load = trainerLoadFor(
        Array.from({ length: 3 }, () => ({
          durationMin: 60,
          regionEffort: {},
          hardSetsTotal: null,
          perceivedRir: null,
          sledMeters: 220,
          exerciseNames: [],
          confirmed: true,
          estimate: { ...priorFromFocus(SYNTHETIC_PROFILE.trainerFocus ?? '') },
        })),
        muscle,
        0.9,
      );
      confident[muscle] = {
        stimulusMean: load.stimulusMean,
        stimulusUpperBound: load.stimulusUpperBound,
        fatigueUpperBound: load.fatigueUpperBound,
      };
    }
    const sharp = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer: confident });
    const before = week1.budgets.reduce((a, b) => a + b.sets, 0);
    const after = sharp.budgets.reduce((a, b) => a + b.sets, 0);
    expect(after).toBeGreaterThan(before);
  });

  it('gives the app the whole week when there is no trainer', () => {
    const solo = generateWeek(SYNTHETIC_PROFILE, { week: 1 });
    expect(budgetFor(solo, 'lats').sets).toBeGreaterThan(0);
    expect(budgetFor(solo, 'upper_back').sets).toBeGreaterThan(0);
    expect(solo.coveredByTrainer).toEqual([]);
  });

  it('keeps the unclamped budget as a diagnostic even when it goes negative', () => {
    const glutes = budgetFor(week1, 'glutes');
    expect(glutes.sets).toBe(0);
    expect(glutes.unclamped).toBeLessThan(0);
    expect(glutes.status === 'over' || glutes.status === 'over_ceiling').toBe(true);
  });

  it('never lets the app plus the trainer exceed the muscle’s ceiling', () => {
    for (let week = 1; week <= 4; week += 1) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week, trainer });
      for (const budget of plan.budgets) {
        if (budget.trainerFatigue > budget.ceiling) continue; // already over on the trainer alone
        const app = appCharge(plan, budget.muscle);
        // Indicator reservations are the one sanctioned overspend, bounded at
        // two sets per lift and gated on real fatigue headroom.
        expect(app + budget.trainerFatigue, budget.muscle).toBeLessThanOrEqual(
          budget.ceiling + INDICATOR_MAX_SETS + 1e-6,
        );
      }
    }
  });
});

describe('the two ledgers', () => {
  it('rescues quads: sled is cheap on fatigue even when stimulus is spent', () => {
    const quads = budgetFor(week1, 'quads');
    expect(quads.trainerFatigue).toBeLessThan(quads.trainerStimulus);
    expect(quads.stimulusBudget).toBeLessThan(quads.fatigueBudget);
  });

  it('funds the knee-ability ladder and the hack-squat indicator out of that headroom', () => {
    expect(budgetFor(week1, 'quads').sets).toBe(0);
    expect(setsOf(week1, 'patrick-step')).toBeGreaterThan(0);
    expect(setsOf(week1, 'atg-split-squat')).toBeGreaterThan(0);
    expect(setsOf(week1, 'hack-squat')).toBeGreaterThan(0);
  });

  it('takes the smaller of the two ledgers, never the larger', () => {
    for (const budget of week1.budgets) {
      expect(budget.unclamped).toBeLessThanOrEqual(budget.fatigueBudget + 1e-9);
    }
  });
});

describe('indicator lifts (§3.6)', () => {
  it('runs every indicator even when its muscle has no budget left', () => {
    for (const slug of SYNTHETIC_PROFILE.indicatorLifts) {
      expect(setsOf(week1, slug), slug).toBeGreaterThan(0);
    }
  });

  it('caps the reservation so it cannot become a backdoor', () => {
    for (const day of week1.days) {
      for (const item of day.items) {
        expect(item.reservedSets).toBeLessThanOrEqual(INDICATOR_MAX_SETS);
      }
    }
  });

  it('keeps the pull-up to a single top set', () => {
    expect(setsOf(week1, 'weighted-pull-up')).toBe(1);
  });

  it('says so out loud when an indicator has to be dropped', () => {
    const crowded: Partial<Record<Muscle, TrainerWeekLoad>> = {
      ...trainer,
      chest: { stimulusMean: 30, stimulusUpperBound: 34, fatigueUpperBound: 34 },
    };
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer: crowded });
    expect(budgetFor(plan, 'chest').indicatorDropped).toBe(true);
    expect(plan.findings.some((f) => f.code === 'strength.indicator_dropped')).toBe(true);
  });
});

describe('the week’s shape (§7)', () => {
  it('programs Mon, Fri, Sat and Sun and only observes Tue–Thu', () => {
    const app = week1.days.filter((d) => d.owner === 'app').map((d) => d.day);
    const trainerDays = week1.days.filter((d) => d.owner === 'trainer').map((d) => d.day);
    expect(app).toEqual([1, 5, 6, 0]);
    expect(trainerDays).toEqual([2, 3, 4]);
    for (const day of week1.days) {
      if (day.owner === 'trainer') expect(day.items).toEqual([]);
    }
  });

  it('orders the week Monday first, Sunday last', () => {
    expect(week1.days.map((d) => d.day)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('reproduces the specified week-1 Monday session', () => {
    // §7.2's table, with two deliberate differences, both from counting the
    // indirect volume that pressing already delivers (methodology §2.3): the
    // triceps slot drops to one set, and the direct front-delt press drops out
    // entirely because three incline presses and two machine presses already
    // put front delts at 2.5 of a week-1 target of 3. Front delts have MEV 0
    // precisely because all pressing feeds them, so that is the right answer
    // for the MEV week — and the slot returns in week 2.
    const monday = week1.days.find((d) => d.day === 1);
    expect(monday?.items.map((i) => [i.slug, i.sets])).toEqual([
      ['incline-dumbbell-press', 3],
      ['weighted-pull-up', 1],
      ['machine-chest-press', 2],
      ['hack-squat', 2],
      ['cable-lateral-raise', 3],
      ['overhead-cable-triceps-extension', 1],
      ['standing-calf-raise', 2],
      ['face-pull', 2],
    ]);
  });

  it('brings the direct shoulder press back once there is budget for it', () => {
    const week2 = generateWeek(SYNTHETIC_PROFILE, { week: 2, trainer });
    expect(setsOf(week2, 'seated-dumbbell-shoulder-press')).toBeGreaterThan(0);
  });

  it('never spends more on a muscle than its budget, counting indirect work', () => {
    for (let week = 1; week <= 3; week += 1) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week, trainer });
      for (const budget of plan.budgets) {
        // Prehab and conditioning were charged off the top before the budget
        // was struck, so they are added back here. The indicator reservation is
        // the one sanctioned overspend (§3.6).
        const allowed =
          budget.sets + budget.prehab + budget.conditioningStimulus + INDICATOR_MAX_SETS;
        expect(appCharge(plan, budget.muscle), `${budget.muscle} wk${week}`).toBeLessThanOrEqual(
          allowed + 1e-6,
        );
      }
    }
  });

  it('keeps Friday low-systemic — it is the day after three trainer sessions', () => {
    expect(week1.days.find((d) => d.day === 5)?.systemicCost).toBe('moderate');
  });

  it('defends the Saturday interval session and its 4 × 4 min structure', () => {
    const saturday = week1.days.find((d) => d.day === 6);
    const intervals = saturday?.items.find((i) => i.slug === 'assault-bike-intervals');
    expect(intervals?.sets).toBe(4);
    expect(intervals?.repMin).toBe(240);
    expect(intervals?.repUnit).toBe('seconds');
    expect(intervals?.zone).toBe('z5');
  });

  it('puts the resilience work before the intervals on Saturday', () => {
    const saturday = week1.days.find((d) => d.day === 6);
    const slugs = saturday?.items.map((i) => i.slug) ?? [];
    expect(slugs.indexOf('atg-split-squat')).toBeLessThan(slugs.indexOf('assault-bike-intervals'));
  });

  it('keeps Sunday recovery-positive', () => {
    const sunday = week1.days.find((d) => d.day === 0);
    expect(sunday?.systemicCost).toBe('low');
    expect(sunday?.items.some((i) => i.slug === 'zone2-incline-walk')).toBe(true);
  });

  it('never touches the modalities the budget rules out', () => {
    const excluded = ['zone2-row', 'zone2-swim', 'rower-intervals', 'vo2max-intervals-run', 'sprint-intervals'];
    for (let week = 1; week <= 4; week += 1) {
      const slugs = new Set(slugsInPlan(generateWeek(SYNTHETIC_PROFILE, { week, trainer })));
      for (const slug of excluded) expect(slugs.has(slug), slug).toBe(false);
    }
  });

  it('closes both pressing days with face pulls and neither of the others', () => {
    for (const day of week1.days) {
      const hasFacePull = day.items.some((i) => i.slug === 'face-pull');
      expect(hasFacePull, `day ${day.day}`).toBe(day.day === 1 || day.day === 5);
    }
  });

  it('keeps hard conditioning well under the haircut threshold', () => {
    expect(week1.hardConditioningMinutes).toBeGreaterThan(0);
    expect(week1.hardConditioningMinutes).toBeLessThan(60);
  });
});

describe('the ramp across the block', () => {
  it('grows the app’s volume from week 1 to week 3', () => {
    const w1 = week1.budgets.reduce((a, b) => a + b.sets, 0);
    const w3 = week3.budgets.reduce((a, b) => a + b.sets, 0);
    expect(w3).toBeGreaterThan(w1);
  });

  it('tightens RIR across accumulation and resets on the deload', () => {
    expect([1, 2, 3, 4].map((w) => generateWeek(SYNTHETIC_PROFILE, { week: w, trainer }).targetRir))
      .toEqual([3, 2, 1, 4]);
  });

  it('never climbs more than the slew cap on any muscle', () => {
    const plans = [1, 2, 3].map((w) => generateWeek(SYNTHETIC_PROFILE, { week: w, trainer }));
    for (const muscle of ALL_MUSCLES) {
      for (let i = 1; i < plans.length; i += 1) {
        const jump = budgetFor(plans[i], muscle).sets - budgetFor(plans[i - 1], muscle).sets;
        expect(jump, muscle).toBeLessThanOrEqual(DEFAULT_MESO.setSlewCap);
      }
    }
  });
});

describe('the deload is a trainer-only week (§8.2)', () => {
  it('drops the VO2max session entirely', () => {
    expect(setsOf(deload, 'assault-bike-intervals')).toBe(0);
    expect(deload.hardConditioningMinutes).toBe(0);
  });

  it('drops the Friday sled block', () => {
    expect(setsOf(deload, 'sled-push-forward')).toBe(0);
  });

  it('keeps Zone 2 at full dose — it is the last thing ever cut', () => {
    expect(setsOf(deload, 'zone2-incline-walk')).toBe(setsOf(week1, 'zone2-incline-walk'));
  });

  it('keeps prehab and mobility at full dose — mobility is not what needs deloading', () => {
    for (const slug of [
      'patrick-step', 'atg-split-squat', 'assisted-nordic-curl', 'knees-over-toes-calf-raise',
      'couch-stretch', 'ninety-ninety-hip-switch', 'pallof-press', 'quadruped-thoracic-rotation',
      'tibialis-raise', 'seated-tibialis-raise', 'side-lying-external-rotation', 'face-pull',
    ]) {
      expect(setsOf(deload, slug), slug).toBe(setsOf(week1, slug));
    }
  });

  it('cuts lifting volume below the final accumulation week', () => {
    expect(appCharge(deload, 'chest')).toBeLessThan(appCharge(week3, 'chest'));
    expect(deload.targetRir).toBe(DEFAULT_MESO.deloadRir);
  });

  it('tells the user why a week that is mostly trainer sessions is still a deload', () => {
    expect(deload.findings.some((f) => f.code === 'plan.deload_week')).toBe(true);
  });
});

describe('prehab is a veto, not a budget line (§6.2)', () => {
  it('charges prehab off the top of both ledgers', () => {
    expect(budgetFor(week1, 'tibialis').prehab).toBeGreaterThan(0);
    expect(budgetFor(week1, 'hip_flexors').prehab).toBeGreaterThan(0);
  });

  it('runs the Nordic and knee ladders the trainer does not cover', () => {
    expect(setsOf(week1, 'assisted-nordic-curl')).toBeGreaterThan(0);
    expect(setsOf(week1, 'patrick-step')).toBeGreaterThan(0);
  });

  it('does not double-prescribe scapular work the trainer likely covers', () => {
    const slugs = new Set(slugsInPlan(week1));
    expect(slugs.has('scap-pull-up')).toBe(false);
    expect(slugs.has('band-pull-apart')).toBe(false);
  });

  it('surfaces the ROM-tracked movements so depth, not load, is the progression', () => {
    const romItems = week1.days.flatMap((d) => d.items).filter((i) => i.romTracked);
    expect(romItems.map((i) => i.slug)).toEqual(
      expect.arrayContaining(['patrick-step', 'atg-split-squat', 'knees-over-toes-calf-raise']),
    );
  });

  it('keeps every prehab set at RIR 2 or more — it is resilience, not stimulus', () => {
    for (const day of week1.days) {
      for (const item of day.items) {
        if (item.role !== 'prehab') continue;
        if (item.targetRir === null) continue;
        expect(item.targetRir, item.slug).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('follows the athlete up a ladder when they advance', () => {
    const advanced: ProgramProfile = {
      ...SYNTHETIC_PROFILE,
      ladders: SYNTHETIC_PROFILE.ladders.map((l) =>
        l.ladder === 'knee_split_squat' ? { ...l, currentSlug: 'poliquin-step-up' } : l,
      ),
    };
    const plan = generateWeek(advanced, { week: 1, trainer });
    const slugs = new Set(slugsInPlan(plan));
    expect(slugs.has('poliquin-step-up')).toBe(true);
    expect(slugs.has('patrick-step')).toBe(false);
  });
});

describe('honesty about the goals', () => {
  it('states all four tradeoffs verbatim', () => {
    for (const code of ['goal.rate_capped', 'goal.strength_held', 'goal.vo2max_realistic']) {
      expect(week1.findings.some((f) => f.code === code), code).toBe(true);
    }
    const strength = week1.findings.find((f) => f.code === 'goal.strength_held');
    expect(strength?.message).toBe(TRADEOFF_COPY.strength_held.body);
  });

  it('says plainly that hypertrophy is not on offer this block', () => {
    const finding = week1.findings.find((f) => f.code === 'goal.hypertrophy_not_this_block');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('will not get bigger');
  });

  it('explains why there is almost no rowing or hip work', () => {
    const finding = week1.findings.find((f) => f.code === 'volume.covered_by_trainer');
    expect(finding?.message).toBe(TRADEOFF_COPY.trainer_crowding.body);
  });

  it('marks fat loss + VO2max compatible and fat loss + hypertrophy not', () => {
    expect(GOAL_CONFLICTS.find((c) => c.pair === 'Fat loss + VO2max')?.compatible).toBe('yes');
    expect(GOAL_CONFLICTS.find((c) => c.pair === 'Fat loss + hypertrophy')?.compatible).toBe('no');
  });

  it('inverts the pull:push advice rather than suggesting a row', () => {
    const finding = week1.findings.find((f) => f.code === 'balance.pull_over_satisfied');
    expect(finding?.message).toContain('more pressing from me, not more rowing');
  });

  it('blocks every progression when discomfort is flagged, and routes to a clinician', () => {
    const flagged: ProgramProfile = { ...SYNTHETIC_PROFILE, discomfortSites: ['left knee'] };
    const plan = generateWeek(flagged, { week: 2, trainer });
    const finding = plan.findings.find((f) => f.code === 'plan.discomfort_flagged');
    expect(finding?.level).toBe('block');
    expect(finding?.message).toContain('qualified clinician');
  });
});

describe('equipment', () => {
  it('falls back to the treadmill when there is no sled', () => {
    const noSled: ProgramProfile = {
      ...SYNTHETIC_PROFILE,
      equipment: SYNTHETIC_PROFILE.equipment.filter((e) => e !== 'sled'),
    };
    const plan = generateWeek(noSled, { week: 1, trainer });
    const slugs = new Set(slugsInPlan(plan));
    expect(slugs.has('sled-push-forward')).toBe(false);
    expect(slugs.has('backward-walk-treadmill') || slugs.has('assault-bike-intervals')).toBe(true);
  });

  it('substitutes a machine raise for the cable one and records the substitution', () => {
    const noCables: ProgramProfile = {
      ...SYNTHETIC_PROFILE,
      equipment: SYNTHETIC_PROFILE.equipment.filter((e) => e !== 'cable'),
    };
    const plan = generateWeek(noCables, { week: 1, trainer });
    const item = plan.days
      .flatMap((d) => d.items)
      .find((i) => i.substitutedFor === 'cable-lateral-raise');
    expect(item?.slug).toBe('machine-lateral-raise');
    expect(slugsInPlan(plan)).not.toContain('cable-lateral-raise');
  });

  it('drops a slot and says so rather than substituting something that trains elsewhere', () => {
    const bare: ProgramProfile = { ...SYNTHETIC_PROFILE, equipment: ['bodyweight'] };
    const plan = generateWeek(bare, { week: 1, trainer });
    expect(plan.findings.some((f) => f.code === 'plan.slot_dropped')).toBe(true);
  });
});

describe('templates', () => {
  it('leads with the personalized block and only that one is personalized', () => {
    expect(PROGRAM_TEMPLATES[0].personalized).toBe(true);
    expect(PROGRAM_TEMPLATES.filter((t) => t.personalized)).toHaveLength(1);
  });

  it('gives every template a ramp whose length matches its accumulation weeks', () => {
    for (const template of PROGRAM_TEMPLATES) {
      expect(template.rirRamp).toHaveLength(template.accumulationWeeks);
      // RIR falls, or holds, across the block. It never rises.
      for (let i = 1; i < template.rirRamp.length; i += 1) {
        expect(template.rirRamp[i]).toBeLessThanOrEqual(template.rirRamp[i - 1]);
      }
    }
  });

  it('has unique ids', () => {
    expect(new Set(PROGRAM_TEMPLATES.map((t) => t.id)).size).toBe(PROGRAM_TEMPLATES.length);
  });
});

describe('structural invariants', () => {
  it('never emits a slot with zero sets', () => {
    for (let week = 1; week <= 4; week += 1) {
      for (const day of generateWeek(SYNTHETIC_PROFILE, { week, trainer }).days) {
        for (const item of day.items) expect(item.sets, item.slug).toBeGreaterThan(0);
      }
    }
  });

  it('covers every muscle in the budget table, exactly once', () => {
    expect(week1.budgets).toHaveLength(ALL_MUSCLES.length);
    expect(new Set(week1.budgets.map((b) => b.muscle)).size).toBe(ALL_MUSCLES.length);
  });

  it('flags the extrapolated landmarks rather than implying precision', () => {
    expect(budgetFor(week1, 'tibialis').lowConfidence).toBe(true);
    expect(budgetFor(week1, 'chest').lowConfidence).toBe(false);
  });

  it('gives conditioning and mobility no RIR target', () => {
    for (const day of week1.days) {
      for (const item of day.items) {
        if (item.role === 'conditioning' || item.role === 'mobility') {
          expect(item.targetRir, item.slug).toBeNull();
        }
      }
    }
  });

  it('uses only slots the skeleton declares', () => {
    const declared = new Set(allProgramSlugs());
    for (const slug of slugsInPlan(week3)) expect(declared.has(slug), slug).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(generateWeek(SYNTHETIC_PROFILE, { week: 2, trainer }))).toBe(
      JSON.stringify(generateWeek(SYNTHETIC_PROFILE, { week: 2, trainer })),
    );
  });

  it('exposes a budget for a bare week without blowing up', () => {
    const rows = budgetWeek(
      SYNTHETIC_PROFILE,
      {
        trainer: {},
        prehab: {},
        conditioning: {},
        hardConditioningMinutes: 0,
        week: 1,
        indicatorMuscles: new Set<Muscle>(),
      },
    );
    expect(rows).toHaveLength(ALL_MUSCLES.length);
    for (const row of rows) expect(row.sets).toBeGreaterThanOrEqual(0);
  });

  it('declares four ordered app-session roles without a personal schedule', () => {
    expect(WEEK_SKELETON.map((d) => d.day)).toEqual([1, 2, 3, 4]);
  });
});

describe('the prior stands until something is confirmed (§2.2)', () => {
  it('never treats an unreported trainer week as zero volume', () => {
    const prior = expectedTrainerWeek(SYNTHETIC_PROFILE);
    expect(prior.upper_back?.stimulusUpperBound ?? 0).toBeGreaterThan(0);
    expect(prior.glutes?.stimulusUpperBound ?? 0).toBeGreaterThan(0);
    expect(prior.lats?.stimulusUpperBound ?? 0).toBeGreaterThan(0);
  });

  it('produces the same zeros as three unconfirmed logged sessions', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer: expectedTrainerWeek(SYNTHETIC_PROFILE) });
    for (const muscle of ['upper_back', 'lats', 'glutes', 'hamstrings'] as const) {
      expect(budgetFor(plan, muscle).sets, muscle).toBe(0);
    }
  });

  it('prices the trainer’s sled work as concentric-only on the fatigue ledger', () => {
    const prior = expectedTrainerWeek(SYNTHETIC_PROFILE);
    expect(prior.quads?.fatigueUpperBound ?? 0).toBeLessThan(
      prior.quads?.stimulusUpperBound ?? 0,
    );
  });

  it('is empty only when there is genuinely no trainer', () => {
    expect(expectedTrainerWeek({ ...SYNTHETIC_PROFILE, trainerDays: [] })).toEqual({});
  });

  it('narrows as confidence rises', () => {
    const seed = expectedTrainerWeek(SYNTHETIC_PROFILE);
    const confident = expectedTrainerWeek(SYNTHETIC_PROFILE, { confidence: 0.9 });
    expect(confident.upper_back?.stimulusUpperBound ?? 0).toBeLessThan(
      seed.upper_back?.stimulusUpperBound ?? 0,
    );
  });
});

describe('fitting the session into the time available', () => {
  it('lands lifting days inside the athlete’s session length', () => {
    for (let w = 1; w <= 4; w += 1) {
      for (const day of generateWeek(SYNTHETIC_PROFILE, { week: w, trainer }).days) {
        if (day.kind !== 'lift') continue;
        expect(day.estimatedSeconds / 60, `wk${w} d${day.day}`).toBeLessThanOrEqual(
          SESSION_TIME.targetMinutes + 1,
        );
      }
    }
  });

  it('honours a shorter session by cutting exercises, never rest', () => {
    const short = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 35 });
    const long = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 75 });

    const monday = (plan: WeekPlan) => plan.days.find((d) => d.day === 1);
    expect(monday(short)?.items.length ?? 0).toBeLessThan(monday(long)?.items.length ?? 0);
    expect(monday(short)?.trimmed.length ?? 0).toBeGreaterThan(0);

    // The rest prescribed for a movement is identical at both lengths.
    for (const item of monday(short)?.items ?? []) {
      const same = monday(long)?.items.find((i) => i.slug === item.slug);
      expect(same?.restSeconds, item.slug).toBe(item.restSeconds);
    }
  });

  it('never prescribes under two minutes of rest on the main compound work', () => {
    for (const minutes of [30, 40, 55, 75]) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: minutes });
      for (const day of plan.days) {
        for (const item of day.items) {
          if (item.role !== 'indicator' && item.role !== 'main') continue;
          expect(item.restSeconds, `${item.slug} @ ${minutes}min`).toBeGreaterThanOrEqual(
            SESSION_TIME.protectedRestSeconds,
          );
        }
      }
    }
  });

  it('drops accessories before prehab, whatever the clock says', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 25 });
    for (const day of plan.days) {
      for (const cut of day.trimmed) {
        const original = WEEK_SKELETON.flatMap((d) => d.slots).find((s) => s.slug === cut.slug);
        expect(original?.role, cut.slug).not.toBe('prehab');
        expect(original?.role, cut.slug).not.toBe('mobility');
      }
    }
    // Every prehab movement is still there.
    for (const slug of ['patrick-step', 'atg-split-squat', 'assisted-nordic-curl', 'face-pull']) {
      expect(setsOf(plan, slug), slug).toBeGreaterThan(0);
    }
  });

  it('never drops an indicator lift for time', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 25 });
    for (const slug of SYNTHETIC_PROFILE.indicatorLifts) {
      const trimmedNames = plan.days.flatMap((d) => d.trimmed).map((t) => t.slug);
      expect(trimmedNames, slug).not.toContain(slug);
    }
  });

  it('never drops the protected interval session or the warm-up', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer, sessionMinutes: 25 });
    expect(setsOf(plan, 'assault-bike-intervals')).toBeGreaterThan(0);
    expect(setsOf(plan, 'zone2-cycling')).toBeGreaterThan(0);
  });

  it('never trims the Sunday Zone 2 dose', () => {
    for (const minutes of [25, 55]) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week: 1, trainer, sessionMinutes: minutes });
      const sunday = plan.days.find((d) => d.day === 0);
      expect(sunday?.trimmed).toEqual([]);
      expect(sunday?.items.some((i) => i.slug === 'zone2-incline-walk')).toBe(true);
    }
  });

  it('supersets only movements that share no muscle', () => {
    for (const day of week3.days) {
      for (const pair of day.supersets) {
        const [a, b] = pair.map((slug) => day.items.find((i) => i.slug === slug));
        expect(a, pair[0]).toBeDefined();
        expect(b, pair[1]).toBeDefined();
        const shared = Object.keys(a?.charges ?? {}).filter((m) => m in (b?.charges ?? {}));
        expect(shared, pair.join(' + ')).toEqual([]);
      }
    }
  });

  it('never leaves a superset pointing at a dropped movement', () => {
    for (const minutes of [25, 35, 55]) {
      const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: minutes });
      for (const day of plan.days) {
        const present = new Set(day.items.map((i) => i.slug));
        for (const pair of day.supersets) {
          expect(pair.length).toBeGreaterThanOrEqual(2);
          for (const slug of pair) expect(present.has(slug), slug).toBe(true);
        }
      }
    }
  });

  it('says what it cut rather than concealing it', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 30 });
    expect(plan.findings.some((f) => f.code === 'plan.trimmed_for_time')).toBe(true);
    for (const day of plan.days) {
      for (const cut of day.trimmed) expect(cut.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports the load-not-sets consequence when the clock binds', () => {
    const plan = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 30 });
    const finding = plan.findings.find((f) => f.code === 'plan.time_capped');
    expect(finding?.message).toContain('longer session, not a shorter rest');
  });

  it('gives back volume when the athlete has time for it', () => {
    const short = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 40 });
    const long = generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, sessionMinutes: 80 });
    const sets = (p: WeekPlan) =>
      p.days.reduce((n, d) => n + d.items.reduce((m, i) => m + i.sets, 0), 0);
    expect(sets(long)).toBeGreaterThan(sets(short));
  });
});

describe('pace learning', () => {
  it('falls back to the prior with nothing to go on', () => {
    expect(estimatePace([])).toEqual(DEFAULT_PACE);
  });

  it('notices an athlete who rests longer than the card says', () => {
    const pace = estimatePace([
      { elapsedSeconds: 3600, sets: 20, reps: 200, timedSeconds: 0, actualRestSeconds: 2400 },
    ]);
    expect(pace.restFactor).toBeGreaterThan(1);
    expect(pace.samples).toBe(1);
  });

  it('clamps a wild sample rather than believing it', () => {
    const pace = estimatePace([
      { elapsedSeconds: 40000, sets: 4, reps: 40, timedSeconds: 0, actualRestSeconds: 300 },
    ]);
    expect(pace.restFactor).toBeLessThanOrEqual(2);
    expect(pace.secondsPerRep).toBeLessThanOrEqual(6);
  });

  it('plans fewer sets for someone who is genuinely slower', () => {
    const slow = { secondsPerRep: 5, restFactor: 1.6, samples: 6 };
    const fast = { secondsPerRep: 2.5, restFactor: 0.8, samples: 6 };
    const sets = (pace: typeof slow) =>
      generateWeek(SYNTHETIC_PROFILE, { week: 3, trainer, pace }).days.reduce(
        (n, d) => n + d.items.reduce((m, i) => m + i.sets, 0),
        0,
      );
    expect(sets(slow)).toBeLessThan(sets(fast));
  });
});

describe('gym filtering', () => {
  it('takes a per-slug availability predicate over the flat tag list', () => {
    const noCables = generateWeek(SYNTHETIC_PROFILE, {
      week: 1,
      trainer,
      canPerform: (slug) => (exerciseBySlug(slug)?.equipment ?? []).every((e) => e !== 'cable'),
    });
    expect(slugsInPlan(noCables)).not.toContain('cable-lateral-raise');
    expect(slugsInPlan(noCables)).not.toContain('cable-crunch');
  });

  it('still produces a coherent week at a bodyweight-only location', () => {
    const bare = generateWeek(SYNTHETIC_PROFILE, {
      week: 1,
      trainer,
      canPerform: (slug) =>
        (exerciseBySlug(slug)?.equipment ?? []).some((e) => e === 'bodyweight' || e === 'wall'),
    });
    expect(bare.days.some((d) => d.items.length > 0)).toBe(true);
    for (const slug of slugsInPlan(bare)) {
      expect(exerciseBySlug(slug), slug).not.toBeNull();
    }
  });
});

describe('prescription is not the same thing as budget', () => {
  it('reports zero prescribed for a muscle the app has budget for but never programs', () => {
    // `neck` has headroom every week and no slot in the week spends it.
    expect(budgetFor(week1, 'neck').sets).toBeGreaterThan(0);
    expect(week1.prescribed.neck ?? 0).toBe(0);
  });

  it('matches the sum of what the days actually ask for', () => {
    for (const [muscle, value] of Object.entries(week3.prescribed) as [Muscle, number][]) {
      expect(value, muscle).toBeCloseTo(appCharge(week3, muscle), 5);
    }
  });

  it('never claims sets on a muscle nothing in the week trains', () => {
    const trained = new Set<Muscle>();
    for (const day of week1.days) {
      for (const item of day.items) {
        for (const muscle of Object.keys(item.charges) as Muscle[]) trained.add(muscle);
      }
    }
    for (const muscle of Object.keys(week1.prescribed) as Muscle[]) {
      expect(trained.has(muscle), muscle).toBe(true);
    }
  });
});
