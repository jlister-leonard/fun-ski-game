# Integration Spec: Oura API v2

**Status:** Draft for implementation — revised for the local-first PWA architecture
**Owner:** Integrations research
**Last updated:** 2026-07-26
**Governing doc:** [`docs/kg/ARCHITECTURE.md`](../ARCHITECTURE.md) — health data never leaves the device.

> **Verification note.** `cloud.ouraring.com` and `api.ouraring.com` are blocked by this environment's egress proxy
> (HTTP 403 on every fetch), so **nothing here was confirmed against the live API**. The schemas in §5 are transliterated
> from Oura's own OpenAPI document (`openapi-1.29.json`, generated 2026-05-04) as mirrored in the actively-maintained
> TypeScript client `Pinta365/oura_api` — including Oura's own field descriptions. Anything I could not corroborate is
> tagged `[UNVERIFIED]`.

---

## 0. Bottom line up front

| Question | Answer |
|---|---|
| Can we use a Personal Access Token? | **Almost certainly not for a new user.** Oura deprecated PATs; new ones cannot be created. Legacy PATs may still work. |
| Can we do OAuth2 from a pure browser app? | **No, not cleanly.** Oura's token exchange requires `client_secret` in the request body and there is no confirmed PKCE support. A client secret cannot live in a static bundle. |
| So what do we do? | **Primary: ingest Oura data via Apple Health** (Oura writes to HealthKit). **Secondary: a manual token paste** for users who hold a legacy PAT or who run the token exchange themselves. |
| What do we lose via Apple Health? | **The scores.** Readiness, Sleep and Activity scores and all their contributors do not reach HealthKit. This is the big one — see §3. |

---

## 1. Authentication — and why it is a problem for us

### 1.1 Personal Access Tokens are deprecated

The maintained TS client's README states plainly:

> ⚠️ **Personal Access Tokens (PATs) no longer supported** — "The Oura API platform has deprecated direct Personal
> Access Tokens. Authentication is now done via **OAuth2** only."

Corroborating search evidence: **PATs deprecated December 2025**; new PATs can no longer be created; previously-issued
PATs may still function during a transition period.

`[UNVERIFIED — exact date]` The *direction* (OAuth2-only for new integrations) is solid and corroborated by a maintained
client library that removed its PAT code path. The specific month rests on search-summary evidence only.

**Implication:** we cannot tell a new user "go to the Oura dashboard and create a token." That page no longer offers it.

### 1.2 OAuth2 endpoints (verified from the client's source)

```
authorize:        https://cloud.ouraring.com/oauth/authorize
token:            https://api.ouraring.com/oauth/token
revoke:           https://api.ouraring.com/oauth/revoke
API base:         https://api.ouraring.com/v2/usercollection/
sandbox base:     https://api.ouraring.com/v2/sandbox/usercollection/
app registration: https://cloud.ouraring.com/oauth/applications
```

Flow shapes:

