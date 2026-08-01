# Program Templates

**Status:** v1.0 seed · **Depends on:** [`training-methodology.md`](./training-methodology.md), [`exercise-library.json`](./exercise-library.json)
**Purpose:** five fully-specified, seedable program templates. Every exercise reference is a live `slug` from the exercise library, so these tables can be loaded straight into the database without a mapping layer.

---

## Conventions used in every table

| Column | Meaning |
|---|---|
| `slug` | Foreign key into `exercise-library.json` |
| `sets` | Working sets in **week 1** of the mesocycle (the MEV-anchored week). Sets rise across the block — see each template's progression rule. |
| `reps` | Target rep range. Progress within the range before adding load (double progression). |
| `RIR` | Week-1 target. Falls each week per the mesocycle RIR ramp. |
| `rest` | Seconds between sets |

**Universal rules applying to all five templates:**

1. **RIR ramp (4 accumulation weeks):** `[4, 3, 2, 1]`. Week 5 is a deload at RIR 4–5. See `training-methodology.md` §3.1.
2. **Set progression:** +1 set per muscle per week for the muscles you're prioritising, modulated by the soreness/pump feedback table (§3.3). Never schedule above MRV.
3. **Load progression:** when the top set hits `repMax` at or under the target RIR, add load (upper body +2.5%, lower body +5%) and reset to `repMin`.
4. **Deload week (week 5):** ~50% of the final accumulation week's sets, 60–70% of its load, RIR 4–5, reps unchanged. Never grind.
5. **Early-deload trigger:** 3 consecutive stalls on one lift, OR stalls across ≥3 lifts in one session → end the mesocycle now and deload. Premature deloads are cheap; late deloads are not.
6. **`face-pull` closes every training day** — 2 sets × 15–20 @ RIR 3–4. Cavaliere's standing prescription. It is deliberately *not* listed in every table below to avoid noise; the engine appends it automatically.
7. **Prescription units come from the exercise's `rep_unit` field** (`reps` | `seconds` | `meters` | `steps`). Read it; never infer it from `pattern` — see methodology §1.1 for why that inference is wrong (`dead-hang` is `vertical_pull` but timed; `sled-drag-backward` is `conditioning` but measured in metres). Where a table below writes `30–45 s` or `50 m`, that is the exercise's own unit rendered for a human reader.
8. **Readiness modulation** applies on top of all of it (§8.4), bounded by the guardrails in §8.5.

---

## Template 1 — Upper / Lower, 4 days/week *(default recommendation)*

**Who it's for:** the default for most intermediate users. Best volume-per-time ratio, hits every muscle 2×/week, survives a missed session better than a 6-day split.
**Mesocycle:** 5 weeks (4 accumulation + 1 deload).
**Schedule:** Mon Upper A · Tue Lower A · Thu Upper B · Fri Lower B.
**Week-1 volume check:** chest 10, lats 10, upper_back 10, side_delts 9, quads 9, hamstrings 8 — all at or just above MEV. ✅

### Day 1 — Upper A (horizontal bias)

| # | slug | sets | reps | RIR | rest |
|---|---|---|---|---|---|
| 1 | `barbell-bench-press` | 4 | 5–8 | 4 | 180 |
| 2 | `chest-supported-row` | 4 | 8–12 | 4 | 150 |
| 3 | `incline-dumbbell-press` | 3 | 8–12 | 4 | 120 |
| 4 | `neutral-grip-lat-pulldown` | 3 | 10–15 | 4 | 120 |
| 5 | `cable-lateral-raise` | 3 | 12–20 | 3 | 75 |
| 6 | `overhead-cable-triceps-extension` | 3 | 10–15 | 3 | 75 |
| 7 | `incline-dumbbell-curl` | 3 | 8–15 | 3 | 75 |
| 8 | `face-pull` | 2 | 15–20 | 4 | 60 |

