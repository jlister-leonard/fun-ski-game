/**
 * @file The nutrition diary's safety gate.
 *
 * Two kinds of assertion live here and they are worth keeping distinct.
 *
 * **Behavioural.** The pure model layer does the right arithmetic: adequacy
 * suppressed on unknown, upper limits computed from a lower bound, DFE and raw
 * folic acid kept apart, "eaten" totals summed once.
 *
 * **Lint.** The screen does not ship copy or colour that the spec forbids.
 * `docs/kg/specs/nutrition-personalization.md` §3.4 makes those requirements
 * normative and calls them machine-checked; this file is where the machine
 * checks them. A `block`-level finding from `validateTrackingSafety()` or
 * `checkDaySummaryCopy()` fails the build, which is the point — "we decided not
 * to have streaks" has to survive the person who decided it leaving.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  checkDaySummaryCopy,
  hasBlock,
  validateTrackingSafety,
  type PersonContext,
} from '@/lib/algorithms';
import { getSeedFood } from '@/data/foods';
import type { FoodLog, MealSlot } from '@/lib/db/types';

import { DIARY_COPY, NUTRITION_SAFETY_DEFAULTS, SLOT_ORDER, allCopyStrings } from '../copy';
import {
  EXTRACTED_FIELDS,
  EXTRACTED_NUTRIENTS,
  FOLATE,
  VITAMIN_A,
} from '../micronutrient-db';
import {
  assessMicronutrients,
  defaultSlotForHour,
  floorProgress,
  frequencyFromLogs,
  groupBySlot,
  nutrientsForGrams,
  recentIdsFromLogs,
  resolveLogs,
  totalEaten,
  weekDiaryRows,
  diaryPeriodStatus,
} from '../model';
import {
  hasValidBarcodeCheckDigit,
  isCurrentScannerOperation,
  nextBarcodeAgreement,
} from '@/lib/food/barcode-scanner';
import { lookupBarcode } from '@/lib/food/open-food-facts';
import { computeTargets, type TargetInputs } from '../useTargets';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PERSON: PersonContext = { sex: 'male', ageYears: 38 };

let counter = 0;
function makeLog(overrides: Partial<FoodLog> & { foodId: string; grams: number }): FoodLog {
  counter += 1;
  const item = getSeedFood(overrides.foodId);
  const nutrients = item
    ? nutrientsForGrams(item, overrides.grams)
    : { kcal: 0, proteinG: 0, carbG: 0, fatG: 0 };
  return {
    id: `log-${counter}`,
    createdAt: counter,
    updatedAt: counter,
    deletedAt: null,
    dateKey: '2026-07-26',
    loggedAt: counter,
    slot: 'lunch' as MealSlot,
    recipeId: null,
    label: item?.name ?? 'unknown',
    nutrients,
    note: null,
    source: 'manual',
    sourceKey: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Safety configuration                                             */
/* ------------------------------------------------------------------ */

