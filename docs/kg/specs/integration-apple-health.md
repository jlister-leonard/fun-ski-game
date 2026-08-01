# Integration Spec: Apple Health

**Status:** Draft for implementation — **two items require on-device verification before committing (§1)**
**Owner:** Integrations research
**Last updated:** 2026-07-26
**Governing doc:** [`docs/kg/ARCHITECTURE.md`](../ARCHITECTURE.md) — health data never leaves the device.

> **Verification note.** `developer.apple.com`, `support.apple.com` and `healthexportapp.com` are blocked by this
> environment's egress proxy, and the session's web-search budget was exhausted during research. Findings below come
> from Apple's own DTD as embedded in real exports, from shipped open-source implementations of this exact
> architecture, and from a **working pipeline I built and benchmarked** (§6.7). Unconfirmed items are tagged
> `[UNVERIFIED]`. **§1 contains two unresolved risks that can invalidate the chosen design — read it first.**

---

## 0. The foundational constraint

**There is no public Apple Health web API.** HealthKit is native-iOS-only and cannot be read from mobile Safari — not
via JavaScript, not via a permission prompt, not from an installed PWA. The store is on-device and encrypted, reachable
only by a native app holding entitlements plus user authorization.

Every "Apple Health integration" in a web product is really one of:
(a) a companion native app, (b) a file the user exports and hands over, (c) a third-party native app that pushes data
out, or (d) a Shortcut. We have no native app, so we are choosing among **(b), (c), (d)**.

**A second fact that shapes everything:** HealthKit data is **not readable while the device is locked.** There is direct
historical evidence of this biting Shortcuts specifically — the Workflow changelog records *"Fixed an issue where **Find
Health Samples** failed with an error when run from the Today Widget on a locked device."* Treat "read health data on a
locked phone" as unreliable.

---

## 1. ⚠️ Two risks to the chosen URL-fragment design

`ARCHITECTURE.md` §5.1 selects: *Shortcuts automation → build JSON → `Open URL https://<app>/#/ingest?d=…`*. The privacy
reasoning is sound — **URL fragments are genuinely never transmitted to the host**, so the data physically cannot reach
the server. But two mechanics threaten it, and both are cheap to test.

### 1.1 `Open URLs` opens **Safari**, not the installed PWA — and they have separate storage

iOS has no mechanism for an `https://` URL to launch an installed home-screen web app (that requires Universal Links,
which require a native app). A Shortcuts `Open URLs` action therefore lands in **Safari**.

A home-screen PWA on iOS has historically had its **own storage partition**: IndexedDB written by Safari is not visible
to the standalone PWA, and vice versa.

**Consequence: if the user followed our own onboarding advice to "Add to Home Screen" (which
`ARCHITECTURE.md` §3 makes a correctness requirement to avoid 7-day storage eviction), the automation would deliver
data into the Safari instance — a different, empty vault.** The two requirements are in direct tension.

`[UNVERIFIED for the latest iOS]` — partition behaviour has been stable for years, but confirm on-device.

This is not theoretical. A shipped app implementing this exact architecture (`FidesBV/Recovery`) instructs users:

> **PWA users:** If you use the app from your home screen, **remove the Open URLs action entirely**. The Shortcut just
> copies to clipboard; you open the PWA manually when ready.

They hit this and designed around it.

### 1.2 Unattended execution is unconfirmed

Whether a Time-of-Day personal automation with **"Run Immediately"** can foreground Safari via `Open URLs` with no tap —
on a locked device — could not be resolved. What is known:

- The toggle is real and is called **"Run Immediately"** (older iOS: *"Ask Before Running"*, turned **off**).
- The `Find Health Samples` read will likely **fail on a locked device** regardless (§0).
- Foregrounding an app from a background automation is an interrupt iOS is conservative about.
- **Both shipped implementations found chose clipboard + a manual tap** rather than relying on unattended URL delivery.

### 1.3 Recommendation

**Do not bet the architecture on unattended foregrounding.** Design for *"the automation prepares data silently; the
user taps once on next app open."* That is robust regardless of how the flags behave, and it costs one tap that
Safari's clipboard security model requires anyway.

**Proposed resolution — support both, detect which applies:**

| User's install state | Transport |
|---|---|
| Home-screen PWA (our recommended state) | **Clipboard** — `Copy to Clipboard` in the Shortcut; app shows an "import ready" banner; one tap calls `navigator.clipboard.readText()` |
| Safari tab (not installed) | **URL fragment** — `Open URLs` works, data lands in the right place |

Detect with `window.matchMedia('(display-mode: standalone)').matches` and **generate a different Shortcut for each
case in the setup wizard.** Both keep the identical privacy property: nothing reaches the host.

**Two items to verify on-device before committing:** the storage partition (§1.1) and unattended behaviour (§1.2).

---

## 2. Path (d): the Shortcuts pipeline

### 2.1 Ordered action list (wizard-renderable)

Action and field names below are as users actually see them, reconstructed from two shipped setup wizards
(`goforgoldipo/biotrack-dashboard`, `FidesBV/Recovery`).

