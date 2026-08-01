import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseAppleExport } from '../parse-export';
import { emptyBatch, type CanonicalBatch } from '../types';

/**
 * A minimal ZIP writer, so the parser can be exercised against a real archive
 * rather than against a mocked reader.
 *
 * Deflate-raw, no data descriptors, no ZIP64 — the smallest thing
 * `readZipDirectory` will accept. Building one here is ~40 lines and removes
 * the need for a binary fixture in the repo.
 */
function buildZip(files: readonly [string, string][]): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  /** Copy into a plain `ArrayBuffer`, which is what `BlobPart` insists on. */
  const bytes = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(source.byteLength);
    out.set(source);
    return out;
  };

  for (const [name, text] of files) {
    const nameBytes = bytes(new TextEncoder().encode(name));
    const raw = bytes(new TextEncoder().encode(text));
    const comp = bytes(deflateRawSync(raw));

    const lfh = new DataView(new ArrayBuffer(30));
    lfh.setUint32(0, 0x04034b50, true);
    lfh.setUint16(4, 20, true);
    lfh.setUint16(8, 8, true); // deflate
    lfh.setUint32(18, comp.length, true);
    lfh.setUint32(22, raw.length, true);
    lfh.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(lfh.buffer), nameBytes, comp);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + comp.length;
  }

  const dirBytes = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, dirBytes, true);
  eocd.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)]);
}

const EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ClinicalRecord)*)>
]>
<HealthData locale="en_US">
 <ExportDate value="2026-07-20 09:12:00 -0700"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-07-18 08:00:00 -0700" endDate="2026-07-18 08:05:00 -0700" value="1200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-07-18 09:00:00 -0700" endDate="2026-07-18 09:05:00 -0700" value="800"/>
 <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Watch" unit="Cal" startDate="2026-07-18 10:00:00 -0700" endDate="2026-07-18 10:30:00 -0700" value="150.5"/>
 <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="iPhone" unit="mi" startDate="2026-07-18 10:00:00 -0700" endDate="2026-07-18 10:30:00 -0700" value="2"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="lb" startDate="2026-07-18 06:30:00 -0700" endDate="2026-07-18 06:30:00 -0700" value="180.4"/>
 <Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="Scale" unit="%" startDate="2026-07-18 06:30:00 -0700" endDate="2026-07-18 06:30:00 -0700" value="0.184"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-07-17 23:00:00 -0700" endDate="2026-07-18 07:00:00 -0700"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-07-17 23:20:00 -0700" endDate="2026-07-18 05:00:00 -0700"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-07-18 05:00:00 -0700" endDate="2026-07-18 06:50:00 -0700"/>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2026-07-18 08:00:00 -0700" endDate="2026-07-18 08:00:00 -0700">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2026-07-18 08:00:00 -0700" endDate="2026-07-18 08:00:00 -0700" value="118"/>
 </Correlation>
 <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2026-07-18 08:00:00 -0700" endDate="2026-07-18 08:00:00 -0700" value="118"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="62.5" durationUnit="min" sourceName="Watch" startDate="2026-07-18 17:00:00 -0700" endDate="2026-07-18 18:02:30 -0700">
  <MetadataEntry key="HKIndoorWorkout" value="1"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="415.2" unit="Cal" startDate="2026-07-18 17:00:00 -0700" endDate="2026-07-18 18:02:30 -0700"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="131.4" minimum="88" maximum="171" unit="count/min" startDate="2026-07-18 17:00:00 -0700" endDate="2026-07-18 18:02:30 -0700"/>
 </Workout>
 <ClinicalRecord type="Observation" identifier="abc" sourceName="Sutter Health" sourceURL="https://example.invalid/x" fhirVersion="4.0.1" receivedDate="2026-01-02 05:01:22 -0800" resourceFilePath="/clinical-records/Observation-1.json"/>
 <ClinicalRecord type="Immunization" identifier="def" sourceName="Sutter Health" sourceURL="https://example.invalid/y" fhirVersion="4.0.1" receivedDate="2026-01-02 05:01:22 -0800" resourceFilePath="/clinical-records/Immunization-1.json"/>
