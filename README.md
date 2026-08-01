# Keel

An all-in-one health coach for iPhone — adaptive nutrition tracking, training planning and
logging, and recovery data — built so that **your health data never leaves your phone**.

There is no app database server and no account. ChatGPT Sites serves only the compiled app
shell. Everything you log lives in AES-256-GCM encrypted storage on the device; Sites has no
route that accepts health data and its D1/R2 cloud storage bindings are disabled.

---

## The login screen is not theatre

There is nothing to log in *to*. Your passphrase is never sent anywhere and never compared
against anything. It runs through PBKDF2 (600,000 iterations) to derive a key that unwraps the
AES key encrypting the vault. A wrong passphrase doesn't get rejected by a server — the
ciphertext simply fails to decrypt.

The consequence is blunt and worth understanding before you start:

> **A forgotten passphrase means the data is gone.** Nobody can reset it. There is no recovery
> email, because there is no server to send one from.

That is why the vault supports three independent ways in, any one of which works:

| Unlock method | Use |
|---|---|
| **Passphrase** | The primary. Save it in a password manager. |
| **Recovery code** | A printable code generated at setup. Keep it somewhere physical. |
| **Passkey (Face ID)** | Optional, fastest day to day. Not a backup — it lives on this device. |

Revoking any one of these leaves the others working. Removing the last one is refused.

## Install it properly — this is a correctness requirement

**On your iPhone, open the Site in Safari → Share → Add to Home Screen → open Keel from the
new icon before creating your vault.** If the link first opens inside ChatGPT or another
in-app browser and there is no **Add to Home Screen** action, use **Open in Safari** first.

This is not a nice-to-have. Browser tabs and installed Home Screen apps use separate storage
containers on iOS, and IndexedDB is not copied during installation. Keel therefore blocks
vault creation in an iPhone/iPad browser tab and starts setup only from the installed app.
Home Screen web apps are also protected from Safari's ordinary seven-day storage-eviction
rule. The app guides you through this on first run and reports the persistent-storage grant
honestly.

Keep using the same Sites address after setup. Browser vaults are tied to the exact site
origin; moving to a different Site or domain requires an encrypted export from the old
address and a restore on the new one.

Back up regularly. The app exports a self-contained `.hcvault` file you can keep in Files or
iCloud Drive; its health values and notes remain encrypted and it is recoverable with your
passphrase or recovery code alone. A keyed whole-file authenticator also detects a removed
table or row, changed ciphertext, or altered row header before restore writes anything. The
file still exposes structural metadata such as table names, record counts, dates, categories,
and update times, so treat the entire file as private. Locally recorded demonstration videos
live in a separate encrypted media store and are deliberately excluded. The app tracks
days-since-last-backup and will remind you.

---

## Getting your data in

### Apple Health

Apple exposes no web API, so the app uses two paths, both entirely on-device:

1. **Daily sync** — a Shortcuts personal automation reads HealthKit, packages the data, and
   copies it to the clipboard. Open Keel and it offers a one-tap import. One tap per day, not
   zero: iOS requires a user gesture before a page can read the clipboard, and that is a
   restriction worth having. The app generates the exact Shortcut for you.
2. **History** — Health app → your profile → Export All Health Data. Hand the `.zip` to Keel
   and it parses it locally in a background worker. This is also the only path that carries
   sleep stages, workout routes and intra-workout heart rate.

Nothing is uploaded in either case. The parsing happens in your browser.

### Oura and Strava

Both write into Apple Health, so the pipeline above already carries them and you need no extra
credentials. Direct API access is largely closed to a browser-only app — both vendors require a
client secret, which cannot be kept secret in a static bundle. Where a metric can't be obtained
that way (Oura's own computed readiness and sleep *scores*, for instance), the app says so
rather than quietly omitting it.

We ship no proxy server. A proxy would hold the secret and see your data, which defeats the
entire point.

### Food

A curated food database ships inside the app, so search works instantly and offline. Barcode
lookups query Open Food Facts on demand — that request contains a barcode and nothing else,
never your log.

---

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm run verify       # complete release gate; see below
npm run build:next   # optional reference build with Next's own compiler
```

`npm run verify` is the gate CI runs: TypeScript, lint, Vitest, the executable crypto and
vault proof harnesses, the production Sites build, Sites-worker and service-worker checks,
the privacy audit, and a high-severity production-dependency audit.

The privacy step is particularly important:

```bash
npm run audit:privacy
```

It reads the **actual Sites client and server bundles plus source request surfaces** and fails
if it finds an outbound host that is not justified in writing, a same-origin write, or an
exfiltration primitive (`sendBeacon`, analytics SDKs, external fonts). The production worker
also refuses all non-GET/HEAD methods and adds the HTTP security policy to every response.

### Layout

```
src/lib/crypto/     key derivation, AEAD, keyring, recovery codes
src/lib/vault/      unlock, session, auto-lock
src/lib/db/         Dexie schema, encrypted record codec, repositories
src/data/foods/     bundled offline food database
src/components/     UI primitives and charts
docs/kg/            architecture, task graph, reusable specs, and privacy boundary
```

`docs/kg/ARCHITECTURE.md` is authoritative. Read it before changing anything.

---

## This is not medical advice

Keel is a tracking and planning tool. It does not diagnose, screen, or treat anything, and it
will not tell you a food is safe to eat. Its coaching output passes through explicit guardrails
that bound how much it can change your training or nutrition, refuse unsafe targets, and
surface a suggestion to see a professional where that is the right answer. Those guardrails are
specified in `docs/kg/specs/` and implemented as code, not as a disclaimer.