**Phase 1 — Create**
1. Open the **Shortcuts** app.
2. Tap **+** (top right). Name it *"Sync Health"*.
3. Tap the search bar at the bottom to add actions.

**Phase 2 — Health reads.** One **`Find Health Samples`** action per metric. Configure **Aggregate** and **Period**,
then add **`Set Variable`**:

| Sample type | Aggregate | Period | Variable |
|---|---|---|---|
| Steps | Sum | Today | `steps` |
| Active Energy Burned | Sum | Today | `activeCalories` |
| Resting Heart Rate | Latest | Last 7 days | `restingHR` |
| Heart Rate | Average | Today | `avgHR` |
| Heart Rate Variability | Average | Last 24 hours | `hrv` |
| VO2 Max | Latest | Last 30 days | `vo2max` |
| Apple Stand Hour | Count | Today | `standHours` |
| Body Mass | Latest | Last 30 days | `weight` |
| Body Fat Percentage | Latest | Last 30 days | `bodyFat` |
| Lean Body Mass | Latest | Last 30 days | `leanMass` |
| Sleep Analysis | — | Last 24 hours | `sleep` |
| Dietary Energy / Protein / Carbohydrates / Fat Total / Fiber / Water | Sum | Today | … |
| **`Find Workouts`** (separate action) | Sort: Newest First, Limit 1 | — | `lastWorkout` |

**Phase 3 — Build the payload**
- Add **`Dictionary`**, or a **`Text`** action containing a JSON template with magic-variable chips inserted.
- For workout fields: insert the `lastWorkout` variable, then **tap the chip** to pick the property (*Workout Type*,
  *Duration* → set unit *Minutes*).
- Date keys: **`Current Date`**, formatted via the chip.

**Phase 4 — Deliver**
- **`Get Text from Dictionary`** → Input: the Dictionary.
- **`Copy to Clipboard`** → Input: that text. *(primary transport — see §1.3)*
- *(Safari-only users)* **`Open URLs`** → `https://<app>/#/ingest?v=1&d=…`. **Omit for home-screen PWA users.**
- **`Show Notification`** → Title *"Health synced ✓"*, Body *"Open the app and tap Import"*.

**Phase 5 — Automate**
- **Automation** tab → **+** → **Personal Automation** → **Time of Day** → pick time → **Daily**.
- Action: **`Run Shortcut`** → *"Sync Health"*.
- Toggle **Run Immediately** ON (older iOS: **Ask Before Running** OFF).
- `biotrack` schedules **four** automations/day (4am, 12pm, 5pm, 11pm) against one shortcut — a pragmatic hedge against
  any single firing being missed. Worth copying.

### 2.2 Capability boundary — what Shortcuts CANNOT do

Being blunt, because this determines whether Shortcuts can be the only path. **It cannot.**

**Reads fine:** scalar quantity types with aggregation — steps, distance, active/basal energy, heart rate (avg/min/max),
resting HR, walking HR, HRV SDNN, VO2 max, body mass, body fat %, lean mass, height, respiratory rate, SpO2, dietary
items, flights climbed, stand hours, mindful minutes.

**Loses badly:**

- **Sleep stages.** `[UNVERIFIED]` The Shortcuts sleep surface is coarse. Even where category samples return, you get
  segments you must stitch yourself, and the Core/Deep/REM/Awake breakdown is awkward-to-impossible to aggregate inside
  Shortcuts (there is no group-by). **This is the single biggest loss — and it is exactly what a health-coach app
  wants.**
- **Workout routes.** No GPX, no per-point GPS. Gone.
- **Intra-workout heart-rate streams.** Summary HR at best, not the series.
- **Per-workout splits / laps / pause events.** Gone.
- **High-frequency series generally.** No streaming, no group-by-day. Pulling a year of 5-minute heart rate is
  impractical. It is an *aggregate-per-run* tool, not a bulk-history tool.
- **Metadata** (`HKWasUserEntered`, motion context, timezone, device provenance). Gone.

**Conclusion: Shortcuts is a good daily-increment mechanism and a bad backfill/fidelity mechanism.**

### 2.3 URL length and chunking (if using the fragment path)

`[UNVERIFIED]` No number could be pinned for iOS Safari via Shortcuts `Open URLs`. The commonly cited WebKit ceiling is
~80,000 chars, but the Shortcuts→`UIApplication.open` hop is a separate, undocumented, likely lower limit.

**Design against 2,000 characters total URL as universally safe; 8,000 as an aggressive-but-probably-fine ceiling.**
Do not exceed 8,000 without on-device testing.

**Measured density** — compact columnar JSON (keys once, values as parallel arrays), base64url:

| Span | Verbose JSON → b64url | **Compact columnar → b64url** |
|---|---|---|
| 1 day | 300 → 400 | 304 → **406** |
| 7 days | 1,991 → 2,655 | 741 → **988** |
| 30 days | 8,480 → 11,307 | 2,423 → **3,231** |
| 365 days | 102,751 → 137,002 | 26,679 → **35,572** |

**A daily incremental sync fits in one ~400-char fragment uncompressed.** Chunking is only needed for backfill — and
backfill should use `export.zip` anyway (§6).

