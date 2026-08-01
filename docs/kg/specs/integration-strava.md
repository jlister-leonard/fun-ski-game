# Integration Spec: Strava API v3

**Status:** Draft for implementation — revised for the local-first PWA architecture
**Owner:** Integrations research
**Last updated:** 2026-07-26
**Governing doc:** [`docs/kg/ARCHITECTURE.md`](../ARCHITECTURE.md) — health data never leaves the device.

> **Verification note.** Direct network calls to `developers.strava.com` and `www.strava.com` are blocked by this
> environment's egress proxy (HTTP 403 on every fetch), so **nothing in this document was confirmed against the live
> API**. Schemas below were reconstructed from the official Strava Swagger/OAS2 specification (mirrored on GitHub) plus
> official Strava changelog/community-hub documentation surfaced via search. Items I could not corroborate are tagged
> `[UNVERIFIED — could not reach live API]`. **Before writing client code, re-check the two 2026 platform changes in
> §0** — they are the highest-risk items in this spec.

---

## 0.0 Bottom line up front

| Question | Answer |
|---|---|
| Can a browser do Strava OAuth end-to-end? | **No.** Token exchange and every refresh require `client_secret`, which cannot exist in a static bundle. |
| Does the API allow browser fetches (CORS)? | `[UNVERIFIED]` — must be probed at runtime. Even if data routes allow it, `/oauth/token` almost certainly does not. |
| Is there a paid prerequisite? | **Yes.** Standard-tier API access requires a Strava subscription (~$11.99/mo) as of June 2026. |
| **Recommended path** | **Ingest Strava data via Apple Health.** Strava writes workouts into HealthKit, so our Shortcuts pipeline carries them with zero credentials, zero cost, and zero CORS risk. |
| Fallback | A manual paste of a short-lived access token, for the user who wants richer detail and accepts re-pasting every 6 hours. |

**Recommendation: do not build the direct Strava integration for v1.** The combination of a mandatory paid
subscription, an impossible-in-browser OAuth flow, a 6-hour token life, and unverified CORS makes it a poor
cost/benefit trade against the Apple Health route, which is free and automatic. Ship §0.6 (Apple Health) and revisit
the direct path only if the losses in §0.7 prove unacceptable.

---

## 0.5 Can the browser talk to Strava directly?

### 0.5.1 The `client_secret` wall

Strava's token exchange **and every refresh** require `client_secret` in the request body (§2.4, §2.5). In a static PWA
there is nowhere to put it — anything in the bundle is readable by anyone. Shipping it would publish our Strava
application credentials to the world, and any third party could then impersonate our app.

`[UNVERIFIED]` I found no evidence that Strava supports **PKCE** (`code_challenge`/`code_verifier`), which is the
standard way a public client avoids needing a secret. The published OAS2 spec models only the confidential-client flow.
**If Strava has since added PKCE support, that would materially change this recommendation** — re-check first when live
docs are reachable.

Compounding it: Strava access tokens expire after **6 hours**. Even a successful manual token paste buys the user only
one afternoon before the connection goes stale. This is far worse than Oura's ~30-day token.

### 0.5.2 CORS

`[UNVERIFIED — could not reach live API]` I could not test whether `www.strava.com/api/v3` returns
`Access-Control-Allow-Origin` headers usable from a browser, and the session's search budget was exhausted before I
could find community reports.

The common pattern for APIs of this type — and what should be assumed until proven otherwise — is:

| Route | Likely CORS | Consequence |
|---|---|---|
| `/api/v3/*` data routes | Possibly permitted | Reads might work with a pasted token |
| `/oauth/token` | **Very likely blocked** | No browser-side token exchange or refresh, even if we had the secret |

Apply the same runtime probe pattern as `integration-oura.md` §2.3 and hide the direct-connect UI when it fails, rather
than letting the user hit an opaque error.

### 0.5.3 Options evaluated

| Option | Verdict |
|---|---|
| **(a) User pastes a short-lived access token** | Works, but expires in **6 hours**. Unusable as a routine sync mechanism — it is a "pull my data once right now" button at best. |
| **(b) User runs the token exchange themselves and pastes a refresh token** | The refresh *token* is long-lived, but **refreshing it still needs `client_secret`**, which we do not have. So we could not use it. **Dead end** unless the user also pastes their own app's client secret into the vault — which is possible (they registered the app; it is their secret) but is a genuinely poor UX and a meaningful thing to hold. |
| **(c) Route via Apple Health** | **RECOMMENDED.** No credentials, no cost, no CORS risk, automatic. |

**Chosen: (c), with (a) offered as an optional "import now" power-user button** clearly labelled as expiring within
hours. Option (b) is documented only so the decision is traceable: if a user *does* paste their own client ID + secret,
the vault can hold them and full refresh becomes possible — but that is a v2 power-user feature, gated behind an
explicit warning, and it still depends on unverified CORS for `/oauth/token`.

---

## 0.6 What Strava writes into HealthKit — and what is lost

Strava's iOS app can write workouts to Apple Health, which our Shortcuts pipeline then picks up for free.

`[UNVERIFIED — could not reach live docs]` This table is from general knowledge of Strava's Apple Health integration,
not a fetched Strava support page. **Verify on-device** via Health → Sources → Strava, which lists exactly what it
writes. Note also that the integration is **opt-in and directional** — the user must enable Health write permission in
the Strava app, and Strava can also *read* from Health, so take care not to create an import loop where Strava-authored
workouts re-import as duplicates.