### Day 2 — Lower A (squat bias)

| # | slug | sets | reps | RIR | rest |
|---|---|---|---|---|---|
| 1 | `back-squat` | 4 | 5–8 | 4 | 210 |
| 2 | `romanian-deadlift` | 3 | 6–10 | 4 | 180 |
| 3 | `leg-press` | 3 | 10–20 | 3 | 150 |
| 4 | `seated-leg-curl` | 3 | 8–15 | 3 | 90 |
| 5 | `standing-calf-raise` | 4 | 8–15 | 2 | 60 |
| 6 | `tibialis-raise` | 2 | 15–25 | 3 | 45 |
| 7 | `cable-crunch` | 3 | 10–20 | 2 | 60 |

### Day 3 — Upper B (vertical bias)

| # | slug | sets | reps | RIR | rest |
|---|---|---|---|---|---|
| 1 | `barbell-overhead-press` | 4 | 5–8 | 4 | 180 |
| 2 | `pull-up` | 4 | 5–12 | 4 | 150 |
| 3 | `machine-chest-press` | 3 | 8–15 | 3 | 120 |
| 4 | `seated-cable-row` | 3 | 8–15 | 3 | 120 |
| 5 | `reverse-pec-deck` | 3 | 12–20 | 3 | 60 |
| 6 | `machine-lateral-raise` | 3 | 10–20 | 2 | 60 |
| 7 | `cable-pushdown-rope` | 3 | 10–20 | 2 | 60 |
| 8 | `hammer-curl` | 3 | 8–15 | 2 | 60 |

### Day 4 — Lower B (hinge bias)

| # | slug | sets | reps | RIR | rest |
|---|---|---|---|---|---|
| 1 | `trap-bar-deadlift` | 3 | 5–10 | 4 | 210 |
| 2 | `bulgarian-split-squat` | 3 | 8–15 | 3 | 150 |
| 3 | `hip-thrust` | 3 | 8–15 | 3 | 120 |
| 4 | `lying-leg-curl` | 3 | 8–15 | 3 | 90 |
| 5 | `seated-calf-raise` | 3 | 12–25 | 2 | 60 |
| 6 | `copenhagen-plank` | 2 | 20–40 s | 3 | 60 |
| 7 | `hanging-leg-raise` | 3 | 8–15 | 2 | 60 |

**Progression:** add 1 set/week to the two highest-priority muscles, +1 set to everything else every *other* week. Cap at the MRV values in §2.1.
**Conditioning add-on:** 3 × 40 min `zone2-cycling` or `zone2-incline-walk` on non-lifting days.

---

## Template 2 — Push / Pull / Legs, 6 days/week

**Who it's for:** advanced users with high MRVs, ≥1 year of consistent training, and the schedule to actually show up 6×/week. Highest achievable weekly volume.
**Mesocycle:** 5 weeks (4 accumulation + 1 deload). Consider a 4-week block (3 + 1) — fatigue accumulates fast at this frequency.
**Schedule:** Push A · Pull A · Legs A · Push B · Pull B · Legs B · rest.
**Warning for the planner:** this template runs close to MRV by week 4 on several muscles. If readiness lands in the `low` band twice in one week, drop the second Legs day to a `zone2-cycling` session rather than cutting sets everywhere.

### Push A (heavy)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `barbell-bench-press` | 4 | 4–8 | 4 | 210 |
| `seated-dumbbell-shoulder-press` | 3 | 6–10 | 4 | 150 |
| `incline-dumbbell-press` | 3 | 8–12 | 3 | 120 |
| `dumbbell-lateral-raise` | 4 | 12–20 | 3 | 60 |
| `overhead-cable-triceps-extension` | 3 | 10–15 | 3 | 75 |
| `cable-pushdown-rope` | 3 | 12–20 | 2 | 60 |