Chunking scheme:
```
#/ingest?v=1&id=<uuid>&seq=<n>&of=<total>&d=<base64url-chunk>
```
Buffer chunks in IndexedDB keyed by `id`; apply only when `seq` 1..`of` are all present; include a `sha` of the
reassembled payload.

**Two footguns:**

1. **Never parse the fragment with `URLSearchParams`.** It applies form decoding, so a `+` in standard base64 becomes a
   space and silently corrupts the payload. Use **base64url** (`-`/`_`, no `=`) and hand-split on `&`/`=`.
2. Shortcuts' `Base64 Encode` emits **standard** base64 with a *Line Breaks* option. Set Line Breaks to **None** and
   convert to base64url with a `Replace Text` action, or make the decoder accept both alphabets.

`[UNVERIFIED]` Whether Shortcuts can gzip a *string*: `Make Archive` operates on files. Given the density above,
**don't bother** — uncompressed compact JSON is small enough.

### 2.4 Clipboard transport (recommended primary)

- **No length limit** in practice.
- **Works with an installed home-screen PWA** — no partition split.
- Same privacy guarantee: no server hop.
- `navigator.clipboard.readText()` is supported on Safari/iOS **13.1+**, requires a user gesture, and shows a system
  "Paste" confirmation — hence the one tap.

---

## 3. Path (b): the `export.zip` — **recommended primary for fidelity**

### 3.1 Producing it

Health app → **profile picture / initials** (top right; if not visible tap **Summary** or **Browse** and scroll to top)
→ scroll to bottom → **Export All Health Data** → **Export** → share sheet (Save to Files / AirDrop).

**Real-world caveat:** if the user gets *"Could not export data"*, have them **increase Auto-Lock** (Settings → Display
& Brightness) and retry. Exports are also **sometimes simply corrupt**. Handle parse failure gracefully and tell the
user to re-export rather than showing a stack trace.

### 3.2 Archive structure

```
apple_health_export/
├── export.xml              ← 95%+ of the bytes
├── export_cda.xml          ← FHIR/CDA clinical records; empty for most people
├── electrocardiograms/     ← ecg_2020-09-24.csv, one per ECG
└── workout-routes/         ← route_2021-01-28_5.21pm.gpx, one per outdoor workout
```

### 3.3 `export.xml` schema

The file carries an **embedded internal DTD subset** (no external URL). Current is **HealthKit Export Version 14**.

```xml
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>

<!ELEMENT ExportDate EMPTY>  <!ATTLIST ExportDate value CDATA #REQUIRED>

<!ELEMENT Me EMPTY>
<!ATTLIST Me
  HKCharacteristicTypeIdentifierDateOfBirth                 CDATA #REQUIRED
  HKCharacteristicTypeIdentifierBiologicalSex               CDATA #REQUIRED
  HKCharacteristicTypeIdentifierBloodType                   CDATA #REQUIRED
  HKCharacteristicTypeIdentifierFitzpatrickSkinType         CDATA #REQUIRED
  HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse CDATA #REQUIRED>   <!-- v14 only -->

<!ELEMENT Record ((MetadataEntry|HeartRateVariabilityMetadataList)*)>
<!ATTLIST Record
  type CDATA #REQUIRED   unit CDATA #IMPLIED   value CDATA #IMPLIED
  sourceName CDATA #REQUIRED   sourceVersion CDATA #IMPLIED   device CDATA #IMPLIED
  creationDate CDATA #IMPLIED  startDate CDATA #REQUIRED   endDate CDATA #REQUIRED>

<!-- NOTE: Records appearing as children of a Correlation ALSO appear as top-level records. -->
<!ELEMENT Correlation ((MetadataEntry|Record)*)>

<!ELEMENT Workout ((MetadataEntry|WorkoutEvent|WorkoutRoute|WorkoutStatistics)*)>
<!ATTLIST Workout
  workoutActivityType CDATA #REQUIRED
  duration CDATA #IMPLIED   durationUnit CDATA #IMPLIED
  totalDistance CDATA #IMPLIED   totalDistanceUnit CDATA #IMPLIED
  totalEnergyBurned CDATA #IMPLIED   totalEnergyBurnedUnit CDATA #IMPLIED
  sourceName CDATA #REQUIRED   startDate CDATA #REQUIRED   endDate CDATA #REQUIRED>

<!ELEMENT WorkoutActivity ((MetadataEntry)*)>   <!-- v14: multisport segments -->
<!ELEMENT WorkoutEvent ((MetadataEntry)*)>
<!ATTLIST WorkoutEvent type CDATA #REQUIRED date CDATA #REQUIRED>

<!ELEMENT WorkoutStatistics EMPTY>
<!ATTLIST WorkoutStatistics
  type CDATA #REQUIRED  startDate CDATA #REQUIRED  endDate CDATA #REQUIRED
  average CDATA #IMPLIED  minimum CDATA #IMPLIED  maximum CDATA #IMPLIED
  sum CDATA #IMPLIED  unit CDATA #IMPLIED>

<!ELEMENT WorkoutRoute ((MetadataEntry|FileReference)*)>
<!ELEMENT FileReference EMPTY>  <!ATTLIST FileReference path CDATA #REQUIRED>

<!ELEMENT ActivitySummary EMPTY>
<!ATTLIST ActivitySummary
  dateComponents, activeEnergyBurned, activeEnergyBurnedGoal, activeEnergyBurnedUnit,
  appleMoveTime, appleMoveTimeGoal,          <!-- v11 called this appleMoveMinutes -->
  appleExerciseTime, appleExerciseTimeGoal, appleStandHours, appleStandHoursGoal>

<!ELEMENT MetadataEntry EMPTY>  <!ATTLIST MetadataEntry key CDATA #REQUIRED value CDATA #REQUIRED>

<!ELEMENT HeartRateVariabilityMetadataList (InstantaneousBeatsPerMinute*)>
<!ELEMENT InstantaneousBeatsPerMinute EMPTY>
<!ATTLIST InstantaneousBeatsPerMinute bpm CDATA #REQUIRED time CDATA #REQUIRED>
```

