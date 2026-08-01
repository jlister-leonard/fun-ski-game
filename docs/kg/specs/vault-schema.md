# Vault Schema Specification

**Owner:** vault agent (nodes V1, V2, V3, V5, V6)
**Status:** contract. Other agents code against this. Post to
[`channel/020-vault.md`](../channel/020-vault.md) before proposing a change.
**Last updated:** 2026-08-01 · **body schema v3** (v2 history: `channel/021-vault-schema-v2.md`)
**Implements:** [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3 and §4

---

## 0. The claim this document has to earn

> A stolen phone, a forensic disk image, or a copy of the user's iCloud Drive
> yields **ciphertext**. Not a redacted version. Not "hashed". Ciphertext.

Everything below exists to make that true, and to be precise about the handful
of places where it is *deliberately* not — because a database with no plaintext
indexes is a database you cannot query, and an app that takes four seconds to
draw a chart is an app nobody uses. Section 4 lists every one of those places
and justifies it individually. There are six.

---

## 1. The layers

```
  repos/*.ts        typed CRUD — plain objects in, plain objects out
       │            callers never see a key, an IV or a ciphertext
       ▼
  codec.ts          encodeRow / decodeRow
       │            AES-256-GCM, AAD-bound to <table>|<id>
       ▼
  schema.ts         Dexie index declarations + plaintext column mapping
       │
       ▼
  IndexedDB         { id, updatedAt, deleted, v, iv, ct, …index columns }
```

Keys come from `src/lib/vault/session.ts` and exist only while unlocked. Every
repository entry point calls `requireKeys()`, so a lock takes effect on the
**next operation**, not at some later checkpoint.

---

## 2. The row format

Every row in every encrypted table:

```ts
{
  id:         string      // random UUID v4 — primary key
  updatedAt:  number      // epoch ms
  deleted:    0 | 1
  v:          number      // record-body schema version
  iv:         Uint8Array  // 12 bytes, fresh per write, never reused
  ct:         Uint8Array  // AES-256-GCM(JSON(record)) ‖ 16-byte tag
  …0–4 plaintext index columns, per table (§4)
}
```

- `ct` is the ciphertext of the **entire record**, including the fields that are
  also mirrored into plaintext columns. That redundancy is deliberate: decoding
  is `JSON.parse(decrypt(ct))` with no reassembly step, and a future version can
  add, drop or recompute an index column without touching a single ciphertext.
- **AAD** for every row is `utf8("hcv1|<table>|<id>")`. An attacker with write
  access to IndexedDB therefore cannot move a ciphertext between tables or swap
  two rows within one — the GCM tag fails. Verified in
  `src/lib/crypto/crypto.verify.mjs` §3.
- `iv` is 12 fresh random bytes per encryption. GCM fails catastrophically on
  (key, IV) reuse, so no IV is ever derived, countered or cached. 20,000
  consecutive encryptions produce 20,000 distinct IVs in the verify script.

### Key hierarchy

```
passphrase    ─► PBKDF2-SHA-256, 600,000 iterations, 16-byte salt ─┐
recovery code ─► PBKDF2-SHA-256, 600,000 iterations, 16-byte salt ─┤► KEK
passkey PRF   ─► HKDF-SHA-256 ─────────────────────────────────────┘   │
                                                                       │ AES-GCM wrap
                                                          ┌────────────▼───────┐
                                                          │  DEK  256-bit rand │
                                                          └────────┬───────────┘
                                    ┌──────────────────────────────┴───────────┐
                              AES-GCM row bodies              HKDF ► HMAC index key
                                                                  (blind indexes, §4.4)
```

The DEK is generated **once** and never changes. Every unlock method is an
independent wrapping of that same key. Consequences:

- Changing the passphrase re-wraps 32 bytes. **Zero rows are re-encrypted.**
- Adding Face ID (node V4) appends one array element. No migration.
- A recovery code is a peer of the passphrase, not a backdoor.
- Revoking a device is one array removal.

---

## 3. Migration policy — two independent version axes

Encrypting the record bodies breaks the usual Dexie upgrade story, and the
break is worth stating loudly because it will surprise people:

> **Dexie `upgrade()` callbacks cannot migrate record bodies.** The database
> opens before the vault is unlocked. There is no DEK at upgrade time. There
> cannot be.

So there are two versions, and they move independently:

| Axis | Where | Governs | Mechanism |
|---|---|---|---|
| **Structural** | `DB_VERSION` in `schema.ts` | index declarations | `db.version(n).stores(…)`, replayed by Dexie on open |
| **Body** | `BODY_VERSION` + the `v` column | the shape inside `ct` | lazy, **on read, after unlock**, via the chain in `codec.ts` |

Current: `DB_VERSION = 1`, `BODY_VERSION = 3`.

| Body version | Change |
|---|---|
| 1 | initial |
| 2 | `WorkoutSet.reps` + `durationSec` → the tagged `magnitude` union; `WorkoutSet.rom` and `WorkoutSession.trainerReport` promoted to declared fields |
| 3 | readiness energy, pain, illness and red-flag symptoms promoted from `contributors[input.*]` to typed encrypted subjective fields |

**v2 and v3 did not bump `DB_VERSION`, and that is correct.** No body field is
indexed, so no index declaration changed. Adding an empty `.version(2)` block
would read, forever, as if the indexes had moved when they had not. The two
axes are independent precisely so that a body reshape does not have to lie
about the structural schema.

Body migrations run in memory every time a stale row is read, and the row is
persisted at its new version on its next write. The chain must be append-only
and pure.

**The practical rule for other agents:**

- Adding an **optional** field → no migration at all. It decodes as `undefined`.
- Adding a **required** field with a safe default → no migration; default it in
  the repository.
- **Renaming or repurposing** a field → bump `BODY_VERSION`, add a step to
  `BODY_MIGRATIONS`, and post to the channel first.
- Adding a **table or index** → new `.version()` block, bump `DB_VERSION`.
  Existing rows are untouched.

Backups carry both numbers in `app: { dbVersion, bodyVersion }`. A backup whose
`bodyVersion` exceeds this build's is refused with an honest message rather than
half-restored.

---

## 4. Plaintext index columns — every one, and why

This is the section to argue with. Six field *kinds* are readable without the
key. Nothing else is.

### 4.1 `dateKey` — `YYYY-MM-DD`, local calendar day

**Tables:** `goals`, `weightEntries`, `bodyMeasurements`, `foodLogs`, `meals`,
`mesocycles`, `workoutSessions`, `personalRecords`, `healthMetrics`,
`sleepRecords`, `readinessRecords`, `activities`, `labRecords`, `insights`, `ingestLog`.

**Why it must be plaintext:** every screen in the app is a date-range query.
A blind index answers exact matches only — it cannot answer "the last 90 days",
because the tokens are unordered by construction. Without a plaintext `dateKey`,
drawing a weight chart means decrypting the entire table. At three years of
daily data that is tens of thousands of AES operations on a phone, per render.

**What it leaks:** an *activity calendar* — which days have data of which kind.
An attacker learns "they logged food on 2026-07-24" and "they did not weigh
themselves on 2026-07-25". They learn nothing about what was eaten or what the
scale said.

**Why that is acceptable:** the same inference is available from IndexedDB file
mtimes, from row counts, and from the phone's own screen-time log. Paying a
full-table decrypt on every render to hide a fact the filesystem already leaks
would be security theatre with a real cost.

**Note:** `dateKey` is the **local** calendar day, never UTC. A 23:30 workout
belongs to that evening. Sleep is attributed to the **wake** day.

### 4.2 `type` — metric / insight discriminator

**Tables:** `healthMetrics`, `insights`. Values are the closed
`HealthMetricType` / `InsightType` unions.

**Why it must be plaintext:** `healthMetrics` is one generic table holding every
timeseries from every source — potentially 15 metrics × 1,000+ days. The
compound index `[deleted+type+dateKey]` turns "resting HR for 90 days" into a
scan of exactly 90 index entries. Without it, that query decrypts the whole
table to find the 0.6% of rows it wants.

**What it leaks:** which *kinds* of metric the vault contains. That
`blood_oxygen_pct` rows exist is mildly informative; that
`respiratory_rate` rows exist is mildly informative. No value is ever exposed.

**Why that is acceptable:** the alternative is a per-metric table, which leaks
exactly the same fact through the table names, or a full-table decrypt per
chart. This is the least-bad option, and the leak is a category, not a datum.

### 4.3 `sourceHash` — keyed blind index, **not** the source key

**Tables:** everything ingestible, plus `exercises` (over `slug`) and
`integrations` (over `provider`).

Storing `sourceKey` in the clear was the obvious design and it is wrong:
`apple-health:body-mass:2026-07-26` announces that the user weighs themselves,
`off:5000159407236` names the chocolate bar they scanned, and
`rehab-shoulder-external-rotation` is a medical inference. So instead:

```
sourceHash = base64url( HMAC-SHA-256( indexKey, "<table>.<field> <value>" )[0..16] )
indexKey   = HKDF-SHA-256( rawDEK, info = "hcvault/blind-index/v1" )
```

- **Deterministic**, so idempotent upsert works: the same Apple Health datum
  always produces the same token, hence an update rather than a duplicate.
- **Opaque** without the DEK. 128 bits, birthday bound ~2^64 rows.
- **Domain-separated** per table+field, so the same string in two tables yields
  unrelated tokens.
- Derived from the DEK by HKDF with a distinct `info`, so it is
  cryptographically independent of the encryption key.

**The cost, stated plainly:** a blind index supports exact match only. No
prefix search, no range, no sort. That is why food and exercise *name* search is
in-memory over decrypted rows (§6) rather than an index scan.

### 4.4 `updatedAt` — epoch ms

**Tables:** all.

Needed to order rows without decrypting them: backup diffing, last-write-wins
merge, "what changed since". Leaks when the user touched the app, which the
filesystem already leaks. Non-negotiable for the backup system to work.

### 4.5 `deleted` — 0 | 1

**Tables:** all.

Every list query filters on it, and IndexedDB cannot index `null`, so a nullable
`deletedAt` is unusable as a column. Leaks only that *a* row was deleted, never
which one or what it held. Soft delete matters because it is what stops a
re-import resurrecting something the user removed on purpose.

### 4.6 Foreign keys — `sessionId`, `exerciseId`, `mesocycleId`, `programId`

**Tables:** `workoutSets`, `workoutSessions`, `mesocycles`, `personalRecords`.

These are **random UUIDs**. They are not derived from content and reveal
nothing about it. What they reveal is *graph structure*: that 12 sets belong to
one session, that 4 sessions belong to one block. A blind index would work here
too but would buy nothing — the identifier is already opaque — while costing an
HMAC per row on every write.

### Everything else

Names, values, weights, notes, macros, tokens, coach names, insight text,
barcodes, exercise slugs, integration provider names, and every number the user
cares about live **inside the ciphertext**. `vault.verify.mjs` §3 asserts this
directly against the raw IndexedDB rows.

---

## 5. Tables

22 encrypted tables plus one deliberately-unencrypted meta table.

Legend for the "plaintext" column: `dk` = `dateKey`, `ty` = `type`,
`sh` = `sourceHash` (blind index over the field named in brackets), `fk` = the
listed foreign keys. `id`, `updatedAt`, `deleted` and `v` are on every row and
are not repeated.

| Table | Plaintext | Indexes | Body |
|---|---|---|---|
| `profile` | — | `id, updatedAt` | singleton, id `profile`. Name, birth date, sex, height, activity level, time zone, unit preference |
| `settings` | — | `id, updatedAt` | singleton, id `settings`. Auto-lock config, backup reminder cadence, week start, UI prefs |
| `goals` | dk[`startDateKey`] | `+[deleted+updatedAt]` | direction, target rate kg/wk, target weight, protein override, active flag |
| `weightEntries` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | `kg`, `measuredAt`, `bodyFatPct`, note, ingest fidelity |
| `bodyMeasurements` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | `sitesCm` map over 13 sites |
| `foods` | sh[`sourceKey`] | `+[deleted+updatedAt]` | name, brand, **barcode**, `per100g` nutrients, servings, use counters |
| `foodLogs` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | slot, foodId, label snapshot, grams, **pre-multiplied** nutrients |
| `recipes` | sh[`sourceKey`] | `+[deleted+updatedAt]` | ingredients, servings, cached totals |
| `meals` | dk, sh[`sourceKey`] | `+[deleted+updatedAt]` | reusable bundle of log items |
| `exercises` | sh[**`slug`**] | `+[deleted+updatedAt]` | slug, name, primary/secondary `Muscle[]`, equipment, SFR, substitutes |
| `programs` | sh[`sourceKey`] | `+[deleted+updatedAt]` | day → slot template, per-muscle landmark overrides |
| `mesocycles` | dk[`startDateKey`], fk`programId` | `+[deleted+dateKey]` | weeks, deload flag, starting RIR, starting sets/muscle, status |
| `workoutSessions` | dk, sh[`sourceKey`], fk`mesocycleId` | `+[deleted+dateKey]` | start/end, kind (**incl. `personal_trainer`**), session RPE, coach name, note, **`trainerReport`** |
| `workoutSets` | fk`sessionId`,`exerciseId` | `+[deleted+sessionId]`, `+[deleted+exerciseId]` | load kg, **`magnitude`** (tagged union), RIR/RPE, warmup flag, technique, rest, **`rom`**, cached e1RM |
| `personalRecords` | dk, fk`exerciseId` | `+[deleted+exerciseId]` | kind, value, previous value, setId |
| `healthMetrics` | dk, **ty**, sh[`sourceKey`] | `+[type+dateKey]`, `+[deleted+type+dateKey]`, `+[deleted+dateKey]` | value, interval bounds, aggregation, ingest fidelity |
| `labRecords` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | LOINC, values, units, range status, provider and FHIR provenance |
| `sleepRecords` | dk (**wake day**), sh[`sourceKey`] | `+[deleted+dateKey]` | bedtime, wake, asleep/in-bed minutes, efficiency, stages, score, HRV, ingest fidelity |
| `readinessRecords` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | score, scored contributors, typed subjective and safety inputs, bounded load multiplier |
| `activities` | dk, sh[`sourceKey`] | `+[deleted+dateKey]` | type, duration, distance, active kcal, HR, elevation, Galpin zone, ingest fidelity |
| `integrations` | sh[**`provider`**] | `id, updatedAt, sourceHash` | **access + refresh tokens**, expiry, status, cursor |
| `insights` | dk, **ty** | `+[deleted+dateKey]`, `+[type+dateKey]` | severity, title, body, ruleId, score, `guardrailPassed`, evidence |
| `ingestLog` | dk, sh[`sourceKey`] | `id, updatedAt, dateKey, sourceHash` | channel, provider, counts, status, per-table breakdown |

### The set magnitude — why it is a union and not three fields

Before v2 a set stored `reps: number` plus a nullable `durationSec`, and the
unit lived nowhere. That made these two rows identical:

```
a 30-minute Zone 2 ride   → { reps: 0, durationSec: 1800 }
a set of zero reps        → { reps: 0, durationSec: null }
```

…and any screen rendering `set.reps` printed **"0 reps" for the ride**. Same
failure as the overloaded `default_rep_range` in the exercise library, which
`channel/013-training-schema-fix.md` already fixed once. Reintroducing it at the
storage layer would have been worse, because storage outlives every screen.

v2 stores one tagged value instead:

```ts
type SetMagnitude =
  | { repUnit: 'reps';    reps: number }
  | { repUnit: 'seconds'; seconds: number }
  | { repUnit: 'meters';  meters: number }
  | { repUnit: 'steps';   steps: number };
```

`magnitude` is **required, with no default** — a default is how the bug returns.
`WorkoutSet.reps` no longer exists, so the old mistake is a compile error rather
than a code-review item:

```ts
set.reps                 // ✗ Property 'reps' does not exist on type 'WorkoutSet'
set.magnitude.reps       // ✗ not on 'seconds' | 'meters' | 'steps'
switch (set.magnitude.repUnit) { case 'reps': set.magnitude.reps  /* ✓ */ }
```

`magnitudeValue(magnitude)` extracts the bare number for the cases that
genuinely need it — a chart axis, a sum over like-for-like sets. Rendering its
result without the unit alongside is the thing to avoid.

Distances are **metres** and loads are **kilograms**, as everywhere else in the
vault; yards and pounds are a display-boundary conversion via `src/lib/units`.

**`RangeOfMotion.unit` is the one deliberate exception to the SI rule.** ROM
measurements are `in`, `cm`, `deg`, `holes`, `notch` — self-describing readings
whose unit is part of the datum, not quantities awaiting conversion.
Normalising a rack notch to metres would destroy the meaning rather than
preserve it. The 16 Knees Over Toes movements in `training-methodology.md` §7
progress by depth, and without this field those ladders advance invisibly.

### `vaultMeta` — deliberately unencrypted

`{ key, value }`, indexed on `key`. Holds exactly what must be readable
**before** unlock:

| Key | Value | Why it is safe |
|---|---|---|
| `keyring` | the full `Keyring` | public by construction — salts, IVs and wrapped ciphertexts are worthless without the secret |
| `lastBackupAt` | epoch ms | so the backup nag can render **on the lock screen**, which is where a user who has not opened the app in a fortnight will see it |
| `pendingMediaCleanup` | boolean | crash-safe coordination flag set atomically by replace restore; it stays true until the separate encrypted media database has been cleared |
| `createdAt` | epoch ms | display only |
| `storagePersisted` | boolean | the `navigator.storage.persist()` grant, reported honestly |

Nothing derived from health data ever goes here.

---

## 6. Query patterns, and where the encryption bites

| Pattern | Cost | Notes |
|---|---|---|
| by `id` | 1 decrypt | |
| date range | N decrypts, N = rows in range | the index narrows *before* any crypto runs |
| one metric over a range | N decrypts | `[deleted+type+dateKey]` |
| sets in a session | N decrypts | `[deleted+sessionId]` |
| by `sourceKey` / slug / provider | 1 HMAC + 1 decrypt | blind index |
| **name search** (foods, exercises) | **full-table decrypt** | unavoidable — see below |
| count | **0 decrypts** | index-only |
| export | **0 decrypts** | rows are copied out still encrypted |

**Name search is the one genuinely awkward case.** Names are inside the
ciphertext, so there is no index to scan. Two mitigations, both already in the
design:

1. The bundled seed food DB (node I7) and the exercise library ship as **static
   assets**, searched before the vault is ever consulted. Those are the ~1,200
   rows that matter for search.
2. The vault-side catalogue is only cached lookups plus user-created entries —
   hundreds of rows, decrypting in single-digit milliseconds.

If that ever stops being true, the fix is a token-level blind index over
name trigrams, not a plaintext name column. Post to the channel first.

---

## 7. Idempotency

Every ingestible record carries a deterministic `sourceKey`, and
`upsertBySourceKey` is the write path for every pipeline.

**Convention:** `<source>:<kind>:<natural-identity>`

```
apple-health:body-mass:2026-07-26T07:12:00Z
apple-health:steps:2026-07-26
oura:sleep:2026-07-26
strava:activity:14237781933
off:5000159407236
paste:<sha-256 of the payload>             ← ingestLog batch key
```

Rules the implementation guarantees, all asserted in `vault.verify.mjs` §4–5:

1. Re-importing an identical batch inserts **nothing** and updates in place.
2. A **soft-deleted row is never resurrected** by a re-import. The user
   deleting something outranks a pipeline bringing it back.
3. A daily Shortcut/manual value never overwrites a higher-fidelity HAE file or
   `export.zip` value for the same natural key.
4. `ingestLog.hasSeen(batchKey)` lets node I2 skip parsing a payload it has
   already applied, before spending the CPU.
5. `bulkUpsertBySourceKey` does all crypto up front and lands the batch in a
   single `bulkPut`.

---

## 8. `.hcvault` backup format

Version 2. A single UTF-8 JSON document.

```jsonc
{
  "format": "hcvault",
  "formatVersion": 2,
  "createdAt": "2026-07-26T09:14:22.031Z",
  "app": { "dbVersion": 1, "bodyVersion": 1 },
  "vaultId": "…",
  "keyring": { "version": 1, "vaultId": "…", "wrappedKeys": [ … ] },
  "recordCount": 4213,
  "tables": {
    "weightEntries": [
      { "id": "…", "updatedAt": 1774512000000, "deleted": 0, "v": 1,
        "dateKey": "2026-07-26", "sourceHash": "…",
        "iv": "<base64url>", "ct": "<base64url>" }
    ]
  },
  "integrity": { "algorithm": "HMAC-SHA-256", "tag": "<base64url>" }
}
```

- **Self-contained.** The keyring travels with the data, so the file opens with
  the passphrase *or* the recovery code alone, on a device that has never seen
  this vault. This is asserted in `vault.verify.mjs` §11: the test wipes the
  database *and the keyring*, then restores from the file plus the recovery
  code and reads every record back.
- **Rows travel still encrypted**, byte-identical to IndexedDB. Export asks for
  the passphrase or recovery code so it can authenticate the complete envelope,
  but it does not decrypt row bodies or require an already-unlocked session.
- **Authenticated completeness.** `integrity.tag` is HMAC-SHA-256 over a
  canonical (key-sorted) serialisation of every field except `integrity`
  itself. Its key is derived from the raw DEK with HKDF and the
  backup-specific label `hcvault/backup-integrity/v2`. Every one of the 22
  known encrypted tables appears, even when empty. The tag therefore detects
  a removed table or row, changed ciphertext, schema header, count, plaintext
  index, or other envelope field—not merely accidental bit-rot.
- **Per-row authentication is still required.** AES-GCM AAD binds each body to
  `<table>|<id>`. Import decrypts every row and regenerates its plaintext date,
  type, foreign-key and blind-index headers; duplicates and mismatches block
  the whole operation.
- **The format exposes structure.** Bodies such as health values and notes stay
  encrypted, but table names, record counts, IDs, dates, categories, update
  times, tombstone state and the public keyring are readable. Treat the whole
  `.hcvault` file as private.
- **Tombstones are included** by default. Excluding them would mean a
  restore-then-reimport resurrects everything the user ever deleted.
- **Format 3 includes recorded videos without JSON/base64 amplification.** A
  signed JSON manifest is followed by each existing AES-GCM ciphertext raw.
  The manifest contains each ciphertext's byte length and SHA-256 digest; a
  purpose-separated `hcvault/backup-integrity/v3` HMAC authenticates the whole
  manifest. Export and import process one capped clip at a time with Blob
  slices. Safari export stages to OPFS via `createWritable()`, obtains a
  disk-backed `File` for Web Share, then removes the temporary entry.
- **Format 2 remains supported as vault-only.** A format-2 replace intentionally
  clears local recordings because the file contains none.
- **Media replacement is fail-closed.** Vault replace commits
  `pendingMediaCleanup=true` before the separate media store changes. The
  marker clears only after every backed-up pair is written. An interruption
  leaves startup blocked until partial/orphaned media is cleared or restore is
  retried.
- **Version 1 backup files are rejected.** Their public SHA-256 digest could be
  recomputed after removing a row or table. Open the older Keel build, restore
  there, and immediately re-export in v2 before moving to this build.

### Import modes

| Mode | Requires | Does | Cost |
|---|---|---|---|
| `replace` | backup secret; works on a blank device | authenticate every row and media entry; atomically clear/adopt/write vault rows and mark media cleanup; stream media pairs, then clear the marker | O(n) with one capped media ciphertext resident at a time |
| `merge` | backup secret and local vault **unlocked** | format 2/vault-only: last-write-wins under the local key; format 3 with media: explicitly rejected before writes because safe re-encryption is not yet streaming | O(n) decrypt + encrypt + writes for vault-only |

`previewImport()` is a real dry run: it parses, verifies the HMAC, decrypts and
validates every row, and compares every regenerated plaintext header. A wrong
secret or malformed record is therefore caught before any destructive step.
Export reads the keyring and all 22 tables in one point-in-time Dexie read
transaction. Merge prepares all WebCrypto results before opening one write
transaction. Replace clears and writes all vault tables and metadata in one
write transaction. A quota or write error rolls each operation back as a unit.
After a successful replace, the current session is synchronously reset and an
origin-scoped `BroadcastChannel` sends the same fixed reset signal to other
open Keel windows. The signal contains no vault id, key, record, or user data.

---

## 9. Threat model — what this does and does not defend against

| Threat | Defended? | How |
|---|---|---|
| Lost/stolen locked phone | ✅ | AES-256-GCM at rest, DEK not on disk |
| Forensic disk image | ✅ | as above; `vault.verify.mjs` §3 asserts no plaintext in raw rows |
| Someone borrows the unlocked phone | ⚠️ partly | auto-lock on idle + on background past a grace period |
| A backup file leaking from iCloud Drive | ⚠️ values protected | health bodies need the passphrase or recovery code; structural metadata remains visible, so treat the file as private |
| Rows, headers, or tables removed from a backup | ✅ | purpose-separated HMAC authenticates the complete canonical envelope; all known tables must be present |
| Passphrase guessing | ✅ | 600,000 PBKDF2 iterations ≈ 0.3–0.6 s per attempt on an iPhone |
| Row swapping / tampering in IndexedDB | ✅ | per-row AAD binds ciphertext to `<table>|<id>`; GCM tag |
| A server operator | ✅ | there is no server |
| **XSS in our own bundle** | ❌ | a script running in-page while unlocked can read the DEK. Mitigated by strict CSP, zero third-party code, and no `dangerouslySetInnerHTML` — but not eliminated |
| **A compromised OS / jailbroken device** | ❌ | game over, as it is for every app |
| **A forgotten passphrase with no recovery code** | ❌ | **by design.** The data is unrecoverable. Say so bluntly at setup |
| Traffic analysis of activity timing | ❌ | `updatedAt` and file mtimes leak when the app was used |

### On "zeroed on lock"

A `CryptoKey` handle cannot be zeroed from JavaScript — the bytes live in the
engine and the spec offers no wipe primitive. What actually happens on `lock()`:

- the raw 32-byte DEK buffer is overwritten with zeroes and dereferenced;
- the AES key used for row bodies was imported **non-extractable**, so even code
  holding the handle cannot read its bytes;
- both handles are dropped and become garbage-collectable.

After `lock()` the key material is unreachable from JS. We cannot promise it has
left physical memory, and this document will not claim otherwise.

### The deliberate trade: raw DEK bytes are retained while unlocked

The session keeps the raw DEK in memory (not just the key handle) so that
adding a recovery code, registering a passkey, or changing the passphrase can
re-wrap without demanding the passphrase again. In a browser, a script that can
call `exportKey` can also read that variable, so the practical difference
against the realistic attacker (in-page XSS) is nil — while the UX difference
is large. Stated here so the choice is visible rather than buried.

---

## 10. Verification

Two executable proof scripts. Both compile the real TypeScript and assert
against it; neither contains a second implementation to drift from.

```
node src/lib/crypto/crypto.verify.mjs    #  83 assertions — crypto core
node src/lib/db/vault.verify.mjs         # 263 assertions — schema, repos,
                                         #   unlock, v2 backup, restore,
                                         #   atomicity, body v1→v2
npx vitest run src/lib/db                #  20 assertions — body migration
```

The second runs the whole stack against `fake-indexeddb`, including a full
disaster-recovery drill (wipe the device *and its keyring*, restore from the
file plus the recovery code alone, read every record back) and an end-to-end
v1→v2 migration: a legacy row is forged on disk at `v: 1`, read through the
ordinary repository, and asserted to come back on the `seconds` arm rather than
as "0 reps".