| Strava data | Reaches HealthKit? | Notes |
|---|---|---|
| Workout (type, start, end, duration) | **Yes** | `HKWorkout` |
| Distance | **Yes** | `HKQuantityTypeIdentifierDistanceWalkingRunning` / `DistanceCycling` |
| Active energy / calories | **Yes** | `ActiveEnergyBurned` |
| Heart rate samples during workout | **Usually** | Only when Strava recorded HR; often the watch already wrote these independently |
| **Per-second streams** (power, cadence, altitude, grade, velocity) | **NO** | The `StreamSet` in §4 is API-only |
| **Segment efforts, laps, splits** | **NO** | |
| **GPS route / polyline** | **NO** (as a usable artifact) | HealthKit stores workout routes, but Strava writing them is `[UNVERIFIED]` |
| **Weighted average power / normalized power** | **NO** | |
| **Kudos, description, gear, device name** | **NO** | Social/metadata, irrelevant to coaching |
| **Athlete HR/power zones** (`/athlete/zones`) | **NO** | We must let the user enter zones manually, or derive them |
| **Suffer score / relative effort** | **NO** | |

### 0.6.1 What this means

Via Apple Health we get **workout envelopes** — what, when, how long, how far, roughly how hard — but **not the
within-workout time series**. For a coaching app that is a real but survivable loss:

- **Training load** can be computed from duration + average HR (a TRIMP-style model) without streams.
- **Zone distribution** needs either HR samples from HealthKit (often present, since the Apple Watch writes them
  independently of Strava) or manual zone entry.
- **Power-based analysis** (NP, IF, TSS) is **not possible** without the API. If the user is a cyclist who cares about
  power, that is the one case where the direct path earns its cost — flag it in the UI rather than silently degrading.

**Duplicate risk is the real engineering problem.** An Apple Watch run may be written to HealthKit by *both* the Watch
and Strava, producing two overlapping workouts. Deduplicate on `(sport, start_time ± 90s, duration ± 60s)` and prefer
the source with more complete data. See the channel note for how this affects the canonical model.

---

## 0. Read this first — 2026/2027 platform changes

Strava materially changed its developer program in 2026. These affect feasibility and cost, not just code.

| Change | Effective | Impact on us |
|---|---|---|
| **Paid developer access.** Standard-tier API access now requires an active Strava subscription (~**$11.99/month**). | June 1 2026; enforcement from ~June 30 2026 | **The user must hold a paid Strava subscription to use this integration at all.** This is a hard prerequisite — surface it in onboarding. Existing active developers were offered a 3-month free transition. |
| **Tiers.** *Standard* = self-serve, up to **10 connected athletes**, default rate limits. *Extended Access* = approval-gated, higher limits, no subscription required, aimed at apps with >10k users. | June 1 2026 | We are a single-user app → **Standard tier is correct and sufficient** (10-athlete cap is a non-issue). |
| **`/oauth/deauthorize` → `/oauth/revoke`.** New revoke endpoint is the recommended path. | Available June 1 2026; `deauthorize` retired **June 1 2027** | Implement `/oauth/revoke` now; keep `deauthorize` only as a legacy fallback. |
| **New API base URL** `https://www.api-v3.strava.com` replacing `https://www.strava.com/api/v3`. | New URL available ~Jan 4 2027; migration required by **June 1 2027** | **Put the base URL in a single exported constant** (`STRAVA_API_BASE`) so the cutover is a one-line change. |
| **Tokens must be sent in request headers, not form params.** | Required by June 1 2027 | We already do this (`Authorization: Bearer`). Never put `access_token` in a query string. |
| **Endpoint removals:** Club Activities, Club Members, Club Admins removed; Explore Segments restricted to Extended tier. | Sept 1 2026 | We don't use any of these. No impact. |

`[UNVERIFIED — could not reach live API]` for all exact dates/pricing above; they come from Strava's community-hub
announcement and press coverage, not from a live docs fetch. **Confirm on the developer dashboard before building.**

---

## 1. Registering the application

Click-by-click (see also `integration-env.md`):

1. Log in at `https://www.strava.com` with the athlete account that owns the data.
2. Go to **Settings → My API Application** (`https://www.strava.com/settings/api`).
3. Fill in: **Application Name**, **Category**, **Club** (leave blank), **Website**,
   **Authorization Callback Domain**, **Application Icon**.
4. **Authorization Callback Domain is the #1 source of OAuth failures.** It is a *bare domain*, no scheme, no path,
   no port — e.g. `localhost` for local dev, or the production ChatGPT Sites host. Strava only validates the domain of
   `redirect_uri` against this value. You cannot list two domains on one app → **create two Strava applications, one
   for dev and one for prod**, with separate client IDs/secrets.
5. On save you receive **Client ID**, **Client Secret**, and a bootstrap access/refresh token pair for your own account.
6. Standard tier allows self-upgrading to up to 10 athletes and higher rate limits from the API settings dashboard
   without review.

---

## 2. OAuth 2.0 flow

### 2.1 Authorize (browser redirect)

