# Architecture — Local-First Health Coach

**Status:** authoritative. Supersedes any earlier assumption of a Supabase/Postgres backend.
**Last updated:** 2026-07-26

---

## 1. The one constraint that shapes everything

> **Health data never leaves the device.**

The user's decision. It is not a nice-to-have; it is the axis the whole design rotates around.
Every subsequent choice below is downstream of it.

Consequences, stated plainly:

| We give up | We get |
|---|---|
| Server-side sync across devices | No breach surface. No vendor. No subpoena target. |
| Server-rendered personalization | Instant UI — every read is a local IndexedDB read, ~0ms |
| "Just works" OAuth with client secrets | Real privacy, and an app that works on a plane |
| Managed backups | User-owned encrypted backup files |

## 2. Shape of the system

```
┌──────────────────────────────────────────────────────────┐
│  iPhone — Safari / Home Screen PWA                       │
│                                                          │
│   UI (Next.js shell via Vinext/Sites worker, React 19)   │
│      │                                                   │
│   Domain / algorithms (pure TS, zero deps)               │
│      │                                                   │
│   Vault  ── AES-GCM ──►  IndexedDB (Dexie)               │
│      ▲                                                   │
│      │ DEK unwrapped at unlock                           │
│   Unlock: passphrase (PBKDF2) │ passkey PRF (Face ID)    │
└───────────▲──────────────────────────────▲───────────────┘
            │                              │
   Shortcuts clipboard             Optional public fetch
   (user-approved local            (OFF barcode / tapped
    import into the PWA)            YouTube demo only)
```

ChatGPT Sites serves **only** the compiled app shell. HTML remains a worker response so its
hash-only CSP and security headers cannot be bypassed by the static asset layer; JavaScript,
CSS, icons, the web manifest, and the service worker remain static public files. D1 and R2 are
disabled, there are no application API routes, the service worker blocks same-origin writes
locally, and the Sites worker refuses every method except `GET` and `HEAD`. It never has a
reason to receive health data. Verifiable: the privacy audit scans both shipped client and
server bundles plus source request surfaces.

## 3. Storage & encryption

- **Engine:** IndexedDB via Dexie. Structured, indexed, transactional, handles 100k+ records.
- **At rest:** every record in a sensitive table is stored as `{ id, iv, ct }` where `ct` is
  AES-256-GCM ciphertext of the JSON body. Indexable non-identifying fields (e.g. `dateKey`)
  stay plaintext so queries stay fast. Documented per-table in `docs/kg/specs/vault-schema.md`.
- **Key hierarchy:**
  - `DEK` — random 256-bit data encryption key, generated once, never leaves memory unwrapped.
  - `KEK` — derived from the passphrase via **PBKDF2-SHA-256, 600,000 iterations** (OWASP 2023
    floor) over a per-install random salt. Wraps the DEK.
  - Optional second wrapping of the DEK by a **passkey PRF** secret → Face ID unlock.
- **Why this matters:** an unlocked phone handed to someone else, or a forensic disk image,
  yields ciphertext. The login screen is not theatre.

### iOS storage eviction — the real risk

Safari evicts IndexedDB for regular sites after ~7 days of inactivity. **Home Screen web apps
are exempt.** Therefore:

1. On iPhone/iPad, the app requires *Add to Home Screen* **before** passphrase or vault
   creation. The browser and Home Screen app have separate storage containers and iOS does
   not copy IndexedDB between them.
2. It calls `navigator.storage.persist()` and surfaces the granted/denied state honestly.
3. It nags for an **encrypted backup export** on a schedule, and shows days-since-last-backup.
   Backups are a single `.hcvault` file the user saves to Files/iCloud Drive. Format v2 remains
   the vault-only JSON compatibility format and uses
   a DEK-derived, purpose-separated HMAC over the complete canonical envelope, so a removed
   table or row and any changed ciphertext or plaintext row header are rejected before an
   import writes. Health bodies remain AES-GCM encrypted, but structural metadata—table names,
   counts, dates, categories, and update times—is readable; the whole file is private.
   Format v3 adds a signed binary manifest followed by raw media ciphertexts. Export verifies and
   writes one clip at a time into Origin Private File System storage, shares the resulting
   disk-backed `File`, then deletes the temporary file; it never base64-expands or accumulates all
   clips in memory. A replace restore commits a durable media-cleanup marker with the new vault,
   making cleanup retry-safe even if iOS terminates the app between storage transactions. Once the
   transaction commits, an origin-scoped `BroadcastChannel` resets in-memory sessions in other
   open Keel windows so none can write with the retired key.
4. The production Sites origin is stable. A different Site or custom domain is a different
   vault namespace; moving origins requires encrypted export/import first.

## 4. Unlock / "login"

There is no account and no server to authenticate against. "Login" = **vault decryption**.

