# Training Methodology Specification

**Status:** v1.0 seed spec · **Owner:** research agent · **Consumers:** planner engine, progression engine, DB schema, UI
**Purpose:** define the training logic that powers workout planning, week-to-week progression, and readiness-based modulation, synthesized from five sources: Mike Israetel (Renaissance Periodization), Jeff Nippard, Jeff Cavaliere (ATHLEAN-X), Andy Galpin, Ben Patrick (Knees Over Toes).

---

## 0. How to read this document

Every substantive claim carries a confidence tag:

| Tag | Meaning | Engineering implication |
|---|---|---|
| `[well-established]` | Supported by multiple independent lines of evidence / meta-analysis; all five coaches would agree. | Safe to hard-code. |
| `[coach-specific opinion]` | A specific coach's model or number. Internally coherent, defensible, but a *choice* — other credible coaches pick differently. | Hard-code as a **default with an override knob**. Store the number in config, not in code. |
| `[uncertain]` | Thin evidence, extrapolated, or the coaches actively disagree. | Must be user-tunable, and should not drive aggressive automated changes. |

**Two non-negotiable rules for anything downstream of this document:**

1. **This app is not a medical device.** Nothing here diagnoses, treats, or gives medical advice. Any pain, injury, illness, or persistent abnormal biometric must route the user to "see a qualified clinician," never to a programmed workaround.
2. **All automated adjustments are bounded.** No readiness signal may move volume by more than ±1 "step" per session or intensity by more than 1 RIR per session (see §11). The engine nudges; it never yanks.

---

## 1. Core object model

```ts
type Muscle =
  | "chest" | "front_delts" | "side_delts" | "rear_delts" | "lats" | "upper_back"
  | "traps" | "biceps" | "triceps" | "forearms" | "quads" | "hamstrings" | "glutes"
  | "adductors" | "abductors" | "calves" | "tibialis" | "spinal_erectors"
  | "abs" | "obliques" | "neck" | "hip_flexors";

type Landmarks = { mv: number; mev: number; mavLow: number; mavHigh: number; mrv: number }; // weekly hard sets

type RepUnit = "reps" | "seconds" | "meters" | "steps";   // see §1.1

type SetPrescription = {
  exerciseSlug: string;
  sets: number;
  repMin: number;
  repMax: number;
  repUnit: RepUnit;      // NEVER infer this from `pattern` — see §1.1
  targetRIR: number;     // reps in reserve
  loadHint?: number;     // kg, derived from last session
  restSeconds: number;
  romTarget?: string;    // set only when exercise.rom_tracked — see §1.2
};
```

### 1.1 Prescription units — `rep_unit`

`default_rep_range` is **not always reps.** Every exercise carries an explicit `rep_unit` declaring what the two numbers mean. Controlled vocabulary, complete list:

| `rep_unit` | Meaning | Count | Examples |
|---|---|---|---|
| `reps` | Conventional repetitions | 192 | `barbell-bench-press`, `atg-split-squat` |
| `seconds` | Held or timed work — isometrics, carries, steady-state and interval conditioning | 25 | `plank`, `dead-hang`, `farmers-carry`, `zone2-cycling` `[1800,3600]` = 30–60 min |
| `meters` | Distance per trip | 2 | `sled-drag-backward`, `sled-push-forward` |
| `steps` | Steps per direction | 1 | `banded-lateral-walk` |

**Never infer the unit from `pattern`.** The inference is wrong for isometrics that live inside non-conditioning patterns, and those are not rare edge cases:

| Slug | `pattern` | Actual unit |
|---|---|---|
| `dead-hang` | `vertical_pull` | `seconds` |
| `wall-sit` | `squat` | `seconds` |
| `plank`, `side-plank`, `l-sit`, `copenhagen-plank` | `isolation` | `seconds` |
| `banded-lateral-walk` | `isolation` | `steps` |
| `sled-drag-backward` | `conditioning` | `meters` (not seconds, unlike every other conditioning entry) |

Units are assigned per-slug in the library's build metadata, and the build fails if any slug is unmapped or maps to a value outside the four above. Adding a fifth unit requires a channel post — the UI has to render it.

### 1.2 Range of motion as a progression axis — `rom_tracked`

For 16 exercises, **range of motion is the progression variable**, not load or reps. A deeper pain-free ATG split squat at the same bodyweight is genuine progress; a sets × reps × load model cannot represent it, and the Knees Over Toes ladders (§7.1) silently stop working if the logger can't record it.

`rom_tracked: true` tells the workout logger to surface a **ROM/depth input** instead of, or alongside, a weight input. Every such entry states in its `notes` exactly what gets measured, in the form `ROM progression: measured as …` — the build fails if it doesn't, and fails if a non-tracked entry claims one.

The 16: `atg-split-squat`, `patrick-step`, `poliquin-step-up`, `sissy-squat`, `reverse-nordic-curl`, `assisted-nordic-curl`, `nordic-hamstring-curl-eccentric`, `nordic-hamstring-curl`, `knees-over-toes-calf-raise`, `cossack-squat`, `ab-wheel-rollout`, `deep-squat-hold`, `ankle-dorsiflexion-mobilization`, `couch-stretch`, `elephant-walk`, `jefferson-curl`.

Measurement is deliberately heterogeneous — knee-to-wall centimetres, torso angle, descent angle, rollout distance — so store it as `{ value: number, unit: string }` plus free text rather than forcing one scale. `[coach-specific opinion]`: the *principle* of progressing range before load is Ben Patrick's central claim and the app should honour it in the KOT track specifically, not universally.

### 1.3 Muscle vocabulary

Canonical muscle vocabulary is the 22-value `Muscle` union above. **It is frozen** — the exercise library, DB schema, and UI all key off it. Rationale for the unusual members: `tibialis` and `hip_flexors` exist because the Knees Over Toes track programs them directly; `neck` exists because it is trained directly in athlete-oriented programs; `upper_back` is split from `lats` because their exercise selections and volume landmarks genuinely differ (rows vs. pulldowns).

---

## 2. Volume landmarks (Israetel / Renaissance Periodization)

RP's central abstraction: for each muscle, weekly hard-set volume has four landmarks. `[coach-specific opinion]` — the *framework* is Israetel's; the *general dose-response* underneath it is `[well-established]`.