### Pull A (heavy)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `barbell-row` | 4 | 6–10 | 4 | 180 |
| `pull-up` | 3 | 5–12 | 4 | 150 |
| `kneeling-cable-pulldown` | 3 | 10–15 | 3 | 90 |
| `chest-supported-rear-delt-row` | 3 | 10–15 | 3 | 75 |
| `barbell-shrug` | 3 | 8–15 | 2 | 75 |
| `ez-bar-curl` | 3 | 8–15 | 2 | 60 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

### Legs A (squat)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `back-squat` | 4 | 4–8 | 4 | 240 |
| `romanian-deadlift` | 3 | 6–10 | 4 | 180 |
| `hack-squat` | 3 | 8–15 | 3 | 150 |
| `seated-leg-curl` | 3 | 8–15 | 3 | 90 |
| `standing-calf-raise` | 4 | 8–15 | 2 | 60 |
| `ab-wheel-rollout` | 3 | 6–15 | 2 | 75 |

### Push B (volume)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `incline-machine-press` | 4 | 8–15 | 3 | 120 |
| `machine-shoulder-press` | 3 | 8–15 | 3 | 120 |
| `seated-cable-fly` | 3 | 10–20 | 2 | 75 |
| `cable-lateral-raise` | 4 | 12–20 | 2 | 60 |
| `dumbbell-overhead-extension` | 3 | 10–15 | 2 | 75 |
| `weighted-dip` | 3 | 6–12 | 3 | 120 |

### Pull B (volume)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `neutral-grip-lat-pulldown` | 4 | 10–15 | 3 | 120 |
| `seal-row` | 3 | 8–12 | 3 | 120 |
| `single-arm-cable-row` | 3 | 10–15 | 2 | 90 |
| `reverse-pec-deck` | 4 | 12–20 | 2 | 60 |
| `bayesian-cable-curl` | 3 | 10–15 | 2 | 60 |
| `hammer-curl` | 3 | 8–15 | 2 | 60 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

### Legs B (hinge / unilateral)
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `conventional-deadlift` | 3 | 3–6 | 4 | 240 |
| `bulgarian-split-squat` | 3 | 8–15 | 3 | 150 |
| `leg-press` | 3 | 10–20 | 3 | 150 |
| `lying-leg-curl` | 3 | 8–15 | 2 | 90 |
| `seated-calf-raise` | 4 | 12–25 | 2 | 60 |
| `adductor-machine` | 3 | 12–20 | 2 | 60 |
| `hanging-leg-raise` | 3 | 8–15 | 2 | 75 |

**Progression:** +1 set per muscle per week is too aggressive here. Use **+1 set every other week** on large muscles, +1/week on side delts, rear delts, biceps, calves (high-MRV, fast-recovering).
**Deload:** mandatory at week 5, no exceptions. This template has the highest early-deload rate — expect it and don't treat it as failure.

---

## Template 3 — Full Body, 3 days/week

**Who it's for:** beginners, returners, time-constrained users, anyone with unpredictable availability. Missing one of three sessions still leaves every muscle trained twice that fortnight.
**Mesocycle:** 6 weeks (5 accumulation + 1 deload) — lower per-session fatigue supports a longer block.
**Schedule:** Mon · Wed · Fri.
**Volume note:** apply the **beginner scale (×0.65)** from §2.2. Week 1 sits at roughly 6–8 weekly sets for major muscles, which is genuinely enough for a novice.

### Day A
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `goblet-squat` | 3 | 8–15 | 4 | 150 |
| `dumbbell-bench-press` | 3 | 6–12 | 4 | 150 |
| `chest-supported-row` | 3 | 8–12 | 4 | 150 |
| `romanian-deadlift` | 2 | 8–12 | 4 | 150 |
| `dumbbell-lateral-raise` | 2 | 12–20 | 3 | 60 |
| `plank` | 2 | 30–45 s | 3 | 60 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