```
GET https://www.strava.com/oauth/authorize
  ?client_id={STRAVA_CLIENT_ID}
  &redirect_uri={https://app.example.com/api/integrations/strava/callback}
  &response_type=code
  &approval_prompt=auto          # 'auto' | 'force' — 'force' always re-shows the consent screen
  &scope=read,activity:read_all,profile:read_all
  &state={csrf_nonce}
```

- `scope` is a **comma-separated** list (not space-separated — differs from most OAuth providers).
- `state` is not optional in practice: generate a random nonce, store it in a short-lived signed httpOnly cookie, and
  compare on callback. Strava echoes it back verbatim.
- `approval_prompt=force` is useful when you need to *widen* scope later — with `auto`, an already-authorized athlete
  is bounced straight back without a chance to grant the new scope.

### 2.2 Scopes

| Scope | Grants | Do we need it? |
|---|---|---|
| `read` | Public segments, routes, profile data, posts, events, club feeds, leaderboards | Yes (baseline) |
| `read_all` | Private routes, segments, events | No |
| `profile:read_all` | All profile info regardless of visibility | **Yes** — needed for `/athlete/zones` (HR/power zones) |
| `profile:write` | Update weight/FTP, star segments | No |
| `activity:read` | Activities visible to Everyone/Followers; **excludes** privacy-zone data and "Only Me" activities | Superseded by below |
| `activity:read_all` | Everything `activity:read` gives **plus** privacy zones and "Only You" activities | **Yes** — a personal coach must see private activities |
| `activity:write` | Create manual activities, uploads, edit activities | No (read-only integration) |

**Recommended scope string:** `read,activity:read_all,profile:read_all`

> Streams are gated by the same scope as the parent activity. Requesting only `activity:read` will silently 404 on
> streams for any activity the athlete marked "Only You" — a very common and confusing failure. Use `activity:read_all`.

### 2.3 Callback

Strava redirects to:

```
{redirect_uri}?state={nonce}&code={authorization_code}&scope=read,activity:read_all,profile:read_all
```

**Always parse and persist the returned `scope`.** The athlete can uncheck boxes on the consent screen, so the granted
scope may be narrower than requested. Store it and degrade features rather than throwing 401s later.

On denial: `{redirect_uri}?state={nonce}&error=access_denied`.

### 2.4 Token exchange

```
POST https://www.strava.com/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id={id}&client_secret={secret}&code={code}&grant_type=authorization_code
```

### 2.5 Refresh (with rotation)

```
POST https://www.strava.com/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id={id}&client_secret={secret}&grant_type=refresh_token&refresh_token={stored_refresh_token}
```

**Critical semantics:**

- Access tokens live **6 hours** (`expires_in: 21600`).
- **Refresh tokens rotate.** Every refresh response *may* contain a **new `refresh_token`**. You must persist it,
  overwriting the old one, in the same transaction as the access token. Dropping it eventually bricks the connection.
- If the current access token still has **more than 1 hour** of life, Strava returns the *existing* access token and the
  *same* refresh token rather than minting new ones. So a refresh call is idempotent-ish and safe to call eagerly.
- Refresh tokens do not have a published expiry, but are invalidated by revocation or by the athlete removing the app.
- Guard against concurrent refreshes. In our architecture the risk is two browser tabs of the PWA refreshing at once and
  racing to persist a rotated token. Serialize with a **Web Lock** (`navigator.locks.request('strava-refresh', …)`)
  around the read-refresh-write sequence, and do the vault write in a single Dexie transaction.
- **All of this is moot without `client_secret` (§0.5.1).** Refresh is only reachable if the user has pasted their own
  client credentials into the vault.

### 2.6 Token response shape

```ts
export interface StravaTokenResponse {
  token_type: 'Bearer';
  /** Unix epoch seconds at which access_token expires. */
  expires_at: number;
  /** Seconds until expiry; 21600 (6h) for a freshly minted token. */
  expires_in: number;
  /** ROTATING — always persist this value, overwriting the previous one. */
  refresh_token: string;
  access_token: string;
  /** Present only on the initial authorization_code exchange, not on refresh. */
  athlete?: StravaSummaryAthlete;
}
```

### 2.7 Revocation / deauthorization

```
POST https://www.strava.com/oauth/revoke        # preferred, available from 2026-06-01
Authorization: Bearer {access_token}
```

```
POST https://www.strava.com/oauth/deauthorize   # legacy, retired 2027-06-01
Authorization: Bearer {access_token}
```

Revoking invalidates **all** access and refresh tokens the app holds for that athlete and removes the app from the
athlete's settings page. All subsequent calls return `401`.

**The athlete can also revoke from Strava's UI without telling us.** Handle this defensively:

- A `401` on refresh (not just on a data call) means the grant is gone → mark the connection `revoked`, stop all sync
  jobs, and prompt for re-connection in the UI. Do not retry-loop.
- Strava also fires a webhook `object_type: "athlete"`, `aspect_type: "update"` with
  `updates: { authorized: "false" }` on deauthorization — see §6.

---

## 3. Endpoints we consume

Base: `https://www.strava.com/api/v3` (migrating to `https://www.api-v3.strava.com` — keep in `STRAVA_API_BASE`).
All calls: `Authorization: Bearer {access_token}`.