Also present in v14: `Audiogram` + `SensitivityPoint`, `VisionPrescription`, `ClinicalRecord`.

### 3.4 The iOS 15+ `WorkoutStatistics` change

Pre-iOS-15, `Workout` totals lived in the `totalDistance` / `totalEnergyBurned` attributes. **From iOS 15,
`WorkoutStatistics` children carry the real per-metric numbers** and the legacy attributes may be absent.

```xml
<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="88.23" durationUnit="min" ...>
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypePause"  date="2020-05-27 17:45:00 +0100"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="..." endDate="..."
                     average="92.5" minimum="65" maximum="125" unit="count/min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="342.5" unit="Cal" .../>
  <WorkoutRoute sourceName="..." startDate="..." endDate="...">
    <FileReference path="/workout-routes/route_2024-12-13_11.59am.gpx"/>
  </WorkoutRoute>
</Workout>
```

**Parse rule:** prefer `WorkoutStatistics` matching `HKQuantityTypeIdentifierDistanceWalkingRunning` /
`…ActiveEnergyBurned` / `…HeartRate`; fall back to the `Workout` attributes.
**An iOS 16 bug wrote `endDate` as a second `startDate`** on `WorkoutStatistics` — tolerate duplicate/malformed date
attributes.

### 3.5 Dates and timezones

Format: **`yyyy-MM-dd HH:mm:ss Z`** → `2024-03-01 07:14:22 -0800`. The offset is `±HHMM` **with no colon**, so this is
**not ISO-8601** and `new Date(str)` is unreliable. Parse with a regex and construct explicitly.

The offset is the *local offset at capture time*, so a year of data contains DST shifts. Store UTC plus the original
offset so local wall-clock can be reconstructed. `HKTimeZone` sometimes appears as a `MetadataEntry`
(e.g. `America/Los_Angeles`) — use it when present.

### 3.6 Record types and the locale trap

Canonical HealthKit units:

| Identifier (`HKQuantityTypeIdentifier…`) | Canonical unit |
|---|---|
| `StepCount`, `FlightsClimbed`, `PushCount`, `BodyMassIndex` | `count` |
| `DistanceWalkingRunning`, `DistanceCycling`, `DistanceSwimming` | `m` |
| `ActiveEnergyBurned`, `BasalEnergyBurned`, `DietaryEnergyConsumed` | `kcal` |
| `HeartRate`, `RestingHeartRate`, `WalkingHeartRateAverage`, `RespiratoryRate` | `count/min` |
| `HeartRateVariabilitySDNN` | `ms` |
| `VO2Max` | `ml/(kg*min)` |
| `BodyMass`, `LeanBodyMass` | `kg` |
| `Height`, `WaistCircumference` | `m` |
| `BodyFatPercentage`, `OxygenSaturation`, `AppleWalkingSteadiness` | `%` |
| `BloodPressureSystolic`, `BloodPressureDiastolic` | `mmHg` |
| `BloodGlucose` | `mg/dL` |
| `BodyTemperature`, `AppleSleepingWristTemperature` | `degC` |
| `AppleExerciseTime`, `AppleStandTime`, `AppleMoveTime` | `min` |
| `Dietary{Protein,Carbohydrates,FatTotal,Fiber,Sugar,Sodium,Cholesterol}` | `g` |
| `DietaryWater` | `L` |
| `WalkingSpeed`, `RunningSpeed`, `CyclingSpeed` | `m/s` |
| `RunningPower`, `CyclingPower` | `W` |

> 🚨 **Do not hard-code these.** The exported `unit=` attribute is **locale- and settings-dependent**. Verified in real
> exports: distance as `km` *or* `mi`; height as `cm`; energy as **`Cal`** *or* `kcal`; VO2 max as `mL/min·kg`. Blood
> glucose can carry a molar-mass-annotated unit string: `unit="mmol&lt;180.1558800000541&gt;/L"`.
> **Always read `unit` off the record and normalize at ingest.**

**Sleep.** `HKCategoryTypeIdentifierSleepAnalysis` carries a *string* in `value`:

```
HKCategoryValueSleepAnalysisInBed
HKCategoryValueSleepAnalysisAsleepUnspecified
HKCategoryValueSleepAnalysisAsleepCore     ← iOS 16+
HKCategoryValueSleepAnalysisAsleepDeep     ← iOS 16+
HKCategoryValueSleepAnalysisAsleepREM      ← iOS 16+
HKCategoryValueSleepAnalysisAwake          ← iOS 16+
HKCategoryValueSleepAnalysisAsleep         ← LEGACY, pre-iOS 16
```

Sleep records have **no `unit`**; duration is `endDate − startDate`. **Stage segments overlap `InBed` segments — sum
stages, never sum everything.**

**Blood pressure.** `HKCorrelationTypeIdentifierBloodPressure` wraps two child `Record`s. ⚠️ Per the DTD's own comment
those children **also appear as top-level records**, so a naive parser double-counts. Either skip `Record`s nested under
`Correlation`, or dedupe on `(type, startDate, sourceName, value)`.

### 3.7 Size reality and the browser-side parse — **validated**

Real volumes: **1.94M records for ~4 years** on a normal user; heavy users report 100 MB to multi-GB `export.xml` with
millions of `<Record>` elements. **DOM parsing is not an option** — `DOMParser` on a 500 MB string will OOM an iPhone
tab instantly.

A pipeline built with **only Web APIs** (no Node built-ins) was benchmarked during research:

```
95 MB / 300,000 records   →  2.4 s   (127k rec/s),  130 MB RSS
1.37 GB / 3,000,000 recs  →  21.3 s,                107 MB peak RSS   ← memory flat regardless of file size
```

**Architecture:**

1. `<input type="file" accept=".zip">` → a `File` (a `Blob`).
   **`showOpenFilePicker` is NOT supported in Safari** — use the input element.
2. Post the `File` to a **Web Worker** (structured-cloneable, zero-copy).
3. **Read the ZIP central directory yourself.** `DecompressionStream` does *not* understand the ZIP container — only raw
   streams. Scan backwards from EOF for the End-of-Central-Directory signature `0x06054b50`, then walk the Central
   Directory (`0x02014b50`) for `{name, method, compSize, uncompSize, localHeaderOffset}`.
   - ⚠️ **Take sizes from the Central Directory, not the Local File Header** — Apple's zip commonly uses data
     descriptors (GP flag bit 3), leaving LFH sizes zero.
   - ⚠️ **ZIP64:** exports >4 GB (or with `0xFFFFFFFF` sentinels) need the ZIP64 EOCD locator. Detect and **fail loudly**
     rather than silently truncating.
4. `blob.slice(dataStart, dataStart + compSize).stream()`
   `.pipeThrough(new DecompressionStream('deflate-raw'))` for method 8; raw for method 0.
5. `.pipeThrough(new TextDecoderStream())` — stateful, so multi-byte UTF-8 split across chunks is handled correctly.
6. Feed chunks to **`saxes`**. **`saxes` is pure JS with zero Node built-ins** (its only dependency is `xmlchars`) and
   runs fine in a Web Worker — it benchmarked **3.3× faster than `sax`** (157k vs 48k rec/s). `sax` also works. Only
   `node-expat` is genuinely unusable (native binding). Both handle Apple's internal DTD subset without complaint.
7. Accumulate rows and `put()` into **IndexedDB in batches of ~5,000** inside one transaction per batch. **Never build a
   full array.**

**Browser support floor:**

| API | Safari / iOS Safari |
|---|---|
| `DecompressionStream` / `CompressionStream` | **16.4** ← binding constraint |
| `Blob.stream()`, `TextDecoderStream` | 14.1 |
| `navigator.clipboard.readText()` | 13.1 |
| `StorageManager.estimate()` | 15.2 / 17 |

**Minimum target: iOS 16.4.** To go lower, bundle a WASM/JS inflate (`fflate`) instead of `DecompressionStream`.

**Storage:** call `navigator.storage.estimate()` and `persist()` *before* a big import. iOS origin quota is not generous
and eviction is real. A multi-million-record import may need downsampling — **keep raw for 90 days, daily rollups
beyond**. `[UNVERIFIED — exact current iOS quota behaviour.]`

---

## 4. Path (c): Health Auto Export — still useful without a server

Its REST-API mode POSTs to a server we don't have. **But its file-export automations (iCloud Drive / Dropbox / Files)
produce the same JSON on-device**, which the user hands to the PWA via `<input type="file">`. That yields
background-scheduled, high-fidelity data with no server — strictly better than Shortcuts on fidelity.

**Cost:** REST API *and* background sync are **Premium**; a user reports **Premium Lifetime at $24.99**. Basic
(one-time) covers manual export + Shortcuts. `[Basic price UNVERIFIED.]`

> **Key decision: adopt Health Auto Export's JSON shape as our single internal wire format.** Then one parser serves all
> three producers — the Shortcut emits HAE-shaped JSON, the HAE app emits it natively, and the `export.xml` reader emits
> the same shape. This is exactly what `FidesBV/Recovery` did.

### 4.1 Envelope