### Day B
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `trap-bar-deadlift` | 3 | 5–10 | 4 | 180 |
| `machine-shoulder-press` | 3 | 8–15 | 4 | 150 |
| `lat-pulldown` | 3 | 8–15 | 4 | 120 |
| `leg-press` | 3 | 10–20 | 3 | 120 |
| `cable-pushdown-rope` | 2 | 12–20 | 3 | 60 |
| `dead-bug` | 2 | 8–15 | 3 | 45 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

### Day C
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `split-squat` | 3 | 8–15 | 4 | 120 |
| `incline-dumbbell-press` | 3 | 8–12 | 4 | 150 |
| `inverted-row` | 3 | 8–20 | 4 | 120 |
| `seated-leg-curl` | 3 | 8–15 | 3 | 90 |
| `ez-bar-curl` | 2 | 8–15 | 3 | 60 |
| `standing-calf-raise` | 3 | 8–15 | 2 | 60 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

**Progression:** load first, sets second. Beginners get far more from adding weight to a stable set count than from adding volume. Add sets only from week 3 onward, and only where soreness has been low.
**Deload:** week 6. Beginners often don't need one — if performance is still climbing and soreness is low, run a 7th accumulation week and deload after.

---

## Template 4 — Hybrid Strength + Conditioning, 5 days/week

**Who it's for:** users whose goal is general athleticism — strength, a real VO2max, and enough muscle. Galpin's concurrent-training structure with Israetel's volume accounting.
**Mesocycle:** 4 weeks (3 accumulation + 1 deload). Concurrent training accumulates fatigue faster; shorter blocks.
**Schedule:** Mon Lower Strength · Tue Upper Strength · Wed Zone 2 · Thu Lower Hypertrophy + VO2max · Fri Upper Hypertrophy · Sat Long Zone 2 · Sun rest.
**Key constraint:** ≥6 hours between hard lifting and hard conditioning, or put them on different days. Lift first if same-session. Modality preference is low-eccentric (bike, rower, sled) to protect leg hypertrophy.
**Volume accounting:** because Z4/Z5 conditioning exceeds 60 min/week here, **reduce lower-body MRV estimates by ~10%** (§11.6).

### Mon — Lower Strength
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `back-squat` | 5 | 3–5 | 3 | 240 |
| `romanian-deadlift` | 3 | 6–8 | 3 | 180 |
| `bulgarian-split-squat` | 3 | 8–12 | 3 | 120 |
| `standing-calf-raise` | 3 | 8–15 | 2 | 60 |
| `pallof-press` | 3 | 10–15 | 3 | 60 |

### Tue — Upper Strength
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `barbell-bench-press` | 5 | 3–5 | 3 | 240 |
| `weighted-pull-up` | 4 | 3–8 | 3 | 180 |
| `barbell-overhead-press` | 3 | 5–8 | 3 | 180 |
| `chest-supported-row` | 3 | 8–12 | 3 | 120 |
| `face-pull` | 3 | 15–20 | 4 | 60 |
| `farmers-carry` | 3 | 30–45 s | 3 | 90 |

### Wed — Zone 2
| slug | duration | zone |
|---|---|---|
| `zone2-cycling` | 45–60 min | Z2 (60–75% HRmax, conversational) |
| `couch-stretch` | 2 × 60 s/side | — |
| `ninety-ninety-hip-switch` | 2 × 10 | — |

### Thu — Lower Hypertrophy + VO2max
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `hack-squat` | 3 | 8–15 | 3 | 150 |
| `seated-leg-curl` | 3 | 8–15 | 2 | 90 |
| `hip-thrust` | 3 | 8–15 | 2 | 120 |
| `seated-calf-raise` | 3 | 12–25 | 2 | 60 |
| — *≥6 h later, or after a full rest* — | | | | |
| `assault-bike-intervals` | 4 rounds | 4 min work / 3 min easy | Z5 | — |