| Purpose | Method & path | Key params |
|---|---|---|
| Logged-in athlete | `GET /athlete` | — |
| **List activities** | `GET /athlete/activities` | `before`, `after` (epoch **seconds**), `page`, `per_page` (default 30, **max 200**) |
| **Activity detail** | `GET /activities/{id}` | `include_all_efforts` (bool) |
| **Activity streams** | `GET /activities/{id}/streams` | `keys` (comma-separated, required), `key_by_type=true` (required) |
| Activity HR/power zone buckets | `GET /activities/{id}/zones` | — |
| Activity laps | `GET /activities/{id}/laps` | — |
| **Athlete zones** | `GET /athlete/zones` | — (requires `profile:read_all`) |
| Athlete totals/stats | `GET /athletes/{id}/stats` | — |

### 3.1 Listing activities

```
GET /athlete/activities?after=1735689600&per_page=200&page=1
```

- `before` / `after` are **Unix epoch seconds**, and they filter on `start_date` (UTC), not `start_date_local`.
- **Prefer `after` (+ `before`) over deep `page` paging.** The `page` parameter is documented as unreliable: pages can
  return fewer items than `per_page` even when they are not the last page. Community guidance is to iterate on time
  windows and to keep paging until an **empty array** is returned rather than trusting a short page as terminal.
- Returns `SummaryActivity[]`. **`calories`, `description`, `laps`, `splits_*`, `gear`, and `device_name` are NOT in
  the summary** — they only appear in `GET /activities/{id}`. Plan a two-phase sync (§7).

### 3.2 Streams

```
GET /activities/{id}/streams?keys=time,distance,heartrate,watts,cadence,altitude,velocity_smooth,grade_smooth,moving,latlng&key_by_type=true
```

- **Always pass `key_by_type=true`.** With it, the response is an object keyed by stream type (much easier to consume).
  Without it you get a bare array and must match on `type`.
- Streams are **omitted entirely** if the activity has no such sensor data — always null-check each key. A run from a
  phone will have `time`, `distance`, `latlng`, `altitude` but no `watts` or `heartrate`.
- All streams for one activity share the same length and index alignment (index *i* in `heartrate` corresponds to
  index *i* in `time`).
- `resolution` (`low`|`medium`|`high`) and `series_type` (`time`|`distance`) let Strava downsample.
  `[UNVERIFIED — could not reach live API]` The mirrored OAS2 spec enumerates `resolution` as `low|high`; Strava's
  live docs also document `medium`. Treat the field as an open string union.
- Streams are the single biggest source of rate-limit burn (1 request per activity). See §5.

### 3.3 Athlete zones

`GET /athlete/zones` returns the athlete's configured HR and power zones. Requires `profile:read_all`. Power zones are
only present if the athlete has an FTP set. Use these to bucket stream samples into training zones for coaching logic
rather than hard-coding %HRmax.

---

## 4. TypeScript interfaces