```jsonc
{ "data": { "metrics": [], "workouts": [], "stateOfMind": [], "medications": [],
            "symptoms": [], "cycleTracking": [], "ecg": [], "heartRateNotifications": [] } }
```
Every key optional; an empty export is literally `{"data":{}}`.

### 4.2 Metric datum variants — **branch on `metrics[].name`, never on datum shape**

```jsonc
// standard
{ "date": "2024-09-12 00:00:00 +0200", "qty": 206, "source": "" }
// heart_rate (aggregated) — CAPITALISED keys
{ "date": "...", "Min": 51, "Avg": 104.19, "Max": 183, "source": "Pavel – Apple Watch" }
// blood_pressure
{ "date": "...", "systolic": 136, "diastolic": 69 }
// blood_glucose
{ "date": "...", "qty": 4.59, "mealTime": "Before Meal" | "After Meal" | "Unspecified" }
// insulin_delivery         { "reason": "Bolus" | "Basal" }
// handwashing/toothbrushing{ "qty": N, "value": "Complete" | "Incomplete" }
// sexual_activity — note SPACES inside key names
{ "date": "...", "Unspecified": N, "Protection Used": N, "Protection Not Used": N }
```

### 4.3 `sleep_analysis` — durations are **hours as floats**, stage keys **lowercase**

```json
{ "date":"2024-09-11 21:41:57 +0200",
  "sleepStart":"2024-09-11 22:02:58 +0200", "sleepEnd":"2024-09-12 05:57:58 +0200",
  "inBedStart":"2024-09-11 21:41:57 +0200", "inBedEnd":"2024-09-12 06:00:15 +0200",
  "inBed":8.305, "totalSleep":7.75, "asleep":0,
  "core":5.175, "deep":0.867, "rem":1.708, "awake":0.158,
  "source":"Pavel – Apple Watch|Pavel - iPhone" }
```

- **`asleep` = *uncategorised* sleep, NOT total.** `totalSleep` is newer and optional.
- Multiple sources are **pipe-joined** in one string.
- `inBedStart`/`inBedEnd` **regressed to missing in v8.2.12** (fixed Aug 2025) — parse defensively or get `Invalid Date`.
- Pre-v6.6.2 used `sleepSource`/`inBedSource` and had no stage keys.
- There is **no** capital-`Core`/`Deep`/`REM` variant in the aggregated object — title-case appears only in the
  *unaggregated* `value` field (`"Awake"|"Asleep"|"In Bed"|"Core"|"REM"|"Deep"|"Unspecified"`).

### 4.4 Workouts v2

Scalars are `{"qty":N,"units":"…"}`; series are arrays.

`id`, `name`, `start`, `end`, `duration` (float **seconds**), `location`, `isIndoor`, `activeEnergyBurned`,
`totalEnergy`, `intensity` (MET), `distance`, `speed`/`avgSpeed`/`maxSpeed`, `temperature`, `humidity`,
`elevationUp`/`elevationDown`, `maxHeartRate`, `avgHeartRate`, `heartRate:{min,avg,max}`, plus arrays
`heartRateData[]`/`heartRateRecovery[]` (`{date,Min,Avg,Max,units,source}`), `stepCount[]`, `activeEnergy[]`,
`walkingAndRunningDistance[]`, `route[]`
(`{latitude,longitude,altitude,course,courseAccuracy,speed,speedAccuracy,horizontalAccuracy,verticalAccuracy,timestamp}`),
`metadata{}`.

**v1→v2 breaking changes:** v1 had no `id`/`duration`; `elevation:{ascent,descent,units}` became
`elevationUp`/`elevationDown`; `heartRateData[]` items went `{date,qty,units}` → `{date,Min,Avg,Max,units,source}`;
`route[]` used `{lat,lon,altitude,timestamp}`; `stepCount`/`activeEnergy` were scalars, now arrays; v1 docs had the typo
`"intesity"`. **Nulls occur** (`"heartRateRecovery": null`), not just omissions.

**Real-world units differ from the docs** — `mi/hr` not `mph`, `count/min` not `spm`. Store the unit string.

### 4.5 Timestamps — parse defensively

Canonical `yyyy-MM-dd HH:mm:ss Z`, but locale-dependent. Formats seen in the wild:

```
2006-01-02 15:04:05 -0700
2006-01-02 3:04:05 PM -0700          (iOS "24-Hour Time" off)
2006-01-02 3:04:05 pm -0700
2006-01-02 3:04:05 PM -0700     ← U+202F NARROW NO-BREAK SPACE, newer iOS
```

**Normalize U+202F before parsing.**

### 4.6 Naming gotchas

Names are HAE's own snake_case, **never** `HKQuantityTypeIdentifier*`: `active_energy`, `basal_energy_burned`
(resting), `weight_body_mass`, `vo2max`, `cardio_recovery`, `heart_rate_variability`, `walking_running_distance`,
`blood_oxygen_saturation`, `breathing_disturbances`. Nutrition mostly **drops** the `dietary_` prefix (`protein`,
`calcium`, `carbohydrates`) *except* `dietary_energy`, `dietary_water`, `dietary_sugar`. And there is a typo in the
enum: **`monosaturated_fat`** (missing the "un").