### Fri — Upper Hypertrophy
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `incline-dumbbell-press` | 3 | 8–12 | 3 | 120 |
| `seated-cable-row` | 3 | 8–15 | 3 | 120 |
| `machine-lateral-raise` | 4 | 12–20 | 2 | 60 |
| `neutral-grip-lat-pulldown` | 3 | 10–15 | 2 | 90 |
| `overhead-cable-triceps-extension` | 3 | 10–15 | 2 | 60 |
| `incline-dumbbell-curl` | 3 | 8–15 | 2 | 60 |
| `face-pull` | 2 | 15–20 | 4 | 60 |

### Sat — Long Zone 2
| slug | duration | zone |
|---|---|---|
| `ruck-walk` *or* `zone2-incline-walk` | 60–90 min | Z2 |

**Weekly conditioning total:** ~150–180 min Zone 2 + ~16 min Z5 work → roughly the 80/20 polarized split (§9.2). ✅
**Progression:** strength lifts progress by load only (add weight, hold sets). Hypertrophy lifts use double progression + 1 set/week. Conditioning progresses by duration first, then intensity.
**Deload:** week 4 — halve lifting sets *and* drop the VO2max session entirely. Keep Zone 2; it's recovery-positive.

---

## Template 5 — Joint-Resilience Build, 4 days/week

**Who it's for:** users with a history of knee, shoulder, or low-back irritation who are currently **asymptomatic** and want to build a base that holds. Heavy on Cavaliere's prehab layer and Ben Patrick's KOT ladders, light on axial loading.
**Not for:** anyone currently in pain. Pain → clinician, not a template. See §8.5 guardrail 4.
**Mesocycle:** 6 weeks (5 accumulation + 1 deload). Connective tissue adapts on a slower clock than muscle; longer blocks, smaller jumps.
**Schedule:** Mon Lower (knee focus) · Tue Upper (shoulder focus) · Thu Lower (hip/hamstring focus) · Fri Upper (back focus).
**Progression rule specific to this template:** **progress range of motion before load.** An ATG split squat done to a deeper, pain-free range with no weight is a progression. This is the core of Ben Patrick's method and the engine must model ROM as a progression axis, not just sets × reps × load.

### Mon — Lower, knee focus
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `ankle-dorsiflexion-mobilization` | 2 | 10–15/side | — | 30 |
| `tibialis-raise` | 3 | 15–25 | 3 | 45 |
| `patrick-step` | 3 | 8–12 | 3 | 60 |
| `atg-split-squat` | 3 | 5–10 | 3 | 90 |
| `leg-press` | 3 | 10–20 | 3 | 120 |
| `knees-over-toes-calf-raise` | 3 | 10–20 | 2 | 60 |
| `sled-drag-backward` | 3 | 50 m | — | 90 |

### Tue — Upper, shoulder focus
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `wall-slide` | 2 | 10–12 | — | 30 |
| `band-pull-apart` | 2 | 15–25 | 4 | 30 |
| `landmine-press` | 3 | 8–12 | 3 | 120 |
| `neutral-grip-pull-up` | 3 | 5–12 | 3 | 120 |
| `incline-dumbbell-press` | 3 | 8–12 | 3 | 120 |
| `chest-supported-row` | 3 | 8–12 | 3 | 120 |
| `side-lying-external-rotation` | 3 | 12–20 | 3 | 45 |
| `face-pull` | 3 | 15–20 | 4 | 60 |

### Thu — Lower, hip & hamstring focus
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `couch-stretch` | 2 | 60 s/side | — | 30 |
| `assisted-nordic-curl` | 3 | 5–8 | 3 | 90 |
| `cable-pull-through` | 3 | 10–20 | 3 | 90 |
| `45-degree-back-extension` | 3 | 10–20 | 3 | 75 |
| `copenhagen-plank` | 3 | 20–40 s | 3 | 60 |
| `abductor-machine` | 3 | 12–20 | 2 | 60 |
| `seated-good-morning` | 2 | 8–15 | 4 | 90 |

