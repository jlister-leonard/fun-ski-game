# Health Records (labs / bloodwork) — ingest, model, and safety

**Status:** v1.0 · **Owner:** health-records agent
**Depends on:** [`ARCHITECTURE.md`](../ARCHITECTURE.md) (authoritative),
[`integration-apple-health.md`](./integration-apple-health.md) (read-only, another agent's),
[`algorithms/guardrails.ts`](./algorithms/guardrails.ts) (the `Finding` type is reused, not duplicated)
**Owns:** [`lab-panels.json`](./lab-panels.json), [`algorithms/labs.ts`](./algorithms/labs.ts)
**Related, read-only:** [`micronutrients.json`](./micronutrients.json) (owner: nutrition-personalization),
[`athlete-profile.md`](./athlete-profile.md)

Confidence tags used throughout: `[well-established]` / `[reasonable-inference]` / `[uncertain]` /
`[UNVERIFIED]`. An untagged number is arithmetic, not a claim.

---

## 0. What this document is, and what it deliberately is not

This spec describes how the user's **laboratory results** get from their healthcare provider into
the app's encrypted vault, how they are modelled, and — at length, because it is the part that can
actually hurt someone — how the app is allowed to talk about them.

> **The app interprets labs the way a well-read coach does, and stops where a clinician's job
> starts.** [`advice-policy.md`](./advice-policy.md) is normative and defines the three tiers. §9
> maps them onto lab data.

**Revision note, v1.0 → v1.1.** This document originally said "the app displays and trends labs, it
does not interpret them." That was replaced by `advice-policy.md`, on the reasoning that an app
which renders a number and says "consult your doctor" has told the user nothing they could not read
off the PDF. I agree with the change: the old rule was not *safe*, it was *inert*, and inertness has
its own cost — a user who gets no steer from the app goes and gets a worse steer from a forum. §9
below is rewritten against the tiers. What did **not** change: the Tier 3 list (no diagnosis, no
medication advice, critical values get a prompt and no explanation), and the deduplication,
range-provenance and unit-refusal machinery in §5–§7, which are correctness properties rather than
caution.

---

## 1. Where the labs physically live — verified

This section is the single most important thing in the document, so it leads, and every claim
carries its evidence.

### 1.1 The short answer

The user's lab results live in **`apple_health_export/clinical-records/` inside the
"Export All Health Data" zip**, as **one FHIR JSON file per resource**, indexed by
`<ClinicalRecord>` elements inside `export.xml`. That directory — not `export.xml`, not
`export_cda.xml` — is the only place a browser can read them from. `[well-established]`

### 1.2 Claim-by-claim verification of the working hypothesis

| # | Claim as briefed | Verdict | Evidence |
|---|---|---|---|
| 1 | Apple Health stores provider clinical data as FHIR resources (`Observation`, `DiagnosticReport`, `Condition`, `MedicationRequest`, `AllergyIntolerance`, `Immunization`, `Procedure`) — different objects from `HKQuantitySample` | **Confirmed** `[well-established]` | Apple documents `HKClinicalRecord` as carrying an `HKFHIRResource`, with clinical type identifiers `allergyRecord`, `conditionRecord`, `immunizationRecord`, `labResultRecord`, `medicationRecord`, `procedureRecord`, `vitalSignRecord` ([Apple: Accessing a User's Clinical Records](https://developer.apple.com/documentation/healthkit/accessing-a-user-s-clinical-records)). `HKClinicalRecord` inherits `HKSample`, but it is not a quantity sample and has no `HKUnit`. |
| 2 | Exposed as `HKClinicalRecord`, requiring a **separate entitlement** | **Confirmed, and moot for us** `[well-established]` | Apple: "check the **Clinical Health Records** checkbox in the HealthKit capability and include the `NSHealthClinicalHealthRecordsShareUsageDescription` key in your app's `Info.plist`" — i.e. an additional entitlement *and* a second, distinct privacy string on top of `NSHealthShareUsageDescription`. **Moot** because we are a PWA: we have no HealthKit access of any kind, entitled or otherwise. |
| 3 | **NOT** reachable from Shortcuts' "Find Health Samples" | **`[UNVERIFIED]` — could not confirm or refute** | I could find no Apple documentation, and no credible user report, of Shortcuts returning clinical records. Absence of evidence is weak evidence. The *reasoning* for the claim is sound (`Find Health Samples` picks from quantity/category sample types; clinical records are `HKClinicalType`, behind a separate entitlement and privacy string that the Shortcuts app has no documented reason to hold), but I am not asserting it as fact. **It does not matter to the design**: see §1.4. |
| 4 | The export zip contains a `clinical-records/` directory of FHIR JSON, one file per resource, named `Observation-<id>.json`, alongside `export.xml`, `export_cda.xml`, `workout-routes/` | **Confirmed, and the brief understated it** `[well-established]` | See §1.3. Multiple independent open-source parsers read exactly this path, and a real `export.xml` DTD + instance data confirms the naming and adds an index element the brief did not know about. |

### 1.3 What is actually in the zip — corrected and enriched

```
apple_health_export/
├── export.xml              ← HK samples AND a <ClinicalRecord> index (see below)
├── export_cda.xml          ← HL7 **CDA** (Clinical Document Architecture). NOT FHIR.
├── clinical-records/       ← the FHIR JSON payloads, one file per resource
│   ├── Observation-8F2C…-….json
│   ├── DiagnosticReport-F011639A-7CDB-4E7F-B195-E4DFF6D2FB76.json
│   ├── Condition-….json  Immunization-….json  Procedure-….json
│   ├── MedicationOrder-… / MedicationRequest-… / MedicationStatement-…
│   ├── AllergyIntolerance-….json
│   └── Patient-6221D445-19F5-4DBB-A995-84FCAFF6F3B5.json
├── electrocardiograms/     ← ecg_YYYY-MM-DD.csv, one per ECG
└── workout-routes/         ← route_YYYY-MM-DD_h.mmam.gpx
```

**Four corrections / additions to the brief:**

1. **`export_cda.xml` is CDA, not FHIR.** CDA is HL7 v3 XML; FHIR is a different standard. The
   phrase "FHIR/CDA clinical records" in `integration-apple-health.md` §3.2 conflates them. We do
   **not** parse `export_cda.xml` — the same clinical content is available as FHIR JSON in
   `clinical-records/`, which is enormously easier to parse correctly. One published export had
   `export_cda.xml` at **1.6 GB**; skipping it is also a performance win.
   `[well-established]` — [aslobodnik/health-sync EXPORT-FORMAT.md](https://github.com/aslobodnik/health-sync/blob/main/EXPORT-FORMAT.md)

2. **`export.xml` carries a `<ClinicalRecord>` index.** This is the find that most improves the
   design, and the brief did not have it. The embedded DTD declares:

   ```xml
   <!ELEMENT ClinicalRecord EMPTY>
   <!ATTLIST ClinicalRecord
           type              CDATA #REQUIRED
           identifier        CDATA #REQUIRED
           sourceName        CDATA #REQUIRED
           sourceURL         CDATA #REQUIRED
           fhirVersion       CDATA #REQUIRED
           receivedDate      CDATA #REQUIRED
           resourceFilePath  CDATA #REQUIRED>
   ```

   and a real instance looks like:

   ```xml
   <ClinicalRecord type="DiagnosticReport"
                   identifier="T18EOBCL62BP9Ym5ddQzK9XS4fVSCMjR2n6K-7k8eOesB"
                   sourceName="Sutter Health"
                   sourceURL="https://apiservices.sutterhealth.org/ifs/api/FHIR/DSTU2/DiagnosticReport/T18EOBCL…"
                   fhirVersion="1.0.2"
                   receivedDate="2020-08-06 05:01:22 -0800"
                   resourceFilePath="/clinical-records/DiagnosticReport-F011639A-7CDB-4E7F-B195-E4DFF6D2FB76.json"/>
   ```

   `[well-established]` — DTD and instance from a real export published at
   [opendroid/hk `public/sampleexport.xml`](https://github.com/opendroid/hk/blob/master/public/sampleexport.xml);
   the same shape appears in [symptomatic/clinical-scenarios](https://github.com/symptomatic/clinical-scenarios).

   Why this matters, concretely:
   - `fhirVersion` tells us **per file** whether to parse as DSTU2 or R4 — we do not have to sniff.
   - `sourceName` gives per-record provider attribution for the "what actually arrived" screen (§10)
     and for dedup (§7).
   - `identifier` is the **provider's own resource id**, stable across re-exports — the backbone of
     the idempotency key.
   - `type` lets us skip non-lab resources without opening them.
   - The index means we can build the whole import plan from the XML stream and only open the JSON
     files we actually want.

3. **`resourceFilePath` has a leading slash and is relative to the export root**
   (`/clinical-records/…`), not an absolute filesystem path. Naïvely joining it to a base path
   produces `/clinical-records/…` and reads from the filesystem root. Strip the leading `/` and
   resolve against `apple_health_export/`. Some zips nest everything under `apple_health_export/`
   and some do not — probe for both. `[well-established]`, and defensive-coding advice from
   [HealthDelta `export_layout.py`](https://github.com/dave0875/HealthDelta), which probes both
   `clinical-records` and `clinical_records`.

4. **`HKClinicalRecord.startDate` / `endDate` are the *download* date, not the clinical date.**
   Apple states this explicitly. Any date used for a lab must come from inside the FHIR resource
   (`effectiveDateTime` / `effectivePeriod.start` / `issued`), never from HealthKit sample dates or
   from `ClinicalRecord@receivedDate`. `[well-established]` —
   [Apple: HKClinicalRecord](https://developer.apple.com/documentation/healthkit/hkclinicalrecord)

### 1.4 Why the Shortcuts question does not change the design

The PWA cannot call HealthKit at all. Whether or not Shortcuts can see clinical records, our
options are the same three, in priority order:

| Path | Status | Notes |
|---|---|---|
| **A. `export.zip` → `clinical-records/`** | **Primary. This is the design.** | Works offline, in-browser, in a Web Worker. Same zip the app already ingests for HK history, so labs are free once the user does the export they were going to do anyway. |
| **B. Provider-supplied FHIR JSON / C-CDA the user downloads from a patient portal** | Supported fallback | Many portals expose a "download my record" that emits a FHIR `Bundle`. The parser accepts a Bundle, a bare array, or a single resource. |
| **C. Manual entry** | Always available | Typed by hand into a form keyed by the `lab-panels.json` catalogue. The only path when a provider is not on Apple's list at all. |

If someone later proves Shortcuts *can* emit clinical records, it becomes path **A′** — a
convenience for incremental sync — and nothing in §3–§9 changes.

### 1.5 Does the export contain labs from *all* connected providers?

**`[uncertain]`.** I found no Apple statement either way, and no way to test without a real
multi-provider export.

What I can say:
- The `<ClinicalRecord>` index carries `sourceName` per record, so the export is *capable* of
  representing multiple providers, and there is no evidence Apple filters by provider.
  `[reasonable-inference]`
- The more likely cause of a missing lab is upstream: not every health system is in Apple's Health
  Records network, and participating systems publish differing subsets of their data. If a provider
  never sends a biomarker to Apple, no export can contain it. `[well-established]` — widely
  reported; consistent with [Apple: Download health records on iPhone](https://support.apple.com/guide/iphone/download-health-records-iphc30019594/ios).
- There is a persistent, half-true claim in Apple's own discussion forums that "the Health XML
  export does not include Health Records." The resolution is §1.3.2: `export.xml` contains only the
  *index*; the content is in the sibling directory. Someone parsing only the XML would reasonably
  conclude the records are absent. `[reasonable-inference]`

**Therefore the app never implies completeness.** After every import it shows a receipt (§10.2):
per provider, per resource type, counts and date range of what arrived. If the user's ferritin is
missing, the app says "no ferritin result found in this export" rather than silently drawing an
empty chart.

---

## 2. Ingest pipeline

All of this runs **in a Web Worker, on device**. No byte of it touches a network we operate. The
zip is read with the same streaming reader `integration-apple-health.md` §3 already specifies.

```
export.zip
  │
  ├─(1)─► stream export.xml ──► collect <ClinicalRecord> elements only
  │                             → ClinicalRecordIndexEntry[]  (cheap; no JSON opened yet)
  │
  ├─(2)─► filter to type ∈ {Observation, DiagnosticReport}
  │        (other types are stored raw but not modelled in v1 — see §11)
  │
  ├─(3)─► for each entry: read clinical-records/<file>.json
  │        → detect FHIR release from index fhirVersion, fall back to sniffing (§3.1)
  │        → normalize to NormalizedObservation / NormalizedPanel  (§3.4)
  │
  ├─(4)─► resolve unit → canonical (§5). Unknown pair ⇒ store verbatim, do not convert.
  │
  ├─(5)─► attach reference range (§6): lab-supplied first, general only as labelled fallback
  │
  ├─(6)─► compute sourceKey (§7) → upsert into vault, idempotently
  │
  └─(7)─► emit ImportReceipt (§10.2) for the UI
```

**Failure policy.** A single unparseable resource never fails the import. It increments a counter
in the receipt and is skipped. Corrupt exports are common enough that
`integration-apple-health.md` §3.1 already calls them out; the same graceful degradation applies.

---

## 3. The FHIR data model

### 3.1 Two FHIR releases, and how to tell them apart

Apple's Health Records supports **DSTU2 (v1.0.2)** and **R4 (v4.0.1)**. `HKFHIRRelease` has exactly
three cases: `dstu2`, `r4`, `unknown` — Apple's own words, "Each release can have multiple
versions." `[well-established]` —
[Apple: HKFHIRRelease](https://developer.apple.com/documentation/healthkit/hkfhirrelease)

History: Health Records shipped with DSTU2 in iOS 11.3 (2018); **R4 support arrived in iOS 14**, and
Apple now tells newly-registering organizations to use R4 (v4.0.1) if available, while continuing to
support DSTU2 and offering an upgrade path. `[well-established]` —
[Apple: Upgrade your FHIR version from DSTU2 to R4](https://support.apple.com/guide/healthregister/apd6587c878b/web),
[Apple: Technical requirements and specifications for Health Records](https://support.apple.com/guide/healthregister/technical-requirements-specifications-health-apd12d144779/web)

**A parser must handle both, and must handle them in the same export.** A user with two providers,
one upgraded and one not, gets a mixed-version `clinical-records/` directory. This is not
hypothetical — the historical records already downloaded under DSTU2 do not get rewritten.
`[reasonable-inference]`

Release detection, in order:

1. `ClinicalRecord@fhirVersion` from the index — `"1.0.2"` → DSTU2, `"4.0.1"` → R4. Authoritative.
2. If absent (path B/C imports), sniff on structural discriminators:

   | Discriminator | DSTU2 | R4 |
   |---|---|---|
   | `Observation.category` | object (`0..1`) | **array** (`0..*`) |
   | `Observation.interpretation` | object (`0..1`) | **array** (`0..*`) |
   | free-text note | `comments` (string) | `note` (`Annotation[]`) |
   | `referenceRange[].` range meaning | `meaning` | `type` |
   | linked observations | `related[]` (`{type,target}`) | `hasMember[]` / `derivedFrom[]` |
   | interpretation code system | `http://hl7.org/fhir/v2/0078` | `http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation` |
   | category code system | `http://hl7.org/fhir/observation-category` | `http://terminology.hl7.org/CodeSystem/observation-category` |
   | `DiagnosticReport.performer` | `0..1` Reference | `0..*` Reference (+ `resultsInterpreter`) |
   | `DiagnosticReport` conclusion codes | `codedDiagnosis[]` | `conclusionCode[]` |

   `[well-established]` — R4 element list and cardinalities read from the machine-generated
   `@types/fhir` R4 declarations
   ([DefinitelyTyped `types/fhir/r4.d.ts`](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/fhir/r4.d.ts));
   DSTU2 shapes read from canonical spec examples
   ([smart-on-fhir/dstu2-examples](https://github.com/smart-on-fhir/dstu2-examples), e.g.
   `observation-example-f001-glucose` which shows `interpretation` as a single object with system
   `http://hl7.org/fhir/v2/0078`).

3. **`array-or-object` tolerance is mandatory regardless.** Real-world producers are sloppy; a
   DSTU2-declared payload sometimes carries an R4-shaped array. Every accessor in `labs.ts` goes
   through `asArray()`, which accepts `undefined | T | T[]`. This costs nothing and removes a whole
   class of silent data loss. `[reasonable-inference]`

### 3.2 The wire types

Deliberately **narrow** — only the fields we read. Full FHIR typings are ~20k lines and would
violate the zero-dependency rule for no benefit. Anything not modelled here is preserved verbatim
in `rawJson` (§8.3).

```ts
/* ---- shared, identical in DSTU2 and R4 ---- */

export interface FhirCoding {
  system?: string;      // 'http://loinc.org' for LOINC
  code?: string;        // '2093-3'
  display?: string;     // 'Cholesterol [Mass/volume] in Serum or Plasma'
  version?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  /** The lab's own free-text label, e.g. "CHOLESTEROL, TOTAL". Often the ONLY human label. */
  text?: string;
}

/** FHIR Quantity. `code` is the UCUM code; `unit` is the lab's human string. They differ. */
export interface FhirQuantity {
  value?: number;
  comparator?: '<' | '<=' | '>=' | '>';   // e.g. "<0.2" — see §4.4
  unit?: string;        // 'mg/dL'  — human-readable, NOT guaranteed UCUM
  system?: string;      // 'http://unitsofmeasure.org' when code is UCUM
  code?: string;        // 'mg/dL'  — UCUM code, authoritative when system is UCUM
}

export interface FhirReference { reference?: string; display?: string; }

/* ---- Observation ---- */

/** Shared across releases. Union-typed where the releases disagree. */
export interface FhirObservationAnyVersion {
  resourceType: 'Observation';
  id?: string;
  status?: string;      // see §3.3
  /** DSTU2: 0..1 object. R4: 0..* array. Accept either. */
  category?: FhirCodeableConcept | FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;               // ISO 8601
  effectivePeriod?: { start?: string; end?: string };
  issued?: string;                          // when the lab released the result
  performer?: FhirReference | FhirReference[];
  valueQuantity?: FhirQuantity;
  valueString?: string;
  valueCodeableConcept?: FhirCodeableConcept;
  dataAbsentReason?: FhirCodeableConcept;
  /** DSTU2: 0..1 object. R4: 0..* array. */
  interpretation?: FhirCodeableConcept | FhirCodeableConcept[];
  /** DSTU2 only. */
  comments?: string;
  /** R4 only. */
  note?: { text?: string }[];
  specimen?: FhirReference;
  referenceRange?: FhirObservationReferenceRange[];
  /** DSTU2 grouping. */
  related?: { type?: string; target?: FhirReference }[];
  /** R4 grouping. */
  hasMember?: FhirReference[];
  derivedFrom?: FhirReference[];
  /** Multi-part results (blood pressure; some differentials). */
  component?: {
    code: FhirCodeableConcept;
    valueQuantity?: FhirQuantity;
    valueString?: string;
    interpretation?: FhirCodeableConcept | FhirCodeableConcept[];
    referenceRange?: FhirObservationReferenceRange[];
  }[];
}

export interface FhirObservationReferenceRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
  /** R4 name. */
  type?: FhirCodeableConcept;
  /** DSTU2 name for the same concept. */
  meaning?: FhirCodeableConcept;
  appliesTo?: FhirCodeableConcept[];
  age?: { low?: FhirQuantity; high?: FhirQuantity };
  /** The lab's own printed range string, e.g. "3.1 - 6.2" or "<100" or "Negative". */
  text?: string;
}

/* ---- DiagnosticReport ---- */

export interface FhirDiagnosticReportAnyVersion {
  resourceType: 'DiagnosticReport';
  id?: string;
  status?: string;
  /** DSTU2: 0..1. R4: 0..*. */
  category?: FhirCodeableConcept | FhirCodeableConcept[];
  /** The PANEL code, e.g. LOINC 24331-1 "Lipid 1996 panel". */
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  issued?: string;
  performer?: FhirReference | FhirReference[];
  /** R4 only. */
  resultsInterpreter?: FhirReference[];
  specimen?: FhirReference[];
  /** References to the member Observations. THE grouping mechanism. */
  result?: FhirReference[];
  conclusion?: string;
  /** DSTU2 name. */
  codedDiagnosis?: FhirCodeableConcept[];
  /** R4 name. */
  conclusionCode?: FhirCodeableConcept[];
  /** Often a base64 PDF of the printed report. We do NOT decode or display it in v1 (§11). */
  presentedForm?: { contentType?: string; data?: string; title?: string }[];
}
```

### 3.3 `status` — which results are safe to show

`Observation.status` values, DSTU2 vs R4:

| Status | DSTU2 | R4 | Our policy |
|---|---|---|---|
| `final` | ✓ | ✓ | **Show and trend.** |
| `amended` | ✓ | ✓ | **Show and trend.** Corrected after release; the current value is the truth. |
| `corrected` | — | ✓ | **Show and trend.** |
| `preliminary` | ✓ | ✓ | Show, badged **"preliminary — may be revised"**. Never trend on it. |
| `registered` | ✓ | ✓ | Ordered, no result. Do not show as a value. |
| `cancelled` | ✓ | ✓ | Hide. |
| `entered-in-error` | ✓ | ✓ | **Hard delete on import**, and delete any previously-imported record with the same `sourceKey`. This is the one status that must remove data. |
| `unknown` | ✓ | ✓ | Show, badged "status not supplied by the lab". Do not trend. |

`[well-established]` — R4 status enum from `@types/fhir` R4 (`registered | preliminary | final |
amended | corrected | cancelled | entered-in-error | unknown`); DSTU2 lacks `corrected`.

`DiagnosticReport.status` additionally has `partial` (DSTU2) / `partial`, `appended` (both). A
partial report is shown as a panel with the members that exist and an explicit "some results still
pending" line — never with the missing members silently absent.

### 3.4 The internal model

This is the contract other agents implement against. It is **release-agnostic** — nothing
downstream of the parser ever sees DSTU2 or R4.

```ts
export type FhirRelease = 'dstu2' | 'r4' | 'unknown';

export type RangeStatus = 'in_range' | 'below' | 'above' | 'no_range_supplied' | 'not_comparable';

export type RangeProvenance =
  /** The user's own lab printed this range on this result. The default and the good case. */
  | 'lab_supplied'
  /** No lab range. We substituted a general adult population range from lab-panels.json.
   *  MUST be labelled in the UI (§6.3). */
  | 'general_population'
  /** No range from anywhere. */
  | 'none';

export interface NormalizedQuantity {
  /** The number exactly as the lab reported it. NEVER overwritten. */
  rawValue: number;
  /** The unit string exactly as the lab reported it. NEVER overwritten. */
  rawUnit: string;
  /** UCUM code from valueQuantity.code when system is unitsofmeasure.org, else null. */
  ucumCode: string | null;
  /** Converted to the catalogue's canonical unit — ONLY when the (LOINC, unit) pair is known.
   *  null means "we declined to convert", which is a first-class, expected outcome. */
  canonicalValue: number | null;
  canonicalUnit: string | null;
  /** Why conversion was skipped, for display and for debugging. */
  conversionNote: string | null;
  /** '<' | '>' etc. from FHIR Quantity.comparator, e.g. a result reported as "<0.2". */
  comparator: '<' | '<=' | '>=' | '>' | null;
}

export interface NormalizedReferenceRange {
  low: number | null;
  high: number | null;
  unit: string | null;
  /** The lab's printed range text, preserved verbatim. Often more informative than low/high. */
  text: string | null;
  provenance: RangeProvenance;
  /** Present only when provenance === 'general_population'. Cited in the UI. */
  generalRangeSource?: string;
}

export interface NormalizedObservation {
  /** Deterministic, content-derived. See §7. */
  sourceKey: string;
  /** LOINC code if the lab supplied one, else null. Many labs supply only local codes. */
  loinc: string | null;
  /** All codings the lab supplied, any system. Kept for matching and for auditability. */
  codings: { system: string; code: string; display?: string }[];
  /** Our catalogue id from lab-panels.json when the LOINC matched, else null. */
  analyteId: string | null;
  /** Best available human label: catalogue displayName ?? code.text ?? LOINC display. */
  displayName: string;

  /** Clinical date. From effectiveDateTime / effectivePeriod.start / issued, in that order.
   *  NEVER from the HealthKit sample date or ClinicalRecord@receivedDate (§1.3.4). */
  effectiveAt: string;          // ISO 8601
  issuedAt: string | null;

  status: string;               // §3.3, passed through verbatim
  /** 'laboratory' | 'vital-signs' | … from Observation.category. */
  category: string | null;

  /** Exactly one of these is populated. */
  quantity: NormalizedQuantity | null;
  /** For qualitative results: "Negative", "Trace", "See report". Displayed verbatim, never parsed. */
  valueText: string | null;

  referenceRange: NormalizedReferenceRange | null;
  /** Our classification. Computed from referenceRange; see §6.4. */
  rangeStatus: RangeStatus;
  /** The LAB's interpretation code (H/L/HH/LL/N/A…), normalized across releases.
   *  Displayed as the lab's flag. We never invent one. */
  labInterpretation: LabInterpretation | null;

  /** Free text the lab attached (DSTU2 `comments` / R4 `note`). Shown verbatim, never parsed. */
  labComment: string | null;

  provider: {
    /** ClinicalRecord@sourceName, e.g. "Sutter Health". */
    sourceName: string | null;
    /** Observation.performer.display — the performing lab, e.g. "Quest Diagnostics". */
    performerName: string | null;
  };

  /** Which DiagnosticReport(s) this belongs to, by their sourceKey. Usually 0 or 1. */
  panelKeys: string[];

  fhirRelease: FhirRelease;
  importedAt: string;
}

export type LabInterpretation =
  | 'normal' | 'high' | 'low' | 'critical_high' | 'critical_low'
  | 'abnormal' | 'resistant' | 'susceptible' | 'other';

export interface NormalizedPanel {
  sourceKey: string;
  /** Panel LOINC, e.g. 24331-1 (lipid), 24323-8 (CMP), 58410-2 (CBC w/ diff). */
  loinc: string | null;
  displayName: string;
  effectiveAt: string;
  issuedAt: string | null;
  status: string;
  /** sourceKeys of member NormalizedObservations that we successfully resolved. */
  memberKeys: string[];
  /** result[] references we could NOT resolve to an imported Observation. Surfaced honestly. */
  unresolvedMemberRefs: string[];
  /** The lab's narrative conclusion, verbatim. Never summarized, never paraphrased. */
  conclusion: string | null;
  provider: { sourceName: string | null; performerName: string | null };
  fhirRelease: FhirRelease;
  importedAt: string;
}
```

---

## 4. Reading an `Observation` correctly

### 4.1 Code → analyte

```
1. Look for coding[] where system === 'http://loinc.org'  → LOINC code
2. Look up that LOINC in lab-panels.json → analyteId, canonical unit, conversions
3. No LOINC match, or no LOINC at all:
     → analyteId = null
     → displayName = code.text ?? first coding.display ?? '(unnamed result)'
     → store, display verbatim, DO NOT trend, DO NOT convert units
```

**A lab may supply no LOINC at all**, only a local/proprietary code. Real parsers handle this
explicitly — [health_data_parser `labtest.py`](https://github.com/tomhallmain/health_data_parser)
falls back to `coding[0]` when no LOINC is present. `[well-established]`

**We never match on display text.** `"Vitamin D"` could be 25-OH total, 25-OH D3, 1,25-dihydroxy,
or a urine result. Text matching is exactly the silent-mismap failure the LOINC keying exists to
prevent. Text is for *display*; codes are for *identity*. The one narrow exception, gated behind an
explicit user confirmation, is §11.

### 4.2 Unit — UCUM code vs. human string

`valueQuantity.code` (UCUM) is authoritative when `valueQuantity.system` is
`http://unitsofmeasure.org`. `valueQuantity.unit` is a human string and may be anything —
`mmol/l`, `mmol/L`, `mg/dl`, `x10E3/uL`, `K/uL`. Resolution order:

1. `code` when `system === 'http://unitsofmeasure.org'`
2. `code` alone (many labs emit the UCUM code without the system URL)
3. `unit`, after normalization (§5.2)
4. nothing → `rawUnit = ''`, no conversion, display "unit not supplied by the lab"

### 4.3 Date

`effectiveDateTime` → else `effectivePeriod.start` → else `issued` → else **reject the
observation** and count it in the receipt. A lab value without a date cannot be trended and cannot
be safely displayed next to dated values.

### 4.4 Values that are not numbers

Real lab data is full of these, and every one of them has burned a naïve parser:

| Shape | Example | Handling |
|---|---|---|
| `valueString` | `"Negative"`, `"Trace"`, `"Not Detected"` | → `valueText`, verbatim. No parsing, no trending. |
| `valueCodeableConcept` | coded qualitative result | → `valueText` from `.text ?? coding[0].display`. |
| `Quantity.comparator` | `<` with value `0.2` | Store `comparator: '<'`, `rawValue: 0.2`. **Display as `<0.2`.** Excluded from trends — a censored value is not a measurement. |
| `valueQuantity.value` as a **string** | `"6.3"`, `"6.3 mg/dL"` | Coerce leading numeric only; if it fails, treat as `valueText`. Observed in the wild ([health_data_parser `observation.py`](https://github.com/tomhallmain/health_data_parser) regexes `(\d+\.\d+|\d+)` out of string values). |
| Narrative dumped into the value | `"SEE BELOW\n\n…"` | → `valueText`. Truncate for display at 200 chars with expand; never trend. |
| `component[]` only, no top-level value | blood pressure (8480-6 / 8462-4) | Split into per-component records keyed by the component LOINC. |
| `dataAbsentReason` present, no value | specimen hemolysed | Show the row with the reason; no value, no trend. |

---

## 5. Unit normalization — where this gets genuinely hard

### 5.1 The governing rule

> **A wrong conversion on a lab value is worse than no conversion.**

A cholesterol of 5.2 mmol/L is normal; multiplied by the glucose factor it reads 93.7 and looks
normal in mg/dL too — the error is *invisible*. So:

- Conversions are keyed by **(analyteId, normalized source unit)** — never by unit alone. `mg/dL` is
  not a conversion; `mg/dL of cholesterol` is.
- An unrecognised pair produces `canonicalValue: null` and a `conversionNote`. The UI shows
  `rawValue rawUnit` unchanged. **Never guess.**
- Conversions round-trip within 1e-9 relative error, and `labs.verify.mjs` asserts this for every
  pair in the catalogue.
- Reference-range comparison happens in whatever space both operands share (§6.4). We never convert
  a *range* into a unit the value isn't in just to make a comparison possible.

### 5.2 Unit-string normalization (safe, purely syntactic)

Applied before lookup. This is lossless string tidying, not conversion:

- trim; collapse internal whitespace
- case-fold the *volume* denominator only: `mg/dl` → `mg/dL`, `mmol/l` → `mmol/L`
  (never case-fold the numerator — `mU` and `MU` differ)
- `µ` (U+00B5), `μ` (U+03BC, Greek mu) and `u` are all folded to `u` for lookup: `µg/dL`, `μg/dL`,
  `ug/dL` are one key. **This bites in practice** — the two mu codepoints are visually identical.
- UCUM exponent forms unified: `10*3/uL`, `10^3/uL`, `x10E3/uL`, `K/uL`, `10e3/uL` → `10*3/uL`
- `%` and `percent` → `%`
- `IU` ≡ `U` for enzyme activity only (`U/L`, `IU/L` — same measurement, different label). **Not**
  for hormones or insulin, where IU is a bioassay standard, not an SI unit.

### 5.3 The conversion model

Three kinds, because two of them are needed and the third is the safety valve:

```ts
export type Conversion =
  /** Same physical quantity, different label. ng/mL ≡ µg/L. */
  | { kind: 'identity' }
  /** canonical = raw * factor + (offset ?? 0). The offset exists for HbA1c (§5.5). */
  | { kind: 'linear'; factor: number; offset?: number }
  /** Deliberate refusal. Store verbatim, display un-normalized, explain why. */
  | { kind: 'refuse'; reason: string };
```

### 5.4 Conversion table

Keyed by analyte (which is keyed by LOINC in `lab-panels.json`). Canonical unit = the one US
ambulatory labs use, because that is what a user's results will arrive in; the alternate is
carried so an overseas or SI-reporting lab still normalizes into the same series.

All factors are `mass → molar` unless noted, derived from molecular weight as
`factor = 10 / MW` (mg/dL → mmol/L) or `1000 / MW` (ng/mL → nmol/L). `[well-established]` —
standard clinical unit-conversion tables; MWs are from the analyte's molecular formula.

| Analyte | Canonical | Alternate | Conversion (alt → canonical) | Note |
|---|---|---|---|---|
| Glucose | mg/dL | mmol/L | `× 18.0156` | MW 180.156 |
| Cholesterol (total, LDL, HDL, non-HDL) | mg/dL | mmol/L | `× 38.67` | MW 386.65 |
| Triglycerides | mg/dL | mmol/L | `× 88.57` | MW 885.4 (triolein) |
| ApoB | mg/dL | g/L | `× 100` | |
| **Lp(a)** | — | — | **`refuse`** | mg/dL ↔ nmol/L has **no universal factor** — it depends on apo(a) isoform size. See §5.6. |
| HbA1c | % (NGSP) | mmol/mol (IFCC) | `× 0.09148 + 2.152` | **Affine.** See §5.5. |
| **Insulin** | — | — | **`refuse`** | µIU/mL ↔ pmol/L depends on the assay's international standard; 6.00 and 6.945 are both in use. See §5.6. |
| Ferritin | ng/mL | µg/L | `identity` | Exactly equal. |
| Serum iron, TIBC, UIBC | µg/dL | µmol/L | `× 5.5847` | MW 55.845 |
| Transferrin | mg/dL | g/L | `× 100` | µmol/L → `refuse` (protein MW varies by glycoform) |
| Transferrin saturation | % | — | — | Dimensionless |
| 25-OH vitamin D | ng/mL | nmol/L | `× 0.4006` | MW 400.64 |
| Vitamin B12 | pg/mL | pmol/L | `× 1.3554` | MW 1355.4; `ng/L` ≡ `pg/mL` identity |
| Folate (serum, RBC) | ng/mL | nmol/L | `× 0.4414` | MW 441.4; `µg/L` ≡ `ng/mL` identity |
| TSH | mIU/L | µIU/mL | `identity` | Exactly equal by definition |
| Free T4 | ng/dL | pmol/L | `× 0.07769` | MW 776.87 |
| Free T3 | pg/mL | pmol/L | `× 0.6510` | MW 650.98 |
| Total T3 | ng/dL | nmol/L | `× 65.098` | MW 650.98 |
| Total testosterone | ng/dL | nmol/L | `× 28.842` | MW 288.42; `ng/mL` → ng/dL `× 100` |
| Free testosterone | pg/mL | pmol/L | `× 0.28842` | MW 288.42 |
| **SHBG** | nmol/L | — | **`refuse`** for any mass unit | Glycoprotein, MW ≈ 90 kDa and variable |
| Estradiol | pg/mL | pmol/L | `× 0.27238` | MW 272.38 |
| DHEA-S | µg/dL | µmol/L | `× 36.846` | MW 368.5 |
| hs-CRP / CRP | mg/L | mg/dL | `× 10` | Same analyte; hs- differs only in assay sensitivity. nmol/L → `refuse` |
| Creatinine | mg/dL | µmol/L | `× 0.011312` | MW 113.12 |
| eGFR | mL/min/1.73m² | — | — | Single unit. See §9.6.1 — creatine caveat |
| BUN (urea nitrogen) | mg/dL | mmol/L | `× 2.8011` | SI value is **molar urea**; carries an explicit note |
| Uric acid | mg/dL | µmol/L | `× 0.016812` | MW 168.11 |
| Total bilirubin | mg/dL | µmol/L | `× 0.058467` | MW 584.66 |
| ALT, AST, ALP, GGT, CK, LDH | U/L | µkat/L | `× 60.0` | 1 U/L = 0.016667 µkat/L; `IU/L` ≡ `U/L` identity |
| Albumin, total protein | g/dL | g/L | `× 0.1` | |
| Sodium, potassium, chloride, CO₂ | mmol/L | mEq/L | `identity` | Monovalent |
| Total calcium | mg/dL | mmol/L | `× 4.008` | MW 40.08; `mEq/L` → mmol/L `× 0.5` (divalent) |
| Magnesium | mg/dL | mmol/L | `× 2.4305` | MW 24.305; `mEq/L` → mg/dL `× 1.215` |
| Phosphate (as P) | mg/dL | mmol/L | `× 3.0974` | MW 30.97 |
| Haemoglobin | g/dL | g/L | `× 0.1` | `mmol/L` → g/dL `× 1.6114` (per-heme convention; **note attached**) |
| Haematocrit | % | L/L | `× 100` | |
| WBC | 10*3/uL | 10*9/L | `identity` | |
| RBC | 10*6/uL | 10*12/L | `identity` | |
| Platelets | 10*3/uL | 10*9/L | `identity` | |
| MCV | fL | um3 | `identity` | |
| MCH | pg | fmol | `refuse` | Hb-monomer convention again |
| MCHC | g/dL | g/L | `× 0.1` | |
| RDW, differential percentages | % | — | — | |

### 5.5 HbA1c is affine, and that is why `offset` exists

`NGSP % = 0.09148 × IFCC mmol/mol + 2.152`, inverse `IFCC = (NGSP − 2.152) × 10.929`.
`[well-established]` — the NGSP/IFCC master equation.

A pure-multiplier conversion model silently mis-converts every HbA1c. An IFCC 48 mmol/mol
(diagnostic threshold, = 6.5%) becomes 4.39% under a naïve factor — a value that reads as
reassuringly normal. This is the reason the model carries `offset` rather than a bare factor, and
`labs.verify.mjs` asserts the 48 ↔ 6.5 anchor explicitly.

### 5.6 The refusal policy, and why these three

When an (analyte, unit) pair is not in the table, or is marked `refuse`:

```
canonicalValue  = null
canonicalUnit   = null
conversionNote  = <the reason string>
UI              = "<rawValue> <rawUnit>" exactly as the lab sent it, plus an
                  info affordance carrying the reason
trend           = the value still trends, but ONLY against other results in the
                  SAME raw unit. Mixed-unit series are split, never merged.
```

The three named refusals are not arbitrary; each is a documented, clinically consequential trap:

- **Lp(a).** Reported both as mass (mg/dL) and particle concentration (nmol/L). No universal
  conversion exists because apolipoprotein(a) has a size-polymorphic KIV-2 repeat, so mass per
  particle varies between people. Published "factors" (≈2.0–2.5) are population averages that are
  wrong for any given individual. `[well-established]`
- **Insulin.** µIU/mL → pmol/L requires knowing which international standard the assay is
  calibrated against; 6.00 and 6.945 are both in current use, a ~16% spread.
  `[well-established]`
- **Any protein reported molar** (SHBG, transferrin as µmol/L, haemoglobin as mmol/L, MCH as fmol).
  The "molecular weight" is a convention (whole molecule? monomer? per heme?) that differs between
  laboratories and between countries. Haemoglobin mmol/L is *listed* with a factor because it is a
  fixed national convention where it is used, but it carries a visible note.

### 5.7 Mixed units in one series

If a series contains both convertible and unconvertible members, the chart splits into segments by
raw unit, with a visible break and a caption: *"These results came from labs reporting different
units, and we couldn't convert between them. They're shown as separate series."* We do **not**
render a single continuous line through a unit change.

---

## 6. Reference ranges

### 6.1 Why the lab's own range wins, always

Reference intervals are **assay-specific and laboratory-specific**. Two labs measuring the same
serum with different platforms legitimately publish different intervals; the interval is a property
of *that lab's method and reference population*, not of the analyte. A value flagged normal against
its own lab's interval can fall outside a textbook interval, and vice versa. `[well-established]`

So the precedence is absolute:

```
1. Observation.referenceRange[]        ← the user's own lab, on this result.  ALWAYS preferred.
2. lab-panels.json generalRange        ← only when (1) is absent. ALWAYS visibly labelled.
3. nothing                             ← rangeStatus = 'no_range_supplied'. Show the number alone.
```

There is **no** step where we override a lab-supplied range with a "better" one, and no setting that
lets the user do so either.

### 6.2 Parsing what the lab actually sends

`referenceRange` is a `0..*` array, and its contents are messier than the spec suggests.

- **`text` is more reliably populated than `low`/`high`.** A real-world parser notes exactly this:
  *"high and low objects less consistent than text field, so use text to set the range"*
  ([health_data_parser `result.py`](https://github.com/tomhallmain/health_data_parser)).
  `[well-established]` We read **both**: structured `low`/`high` when present, and if either is
  missing we attempt a conservative parse of `text`.
- **Text-parse patterns** (conservative — anything unmatched yields `no_range_supplied`, never a guess):

  | Pattern | Example | Result |
  |---|---|---|
  | `A - B` / `A – B` (en dash) | `3.1 - 6.2`, `13.5–17.5` | low=A, high=B |
  | `< B` / `<= B` / `less than B` | `<100`, `< 5.7` | low=null, high=B |
  | `> A` / `>= A` | `>40`, `≥ 60` | low=A, high=null |
  | `A to B` | `70 to 99` | low=A, high=B |
  | qualitative | `Negative`, `Not Detected`, `Clear` | qualitative; compared only by string equality |
  | `Not Estab.`, `Not Established`, `See report`, `` | | `no_range_supplied` |
  | anything else | `Age dependent`, `Male: 13-17 Female: 12-16` | `no_range_supplied` — **we do not pick a sex** |

  Thousands separators are stripped (`1,000` → `1000`). If parsed `low > high`, they are **not**
  silently swapped — the range is discarded as unparseable, because a reversed range signals a
  format we don't understand.
- **Multiple ranges.** Prefer the entry whose `type`/`meaning` coding is `normal`. Otherwise, if
  exactly one entry has no `appliesTo` and no `age` restriction, use it. Otherwise
  `no_range_supplied` — we do **not** guess which age/sex stratum applies to the user.
- **Unit mismatch.** If the range's unit differs from the value's unit, convert the range using the
  same §5 table. If the pair is unconvertible, `rangeStatus = 'not_comparable'` and the UI shows the
  value and the range side by side, uncompared, with a one-line explanation. We never compare across
  units by assumption.

### 6.3 The general-population fallback, and how it is labelled

`lab-panels.json` carries a `generalRange` for the well-characterised analytes. It is used only when
the lab supplied nothing, and when used it is **visually distinct** — different colour, and a
mandatory inline label:

> **General adult range — not your lab's.** Your lab didn't include a reference range with this
> result. This is a commonly used adult range for context only. Your lab's own range may differ,
> and your lab's is the one that applies to you.

Machine-enforced: `NormalizedReferenceRange.provenance === 'general_population'` makes the label
non-optional in the component contract. A UI that renders a general range without the label is a
bug, and `labs.verify.mjs` has a corresponding assertion on the finding code so the failure is
caught in CI rather than in review.

Analytes where the general range is **omitted deliberately** because it is too
population-dependent to state responsibly: all hormones (testosterone, free testosterone, SHBG,
estradiol, DHEA-S — strongly age- and sex-dependent), ferritin (sex-dependent, and an acute-phase
reactant), haemoglobin/haematocrit/RBC (sex-dependent), eGFR (equation-dependent), and
alkaline phosphatase (age-dependent). For these, no lab range means **no range**.

### 6.4 Classification

```
value missing or non-numeric      → 'not_comparable'
no usable range                   → 'no_range_supplied'
range unit ≠ value unit, unconvertible → 'not_comparable'
low != null  && value < low       → 'below'
high != null && value > high      → 'above'
otherwise                         → 'in_range'
```

Boundary values are **in range**: `value === low` and `value === high` both classify `in_range`.
There is no "borderline", no "high-normal", no "optimal vs normal" band. Those are
interpretations, and §9 forbids them.

The lab's own `interpretation` flag is stored and displayed *as the lab's flag*, separately from our
`rangeStatus`. Where they disagree — which happens, because the lab may flag against a range it did
not transmit — **the lab's flag is displayed and ours is suppressed**. The lab knows things we
don't.

---

## 7. Deduplication and idempotency

### 7.1 The requirement

Re-importing the same export, or an overlapping later export, must produce **zero** new records. The
same result arriving via two connected providers (common: a hospital and the reference lab that ran
the assay both publish it) must appear once.

### 7.2 `sourceKey`

Deterministic, content-derived, computed with a dependency-free FNV-1a 64-bit hash rendered as 16
hex chars. (Not a cryptographic hash — this is a collision-resistant identity key inside an already
encrypted store, not a security boundary. `SubtleCrypto` is async and unavailable synchronously in
a pure function.)

```
sourceKey = 'obs:' + fnv1a64(join('|', [
    identityCode,            // 'loinc:2093-3'  else 'local:<system>#<code>'  else 'text:<lowercased code.text>'
    effectiveAtUtcMinute,    // ISO 8601 UTC, truncated to the minute
    rawValueCanonicalString, // value formatted with toPrecision(12), or the verbatim valueText
    normalizedRawUnit,       // '' when absent
]))
```

**What is deliberately excluded, and why:**

| Excluded | Reason |
|---|---|
| `sourceName` (the provider) | Its inclusion is exactly what would let the same result in from two providers twice. This is the crux. |
| `ClinicalRecord@identifier` | Provider-scoped. Two providers publishing the same lab give it two different ids. Stored as metadata, never keyed on. |
| `Observation.id` | Same problem, plus it can change on re-download. |
| `importedAt`, `receivedDate` | Change every export. Would defeat idempotency entirely. |
| `status` | An `amended` result must *replace* the `final` one it corrects, not sit beside it. |

**Included and load-bearing:** the value itself. Two genuinely different results for the same
analyte at the same minute are two results — a real (if rare) occurrence, e.g. a repeat run on a
hemolysed specimen. Keying on the value keeps both rather than silently discarding one.

`effectiveAt` is truncated to the **minute** because different providers serialise the same timestamp
with differing sub-minute precision and timezone rendering. Normalising to UTC first is essential:
`2024-03-01T09:30:00-08:00` and `2024-03-01T17:30:00Z` are the same instant. Truncating to the *day*
was considered and rejected — it would merge a genuine morning/evening repeat.

Panels: `sourceKey = 'dxr:' + fnv1a64(join('|', [panelIdentityCode, effectiveAtUtcMinute, sortedMemberKeys.join(',')]))`.

### 7.3 Upsert semantics

```
existing = vault.get(sourceKey)
if (!existing)                              insert
else if (incoming.status === 'entered-in-error')   DELETE existing        // §3.3
else if (statusRank(incoming) > statusRank(existing))  replace            // amended/corrected wins
else                                        no-op, increment 'duplicates skipped'
```

`statusRank`: `corrected` = `amended` (3) > `final` (2) > `preliminary` (1) > everything else (0).

### 7.4 Cross-provider near-duplicates

Records that share LOINC + minute + unit but differ in value by less than half the display precision
are flagged as a **soft duplicate**: both stored, one shown, an affordance to see the other, and the
provider names on both. We do not merge or average them. Averaging two lab results is fabrication.

---

## 8. Privacy and vault storage

### 8.1 The stake

Under `ARCHITECTURE.md` §1 nothing leaves the device, so the threat model is a **local** adversary:
an unlocked or seized phone, a forensic disk image, a shared iCloud backup, another origin on the
same device. Labs are the most re-identifying and most consequential data the app will ever hold —
a diagnosis is often inferable from a pattern of results.

### 8.2 Encryption

Per `ARCHITECTURE.md` §3, every sensitive record is stored as `{ id, iv, ct }`, `ct` being AES-256-GCM
ciphertext of the JSON body under the vault DEK. Lab records are no exception, and lab records get
**no** relaxation of it.

### 8.3 What may be plaintext — argued, not asserted

The brief's instinct was "LOINC and date can be plaintext, the value cannot." I agree on the value
and I **disagree on the LOINC**. The reasoning:

Dexie can only index plaintext fields, and a table with no plaintext index requires decrypting every
row to answer any query — for a few thousand lab records that is acceptable, so the burden of proof
is on *including* an index, not on omitting one.

Field by field:

| Field | Plaintext? | Argument |
|---|---|---|
| `sourceKey` (opaque hash) | **Yes** | Reveals nothing without the inputs. Needed as the primary key for idempotent upsert (§7.3), which by definition must work before decrypting the row. Non-negotiable and safe. |
| `dateKey` (`YYYY-MM-DD`) | **Yes** | Consistent with the existing convention (`ARCHITECTURE.md` §3 names `dateKey` as an acceptable plaintext index). Leaks "this person had bloodwork on 2026-03-14" — a fact already leaked by the presence of the table at all, and by every other dated table in the vault. Enables the range queries the trend UI needs. |
| `recordKind` (`'lab_observation'` / `'lab_panel'`) | **Yes** | One bit of table-shape information. Needed to partition queries. |
| **`loinc`** | **No** | **This is where I part company with the brief.** A LOINC code is not a neutral identifier — it names the *test that was ordered*, and the order is often more disclosing than the result. Plaintext `56888-1` (HIV-1 RNA), `5196-1` (HBsAg), `2857-1` (PSA), `2118-8` (hCG), `14979-9` (aPTT — anticoagulation), or any of the therapeutic-drug-monitoring codes tells a reader what condition is being managed, **without decrypting anything**. That an anxious person once ordered an HIV test is exactly the kind of fact that must not survive an unlocked phone. The gain — a fast index for "show me all ferritin results" — is worth a few milliseconds of decrypting a small table, and nothing more. |
| `analyteId` (our catalogue id) | **No** | Same objection with a friendlier name. `analyteId: "hiv_1_rna"` is *more* legible to a casual reader than the raw LOINC, not less. |
| `value`, `unit`, `referenceRange`, `interpretation`, `status`, `provider`, `comment`, `rawJson` | **No** | Obviously. The value is the payload. |
| `providerName` | **No** | "Sutter Health" plus a date is a re-identifier and reveals care relationships. |

**Resulting Dexie schema** (proposed to the vault agent; final form is theirs to ratify — see §12):

```
labRecords: '&sourceKey, dateKey, recordKind, [recordKind+dateKey]'
```

Everything else lives inside `ct`. Query pattern: filter by `dateKey` range and `recordKind` in the
index, decrypt the (small) candidate set, then filter by LOINC in memory. For a person with a decade
of bloodwork — order 10³ records — this is single-digit milliseconds, and the app is already
decrypting on every read elsewhere.

**Consequence to accept honestly:** "all ferritin results ever" is a full-table decrypt of
`labRecords`. On first render of the labs screen we decrypt the table once and hold a decrypted
index in memory for the session, zeroed on lock alongside the DEK. That is the cost, it is small,
and it buys a genuinely meaningful privacy property.

### 8.4 `rawJson`

The original FHIR resource is retained inside the encrypted body. It costs little, and it means a
future parser fix can re-derive better data without asking the user to re-export. It is **never**
exported, logged, or rendered as a debug blob in the UI.

### 8.5 Backup and deletion

- Lab records ride the standard `.hcvault` encrypted backup. No separate handling.
- **Per-record and per-provider deletion must exist**, and must be a real delete, not a hidden flag.
  A user who imported records they did not want in the app must be able to remove them.
- Deleting a lab record also removes it from any panel's `memberKeys`.
- "Delete all health records" is a distinct, single action, separate from vault reset.

---

## 9. SAFETY — and how the app is allowed to interpret

This section is normative. It binds the UI author, the coach engine, and any future agent. It
implements [`advice-policy.md`](./advice-policy.md) for lab data; where this section is silent, the
policy doc governs.

### 9.1 The three tiers, mapped onto labs

**Tier 1 — say it straight.** No hedging. Reasoning, inputs, confidence tag.

- What the analyte measures, in plain language (`lab-panels.json → whatItMeasures`).
- The value against the lab's own reference range, and against a goal-relevant range where a
  defensible one exists — **always saying which is which** (`referenceContext` vs `goalContext`).
- What typically moves the number up and down, split into **things the user controls** (intake,
  supplementation, training load, hydration and fasting before the draw, sleep, energy availability)
  and **things they don't** (age, genetics, acute illness, assay platform).
- Whether a change since last time exceeds assay + biological noise (§9.7).
- Whether the result looks like an **artifact** rather than a signal (§9.6). This is the
  highest-value thing the app does, because getting it wrong is what causes needless alarm.
- Which analytes matter most for each of a user's goals (`relevanceToGoals`).

**Tier 2 — say it straight, plus the one specific caveat.** A named uncertainty the user can act
on, not a generic disclaimer.

- An out-of-range value with several plausible causes → give the likely ones and **what would
  distinguish them** ("ferritin is both an iron store and an inflammatory marker; a CRP drawn at the
  same time tells you which you're looking at").
- A supplement recommendation approaching a tolerable upper intake level → the UL check runs first
  and its result is stated.
- Anything genuinely contested in the literature → say it is contested, give the default, give the
  rationale.

**Tier 3 — don't, and say why.** Unchanged from `advice-policy.md`, restated here because these are
the ones a lab screen will be tempted to violate:

1. **Never suggest starting, stopping, or changing the dose of a prescribed medication.** Not
   hedged. Not "ask whether your statin dose is right." Nothing. If a result plausibly relates to a
   medication, the app says: *"if you're on any prescription, that's worth raising with the
   prescriber alongside this result"* — and stops.
2. **Never name a diagnosis.** Describe the finding and say what the panel measures.
   ✅ *"Your TSH is above your lab's range and has risen across three draws. That panel measures
   thyroid function; a clinician can tell you whether it means anything."*
   ❌ *"You have subclinical hypothyroidism."*
3. **Critical values get an urgent prompt and no interpretation** (§9.5). A plausible-sounding
   explanation is the dangerous failure mode when someone is frightened.
4. **Never contradict a clinical instruction the user has logged.** If they have recorded that a
   clinician told them something about a result, the app defers, says it is deferring, and shows the
   logged instruction above its own commentary.
5. **Never clear a food as safe** given the user's oral allergy syndrome. Explaining mechanism is
   education and is allowed and useful — PR-10 proteins are heat-labile, nsLTPs are not — but
   "you can eat this" is not the app's call.

### 9.2 Still off the table, and why

Not because interpretation is forbidden, but because each of these is either a clinical calculation
the app has no business performing or a genre convention that misleads:

- **Composite risk scores** — ASCVD, FRAX, MELD, "metabolic health score", "biological age",
  "inflammation score." These read as medical output, are validated for specific populations under
  specific conditions, and none of those conditions is "a fitness app." Where a *lab* reports one,
  we display it like any other result.
- **Derived clinical indices we compute ourselves** — HOMA-IR, FIB-4, TyG, free-androgen index,
  Friedewald/Martin-Hopkins LDL, non-HDL. If the lab reported it, display it. We do not calculate
  one and present it as a result, because a computed number in a results table is indistinguishable
  from a measured one. *(Explaining what one of these means when the lab reported it is Tier 1 and
  is fine.)*
- **Trend extrapolation** — "at this rate your ferritin reaches 15 by June." Two or three points do
  not support a forecast, and the RCV work in §9.7 exists precisely because they usually do not even
  support a direction.
- **Causal claims linking labs to logged training or nutrition.** Association, stated as
  association, with the confounders named, is Tier 1 and is genuinely useful. "Your deficit caused
  this" is not.
- **Reassurance.** "That's nothing to worry about" remains out, and this survives the policy change
  intact. Explaining *why a value is very likely an artifact* (§9.6) is a different act: it names a
  mechanism, states its confidence, and still routes anything persistent to a clinician. Saying "this
  is fine" is a clinical judgement made without an examination. The distinction is the difference
  between "hs-CRP rises for days after hard eccentric work, and you logged a heavy session two days
  before this draw — retest when you've been rested for a week" and "don't worry about it."

### 9.3 User-facing copy

Tone per `advice-policy.md`: a knowledgeable friend who has done the reading. Not a legal
department, not a wellness brand. **The disclaimer lives in onboarding and Settings — it is not
stapled to individual results**, because a disclaimer on every sentence trains the user to skip all
of them, including the one that matters.

**Above the lab's range** (`rangeStatus === 'above'`, `provenance === 'lab_supplied'`):

> **{Analyte} is above your lab's range** — {value} {unit}, against their {low}–{high}.
> {whatItMeasures, one sentence.}
> {The Tier-2 differential: the two or three things that most commonly move this up, and what would
> tell them apart.}
> {If an artifact rule fires (§9.6), it goes here, first.}
> {If persistent or unexplained: "worth putting in front of a clinician, who can settle it."}

**Below the lab's range** — same shape.

**In range but outside a goal-relevant range** (§9.4) — this is the case the old spec could not
express, and it is the one a user most needs:

> **Ferritin 18 ng/mL — inside your lab's range (15–200), but low for what you're training for.**
> Ferritin is your stored iron. Below roughly 30 ng/mL, endurance adaptation measurably suffers even
> without anaemia, which matters given the VO₂ max goal. `[reasonable-inference]`
> Two things worth knowing before you act on it: ferritin also rises with inflammation, so a low
> number is *more* meaningful than a high one; and iron overload is a real risk, so this is not a
> "take iron and see" situation. **Retest with transferrin saturation and hs-CRP alongside** — that
> combination tells you whether this is genuinely low stores.

**In range on both:**

> {Analyte} {value} {unit} — inside your lab's range ({low}–{high}) and inside the range that
> matters for {goal}.

No tick, no green badge, no "great work." A lab result is not an achievement.

**Out of range against a general range** (`provenance === 'general_population'`):

> **Outside a general adult range.** Your lab didn't send a range with this result, so this is
> compared against a commonly used adult range ({low}–{high} {unit}). **That's not your lab's
> range** — ranges are specific to the assay and the lab, and theirs is the one that applies to you.

**No range supplied:**

> Your lab didn't include a reference range, and this isn't an analyte we're confident enough to
> supply a general one for. The value is {value} {unit}.

**Unconvertible unit:**

> Reported as {rawValue} {rawUnit}. We don't convert this one — the conversion isn't reliable enough
> to do automatically, and a wrong conversion on a lab value is worse than none.

**Censored value** (comparator present):

> Reported as {comparator}{value} {unit} — the result was outside what the assay measures precisely.
> Shown as reported, and left out of trend calculations.

**Deference to a logged clinical instruction** (Tier 3 rule 4) — rendered *above* any app
commentary, which is then visually subordinated:

> **Your clinician's note on this, from {date}:** "{logged instruction}"
> That's the guidance that applies. Everything below is general context, not a second opinion.

### 9.4 Goal-relevant ranges — and the honesty rules that make them safe

`lab-panels.json` carries, per analyte, an optional `goalContext`: a range that is *not* the lab's,
justified by a stated rationale, tagged with a confidence level and a source, and tied to specific
goals. This is the mechanism behind the ferritin copy above.

**Five rules keep this from becoming the "optimal range" pseudoscience it superficially resembles:**

1. **Never displaces the lab's range.** Both are shown, both labelled. The lab's is the primary
   visual; the goal range is secondary and explicitly framed as "for what you're training for."
2. **Requires a rationale and a source in the data file.** An entry with `goalContext` but no
   `rationale` and `source` fails the catalogue's own validation in `labs.verify.mjs`. A range with
   no argument behind it does not ship.
3. **Carries a confidence tag that is displayed**, not buried. Most of these are
   `[reasonable-inference]`, and the copy says so.
4. **Omitted wherever it cannot be defended.** No goal range for: testosterone and free
   testosterone, SHBG, oestradiol, DHEA-S (strongly age-, assay- and time-of-day-dependent — a
   "optimal testosterone" number is the single most common piece of nonsense in this product
   category), TSH, free T4, eGFR, ALP, or any CBC index. Where the honest answer is "it depends on
   your lab and your clinician," that is the answer.
5. **Never triggers an alert on its own.** A value inside the lab's range but outside a goal range
   is *information on the analyte's own screen*. It never fires a notification, never appears as a
   badge count, and never contributes to a critical-value prompt.

The analytes that do carry a `goalContext`, and why each is defensible, are listed in
`lab-panels.json` with their sources. The short version: ferritin and transferrin saturation (iron
status genuinely caps endurance `[well-established]` that iron deficiency impairs it; `[reasonable-inference]`
on the exact athlete threshold), 25-OH vitamin D (`[uncertain]` above the bone-health threshold —
flagged as contested), hs-CRP (AHA/CDC cardiovascular strata, `[well-established]`), ApoB and
triglycerides (`[reasonable-inference]`, guideline-derived), HbA1c (ADA thresholds,
`[well-established]`), and free T3 (falls in sustained energy deficit — directly relevant to an
aggressive cut, `[well-established]` mechanism / `[reasonable-inference]` threshold).

### 9.5 Critical values

Some results indicate an emergency. The app must not miss those, and must not pretend to
adjudicate them.

**Design constraints, all of them binding:**

1. **Conservative by construction.** Thresholds are set well outside published hospital
   critical-value lists, not at them. Hospital lists are tuned for a population of acutely ill
   inpatients, with a clinician on the other end of the phone call; using them verbatim in a
   consumer app would generate alarms on results a doctor has already seen and judged fine. The cost
   of a false alarm here is real — it is anxiety, and repeated false alarms train the user to
   dismiss the true one.
2. **No explanation. Ever.** The prompt says what to do. It does not say what it might be. Naming a
   possible cause is Tier 3 rule 3 territory, and it is at its most harmful when
   the user is frightened.
3. **Historical results are not emergencies.** A result older than **14 days** never triggers the
   prompt — it is shown with the standard out-of-range copy plus one line noting it was well outside
   the range. A four-year-old potassium of 6.2 is history, and the user's doctor saw it at the time.
4. **Only lab-supplied ranges and catalogue-defined absolute thresholds** trigger it. A
   general-population fallback range never triggers a critical prompt.
5. **Only `final` / `amended` / `corrected` results.** Never `preliminary`.
6. **Once per result, dismissible, and never re-fired** for the same `sourceKey`. It is not a modal
   the user must fight.
7. **The app never phones anyone, never contacts a provider, never auto-sends anything.**
8. Thresholds live in `lab-panels.json` as `criticalLow` / `criticalHigh` in the canonical unit, and
   are **only** defined for the small set of analytes where a consumer-facing prompt is defensible.
   Every other analyte has `null` and can never trigger. See `lab-panels.json` for the
   values and their sourcing.
9. **An artifact rule (§9.6) never suppresses this prompt.** A haemolysis flag on a potassium of 7.1
   is shown *alongside* the prompt, not instead of it.

**Where the numbers come from, and why ours are wider.** The anchor is the CAP Q-Probes survey of
163 clinical laboratories, 97 % US-based — typical thresholds: potassium < 2.5 or > 6.5 mmol/L;
sodium < 120 or > 160 mmol/L; glucose < 50 or > 540 mg/dL; calcium < 6.0 or > 13.0 mg/dL.
`[well-established]` — [Arch Pathol Lab Med 2007;131(12):1769](https://meridian.allenpress.com/aplm/article/131/12/1769/460054/Critical-Values-Comparison-A-College-of-American).
The same survey found >90 % of labs report critical values for potassium, sodium, calcium, platelets,
haemoglobin, aPTT, WBC and prothrombin time — which is the list our catalogue draws from.

Note the spread across institutions is enormous: high-sodium critical limits ran **147 to 170
mmol/L**, a >15 % range on the same analyte. Any single number is arbitrary, which is itself an
argument for setting ours outside the whole envelope rather than at its centre. Critical-value lists
exist so a hospital lab can telephone a treating clinician who can act immediately; that is a
regulatory obligation under CLIA and CAP accreditation, with documented read-back. A consumer app
has no clinician standing by and no repeat-and-verify step, so applying hospital thresholds verbatim
is a category error. `[well-established]`

**Creatine kinase is deliberately excluded** from critical prompts despite appearing on some
hospital lists. Section 9.6 explains why: unaccustomed eccentric training routinely produces CK
multiples that would trip any threshold worth having. `[reasonable-inference]`

**The copy:**

> **This result is a long way outside the reference range.**
> Your {analyte} was {value} {unit}; your lab's range is {low}–{high} {unit}.
> **Please contact your doctor promptly about this result.** If you feel unwell, seek urgent
> medical care rather than waiting.
> We're not going to guess what it means — that's a question for someone who can examine you and
> see your whole record.

And, appended when the result is over 14 days old, replacing the prompt entirely:

> This result, from {date}, was well outside your lab's range at the time. Your care team would
> have seen it then. If it hasn't been followed up, it's worth asking about.

### 9.6 Artifact rules — the highest-value thing this feature does

Most "abnormal" results in a healthy, hard-training adult are artifacts of when and how the blood
was drawn, not signals. Flagging them is genuinely useful and prevents needless alarm. Getting it
wrong in the other direction — explaining away something real — is the risk, so every artifact rule
obeys four constraints:

1. It fires only on **evidence the app actually has**: a logged training session near the draw
   date, a logged supplement, a concurrent result on the same panel. It never speculates.
2. It states a **mechanism and a confidence tag**, not a verdict.
3. It gives the **discriminating test** — what would settle it.
4. It **never suppresses** the out-of-range copy, and **never suppresses a critical-value prompt**
   (§9.5). An artifact note sits alongside the finding; it does not replace it.

`lab-panels.json` carries these as `artifactRules[]` per analyte, each with a `trigger`, a
`mechanism`, a `discriminator` and a `confidence`. The ones that matter for a user:

| Analyte | Trigger | What the app says |
|---|---|---|
| **CK** | Resistance or eccentric session logged within 7 d | Unaccustomed eccentric work raises CK enormously — multiples of the upper limit are routine, peaking 24–72 h after and taking up to a week to normalise. Discriminator: retest after 7 rest days. `[well-established]` |
| **AST, ALT** | Hard session within 72 h | Both are present in skeletal muscle, AST more so. A training-induced rise reads like liver injury and usually is not. Discriminator: GGT — muscle does not raise it. `[well-established]` |
| **hs-CRP** | Hard session within 72 h, **or** value > 10 mg/L | hs-CRP rises for days after hard training and with any infection. The cardiovascular-risk protocol is two draws ≥2 weeks apart when rested, discarding anything >10 mg/L as acute inflammation. `[well-established]` |
| **Ferritin** | hs-CRP or CRP elevated on the same panel | Ferritin is an acute-phase reactant as well as an iron store — inflammation raises it by roughly 30–90 % depending on phase, so a *normal* ferritin during inflammation can conceal genuinely low stores. Discriminator: transferrin saturation, and repeat when CRP is normal. `[well-established]` |
| **Serum iron, transferrin saturation** | Always | Serum iron has one of the largest within-subject variations of any common analyte (CVi ≈ 28 %) and a diurnal pattern that is not even consistent between people. A single value means very little. Discriminator: ferritin + saturation together, morning draw. `[well-established]` |
| **Haemoglobin, haematocrit, albumin, calcium** | Endurance block logged, or draw noted as non-fasting/upright | Posture and hydration shift plasma volume ~5–10 % within half an hour — which is larger than the entire reference change value for these four. Endurance training also expands plasma volume, producing "athlete's pseudoanaemia": a diluted haemoglobin with a normal red-cell mass. `[well-established]` |
| **Triglycerides, glucose** | Draw not recorded as fasting | Both move substantially postprandially; triglycerides peak 3–5 h after a meal. `[well-established]` |
| **Free T4, free T3, TSH** | Biotin logged in the supplement stack | High-dose biotin interferes with streptavidin-biotin immunoassays, producing falsely high free T4/T3 and falsely low TSH — a pattern that mimics Graves' disease. The FDA has warned about the same interference falsely lowering troponin. Discriminator: stop biotin 48–72 h before the draw and retest. `[well-established]` |
| **TSH, total testosterone** | Draw time recorded as afternoon | Both have large diurnal swings — TSH peaks overnight, testosterone in the early morning. An afternoon draw is not comparable to a morning one. Discriminator: standardise on a morning draw. `[well-established]` |
| **Potassium** | Lab reports a haemolysis flag | Haemolysis releases intracellular potassium and can fabricate hyperkalaemia. Ingest the haemolysis index when the feed provides it. `[well-established]` |

**Contract with `medication-effects.json`** (owner: medication-effects). That file records how
specific prescribed and non-prescribed agents move specific analytes, and it explicitly defers
`artifactRules[]` and this section to us. The two are **merged, not substituted**: a training-related
AST rise and a medication note can both be true, and the training rule is usually the better
explanation, so it renders first. Their file keys analytes by a hyphenated id vocabulary
(`testosterone-total`, `egfr-creatinine`, `alt-ast`) that differs from ours; because that file is not
ours to edit, the crosswalk lives on our side as `externalIdAliases` in `lab-panels.json`. **Any
consumer resolving a medication `labEffect` must map through that table first.** Ids mapping to
`null` (DHT, LH/FSH, prolactin, PSA, bleeding time, urine drug screens) have no counterpart in this
catalogue and their effects cannot be attached to a result.

Note also that `dietary-guardrails.ts` already emits `BIOTIN_ASSAY_INTERFERENCE` from the logged
supplement stack. Our biotin `artifactRules` on TSH, free T4 and free T3 consume that as a trigger
rather than re-deriving it — the stack is theirs, the lab consequence is ours.

#### 9.6.1 Creatinine, eGFR, and 5 g/day creatine — the worked example

Creatine supplementation is not an edge case: creatine is among
the most-used supplements in exactly the population that buys lab panels. **An app that trends eGFR
without knowing about creatine will systematically manufacture kidney-disease alarms in
resistance-training users.**

Mechanism `[well-established]`: supplemental creatine expands the creatine pool and can modestly
raise serum creatinine. In healthy trial participants, that rise can occur without a corresponding
reduction in measured filtration. Because creatinine-based eGFR equations invert creatinine, the
calculated estimate can fall. This is a plausible confounder for an individual result, not proof
that kidney filtration is normal.

Magnitude `[uncertain]` — commonly cited as roughly 0.1–0.3 mg/dL on 5 g/day maintenance, more
during a 20 g/day load, washing out over about four weeks after stopping. **I could not verify these
figures against primary sources** (see §12.7); the app therefore states the *direction and
mechanism*, which are solid, and does not quote a magnitude.

The copy, attached to creatinine and eGFR results when creatine is in the logged stack:

> **Creatine can change how this number reads.** Trials in healthy participants found that creatine
> can modestly raise serum creatinine without reducing measured filtration, which can lower a
> creatinine-based eGFR. That is one possible explanation, not proof that an abnormal result is
> harmless. **Tell the clinician who reads these results that you take creatine** and ask whether a
> combined creatinine-cystatin C estimate (eGFRcr-cys) or measured GFR is appropriate. Cystatin C is
> less muscle-dependent than creatinine, but it also has non-GFR influences; the combined estimate
> is generally more accurate than either marker alone.

Note what this does and does not do. It names a plausible confounder and an appropriate clinical
follow-up; it does not identify the cause. It does not say the result is fine, does not adjust the
stored value, and does not suppress a critical-value prompt.

### 9.7 Trends, and not dramatising noise

Two consecutive results differing slightly is usually **noise**. `labs.ts` gates every trend
statement behind a **reference change value (RCV)**.

**Symmetric (Fraser–Harris) form**, adequate when total CV is small:

```
RCV% = Z × √2 × √(CVa² + CVi²)
```

**Log-normal (Fokkema / Lund) form**, which is what EFLM currently recommends and what we use when
total CV ≳ 20 %:

```
RCV%(±) = 100 × (exp(± Z × √2 × √(ln(1+CVa²) + ln(1+CVi²))) − 1)     — CVs as fractions
```

The log-normal form produces **asymmetric** thresholds — the upward one is always larger. This is
not a refinement, it is a correctness requirement at high CVi: the symmetric formula can emit a
downward threshold beyond −100 %, which is physically impossible. For ferritin (CVi ≈ 22 %, CVa ≈ 3 %,
Z = 1.96) the symmetric form gives ±61 % while the log-normal gives roughly **+72 % / −42 %** — the
same evidence, a materially different message. `[well-established]` — EFLM TG-BVD,
[Biochemia Medica 2021;31(3):030902](https://www.biochemia-medica.com/en/journal/31/3/10.11613/BM.2021.030902).

**Z values — a correction.** The brief I was given said "2.33 for 95 % one-sided / 99 % two-sided."
Both halves are wrong. Correct values: **1.96** two-sided 95 %; **1.65** one-sided 95 %; **2.58**
two-sided 99 %; 2.33 one-sided 99 %. `[well-established]` We use **Z = 1.65, one-sided**, because
the clinical question is directional ("has my ferritin fallen?"), which is also the convention the
EFLM database itself publishes against. `[reasonable-inference]` on the choice; the values are not
in dispute.

**Three things the RCV alone gets wrong, and how `labs.ts` handles each:**

1. **High-CVi analytes need more than two points.** hs-CRP (CVi ≈ 44 %, RCV > 100 %), serum iron
   (≈ 28 %), transferrin saturation, insulin, folate, oestradiol, ferritin and triglycerides are
   flagged `singlePairTrendUnreliable: true`. For these the UI requires **≥ 4 results** before it
   draws a direction at all, and reports a rolling median rather than a last-vs-previous delta.
2. **Low-CVi analytes flag on physiologically trivial moves — the failure inverts.** Sodium's RCV is
   about 2–3 %, so 138 → 142 mmol/L is "statistically significant" and clinically meaningless.
   Every analyte therefore also carries a `clinicalFloor` — an absolute delta below which no change
   is reported however significant it is statistically. **A statistically significant change is not
   a clinically important one**, and an app that conflates them will frighten people over normal
   physiology. This applies to sodium, calcium, albumin, MCV, HbA1c, haemoglobin, haematocrit and
   magnesium.
3. **Multiplicity.** At 95 %, one comparison in twenty flags by chance. A 40-analyte panel compared
   against a prior panel yields ~2 spurious "significant changes" *every time*. `labs.ts` therefore
   never presents a panel-wide "what changed" list without stating how many flags are expected by
   chance, and the panel view sorts by effect size rather than by significance.

RCV is also **method-dependent**: HbA1c's RCV is 5.4 % by HPLC but 10.4 % by boronate affinity.
`[well-established]` Where results in a series come from different providers, `labs.ts` widens the
threshold to the most permissive `CVa` in the series and says so.

Per-analyte `CVi`, `CVa`, `clinicalFloor` and confidence live in `lab-panels.json` under
`biologicalVariation`. **Most of those CVi values are `[uncertain]`** — see §12.6; they are recalled
Ricos/EFLM figures that could not be verified against source in this session, and they must be
re-checked against [biologicalvariation.eu](https://biologicalvariation.eu) before ship. The ones
that *were* verified are tagged in the file.

Pre-analytical confounders (fasting, draw time, recent training, hydration, acute illness, biotin)
are carried as `artifactRules` (§9.6) and surface as caveats on any trend that crosses them. Without
that metadata, RCV is a well-calibrated test on badly confounded inputs — which is worse than no
test, because it looks rigorous.

### 9.8 The restricted diet, nutrient labs, and actual recommendations

A user may report a restricted diet or food allergy.
`micronutrients.json` (owner: nutrition-personalization) carries a `riskWithoutVegetables` rating
per nutrient — that is the join. **`nutrition-personalization.md` landed while this spec was being
written**, so the contract is now concrete rather than prospective:

| We need | They provide |
|---|---|
| Intake vs reference for a nutrient | `micronutrients.ts` → `assessNutrient` / `assessAll` → `AdequacyAssessment` |
| The upper-limit check across the whole logged stack | `dietary-guardrails.ts` → `checkUpperLimits`, and `resolveUpperLimit` / `countsTowardUpperLimit` |
| Whether a supplement can actually close the gap | `NutrientDefinition.supplementCloseability` (`equivalent` / `good` / `partial` / `poor`) and `gapsSupplementsCannotClose` |
| The ED-aware gate | `dietary-guardrails.ts` → `validateDietary`, `supportPrompt` |
| Biotin in the stack | `checkBiotinAssayInterference` — which is also the trigger for our TSH/fT4/fT3 artifact rules |

**We never compute a dose ourselves.** The labs screen states the gap and hands off; the dose, the
UL check and the ED-aware gating are theirs, because they hold the whole stack and we hold one
number.

Under `advice-policy.md` this is Tier 1 or Tier 2, not a bare cross-reference. When a nutrient
analyte is below range (or below its `goalContext`), the app says what it is, why the diet pattern
is plausibly relevant, **and what to do about it** — with the upper-limit check already run:

> **Folate 3.2 ng/mL — below your lab's range (3.9–26.8).**
> Folate comes overwhelmingly from leafy greens, legumes and fortified grains. Your logged intake
> runs at roughly {n} % of the RDA, and greens are the source you're not eating — so this result and
> your food log point the same way. `[reasonable-inference]`
> **What I'd do:** 400 µg/day of folic acid or methylfolate closes this comfortably; that is the RDA
> and well under the 1000 µg upper limit, including what your current stack already contributes.
> One caveat worth taking seriously: **folate supplementation can mask a B12 deficiency** while
> nerve damage continues. Your B12 on this panel is {value} — if B12 hasn't been checked recently,
> check it before starting folate, not after. `[well-established]`
> → Micronutrient screen

The mandatory parts of that shape: the analyte, the dietary link stated as convergent evidence
rather than proof, a **named dose within the UL after accounting for the whole logged stack**, the
one specific caveat, and the link. Where the UL check fails or the interaction is complex, it drops
to Tier 2 and names the uncertainty instead of the dose.

**Analytes in scope**, via `analyteId → micronutrientKey`: folate and RBC folate → `folate`; B12 →
`vitamin_b12`; 25-OH vitamin D → `vitamin_d`; ferritin, serum iron, transferrin saturation →
`iron`; magnesium → `magnesium`; potassium → `potassium`; calcium → `calcium`. Of these,
`micronutrients.json` rates folate the highest-risk under restricted dietary pattern, which is why it is
the worked example.

**Two constraints that survive the policy change**, both of which `advice-policy.md` explicitly
preserves:

- **Serum magnesium is a poor marker of magnesium status** — roughly 1 % of body magnesium is
  extracellular, and serum is defended at the expense of stores. A normal serum magnesium does not
  rule out depletion, and the app says so rather than treating the number as an all-clear.
  `[well-established]` This is a case where the *lab* is the weak evidence and the food log is the
  stronger one.
- **The eating-disorder rules are not overridable by any recommendation tier**
  (`advice-policy.md` §Always-on). Concretely, for a user: if `guardrails.ts` has produced an
  `ED_SCREEN_POSITIVE` or `ED_HISTORY` finding, a low nutrient result routes to the existing
  guardrails path rather than emitting a supplement recommendation from the labs screen — because a
  lab result reading as *evidence that your eating is failing* is precisely the pressure that makes
  restrictive eating worse. The recommendation still exists; it is delivered through the surface
  that is built to handle it. And in every case these results appear on the analyte screen only —
  never as a dashboard badge, a notification, or a "deficiencies: 3" count. `[reasonable-inference]`,
  and flagged in the channel for the human to overrule if they disagree.

---

## 10. The UI contract

### 10.1 Surfaces

| Surface | Shows |
|---|---|
| **Panel view** (default) | A `DiagnosticReport` as one card — panel name, date, provider, all members in one table. This is the point of modelling `DiagnosticReport` at all: a CMP is one thing a doctor ordered, not 14 loose numbers. |
| **Analyte view** | One analyte over time. Value, unit, lab range band, RCV-gated trend. Split by unit where §5.7 applies. |
| **Orphan results** | Observations with no `DiagnosticReport`, grouped by date and provider. |
| **Import receipt** | §10.2. |

The panel card shows members in the order the lab's `result[]` lists them — that is the order the
report was designed to be read in. Unresolved members are listed by name with "result not included
in this export", never omitted.

### 10.2 Import receipt

Shown after every import, and re-openable. This is the honesty surface for §1.5.

```
Imported 2026-07-26 from apple_health_export.zip

  Sutter Health          FHIR DSTU2    41 lab results,  7 panels    2019-03-02 → 2026-06-14
  Quest Diagnostics      FHIR R4       18 lab results,  3 panels    2025-01-11 → 2026-06-14

  12 duplicates skipped (already imported)
   3 results skipped — no date supplied by the lab
   1 file could not be parsed
   9 results shown in their original units (no reliable conversion)
   4 results with no reference range from the lab

  Not found in this export: ApoB, hs-CRP, free testosterone
  ↳ These may simply not have been ordered, or your provider may not publish them to
    Apple Health. This app can only show what your provider sent.
```

The "not found" line lists catalogue analytes tagged `relevanceToGoals` matching the user's active
goals — so the user learns what is genuinely missing rather than inferring it from an empty chart.

### 10.3 Manual entry

Keyed by the catalogue: pick an analyte (search by name, resolves to a LOINC), enter value + unit +
date, optionally the lab's printed range. Manually entered records get
`provider.sourceName = 'Entered manually'`, participate in trends, and are visually distinguished.
They carry `sourceKey` prefix `manual:` so an export import never collides with them.

---

## 11. Out of scope for v1

Stored raw, not modelled, not displayed as structured data:

- `Condition`, `MedicationRequest`/`MedicationOrder`/`MedicationStatement`, `AllergyIntolerance`,
  `Immunization`, `Procedure`. Retained in the vault verbatim so a future version can model them
  without another export. **`MedicationRequest` in particular is stored and never surfaced in v1**,
  because a medication list adjacent to a coaching engine is an invitation to exactly the
  medication-adjacent advice `advice-policy.md` Tier 3 rule 1 forbids. Introducing it needs its own
  safety review.
- `presentedForm` PDFs. Stored, not rendered.
- `export_cda.xml`. Not parsed (§1.3.1).
- Text-based analyte matching for results with no LOINC. A future version may offer *the user*
  "is this the same test as your other Ferritin results?" as an explicit, per-code, reversible
  confirmation. It is never automatic.
- Microbiology, pathology, imaging reports.

---

## 12. Open questions

1. **Vault schema ratification.** §8.3's `labRecords` index proposal needs the vault agent's sign-off,
   and its decision on whether a full-table decrypt per session is acceptable. If they object, the
   fallback is a **keyed** index — HMAC(LOINC) under a vault-derived subkey — which restores index
   performance while keeping the code unreadable without the DEK. I'd rather have the simple version.
2. **Does the export contain all providers?** §1.5, `[uncertain]`. Resolvable only with a real
   multi-provider export. The import receipt is designed so that being wrong here is visible rather
   than silent.
3. **Shortcuts and clinical records.** `[UNVERIFIED]` (§1.2 row 3). Doesn't block anything.
4. **Analytes with no LOINC.** Frequency unknown until we see a user's real export. If it is
   common, §11's user-confirmed matching moves up in priority.
5. **~~`nutrition-personalization.md` does not exist yet.~~ Resolved** — it landed mid-flight and
   §9.8 now names the actual API surface. The `analyteId → micronutrientKey` mapping uses the keys
   present in `micronutrients.json`. Still open: confirmation from that agent that the ED-gate
   routing in §9.8 matches what `validateDietary` expects.
6. **Critical-value thresholds are a judgement call.** §9.5 and the values in `lab-panels.json` are
   set deliberately wider than hospital lists. A clinician should review them before ship. I would
   rather they were reviewed and loosened than shipped unreviewed.
7. **Most `biologicalVariation.cvi` values are `[uncertain]`.** The web-research budget ran out
   before the EFLM Biological Variation Database could be read directly — `biologicalvariation.eu`,
   `westgard.com` and PMC are all blocked at this session's egress proxy. The values in
   `lab-panels.json` are the widely reproduced Ricos/EFLM figures, tagged `unverified`, with the
   handful that *were* verified tagged `verified` and cited. **They must be re-checked before ship.**
   Two are known to conflict across sources (ferritin ~14 % vs ~22 %; TSH ~19 % vs ~23 %) and the
   file records both. The right long-term fix is a dated, vendored snapshot of the EFLM database with
   its version recorded, not hand-transcribed numbers.
8. **eGFR biological variation is derived, not measured.** BV is published for creatinine, not for
   eGFR. Because CKD-EPI is roughly a power function of creatinine with exponent ≈ −1.2, eGFR's CV
   is approximately 1.2× creatinine's and its RCV is asymmetric before any log-normal consideration.
   There is a dedicated meta-analysis ([Front Med 2022, "Biological variation and reference change
   value of the eGFR"](https://www.frontiersin.org/journals/medicine/articles/10.3389/fmed.2022.1009358/full))
   that could not be fetched. Read it before shipping eGFR trending. `[reasonable-inference]` on the
   propagation, `[uncertain]` on the figures.
9. **Creatine → creatinine magnitude is `[uncertain]`.** The mechanism is not in doubt; the numbers
   (≈0.1–0.3 mg/dL on 5 g/day, ~4-week washout) could not be verified against Kreider et al.'s ISSN
   position stand or Gualano's work. §9.6.1's copy therefore states direction and mechanism only.
   Worth verifying, because it is the highest-traffic artifact rule for a user.
10. **Two catalogues, two id vocabularies.** `medication-effects.json` uses hyphenated analyte ids;
    we use underscored. The `externalIdAliases` crosswalk resolves it without either agent editing
    the other's file, but a single shared vocabulary would be better. Worth a decision from the
    orchestrator rather than a second crosswalk when a third file appears.
11. **Cystatin C is in the catalogue but its LOINC (33863-2) is `[uncertain]`.** It was added
    because §9.6.1 recommends it as the discriminating test for the creatine artifact and it was
    conspicuously missing. Verify the code before shipping that recommendation.
12. **Calculated free testosterone has no confirmed mass/volume LOINC.** Only a Moles/volume "by
    calculation" term (96559-0) was confirmed; US labs reporting calculated free T in pg/mL appear to
    reuse the direct-assay code 2991-8. Flagged `low` confidence in the catalogue — check against this
    user's actual feed before relying on it.