```ts
// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601. See §8 for the start_date vs start_date_local trap. */
export type StravaDateTime = string;

/** Strava's legacy coarse activity type. Prefer sport_type. */
export type StravaActivityType =
  | 'AlpineSki' | 'BackcountrySki' | 'Canoeing' | 'Crossfit' | 'EBikeRide' | 'Elliptical'
  | 'Golf' | 'Handcycle' | 'Hike' | 'IceSkate' | 'InlineSkate' | 'Kayaking' | 'Kitesurf'
  | 'NordicSki' | 'Ride' | 'RockClimbing' | 'RollerSki' | 'Rowing' | 'Run' | 'Sail'
  | 'Skateboard' | 'Snowboard' | 'Snowshoe' | 'Soccer' | 'StairStepper' | 'StandUpPaddling'
  | 'Surfing' | 'Swim' | 'Velomobile' | 'VirtualRide' | 'VirtualRun' | 'Walk'
  | 'WeightTraining' | 'Wheelchair' | 'Windsurf' | 'Workout' | 'Yoga';

/**
 * Finer-grained modern enum. Superset of StravaActivityType.
 * Strava adds values over time, so keep the `(string & {})` escape hatch —
 * do NOT use a closed union for runtime validation.
 */
export type StravaSportType =
  | StravaActivityType
  | 'GravelRide' | 'MountainBikeRide' | 'TrailRun' | 'Pickleball' | 'Padel'
  | 'Racquetball' | 'Squash' | 'Tennis' | 'TableTennis' | 'Badminton'
  | 'VirtualRow' | 'HighIntensityIntervalTraining' | 'Pilates'
  | (string & {});

export interface StravaPolylineMap {
  id: string;
  /** Encoded polyline; only on detailed representations. */
  polyline?: string | null;
  summary_polyline: string | null;
  resource_state?: number;
}

export interface StravaSummaryAthlete {
  id: number;
  resource_state: number;
  firstname?: string;
  lastname?: string;
  profile_medium?: string;
  profile?: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  sex?: 'M' | 'F' | null;
  premium?: boolean;
  summit?: boolean;
  created_at?: StravaDateTime;
  updated_at?: StravaDateTime;
  weight?: number | null; // kilograms
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

/** Returned by GET /athlete/activities */
export interface StravaSummaryActivity {
  id: number;
  resource_state: number; // 1=meta, 2=summary, 3=detail
  external_id: string | null;
  upload_id: number | null;
  athlete: { id: number; resource_state: number };
  name: string;

  /** METERS. */
  distance: number;
  /** SECONDS. */
  moving_time: number;
  /** SECONDS. */
  elapsed_time: number;
  /** METERS. */
  total_elevation_gain: number;

  type: StravaActivityType;
  sport_type: StravaSportType;
  workout_type: number | null;

  /** UTC instant, e.g. "2026-03-01T15:14:22Z". */
  start_date: StravaDateTime;
  /** Local WALL-CLOCK time, but serialised with a misleading "Z". See §8. */
  start_date_local: StravaDateTime;
  /** e.g. "(GMT-08:00) America/Los_Angeles" */
  timezone: string;
  /** Offset from UTC in SECONDS, e.g. -28800. */
  utc_offset: number;

  location_city?: string | null;
  location_state?: string | null;
  location_country?: string | null;

  achievement_count: number;
  kudos_count: number;
  comment_count: number;
  athlete_count: number;
  photo_count: number;
  total_photo_count: number;
  pr_count: number;

  map: StravaPolylineMap;

  trainer: boolean;
  commute: boolean;
  manual: boolean;
  private: boolean;
  flagged: boolean;
  from_accepted_tag?: boolean;
  has_kudoed: boolean;
  visibility?: string; // "everyone" | "followers_only" | "only_me"

  gear_id: string | null;

  /** METERS PER SECOND. */
  average_speed: number;
  /** METERS PER SECOND. */
  max_speed: number;

  average_cadence?: number;        // RPM (or SPM/2 for runs)
  average_temp?: number;           // Celsius
  average_watts?: number;
  weighted_average_watts?: number; // "normalised power"
  kilojoules?: number;
  device_watts?: boolean;          // false => estimated, not from a power meter

  has_heartrate: boolean;
  average_heartrate?: number;
  max_heartrate?: number;

  elev_high?: number;              // METERS
  elev_low?: number;               // METERS

  start_latlng: [number, number] | null;  // [] when privacy-zoned
  end_latlng: [number, number] | null;
}

/** Returned by GET /activities/{id}. Superset of the summary. */
export interface StravaDetailedActivity extends StravaSummaryActivity {
  description: string | null;
  /** KILOcalories despite the name. */
  calories: number;
  device_name?: string | null;
  embed_token?: string;
  segment_efforts?: unknown[];
  splits_metric?: StravaSplit[];
  splits_standard?: StravaSplit[];
  laps?: StravaLap[];
  gear?: StravaSummaryGear | null;
  photos?: unknown;
  best_efforts?: unknown[];
  segment_leaderboard_opt_out?: boolean;
  leaderboard_opt_out?: boolean;
}

export interface StravaSplit {
  distance: number;              // meters
  elapsed_time: number;          // seconds
  moving_time: number;           // seconds
  elevation_difference: number;  // meters
  split: number;
  average_speed: number;         // m/s
  average_heartrate?: number;
  pace_zone?: number;
}

export interface StravaLap {
  id: number;
  activity: { id: number };
  athlete: { id: number };
  name: string;
  lap_index: number;
  split: number;
  start_index: number;
  end_index: number;
  distance: number;         // meters
  elapsed_time: number;     // seconds
  moving_time: number;      // seconds
  start_date: StravaDateTime;
  start_date_local: StravaDateTime;
  average_speed: number;    // m/s
  max_speed: number;        // m/s
  average_cadence?: number;
  average_watts?: number;
  device_watts?: boolean;
  average_heartrate?: number;
  max_heartrate?: number;
  total_elevation_gain: number;
  pace_zone?: number;
}

export interface StravaSummaryGear {
  id: string;
  resource_state: number;
  primary: boolean;
  name: string;
  distance: number; // meters
}

// ---------------------------------------------------------------------------
// Streams  (GET /activities/{id}/streams?key_by_type=true)
// ---------------------------------------------------------------------------

export type StravaStreamType =
  | 'time' | 'distance' | 'latlng' | 'altitude' | 'velocity_smooth'
  | 'heartrate' | 'cadence' | 'watts' | 'temp' | 'moving' | 'grade_smooth';

export interface StravaStreamBase<TType extends StravaStreamType, TData> {
  type: TType;
  data: TData[];
  series_type: 'time' | 'distance';
  original_size: number;
  resolution: 'low' | 'medium' | 'high' | (string & {});
}

export type StravaTimeStream      = StravaStreamBase<'time', number>;            // seconds from start
export type StravaDistanceStream  = StravaStreamBase<'distance', number>;        // meters, cumulative
export type StravaLatLngStream    = StravaStreamBase<'latlng', [number, number]>;
export type StravaAltitudeStream  = StravaStreamBase<'altitude', number>;        // meters
export type StravaVelocityStream  = StravaStreamBase<'velocity_smooth', number>; // m/s
export type StravaHeartrateStream = StravaStreamBase<'heartrate', number>;       // bpm
export type StravaCadenceStream   = StravaStreamBase<'cadence', number>;         // rpm
export type StravaPowerStream     = StravaStreamBase<'watts', number>;           // watts
export type StravaTempStream      = StravaStreamBase<'temp', number>;            // celsius
export type StravaMovingStream    = StravaStreamBase<'moving', boolean>;
export type StravaGradeStream     = StravaStreamBase<'grade_smooth', number>;    // percent

/**
 * With key_by_type=true. EVERY key is optional — a stream is absent whenever
 * the recording device did not produce it.
 */
export interface StravaStreamSet {
  time?: StravaTimeStream;
  distance?: StravaDistanceStream;
  latlng?: StravaLatLngStream;
  altitude?: StravaAltitudeStream;
  velocity_smooth?: StravaVelocityStream;
  heartrate?: StravaHeartrateStream;
  cadence?: StravaCadenceStream;
  watts?: StravaPowerStream;
  temp?: StravaTempStream;
  moving?: StravaMovingStream;
  grade_smooth?: StravaGradeStream;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface StravaZoneRange {
  /** Lower bound (inclusive). */
  min: number;
  /** Upper bound; -1 means "no upper bound" for the top zone. */
  max: number;
}

export interface StravaHeartRateZoneRanges {
  custom_zones: boolean;
  zones: StravaZoneRange[];
}

export interface StravaPowerZoneRanges {
  zones: StravaZoneRange[];
}

/** GET /athlete/zones */
export interface StravaAthleteZones {
  heart_rate?: StravaHeartRateZoneRanges;
  /** Absent unless the athlete has set an FTP. */
  power?: StravaPowerZoneRanges;
}

/** GET /activities/{id}/zones — time-in-zone buckets for one activity. */
export interface StravaActivityZone {
  score?: number;
  type: 'heartrate' | 'power';
  sensor_based?: boolean;
  points?: number;
  custom_zones?: boolean;
  max?: number;
  distribution_buckets: Array<{
    min: number;
    max: number;
    /** SECONDS spent in this bucket. */
    time: number;
  }>;
}
```