- First run → user sets a passphrase → salt + wrapped DEK persisted.
- Subsequent runs → passphrase derives KEK → unwraps DEK → app usable.
- Wrong passphrase = AES-GCM auth-tag failure. No oracle, no lockout table needed.
- Optional: register a passkey with the **PRF extension** (iOS 18+) → Face ID unlock.
  Graceful degradation to passphrase where unsupported.
- Auto-lock on backgrounding after a configurable interval; DEK zeroed from memory.

**Recovery:** there is none, by construction. Forgotten passphrase = unrecoverable vault.
The app states this bluntly at setup and pushes a recovery-code escrow (a printable code that
independently wraps the DEK) so the user opts into their own safety net.

## 5. Data ingestion — how each source gets in, without a server

### 5.1 Apple Health — primary, free

> **Correction, 2026-07-26.** This section originally specified a URL-fragment transport:
> a Shortcuts automation calling `Open URL` on `https://app/#/ingest?d=…`, on the reasoning
> that fragments are never transmitted. The privacy reasoning was sound but **the mechanism
> was broken**: `Open URLs` opens *Safari*, and an installed Home Screen web app on iOS has a
> **separate storage partition** from Safari. The data would have landed in a different, empty
> vault than the one the user actually opens. This is not speculation — a shipped app using
> the same architecture instructs its PWA users to delete that action. The design below
> replaces it.

Three transports, all with the same privacy property — the data never touches a server we
operate — differing only in ergonomics.

**A. Clipboard (primary, recurring).**

```
Shortcuts personal automation (daily, "Run Immediately")
  → Find Health Samples (steps, active energy, resting HR, HRV, sleep, body mass, workouts…)
  → build JSON  → compress → Copy to Clipboard
  → user opens Keel; it offers "Import today's health data" → one tap
```

No storage partition problem, no URL length ceiling, and the clipboard never leaves the
device. The cost is honest: it is **one tap per day**, not zero. iOS requires a user gesture
before a page may read the clipboard, and that is a restriction worth having.

**B. `export.zip` (primary for history, and the richest source).**
Full Health export → streaming XML parse in a **Web Worker, on device**. This is the only
path that carries sleep stages, workout routes and intra-workout heart-rate series. The
pipeline is benchmarked at **1.37 GB / 3M records in ~21 s at ~110 MB flat memory** using
Web APIs only. Used for initial backfill and periodic deep syncs.

**C. Manual paste (fallback).** Same payload, pasted by hand. Always works.

The app **generates the Shortcut for you** — a setup wizard emits the exact action list, so
the complexity is real but the user experience is one guided screen.

### 5.2 Oura & Strava

**Apple Health is not merely the preferred path — it is very nearly the only one.** Both
vendors write into HealthKit, so the pipeline above already carries their data with no extra
credentials. That turns out to be fortunate, because direct browser access is largely closed:

- Both APIs require a **`client_secret` for token exchange and for every refresh**. A secret
  in a static bundle is not a secret, so the standard OAuth flow is unavailable to us.
- Oura **deprecated Personal Access Tokens** (reported Dec 2025), removing the one mechanism
  that would have made a browser-only client straightforward.
- Strava now gates API access behind a **paid subscription**, and issues **6-hour** tokens.

`[UNVERIFIED]` — these were established from vendor documentation, not live calls; the
environment blocks outbound traffic to both hosts. They should be re-checked against the live
APIs before any work is done on nodes I5/I6.

What is lost by routing through HealthKit rather than the vendor APIs is real and is
documented per-metric in the integration specs — Oura's own readiness and sleep *scores*, in
particular, are computed by Oura and do not reach HealthKit. Where a metric is unavailable,
the UI says so rather than silently omitting it.

We do **not** ship a proxy. A proxy would hold the client secret and see the data, which
defeats the premise. If direct sync proves impossible, the honest answer is to say so in the
UI, not to compromise the architecture to work around it.

### 5.3 Food database

- **Bundled local seed DB** of common foods ships with the app → search works offline, instantly.
- **Open Food Facts** lookup on demand (no key, CORS-friendly) for barcodes and long-tail items.
  A barcode lookup reveals only the barcode, never the user's log.
- Results are cached into the vault so repeat lookups are offline.

## 6. Rules the implementation must not break

1. No same-origin network call ever carries health data. (Enforced by review + a build check.)
2. No third-party analytics, telemetry, error reporting, or font/CDN fetch. Everything is
   self-hosted and inlined. A strict CSP encodes this.
3. All algorithms are pure, dependency-free TypeScript — auditable and testable in isolation.
4. Anything shown as a coaching recommendation passes through `guardrails.ts` first.
5. Not medical advice. Bounded adjustments. Never counsel training through pain, never set
   targets in unsafe territory. See `docs/kg/specs/nutrition-algorithms.md` §Safety.