- **MV — Maintenance Volume:** sets/week to hold current muscle while under-recovered or in a deficit.
- **MEV — Minimum Effective Volume:** the floor at which growth becomes measurable. Mesocycles **start here**.
- **MAV — Maximum Adaptive Volume:** the band where growth per unit of fatigue is best. This is a *range*, and it drifts week to week.
- **MRV — Maximum Recoverable Volume:** ceiling. Exceeding it for more than ~1 week produces net fatigue, not net growth. Mesocycles **end just under here**, then deload.

Source: [RP — Training Volume Landmarks for Muscle Growth](https://rpstrength.com/blogs/articles/training-volume-landmarks-muscle-growth); [RP Hypertrophy App knowledge base, per-muscle articles](https://hypertrophy.zendesk.com/hc/en-us/articles/18980934222231-Side-Delts).

### 2.1 Seed table — weekly hard sets, intermediate trainee

`[coach-specific opinion]` for every cell. These are the values RP publishes for an intermediate lifter and are what the engine should ship with. They are **starting estimates the app is expected to personalize**, not truths.

| Muscle | MV | MEV | MAV (low–high) | MRV | Min freq/wk | Notes |
|---|---|---|---|---|---|---|
| chest | 8 | 10 | 12–20 | 22 | 2 | Split flat/incline; incline biases clavicular head |
| front_delts | 0 | 0 | 6–12 | 12 | 1 | MEV is 0 — heavily stimulated by all pressing |
| side_delts | 6 | 8 | 16–22 | 26 | 2–4 | Highest MRV of the delts; recovers fast, tolerates high frequency |
| rear_delts | 0 | 6 | 12–20 | 26 | 2–4 | MEV 0 if back volume is high; recovers fast |
| lats | 6 | 10 | 14–22 | 25 | 2 | Vertical pulling + pullovers |
| upper_back | 0 | 10 | 12–20 | 25 | 2 | Rows, rear-delt/scap work counts here |
| traps | 0 | 0 | 12–20 | 26 | 1 | MEV 0 — fed by deadlifts, rows, carries, shrugs |
| biceps | 5 | 8 | 14–20 | 26 | 2 | High MRV; small muscle, cheap to recover |
| triceps | 4 | 6 | 10–14 | 18 | 2 | **Lower MRV than biceps** — elbow tendon is the limiter |
| forearms | 2 | 2 | 10–15 | 20 | 2 | Largely fed by grip demand of other lifts |
| quads | 6 | 8 | 12–18 | 20 | 2 | Systemically expensive; MRV is fatigue-capped not muscle-capped |
| hamstrings | 4 | 6 | 10–16 | 20 | 2 | Split hip-dominant (RDL) and knee-dominant (curl) |
| glutes | 0 | 4 | 12–16 | 16 | 2 | MEV very low — squats/hinges feed it |
| adductors | 0 | 6 | 8–12 | 16 | 2 | `[uncertain]` — RP publishes less here; derived |
| abductors | 0 | 4 | 6–12 | 14 | 2 | `[uncertain]` — mostly extrapolated |
| calves | 6 | 8 | 12–16 | 20 | 2–3 | Very high recovery rate, low systemic cost |
| tibialis | 0 | 4 | 6–12 | 16 | 2–3 | `[uncertain]` — not an RP landmark. Derived from Ben Patrick's 5×5-ish weekly dosing |
| spinal_erectors | 0 | 4 | 6–10 | 12 | 2 | `[uncertain]` — low MRV; heavily loaded by squat/deadlift/row |
| abs | 0 | 0 | 16–20 | 25 | 2 | MEV 0 for many; high MRV |
| obliques | 0 | 0 | 8–16 | 20 | 2 | `[uncertain]` — folded into abs by most RP material |
| neck | 0 | 0 | 8–12 | 16 | 2 | `[uncertain]` — athlete/contact-sport population only |
| hip_flexors | 0 | 0 | 4–10 | 12 | 1–2 | `[uncertain]` — trained directly only in the KOT track |

### 2.2 Training-age scaling

`[coach-specific opinion]` — apply a multiplier to MEV/MAV/MRV (never to MV):

```ts
const trainingAgeScale = { beginner: 0.65, intermediate: 1.0, advanced: 1.15 } as const;
// Beginners: floor MEV at 6 sets/wk for major muscles. They grow at MV-ish volumes and
// the limiting factor is technique and connective-tissue tolerance, not volume.
```

Rationale for the beginner clamp: the biggest programming failure mode for novices is prescribing intermediate volume, blowing up soreness, and killing adherence. `[well-established]` that beginners respond to low volume.

### 2.3 Set-counting rules

`[coach-specific opinion]`, but pick one and be consistent — inconsistency here silently corrupts every volume calculation.

- A **hard set** = a working set taken to ≤4 RIR. Warm-ups never count.
- **Direct volume** (`primary_muscles`) counts as **1.0 sets**.
- **Indirect volume** (`secondary_muscles`) counts as **0.5 sets**.
- Example: a barbell row set = 1.0 to `upper_back`, 1.0 to `lats`, 0.5 to `biceps`, 0.5 to `rear_delts`, 0.5 to `spinal_erectors`.
- Myo-rep / drop-set / cluster extensions count as **1.5 sets** of the muscle, not 2+. `[uncertain]`

**Implementation note:** store the 0.5 multiplier as config (`INDIRECT_SET_WEIGHT = 0.5`). Some practitioners use 0 (direct-only counting), some use 1.0. Direct-only counting will systematically over-prescribe arm and rear-delt volume in high-frequency programs.

### 2.4 Frequency

`[well-established]`: when weekly volume is equated, frequency has a small effect on hypertrophy; 2×/week beats 1×/week mostly because it lets you *fit* more quality volume. `[coach-specific opinion]` (Israetel): the real constraint is **sets per muscle per session**, which should stay ≈ 4–10 for large muscles. So:

```ts
function minFrequency(weeklySets: number, muscle: Muscle): number {
  const perSessionCap = LARGE_MUSCLES.has(muscle) ? 8 : 10;
  return Math.max(2, Math.ceil(weeklySets / perSessionCap));
}
```

---

## 3. Mesocycle model

The RP accumulation → deload structure, expressed so it can be coded directly. `[coach-specific opinion]`.

### 3.1 Shape

- **Mesocycle length:** 4–6 weeks total = 3–5 accumulation weeks + 1 deload week. **Default: 5 weeks (4 accumulation + 1 deload).**
- **Volume trajectory:** week 1 starts at MEV; each subsequent week adds sets per muscle until week N sits at or just under MRV.
- **Intensity trajectory:** RIR *falls* across the mesocycle. Israetel's canonical ramp for a 4-week accumulation is **4 → 3 → 2 → 1 RIR**, then deload. Source: [RP — Progressing for Hypertrophy](https://rpstrength.com/expert-advice/progressing-for-hypertrophy), [Israetel on static vs. dropping RIR](https://www.youtube.com/watch?v=7xVvEsUUDmo).

The rationale for the falling ramp is the key insight: fatigue accumulates across the block, so a *fixed* RIR target means the stimulus-to-fatigue ratio degrades silently. Lowering RIR each week keeps effective stimulus roughly constant against a rising fatigue floor. Israetel's own caveat: don't linger at 4 RIR (inefficient) or at 0–1 RIR (unsustainable).

### 3.2 Reference implementation

```ts
type MesoConfig = {
  accumulationWeeks: number;   // default 4
  deloadWeeks: number;         // default 1
  rirRamp: number[];           // default [4,3,2,1]  (length === accumulationWeeks)
  setIncrementLarge: number;   // default 1  (sets added per muscle per week)
  setIncrementSmall: number;   // default 1
};

function weeklySetsFor(muscle: Muscle, week: number, cfg: MesoConfig, lm: Landmarks): number {
  if (week > cfg.accumulationWeeks) return deloadSets(lm);          // deload week
  const span = lm.mrv - lm.mev;
  const steps = Math.max(1, cfg.accumulationWeeks - 1);
  // Linear ramp MEV -> ~95% of MRV. Never schedule *at* MRV; MRV is a limit, not a target.
  const target = lm.mev + (span * 0.95) * ((week - 1) / steps);
  return clamp(Math.round(target), lm.mev, lm.mrv);
}

function targetRIR(week: number, cfg: MesoConfig): number {
  if (week > cfg.accumulationWeeks) return 4;                        // deload
  return cfg.rirRamp[Math.min(week - 1, cfg.rirRamp.length - 1)];
}

function deloadSets(lm: Landmarks): number {
  // Deload = MV-ish volume, ~50-60% of last accumulation week's load, RIR 4-5.
  return Math.max(lm.mv, Math.round(lm.mev * 0.6));
}
```

**Deload prescription** `[coach-specific opinion]`:
- Sets: ~50% of the final accumulation week (floor at MV).
- Load: ~60–70% of the final accumulation week's working weight.
- RIR: 4–5. Reps unchanged. Never grind.
- Duration: 1 week (5–7 days). Longer only after a peaking block or if readiness is still suppressed.

### 3.3 Within-mesocycle progression rules (the part the engine actually runs)

Per exercise, week over week, in priority order:

```
IF last week's top set hit repMax at or below targetRIR:
    → add load (upper body +2.5%, lower body +5%, or the smallest available plate jump), reset to repMin
ELSE IF reps achieved >= last week's reps:
    → add 1 rep at the same load (double progression), stay within [repMin, repMax]
ELSE (reps regressed):
    → repeat the load; log a "stall" event
```

**Stall handling** `[coach-specific opinion]`:
- 1 stall → repeat.
- 2 consecutive stalls on the same exercise → cut that exercise's sets by 1 for the week.
- 3 consecutive stalls, or stalls across ≥3 exercises in a session → **end the mesocycle early and deload**. This is the single most valuable autoregulation rule in the system; premature deloads cost almost nothing, late deloads cost weeks.

**Volume-add rule between weeks** `[coach-specific opinion]`, RP's "feedback" heuristic. Ask three questions after each session and add sets to the *next* week accordingly:

| Signal | Set change next week |
|---|---|
| No pump, no disruption, no soreness, session felt easy | +2 sets |
| Moderate pump/soreness, recovered by next session | +1 set |
| High soreness, still sore on next session for that muscle | +0 sets |
| Very sore, performance down, joints achy | −1 set (or hold and flag) |

### 3.4 Mesocycle → mesocycle

After a deload, set the next block's starting volume using the previous block:
- If the previous block's final week was tolerated with performance still rising → next MEV estimate `+= 1–2 sets`.
- If it ended in an early deload → next MEV estimate stays, and the MRV estimate drops by 1–2 sets.
- Cap drift at ±3 sets per block so estimates cannot run away. `[uncertain]` — this is our guardrail, not a published rule.

**Every 3–4 mesocycles**, run a **resensitization phase**: 1–2 weeks at MV. `[coach-specific opinion]` — the claimed mechanism (restoring sensitivity to volume) is `[uncertain]`, but the practical effect (a real break for connective tissue) is not.

---

## 4. Exercise selection and ordering

### 4.1 Stimulus-to-fatigue ratio (SFR)

`[coach-specific opinion]` (Israetel). SFR = target-muscle stimulus ÷ total (systemic + joint + local) fatigue. The exercise library encodes this as `sfr_rating` 1–5, 5 = best. Selection heuristics:

- Prefer high-SFR movements when weekly volume is high (late mesocycle) — they let you keep adding sets.
- Tolerate low-SFR/high-load movements early in the mesocycle and early in the session, when you're freshest.
- Machines and cables generally score higher SFR than free-weight equivalents for *hypertrophy specifically*, because stabilization fatigue is offloaded. This is Nippard's stated reason for putting machine chest press and seated cable fly above barbell bench for chest growth ([BarBend coverage of Nippard's chest tier list](https://barbend.com/news/jeff-nippard-ranks-chest-exercises-for-hypertrophy/)).

### 4.2 Nippard's exercise-ranking criteria

`[coach-specific opinion]` — three criteria, useful as an explicit scoring rubric the app can show users:

1. **Stretch & tension** — how loaded the muscle is at long muscle lengths. `[well-established]` that training at long lengths is at least as good as, and plausibly better than, short-length training for hypertrophy.
2. **It needs to feel good** — smooth resistance profile, no joint pain, clear mind-muscle connection.
3. **Simple progression** — can you add load/reps cleanly, session to session?

Source: [Nippard's chest exercise tier list, via BarBend](https://barbend.com/news/jeff-nippard-ranks-chest-exercises-for-hypertrophy/) and [Fitness Volt](https://fitnessvolt.com/jeff-nippard-best-and-worst-chest-exercises/).

Sample rankings encoded in the library: machine chest press and seated cable fly at the top for chest; barbell bench press strong but A-tier (shallower stretch than dumbbells, since a bar stops at the ribcage); plate press near the bottom. Incline pressing at ~30° for the clavicular head.

### 4.3 Exercise order rules

In priority order `[coach-specific opinion]`, consistent across Israetel and Nippard:

1. **Highest skill/highest load first.** Compound barbell lifts before machines before isolation.
2. **Priority muscle first** within a session — the lagging body part gets the freshest slot.
3. **Never put a lift that fatigues the same stabilizers before a lift that needs them** (e.g. don't put heavy RDLs before squats; don't put lateral raises before overhead press if the press matters).
4. **Isolation last**, with one deliberate exception: **pre-exhaust or "primer" isolation** for a muscle with a poor mind-muscle connection.
5. **Prehab/corrective work is bookended**, not buried: activation work before, face pulls / cuff work after. (Cavaliere.)
6. Israetel's **heavy–moderate–light** ordering across the *week*: heaviest compounds on the freshest day, moderate mid-week, pump work last. ([RP compilation](https://rpstrength.com/blogs/articles/dr-mike-israetel-compilation))

---

## 5. Rep ranges and adaptation targets

`[well-established]` that hypertrophy is achievable across a wide rep range when sets are taken near failure; the ranges below are about *efficiency and specificity*, not about growth being impossible outside them.

| Goal | Reps | %1RM (approx) | RIR | Rest | Weekly frequency |
|---|---|---|---|---|---|
| Max strength | 1–5 | 85–95% | 2–4 | 3–5 min | 2–3× per lift |
| Strength–hypertrophy overlap | 5–8 | 75–85% | 1–3 | 2–3 min | 2× per muscle |
| Hypertrophy (primary) | 6–12 | 65–80% | 0–3 | 1.5–3 min | 2–4× per muscle |
| Metabolite / pump | 12–25 | 40–65% | 0–2 | 60–90 s | 2–4× per muscle |
| Power / rate of force dev. | 1–5 explosive | 30–60% | high (never near failure) | 2–3 min full recovery | 2–3× |
| Muscular endurance | 15–30+ | <50% | 0–2 | 30–60 s | 2–3× |

**Rest periods** `[well-established]`: longer rest (≥2 min) produces more hypertrophy than short rest at matched sets, because it preserves reps. Short rest is a time-efficiency compromise, not an optimization.

**Galpin's adaptation framing** `[coach-specific opinion]`: strength, hypertrophy, and endurance are distinct adaptation targets with distinct dose requirements, and the app should make the user pick a *primary* one per block rather than chasing all three. Concurrent training interference is real but modest and mostly affects lower-body strength/power when high-volume endurance is stacked close in time. Practical mitigation `[coach-specific opinion]`: separate hard lifting and hard conditioning by ≥6 hours, or put them on different days; if same-session is unavoidable, lift first when strength is the goal.

---

## 6. Joint health and prehab layer (Cavaliere)

Jeff Cavaliere is a physical therapist (MSPT, former head PT for the New York Mets) and his contribution to this spec is the **joint-preservation layer that runs underneath every program**. `[coach-specific opinion]` throughout, but the underlying principle — balance pushing volume with pulling/external-rotation volume — is `[well-established]` enough to be safe as a default.

### 6.1 Mandatory balance ratios

```ts
// Enforced by the planner as a weekly check.
const BALANCE_RULES = [
  { name: "pull_to_push",     numerator: ["horizontal_pull","vertical_pull"], denominator: ["horizontal_push","vertical_push"], min: 1.0 },
  { name: "rear_to_front_delt", numerator: ["rear_delts"], denominator: ["front_delts"], min: 1.0 },
  { name: "hinge_to_squat",   numerator: ["hinge"], denominator: ["squat"], min: 0.75 },
];
```
Violations should produce a soft warning in the UI plus an auto-suggested fix (add a row / add face pulls), never a hard block.

### 6.2 The standing prehab prescription

- **Face pulls after every session** — push, pull, legs, all of them. Cavaliere's position is that face pulls hit three chronically under-trained things at once: upper back, rotator cuff (external rotation), and scapular retractors. 2–3 sets × 12–20, RIR 3–4, never to failure. Source: [ATHLEAN-X — Do Face Pulls After Every Workout](https://learn.athleanx.com/articles/shoulders-for-men/do-face-pulls-after-every-workout), [ATHLEAN-X — How To Do Face Pulls](https://learn.athleanx.com/articles/shoulders-for-men/stop-doing-face-pulls-like-this).
- **External rotation work** (side-lying DB ER, cable ER at 90°) 2×/week for anyone doing >10 weekly pressing sets.
- **Scap health**: scap pull-ups, band pull-aparts, prone Y/W raises, wall slides. Low load, high control.
- **Dumbbells over barbells for overhead pressing** where shoulder irritation exists — independent arms permit natural scapulohumeral rhythm rather than forcing a fixed path. ([Fitness Volt on Cavaliere's shoulder work](https://fitnessvolt.com/jeff-cavaliere-shares-shoulder-workout/))
- **"Train like an athlete"**: include carries, rotation, anti-rotation, and unilateral work in every week — not just the sagittal-plane bilateral lifts.

### 6.3 Overuse patterns and their substitutions

The library encodes these as `regressions`. The planner should surface them when a user flags joint discomfort.

| Complaint | Likely culprit | Substitution |
|---|---|---|
| Anterior shoulder pain on press | Flat barbell bench, behind-neck press, wide-grip upright row | DB bench with neutral/45° grip; landmine press; low-incline; DB lateral raise instead of upright row |
| Elbow pain (medial/lateral) | Heavy straight-bar curls, skullcrushers, close-grip bench | EZ-bar or DB (neutral) curls; cable pushdowns; overhead cable extension with rope |
| Anterior knee pain | Deep barbell back squat under load, leg extension at end-range | ATG split squat (progressed from a shallow range), Patrick step, reverse lunge, leg press with a controlled range |
| Low back pain on hinge | Conventional deadlift volume, good mornings under load | Trap-bar deadlift, hip thrust, back extension, chest-supported row |
| Wrist pain on press | Fixed pronated grip | Neutral-grip DB, football bar, wrist wraps, reduced range |

**Hard rule:** these are *substitutions for discomfort*, not treatments. Sharp, radiating, or persistent (>2 weeks) pain → clinician. The app must never present a substitution as a fix for an injury.

---

## 7. Lower-body resilience track (Ben Patrick / Knees Over Toes)

`[coach-specific opinion]` throughout. The evidence base for the *specific* KOT protocol is thin (largely n=1 and coaching experience), but its components — eccentric hamstring work, full-ROM knee loading, tibialis training, backward locomotion — each have independent support ranging from strong (Nordic curls for hamstring injury prevention, `[well-established]`) to weak (tibialis raises for knee health, `[uncertain]`).

Sources: [Ben Patrick's Knee Ability series](https://kneesovertoesguy.substack.com/p/atg-knee-ability-series-3-of-10); [Tim Ferriss Show #835 interview](https://tim.blog/2025/11/11/ben-patrick-kneesovertoesguy/); [BarBend — 7 exercises to prevent knee injuries](https://barbend.com/kneesovertoesguy-7-exercises-to-help-prevent-knee-injuries/); [A1 Athlete ATG standards](https://a1athlete.com/atg-standards/).

### 7.1 Progression ladders

Each ladder is a linear chain of slugs; the user advances when they hit the stated standard. These map directly onto `regressions`/`progressions` in the exercise library.

**Knee / split squat ladder**
`bodyweight-split-squat` → `patrick-step` → `poliquin-step-up` → `atg-split-squat` (bodyweight, front foot elevated) → `atg-split-squat` loaded
*Standard to advance to loaded:* full bodyweight ATG split squat, hamstring covering calf, no knee pain. Ben Patrick's published benchmark for the loaded version is **~50% bodyweight for 10 reps** (dumbbells/goblet).

**Tibialis ladder**
`wall-tibialis-raise` (bodyweight, back to wall) → `seated-tibialis-raise` (bench, band) → `tib-bar-raise` (loaded)
*Standard:* **25% bodyweight × 5 sets × 5 reps** on the tib bar.

**Calf / knee-ability ladder**
`seated-calf-raise` → `standing-calf-raise` → `knees-over-toes-calf-raise` (full ROM, knee travelling forward) → `single-leg-calf-raise`

**Hamstring / Nordic ladder**
`45-degree-back-extension` → `nordic-hamstring-curl-assisted` (band or partner, high hands) → `nordic-hamstring-curl-eccentric` (3×5 eccentric only) → `nordic-hamstring-curl` (full concentric)
*Note:* Nordic curls have the strongest evidence base in the whole KOT toolkit — meaningful hamstring-strain risk reduction. `[well-established]`

**Sled ladder**
`sled-drag-backward` (light, 2×50 yd) → progressive load → `sled-push-forward`
Ben Patrick calls backward sled work the "#1 exercise for longevity": knee-friendly (no eccentric loading), builds quad/VMO and conditioning simultaneously. `[coach-specific opinion]`. Benchmark: reverse sled drag at ~50% bodyweight.

**Hip / spine mobility**
`couch-stretch` → `90-90-hip-switch` → `elephant-walk` → `jefferson-curl` (light load, deliberate, never a max effort)

### 7.2 How the KOT track integrates with the hypertrophy program

Default `[coach-specific opinion]`: run KOT work as a **low-fatigue accessory layer**, not as the main program.
- 2–3 sessions/week, 10–20 minutes, either as a warm-up block or on off days.
- Sets counted at **0.5 weight** toward the relevant muscle's weekly volume (they're generally sub-maximal and full-ROM).
- Keep RIR ≥ 2 on all KOT work. It is a resilience input, not a hypertrophy stimulus, and taking Nordics or ATG split squats to failure produces days of soreness for no benefit.

---

## 8. Readiness modulation (Galpin)

This section is the highest-risk part of the app and the most tightly guardrailed.

### 8.1 The governing principle

`[well-established]`, and Galpin's most emphatic point: **a single day's HRV or RHR reading means nothing.** HRV is noisy, highly individual, sensitive to measurement conditions, and only interpretable against your *own* rolling baseline collected under consistent conditions. Galpin's guidance is to collect ~a month of consistent morning readings before using HRV for any decision, then to look at percent deviation from your own norm and at *multi-day* trends — a 3+ day unexplained deviation is a signal; a one-day dip is noise.

Sources: [Huberman Lab guest series with Galpin — Maximize Recovery](https://podcastnotes.org/huberman-lab/guest-series-dr-andy-galpin-maximize-recovery-to-achieve-fitness-performance-goals-huberman-lab/); [Ask Dexa — Galpin on HRV and cardio recovery](https://dexa.ai/s/WIyH_PRb); [Tim Ferriss #716 transcript](https://tim.blog/2024/01/20/andy-galpin-transcript/).

Also `[coach-specific opinion]` from Galpin: **RHR is not sensitive enough** to detect the stress of a single hard session, so it's a poor day-to-day dial. It's useful for detecting illness and for long-horizon fitness trends.

### 8.2 Inputs

```ts
type ReadinessInput = {
  hrvToday?: number;          // ms, RMSSD, morning, consistent conditions
  hrvBaseline?: number;       // 30-60 day rolling mean
  hrvSD?: number;             // rolling SD of the baseline window
  rhrToday?: number;
  rhrBaseline?: number;
  sleepHours?: number;        // last night
  sleepDebt7d?: number;       // hours below the user's own target across 7d
  subjectiveSoreness: 1|2|3|4|5;   // 1 = none, 5 = severe
  subjectiveEnergy: 1|2|3|4|5;     // 1 = wrecked, 5 = great
  sessionPerfLastTime?: "up"|"flat"|"down";
  painFlag: boolean;               // user reported joint//muscle pain
  illnessFlag: boolean;
};
```

**Subjective inputs are first-class, not fallbacks.** `[well-established]` that simple subjective wellness questionnaires track training stress at least as well as HRV in athlete populations. The app must work fully with **zero wearable data** — subjective-only mode is the default, wearables are an enhancement.

### 8.3 Scoring

```ts
// Each sub-score in [-2, +1]. Missing inputs contribute 0 and are excluded from the denominator.
function hrvScore(i: ReadinessInput): number | null {
  if (i.hrvToday == null || i.hrvBaseline == null || i.hrvSD == null) return null;
  if (!hasNDaysOfBaseline(21)) return null;              // GUARDRAIL: no baseline, no signal
  const z = (i.hrvToday - i.hrvBaseline) / Math.max(i.hrvSD, 1);
  const suppressedDays = consecutiveDaysBelow(i.hrvBaseline - i.hrvSD);
  if (z < -1 && suppressedDays >= 3) return -2;          // sustained suppression: real signal
  if (z < -1)                        return -0.5;        // one-off dip: DELIBERATELY damped
  if (z > 1)                         return +1;
  return 0;
}

function sleepScore(i: ReadinessInput): number | null {
  if (i.sleepHours == null) return null;
  if (i.sleepHours < 5)  return -2;
  if (i.sleepHours < 6.5) return -1;
  if (i.sleepHours >= 7 && (i.sleepDebt7d ?? 0) < 3) return +1;
  return 0;
}

function sorenessScore(i: ReadinessInput): number {
  return { 1: +1, 2: 0, 3: 0, 4: -1, 5: -2 }[i.subjectiveSoreness];
}

function readiness(i: ReadinessInput): { band: Band; score: number } {
  const parts = [hrvScore(i), rhrScore(i), sleepScore(i), sorenessScore(i), energyScore(i), perfScore(i)]
                  .filter((v): v is number => v !== null);
  const score = parts.reduce((a, b) => a + b, 0) / parts.length;   // ~[-2, +1]
  if (score <= -1.0) return { band: "poor",  score };
  if (score <  -0.3) return { band: "low",   score };
  if (score <= 0.4)  return { band: "normal", score };
  return { band: "high", score };
}
```

Note the deliberate asymmetry in `hrvScore`: a one-day dip returns **−0.5, not −2**. This is the anti-overreaction guardrail made concrete. A single bad night should not be able to, on its own, push a user out of the `normal` band.

### 8.4 Band → prescribed adjustment

| Band | Volume | Intensity (RIR) | Load | Conditioning | UI copy |
|---|---|---|---|---|---|
| **high** | +0 to +1 set on the *last* exercise only | −0 RIR (as programmed); optional 1 top set at −1 RIR | as programmed | as programmed | "You're primed. Green light on the planned session." |
| **normal** | as programmed | as programmed | as programmed | as programmed | "Normal day. Run the plan." |
| **low** | −1 set per exercise (min 2 sets), cap total cut at −25% | +1 RIR (leave one more in the tank) | −0 to −5% | downgrade a hard interval day to Zone 2 | "Recovery looks a bit down. Trimmed a set and left a rep in the tank." |
| **poor** | −40 to −50% volume, or swap to the deload template | +2 RIR, never below 3 RIR | −10 to −20% | Zone 1–2 only, or rest | "Low readiness. Today's a technique-and-blood-flow day, not a PR day." |

### 8.5 SAFETY GUARDRAILS (normative — these are requirements, not suggestions)

**Implementation contract:** these rules must be implemented as validators that return the existing `Finding` type from [`algorithms/guardrails.ts`](./algorithms/guardrails.ts) — same `{ ok, level: 'info'|'warn'|'block', ... }` shape, same `hasBlock()` semantics. Do **not** invent a parallel training-only guardrail type. The nutrition module already establishes the pattern that the *generator proposes and the guardrail disposes*; training progression follows it exactly: the mesocycle/readiness engine proposes a session, `trainingGuardrails.ts` can downgrade or block it, and a `block` finding means the session is not shown as prescribed.


1. **Bounded per-session change.** Volume adjustment ∈ [−50%, +10%]. RIR adjustment ∈ [−1, +2]. Load adjustment ∈ [−20%, +0%]. The engine may never *increase* prescribed load based on a readiness score.
2. **Bounded consecutive change.** If readiness has driven a reduction on 3 consecutive sessions, the app stops adjusting and instead **prompts a deload or a rest day**, plus a nudge to consider sleep, nutrition, life stress, or illness. Chronic auto-reduction that quietly hides an underlying problem is a failure mode.
3. **No baseline, no HRV-driven decisions.** HRV and RHR contribute 0 to the score until ≥21 days of readings exist under consistent conditions. Show the user "building your baseline — N/21 days."
4. **Never train through pain.** `painFlag === true` → the engine must (a) never increase load or volume, (b) offer a substitution from §6.3 *for discomfort only*, and (c) display: "Pain isn't soreness. If it's sharp, radiating, swelling, or lasts more than a couple of weeks, see a qualified clinician — we can't assess that." No exercise substitution may be framed as a treatment.
5. **Illness handling.** `illnessFlag === true` → no automated programming at all. Show rest guidance and a clinician referral. Do not implement "neck-check" or similar heuristics; that is medical triage and out of scope.
6. **No medical claims, ever.** The app does not diagnose, does not screen, does not detect illness from HRV, and does not use words like "diagnose," "treat," "cure," or "heal." HRV drops are described as "your recovery metrics are below your usual range," never as a health finding.
7. **Physician-first triggers** — surface a clinician referral, suppress readiness-based programming, and do not attempt an explanation, when: RHR is >10 bpm above baseline for ≥3 days; HRV is >2 SD below baseline for ≥7 days; chest pain, dizziness, fainting, or shortness of breath at any intensity; unexplained weight change; any pain present at rest.
8. **User override always wins.** The user can always accept, reject, or edit any suggested adjustment. Log the override — those logs are the best available signal for tuning these thresholds later.
9. **Pregnancy, known cardiac/metabolic conditions, and under-18 users** are out of scope for automated load prescription in v1. Route to a professional.
10. **Show the reasoning.** Every adjustment must display which inputs drove it. Opaque readiness scores erode trust and encourage exactly the kind of single-data-point fixation Galpin warns against.

---

## 9. Conditioning model (Galpin)

### 9.1 Zone definitions

`[well-established]` as a framework; exact boundaries vary by author `[coach-specific opinion]`. Default to **%HRmax**, since it's computable for every user; upgrade to lactate/ventilatory anchoring if the user has tested thresholds.

| Zone | %HRmax | %HRR | Talk test | Primary adaptation | Typical duration |
|---|---|---|---|---|---|
| Z1 recovery | 50–60% | 30–40% | Full conversation, nasal breathing easy | Blood flow, recovery | 20–60 min |
| **Z2 aerobic base** | **60–75%** | 45–60% | Can hold a conversation; slightly effortful | Mitochondrial density, capillarization, fat oxidation, stroke volume | 30–90 min |
| Z3 tempo | 75–82% | 60–70% | Short sentences only | Aerobic threshold, "grey zone" | 20–40 min |
| Z4 threshold | 82–90% | 70–85% | A few words | Lactate threshold, VO2max | 8–30 min work |
| Z5 VO2max/anaerobic | 90–100% | 85–100% | No talking | VO2max, anaerobic power | 30 s – 5 min intervals |

`HRmax` default: **211 − 0.64 × age** (Nes formula, more accurate than 220−age). Show it as an estimate with a ±10 bpm caveat, and let the user overwrite with a field-tested value. `[well-established]`

**Zone 2 is best identified by the talk test, not by the HR number.** `[well-established]` — the ability to hold a conversation while feeling mildly effortful is more robust across individuals than any %HRmax formula.

### 9.2 Weekly conditioning dose

`[coach-specific opinion]` (Galpin, and closely aligned with Huberman/Attia-style protocols):

- **Zone 2: 150–180 min/week**, in 3–4 sessions of 30–60 min. This is the dose Galpin cites as meaningfully improving cardiovascular health without compromising strength and hypertrophy. ([Zone 2 discussion](https://ask.andygalpin.com/c/0ba2c572-3598-11f0-8b35-77721b9b0e69))
- **VO2max work: 1–2 sessions/week**, e.g. 4×4 min at Z5 with 3 min active recovery, or 8–12×30 s all-out with full recovery.
- **Polarized distribution: ~80% of conditioning time in Z1–Z2, ~20% in Z4–Z5.** Minimize Z3. `[well-established]` in endurance-sport literature; `[coach-specific opinion]` as applied to a general fitness population.
- **Modality selection to protect lifting:** prefer low-eccentric modalities (cycling, rowing, sled, incline walking, swimming) over running when leg hypertrophy is the priority. `[well-established]` — eccentric-loading interference is the main mechanism of concurrent-training conflict.

```ts
const CONDITIONING_DEFAULT = {
  zone2MinutesPerWeek: 150,
  zone2Sessions: 3,
  vo2maxSessionsPerWeek: 1,
  vo2maxProtocol: { work: "4min@Z5", rest: "3min@Z1", rounds: 4 },
  minHoursFromHardLifting: 6,
  preferLowEccentricModalities: true,
};
```

### 9.3 Readiness interaction

VO2max sessions are the *first* thing cut when readiness is `low` or `poor` — they carry the highest fatigue cost and the least urgency. Zone 2 is the *last* thing cut; low-intensity aerobic work is generally recovery-positive. `[coach-specific opinion]`

---

## 10. Fueling, hydration, sleep

`[well-established]` unless noted. The app should present these as **defaults and reminders**, never as personalized nutrition prescription.

- **Protein: 1.6–2.2 g/kg/day**, spread over 3–5 feedings of 20–40 g. Returns diminish sharply above ~1.6 g/kg. ([meta-analytic support](https://www.mdpi.com/2072-6643/10/2/180))
- **Energy availability:** hypertrophy in a deficit is possible but slower; if the user is in a deficit, the engine should **cap volume near MAV rather than pushing to MRV**, and expect flatter progression. `[coach-specific opinion]`
- **Carbohydrate around training:** matters most for sessions >60–75 min or high-volume/glycolytic work. 1–4 g/kg pre-session depending on timing. `[well-established]`
- **Hydration:** Galpin's practical heuristic is **~body weight (lb) ÷ 2 = fluid ounces per day** baseline, plus replacement during training; and during exercise, roughly **body weight (lb) ÷ 30 = ounces per 15–20 min**. `[coach-specific opinion]` — a usable rule of thumb, not a physiological law. Add sodium for long or hot sessions.
- **Sleep: 7–9 hours.** Sleep is the single highest-leverage recovery variable; the app should weight `sleepScore` accordingly. Chronic restriction (<6 h) measurably impairs strength expression, glycogen resynthesis, and appetite regulation. `[well-established]`
- **Pre-sleep protein (~30–40 g casein-type, 1–3 h before bed)** modestly supports overnight MPS. `[well-established]`, small effect.

---

## 11. Where the coaches disagree

These are real conflicts. Each one names the app's **default** and why.

### 11.1 Fixed RIR vs. descending RIR across a mesocycle
- **Israetel:** descend 4 → 3 → 2 → 1 across accumulation, because a fixed RIR silently loses effective stimulus as fatigue accumulates.
- **Nippard:** more often uses wave loading or fixed 1–3 RIR with linear load progression.
- **DEFAULT: descending RIR ramp (Israetel).** Rationale: it composes cleanly with the volume ramp (both intensity and volume rise together, deload resets both), it's easier to encode as a rule, and it makes the deload feel earned. Expose `rirRamp` as config so a wave-loading template can override it.

### 11.2 Free weights vs. machines
- **Nippard/Israetel (for hypertrophy):** machines and cables often win on SFR and resistance profile; the top of the chest tier list is a machine press.
- **Cavaliere:** free weights, unilateral loading, and athletic movement patterns; machines lock you into paths your joints didn't choose.
- **DEFAULT: mixed, with the compound-first ordering rule.** Free-weight compound as the session anchor (strength, skill, athletic carryover), machines/cables for the volume tail (SFR, safety near failure). This satisfies both, and it's what both actually program in practice.

### 11.3 Deep knee flexion / "knees over toes"
- **Ben Patrick:** deep, knee-forward loading *builds* knee resilience; avoiding it is what makes knees fragile.
- **Conventional/Cavaliere-adjacent view:** deep knee flexion under load raises patellofemoral compressive forces and should be progressed cautiously in symptomatic people.
- **DEFAULT: Patrick's direction, Cavaliere's pacing.** Full-ROM knee training is a goal, reached via the §7.1 ladder starting from a range the user owns pain-free. Never prescribe a loaded ATG split squat to someone who cannot do the bodyweight version cleanly. This is genuinely `[uncertain]` territory — hold the position loosely and default conservative.

### 11.4 Training to failure
- **Israetel:** 0–1 RIR only in the final week(s); failure is expensive and mostly unnecessary.
- **Nippard:** last set of an isolation exercise to failure is fine and probably useful.
- **Cavaliere:** effort is the point; but not on compounds where technique breaks down.
- **DEFAULT: failure permitted on isolation and machine work only, and only in the final 1–2 weeks of a mesocycle.** Never on barbell compounds without a spotter or safeties. Never when `readiness.band` is `low` or `poor`.

### 11.5 High volume vs. high effort
- **Israetel:** volume is the primary driver; push toward MRV.
- **Nippard (more recent):** the volume-response curve flattens sooner than the RP model implies; many people over-prescribe.
- **DEFAULT: start conservative — MEV values as published, and don't ramp to MRV, ramp to ~95% of it.** Bias the *estimated* landmarks downward for beginners (§2.2). Over-prescribing volume is the more common and more costly error.

### 11.6 Cardio's effect on hypertrophy
- **Israetel:** manage it; cardio eats into recovery capacity and should be counted against MRV.
- **Galpin:** the interference effect is over-stated at typical doses and modality/timing choices largely solve it.
- **DEFAULT: Galpin's dose, Israetel's accounting.** Program 150–180 min Zone 2 as standard, but when weekly Z4/Z5 conditioning exceeds ~60 min, reduce lower-body MRV estimates by ~10%.

### 11.7 Tibialis raises and knee health
- **Ben Patrick:** foundational; tibialis strength protects the knee.
- **Everyone else:** largely silent, or unconvinced.
- **DEFAULT: include, at low dose.** `[uncertain]`. It is cheap (3 min, near-zero systemic fatigue), plausibly useful for ankle dorsiflexion and shin-splint resistance, and low-risk. Include it — but do not claim it prevents knee injury.

---

## 12. Open questions / known gaps

1. **Landmark personalization.** The seed table is a population prior. We need a principled update rule from logged soreness/performance data — currently a hand-tuned ±3 sets/block drift cap (§3.4). This is the biggest modelling gap.
2. **Indirect volume weighting** (0.5) is a guess. It materially changes arm and rear-delt programming. Worth an A/B.
3. **Adductors, abductors, obliques, neck, hip_flexors, tibialis** landmarks are extrapolated, not published. Flag them as low-confidence in the UI.
4. **Female-specific programming.** Menstrual-cycle-phase periodization has weak and conflicting evidence; v1 deliberately does nothing with it rather than doing something wrong.
5. **Older adults (>60)** need longer inter-session recovery and more warm-up; the current model doesn't age-adjust MRV.
6. **HRV device heterogeneity.** RMSSD from a chest strap, a ring, and a wrist optical sensor are not interchangeable. Baselines must be per-device, and switching devices must reset the baseline.
7. **RPE/RIR accuracy in novices** is poor — they systematically overestimate RIR. Consider weighting velocity or rep-decay data over self-reported RIR for beginners.

---

## 13. Source index

- Renaissance Periodization — [Training Volume Landmarks for Muscle Growth](https://rpstrength.com/blogs/articles/training-volume-landmarks-muscle-growth), [Progressing for Hypertrophy](https://rpstrength.com/expert-advice/progressing-for-hypertrophy), [In Defense of Set Increases Within the Hypertrophy Mesocycle](https://rpstrength.com/blogs/articles/in-defense-of-set-increases-within-the-hypertrophy-mesocycle), [Complete Hypertrophy Training Guide](https://rpstrength.com/blogs/articles/complete-hypertrophy-training-guide), [Side Delt Hypertrophy](https://rpstrength.com/blogs/articles/side-delt-hypertrophy-training-tips), [Rear Delt Training Guide](https://rpstrength.com/blogs/articles/rear-delt-hypertrophy-training-tips), [RP Hypertrophy App knowledge base](https://hypertrophy.zendesk.com/hc/en-us/articles/18980934222231-Side-Delts)
- Mike Israetel — [Static vs. Dropping RIR Through a Mesocycle](https://www.youtube.com/watch?v=7xVvEsUUDmo), [RP compilation](https://rpstrength.com/blogs/articles/dr-mike-israetel-compilation)
- Jeff Nippard — [Chest exercise tier list (BarBend)](https://barbend.com/news/jeff-nippard-ranks-chest-exercises-for-hypertrophy/), [Fitness Volt coverage](https://fitnessvolt.com/jeff-nippard-best-and-worst-chest-exercises/), [Ultimate Push Pull Legs System](https://jeffnippard.com/products/the-ultimate-push-pull-legs-system), [Upper/Lower program overview](https://www.studocu.com/row/document/sveuciliste-u-rijeci/tjelesna-i-zdravstvena-kultura/jeff-nippards-upper-lower-strength-and-size-program/17980896)
- Jeff Cavaliere — [Do Face Pulls After Every Workout](https://learn.athleanx.com/articles/shoulders-for-men/do-face-pulls-after-every-workout), [How To Do Face Pulls](https://learn.athleanx.com/articles/shoulders-for-men/stop-doing-face-pulls-like-this), [Science-backed shoulder workout](https://fitnessvolt.com/jeff-cavaliere-shares-shoulder-workout/), [12 exercises that should be in every program](https://boxlifemagazine.com/twelve-essential-exercises-pain-free-variations/)
- Andy Galpin — [Huberman Lab recovery guest series notes](https://podcastnotes.org/huberman-lab/guest-series-dr-andy-galpin-maximize-recovery-to-achieve-fitness-performance-goals-huberman-lab/), [Tim Ferriss #716 transcript](https://tim.blog/2024/01/20/andy-galpin-transcript/), [Galpin on HRV & recovery](https://dexa.ai/s/WIyH_PRb), [Zone 2 benefits](https://ask.andygalpin.com/c/0ba2c572-3598-11f0-8b35-77721b9b0e69), [Heart health, VO2max & sleep](https://www.getrecall.ai/summary/chris-williamson/the-new-science-of-heart-health-vo2-max-and-optimal-sleep-dr-andy-galpin)
- Ben Patrick — [Knee Ability Series](https://kneesovertoesguy.substack.com/p/atg-knee-ability-series-3-of-10), [Tim Ferriss #835](https://tim.blog/2025/11/11/ben-patrick-kneesovertoesguy/), [BarBend — 7 knee injury prevention exercises](https://barbend.com/kneesovertoesguy-7-exercises-to-help-prevent-knee-injuries/), [ATG standards](https://a1athlete.com/atg-standards/), [Full ATG exercise list](https://a1athlete.com/knees-over-toes-guy-exercises/)
- Supporting literature — [Higher training frequency for strength (PMC6036131)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6036131/), [Protein for hypertrophy (Nutrients 2018)](https://www.mdpi.com/2072-6643/10/2/180), [Pre-sleep protein](https://jn.nutrition.org/article/S0022-3166(22)08742-9/fulltext)

---

*Legal/product note: this document describes a fitness-planning heuristic engine for healthy adults. It is not medical advice, it does not diagnose or treat any condition, and every surface built on it must say so.*
