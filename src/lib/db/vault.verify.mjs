/**
 * Executable proof for the storage + unlock + backup layers (nodes V2/V3/V5/V6).
 *
 *   node src/lib/db/vault.verify.mjs
 *
 * Compiles the real TypeScript under `src/lib` and runs it against
 * `fake-indexeddb`, so the Dexie schema, the row codec, the repositories, the
 * lock flow and the `.hcvault` round trip are all exercised as shipped.
 *
 * Every assertion is real. A failure exits non-zero.
 */

import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const LIB = join(REPO, 'src/lib');
const OUT = join(REPO, 'node_modules/.cache/hcvault-verify');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
}
async function throws(name, fn, predicate) {
  try {
    await fn();
    ok(name, false, 'no error thrown');
  } catch (err) {
    ok(name, predicate(err), `${err?.constructor?.name}: ${err?.message}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

/** Match backup.ts's key-sorted JSON so tests can model signed-tool mistakes. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Re-authenticate a deliberately altered v2 file as an authorised buggy tool. */
async function retagV2(envelope, recoveryCode) {
  const body = { ...envelope };
  delete body.integrity;
  const opened = await C.unlockWithRecoveryCode(body.keyring, recoveryCode);
  try {
    const subtle = globalThis.crypto.subtle;
    const base = await subtle.importKey('raw', opened.rawDek, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('hcvault/backup-integrity/v2'),
      },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    const tag = await subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(canonicalJson(body)),
    );
    return {
      ...body,
      integrity: {
        algorithm: 'HMAC-SHA-256',
        tag: Buffer.from(tag).toString('base64url'),
      },
    };
  } finally {
    C.zeroBytes(opened.rawDek);
  }
}

/** Clone JSON data without retaining references to the source envelope. */
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Flip one base64url character while preserving a structurally valid string. */
function changeToken(value) {
  return (
    (value[0] === 'A' ? 'B' : 'A') +
    value.slice(1)
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('Compiling src/lib ...');
const t0 = Date.now();
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    '--module', 'commonjs',
    '--target', 'es2022',
    '--moduleResolution', 'node10',
    '--strict',
    '--esModuleInterop',
    '--skipLibCheck',
    '--resolveJsonModule',
    '--lib', 'es2022,dom',
    '--rootDir', LIB,
    '--outDir', OUT,
    ...['crypto', 'db', 'db/repos', 'vault'].flatMap((d) =>
      readdirSync(join(LIB, d))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(LIB, d, f)),
    ),
  ],
  { cwd: REPO, stdio: 'inherit', shell: false },
);
console.log(`Compiled in ${Date.now() - t0} ms\n`);

const require = createRequire(join(OUT, 'x.cjs'));

// Model two same-origin browser contexts without giving the proof harness a
// real network or persistent browser dependency. vault.ts installs its
// listener during import; a second instance below acts as the peer tab.
const HAD_WINDOW = Object.hasOwn(globalThis, 'window');
const ORIGINAL_WINDOW = globalThis.window;
const ORIGINAL_BROADCAST_CHANNEL = globalThis.BroadcastChannel;
class FakeBroadcastChannel {
  static byName = new Map();

  constructor(name) {
    this.name = name;
    this.listeners = new Set();
    const peers = FakeBroadcastChannel.byName.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.byName.set(name, peers);
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  postMessage(data) {
    for (const peer of FakeBroadcastChannel.byName.get(this.name) ?? []) {
      if (peer === this) continue;
      queueMicrotask(() => {
        for (const listener of peer.listeners) listener({ data });
      });
    }
  }

  close() {
    FakeBroadcastChannel.byName.get(this.name)?.delete(this);
  }
}
globalThis.window = {};
globalThis.BroadcastChannel = FakeBroadcastChannel;

const C = require(join(OUT, 'crypto/index.js'));
const V = require(join(OUT, 'vault/index.js'));
const DB = require(join(OUT, 'db/index.js'));
const R = require(join(OUT, 'db/repos/index.js'));

/** Cheap KDF so the suite runs in seconds; production is 600,000. */
const FAST = 1000;
const PASS = 'the correct horse battery staple';

// ---------------------------------------------------------------------------
section('1. Initialisation');
// ---------------------------------------------------------------------------
eq('a fresh device reports no vault', await V.isInitialized(), false);
await throws(
  'unlocking a non-existent vault fails cleanly',
  () => V.unlock(PASS),
  (e) => e.name === 'VaultNotInitializedError',
);

const init = await V.initializeVault(PASS, { iterations: FAST });
ok('initializeVault returns a vaultId', typeof init.vaultId === 'string' && init.vaultId.length > 0);
ok('a recovery code is issued by default', typeof init.recoveryCode === 'string');
eq('recovery code is 7 groups of 4', init.recoveryCode.split('-').length, 7);
eq('the vault is unlocked after setup', V.getState(), 'unlocked');
eq('the device now reports an initialised vault', await V.isInitialized(), true);

const status = await V.getStatus();
eq('two independent wrappings exist', status.wrappings.length, 2);
ok('a passphrase wrapping exists', status.wrappings.some((w) => w.method === 'passphrase'));
ok('a recovery-code wrapping exists', status.hasRecoveryCode);
ok('no passkey wrapping yet', !status.hasPasskey);

await throws(
  'initialising twice is refused',
  () => V.initializeVault('other', { iterations: FAST }),
  (e) => e.name === 'VaultAlreadyInitializedError',
);

// ---------------------------------------------------------------------------
section('2. Writing and reading through the repositories');
// ---------------------------------------------------------------------------
const SECRET_NOTE = 'weighed after the 10k, felt awful';
await R.weights.log({
  dateKey: '2026-07-20',
  kg: 82.4,
  measuredAt: Date.parse('2026-07-20T07:10:00Z'),
  bodyFatPct: 17.2,
  note: SECRET_NOTE,
  source: 'manual',
  sourceKey: null,
});
for (const [d, kg] of [
  ['2026-07-21', 82.1],
  ['2026-07-22', 82.6],
  ['2026-07-23', 81.9],
  ['2026-07-24', 81.7],
]) {
  await R.weights.log({
    dateKey: d,
    kg,
    measuredAt: Date.parse(`${d}T07:00:00Z`),
    bodyFatPct: null,
    note: null,
    source: 'apple-health',
    sourceKey: `apple-health:body-mass:${d}`,
  });
}

const series = await R.weights.getSeries('2026-07-01', '2026-07-31');
eq('five weigh-ins round-trip', series.length, 5);
eq('values survive encryption exactly', series[0].kg, 82.4);
eq('the series is ascending by date', series[4].date, '2026-07-24');

const latest = await R.weights.getLatest();
eq('getLatest returns the newest measurement', latest.kg, 81.7);
eq('the free-text note round-trips verbatim', (await R.weights.getForDate('2026-07-20'))[0].note, SECRET_NOTE);

const profile = await R.profiles.ensure();
eq('the profile singleton has a fixed id', profile.id, 'profile');
await R.profiles.save({ displayName: 'J', heightCm: 181, sex: 'male', birthDate: '1988-03-14' });
eq('singleton patches persist', (await R.profiles.load()).heightCm, 181);
ok('age is derived from the birth date', (await R.profiles.ageYears(new Date('2026-07-26'))) === 38);

// ---------------------------------------------------------------------------
section('3. What an attacker with the disk image actually sees');
// ---------------------------------------------------------------------------
{
  const rawRows = await DB.getDb().rows('weightEntries').toArray();
  eq('rows are present on disk', rawRows.length, 5);
  const asText = JSON.stringify(rawRows, (k, v) =>
    v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
  );
  ok('the note is nowhere in the raw rows', !asText.includes('felt awful'));
  ok('the weight value is nowhere in the raw rows', !asText.includes('82.4'));
  ok('the body-fat value is nowhere in the raw rows', !asText.includes('17.2'));
  ok('the plaintext sourceKey is nowhere in the raw rows', !asText.includes('apple-health:body-mass'));
  ok('dateKey IS visible (documented, deliberate)', asText.includes('2026-07-20'));
  ok('every row carries a 12-byte IV', rawRows.every((r) => r.iv.length === 12));
  eq('every IV is distinct', new Set(rawRows.map((r) => Buffer.from(r.iv).toString('hex'))).size, 5);
  ok(
    'sourceHash is an opaque 22-char token',
    rawRows.filter((r) => r.sourceHash).every((r) => /^[A-Za-z0-9_-]{22}$/.test(r.sourceHash)),
  );

  const meta = await DB.getDb().vaultMeta.toArray();
  const metaText = JSON.stringify(meta);
  ok('the keyring is stored in the clear (by design)', metaText.includes('wrappedKeys'));
  ok('the keyring contains no plaintext passphrase', !metaText.includes(PASS));
  ok('the keyring contains no plaintext recovery code', !metaText.includes(init.recoveryCode.replace(/-/g, '')));
}

// ---------------------------------------------------------------------------
section('4. Idempotent ingest');
// ---------------------------------------------------------------------------
{
  const before = await R.weights.count();
  await R.weights.log({
    dateKey: '2026-07-24',
    kg: 81.75,
    measuredAt: Date.parse('2026-07-24T07:00:00Z'),
    bodyFatPct: null,
    note: null,
    source: 'apple-health',
    sourceKey: 'apple-health:body-mass:2026-07-24',
  });
  eq('re-importing the same day does not duplicate', await R.weights.count(), before);
  eq('re-importing updates the value in place', (await R.weights.getForDate('2026-07-24'))[0].kg, 81.75);

  const metrics = [];
  for (let i = 1; i <= 30; i++) {
    const d = `2026-07-${String(i).padStart(2, '0')}`;
    metrics.push({
      type: 'resting_heart_rate',
      dateKey: d,
      value: 50 + (i % 5),
      startedAt: null,
      endedAt: null,
      aggregation: 'average',
      source: 'apple-health',
      sourceKey: `apple-health:rhr:${d}`,
    });
    metrics.push({
      type: 'steps',
      dateKey: d,
      value: 8000 + i * 37,
      startedAt: null,
      endedAt: null,
      aggregation: 'sum',
      source: 'apple-health',
      sourceKey: `apple-health:steps:${d}`,
    });
  }
  const first = await R.healthMetrics.ingest(metrics);
  eq('first ingest inserts 60 metrics', first.created, 60);
  const second = await R.healthMetrics.ingest(metrics);
  eq('replaying the identical batch inserts nothing', second.created, 0);
  eq('replaying the identical batch updates in place', second.updated, 60);
  eq('the table still holds 60 rows', await R.healthMetrics.count(), 60);

  const rhr = await R.healthMetrics.getSeries('resting_heart_rate', '2026-07-01', '2026-07-30');
  eq('the [type+dateKey] index returns only that metric', rhr.length, 30);
  eq('metric values round-trip', rhr[0].value, 51);
  const steps = await R.healthMetrics.getSeries('steps', '2026-07-10', '2026-07-19');
  eq('a narrow range returns only that window', steps.length, 10);
  eq('the range is inclusive at both ends', steps[0].date, '2026-07-10');
  eq('the range is inclusive at both ends (upper)', steps[9].date, '2026-07-19');
}

// ---------------------------------------------------------------------------
section('4b. Durable coach insight memory');
// ---------------------------------------------------------------------------
{
  const dateKey = '2026-07-30';
  const base = {
    type: 'nutrition',
    dateKey,
    severity: 'suggestion',
    title: 'Protein is below the useful floor',
    body: 'The logged average was below the current floor.',
    ruleId: 'adequacy-protein',
    score: 0.72,
    guardrailPassed: true,
    evidence: { action: 'Add a protein serving.', grams: 118 },
    dismissedAt: null,
    acknowledgedAt: null,
  };
  const created = await R.insights.upsertRuleOutput(base.ruleId, dateKey, base);
  eq('a generated coach insight is persisted', (await R.insights.getForDate(dateKey)).length, 1);
  await R.insights.acknowledge(created.id);
  await R.insights.dismiss(created.id);

  const refreshed = await R.insights.upsertRuleOutput(base.ruleId, dateKey, {
    ...base,
    title: 'Protein is still below the useful floor',
    score: 0.75,
  });
  ok('regeneration preserves acted-on state', refreshed.acknowledgedAt !== null);
  ok('regeneration preserves dismissed state', refreshed.dismissedAt !== null);
  eq('regeneration can refresh the coaching content', refreshed.score, 0.75);
  eq('dismissed insights leave the live ranked list', (await R.insights.getForDate(dateKey)).length, 0);
  eq(
    'dismissed insights remain available as honest history',
    (await R.insights.getForDate(dateKey, { includeDismissed: true })).length,
    1,
  );

  const unchanged = await R.insights.upsertRuleOutput(base.ruleId, dateKey, {
    ...base,
    title: 'Protein is still below the useful floor',
    score: 0.75,
  });
  eq('identical regeneration is a no-op', unchanged.updatedAt, refreshed.updatedAt);
}

// ---------------------------------------------------------------------------
section('5. Soft delete and tombstones');
// ---------------------------------------------------------------------------
{
  const target = (await R.weights.getForDate('2026-07-22'))[0];
  ok('soft delete reports success', await R.weights.softDelete(target.id));
  eq('the row is gone from normal reads', (await R.weights.getForDate('2026-07-22')).length, 0);
  eq('the row is still there when asked for', (await R.weights.listByDate('2026-07-22', { includeDeleted: true })).length, 1);
  eq('the tombstone survives on disk', await DB.getDb().rows('weightEntries').count(), 5);

  await R.weights.log({
    dateKey: '2026-07-22',
    kg: 99,
    measuredAt: Date.now(),
    bodyFatPct: null,
    note: null,
    source: 'apple-health',
    sourceKey: 'apple-health:body-mass:2026-07-22',
  });
  eq('a re-import does NOT resurrect a deleted record', (await R.weights.getForDate('2026-07-22')).length, 0);

  const restored = await R.weights.restore(target.id);
  eq('restore brings it back', restored.kg, 82.6);
  eq('and it is visible again', (await R.weights.getForDate('2026-07-22')).length, 1);
}

// ---------------------------------------------------------------------------
section('6. Relational reads: training');
// ---------------------------------------------------------------------------
let sessionId;
{
  await R.exercises.seed([
    {
      slug: 'barbell-bench-press',
      name: 'Barbell Bench Press',
      primaryMuscles: ['chest'],
      secondaryMuscles: ['front_delts', 'triceps'],
      equipment: 'barbell',
      sfr: 4,
      substituteSlugs: ['dumbbell-bench-press'],
      unilateral: false,
      userCreated: false,
      note: null,
      source: 'seed',
      sourceKey: null,
    },
    {
      slug: 'barbell-row',
      name: 'Barbell Row',
      primaryMuscles: ['upper_back', 'lats'],
      secondaryMuscles: ['biceps'],
      equipment: 'barbell',
      sfr: 4,
      substituteSlugs: [],
      unilateral: false,
      userCreated: false,
      note: null,
      source: 'seed',
      sourceKey: null,
    },
  ]);
  const reseed = await R.exercises.seed([
    {
      slug: 'barbell-bench-press',
      name: 'Barbell Bench Press',
      primaryMuscles: ['chest'],
      secondaryMuscles: ['front_delts', 'triceps'],
      equipment: 'barbell',
      sfr: 5,
      substituteSlugs: [],
      unilateral: false,
      userCreated: false,
      note: null,
      source: 'seed',
      sourceKey: null,
    },
  ]);
  eq('re-seeding the library creates nothing new', reseed.created, 0);
  eq('the library holds 2 exercises', await R.exercises.count(), 2);

  const bench = await R.exercises.getBySlug('barbell-bench-press');
  ok('lookup by slug works through the blind index', bench !== null);
  eq('re-seeding updated the record in place', bench.sfr, 5);
  eq('lookup by an unknown slug returns null', await R.exercises.getBySlug('nope'), null);
  eq('forMuscle finds primary movers', (await R.exercises.forMuscle('chest')).length, 1);
  eq('forMuscle finds secondary movers too', (await R.exercises.forMuscle('biceps')).length, 1);

  const row = await R.exercises.getBySlug('barbell-row');
  const session = await R.workoutSessions.create({
    dateKey: '2026-07-24',
    startedAt: Date.parse('2026-07-24T17:30:00Z'),
    endedAt: Date.parse('2026-07-24T18:45:00Z'),
    mesocycleId: null,
    dayIndex: 0,
    kind: 'personal_trainer',
    title: 'Upper A',
    sessionRpe: 8,
    note: 'shoulder twinge on set 3',
    coachName: 'Sam',
    trainerReport: null,
    source: 'manual',
    sourceKey: null,
  });
  sessionId = session.id;
  for (let i = 0; i < 12; i++) {
    await R.workoutSets.create({
      sessionId,
      exerciseId: i < 6 ? bench.id : row.id,
      order: i,
      weightKg: 80 + i,
      magnitude: { repUnit: 'reps', reps: 8 },
      effortKind: 'rir',
      effort: 2,
      warmup: i === 0,
      technique: 'straight',
      restSeconds: 150,
      rom: null,
      note: null,
      estimated1rmKg: (80 + i) * 1.27,
      source: 'manual',
      sourceKey: null,
    });
  }
  const sets = await R.workoutSets.getForSession(sessionId);
  eq('all 12 sets come back for the session', sets.length, 12);
  eq('sets are ordered by their order field', sets[0].order, 0);
  eq('set loads round-trip', sets[11].weightKg, 91);
  eq('the magnitude union round-trips tagged', sets[0].magnitude.repUnit, 'reps');
  eq('and carries its number', sets[0].magnitude.reps, 8);
  ok('there is no bare reps field to render wrongly', !('reps' in sets[0]));
  eq('per-exercise history works', (await R.workoutSets.getForExercise(bench.id)).length, 6);

  const volume = await R.workoutSets.hardSetsByMuscle(
    [sessionId],
    new Map([
      [bench.id, bench],
      [row.id, row],
    ]),
  );
  eq('warm-ups are excluded from hard-set volume', volume.chest, 5);
  eq('secondary muscles count as half a set', volume.triceps, 2.5);
  eq('a two-primary exercise counts fully for both', volume.upper_back, 6);

  ok('the trainer session survives verbatim', (await R.workoutSessions.get(sessionId)).coachName === 'Sam');
  eq('sessions for a date are found', (await R.workoutSessions.getForDate('2026-07-24')).length, 1);
}

// ---------------------------------------------------------------------------
section('6b. Body schema v2: tagged magnitudes, ROM, trainer report');
// ---------------------------------------------------------------------------
{
  const bench = await R.exercises.getBySlug('barbell-bench-press');

  // Every unit, stored and read back through the real codec.
  const cases = [
    ['reps', { repUnit: 'reps', reps: 12 }, 12],
    ['seconds', { repUnit: 'seconds', seconds: 1800 }, 1800],
    ['meters', { repUnit: 'meters', meters: 45 }, 45],
    ['steps', { repUnit: 'steps', steps: 20 }, 20],
  ];
  for (const [label, magnitude, value] of cases) {
    const written = await R.workoutSets.create({
      source: 'manual',
      sourceKey: null,
      sessionId,
      exerciseId: bench.id,
      order: 100 + cases.indexOf(cases.find((c) => c[0] === label)),
      weightKg: 0,
      magnitude,
      effortKind: 'none',
      effort: null,
      warmup: false,
      technique: 'straight',
      restSeconds: null,
      rom: null,
      note: null,
      estimated1rmKg: null,
    });
    const read = await R.workoutSets.get(written.id);
    eq(`a ${label} set round-trips its unit`, read.magnitude.repUnit, label);
    eq(`a ${label} set round-trips its value`, DB.magnitudeValue(read.magnitude), value);
    ok(`a ${label} set exposes no bare reps field`, !('reps' in read) || label === 'reps');
  }

  // ROM, for the movements that progress by depth rather than load.
  const romSet = await R.workoutSets.create({
    source: 'manual',
    sourceKey: null,
    sessionId,
    exerciseId: bench.id,
    order: 120,
    weightKg: 0,
    magnitude: { repUnit: 'reps', reps: 10 },
    effortKind: 'none',
    effort: null,
    warmup: false,
    technique: 'straight',
    restSeconds: null,
    rom: { value: 12.5, unit: 'in', note: 'knee to wall, left' },
    note: null,
    estimated1rmKg: null,
  });
  const romRead = await R.workoutSets.get(romSet.id);
  eq('ROM value round-trips', romRead.rom.value, 12.5);
  eq('ROM unit round-trips verbatim', romRead.rom.unit, 'in');
  eq('ROM note round-trips', romRead.rom.note, 'knee to wall, left');

  // Trainer report on a session.
  const report = {
    durationMin: 60,
    regionEffort: { hips: 3, mid_back: 2, quads_sled: 3 },
    hardSetsTotal: null,
    perceivedRir: 2,
    sledMeters: 200,
    exerciseNames: ['trap bar deadlift', 'sled push'],
    confirmed: false,
    estimate: { glutes: { meanSets: 5.5, sdSets: 1.4 }, upper_back: { meanSets: 4, sdSets: 1.0 } },
  };
  const trainerSession = await R.workoutSessions.create({
    source: 'manual',
    sourceKey: null,
    dateKey: '2026-07-23',
    startedAt: Date.parse('2026-07-23T17:00:00Z'),
    endedAt: Date.parse('2026-07-23T18:00:00Z'),
    mesocycleId: null,
    dayIndex: null,
    kind: 'personal_trainer',
    title: 'Trainer session',
    sessionRpe: 8,
    note: 'sled felt heavy',
    coachName: 'Sam',
    trainerReport: report,
  });
  const trainerRead = await R.workoutSessions.get(trainerSession.id);
  eq('the trainer report round-trips its estimate', trainerRead.trainerReport.estimate.glutes.meanSets, 5.5);
  eq('the sigma survives', trainerRead.trainerReport.estimate.glutes.sdSets, 1.4);
  eq('confirmed:false survives — an unreported session still counts', trainerRead.trainerReport.confirmed, false);
  eq('sled metres are stored in SI', trainerRead.trainerReport.sledMeters, 200);
  eq('perceived effort stays on the session, not duplicated', trainerRead.sessionRpe, 8);

  const rawTrainer = await DB.getDb().rows('workoutSessions').get(trainerSession.id);
  ok(
    'the trainer report is inside the ciphertext',
    !JSON.stringify(rawTrainer, (k, v) => (v instanceof Uint8Array ? '' : v)).includes('trap bar'),
  );
  eq('new rows are written at the current body version', rawTrainer.v, DB.BODY_VERSION);
}

// ---------------------------------------------------------------------------
section('6c. Reading a v1 row written before the schema change');
// ---------------------------------------------------------------------------
{
  // Forge exactly what the workout logger's pre-v2 workaround left on disk:
  // the count in `unitValue`, `reps` stuck at 0, an undeclared `repUnit`, and
  // the row stamped v=1. Then read it through the ordinary repository.
  const keys = V.requireKeys();
  const legacyId = 'legacy-zone2-set';
  const legacyBody = {
    id: legacyId,
    createdAt: Date.parse('2026-06-01T10:00:00Z'),
    updatedAt: Date.parse('2026-06-01T10:00:00Z'),
    deletedAt: null,
    source: 'manual',
    sourceKey: null,
    sessionId,
    exerciseId: 'ex-legacy',
    order: 200,
    weightKg: 0,
    reps: 0,
    durationSec: 1800,
    repUnit: 'seconds',
    unitValue: 1800,
    rom: { value: 9, unit: 'holes', note: 'pin 9' },
    effortKind: 'none',
    effort: null,
    warmup: false,
    technique: 'straight',
    restSeconds: null,
    note: 'zone 2, felt easy',
    estimated1rmKg: null,
  };
  const encoded = await DB.encodeRow(keys, 'workoutSets', legacyBody);
  await DB.getDb().rows('workoutSets').put({ ...encoded, v: 1 });

  const migrated = await R.workoutSets.get(legacyId);
  eq('a v1 row is readable at all', migrated !== null, true);
  eq('a 30-minute ride migrates to the seconds arm', migrated.magnitude.repUnit, 'seconds');
  eq('and keeps its 1800', migrated.magnitude.seconds, 1800);
  ok('it does NOT come back as 0 reps', migrated.magnitude.repUnit !== 'reps');
  ok('the legacy reps field is gone', !('reps' in migrated));
  ok('the legacy durationSec field is gone', !('durationSec' in migrated));
  ok('the legacy unitValue field is gone', !('unitValue' in migrated));
  eq('the logger ROM key was promoted', migrated.rom.unit, 'holes');
  eq('unrelated fields survive the migration', migrated.note, 'zone 2, felt easy');

  eq('the row on disk is still stamped v1 until it is rewritten',
    (await DB.getDb().rows('workoutSets').get(legacyId)).v, 1);
  await R.workoutSets.update(legacyId, { note: 'zone 2, felt easy (edited)' });
  eq('a write persists it at the current body version',
    (await DB.getDb().rows('workoutSets').get(legacyId)).v, DB.BODY_VERSION);
  const rewritten = await R.workoutSets.get(legacyId);
  eq('and the magnitude is unchanged by the rewrite', rewritten.magnitude.seconds, 1800);

  await R.workoutSets.hardDelete(legacyId);
}

// ---------------------------------------------------------------------------
section('7. Nutrition diary');
// ---------------------------------------------------------------------------
{
  const oatsInput = {
    // The OFF mapper's real identity shape. The repository must discard it
    // because IndexedDB row ids are plaintext.
    id: 'off:5000159407236',
    name: 'Rolled Oats',
    brand: 'Generic',
    barcode: null,
    per100g: { kcal: 379, proteinG: 13.2, carbG: 67.7, fatG: 6.5, fiberG: 10.1 },
    servings: [{ id: 'cup', label: '1 cup', grams: 81 }],
    userCreated: false,
    useCount: 0,
    lastUsedAt: null,
    source: 'open-food-facts',
    sourceKey: null,
  };
  const oats = await R.foods.cacheFromLookup('5000159407236', oatsInput);
  const cachedAgain = await R.foods.cacheFromLookup('5000159407236', {
    ...oatsInput,
    name: 'Rolled Oats — refreshed',
  });
  eq('repeating an OFF lookup updates one encrypted cache row', cachedAgain.id, oats.id);
  eq('the encrypted cache contains one barcode result', await R.foods.count(), 1);
  const found = await R.foods.getByBarcode('5000159407236');
  ok('a food is found by barcode through the blind index', found?.id === oats.id);

  const rawFoods = await DB.getDb().rows('foods').toArray();
  ok(
    'the barcode is NOT stored in plaintext',
    !JSON.stringify(rawFoods, (k, v) => (v instanceof Uint8Array ? '' : v)).includes('5000159407236'),
  );
  ok('the OFF-derived id is replaced with a random vault id', !oats.id.includes('5000159407236'));

  await R.foodLogs.logFood({ dateKey: '2026-07-24', slot: 'breakfast', food: oats, grams: 100 });
  await R.foodLogs.logFood({ dateKey: '2026-07-24', slot: 'lunch', food: oats, grams: 50 });
  const totals = await R.foodLogs.getDayTotals('2026-07-24');
  eq('day totals sum correctly', Math.round(totals.kcal), 569);
  eq('macros scale by mass', Math.round(totals.proteinG * 10) / 10, 19.8);
  eq('optional micros are preserved', Math.round(totals.fiberG * 10) / 10, 15.2);
  const slots = await R.foodLogs.getSlotTotals('2026-07-24');
  eq('per-slot totals split correctly', Math.round(slots.breakfast.kcal), 379);
  const diary = await R.foodLogs.getForDate('2026-07-24');
  eq('the diary is ordered breakfast before lunch', diary[0].slot, 'breakfast');
  const intake = await R.foodLogs.getDailyIntakeSeries('2026-07-01', '2026-07-31');
  eq('the intake series has one entry for the logged day', intake.length, 1);
  eq('search finds foods by name', (await R.foods.search('oats')).length, 1);
  eq('search misses are empty, not errors', (await R.foods.search('zzzz')).length, 0);
}

// ---------------------------------------------------------------------------
section('8. Locking');
// ---------------------------------------------------------------------------
const events = [];
const unsubscribe = V.subscribe((e) => events.push(e));
{
  V.lock();
  eq('lock() moves the state to locked', V.getState(), 'locked');
  eq('a lock event was emitted', events.at(-1).state, 'locked');
  eq('the lock reason is reported', events.at(-1).reason, 'manual');

  await throws(
    'reads are refused while locked',
    () => R.weights.getSeries('2026-07-01', '2026-07-31'),
    (e) => e.name === 'VaultLockedError',
  );
  await throws(
    'writes are refused while locked',
    () => R.weights.create({ dateKey: '2026-07-25', kg: 1, measuredAt: 0, bodyFatPct: null, note: null, source: 'manual', sourceKey: null }),
    (e) => e.name === 'VaultLockedError',
  );
  ok('but the keyring is still readable while locked', (await V.loadKeyring()) !== null);
  ok('and getStatus still works while locked', (await V.getStatus()).state === 'locked');

  await throws(
    'a wrong passphrase fails via the GCM tag',
    () => V.unlock(PASS + 'x'),
    (e) => e.name === 'UnlockFailedError',
  );
  eq('a failed unlock leaves the vault locked', V.getState(), 'locked');

  await V.unlock(PASS);
  eq('the correct passphrase unlocks', V.getState(), 'unlocked');
  eq('an unlock event was emitted', events.at(-1).state, 'unlocked');
  eq('data is intact after a lock/unlock cycle', (await R.weights.getSeries('2026-07-01', '2026-07-31')).length, 5);

  V.lock();
  await V.unlockWithRecoveryCode(init.recoveryCode.toLowerCase());
  eq('the recovery code also unlocks (lowercase, as typed)', V.getState(), 'unlocked');
  eq('data is identical after a recovery-code unlock', (await R.weights.getForDate('2026-07-20'))[0].note, SECRET_NOTE);

  const peer = new FakeBroadcastChannel('keel-vault-session-v1');
  peer.postMessage({ type: 'vault-reset' });
  await new Promise((resolve) => queueMicrotask(resolve));
  eq('a restore reset from a peer context locks this session', V.getState(), 'locked');
  eq('the peer-context lock reports the reset reason', events.at(-1).reason, 'reset');
  await V.unlockWithRecoveryCode(init.recoveryCode);
  eq('peer reset changes no encrypted health data', (await R.weights.getForDate('2026-07-20'))[0].note, SECRET_NOTE);
  peer.close();
}
unsubscribe();

// ---------------------------------------------------------------------------
section('9. Passphrase change and passkey registration');
// ---------------------------------------------------------------------------
{
  const NEW_PASS = 'a completely different passphrase entirely';
  await V.changePassphrase(PASS, NEW_PASS, { iterations: FAST });
  V.lock();
  await throws(
    'the old passphrase stops working',
    () => V.unlock(PASS),
    (e) => e.name === 'UnlockFailedError',
  );
  await V.unlock(NEW_PASS);
  eq('the new passphrase works', V.getState(), 'unlocked');
  eq('no data was re-encrypted — it is all still readable', (await R.weights.getSeries('2026-07-01', '2026-07-31')).length, 5);
  eq('the wrapping count is unchanged', (await V.getStatus()).wrappings.length, 2);

  // Node V4's entry point: a 32-byte PRF secret from a passkey.
  const prf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(prf);
  const wrappingId = await V.registerSecretWrapping(prf, { label: 'iPhone — Face ID', credentialId: 'Y3JlZA' });
  eq('registering a passkey adds a third wrapping', (await V.getStatus()).wrappings.length, 3);
  ok('the status reports a passkey', (await V.getStatus()).hasPasskey);
  V.lock();
  await V.unlockWithSecret(prf, { credentialId: 'Y3JlZA' });
  eq('the passkey secret unlocks the vault', V.getState(), 'unlocked');
  eq('and the same data is there', (await R.weights.getForDate('2026-07-20'))[0].kg, 82.4);

  await V.removeWrapping(wrappingId);
  eq('revoking the passkey leaves two wrappings', (await V.getStatus()).wrappings.length, 2);
  V.lock();
  await throws(
    'the revoked passkey no longer opens the vault',
    () => V.unlockWithSecret(prf),
    (e) => e.name === 'UnlockFailedError',
  );
  await V.unlock(NEW_PASS);
  globalThis.__PASS = NEW_PASS;
}

// ---------------------------------------------------------------------------
section('10. Backup export');
// ---------------------------------------------------------------------------
let blob;
let expectedCount;
{
  expectedCount = (await DB.countAllRows()).total;
  eq('a fresh vault has no claimed backup delivery', await V.daysSinceLastBackup(), null);
  V.lock();
  blob = await V.exportVault({
    kind: 'recovery-code',
    value: init.recoveryCode,
  });
  ok('export produces a blob', blob instanceof Blob);
  eq('secret-authenticated export does not open the local session', V.getState(), 'locked');
  await V.unlock(globalThis.__PASS);
  const env = JSON.parse(await blob.text());
  eq('the envelope declares its format', env.format, 'hcvault');
  eq('the envelope declares its version', env.formatVersion, 2);
  ok('the envelope has a creation timestamp', !Number.isNaN(Date.parse(env.createdAt)));
  eq('the envelope record count matches the database', env.recordCount, expectedCount);
  ok('the envelope carries the full keyring', env.keyring.wrappedKeys.length === 2);
  ok('every known table is present, including empty tables', DB.VAULT_TABLES.every((t) => Array.isArray(env.tables[t])));
  ok('the envelope carries a 32-byte keyed tag', Buffer.from(env.integrity.tag, 'base64url').length === 32);
  eq('the integrity algorithm is keyed', env.integrity.algorithm, 'HMAC-SHA-256');
  console.log(`     (envelope: ${expectedCount} records, ${(await blob.text()).length} bytes JSON)`);

  const text = await blob.text();
  ok('the backup contains no plaintext note', !text.includes('felt awful'));
  ok('the backup contains no plaintext passphrase', !text.includes(globalThis.__PASS));

  eq(
    'creating a blob alone does not claim that the user received it',
    await V.daysSinceLastBackup(),
    null,
  );
  await throws(
    'a wrong passphrase cannot produce an unauthenticated v2 export',
    () =>
      V.exportAndVerify({
        kind: 'passphrase',
        value: 'wrong',
      }),
    (e) => e.name === 'UnlockFailedError',
  );
  eq(
    'failed credential verification does not advance backup freshness',
    await V.daysSinceLastBackup(),
    null,
  );
  const verifiedExport = await V.exportAndVerify({
    kind: 'recovery-code',
    value: init.recoveryCode,
  });
  ok('a correct credential fully verifies an export', verifiedExport.preview.restorable);
  eq(
    'successful verification alone still does not claim delivery',
    await V.daysSinceLastBackup(),
    null,
  );

  const preview = await V.previewImport(blob, { kind: 'recovery-code', value: init.recoveryCode });
  ok('the keyed integrity tag verifies', preview.integrityOk);
  ok('the recovery code opens the backup', preview.canDecrypt);
  ok('every encrypted row authenticates', preview.recordsOk);
  ok('the verified backup is restorable', preview.restorable);
  ok('the preview knows it is the same vault', preview.sameVault);
  eq('the preview counts the records', preview.recordCount, expectedCount);
  ok('the preview lists per-table counts', preview.byTable.weightEntries === 5);

  const wrongPreview = await V.previewImport(blob, { kind: 'passphrase', value: 'wrong' });
  ok('a wrong passphrase is caught in the dry run', !wrongPreview.canDecrypt);
  ok('and is reported as a warning', wrongPreview.warnings.some((w) => w.includes('does not open')));

  const tampered = jsonClone(env);
  tampered.integrity.tag = changeToken(tampered.integrity.tag);
  const tamperedBlob = new Blob([JSON.stringify(tampered)]);
  const tamperedPreview = await V.previewImport(tamperedBlob, {
    kind: 'recovery-code',
    value: init.recoveryCode,
  });
  ok('a changed HMAC tag fails verification', !tamperedPreview.integrityOk);
  ok('a failed keyed-integrity backup is never restorable', !tamperedPreview.restorable);

  await DB.setMeta('__restore_sentinel__', 'must survive');
  await throws(
    'a failed-integrity replace is rejected before it can clear the vault',
    () =>
      V.importVault(
        tamperedBlob,
        { kind: 'recovery-code', value: init.recoveryCode },
        { mode: 'replace' },
      ),
    (e) => e.name === 'BackupFormatError' && e.reason === 'integrity',
  );
  eq(
    'failed integrity left unrelated local metadata untouched',
    await DB.getMeta('__restore_sentinel__'),
    'must survive',
  );

  // Removing a row and fixing the public count still cannot forge the HMAC.
  const removedRowEnvelope = jsonClone(env);
  removedRowEnvelope.tables.weightEntries.pop();
  removedRowEnvelope.recordCount--;
  const removedRowPreview = await V.previewImport(
    new Blob([JSON.stringify(removedRowEnvelope)]),
    { kind: 'recovery-code', value: init.recoveryCode },
  );
  ok('removing a row invalidates the keyed manifest', !removedRowPreview.integrityOk);
  ok('a row-omission backup is never restorable', !removedRowPreview.restorable);

  // Removing even an empty table is authenticated and separately incompatible.
  const removedTableEnvelope = jsonClone(env);
  removedTableEnvelope.recordCount -= removedTableEnvelope.tables.meals.length;
  delete removedTableEnvelope.tables.meals;
  const removedTablePreview = await V.previewImport(
    new Blob([JSON.stringify(removedTableEnvelope)]),
    { kind: 'recovery-code', value: init.recoveryCode },
  );
  ok('removing a table invalidates the keyed manifest', !removedTablePreview.integrityOk);
  ok('a missing required table is incompatible', !removedTablePreview.compatible);

  // Header mutations are part of the HMAC, including the body-version header.
  const changedHeaderEnvelope = jsonClone(env);
  changedHeaderEnvelope.tables.weightEntries[0].dateKey = '1900-01-01';
  changedHeaderEnvelope.tables.weightEntries[0].v = 1;
  const changedHeaderPreview = await V.previewImport(
    new Blob([JSON.stringify(changedHeaderEnvelope)]),
    { kind: 'recovery-code', value: init.recoveryCode },
  );
  ok('changing plaintext row headers invalidates the HMAC', !changedHeaderPreview.integrityOk);

  // Model an authorised but buggy backup tool that signs invalid row content.
  // The independent row GCM tag and regenerated indexes must still block it.
  const corruptRowEnvelope = jsonClone(env);
  const corruptRow = corruptRowEnvelope.tables.weightEntries[0];
  corruptRow.ct = changeToken(corruptRow.ct);
  const corruptRowBlob = new Blob([
    JSON.stringify(await retagV2(corruptRowEnvelope, init.recoveryCode)),
  ]);
  const corruptRowPreview = await V.previewImport(corruptRowBlob, {
    kind: 'recovery-code',
    value: init.recoveryCode,
  });
  ok('a re-tagged corrupt file passes the envelope HMAC', corruptRowPreview.integrityOk);
  ok('its keyring still opens', corruptRowPreview.canDecrypt);
  ok('its damaged encrypted row is detected', !corruptRowPreview.recordsOk);
  ok('row corruption blocks restore', !corruptRowPreview.restorable);
  await throws(
    'a corrupt encrypted row is rejected before any replace write',
    () =>
      V.importVault(
        corruptRowBlob,
        { kind: 'recovery-code', value: init.recoveryCode },
        { mode: 'replace' },
      ),
    (e) => e.name === 'BackupFormatError' && e.reason === 'integrity',
  );
  eq(
    'row-authentication failure left local metadata untouched',
    await DB.getMeta('__restore_sentinel__'),
    'must survive',
  );
  eq(
    'row-authentication failure left readable health data untouched',
    (await R.weights.getForDate('2026-07-20'))[0].note,
    SECRET_NOTE,
  );

  for (const key of [
    'dateKey',
    'type',
    'sourceHash',
    'sessionId',
    'exerciseId',
    'mesocycleId',
    'programId',
  ]) {
    const badIndexEnvelope = jsonClone(env);
    badIndexEnvelope.tables.weightEntries[0][key] = `tampered-${key}`;
    const signedBadIndex = await retagV2(badIndexEnvelope, init.recoveryCode);
    const badIndexPreview = await V.previewImport(
      new Blob([JSON.stringify(signedBadIndex)]),
      { kind: 'recovery-code', value: init.recoveryCode },
    );
    ok(
      `a validly signed wrong ${key} index is regenerated and rejected`,
      badIndexPreview.integrityOk &&
        !badIndexPreview.recordsOk &&
        !badIndexPreview.restorable,
    );
  }

  const futureEnvelope = jsonClone(env);
  futureEnvelope.app.bodyVersion += 1;
  const futureBlob = new Blob([
    JSON.stringify(await retagV2(futureEnvelope, init.recoveryCode)),
  ]);
  const futurePreview = await V.previewImport(futureBlob, {
    kind: 'recovery-code',
    value: init.recoveryCode,
  });
  ok('a newer record schema is reported as incompatible', !futurePreview.compatible);
  ok('an incompatible backup is never restorable', !futurePreview.restorable);
  await throws(
    'a newer record schema is rejected before any replace write',
    () =>
      V.importVault(
        futureBlob,
        { kind: 'recovery-code', value: init.recoveryCode },
        { mode: 'replace' },
      ),
    (e) => e.name === 'BackupFormatError' && e.reason === 'version',
  );
  eq(
    'version rejection left local metadata untouched',
    await DB.getMeta('__restore_sentinel__'),
    'must survive',
  );

  const legacyEnvelope = jsonClone(env);
  legacyEnvelope.formatVersion = 1;
  legacyEnvelope.integrity = { algorithm: 'SHA-256', digest: 'legacy' };
  await throws(
    'legacy v1 backups are rejected with explicit re-export guidance',
    () => V.previewImport(new Blob([JSON.stringify(legacyEnvelope)])),
    (e) =>
      e.name === 'BackupFormatError' &&
      e.reason === 'version' &&
      /legacy format 1/i.test(e.message) &&
      /re-export/i.test(e.message),
  );

  // A storage failure after destructive clears must roll back rows, metadata,
  // keyring adoption, and leave the old in-memory session unlocked.
  const beforeRollbackCount = (await DB.countAllRows()).total;
  const markerBeforeRollback = await DB.getMeta(DB.META_KEYS.pendingMediaCleanup);
  const failTable = DB.getDb().rows('healthMetrics');
  let injectedWriteFailureRan = false;
  const failCreating = () => {
    injectedWriteFailureRan = true;
    throw new Error('injected replace write failure');
  };
  failTable.hook.creating.subscribe(failCreating);
  try {
    await throws(
      'a mid-replace storage error aborts the complete transaction',
      () =>
        V.importVault(
          blob,
          { kind: 'recovery-code', value: init.recoveryCode },
          { mode: 'replace' },
        ),
      (e) => /injected replace write failure/.test(String(e?.message ?? e)),
    );
  } finally {
    failTable.hook.creating.unsubscribe(failCreating);
  }
  ok('the injected replace failure reached a later table write', injectedWriteFailureRan);
  eq('failed replace leaves every row intact', (await DB.countAllRows()).total, beforeRollbackCount);
  eq('failed replace leaves unrelated metadata intact', await DB.getMeta('__restore_sentinel__'), 'must survive');
  eq('failed replace does not create a cleanup marker', await DB.getMeta(DB.META_KEYS.pendingMediaCleanup), markerBeforeRollback);
  eq('failed replace leaves the old session unlocked', V.getState(), 'unlocked');
  eq('failed replace leaves health data readable', (await R.weights.getForDate('2026-07-20'))[0].note, SECRET_NOTE);

  await DB.deleteMeta('__restore_sentinel__');

  await V.recordBackupDelivered();
  eq('successful delivery bookkeeping makes the backup current', await V.daysSinceLastBackup(), 0);
  ok('the backup is no longer overdue', !(await V.isBackupOverdue()));

  await throws(
    'a non-backup file is rejected',
    () => V.previewImport(new Blob(['not json at all'])),
    (e) => e.name === 'BackupFormatError' && e.reason === 'not-json',
  );
  await throws(
    'a JSON file that is not a backup is rejected',
    () => V.previewImport(new Blob(['{"hello":"world"}'])),
    (e) => e.name === 'BackupFormatError' && e.reason === 'not-hcvault',
  );
  await throws(
    'a backup from a newer app version is rejected',
    () => V.previewImport(new Blob([JSON.stringify({ ...JSON.parse(text), formatVersion: 99 })])),
    (e) => e.name === 'BackupFormatError' && e.reason === 'version',
  );
}

// ---------------------------------------------------------------------------
section('11. Disaster recovery: wipe the device, restore from the file alone');
// ---------------------------------------------------------------------------
{
  V.lock();
  await DB.wipeVault();
  V.invalidateKeyringCache();
  eq('the device is empty', (await DB.countAllRows()).total, 0);
  eq('the device has no keyring', await V.isInitialized(), false);

  // Install an unrelated vault so replace proves it closes an actively
  // unlocked, wrong-DEK session rather than merely restoring into emptiness.
  const temporaryPass = 'temporary different vault passphrase';
  const temporary = await V.initializeVault(temporaryPass, { iterations: FAST });
  ok('the temporary vault is genuinely different', temporary.vaultId !== init.vaultId);
  eq('the temporary vault is unlocked before replace', V.getState(), 'unlocked');

  const result = await V.importVault(blob, { kind: 'recovery-code', value: init.recoveryCode }, { mode: 'replace' });
  eq('the restore reports the right mode', result.mode, 'replace');
  eq('every record was restored', result.applied, expectedCount);
  eq('nothing failed', result.failed, 0);
  eq('replace locks the old in-memory session immediately', V.getState(), 'locked');
  eq('replace commits the cross-database cleanup marker', await DB.getMeta(DB.META_KEYS.pendingMediaCleanup), true);
  await throws(
    'repository keys are unavailable immediately after replace',
    () => V.requireKeys('post-restore write'),
    (e) => e.name === 'VaultLockedError',
  );
  await throws(
    'the replaced temporary-vault passphrase no longer opens the device',
    () => V.unlock(temporaryPass),
    (e) => e.name === 'UnlockFailedError',
  );

  await V.unlockWithRecoveryCode(init.recoveryCode);
  eq('the restored vault opens with the recovery code alone', V.getState(), 'unlocked');

  const restoredSeries = await R.weights.getSeries('2026-07-01', '2026-07-31');
  eq('the weight series is byte-identical', restoredSeries.length, 5);
  eq('values survived the round trip', restoredSeries[0].kg, 82.4);
  eq('free text survived the round trip', (await R.weights.getForDate('2026-07-20'))[0].note, SECRET_NOTE);
  eq('60 health metrics survived', await R.healthMetrics.count(), 60);
  eq('the metric index still works after restore', (await R.healthMetrics.getSeries('steps', '2026-07-01', '2026-07-30')).length, 30);
  const restoredSets = await R.workoutSets.getForSession(sessionId);
  eq('all 17 workout sets survived', restoredSets.length, 17);
  ok(
    'every restored set still carries a tagged magnitude',
    restoredSets.every((s) => typeof s.magnitude?.repUnit === 'string'),
  );
  ok(
    'the seconds/meters/steps sets did not collapse into reps',
    new Set(restoredSets.map((s) => s.magnitude.repUnit)).size === 4,
  );
  eq('the trainer session survived', (await R.workoutSessions.get(sessionId)).coachName, 'Sam');
  eq('the profile singleton survived', (await R.profiles.load()).heightCm, 181);
  eq('the food catalogue survived', (await R.foods.getByBarcode('5000159407236')) !== null, true);
  eq('the diary survived', Math.round((await R.foodLogs.getDayTotals('2026-07-24')).kcal), 569);
  eq('the blind index still resolves after restore', (await R.exercises.getBySlug('barbell-row')) !== null, true);
  eq('tombstones survived (deleted stays deleted)', (await R.weights.count({ includeDeleted: true })) - (await R.weights.count()), 0);

  // The backup's passphrase — not the device's old one — now opens the vault.
  V.lock();
  await V.unlock(globalThis.__PASS);
  eq('the backup passphrase opens the restored vault', V.getState(), 'unlocked');
}

// ---------------------------------------------------------------------------
section('12. Merge import');
// ---------------------------------------------------------------------------
{
  // Take a snapshot, then diverge locally, then merge the snapshot back.
  const snapshot = await V.exportVault({
    kind: 'passphrase',
    value: globalThis.__PASS,
  });
  await R.weights.log({
    dateKey: '2026-07-25',
    kg: 81.4,
    measuredAt: Date.parse('2026-07-25T07:00:00Z'),
    bodyFatPct: null,
    note: 'added after the snapshot',
    source: 'manual',
    sourceKey: null,
  });
  const beforeMerge = (await DB.countAllRows()).total;

  const merged = await V.importVault(snapshot, { kind: 'passphrase', value: globalThis.__PASS }, { mode: 'merge' });
  eq('merge reports its mode', merged.mode, 'merge');
  eq('merge skips rows the device already has newer or equal copies of', merged.applied, 0);
  ok('merge skipped everything in the snapshot', merged.skipped === expectedCount);
  eq('the post-snapshot record was not clobbered', (await R.weights.getForDate('2026-07-25'))[0].kg, 81.4);
  eq('no rows were lost', (await DB.countAllRows()).total, beforeMerge);

  const dry = await V.importVault(snapshot, { kind: 'passphrase', value: globalThis.__PASS }, { mode: 'merge', dryRun: true });
  ok('a dry run reports itself as such', dry.dryRun);
  eq('a dry run writes nothing', (await DB.countAllRows()).total, beforeMerge);

  await throws(
    'importing with the wrong secret fails before anything is written',
    () => V.importVault(snapshot, { kind: 'passphrase', value: 'nope' }, { mode: 'replace' }),
    (e) => e.name === 'UnlockFailedError',
  );
  eq('the failed import left the device untouched', (await DB.countAllRows()).total, beforeMerge);

  const rollbackSnapshot = await V.exportVault({
    kind: 'passphrase',
    value: globalThis.__PASS,
  });
  const db = DB.getDb();
  await db.transaction(
    'rw',
    db.rows('weightEntries'),
    db.rows('healthMetrics'),
    async () => {
      await db.rows('weightEntries').clear();
      await db.rows('healthMetrics').clear();
    },
  );
  const afterIntentionalClears = (await DB.countAllRows()).total;
  const cleanupMarkerBeforeMergeFailure = await DB.getMeta(DB.META_KEYS.pendingMediaCleanup);
  const mergeFailTable = db.rows('healthMetrics');
  let injectedMergeFailureRan = false;
  const failMergeCreating = () => {
    injectedMergeFailureRan = true;
    throw new Error('injected merge write failure');
  };
  mergeFailTable.hook.creating.subscribe(failMergeCreating);
  try {
    await throws(
      'a later merge write failure aborts all earlier table writes',
      () =>
        V.importVault(
          rollbackSnapshot,
          { kind: 'passphrase', value: globalThis.__PASS },
          { mode: 'merge' },
        ),
      (e) => /injected merge write failure/.test(String(e?.message ?? e)),
    );
  } finally {
    mergeFailTable.hook.creating.unsubscribe(failMergeCreating);
  }
  ok('the injected merge failure reached the later table', injectedMergeFailureRan);
  eq('failed merge commits none of its earlier rows', (await DB.countAllRows()).total, afterIntentionalClears);
  eq('failed merge leaves the first target table empty', await db.rows('weightEntries').count(), 0);
  eq('failed merge leaves the failing target table empty', await db.rows('healthMetrics').count(), 0);
  eq('failed merge leaves the active session unlocked', V.getState(), 'unlocked');
  eq(
    'failed merge leaves unrelated cleanup metadata unchanged',
    await DB.getMeta(DB.META_KEYS.pendingMediaCleanup),
    cleanupMarkerBeforeMergeFailure,
  );

  const recoveredFromRollbackTest = await V.importVault(
    rollbackSnapshot,
    { kind: 'passphrase', value: globalThis.__PASS },
    { mode: 'merge' },
  );
  ok('the same merge succeeds once storage writes recover', recoveredFromRollbackTest.applied > 0);
  eq('the intentionally cleared weight rows are restored', await db.rows('weightEntries').count(), 6);
  eq('the intentionally cleared health rows are restored', await db.rows('healthMetrics').count(), 60);
  eq('the cleanup helper sees the durable replace marker', await V.isMediaCleanupPending(), true);
  await V.recordMediaCleanupComplete();
  eq('successful media cleanup clears its durable marker', await V.isMediaCleanupPending(), false);
}

// ---------------------------------------------------------------------------
section('13. Auto-lock controller');
// ---------------------------------------------------------------------------
{
  V.configureAutoLock({ enabled: true, idleMs: 60_000, hiddenGraceMs: 5_000 });
  const cfg = V.getAutoLockConfig();
  eq('configuration is applied', cfg.idleMs, 60_000);
  ok('time-to-lock is reported while unlocked', V.msUntilIdleLock() > 55_000);
  V.noteActivity();
  ok('activity resets the countdown', V.msUntilIdleLock() > 59_000);
  V.configureAutoLock({ enabled: false });
  eq('a disabled auto-lock reports no deadline', V.msUntilIdleLock(), null);
  ok('startAutoLock is inert without a DOM', (V.startAutoLock(), !V.isAutoLockRunning()));

  const assessments = ['abc', 'password123', 'correct horse battery staple xyz'].map(V.assessPassphrase);
  eq('a 3-character passphrase is rejected', assessments[0].acceptable, false);
  ok('a long multi-word passphrase is accepted', assessments[2].acceptable);
  ok('entropy rises with length', assessments[2].entropyBits > assessments[1].entropyBits);
}

for (const peers of FakeBroadcastChannel.byName.values()) {
  for (const channel of peers) channel.close();
}
if (HAD_WINDOW) globalThis.window = ORIGINAL_WINDOW;
else delete globalThis.window;
globalThis.BroadcastChannel = ORIGINAL_BROADCAST_CHANNEL;

rmSync(OUT, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('vault storage, unlock and backup VERIFIED');