- **Authorize (GET, browser redirect):** `response_type=code`, `client_id`, `redirect_uri`, `scope` (**space-delimited**,
  unlike Strava's commas), `state`.
- **Token exchange (POST, `application/x-www-form-urlencoded`):** `grant_type=authorization_code`, `code`,
  `redirect_uri`, `client_id`, **`client_secret`**. Credentials go in the **body**, not a Basic auth header.
- **Refresh (POST, form-encoded):** `grant_type=refresh_token`, `refresh_token`, `client_id`, **`client_secret`**.
- **Revoke:** `POST https://api.ouraring.com/oauth/revoke?access_token=<token>` — token as a **query param**, no body.

```ts
export interface OuraTokenResponse {
  access_token: string;
  expires_in: number;      // seconds
  refresh_token: string;
  token_type: 'bearer';
}
```

### 1.3 Why this breaks in a browser

Both the initial exchange and every refresh require **`client_secret`**. In a static PWA there is nowhere to put it —
anything in the bundle is readable by anyone who opens DevTools or downloads the JS. Shipping it would mean publishing
our app's Oura credentials to the world.

`[UNVERIFIED]` I could not confirm whether Oura supports **PKCE** (`code_challenge`/`code_verifier`), which is the
standard way a public client avoids needing a secret. The OpenAPI-derived client I inspected implements only the
confidential-client flow. **If Oura does support PKCE, that changes this recommendation substantially** — it should be
the first thing re-checked when live docs are reachable.

### 1.4 Scopes (8, verified)

| Scope | Grants |
|---|---|
| `email` | User's email address |
| `personal` | Personal info (biological sex, age, height, weight) |
| `daily` | Daily summaries — sleep, activity, readiness |
| `heartrate` | Time-series heart rate |
| `workout` | Auto-detected and user-entered workouts |
| `tag` | User-entered tags |
| `session` | Guided/unguided sessions ("Moments") |
| `spo2Daily` | SpO2 average recorded during sleep |

> **Trap:** the reference TS client's scope union lists the tag scope as the string `"tag User"` — that is a bug in the
> library (it swallowed the docs table's next column). The correct literal is **`tag`**.

Users toggle scopes individually at consent, so **every scope must be treated as optionally denied**. A 401/403 on one
collection must not fail the whole sync.

### 1.5 Token lifetimes

- Access token: **~30 days** `[UNVERIFIED — exact value]`. Never hardcode; read `expires_in`.
- Refresh token: **rotating / single-use** — each refresh returns a new `refresh_token` that must replace the old one.
  In our vault this means a read-modify-write inside one Dexie transaction.
- The client-side **implicit flow returns no refresh token** → 30-day expiry then full re-auth.

### 1.6 The 10-user cap (verified, Oura's own OpenAPI text)

> "API Applications are limited to **10** users before requiring approval from Oura. There is no limit once an
> application is approved. Additionally, Oura users **must provide consent** to share each data type an API Application
> has access to."

Irrelevant for a single-user personal app, but relevant if this is ever distributed.

### 1.7 Sandbox

Every `usercollection` route has a parallel `sandbox/usercollection` route returning simulated data with no real account.
**Use this for development and for the CORS probe described in §2.3** — it costs nothing and needs no credentials.

---

## 2. Can the browser talk to Oura directly?

### 2.1 CORS status

`[UNVERIFIED — could not reach live API]` I could not test whether `api.ouraring.com` returns
`Access-Control-Allow-Origin` headers usable by a browser `fetch()`, and the session's search budget was exhausted before
I could find community reports. **This must be verified before building the direct path.**

Three possible outcomes, all of which the app must handle:

| Outcome | Consequence |
|---|---|
| Oura sends `Access-Control-Allow-Origin: *` (or echoes origin) on `/v2/usercollection/*` | Direct browser reads work with a `Bearer` token. Best case. |
| Oura sends no CORS headers | Browser reads are **impossible**. Direct path is dead; Apple Health only. |
| CORS on data routes but not `/oauth/token` | Data reads work, but token **refresh** cannot happen in-browser → the token expires and the user must re-paste. Degraded but usable. |

The third outcome is the most likely and the most awkward, because it is exactly the pattern most APIs land on: they
CORS-enable resource endpoints but not the token endpoint.

### 2.2 The realistic direct-path design: paste a token

Given §1.3, the only browser-viable direct path is **the user supplies a bearer token out-of-band**:

1. User holds a **legacy PAT** (if they created one before deprecation), or
2. User registers their *own* Oura OAuth application at `https://cloud.ouraring.com/oauth/applications`, runs the
   authorize + token exchange **themselves once** (a `curl` one-liner or an Apple Shortcut we generate), and pastes the
   resulting `access_token` into our vault.

The token is stored **encrypted in the vault** and sent only in an `Authorization: Bearer` header directly from the
device to `api.ouraring.com`. Nothing we operate is in that path.

**Honesty requirement:** the UI must state that a pasted access token expires (~30 days) and that without a
`client_secret` we cannot refresh it for them, so they will need to repeat the paste. Do not pretend this is a
"connect once" flow.

### 2.3 Runtime CORS probe

Because we cannot verify CORS statically, **the app should determine it empirically and tell the user the truth.** On
the Oura settings screen, before offering the direct path:

```ts
/**
 * Probe whether the browser can reach Oura at all. Uses the credential-free
 * sandbox route so it costs nothing and needs no token.
 * Returns 'ok' | 'cors-blocked' | 'network-error'.
 */
export async function probeOuraCors(): Promise<'ok' | 'cors-blocked' | 'network-error'> {
  try {
    const res = await fetch(
      'https://api.ouraring.com/v2/sandbox/usercollection/daily_sleep?start_date=2024-01-01&end_date=2024-01-02',
      { method: 'GET', mode: 'cors' },
    );
    // Any HTTP status (even 401) means CORS preflight passed and we got a response.
    return res.status >= 0 ? 'ok' : 'network-error';
  } catch {
    // A CORS failure surfaces as an opaque TypeError, indistinguishable from
    // offline — so check connectivity before concluding 'cors-blocked'.
    return navigator.onLine ? 'cors-blocked' : 'network-error';
  }
}
```

Gate the "Connect Oura directly" UI on this returning `ok`. If it returns `cors-blocked`, hide the direct path entirely
and explain that Oura's API cannot be reached from a browser, so Apple Health is the route.

---

## 3. What Oura writes into HealthKit — and what is lost

**This is the decisive tradeoff table.** The Oura iOS app syncs a subset of its data into Apple Health, which our
Shortcuts pipeline picks up for free with zero credentials.

`[UNVERIFIED — could not reach live docs]` The exact write-list is from general knowledge of the Oura app's Apple Health
integration, not a fetched Oura support page. Treat the "carried" column as *expected* and verify on-device by opening
Health → Sources → Oura, which lists precisely what it writes.

| Oura data | Reaches HealthKit? | HealthKit type |
|---|---|---|
| Sleep periods + stages | **Yes** | `HKCategoryTypeIdentifierSleepAnalysis` (`AsleepCore`/`AsleepDeep`/`AsleepREM`/`Awake`/`InBed`) |
| Heart rate (time series) | **Yes** | `HKQuantityTypeIdentifierHeartRate` |
| Resting heart rate | **Yes** | `HKQuantityTypeIdentifierRestingHeartRate` |
| HRV | **Yes** | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` |
| Respiratory rate | **Yes** | `HKQuantityTypeIdentifierRespiratoryRate` |
| SpO2 | **Yes** | `HKQuantityTypeIdentifierOxygenSaturation` |
| Body temperature deviation | **Partial / unreliable** | Oura's headline metric is a *deviation from personal baseline*, which has no clean HealthKit equivalent |
| Steps, active energy | **Yes** | `HKQuantityTypeIdentifierStepCount`, `ActiveEnergyBurned` |
| Workouts | **Yes** | `HKWorkoutType` |
| **Readiness score (0–100)** | **NO** | — |
| **Sleep score (0–100)** | **NO** | — |
| **Activity score (0–100)** | **NO** | — |
| **All score contributors** (`hrv_balance`, `recovery_index`, `sleep_balance`, `body_temperature`, …) | **NO** | — |
| **Daily Stress** (`day_summary`, `stress_high`, `recovery_high`) | **NO** | — |
| **Resilience level** | **NO** | — |
| **Cardiovascular age** (`vascular_age`) | **NO** | — |
| **VO2 max estimate** | **Possibly** | `HKQuantityTypeIdentifierVO2Max` exists; whether Oura writes it is `[UNVERIFIED]` |
| Sleep timing recommendations (`sleep_time`) | **NO** | — |
| Tags / sessions | **NO** | — |

### 3.1 What this means for the product

Going via Apple Health, we get **the raw physiology but none of Oura's interpretation.** That is a real loss — Oura's
readiness score and its contributors are the most legible thing the ring produces, and they are exactly what a coaching
UI would want to surface.

**Mitigation:** the raw inputs to readiness *are* mostly available via HealthKit (HRV, resting HR, sleep duration and
stages, body temperature, previous-day activity). We can compute our own equivalent signals — a HRV-balance trend, a
sleep-debt figure, a resting-HR-vs-baseline delta — using the same underlying data. See
`docs/kg/specs/training-methodology.md`. This is arguably *better* for the product: our numbers are auditable and
explainable, whereas Oura's score is a black box we could only display, never justify.

**Recommendation:** treat the Oura score fields as a *nice-to-have* available only on the direct-API path, and design
the UI so their absence is graceful — not a hole where a number should be.

---

## 4. Endpoints (for the direct path)

Base: `https://api.ouraring.com/v2/usercollection/` — header `Authorization: Bearer <token>`.

### 4.1 Date-ranged collections — `start_date` / `end_date` (`YYYY-MM-DD`)

All have a list form and a single-document form `GET .../{document_id}`:

| Path | Document model |
|---|---|
| `daily_activity` | `PublicDailyActivity` |
| `daily_sleep` | `PublicDailySleep` |
| `daily_readiness` | `PublicDailyReadiness` |
| `sleep` | `PublicModifiedSleepModel` |
| `sleep_time` | `PublicSleepTime` |
| `daily_spo2` | `PublicDailySpO2` |
| `daily_stress` | `PublicDailyStress` |
| `daily_resilience` | `DailyResilienceModel` |
| `daily_cardiovascular_age` | `PublicDailyCardiovascularAge` |
| `vO2_max` | `PublicVO2Max` |
| `session` | `PublicSession` |
| `workout` | `PublicWorkout` |
| `enhanced_tag` | `EnhancedTagModel` |
| `tag` | `TagModel` — **DEPRECATED**, use `enhanced_tag` |
| `rest_mode_period` | `PublicRestModePeriod` |

> **Case sensitivity:** the VO2 max path is literally **`vO2_max`** (lowercase v, uppercase O). The webhook enum spells
> it `vo2_max` and the *field* is `vo2_max`. Three spellings, all real, in different places. Highest-risk typo in this
> whole spec.

### 4.2 Datetime-ranged time series — `start_datetime` / `end_datetime` (ISO 8601 with offset)

| Path | Row model | Single-doc route? |
|---|---|---|
| `heartrate` | `PublicHeartRateRow` | **No** |
| `interbeat_interval` | `PublicInterbeatIntervalRow` | **No** |
| `ring_battery_level` | `PublicRingBatteryLevelRow` | **No** |

### 4.3 Special cases that break a generic client

- **`personal_info`** — no query params, no `{document_id}` route, and returns a **bare object**, not a
  `{data, next_token}` envelope.
- **`ring_configuration`** — returns the standard envelope but **ignores `start_date`/`end_date`** entirely.

Both will break a naive "fetch any collection by date range" abstraction. Special-case them.

### 4.4 Webhooks — not usable by us

Oura offers a webhook subscription API (`/v2/webhook/subscription`). **It requires a publicly reachable
`callback_url`, which a local-first app does not have.** Documented here only so a future reader knows we consciously
skipped it. Polling on app open is our model.

---

## 5. Response envelope and pagination

```ts
/** Collections. */
export interface OuraMultiDocumentResponse<T> {
  data: T[];
  next_token: string | null;   // key always present, value nullable
}

/** Time series (heartrate, interbeat_interval, ring_battery_level). */
export interface OuraTimeSeriesResponse<T> {
  data: T[];
  next_token?: string | null;  // key optional
}
```

Consume as `next_token?: string | null` everywhere and both are covered.

**Pagination mechanics:** issue the first request with your date params; if `next_token` is non-null, issue the next
request with **`next_token` as the sole query parameter** — the date range is *not* repeated, it is encoded in the token.
Loop until `next_token` is null or absent.

```
GET /v2/usercollection/sleep?start_date=2026-07-01&end_date=2026-07-26
GET /v2/usercollection/sleep?next_token=<token>
GET /v2/usercollection/sleep?next_token=<token2>   ... until null
```

Single-document GETs return the **bare document**, with no `data` wrapper.

---

## 6. TypeScript interfaces

```ts
// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type OuraISODate = string;          // "YYYY-MM-DD"
export type OuraLocalDateTime = string;    // ISO 8601, no offset
export type OuraLocalizedDateTime = string;// ISO 8601 with offset
export type OuraUtcDateTime = string;      // ISO 8601 UTC

export interface OuraMetadata {
  updated_at: OuraUtcDateTime;
  version: number;
}

/**
 * Sampled series. Reconstruct point i's time as timestamp + i * interval.
 * `items` CONTAINS NULLS where the ring had no reading — always null-guard
 * before charting or averaging.
 */
export interface OuraSample {
  interval: number;             // seconds between items
  items: (number | null)[];
  timestamp: OuraLocalizedDateTime;
}

// Documents WITHOUT `meta`: DailyResilienceModel, TagModel, EnhancedTagModel,
// PersonalInfoResponse. Everything else carries `id` + `meta`.

// ---------------------------------------------------------------------------
// daily_sleep
// ---------------------------------------------------------------------------

export interface OuraSleepContributors {   // each "in range [1, 100]"
  deep_sleep?: number | null;
  efficiency?: number | null;
  latency?: number | null;
  rem_sleep?: number | null;
  restfulness?: number | null;
  timing?: number | null;
  total_sleep?: number | null;
}

export interface OuraDailySleep {
  id: string;
  meta: OuraMetadata;
  contributors: OuraSleepContributors;
  day: OuraISODate;
  score?: number | null;
  timestamp: OuraLocalizedDateTime;
}

// ---------------------------------------------------------------------------
// daily_readiness
// ---------------------------------------------------------------------------

export interface OuraReadinessContributors {  // each "in range [1, 100]"
  activity_balance?: number | null;
  body_temperature?: number | null;
  hrv_balance?: number | null;
  previous_day_activity?: number | null;
  previous_night?: number | null;
  recovery_index?: number | null;
  resting_heart_rate?: number | null;
  sleep_balance?: number | null;
  /** NINTH contributor, present in spec 1.29. Easy to miss. */
  sleep_regularity?: number | null;
}

export interface OuraDailyReadiness {
  id: string;
  meta: OuraMetadata;
  contributors: OuraReadinessContributors;
  day: OuraISODate;
  score?: number | null;
  temperature_deviation?: number | null;        // degrees Celsius
  temperature_trend_deviation?: number | null;  // degrees Celsius
  timestamp: OuraLocalizedDateTime;
}

// ---------------------------------------------------------------------------
// daily_activity
// ---------------------------------------------------------------------------

export interface OuraActivityContributors {
  meet_daily_targets?: number | null;
  move_every_hour?: number | null;
  recovery_time?: number | null;
  stay_active?: number | null;
  training_frequency?: number | null;
  training_volume?: number | null;
}

export interface OuraDailyActivity {
  id: string;
  meta: OuraMetadata;
  active_calories: number;                 // kcal
  average_met_minutes: number;
  /** 1 char per 5 min: 0=non-wear 1=rest 2=inactive 3=low 4=medium 5=high */
  class_5_min?: string | null;
  contributors: OuraActivityContributors;
  day: OuraISODate;
  equivalent_walking_distance: number;     // meters
  high_activity_met_minutes: number;
  high_activity_time: number;              // seconds
  inactivity_alerts: number;
  low_activity_met_minutes: number;
  low_activity_time: number;               // seconds
  medium_activity_met_minutes: number;
  medium_activity_time: number;            // seconds
  met: OuraSample;
  meters_to_target: number;
  non_wear_time: number;                   // seconds
  resting_time: number;                    // seconds
  score?: number | null;
  sedentary_met_minutes: number;
  sedentary_time: number;                  // seconds
  steps: number;
  target_calories: number;                 // kcal
  target_meters: number;
  timestamp: OuraLocalizedDateTime;
  total_calories: number;                  // kcal
}

// ---------------------------------------------------------------------------
// sleep (detailed periods)
// ---------------------------------------------------------------------------

export type OuraSleepType = 'deleted' | 'sleep' | 'long_sleep' | 'late_nap' | 'rest';

/** Readiness snapshot nested inside a sleep document (no id/meta/day). */
export interface OuraNestedReadiness {
  contributors: OuraReadinessContributors;
  score?: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}

export interface OuraSleep {
  id: string;
  meta: OuraMetadata;
  average_breath?: number | null;          // breaths/min
  /** NB: 30-second-sample based; will NOT match the Oura app. See §7.3. */
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  awake_time?: number | null;              // seconds
  bedtime_end: OuraLocalizedDateTime;
  bedtime_start: OuraLocalizedDateTime;
  day: OuraISODate;
  deep_sleep_duration?: number | null;     // seconds
  efficiency?: number | null;              // [1, 100]
  heart_rate?: OuraSample | null;
  hrv?: OuraSample | null;
  latency?: number | null;                 // seconds to fall asleep
  light_sleep_duration?: number | null;    // seconds
  low_battery_alert: boolean;
  lowest_heart_rate?: number | null;
  /** 1=no motion 2=restless 3=tossing/turning 4=active */
  movement_30_sec?: string | null;
  period: number;
  readiness?: OuraNestedReadiness | null;
  readiness_score_delta?: number | null;
  rem_sleep_duration?: number | null;      // seconds
  restless_periods?: number | null;
  sleep_algorithm_version?: 'v1' | 'v2' | null;
  sleep_analysis_reason?: 'foreground_sleep_analysis' | 'bedtime_edit' | null;
  /** 1=deep 2=light 3=REM 4=awake */
  sleep_phase_30_sec?: string | null;
  sleep_phase_5_min?: string | null;
  sleep_score_delta?: number | null;
  time_in_bed: number;                     // seconds
  total_sleep_duration?: number | null;    // seconds
  type?: OuraSleepType | null;
  ring_id?: string | null;
  /** App-aligned variant. Oura says this WILL BE REMOVED. Prefer sleep_phase_5_min. */
  app_sleep_phase_5_min?: string | null;
}

// ---------------------------------------------------------------------------
// daily_spo2 / daily_stress / daily_resilience
// ---------------------------------------------------------------------------

export interface OuraSpo2AggregatedValues { average: number; }

export interface OuraDailySpO2 {
  id: string;
  meta: OuraMetadata;
  breathing_disturbance_index?: number | null;  // [0, 100]
  day: OuraISODate;
  /** An OBJECT, not a number: { average: 96.5 } */
  spo2_percentage?: OuraSpo2AggregatedValues | null;
}

export interface OuraDailyStress {
  id: string;
  meta: OuraMetadata;
  day: OuraISODate;
  day_summary?: 'restored' | 'normal' | 'stressful' | null;
  recovery_high?: number | null;   // seconds in high-recovery zone
  stress_high?: number | null;     // seconds in high-stress zone
}

export type OuraResilienceLevel =
  | 'limited' | 'adequate' | 'solid' | 'strong' | 'exceptional';

/** Structurally the odd one out: no meta, no timestamp, no score. */
export interface OuraDailyResilience {
  id: string;
  day: OuraISODate;
  contributors: {
    sleep_recovery: number;    // REQUIRED, [0, 100]
    daytime_recovery: number;
    stress: number;
  };
  level: OuraResilienceLevel;
}

// ---------------------------------------------------------------------------
// daily_cardiovascular_age / vO2_max
// ---------------------------------------------------------------------------

export interface OuraDailyCardiovascularAge {
  id: string;
  meta: OuraMetadata;
  day: OuraISODate;
  /** Field is `vascular_age`, NOT `cardiovascular_age`. Range [18, 100]. */
  vascular_age?: number | null;
}

export interface OuraVO2Max {
  id: string;
  meta: OuraMetadata;
  day: OuraISODate;
  timestamp: OuraLocalizedDateTime;
  /** Field is `vo2_max`; the PATH is `vO2_max`. Required, non-nullable. */
  vo2_max: number;
}

// ---------------------------------------------------------------------------
// workout / session
// ---------------------------------------------------------------------------

export interface OuraWorkout {
  id: string;
  meta: OuraMetadata;
  activity: string;                 // free-form string, NOT an enum
  calories?: number | null;         // kcal
  day: OuraISODate;
  distance?: number | null;         // meters
  end_datetime: OuraLocalizedDateTime;
  intensity: 'easy' | 'moderate' | 'hard';
  label?: string | null;
  source: 'manual' | 'autodetected' | 'confirmed' | 'workout_heart_rate';
  start_datetime: OuraLocalizedDateTime;
}

export interface OuraSession {
  id: string;
  meta: OuraMetadata;
  day: OuraISODate;
  end_datetime: OuraLocalizedDateTime;
  heart_rate?: OuraSample | null;
  /** NB: full word here; `sleep` uses `hrv`. */
  heart_rate_variability?: OuraSample | null;
  mood?: 'bad' | 'worse' | 'same' | 'good' | 'great' | null;
  motion_count?: OuraSample | null;
  start_datetime: OuraLocalizedDateTime;
  type: 'breathing' | 'meditation' | 'nap' | 'relaxation' | 'rest' | 'body_status';
}

// ---------------------------------------------------------------------------
// Time-series rows
// ---------------------------------------------------------------------------

export interface OuraHeartRateRow {
  timestamp: OuraUtcDateTime;
  timestamp_unix: number;   // unix MILLISECONDS
  bpm: number;
  source: 'awake' | 'workout' | 'rest' | 'sleep' | 'live' | 'session';
}

export interface OuraInterbeatIntervalRow {
  timestamp: OuraUtcDateTime;
  timestamp_unix: number;
  ibi: number;        // ms between beats, capped at 2000
  /** 1=Good 2=Bad 3=Corrected -1/-2=Gap 0=Raw(Uncorrected) */
  validity: number;
}

export interface OuraRingBatteryLevelRow {
  timestamp: OuraUtcDateTime;
  timestamp_unix: number;
  charging?: boolean | null;
  in_charger?: boolean | null;
  level: number;      // [0, 100]
}

// ---------------------------------------------------------------------------
// personal_info (bare object, no envelope)
// ---------------------------------------------------------------------------

export interface OuraPersonalInfo {
  id: string;
  age?: number | null;
  weight?: number | null;          // kg
  height?: number | null;          // meters
  biological_sex?: string | null;
  email?: string | null;           // only with `email` scope
}

// ---------------------------------------------------------------------------
// enhanced_tag / rest_mode_period / sleep_time / ring_configuration
// ---------------------------------------------------------------------------

export interface OuraEnhancedTag {
  id: string;
  tag_type_code?: string | null;   // null for text-only; "custom" for custom
  start_time: OuraLocalDateTime;
  end_time?: OuraLocalDateTime | null;
  start_day: OuraISODate;          // NB: start_day/end_day, not `day`
  end_day?: OuraISODate | null;
  comment?: string | null;
  custom_name?: string | null;
}

export interface OuraRestModePeriod {
  id: string;
  meta: OuraMetadata;
  end_day?: OuraISODate | null;
  end_time?: OuraLocalizedDateTime | null;
  episodes: Array<{ tags: string[]; timestamp: OuraLocalizedDateTime }>;
  start_day: OuraISODate;
  start_time?: OuraLocalizedDateTime | null;
}

export interface OuraSleepTimeWindow {
  day_tz: number;        // timezone offset in SECONDS from GMT
  end_offset: number;    // seconds from midnight
  start_offset: number;  // seconds from midnight
}

export interface OuraSleepTime {
  id: string;
  meta: OuraMetadata;
  day: OuraISODate;
  optimal_bedtime?: OuraSleepTimeWindow | null;
  recommendation?:
    | 'improve_efficiency' | 'earlier_bedtime' | 'later_bedtime'
    | 'earlier_wake_up_time' | 'later_wake_up_time' | 'follow_optimal_bedtime'
    | null;
  status?:
    | 'not_enough_nights' | 'not_enough_recent_nights' | 'bad_sleep_quality'
    | 'only_recommended_found' | 'optimal_found'
    | null;
}

export interface OuraRingConfiguration {
  id: string;
  meta: OuraMetadata;
  color?: string | null;
  design?: 'heritage' | 'balance' | 'balance_diamond' | 'horizon' | 'ceramic' | null;
  firmware_version?: string | null;
  hardware_type?: 'gen1' | 'gen2' | 'gen2m' | 'gen3' | 'gen4' | null;
  set_up_at?: OuraUtcDateTime | null;
  size?: number | null;   // US ring size
}
```

---

## 7. Score semantics — so the UI can explain, not just display

### 7.1 Scale and banding

Scores run **1–100** (resilience contributors are `[0, 100]`). Oura's published banding, applied to both overall scores
and individual contributors:

| Band | Range | UI treatment |
|---|---|---|
| Optimal | **85–100** | green / positive |
| Good | **70–84** | neutral |
| Pay attention | **below 70** | red, surfaced as actionable |

Using the same thresholds gives users a UI consistent with the app they already know.

### 7.2 Readiness contributors, in plain language

| Field | What it actually measures |
|---|---|
| `activity_balance` | Whether cumulative activity over recent days/weeks has left capacity, or you've been overreaching. Low = load exceeding recovery. |
| `body_temperature` | Deviation of body temperature from *your* baseline. Elevation often precedes illness. Pairs with `temperature_deviation` on the same document. |
| `hrv_balance` | Your **two-week HRV trend vs. your three-month average**. The single best "am I trending down?" signal. |
| `previous_day_activity` | Whether yesterday's activity was appropriate — penalises *both* an unusually hard day and total inactivity. |
| `previous_night` | Last night's sleep quality rolled into one number feeding today's readiness. |
| `recovery_index` | How many hours of sleep you got *after* your heart rate bottomed out. **≥6 hours** post-nadir boosts readiness — i.e. how early your body finished recovering. |
| `resting_heart_rate` | Last night's resting HR vs. normal, and whether it settled early (good) or stayed elevated (late meal, alcohol, stress, illness). |
| `sleep_balance` | Accumulated sleep debt over the past two weeks. |
| `sleep_regularity` | Consistency of sleep/wake *timing*. Irregular schedules depress it even when total sleep is fine. |

### 7.3 Sleep contributors, in plain language

| Field | What it actually measures |
|---|---|
| `total_sleep` | Light + REM + deep. Most adults need 7–9 h. |
| `efficiency` | % of time in bed actually asleep. ~85%+ is good. |
| `restfulness` | How much you moved — awakenings, position changes. Corresponds to `restless_periods` / `movement_30_sec`. |
| `rem_sleep` | REM vs. expectation. ≈**20–25% (1.5–2 h)** for adults; memory, learning, creativity. Declines with age. |
| `deep_sleep` | The most physically restorative stage. ≈**15–20% (1–1.5 h)**; declines with age. |
| `latency` | Minutes to fall asleep. **Healthy is 10–20 min.** **Non-monotonic — under 5 minutes scores WORSE**, because it signals sleep deprivation. This needs a tooltip; users assume faster is better and get confused. |
| `timing` | How well the sleep window aligned with your circadian rhythm. Penalises very late or shifted nights. |

Weighting: `total_sleep` and `efficiency` dominate, then `restfulness`, `rem_sleep`, `deep_sleep`; `latency` and
`timing` carry less weight but grow influential on sharp deviations. `[UNVERIFIED]` Exact numeric weights are not
published — **do not attempt to reconstruct or "verify" the score.**

### 7.4 A discrepancy to disclose in the UI

Oura's own spec notes that `sleep.average_heart_rate` and `sleep.lowest_heart_rate` are computed by ecore from
**30-second samples**, whereas the Oura app displays averages of **5-minute aggregated samples**. Our numbers will
therefore differ slightly from the app. Either state this in a tooltip or recompute from `heart_rate.items` to match the
app — but pick one deliberately, because "why doesn't this match my ring?" is a trust-destroying question.

---

## 8. Rate limits

**The one hard documented number**, from Oura's own OpenAPI `info.description`:

> **429 Request Rate Limit Exceeded** — "The API is rate limited to **5000 requests in a 5 minute period**."

`[UNVERIFIED]` Oura's current docs describe a newer **two-layer** model — a per-access-token limit and a
per-application limit — with these headers on a 429: `Retry-After` (seconds), `X-RateLimit-Limit`,
`X-RateLimit-Window` (rolling window, seconds), `X-RateLimit-Reset` (unix epoch), `X-RateLimit-Tier` (which layer
fired). **I could not obtain the actual numeric limits for either tier.**

For a single-user local-first app this is a non-issue in practice — a daily sync is a handful of requests. Still:

- Do not hardcode a budget; read `X-RateLimit-*` from responses.
- Honour `Retry-After` on 429 with exponential backoff.
- Treat 5000/5min as a conservative ceiling until confirmed.

Documented error codes: `200 OK`, `400` (query parameter validation error), `429` (rate limit). Error bodies carry a
**`detail`** field which may be a `string` *or* a structured `ValidationError[]` — type it defensively as
`string | unknown[]`.

---

## 9. Sync design (direct path, no server)

All of this runs in the browser, on app open — there is no background job.

1. **Unlock vault** → decrypt the stored Oura token.
2. **Probe** connectivity/CORS (§2.3); if blocked, show the honest message and stop.
3. **Incremental pull.** Track `last_synced_day` in the vault. Request each enabled collection for
   `[last_synced_day - 2, today]` — a 2-day overlap, because Oura revises recent days (sleep gets re-analysed,
   readiness recomputed).
4. **Paginate** via `next_token` until exhausted.
5. **Upsert** into Dexie keyed on `(source='oura', collection, id)`. Oura's `id` is stable per document; `meta.version`
   and `meta.updated_at` tell you whether to overwrite.
6. **Backfill** on first connect: walk backwards in ~90-day windows. Oura data volume is small (one document per day per
   collection), so a multi-year backfill is only a few hundred requests — trivially within limits, but do it in chunks
   with progress UI since it happens on the main thread.
7. **Never** call `heartrate` or `interbeat_interval` for a wide range on first sync — those are the only high-volume
   endpoints (thousands of rows/day). Gate them behind an explicit "import detailed heart rate" toggle.

---

## 10. Gotchas

- **Path casing `vO2_max`** and **scope literal `tag`** are the two most likely copy-paste failures.
- **`sleep_regularity`** is a 9th readiness contributor — omit it and your contributor chart silently drops a bar.
- **`OuraSample.items` contains real nulls** (non-wear gaps), not a codegen artifact. Null-guard before averaging.
- **`timestamp_unix`** (unix **milliseconds**) exists on all three time-series row types — cheaper than re-parsing strings.
- **`spo2_percentage` is an object** `{average: number}`, not a number.
- **Filter `sleep` by `type`.** Exclude `deleted` and `rest` always. `long_sleep` (>3 h) is the main night;
  `sleep` (15 min–3 h) and `late_nap` are naps. `late_nap` contributes to the *next* day's scores.
- **`daily_resilience` has no `score`, no `meta`, no `timestamp`** and its contributors are required with a `[0,100]`
  range. Do not reuse a generic contributor renderer without checking.
- **`app_sleep_phase_5_min` is slated for removal** — prefer `sleep_phase_5_min` and isolate any use behind one accessor.
- **`enhanced_tag` uses `start_day`/`end_day`**, but the *query params* are still `start_date`/`end_date`.
- **`daily_cardiovascular_age` and `vO2_max` are sparse** — documents exist only on days an estimate was produced.
  Render as "last computed on {day}", not a dense daily series.
- **`workout.activity` is a free-form string**, not an enum. Normalise via a lookup table with a fallback.
- **Interbeat interval `validity`**: only `1` (good) and `3` (corrected) are trustworthy for HRV computation.
- **Oura's `day` field is the "sleep day"**, which rolls over at ~6 pm for late naps — it is not a naive calendar date
  derived from `timestamp`. Always trust `day`, never recompute it from the timestamp.

---

## 11. Mapping to the canonical model

| Canonical | Oura source |
|---|---|
| `DailySummary.readiness_score` | `daily_readiness.score` |
| `DailySummary.sleep_score` | `daily_sleep.score` |
| `DailySummary.activity_score` | `daily_activity.score` |
| `DailySummary.readiness_contributors` | `daily_readiness.contributors` (stored as a nested object) |
| `DailySummary.local_date` | `day` (**never** recomputed from `timestamp`) |
| `SleepSession.*` | `sleep` document — `bedtime_start/end`, `*_duration` (already seconds), `efficiency`, `latency` |
| `SleepSession.samples` | `sleep.hrv`, `sleep.heart_rate`, `sleep_phase_5_min` |
| `MetricSample('hrv_sdnn')` | `sleep.average_hrv`, or `hrv.items[]` expanded |
| `MetricSample('resting_heart_rate')` | `sleep.lowest_heart_rate` |
| `MetricSample('spo2')` | `daily_spo2.spo2_percentage.average` |
| `MetricSample('vo2_max')` | `vO2_max.vo2_max` |
| `MetricSample('cardiovascular_age')` | `daily_cardiovascular_age.vascular_age` |
| `Workout.*` | `workout` — `distance` (meters), `calories` (kcal), `intensity` |

Units are already SI: durations in **seconds**, distance in **meters**, energy in **kcal**, temperature deviations in
**degrees Celsius**. No conversion needed on ingest.

---

## Sources

- [Pinta365/oura_api](https://github.com/Pinta365/oura_api) — `src/types/generated.ts`, generated from
  `https://cloud.ouraring.com/v2/static/json/openapi-1.29.json` (2026-05-04); plus `src/OuraBase.ts`, `src/utils.ts`,
  `src/utilsOAuth.ts`, `README.md`
- [balenamiaa/oura_api](https://github.com/balenamiaa/oura_api) — README carrying Oura's verbatim OpenAPI
  `info.description` (rate limit, 10-user cap, response codes)
- [Oura API Authentication](https://cloud.ouraring.com/docs/authentication) *(403 from this environment)*
- [Oura API Documentation 2.0](https://api.ouraring.com/v2/docs) *(403 from this environment)*
- [Readiness Contributors — Oura Member Care](https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors)
- [Sleep Contributors — Oura Member Care](https://support.ouraring.com/hc/en-us/articles/360057792293-Sleep-Contributors)
- [Your Oura Sleep Score](https://ouraring.com/blog/sleep-score/)