</HealthData>
`;

const OBSERVATION = JSON.stringify({
  resourceType: 'Observation',
  status: 'final',
  effectiveDateTime: '2025-11-04T08:15:00Z',
  code: {
    text: 'Hemoglobin A1c',
    coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }],
  },
  valueQuantity: { value: 5.4, unit: '%', code: '%' },
});

/** A file that must never be opened. Parsing it would be a bug, not a feature. */
const CDA = '<ClinicalDocument>if this is read, the parser opened export_cda.xml</ClinicalDocument>';

function fixture(): Blob {
  return buildZip([
    ['apple_health_export/export.xml', EXPORT_XML],
    ['apple_health_export/export_cda.xml', CDA],
    ['apple_health_export/clinical-records/Observation-1.json', OBSERVATION],
    [
      'apple_health_export/clinical-records/Immunization-1.json',
      JSON.stringify({ resourceType: 'Immunization', status: 'completed' }),
    ],
  ]);
}

/** Run the parser and flatten every emitted batch into one. */
async function run(): Promise<{
  batch: CanonicalBatch;
  outcome: Awaited<ReturnType<typeof parseAppleExport>>;
  phases: string[];
}> {
  const batch = emptyBatch();
  const phases: string[] = [];
  const outcome = await parseAppleExport(fixture(), {
    onProgress: (progress) => {
      if (phases[phases.length - 1] !== progress.phase) phases.push(progress.phase);
    },
    onBatch: async (chunk) => {
      batch.metrics.push(...chunk.metrics);
      batch.sleep.push(...chunk.sleep);
      batch.activities.push(...chunk.activities);
      batch.weights.push(...chunk.weights);
      batch.labs.push(...chunk.labs);
      return Promise.resolve(
        chunk.metrics.length +
          chunk.sleep.length +
          chunk.activities.length +
          chunk.weights.length,
      );
    },
  });
  return { batch, outcome, phases };
}

describe('parseAppleExport', () => {
  it('reads the archive end to end', async () => {
    const { outcome, phases } = await run();
    expect(outcome.exportDate).toBe('2026-07-20 09:12:00 -0700');
    // Ten top-level records. The eleventh is the Correlation's child, which is
    // a duplicate of one of them and is never parsed, so it is never counted.
    expect(outcome.rawSamplesSeen).toBe(10);
    expect(phases[0]).toBe('reading-archive');
    expect(phases).toContain('scanning-records');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('converts every unit to SI, reading it off the record', async () => {
    const { batch } = await run();
    const byType = new Map(batch.metrics.map((m) => [m.type, m]));

    expect(byType.get('steps')!.value).toBe(2000);
    // `Cal` is Apple's spelling of kcal, not a gram-calorie.
    expect(byType.get('active_energy_kcal')!.value).toBeCloseTo(150.5, 3);
    // 2 miles, because this user's phone is in a US locale.
    expect(byType.get('distance_walking_running_m')!.value).toBeCloseTo(3218.688, 2);
    // 180.4 lb → kg.
    expect(batch.weights[0].kg).toBeCloseTo(81.83, 2);
    // 0.184 is a fraction, not 0.184%.
    expect(batch.weights[0].bodyFatPct).toBeCloseTo(18.4, 1);
  });

  it('counts a blood-pressure record once, not twice', async () => {
    // Apple's own DTD warns that Correlation children also appear at top level.
    const { outcome } = await run();
    expect(outcome.unmapped.BloodPressureSystolic).toBe(1);
  });

  it('prefers WorkoutStatistics over the legacy workout attributes', async () => {
    const { batch } = await run();
    expect(batch.activities).toHaveLength(1);
    const workout = batch.activities[0];
    expect(workout.activityType).toBe('traditional_strength_training');
    expect(workout.durationSec).toBe(3750);
    expect(workout.activeKcal).toBeCloseTo(415.2, 2);
    expect(workout.averageHeartRate).toBe(131);
    expect(workout.maxHeartRate).toBe(171);
  });

  it('stitches sleep into one night attributed to the wake day', async () => {
    const { batch } = await run();
    expect(batch.sleep).toHaveLength(1);
    const night = batch.sleep[0];
    expect(night.dateKey).toBe('2026-07-18');
    // 340 min core + 110 min deep. The 480-minute InBed span is not added.
    expect(night.asleepMin).toBe(450);
    expect(night.inBedMin).toBe(480);
    expect(night.stages.deepMin).toBe(110);
  });

  it('reads labs from clinical-records and skips resources it does not need', async () => {
    const { batch, outcome } = await run();
    expect(batch.labs).toHaveLength(1);
    expect(batch.labs[0].displayName).toBe('Hemoglobin A1c');
    expect(batch.labs[0].loinc).toBe('4548-4');
    expect(batch.labs[0].rawValue).toBe(5.4);
    expect(batch.labs[0].provider).toBe('Sutter Health');
    // Only the Observation was opened; the Immunization was skipped via the
    // <ClinicalRecord> index without reading its JSON.
    expect(outcome.clinicalFilesRead).toBe(1);
    expect(outcome.providers).toEqual([
      { provider: 'Sutter Health', count: 1, from: '2025-11-04', to: '2025-11-04' },
    ]);
  });

  it('reports the date range it actually covered', async () => {
    const { outcome } = await run();
    expect(outcome.dateRange).toEqual({ from: '2026-07-18', to: '2026-07-18' });
  });

  it('applies backpressure — it never runs ahead of the writer', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await parseAppleExport(fixture(), {
      onProgress: () => undefined,
      onBatch: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return 0;
      },
    });
    expect(maxInFlight).toBe(1);
  });

  it('refuses an archive with no export.xml, and says what to do', async () => {
    const notAnExport = buildZip([['readme.txt', 'hello']]);
    await expect(
      parseAppleExport(notAnExport, { onProgress: () => undefined, onBatch: async () => 0 }),
    ).rejects.toThrow(/export\.xml/);
  });

  it('refuses a file that is not a zip at all', async () => {
    const junk = new Blob(['this is not a zip archive, it is a sentence']);
    await expect(
      parseAppleExport(junk, { onProgress: () => undefined, onBatch: async () => 0 }),
    ).rejects.toThrow(/not a zip/i);
  });
});