---

## 5. Rate limits and how to stay under them

### 5.1 The numbers

| Bucket | 15-minute | Daily |
|---|---|---|
| **Overall** (default) | 200 | 2,000 |
| **Read** (non-upload, default) | 100 | 1,000 |

The daily window resets at **UTC midnight**; the 15-minute window resets at `:00`, `:15`, `:30`, `:45`.
Requests that violate the short-term limit **still count** toward the long-term limit.

`[UNVERIFIED — could not reach live API]` Standard-tier developers can self-upgrade to higher limits from the API
settings dashboard without review; the upgraded numbers were not confirmable.

### 5.2 Headers

Every response carries usage headers. **Header casing changed — Strava now emits lowercase.** Node/`fetch` normalises
header names to lowercase anyway, so always read them lowercased:

```
x-ratelimit-limit:       200,2000        # 15-min, daily  (overall)
x-ratelimit-usage:       23,412          # 15-min, daily  (overall)
x-readratelimit-limit:   100,1000        # 15-min, daily  (read)
x-readratelimit-usage:   11,205          # 15-min, daily  (read)
```

Parse as `const [short, long] = header.split(',').map(Number)`.

Over the limit → **`429 Too Many Requests`** with a JSON error body:
```json
{ "message": "Rate Limit Exceeded", "errors": [{ "resource": "Application", "field": "rate limit", "code": "exceeded" }] }
```
Strava does **not** send `Retry-After`. Compute the wait yourself to the next quarter-hour boundary (short-limit hit) or
to the next UTC midnight (daily limit hit).

### 5.3 Staying under

1. **Persist headers after every call.** Store the parsed limits/usage in the vault alongside the connection record.
   Read them before dispatching a batch and refuse to start if headroom is insufficient.
2. **Budget the read bucket, not the overall bucket** — 100/15min is the binding constraint for a read-only app.
3. **Pull on app open only.** No polling loop — there is no background process to run one, and the app is only ever
   open when the user is looking at it.
4. **Serialize, don't parallelize.** A concurrency of 1–2 with a simple in-memory queue is plenty. Bursty parallel
   fan-out is what trips the 15-minute limit.
5. **Backfill in throttled chunks.** An athlete with 5 years of history has ~1,500 activities → ~3,000 requests with
   streams → **at least 3 days** under the read limit. Model backfill as a resumable job with a cursor
   (`backfill_before_epoch`), run it as a cron that does ~80 reads per 15-min slot, and show the user a progress bar.
6. **Fetch streams lazily where possible.** Full streams for every historical activity is rarely worth 1 request each up
   front; consider streams-on-demand for activities the coach actually analyses, plus eager streams only for the last
   N days.
7. **Cache aggressively and use `updated_at`-style change detection.** Activity detail rarely changes after the first
   few hours; don't re-fetch unless a webhook `update` event says to.
