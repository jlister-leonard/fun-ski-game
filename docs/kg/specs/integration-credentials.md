# Integration Spec: Credentials & Secrets

**Status:** Draft for implementation
**Owner:** Integrations research
**Last updated:** 2026-07-26
**Governing doc:** [`docs/kg/ARCHITECTURE.md`](../ARCHITECTURE.md) — health data never leaves the device.
**Supersedes:** the previously-planned `integration-env.md` (server environment variables), which no longer applies.

---

## 0. Why this document is short

There is **no application backend** and therefore no server-side credential store, `.env`, or secret manager carrying
anything sensitive. ChatGPT Sites' Vinext worker serves only the public app shell and rejects writes; it has no D1 or R2
binding. The client bundle is public by definition: anything compiled into it is readable by anyone who opens DevTools
or fetches the JavaScript.

Therefore the only meaningful credential story is: **which user-supplied secrets live in the encrypted vault on the
user's device, how the user obtains them, and what an attacker gains if the vault is compromised.**

### 0.1 The one rule for build-time configuration

> **Nothing secret may be compiled into the bundle.** If a value must be kept secret, it cannot be a build-time
> constant — it must be supplied by the user at runtime and stored in the vault.

The only build-time values we have are non-secret and safe to publish:

| Value | Example | Why it's safe |
|---|---|---|
| `NEXT_PUBLIC_APP_VERSION` | `1.4.2` | Cosmetic; shown in settings and sent to OFF as `app_version`. |
| `NEXT_PUBLIC_OFF_APP_NAME` | `HealthCoach` | Public identifier sent to Open Food Facts. Not a credential. |
| `NEXT_PUBLIC_SEED_DB_URL` | `/data/seed-foods.v1.json` | A path to a public static asset. |

There is deliberately **no** `NEXT_PUBLIC_STRAVA_CLIENT_ID` or similar. A Strava client ID is not itself secret, but
pairing it with a bundled secret is what breaks — and since we are not doing browser OAuth (see
`integration-strava.md` §0.5), we do not need either.

---

## 1. Credentials the user may supply

All are **optional**. The app is fully functional with none of them, because the primary ingestion path — Apple Health
via Shortcuts — requires **no credentials at all.**

| # | Credential | Integration | Required? | Stored | Lifetime |
|---|---|---|---|---|---|
| 1 | *(none)* | **Apple Health via Shortcuts** | — | — | — |
| 2 | Oura access token | Oura direct API | Optional | Vault, encrypted | ~30 days |
| 3 | Strava access token | Strava direct API | Optional, discouraged | Vault, encrypted | **6 hours** |
| 4 | Strava client ID + client secret | Strava refresh (v2 power-user) | Optional, discouraged | Vault, encrypted | Until revoked |
| 5 | Vault passphrase | The app itself | **Required** | **Never stored** — derives the KEK | — |
| 6 | Recovery code | Vault escrow | Strongly recommended | Shown once; user stores it | — |

### 1.1 Apple Health — no credential