**Idempotency keys:** `(date, source)` for metrics; `id` for v2 workouts; `(name, start)` for v1.

---

## 5. TypeScript interfaces

```ts
// ---------------------------------------------------------------------------
// Wire format — Health Auto Export shape. Emitted by ALL THREE producers.
// ---------------------------------------------------------------------------

export interface HaeEnvelope {
  data: {
    metrics?: HaeMetric[];
    workouts?: HaeWorkout[];
    [k: string]: unknown;
  };
}

export interface HaeMetric {
  /** HAE snake_case name, e.g. 'heart_rate_variability'. NOT an HK identifier. */
  name: string;
  units?: string;
  data: HaeDatum[];
}

/** Branch on the parent metric's `name`, never on datum shape. */
export type HaeDatum =
  | HaeStandardDatum
  | HaeAggregateDatum
  | HaeBloodPressureDatum
  | HaeSleepDatum;

export interface HaeStandardDatum {
  date: string;          // 'yyyy-MM-dd HH:mm:ss Z' — see §4.5
  qty: number;
  source?: string;
}

/** heart_rate and other aggregated metrics. Note CAPITALISED keys. */
export interface HaeAggregateDatum {
  date: string;
  Min?: number;
  Avg?: number;
  Max?: number;
  source?: string;
}

export interface HaeBloodPressureDatum {
  date: string;
  systolic: number;
  diastolic: number;
  source?: string;
}

/** sleep_analysis. ALL DURATIONS ARE HOURS AS FLOATS. Stage keys lowercase. */
export interface HaeSleepDatum {
  date: string;
  sleepStart?: string;
  sleepEnd?: string;
  /** Absent in HAE v8.2.12 — guard before parsing. */
  inBedStart?: string;
  inBedEnd?: string;
  inBed?: number;
  /** NEWER and optional. Prefer over summing when present. */
  totalSleep?: number;
  /** UNCATEGORISED sleep, NOT the total. */
  asleep?: number;
  core?: number;
  deep?: number;
  rem?: number;
  awake?: number;
  /** Multiple sources are PIPE-JOINED in one string. */
  source?: string;
}

export interface HaeQuantity { qty: number; units: string; }

export interface HaeWorkout {
  id?: string;                 // v2 only
  name: string;
  start: string;
  end: string;
  duration?: number;           // FLOAT SECONDS (v2)
  location?: string;
  isIndoor?: boolean;
  activeEnergyBurned?: HaeQuantity;
  totalEnergy?: HaeQuantity;
  intensity?: HaeQuantity;     // MET
  distance?: HaeQuantity;
  avgSpeed?: HaeQuantity;
  maxSpeed?: HaeQuantity;
  elevationUp?: HaeQuantity;   // v1: elevation:{ascent,descent,units}
  elevationDown?: HaeQuantity;
  temperature?: HaeQuantity;
  humidity?: HaeQuantity;
  avgHeartRate?: HaeQuantity;
  maxHeartRate?: HaeQuantity;
  heartRate?: { min?: number; avg?: number; max?: number };
  /** v2 item shape; v1 was {date,qty,units}. May be null, not just absent. */
  heartRateData?: Array<{ date: string; Min?: number; Avg?: number; Max?: number; units?: string }> | null;
  heartRateRecovery?: Array<{ date: string; Min?: number; Avg?: number; Max?: number }> | null;
  stepCount?: Array<{ date: string; qty: number }>;
  route?: Array<{
    latitude: number; longitude: number; altitude?: number;
    speed?: number; horizontalAccuracy?: number; verticalAccuracy?: number;
    timestamp: string;
  }>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// export.xml — raw parsed rows (Web Worker output)
// ---------------------------------------------------------------------------

export interface HkRecord {
  /** e.g. 'HKQuantityTypeIdentifierStepCount'. */
  type: string;
  /** LOCALE-DEPENDENT. Never assume — always read and normalize. */
  unit?: string;
  /** Numeric for quantity types; an enum STRING for category types. */
  value?: string;
  sourceName: string;
  sourceVersion?: string;
  device?: string;
  creationDate?: string;
  startDate: string;
  endDate: string;
  metadata?: Record<string, string>;
}

export interface HkWorkoutStatistics {
  type: string;
  startDate: string;
  endDate: string;
  average?: number;
  minimum?: number;
  maximum?: number;
  sum?: number;
  unit?: string;
}

export interface HkWorkout {
  workoutActivityType: string;
  duration?: number;
  durationUnit?: string;
  /** iOS 15+: may be ABSENT — prefer statistics. See §3.4. */
  totalDistance?: number;
  totalDistanceUnit?: string;
  totalEnergyBurned?: number;
  totalEnergyBurnedUnit?: string;
  sourceName: string;
  startDate: string;
  endDate: string;
  statistics: HkWorkoutStatistics[];
  events?: Array<{ type: string; date: string }>;
  /** Path into workout-routes/*.gpx inside the zip. */
  routeFileRefs?: string[];
  metadata?: Record<string, string>;
}

export interface HkActivitySummary {
  dateComponents: string;        // 'YYYY-MM-DD'
  activeEnergyBurned?: number;
  activeEnergyBurnedGoal?: number;
  activeEnergyBurnedUnit?: string;
  appleExerciseTime?: number;
  appleExerciseTimeGoal?: number;
  appleStandHours?: number;
  appleStandHoursGoal?: number;
  appleMoveTime?: number;
}

export interface HkExportMeta {
  locale: string;
  exportDate: string;
  dateOfBirth?: string;
  biologicalSex?: string;
  bloodType?: string;
}

// ---------------------------------------------------------------------------
// Ingest envelope — what the app actually receives, from any transport
// ---------------------------------------------------------------------------

export type IngestTransport = 'clipboard' | 'url_fragment' | 'file_zip' | 'file_json';

export interface IngestBatch {
  v: 1;
  transport: IngestTransport;
  /** Chunk reassembly (url_fragment only). */
  id?: string;
  seq?: number;
  of?: number;
  /** SHA-256 of the reassembled payload, hex. */
  sha?: string;
  payload: HaeEnvelope;
  received_at: string;
}
```