### Fri — Upper, back & posture focus
| slug | sets | reps | RIR | rest |
|---|---|---|---|---|
| `scap-pull-up` | 2 | 8–12 | — | 45 |
| `quadruped-thoracic-rotation` | 2 | 8–10/side | — | 30 |
| `seated-cable-row` | 4 | 8–15 | 3 | 120 |
| `neutral-grip-lat-pulldown` | 3 | 10–15 | 3 | 120 |
| `machine-chest-press` | 3 | 8–15 | 3 | 120 |
| `prone-incline-y-raise` | 3 | 12–20 | 3 | 45 |
| `reverse-curl` | 2 | 10–15 | 3 | 45 |
| `farmers-carry` | 3 | 30–45 s | 3 | 90 |

**Progression ladders active in this template** (advance when the standard is met, pain-free):
- `patrick-step` → `poliquin-step-up` → `atg-split-squat` (bodyweight, full range) → `atg-split-squat` loaded to ~50% BW × 10
- `tibialis-raise` → `seated-tibialis-raise` → `tib-bar-raise` @ 25% BW × 5×5
- `assisted-nordic-curl` → `nordic-hamstring-curl-eccentric` (3×5) → `nordic-hamstring-curl`
- `side-lying-external-rotation` → `cable-external-rotation`

**Conditioning:** 3 × 30–45 min `zone2-cycling` or `zone2-swim` (zero impact). Add `sled-push-forward` once the backward drag is comfortable at ~50% BW.
**Deload:** week 6 — halve sets, keep all mobility and prehab work at full dose. Mobility work is not what needs deloading.

---

## Template selection logic

```ts
function recommendTemplate(u: UserProfile): TemplateId {
  if (u.painHistory.length > 0 && u.currentlyAsymptomatic) return "joint-resilience-4d";
  if (u.trainingAgeMonths < 9)                             return "full-body-3d";
  if (u.goal === "athleticism" || u.wantsConditioning)     return "hybrid-5d";
  if (u.availableDays >= 6 && u.trainingAgeMonths >= 12)   return "ppl-6d";
  return "upper-lower-4d";   // default
}
```

If the user is **currently in pain**, no template is returned. The app shows a clinician referral and offers to keep tracking only.

---

## Seeding notes for the vault / storage agent

Per [`ARCHITECTURE.md`](../ARCHITECTURE.md) there is no server database — this seeds into **Dexie/IndexedDB**, client-side.

- Every `slug` above resolves against `exercise-library.json` (220 entries, validated — zero dangling references).
- **The exercise library and these templates are static reference data, not user data.** They contain nothing personal, so they should ship in the bundle and live in **unencrypted** Dexie tables (or be imported directly as a JS module). Only the *user's* program instance, logged sets, and readiness inputs go in the encrypted vault. Encrypting 196 KB of public exercise data on every unlock is pure cost.
- Suggested stores: `exercise` (keyed by `slug`), `programTemplate`, `programDay`, `programSlot` (ordered, referencing `exercise.slug`) with `sets`, `repMin`, `repMax`, `targetRir`, `restSeconds`, `orderIndex`, `isTimeBased`.
- **No `isTimeBased` flag is needed** — `exercise.rep_unit` carries this directly and is already materialised on all 220 entries. Render off `rep_unit`; don't derive a second, drift-prone boolean.
- `exercise.rom_tracked` tells the logger to surface a ROM/depth input rather than (or alongside) a weight input. Store the logged value as `{ value, unit }` plus free text — the 16 tracked entries measure genuinely different things (centimetres, angles, distance).
- The RIR values in these tables are **week-1** values. Store the mesocycle `rirRamp` on `programTemplate`, not on the slot.
- Bump a `libraryVersion` constant whenever the JSON changes so a migration can re-seed without touching user data.