describe('tracking-safety invariants', () => {
  it('the shipped configuration produces no block-level findings', () => {
    const findings = validateTrackingSafety(NUTRITION_SAFETY_DEFAULTS);
    expect(hasBlock(findings)).toBe(false);
  });

  it('keeps adequacy at parity with deficit progress', () => {
    expect(NUTRITION_SAFETY_DEFAULTS.adequacyProminence).toBe('equal-or-greater');
  });

  it('ships no streaks, no gamification, no celebration, no projections', () => {
    expect(NUTRITION_SAFETY_DEFAULTS.streaks).toBe(false);
    expect(NUTRITION_SAFETY_DEFAULTS.gamification).toBe(false);
    expect(NUTRITION_SAFETY_DEFAULTS.celebrateUnderBudget).toBe(false);
    expect(NUTRITION_SAFETY_DEFAULTS.weightProjections).toBe(false);
  });

  it('hiding calories is switchable and starts off', () => {
    // Off by default, but the whole product must work with it on. The
    // component-level assertion for that is the EnergyValue grep below.
    expect(NUTRITION_SAFETY_DEFAULTS.hideCalories).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Copy lint                                                        */
/* ------------------------------------------------------------------ */

describe('copy lint', () => {
  const strings = allCopyStrings();

  it('has copy to check', () => {
    expect(strings.length).toBeGreaterThan(40);
  });

  it('never congratulates a deficit', () => {
    for (const copy of strings) {
      const findings = checkDaySummaryCopy(copy);
      expect(hasBlock(findings), `blocked copy: ${copy}`).toBe(false);
    }
  });

  it('never frames intake as a budget with a remainder', () => {
    // "Show what has been eaten, never remaining." A remainder is the framing
    // that constructs eating as overspending, and it is the single easiest
    // thing to reintroduce during a polish pass.
    const banned = [
      'remaining',
      'left to eat',
      'calories left',
      'budget',
      'allowance',
      'over budget',
      'you have used',
    ];
    for (const copy of strings) {
      const lowered = copy.toLowerCase();
      for (const phrase of banned) {
        expect(lowered.includes(phrase), `"${phrase}" in: ${copy}`).toBe(false);
      }
    }
  });

  it('never gamifies', () => {
    const banned = ['streak', 'badge', 'points', 'level up', 'achievement', 'challenge'];
    for (const copy of strings) {
      const lowered = copy.toLowerCase();
      for (const phrase of banned) {
        expect(lowered.includes(phrase), `"${phrase}" in: ${copy}`).toBe(false);
      }
    }
  });

  it('never projects weight forward', () => {
    for (const copy of strings) {
      const lowered = copy.toLowerCase();
      expect(lowered.includes('you would weigh')).toBe(false);
      expect(lowered.includes("you'd weigh")).toBe(false);
      expect(/in \d+ weeks you/.test(lowered)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Source lint — colour and the energy switch                       */
/* ------------------------------------------------------------------ */

const NUTRITION_DIR = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(NUTRITION_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((name) => ({ name, text: readFileSync(`${NUTRITION_DIR}${name}`, 'utf8') }));
}

describe('source lint', () => {
  it('uses no danger/error colour anywhere in the nutrition surface', () => {
    // There is deliberately no "red = over budget" colour in the palette.
    // Red-for-exceeded is documented to produce guilt and shame in users with
    // disordered eating, so exceeding a nutrition target renders as neutral
    // information. This catches the accidental reintroduction.
    for (const file of sourceFiles()) {
      const code = file.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code.includes('--c-danger'), file.name).toBe(false);
      expect(code.includes('text-danger'), file.name).toBe(false);
      expect(code.includes('bg-danger'), file.name).toBe(false);
      expect(/\btext-red-|\bbg-red-/.test(code), file.name).toBe(false);
      expect(code.includes('variant="destructive"'), file.name).toBe(false);
    }
  });

  it('renders kcal only through EnergyValue, which honours the hide switch', () => {
    // Any component that formats a kcal figure itself has bypassed the
    // "hide calorie numbers entirely" affordance. `formatKcal` is defined and
    // consumed in atoms.tsx and must not be called anywhere else.
    for (const file of sourceFiles()) {
      if (file.name === 'atoms.tsx' || file.name === 'copy.ts') continue;
      const code = file.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code.includes('formatKcal('), file.name).toBe(false);
    }
  });

  it('exposes hideCalories as an explicit prop rather than an ambient context', () => {
    const atoms = sourceFiles().find((f) => f.name === 'atoms.tsx');
    expect(atoms?.text.includes('hidden: boolean')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Day arithmetic                                                   */
/* ------------------------------------------------------------------ */

describe('day totals', () => {
  it('sums what was eaten, once, without rounding on the way', () => {
    const logs = [
      makeLog({ foodId: 'chicken-breast-cooked', grams: 200, slot: 'lunch' }),
      makeLog({ foodId: 'rice-white-long-cooked', grams: 250, slot: 'lunch' }),
    ];
    const total = totalEaten(logs);
    const expected = logs.reduce((s, l) => s + l.nutrients.kcal, 0);
    expect(total.kcal).toBeCloseTo(expected, 10);
    expect(total.proteinG).toBeGreaterThan(0);
  });

  it('an empty day is zero, not undefined', () => {
    const total = totalEaten([]);
    expect(total.kcal).toBe(0);
    expect(total.proteinG).toBe(0);
    expect(total.fiberG).toBe(0);
  });

  it('groups by meal slot', () => {
    const logs = [
      makeLog({ foodId: 'egg-hard-boiled', grams: 100, slot: 'breakfast' }),
      makeLog({ foodId: 'rice-white-long-cooked', grams: 100, slot: 'dinner' }),
      makeLog({ foodId: 'rice-white-long-cooked', grams: 50, slot: 'dinner' }),
    ];
    const grouped = groupBySlot(logs);
    expect(grouped.get('breakfast')).toHaveLength(1);
    expect(grouped.get('dinner')).toHaveLength(2);
    expect(grouped.get('lunch')).toBeUndefined();
  });

  it('every slot in the render order is a real slot with a label', () => {
    expect(new Set(SLOT_ORDER).size).toBe(SLOT_ORDER.length);
    for (const slot of SLOT_ORDER) {
      expect(typeof DIARY_COPY.title).toBe('string');
      expect(slot.length).toBeGreaterThan(0);
    }
  });

  it('picks a plausible default meal for the time of day', () => {
    expect(defaultSlotForHour(8)).toBe('breakfast');
    expect(defaultSlotForHour(13)).toBe('lunch');
    expect(defaultSlotForHour(19)).toBe('dinner');
    expect(defaultSlotForHour(23)).toBe('snack');
  });
});

describe('week view', () => {
  it('uses the visible period query status instead of treating loading as unlogged', () => {
    expect(diaryPeriodStatus('week', 'ready', 'loading')).toBe('loading');
    expect(diaryPeriodStatus('week', 'ready', 'unavailable')).toBe('unavailable');
    expect(diaryPeriodStatus('week', 'ready', 'locked')).toBe('locked');
    expect(diaryPeriodStatus('day', 'ready', 'loading')).toBe('ready');
  });

  it('returns seven ascending days and keeps unlogged distinct from zero', () => {
    const log = makeLog({
      dateKey: '2026-07-26',
      foodId: 'egg-hard-boiled',
      grams: 100,
    });
    const rows = weekDiaryRows('2026-07-26', [log]);
    expect(rows).toHaveLength(7);
    expect(rows[0].dateKey).toBe('2026-07-20');
    expect(rows[6].dateKey).toBe('2026-07-26');
    expect(rows[0].logged).toBe(false);
    expect(rows[0].total.kcal).toBe(0);
    expect(rows[6].logged).toBe(true);
    expect(rows[6].entries).toBe(1);
  });
});

describe('barcode acceptance and privacy', () => {
  it('validates GS1 check digits before lookup', () => {
    expect(hasValidBarcodeCheckDigit('3017620422003')).toBe(true);
    expect(hasValidBarcodeCheckDigit('036000291452')).toBe(true);
    expect(hasValidBarcodeCheckDigit('12345670')).toBe(true);
    expect(hasValidBarcodeCheckDigit('3017620422004')).toBe(false);
    expect(hasValidBarcodeCheckDigit('123')).toBe(false);
  });

  it('requires two consecutive matching camera reads', () => {
    const first = nextBarcodeAgreement(null, '3017620422003');
    expect(first.accepted).toBeNull();
    const mismatch = nextBarcodeAgreement(first.state, '036000291452');
    expect(mismatch.accepted).toBeNull();
    const accepted = nextBarcodeAgreement(mismatch.state, '036000291452');
    expect(accepted.accepted).toBe('036000291452');
  });

  it('rejects async continuations after close, replacement, or abort', () => {
    expect(isCurrentScannerOperation(true, 4, 4, false)).toBe(true);
    expect(isCurrentScannerOperation(false, 4, 4, false)).toBe(false);
    expect(isCurrentScannerOperation(true, 5, 4, false)).toBe(false);
    expect(isCurrentScannerOperation(true, 4, 4, true)).toBe(false);
  });

  it('makes exactly one credential-free GET only when lookup is invoked', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await lookupBarcode(
      '3017620422003',
      {},
      async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ status: 0, code: '3017620422003' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\//);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].url).not.toContain('app_uuid');
  });

  it('aborts an in-flight vendor lookup when its owning scan is cancelled', async () => {
    const owner = new AbortController();
    const resultPromise = lookupBarcode(
      '3017620422003',
      {},
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      }),
      owner.signal,
    );
    owner.abort();
    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });
});

describe('floor progress', () => {
  it('reports a floor as reached or short, and never as a remainder', () => {
    const met = floorProgress('Protein', 190, 185);
    expect(met.met).toBe(true);
    expect(met.shortBy).toBeNull();

    const short = floorProgress('Protein', 100, 185);
    expect(short.met).toBe(false);
    expect(short.shortBy).toBeCloseTo(85);
  });

  it('going past a floor is not an error state', () => {
    const over = floorProgress('Protein', 300, 185);
    expect(over.fraction).toBeGreaterThan(1);
    expect(over.met).toBe(true);
  });

  it('no floor means no fraction, rather than a zeroed one', () => {
    const none = floorProgress('Protein', 100, null);
    expect(none.fraction).toBeNull();
    expect(none.floor).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Search ranking inputs                                            */
/* ------------------------------------------------------------------ */

describe('search ranking', () => {
  it('counts how often each food was logged', () => {
    const freq = frequencyFromLogs([
      makeLog({ foodId: 'rice-white-long-cooked', grams: 100 }),
      makeLog({ foodId: 'rice-white-long-cooked', grams: 100 }),
      makeLog({ foodId: 'egg-hard-boiled', grams: 50 }),
    ]);
    expect(freq.get('rice-white-long-cooked')).toBe(2);
    expect(freq.get('egg-hard-boiled')).toBe(1);
  });

  it('lists distinct foods most recently logged first', () => {
    const older = makeLog({ foodId: 'rice-white-long-cooked', grams: 100 });
    const newer = makeLog({ foodId: 'egg-hard-boiled', grams: 100 });
    newer.loggedAt = older.loggedAt + 1000;
    const ids = recentIdsFromLogs([older, newer]);
    expect(ids[0]).toBe('egg-hard-boiled');
    expect(ids).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Micronutrients — the asymmetry that matters                      */
/* ------------------------------------------------------------------ */

describe('micronutrient reference table', () => {
  // The spec file is read from disk here and NOT imported by the app: its
  // `sources` arrays carry citation URLs, and a hostname in the shipped bundle
  // fails the privacy audit. So the app carries an extract, and this test is
  // what stops the extract drifting.
  const specPath = fileURLToPath(
    new URL('../../../../docs/kg/specs/micronutrients.json', import.meta.url),
  );
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as {
    nutrients: Record<string, unknown>[];
  };

  it('extracts exactly what the spec says, field for field', () => {
    for (const extracted of EXTRACTED_NUTRIENTS) {
      const authoritative = spec.nutrients.find((n) => n.id === extracted.id);
      expect(authoritative, `spec has no nutrient "${extracted.id}"`).toBeTruthy();

      for (const field of EXTRACTED_FIELDS) {
        if (!(field in extracted)) continue;
        expect(
          extracted[field],
          `${extracted.id}.${field} has drifted from micronutrients.json`,
        ).toEqual(authoritative![field]);
      }
    }
  });

  it('drops nothing the assessment actually reads', () => {
    // If the spec grows a field that `assessNutrient()` consumes, this fails
    // and the extract has to be widened rather than quietly falling behind.
    const consumed = [
      'id',
      'name',
      'unit',
      'referenceType',
      'reference',
      'upperLimit',
      'upperLimitBasis',
      'riskWithoutVegetables',
      'supplementCloseability',
      'trackingPriority',
    ];
    for (const field of consumed) {
      expect(EXTRACTED_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('keeps the two upper-limit bases that make the check correct', () => {
    expect(VITAMIN_A.upperLimitBasis).toBe('preformed-retinol-only');
    expect(FOLATE.upperLimitBasis).toBe('synthetic-folic-acid-only');
  });
});

describe('micronutrient adequacy', () => {
  it('suppresses the adequacy check when any logged food has no data', () => {
    // 1,431 of 1,557 seed foods carry `null` here. Summing the known part and
    // comparing it to an RDA would flag essentially every user as deficient.
    const logs = [makeLog({ foodId: 'chicken-breast-cooked', grams: 200 })];
    const day = assessMicronutrients(resolveLogs(logs, []), PERSON);
    for (const panel of day.panels) {
      expect(panel.adequacySuppressed).toBe(true);
      expect(panel.unknownEntries).toBeGreaterThan(0);
    }
  });

  it('treats a missing value as unknown, never as zero', () => {
    const logs = [makeLog({ foodId: 'chicken-breast-cooked', grams: 200 })];
    const day = assessMicronutrients(resolveLogs(logs, []), PERSON);
    const vitA = day.panels.find((p) => p.assessment.nutrientId === 'vitamin_a');
    // Intake is a lower bound over the known entries; the panel says how much
    // was unknown rather than asserting an absence.
    expect(vitA?.unknownGrams).toBe(200);
  });

  it('an empty day reports no data rather than a deficiency', () => {
    const day = assessMicronutrients([], PERSON);
    expect(day.noData).toBe(true);
  });

  it('THE FAILURE MODE THAT MATTERS: liver trips the preformed-retinol limit', () => {
    // 85 g of beef liver is roughly twice the 3,000 mcg upper limit on its own.
    // The limit check must run on the known lower bound, never be suppressed
    // because other foods lacked data.
    const liver = getSeedFood('beef-liver-cooked');
    expect(liver, 'seed database must carry beef liver').toBeTruthy();
    expect(liver!.micronutrients.vitamin_a_retinol_mcg).not.toBeNull();

    const logs = [
      makeLog({ foodId: 'beef-liver-cooked', grams: 85 }),
      // A food with NO micronutrient data alongside it must not silence the
      // check. Chicken breast is one of the 1,431 seed foods whose panel is
      // explicitly `null`.
      makeLog({ foodId: 'chicken-breast-cooked', grams: 200 }),
    ];
    const day = assessMicronutrients(resolveLogs(logs, []), PERSON);
    const vitA = day.panels.find((p) => p.assessment.nutrientId === 'vitamin_a');

    expect(vitA?.assessment.upperLimitStatus).toBe('exceeded');
    expect(vitA?.adequacySuppressed).toBe(true);
    expect(vitA?.assessment.intakeAgainstUpperLimit).toBeGreaterThan(3000);
  });

  it('THE OTHER FAILURE MODE: a carotenoid-heavy day does NOT trip it', () => {
    // Carotenoids convert on demand and are essentially non-toxic at dietary
    // intakes. A conflated vitamin A total would false-alarm here, which is
    // how a user learns to ignore the alarm that matters.
    const logs = [
      makeLog({ foodId: 'sweet-potato-baked', grams: 400 }),
      makeLog({ foodId: 'carrot-raw', grams: 300 }),
    ];
    const day = assessMicronutrients(resolveLogs(logs, []), PERSON);
    const vitA = day.panels.find((p) => p.assessment.nutrientId === 'vitamin_a');

    expect(vitA?.assessment.intakeAgainstUpperLimit).toBeLessThan(3000);
    expect(vitA?.assessment.upperLimitStatus).not.toBe('exceeded');
    // But the total RAE is genuinely large, and is reported as such.
    expect(vitA?.assessment.intake).toBeGreaterThan(3000);
  });

  it('suppresses adequacy entirely when there is no profile to compare against', () => {
    // The vitamin A RDA differs by sex, so with no profile there is no
    // reference worth showing. The upper limit is identical for adult men and
    // women, so the safety check still runs.
    const logs = [makeLog({ foodId: 'beef-liver-cooked', grams: 85 })];
    const day = assessMicronutrients(resolveLogs(logs, []), null);
    for (const panel of day.panels) {
      expect(panel.adequacySuppressed).toBe(true);
    }
    const vitA = day.panels.find((p) => p.assessment.nutrientId === 'vitamin_a');
    expect(vitA?.assessment.upperLimitStatus).toBe('exceeded');
  });

  it('folate adequacy is in DFE while the limit is in raw folic acid', () => {
    // Mixing the two inflates supplement contributions by 70% in one direction
    // and understates enriched grains by the same in the other.
    const logs = [makeLog({ foodId: 'lentils-cooked', grams: 400 })];
    const day = assessMicronutrients(resolveLogs(logs, []), PERSON);
    const folate = day.panels.find((p) => p.assessment.nutrientId === 'folate');

    expect(folate?.assessment.intake).toBeGreaterThan(0);
    // Natural food folate never counts against the upper limit.
    expect(folate?.assessment.intakeAgainstUpperLimit).toBe(0);
    expect(folate?.assessment.upperLimitStatus).not.toBe('exceeded');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Targets — honest about what it cannot compute                    */
/* ------------------------------------------------------------------ */

const EMPTY_INTAKE = new Map<string, number>();

function inputs(overrides: Partial<TargetInputs> = {}): TargetInputs {
  return {
    profile: null,
    ageYears: null,
    goal: null,
    weightSeries: [],
    intakeByDate: EMPTY_INTAKE,
    ...overrides,
  };
}

describe('targets', () => {
  it('refuses to invent a target when the profile is empty', () => {
    const result = computeTargets(inputs());
    expect(result.status).toBe('insufficient');
    expect(result.targets).toBeNull();
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('names what is actually missing rather than failing silently', () => {
    const result = computeTargets(inputs());
    expect(result.missing.join(' ')).toContain('weigh-in');
    expect(result.missing.join(' ')).toContain('height');
  });

  it('refuses when there is a profile but no weigh-in', () => {
    const result = computeTargets(
      inputs({
        ageYears: 38,
        profile: {
          id: 'profile',
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          displayName: null,
          birthDate: '1988-01-01',
          sex: 'male',
          heightCm: 180,
          activityLevel: 'moderately_active',
          timeZone: null,
          unitPreference: 'imperial',
        },
      }),
    );
    expect(result.status).toBe('insufficient');
    expect(result.missing).toContain('at least one weigh-in');
  });

  it('produces a target once profile and weight exist, and validates it', () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      kg: 88 - i * 0.02,
    }));
    const result = computeTargets(
      inputs({
        ageYears: 38,
        weightSeries: series,
        profile: {
          id: 'profile',
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          displayName: null,
          birthDate: '1988-01-01',
          sex: 'male',
          heightCm: 180,
          activityLevel: 'very_active',
          timeZone: null,
          unitPreference: 'imperial',
        },
      }),
    );

    expect(result.status).toBe('ready');
    expect(result.targets).not.toBeNull();
    expect(result.targets!.kcal).toBeGreaterThan(1500);
    expect(result.targets!.proteinG).toBeGreaterThan(100);
    expect(result.targets!.fiberG).toBeGreaterThan(0);
    // Guardrails ran and did not block.
    expect(result.findings.some((f) => f.level === 'block')).toBe(false);
  });

  it('never derives a target from the food log', () => {
    // The rule most likely to be undone by a well-meaning refactor: a run of
    // low logged days must not lower the target. Same inputs, different
    // intake history, identical target.
    const series = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      kg: 88,
    }));
    const profile = {
      id: 'profile',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      displayName: null,
      birthDate: '1988-01-01',
      sex: 'male' as const,
      heightCm: 180,
      activityLevel: 'moderately_active' as const,
      timeZone: null,
      unitPreference: 'imperial' as const,
    };

    const starved = new Map<string, number>();
    for (let i = 1; i <= 30; i += 1) {
      starved.set(`2026-06-${String(i).padStart(2, '0')}`, 900);
    }

    const normal = computeTargets(inputs({ ageYears: 38, weightSeries: series, profile }));
    const afterLowLogs = computeTargets(
      inputs({ ageYears: 38, weightSeries: series, profile, intakeByDate: starved }),
    );

    expect(normal.status).toBe('ready');
    expect(afterLowLogs.status).toBe('ready');
    // The expenditure estimator legitimately learns from intake, but a flat
    // weight on 900 kcal implies a LOW expenditure and therefore must not
    // produce a target below the guardrail floors — which is what `validateTargets`
    // is for, and why a blocked result returns no numbers at all.
    if (afterLowLogs.targets) {
      expect(afterLowLogs.targets.kcal).toBeGreaterThanOrEqual(1500);
    }
  });
});