---

## 6. Canonical normalization

All three paths converge on the canonical model (see `channel/011-integrations-research.md`). Normalization rules:

| Rule | Detail |
|---|---|
| **Units → SI at ingest** | Read the source unit string; convert. `Cal`→kcal, `mi`→m, `cm`→m, HAE sleep **hours→seconds**. |
| **Dates** | Parse the Apple format with a regex (not `new Date`). Normalize U+202F first. Store UTC instant + original offset. |
| **Local day attribution** | `local_date` = wall-clock date at capture. A 6 am workout belongs to that local day. |
| **Sleep** | Sum **stages only** (`core+deep+rem`), never stages+inBed. Attribute the session to the **wake-up** local day. |
| **Blood pressure** | Skip `Record`s nested in `Correlation`, or dedupe — they appear twice (§3.6). |
| **Deduplication** | Metrics: `(metric, measured_at, source)`. Workouts: `(sport, start ±90s, duration ±60s)` across sources — the Watch and Strava both write the same run. |
| **Precedence** | `export.zip` (highest fidelity) > HAE file > Shortcut aggregate. A later low-fidelity write must never overwrite a higher-fidelity record. Store `fidelity` on each row and compare before upsert. |

---

## 7. Recommendation

**PRIMARY — `export.zip` → `<input type="file">` → Web Worker → IndexedDB.**
The only path delivering sleep *stages*, workout routes, intra-workout HR, metadata and full history. No third-party
app, no subscription, no network, no server. The pipeline was validated end-to-end with Web APIs only:
**1.37 GB / 3M records in 21 s at ~110 MB flat memory.** Cost: a manual ~2-minute export the user repeats occasionally.
For a single-user personal health-coach app that is an acceptable trade — and it is the only option that satisfies
"data never leaves the device" *while* giving a coach the fidelity it needs.

**FALLBACK / daily increment — Shortcut → HAE-shaped JSON → Clipboard → one tap in the PWA.**
Free, no third-party app, runs on a schedule, and sidesteps every URL-length and storage-partition hazard. Yields daily
aggregates only.

**OPTIONAL UPGRADE — Health Auto Export Premium (~$25 lifetime) writing JSON files to iCloud Drive**, picked up via the
same file input. Background-scheduled, far richer than Shortcuts, still serverless.

**On the URL-fragment design:** keep it, but as the **secondary** transport for non-installed Safari users, capped at
2,000-char chunks with base64url (never `URLSearchParams`). Do not make it the primary, for the three reasons in §1.
The clipboard achieves the identical privacy property with none of the risks.

**Two items need on-device verification before committing:** the PWA-vs-Safari storage partition (§1.1) and unattended
automation behaviour (§1.2). Both are cheap to test; both can invalidate a design.

---

## Sources

- Apple's embedded DTD, read from real `export.xml` files (HealthKit Export Version 11 and 14)
- [`FidesBV/Recovery`](https://github.com/FidesBV/Recovery) — shipped PWA using this exact architecture; source of the
  clipboard-over-URL finding and the HAE-shaped Shortcut output
- [`goforgoldipo/biotrack-dashboard`](https://github.com/goforgoldipo/biotrack-dashboard) — shipped Shortcuts setup
  wizard; source of the action/field names in §2.1
- [`k0rventen/apple-health-grafana`](https://github.com/k0rventen/apple-health-grafana) — record-volume figures and the
  export-failure/corruption caveats
- [`wlame/ahkit`](https://github.com/wlame/ahkit) — canonical `HKUnit`-per-type registry
- [`softwarehistorysociety/workflow`](https://github.com/softwarehistorysociety/workflow) — changelog evidence that
  `Find Health Samples` fails on a locked device
- `saxes` / `sax` / `xmlchars` package sources — Web Worker compatibility verified by inspection and benchmark
- MDN browser-compat-data for `DecompressionStream`, `TextDecoderStream`, `Blob.stream`, `navigator.clipboard.readText`