8. **Exponential backoff with jitter** on `429` and `5xx`; hard-stop (don't retry) on `401` (revoked) and `404`.

---

## 6. Webhook Events API (push updates) — NOT USABLE BY US

> **Architecture note.** Webhooks require a **publicly reachable HTTPS callback URL** that receives POSTs from Strava.
> A local-first app has no server to receive them, and standing one up would mean Strava's event payloads — and then the
> activity data we would fetch in response — passing through infrastructure we operate. That is precisely what
> `ARCHITECTURE.md` forbids.
>
> **We do not use webhooks.** Our model is: pull on app open (§7). This section is retained only so a future reader
> knows the option was considered and consciously rejected, and so the deauthorization signal in §6.5 is documented.

```
POST https://www.strava.com/api/v3/push_subscriptions
Content-Type: application/x-www-form-urlencoded

client_id={id}&client_secret={secret}
&callback_url=https://app.example.com/api/integrations/strava/webhook
&verify_token={STRAVA_WEBHOOK_VERIFY_TOKEN}
```

**Constraints:**
- **One subscription per application.** Creating a second returns an error; delete the first.
- `callback_url` must be publicly reachable over HTTPS (port 443) — no localhost. For local dev use a tunnel
  (ngrok/cloudflared) and a *separate* dev Strava app.
- The callback must answer the validation GET **within 2 seconds**.

### 6.2 Validation handshake

Immediately after the POST, Strava issues a `GET` to your `callback_url`:

```
GET /api/integrations/strava/webhook
  ?hub.mode=subscribe
  &hub.verify_token={your token}
  &hub.challenge={random string}
```

You must verify `hub.verify_token` matches your secret and reply **HTTP 200** with:

```json
{ "hub.challenge": "{the same random string}" }
```

Content-Type `application/json`. Note the **dots in the key name** — in Next.js read them via
`searchParams.get('hub.challenge')`, and in the JSON body use the quoted literal `"hub.challenge"`.

If validation succeeds, the original POST returns `{ "id": 12345 }` — the subscription id.

### 6.3 View / delete

```
GET    https://www.strava.com/api/v3/push_subscriptions?client_id={id}&client_secret={secret}
DELETE https://www.strava.com/api/v3/push_subscriptions/{subscription_id}?client_id={id}&client_secret={secret}
```
Delete returns `204 No Content`.

### 6.4 Event payload

```ts
export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete';
  aspect_type: 'create' | 'update' | 'delete';
  /** Activity id when object_type='activity'; athlete id when 'athlete'. */
  object_id: number;
  /** Athlete who owns the object. */
  owner_id: number;
  subscription_id: number;
  /** Unix epoch SECONDS. */
  event_time: number;
  /**
   * Only populated for aspect_type='update'.
   * Activities: may contain "title", "type", "private", "visibility".
   * Athletes:   contains { authorized: "false" } on deauthorization.
   * NOTE: values are STRINGS, including the boolean-looking ones.
   */
  updates?: Record<string, string>;
}
```

### 6.5 Handler rules

- **Respond `200` within 2 seconds.** Strava retries 3 more times then gives up.
- Therefore: **acknowledge first, process later.** The route handler should validate, enqueue (a `strava_webhook_events`
  table row or a background job), and return `200` immediately. Never call the Strava API inside the handler.
- **Events are not authenticated.** There is no signature header. Mitigate by (a) using a long random, unguessable path
  segment in `callback_url`, (b) checking `subscription_id` and `owner_id` match a known connection, and (c) treating
  the event purely as a *hint* — always re-fetch the object from the API rather than trusting payload contents.
- **Deduplicate.** Retries and rapid edits produce repeat events. Key on
  `(object_type, object_id, aspect_type, event_time)`.
- **Expect delay and out-of-order delivery.** An activity may not be fully processed when `create` fires; if
  `GET /activities/{id}` 404s, retry with backoff rather than discarding.
- Handle `object_type: 'athlete'` + `updates.authorized === 'false'` → mark connection revoked, cancel jobs, clear
  tokens (see §2.7).

---

## 7. Sync design (direct path only, if ever built)

There is no server, no background job, and no webhook. Everything below runs **in the browser, on app open**, and only
if the user has explicitly pasted a token and the CORS probe (§0.5.2) succeeded.

1. **Unlock vault** → decrypt the stored Strava access token → check `expires_at`. If expired (6 h), the direct path is
   unavailable until the user pastes a fresh token. Say so plainly; do not fail silently.
2. **Pull recent activities.** `GET /athlete/activities?after=<last_synced_epoch - 172800>&per_page=200` — a 48-hour
   overlap catches edits. Page until an empty array.
3. **Enrich on demand, not eagerly.** Fetch `GET /activities/{id}` (for `calories`, `description`, `device_name`) and
   streams **only for activities the user actually opens**. A local-first app has no background worker to warm a cache,
   and streams are the dominant rate-limit cost (§5).
4. **Upsert** into Dexie keyed on `(source='strava', external_id)`. Store the raw JSON alongside normalized fields so a
   schema change never requires re-fetching.
5. **Backfill** is a foreground, user-initiated, resumable action with a visible progress bar — walking backwards with
   `before` as a cursor. It cannot run unattended. Given the read limit of 100/15 min, a multi-year backfill takes days
   of intermittent app usage; **be honest in the UI that this is slow**, and default to importing the last 90 days.
6. **Deduplicate against Apple Health.** If the same workout arrived via both routes, keep one — see §0.6.1.

Because streams are effectively unavailable via Apple Health (§0.6), the honest framing for the direct path is
"optionally enrich a workout you're looking at right now", not "sync everything".

---

## 8. Gotchas

### 8.1 Units — everything is metric SI, always

Strava's API is **always metric regardless of the athlete's display preference.** The athlete's `measurement_preference`
(`feet`/`meters`) affects only the Strava UI. Never apply it to API values.

| Field | Unit |
|---|---|
| `distance`, `total_elevation_gain`, `elev_high`, `elev_low`, altitude stream | **meters** |
| `moving_time`, `elapsed_time`, time stream, zone bucket `time` | **seconds** |
| `average_speed`, `max_speed`, `velocity_smooth` | **meters/second** |
| `average_watts`, `weighted_average_watts`, watts stream | watts |
| `kilojoules` | kJ (work) |
| `calories` (detail only) | **kcal** (misleading name) |
| `average_heartrate`, `max_heartrate` | bpm |
| `average_cadence` | rpm — **for runs this is one leg, so stride rate = cadence × 2** |
| `temp` | °C |
| `grade_smooth` | percent |
| `utc_offset` | seconds |
| athlete `weight` | kilograms |

**Store metric.** Convert only at the render layer. Pace = `1000 / average_speed` seconds per km.

### 8.2 `start_date` vs `start_date_local` — the classic trap

- `start_date` = the true UTC instant. Correct for ordering, deduping, and `before`/`after` filtering.
- `start_date_local` = the athlete's **wall-clock time**, but Strava serialises it with a trailing **`Z`** anyway.
  So `2026-03-01T07:14:22Z` in `start_date_local` means *7:14 am local*, **not** 7:14 UTC.
  `new Date(start_date_local)` in JS will therefore produce a wrong instant.

**Rules:**
- For "which day did this happen on" (the coaching-relevant question — a 6 am workout belongs to that local day), derive
  the local calendar date by **string-slicing** `start_date_local.slice(0, 10)`. Do not parse-and-format.
- For instants, timelines and sorting, use `start_date`.
- Persist both, plus `timezone` and `utc_offset`, so you can always reconstruct.
- `timezone` is a *decorated* string (`"(GMT-08:00) America/Los_Angeles"`), not a bare IANA id. Strip the parenthetical
  prefix before feeding it to `Intl`/`date-fns-tz`.

### 8.3 Pagination

- `per_page` max **200**, default 30.
- `page` is 1-indexed and **unreliable at depth** — short non-final pages occur. Terminate on an **empty array**, never
  on `length < per_page`.
- Prefer time-window cursors (`before`/`after`, epoch seconds) over `page` for backfill; they're stable against new
  activities being inserted mid-crawl.
- New activities appear at page 1 and shift everything, so a naive page-crawl can miss or duplicate items. Backfill
  *backwards* with `before` = oldest-seen `start_date` epoch.

### 8.4 Other

- **`type` is deprecated in favour of `sport_type`.** Both are returned; `sport_type` is a superset
  (`MountainBikeRide`, `GravelRide`, `TrailRun`, …). Strava adds values over time → never `switch` exhaustively without
  a default branch, and never persist as a closed enum; store the raw string plus a normalized `sport` via a lookup
  table, so an unrecognized value degrades to `'other'` instead of failing ingest.
- **Privacy zones** blank out `start_latlng`/`end_latlng` (empty array, not null in some responses) and truncate
  `latlng` streams. Code defensively for `[]`.
- **Summary vs detail.** `calories`, `description`, `device_name`, `laps`, `splits_*`, `gear` are detail-only. Don't
  build UI that assumes they're on the summary.
- **`device_watts: false`** means power was *estimated* by Strava, not measured. Exclude estimated power from any
  training-load calculation.
- **Manual activities** (`manual: true`) have no streams and often bogus averages — filter from analytics.
- **`kilojoules` vs `calories`.** `kilojoules` is mechanical work (cycling, power meter only); `calories` is metabolic
  estimate. They are not interchangeable (~1 kJ ≈ 1 kcal for cycling only by coincidence of ~24% efficiency).
- **Rate-limit headers are absent on some error responses** — don't assume they're always parseable.
- **Trailing-slash and `redirect_uri` mismatch** cause opaque `bad_request` errors on token exchange; the `redirect_uri`
  in the exchange must match the one used at authorize exactly.

---

## 9. Data we hand to the normalized model

Strava feeds the canonical `workout` / `workout_sample` entities described in `channel/011-integrations-research.md`:

| Canonical field | Strava source |
|---|---|
| `external_id` | `id` |
| `source` | `'strava'` |
| `started_at` | `start_date` |
| `local_date` | `start_date_local.slice(0,10)` |
| `sport` | `sport_type` (normalized via lookup) |
| `duration_s` / `moving_s` | `elapsed_time` / `moving_time` |
| `distance_m` | `distance` |
| `elevation_gain_m` | `total_elevation_gain` |
| `avg_hr` / `max_hr` | `average_heartrate` / `max_heartrate` |
| `avg_power_w` / `np_w` | `average_watts` / `weighted_average_watts` (only when `device_watts === true`) |
| `avg_cadence` | `average_cadence` |
| `energy_kcal` | `calories` (detail fetch) |
| `samples` | `StravaStreamSet` → `(t_offset_s, hr, power_w, speed_mps, cadence, altitude_m, lat, lng)` |

---

## Sources

- [Strava Developers — Authentication](https://developers.strava.com/docs/authentication/)
- [Strava Developers — API Reference](https://developers.strava.com/docs/reference/)
- [Strava Developers — Rate Limits](https://developers.strava.com/docs/rate-limits/)
- [Strava Developers — Webhook Events API](https://developers.strava.com/docs/webhooks/)
- [Strava Developers — Changelog](https://developers.strava.com/docs/changelog/)
- [Strava Community Hub — An Update To Our Developer Program](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428)
- [Strava Community Hub — Rate Limits](https://communityhub.strava.com/developers-knowledge-base-14/rate-limits-3201)
- [Official Strava OAS2 spec (mirror)](https://github.com/yohcop/stravago/blob/master/api/swagger.yaml)
- [Strava API Pricing in 2026 — Apps for Strava](https://appsforstrava.com/blog/strava-developer-program-changes-2026/)