Worth stating explicitly because it is the headline: the Shortcuts pipeline uses **no token, no API key, no account**.
The Shortcut reads HealthKit locally (with the user's own iOS permission grant) and copies JSON to the clipboard. Keel
reads it only after the user taps Import. There is nothing to steal, nothing to expire, and nothing to revoke.

This is the strongest argument for making it the primary path.

### 1.2 Oura access token

**What it is.** A bearer token for `api.ouraring.com`, sent as `Authorization: Bearer <token>`.

**How the user obtains it.** This is genuinely awkward, and the UI must not pretend otherwise. Oura **deprecated
Personal Access Tokens** (see `integration-oura.md` §1.1), so:

- **If the user already holds a legacy PAT** (created before deprecation): paste it. Done.
- **Otherwise**, the user must register their own Oura application and run the OAuth exchange themselves, once:
  1. Go to `https://cloud.ouraring.com/oauth/applications` and sign in.
  2. Create a new application. Set the redirect URI to anything they control — `http://localhost/callback` is fine,
     since they will read the `code` out of the address bar by hand.
  3. Note the **Client ID** and **Client Secret**.
  4. Visit the authorize URL in a browser, substituting their values:
     ```
     https://cloud.ouraring.com/oauth/authorize?response_type=code&client_id=<ID>
       &redirect_uri=http://localhost/callback
       &scope=daily%20heartrate%20workout%20personal%20spo2Daily
       &state=xyz
     ```
  5. Approve. The browser lands on a dead `localhost` URL — copy the `code=` value from the address bar.
  6. Exchange it (any machine with `curl`, or an Apple Shortcut we generate):
     ```
     curl -X POST https://api.ouraring.com/oauth/token \
       -d grant_type=authorization_code -d code=<CODE> \
       -d redirect_uri=http://localhost/callback \
       -d client_id=<ID> -d client_secret=<SECRET>
     ```
  7. Paste the returned `access_token` into the app.

**Honesty requirement.** The UI must state that this token expires in roughly 30 days and that **we cannot refresh it**
(refresh needs the client secret, which we deliberately do not ask for by default). The user will repeat this. Do not
label the button "Connect Oura" as though it were a one-time OAuth flow — label it "Paste Oura token" and show the
expiry date prominently.

**Blast radius if the vault is compromised.** Full read access to that user's Oura data — sleep, readiness, heart rate,
workouts, personal info (age/height/weight, and email if the `email` scope was granted) — for the token's remaining
lifetime. **It is read-only**: the Oura API surface we use has no write capability, so an attacker cannot alter or
delete the user's Oura history. Mitigate by requesting the narrowest scope set that supports the features the user
actually enabled.

### 1.3 Strava access token

**How the user obtains it.** Strava's own API settings page issues a bootstrap access/refresh token pair for the
owner's account:

1. Log in at `https://www.strava.com`.
2. **Settings → My API Application** (`https://www.strava.com/settings/api`).
3. Create the application if one does not exist: Application Name, Category, Website, and an **Authorization Callback
   Domain** (a bare domain, no scheme or path — `localhost` is fine).
4. The page shows **Client ID**, **Client Secret**, and an **Access Token**. Copy the access token.
5. Paste it into the app.

**Prerequisite the user must know before starting:** since **June 1 2026** Standard-tier API access requires an active
**Strava subscription (~$11.99/month)**. `[UNVERIFIED — could not reach live API]`. If they are not a subscriber, this
path is closed and Apple Health is the only route. **Check and state this at the top of the setup screen**, before the
user invests effort in the steps above.

**The 6-hour problem.** The token on that page expires in 6 hours. Refreshing requires the client secret. So the
realistic framing is a **"Import from Strava now"** button, not a persistent connection. Label it accordingly.

**Blast radius.** Read access to the athlete's activities for up to 6 hours — including private and privacy-zone data
if `activity:read_all` was granted. Short-lived by construction, which is the one upside. Read-only for our scope set.

### 1.4 Strava client ID + secret (v2, power-user, discouraged)

If the user pastes their **own** client ID and secret, the app can perform token refresh itself and the connection
becomes durable. This is *their* secret for *their* app, so it is not a credential-sharing violation — but it is still
the most dangerous thing the vault would hold.

**Blast radius.** A client secret plus a refresh token is a **durable, self-renewing** grant. Unlike an access token it
does not expire on its own — an attacker retains access until the user notices and revokes the application at
`https://www.strava.com/settings/apps`. This is categorically worse than items 1.2 and 1.3.

**Therefore:** gate behind an explicit warning, do not offer it in the default flow, and surface a one-tap "revoke"
link that opens Strava's app-settings page. Ship it only if there is real demand.

### 1.5 Vault passphrase

**Never stored, anywhere.** It derives the KEK via PBKDF2-SHA-256 at 600,000 iterations over a per-install random salt,
which unwraps the DEK. Held in memory only while unlocked; zeroed on auto-lock.

There is **no recovery** by construction (`ARCHITECTURE.md` §4). The setup flow must say this bluntly and push the user
to record the recovery code (1.6) — a forgotten passphrase means a lost vault, and users do not believe that until it
happens to them.

### 1.6 Recovery code

A high-entropy code, shown **once** at setup, that independently wraps the DEK. Functionally a second passphrase.

**Blast radius: total.** Anyone holding it can decrypt the entire vault. The UI must frame it as "treat this like the
key to your house" — print it, put it in a password manager, do not photograph it into a synced camera roll.

---

## 2. How credentials are stored

Tokens are **encrypted with the same DEK as health data** and live in a dedicated Dexie table. They are not special-cased
into `localStorage`, never held in a cookie, and never placed in a URL.

```ts
/** Row in the `credentials` table. Value is always ciphertext. */
export interface StoredCredential {
  /** e.g. 'oura.access_token', 'strava.access_token', 'strava.client_secret'. */
  id: string;
  provider: 'oura' | 'strava';
  kind: 'access_token' | 'refresh_token' | 'client_id' | 'client_secret';
  /** AES-256-GCM ciphertext of the UTF-8 secret. */
  ct: ArrayBuffer;
  /** 12-byte random IV, unique per write. NEVER reused. */
  iv: Uint8Array;
  /** Plaintext, non-identifying — safe to index and to show in the UI. */
  expires_at?: string | null;
  scope?: string | null;
  created_at: string;
  updated_at: string;
}
```

### 2.1 Rules

1. **Encrypt before write, decrypt on use, never cache the plaintext** beyond the request that needs it.
2. **A fresh 12-byte IV on every write.** IV reuse under GCM with the same key is catastrophic — it leaks plaintext
   relationships and can enable forgery. Generate with `crypto.getRandomValues`, never a counter.
3. **Never log a token.** Add a redaction helper and use it in every error path. Third-party tokens in a console log
   survive in screen recordings and screenshots.
4. **Never put a token in a URL** — not in a query string, not in a fragment. Headers only.
5. **Auto-lock zeroes the DEK**, which transitively makes every credential unreadable until the next unlock.
6. **Deleting a connection deletes the row**, and the UI should link out to the vendor's revocation page — deleting our
   copy does not revoke the grant at the vendor.
7. **Exclude credentials from backup exports by default.** The `.hcvault` backup should contain health data; a checkbox
   can opt them in, with a warning. Tokens are cheap to re-obtain and expensive to leak.

### 2.2 What an attacker with the device but not the passphrase gets

Ciphertext. IndexedDB yields `{id, iv, ct}` rows and a wrapped DEK. Without the passphrase (or recovery code) there is
no oracle and no shortcut — AES-GCM authentication simply fails. This is the property that makes the local-first design
defensible rather than merely convenient.

**The honest caveat:** while the app is *unlocked*, the DEK is in memory and the plaintext is reachable by anything with
code execution in that origin. This is why `ARCHITECTURE.md` §6.2 forbids third-party scripts, analytics, error
reporting, and CDN fetches — **an XSS or a compromised dependency defeats the vault entirely.** A strict CSP and a
zero-third-party-script policy are load-bearing security controls here, not hygiene.

---

## 3. Network egress inventory

Every outbound request the app can make. Anything not on this list is a bug, and a build check should enforce it.

| Destination | When | Carries health data? | Credential |
|---|---|---|---|
| Our own static origin | App load, seed DB fetch, WASM fetch | **No** — static assets only | None |
| `world.openfoodfacts.org` | User scans a barcode | **No** — one barcode, nothing else | None |
| `api.ouraring.com` | Only if user pasted a token | **Yes**, device ↔ Oura directly | Oura token |
| `www.strava.com` | Only if user pasted a token | **Yes**, device ↔ Strava directly | Strava token |

**No same-origin `POST` ever carries health data.** The Shortcuts ingest path reads clipboard text after an explicit
user gesture and writes it directly to encrypted IndexedDB. This is the invariant to assert in a build check and to
state in the privacy screen.

The settings screen should expose an **"offline only"** toggle that disables the Oura, Strava, and Open Food Facts rows
entirely, leaving the app functional on the bundled seed DB and Apple Health alone.

---

## 4. Setup checklist for the user

The minimum viable path — no accounts, no keys, no cost:

1. Open the app in Safari on iPhone → **Add to Home Screen** (required; see `ARCHITECTURE.md` §3, storage eviction).
2. Set a vault passphrase. Save the recovery code somewhere real.
3. Run the **Apple Health setup wizard**, which generates the Shortcut and walks through creating the automation.
4. Done. Food search works offline immediately via the bundled seed DB; barcode scanning works with no key.

Optional, later:

5. Paste an Oura token if you want readiness/sleep scores that Apple Health does not carry.
6. Ignore Strava unless you are a cyclist who needs power data *and* holds a Strava subscription.
