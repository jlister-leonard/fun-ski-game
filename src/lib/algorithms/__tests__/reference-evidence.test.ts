import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS, validateTargets } from '../guardrails';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(`${root}${relativePath}`, 'utf8')) as T;

interface LabEvidenceCatalogue {
  version: string;
  about: {
    criticalPolicy: string;
    biologicalVariationSnapshot: {
      retrievedOn: string;
      snapshotCounts: { metaCalculations: number; bvSpecifications: number; references: number };
    };
  };
  analytes: Record<string, { biologicalVariation: Record<string, unknown> }>;
}

interface MedicationEvidence {
  policy: { neverSuppressesCritical: string };
  evidenceReview: { boundary: string };
}

interface EvidenceFood {
  id: string;
  source: string;
  per100g: { satfat_g: number };
}

describe('reference evidence provenance', () => {
  it('records the dated EFLM snapshot while distinguishing assumed assay variation', () => {
    const catalogue = readJson<LabEvidenceCatalogue>('docs/kg/specs/lab-panels.json');
    const snapshot = catalogue.about.biologicalVariationSnapshot;
    const creatinine = catalogue.analytes.creatinine.biologicalVariation;

    expect(catalogue.version).toBe('1.2.0');
    expect(snapshot).toMatchObject({
      retrievedOn: '2026-08-01',
      snapshotCounts: {
        metaCalculations: 191,
        bvSpecifications: 3366,
        references: 607,
      },
    });
    expect(creatinine).toMatchObject({
      cvi: 4.3864,
      provenance: 'verified',
      cvaProvenance: 'assumed',
      reviewedOn: '2026-08-01',
      sourceRecordUpdatedAt: '2026-05-06T10:47:57.307Z',
    });
  });

  it('keeps critical thresholds explicitly blocked on external clinician review', () => {
    const catalogue = readJson<LabEvidenceCatalogue>('docs/kg/specs/lab-panels.json');
    const medication = readJson<MedicationEvidence>('docs/kg/specs/medication-effects.json');

    expect(catalogue.about.criticalPolicy).toContain('NEEDS CLINICIAN REVIEW BEFORE SHIP');
    expect(medication.policy.neverSuppressesCritical).toContain('may suppress a critical-value prompt');
    expect(medication.evidenceReview.boundary).toContain('not clinician review');
  });

  it('preserves dated USDA provenance for the audited common-staple cohort', () => {
    const paths = ['grain', 'dairy', 'egg', 'poultry', 'fruit', 'seafood'];
    const foods = paths.flatMap((name) => readJson<EvidenceFood[]>(`src/data/foods/json/${name}.json`));
    const expected: Record<string, string> = {
      'rice-white-long-cooked': '168878',
      'milk-whole': '171265',
      'egg-whole-raw': '171287',
      'chicken-breast-cooked': '171477',
      'apple-raw': '171688',
      'banana-raw': '173944',
      'salmon-atlantic-farmed-cooked': '175168',
    };

    for (const [id, fdcId] of Object.entries(expected)) {
      const food = foods.find((candidate) => candidate.id === id);
      expect(food?.source).toContain(`FDC ${fdcId}`);
      expect(food?.source).toContain('release 2018-04, reviewed 2026-08-01');
    }
    expect(foods.find((food) => food.id === 'salmon-atlantic-farmed-cooked')?.per100g.satfat_g).toBe(2.4);
  });
});

describe('source-supported safety copy', () => {
  it('treats energy availability as a caution continuum, not a diagnosis', () => {
    expect(LIMITS.ENERGY_AVAILABILITY).toEqual({ reference: 45, caution: 30 });
    const finding = validateTargets(
      { kcal: 2500, proteinG: 160, carbG: 300, fatG: 70, targetRatePctBwPerWeek: 0 },
      {
        profile: {
          sex: 'male',
          ageYears: 30,
          heightCm: 180,
          bodyweightKg: 80,
          bodyFatPct: 20,
          goal: 'maintain',
        },
        exerciseKcalPerDay: 700,
      },
    ).find((candidate) => candidate.code === 'ENERGY_AVAILABILITY_LOW');

    expect(finding?.message).toContain('conservative app caution line');
    expect(finding?.message).toContain('continuum');
    expect(finding?.message).toContain('cannot diagnose REDs');
  });

  it('does not promise that cystatin C alone settles a creatinine result', () => {
    const files = [
      'src/lib/algorithms/medication-interactions.ts',
      'docs/kg/specs/algorithms/medication-interactions.ts',
      'docs/kg/specs/medication-effects.json',
      'docs/kg/specs/integration-health-records.md',
    ].map((path) => readFileSync(`${root}${path}`, 'utf8')).join('\n');

    expect(files).not.toMatch(/cystatin C[^\n]{0,80}settles/i);
    expect(files).not.toContain('unaffected by muscle mass or creatine intake');
    expect(files).toContain('combined creatinine-cystatin C');
  });
});
