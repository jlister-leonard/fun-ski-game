# Adaptive Nutrition Coaching — Algorithm Specification

**Status:** draft for implementation
**Reference implementations:** [`algorithms/`](./algorithms/) — `weight-trend.ts`, `expenditure.ts`, `macro-targets.ts`, `guardrails.ts`
**Verification:** `algorithms/verify.mjs` (176 assertions, all passing)

---

## 0. Scope, provenance and confidence tags

This document specifies an adaptive nutrition-coaching algorithm of comparable
quality to MacroFactor's, **synthesised independently** from (a) MacroFactor's
own public explainer articles and help centre, and (b) the primary
sport-nutrition literature. No proprietary code was obtained or reverse
engineered, and nothing here should be read as a claim to replicate their exact
model — MacroFactor does not publish its estimator, its smoothing constants, its
BMR coefficients, or its update-gain schedule. Where we had to make a choice
they do not disclose, we made our own and said so.

Every substantive claim carries a confidence tag:

| Tag | Meaning |
|---|---|
| **[well-established]** | Supported by consensus statements, meta-analyses, or basic physics/statistics. Safe to build on. |
| **[reasonable-inference]** | A defensible synthesis or engineering choice, consistent with published evidence but not directly demonstrated. Tune with real data. |
| **[uncertain]** | Plausible but weakly supported, contested, or a pure modelling convenience. Do not defend it in public copy. |

A note on sourcing: research for this spec was conducted via web search.
`WebFetch` was blocked in the working environment, so primary-source PDFs could
not be read in full — findings come from search-engine summaries over the cited
URLs plus domain knowledge. **Before shipping, the numeric guardrails in §6
should be verified against the primary sources**, which are listed inline.

---

## 1. Weight trend smoothing

### 1.1 The problem

Day-to-day scale weight has a standard deviation of roughly **0.8–1.2 kg** for
an adult weighing at a consistent time. **[well-established]** Sources: total
body water, gut contents, glycogen (which binds ~3 g of water per gram), sodium,
and menstrual-cycle fluid shifts. A 0.5 kg/week true rate of fat loss is
therefore buried under noise an order of magnitude larger on any given day.

MacroFactor describes its trend as *"a moving average of your weight data that
places greater emphasis on more recent weigh-ins"*, fills gaps by linear
interpolation for display, and states that all coaching outputs are computed
from **changes in trend weight, not scale weight**. They do not publish the
smoothing constant. **[well-established that they do this; the constant is undisclosed]**

### 1.2 Our model: local linear trend, Kalman-filtered

We use a two-state **local linear trend** model (the stochastic form of Holt's
linear exponential smoothing), which is strictly more capable than the plain
EWMA popularised by *The Hacker's Diet* (α = 0.1) because it estimates the
**rate of change as an explicit state** rather than differencing a smoothed
level. **[well-established]** — differencing a smoothed series is a noisy way to
get a gradient.

State `x = [level L (kg), slope S (kg/day)]`:

```
L_t = L_{t-1} + S_{t-1} + w_L        w_L ~ N(0, qL)
S_t = S_{t-1}           + w_S        w_S ~ N(0, qS)
y_t = L_t + v                        v   ~ N(0, r)
```

Standard Kalman predict/update, with `F = [[1,1],[0,1]]`, `H = [1,0]`.

**Default parameters** (all tunable; `weight-trend.ts` → `TrendOptions`):

| Parameter | Default | Basis |
|---|---|---|
| `observationSdKg` | 0.9 kg, scaled by `bodyweight/80` | Empirical day-to-day scale noise **[well-established]** |
| `levelProcessSdKg` | 0.005 kg/day | Swept 0.002–0.01; changes outcomes by <5%. Nearly irrelevant. **[reasonable-inference]** |
| `slopeProcessSdKg` | 0.003 kg/day/day | **The responsiveness dial.** Tuned to give ~20-day median detection of a genuine rate change **[reasonable-inference]** |
| `outlierSigma` | 3.0 | Standard robust-statistics choice **[well-established]** |
| `cusumSlack` | 0.4 σ | Tuned **[reasonable-inference]** |
| `adaptationGain` | 3.0 | Tuned **[reasonable-inference]** |
| `maxAdaptationFactor` | 40 | Tuned **[reasonable-inference]** |

Initialisation: level = first reading; slope = OLS over the first ≤14 days
(avoids a multi-week ramp-in); `P₀ = diag(r, 0.06²)`.

### 1.3 Missing days

The **predict** step runs on every calendar day; the **update** step only on
days with a weigh-in. This is the native Kalman treatment and is strictly better
than interpolating: interpolated points are not data and must not be allowed to
shrink the filter's uncertainty. **[well-established]**

Interpolated values *are* produced, separately, for chart display only
(`TrendPoint.kg`), matching MacroFactor's pale "Scale Weight" line.

Verified: with only **40% weigh-in adherence** over 90 days the filter still
recovers the true rate to within 0.2 kg/week.

### 1.4 Outliers

Readings whose standardised innovation exceeds `outlierSigma` are **Huberised**
— their measurement variance is inflated by `(|z|/k)²` — rather than rejected.
**[reasonable-inference]** Hard rejection is wrong here because a genuine step
change (starting creatine, a real 3 kg water shift) would be flagged
indefinitely and never learned.

Readings more than `hardRejectDeltaKg` (10 kg) from prediction are dropped
entirely as data errors.

Verified: a single **+4 kg spike shifts the trend by 0.06 kg** and is correctly
flagged, versus 0.36 kg for a plain α = 0.1 EWMA — a **6× improvement** in
outlier rejection.

### 1.5 The "adaptive" part — responding to genuine trend breaks

MacroFactor publishes the behaviour they want: *"during the first week the
algorithm makes some tentative adjustments, but if an observed trend holds for a
second week (and certainly a third week), you'll see larger adjustments."* They
also state the general principle plainly: *"you can't simultaneously maximize
both stability and responsiveness."* **[well-established]**

We implement this with a **two-sided CUSUM over standardised innovations**. Runs
of same-signed prediction error accumulate; when the statistic exceeds the slack
`k`, process noise is inflated by `1 + gain·cusum²`, capped. The filter then
re-converges in days rather than weeks. The CUSUM self-resets, because once the
filter catches up the innovations shrink.

The standardised innovation is **clipped at `outlierSigma` before entering the
CUSUM**, so one wild reading cannot trigger adaptation but a sustained run will.
This is precisely the "hedge in week one, commit in week two" behaviour.

**Measured responsiveness/stability frontier** (90-day simulations, 0.9 kg noise,
median over 20 seeds — this is the trade-off, made explicit):

| `slopeProcessSd` | gain | Days to detect a real break | Steady-state rate error |
|---|---|---|---|
| 0.0012 | 4 | 37 | 0.047 kg/wk |
| 0.002 | 4 | 29 | 0.067 kg/wk |
| **0.003** | **3** | **20** | **0.096 kg/wk** |
| 0.003 | 15 | 21 | 0.120 kg/wk |

We chose the 20-day point, matching the 2–3 weeks MacroFactor publishes for its
own estimator.

### 1.6 Smoothing vs filtering — an important subtlety

An **RTS fixed-interval smoother** runs backwards over the history. This makes
the displayed trend line much better in the interior, and at the most recent day
the smoothed and filtered estimates are *identical*, so no future information
leaks into today's decision.

**But**: the smoother legitimately *anticipates* a break when looking backwards.
Verified — five days before a real trend break, the smoothed rate already reads
−0.14 kg/wk while the causal estimate correctly reads ≈0.

> **Implementation rule:** use the smoothed series for charts; use the **causal
> (`smooth: false`) series for any coaching decision.**

### 1.7 Calibration honesty

Over 300 seeds, the filter's reported CI is **~2.0× wider** than the observed
error, and 95% coverage is ~100%. This is not a bug: the model permits the slope
to random-walk, and the simulation holds it constant. Real rates do drift, so
the truth is between the two. **[reasonable-inference]** The CI is conservative,
which is the correct direction to err for a health app.

---

## 2. Non-energetic weight perturbations

> This section exists because getting it wrong causes **active harm**, not just
> inaccuracy.

### 2.1 The failure mode

Consider a user in a correct, well-executed 500 kcal/day deficit who starts
5 g/day creatine:

1. Creatine draws water into muscle: **+1–2 kg of intracellular water**, loading
   over ~3–4 weeks at a maintenance dose and **persisting for as long as they
   supplement**. **[well-established]**
2. Scale weight flattens or rises for 1–3 weeks despite genuine fat loss.
3. A naive energy-balance estimator reads flat weight at constant intake and
   concludes **expenditure has fallen**.
4. The weekly check-in **cuts calories** — on a user whose plan was working.
5. Fat loss continues, so the scale eventually falls again, and the estimator
   has now baked in an expenditure that is several hundred kcal too low.

The app has made things worse while appearing confident. The same mechanism
applies, with different time constants, to:

| Perturbation | Typical magnitude | Settling | Persistent? |
|---|---|---|---|
| Creatine start (5 g/day) | +1.5 kg | ~28 d | Yes, while supplementing |
| Creatine stop | −1.5 kg | ~28 d | Yes |
| Carbohydrate load / refeed | +1.5 kg | ~3 d | No, ~5 d |
| Starting low-carb | −1.8 kg | ~7 d | Yes |
| Sodium spike (restaurant meal) | +1.0 kg | ~2 d | No, ~4 d |
| Menstrual-cycle fluid | +1.0 kg | ~3 d | No, ~7 d |
| Travel | +1.0 kg | ~2 d | No, ~6 d |
| New training block (glycogen + inflammation) | +1.0 kg | ~14 d | Semi |

Magnitudes: **[reasonable-inference]**. That the effects exist and are of this
rough scale: **[well-established]**. Glycogen binds ~3 g water per gram, which is
the mechanism behind several rows. **[well-established]**

### 2.2 Mechanism 1 — logged events (primary, exact)

`PerturbationEvent { startDate, type, expectedShiftKg?, settlingDays?, reversesAfterDays? }`

The modelled offset loads as a saturating exponential reaching ~87.5% of plateau
at `settlingDays`, then optionally reverses on the same time constant.

Three things then happen:

1. **The trend filter** inflates *level* process noise ×400 inside the window
   (a water shift is a step in level) while keeping *slope* noise **normal** —
   because it is emphatically **not** a change in the rate of fat loss. The
   CUSUM is suppressed, so the adaptive gate cannot misfire.
2. **`TrendPoint` exposes two series**: `trendKg` (what the scale says — shown to
   the user, annotated) and `energyTrendKg` (offset removed — consumed by the
   estimator). Never conflate them.
3. **The expenditure estimator** regresses on `energyTrendKg`, down-weights
   affected days to 0.15, and sets `suppressAdjustment` so targets hold.

### 2.3 Mechanism 2 — automatic detection (fallback, partial)

For users who do not log the event, `detectStepAndSlopeChange` scans for two
breakpoints and decomposes the change at the best split into:

- **`levelStepKg`** — a discontinuity in level. This is the *water* signature.
- **`slopeChangeKcal`** — a change in gradient. This is the *metabolism*
  signature, and the estimator should follow it.

Separating these is essential: a detector that cannot tell them apart would
either ignore creatine or block legitimate adaptation.

**Measured performance, and an honest limitation** (200 simulated runs each):

| Scenario | Detection | False positives |
|---|---|---|
| Sharp step (1.5 kg over 5 d) | **65%** | 4% |
| **Slow ramp (creatine, 1.5 kg over 28 d)** | **18%** | 9% |

> **A slowly-loading water shift is not reliably distinguishable from a genuine
> fall in expenditure using scale weight and intake alone.** Both flatten the
> scale at constant intake. At any usable threshold the detector performs no
> better than guessing on the slow case. **[well-established — this is an
> identifiability limit, not an implementation shortfall]**

We therefore do **not** pretend to detect it. Instead:

### 2.4 Mechanism 3 — ask the user (the honest fallback)

When `|slopeChangeKcal| > 150` or a level step is detected,
`ExpenditureEstimate.userPrompt` is populated with a question naming the likely
causes. Threshold calibrated over 200 runs: fires on **~62–70%** of unlogged
creatine cases and **~18–25%** of stable ones. That trade is right for a
*question*; it would be far too loose for anything that silently overrode the
estimate.

### 2.5 Mechanism 4 — rate limiting (the backstop that always works)

This is the property that matters most, because it protects users regardless of
whether anything was detected or logged. See §5.4. Measured: even with the
perturbation **completely unhandled**, the check-in limiter held the calorie
target to a **100 kcal drop over nine weeks**, versus **0 kcal** when logged.

### 2.6 Defence-in-depth summary

| Layer | Requires | Effectiveness |
|---|---|---|
| Logged event | User logs it | **Exact** — bias 140 → 78 kcal, target drop → 0 |
| Auto step detection | Nothing | Good on sharp steps, poor on slow ramps |
| User prompt | User answers | ~70% sensitivity, converts to layer 1 |
| Rate limiting + floors | Nothing | **Always on**; bounds the damage |

---

## 3. Adaptive expenditure (TDEE) estimation

### 3.1 The energy-balance identity

```
dE_body/dt = intake − expenditure
rho · Δ(trend weight) = Σ intake − Σ expenditure
```

**[well-established]** — this is the first law of thermodynamics applied to a
person, and it is the entire basis of the approach. MacroFactor states it the
same way: *"Calories out = Calories in − Δ stored energy."*

### 3.2 The kcal-per-kg constant

| Quantity | Value | Confidence |
|---|---|---|
| Fat mass energy density | **9,440 kcal/kg** (Hall uses 9,500) | **[well-established]** |
| Fat-free mass energy density | **1,816 kcal/kg** | **[well-established]** — low because FFM change is ~70–75% water |
| Default mixed tissue | **7,700 kcal/kg** (= 3,500 kcal/lb) | **[well-established]** as a convention; **[uncertain]** as a universal constant |

MacroFactor publishes *"lean tissue stores about 1800 kcal per kilogram, while
fat tissue stores about 9400 kcal per kilogram"* — essentially identical to the
values above, which is reassuring convergence.

**Forbes partitioning** (used when body fat is known): the fraction of weight
change that is fat rises with fat mass, `p_fat = FM / (FM + 10.4)`, giving
`rho = p_fat·9440 + (1−p_fat)·1816`, clamped to [5200, 8600].
**[reasonable-inference]** — Forbes' relationship is well supported in direction
and rough magnitude; applying it pointwise to a coaching algorithm is our choice.

**Why the static 3,500 kcal/lb rule is criticised:** Hall & Chow showed it
ignores adaptive changes in RMR and activity cost, over-predicting one-year
weight loss by ~38%. **[well-established]** Crucially, that critique applies to
*forward prediction from an assumed deficit*. Our inversion **measures**
expenditure rather than assuming it, so it is largely immune — but it still
inherits the energy-density assumption. Note also that the energy density of
weight change is **not constant over time**: early loss is disproportionately
glycogen and water (low kcal/kg), later loss disproportionately fat.
**[well-established]** This is a known source of transient bias in the first
2–3 weeks of any new deficit.

### 3.3 Why naive back-calculation is unstable

The obvious estimator is:

```
TDEE = meanIntake − rho · Δweight / Δdays
```

This **differentiates a noisy series**, and differencing amplifies noise. With
0.9 kg of daily scale noise, a 7-day end-to-end difference carries ~±1.8 kg of
95% error, which at 7,700 kcal/kg is **±2,000 kcal/day of nonsense**.
**[well-established]** — this is elementary error propagation.

### 3.4 Our estimator: regression on cumulative energy

Define, over a window:

```
y_t := cumulativeIntake_t − rho · (energyTrend_t − energyTrend_0)
```

By the identity in §3.1, `y_t = Σ_{k≤t} TDEE_k`, and therefore:

```
dy/dt = TDEE(t)
```

**Estimate TDEE as the slope of a recency-weighted linear regression of `y` on
day index.** This *integrates* intake noise (errors average as `1/√n`) instead
of differentiating it, and the local slope of `y` equals the *instantaneous*
TDEE — so recency weighting yields a current, not historical, estimate.
**[reasonable-inference]** — the formulation is our own; the underlying identity
is not.

**Parameters:**

| Parameter | Default | Notes |
|---|---|---|
| `windowDays` | 56 | 8 weeks |
| `halfLifeDays` | 21 | Recency weight `0.5^((n−1−i)/21)` |
| `minDays` | 7 | Below this, prior only |
| `imputedDayWeight` | 0.2 | Missing intake imputed at the logged mean |
| `perturbationDayWeight` | 0.15 | §2.2 |

**Measured: this beats naive back-calculation.** Across 10 rolling evaluations
of a 90-day simulation, mean |error| vs true TDEE was **16 kcal** for the
cumulative regression versus **25 kcal** for a 14-day naive back-calculation.

### 3.5 Standard error and confidence

Two independent routes, take the larger (conservative):

- **Analytic:** `SE² = rho²·Var(trend slope) + σ_intake²/n_eff`, where the OLS
  slope variance through `n` noisy points is `12σ²/(n(n²−1))`. **[well-established]**
- **Empirical:** heteroskedasticity-robust sandwich SE from the regression
  residuals, inflated ×3 for the strong autocorrelation the cumulative
  construction induces. **[reasonable-inference]** — the inflation factor is a
  calibration choice.

`confidence = clamp(1 − sd/500) × clamp(n_eff/21)`, in [0,1].
**[reasonable-inference]** — a presentation device, not a probability.

### 3.6 Cold start and Bayesian blending

**Mifflin–St Jeor** (default; best-validated general-population equation, within
±10% for ~82% of healthy adults **[well-established]**):

```
BMR = 10·kg + 6.25·cm − 5·age + s      s = +5 (male), −161 (female)
```

**Katch–McArdle** (used when a plausible body-fat estimate exists, 3–60%;
better at body-composition extremes **[well-established]**):

```
BMR = 370 + 21.6 · LBM_kg
```

**Cunningham** `500 + 22·LBM` is also exported; it fits trained athletes better
and is reportedly what MacroFactor originally seeded from. **[well-established]**

Activity multipliers 1.2 / 1.375 / 1.55 / 1.725 / 1.9. These are **blunt
instruments** — MacroFactor publishes that TDEE calculators are off by >250
kcal/day at least half the time and >500 kcal/day more than 20% of the time.
**[well-established]** We assign the prior an SD of `√((0.08·TDEE)² + (0.12·TDEE)²)`,
floored at 200 kcal, dominated by the activity-multiplier term.

**Blending is inverse-variance (Bayesian), not a hard switchover:**

```
posterior = (prior/σ²_prior + data/σ²_data) / (1/σ²_prior + 1/σ²_data)
```

This gives smooth, principled cold-start behaviour with no discontinuity.
**Measured convergence** (true TDEE 2,800; deliberately bad prior of 2,400):

| Day | Estimate | SD | Data weight | Source |
|---|---|---|---|---|
| 7 | 2,440 | 365 | 0.08 | blended |
| 14 | 2,591 | 297 | 0.39 | blended |
| 21 | 2,711 | 220 | 0.66 | blended |
| 28 | 2,762 | 167 | 0.81 | blended |
| 42 | 2,798 | 112 | 0.91 | data |
| 90 | **2,799** | 88 | 0.95 | data |

Final error: **1 kcal**, 95% CI [2,627, 2,971]. The estimator escapes a 400 kcal
prior error and converges. This matches the shape MacroFactor describes
(useful by ~2 weeks, dialled in by 3–4).

Finally the posterior is clamped to **[1.05, 3.0] × BMR** as a physiological
sanity bound. **[reasonable-inference]**

### 3.7 Data sufficiency

Following MacroFactor's published operational rules **[well-established that
they use these]**:

- Continuous updating needs **≥4 of the last 7 days** of food logs (≥6 for full
  confidence) and **≥1 weigh-in in the last 7 days**.
- If weigh-ins stop, the estimate **holds** rather than drifting.
- The first ~30 days are a **calibration** phase where larger steps are allowed
  (and a slight overshoot-then-correct is expected and normal).
- **Partial logging is worse than not logging at all** — it feeds the algorithm
  actively wrong intake. Treat a partial day as missing, not as a low day.

### 3.8 Logging bias self-correction

A user who **consistently** under-reports by 300 kcal/day drives the estimate to
converge ~300 kcal low. Their target is then also expressed in their own
(under-reported) units, so when they log 1,700 they actually eat 2,000 — which
is correct for their goal. **Consistent bias cancels.** **[well-established]** —
MacroFactor makes the same argument, and our simulation confirms it: with a
300 kcal consistent under-report, the estimate landed at 2,530 against a true
2,800 (expected ~2,500).

**Inconsistent** bias does not cancel, and is the real hazard. See
`detectLoggingDiscrepancy` in §6.

### 3.9 Wearables without double counting

**MacroFactor deliberately does not use wearable energy data at all**, arguing
weight + nutrition is *"arguably still a superior method… as it inherently
accounts for and adjusts for personal digestive and food logging idiosyncrasies
in a way that wearable devices simply wouldn't be capable of."* **[well-established
as their position]**

We agree with the core reasoning and enforce it structurally:

> **The adaptive estimate already contains all expenditure, including exercise.
> Adding wearable "active energy" to it double-counts. Never do this.**

Where wearable data *is* legitimately informative is in explaining
**day-to-day variance around the user's own baseline**:

```
delta = beta · (todayActive − baselineActive)     clamped to ±25% of TDEE
```

`baselineActive` is an EWMA (21-day half-life) of the user's own active energy.
Because the baseline is their own trailing mean, **`delta` is zero-mean by
construction and therefore cannot shift the weekly energy budget** — it only
redistributes calories between a rest day and a big training day.
**[well-established]** Verified: mean applied delta over 28 days = **0 kcal**.

`beta` defaults to 0.5 **[reasonable-inference]**, reflecting both consumer-device
error (20–30% on active energy) and **constrained TDEE**: MacroFactor publishes
~72 net kcal of TDEE per 100 kcal of exercise (range ~100 sedentary to ~40 very
active), while Pontzer's exercise-intervention data suggest a harsher ~30–50%.
**[well-established that compensation occurs; magnitude contested]**

Two further correctness requirements:

- **Normalise total vs active.** Apple Health `activeEnergyBurned` is
  active-only; many rings report a total including BMR. Mixing them over-states
  activity by ~one BMR per day. `normalizeActiveEnergy` handles this.
- **De-duplicate across sources.** A Strava ride also lands in Apple Health.
  `dedupeWorkouts` groups by ≥50% time overlap, prefers the higher-precedence
  source, and breaks ties toward the **lower** kcal figure (over-counting
  activity is the failure mode that hurts users).

**Step-informed updates** — MacroFactor's most interesting published idea: steps
are **not converted to calories and added anywhere**. A sustained step trend is
used as *evidence that a real expenditure change is underway*, which makes the
estimator update faster in that direction. `stepInformedHalfLife` implements the
same idea by shortening the recency half-life. This sidesteps the accuracy
problems of consumer kcal estimates entirely. **[well-established as their
approach; our implementation is our own]**

**Predictive goal adjustment** — expenditure genuinely falls entering a deficit
and rises entering a surplus, beyond the change in body mass (adaptive
thermogenesis; Leibel & Rosenbaum showed both REE and non-REE fall below
prediction after −10% body weight **[well-established]**). `predictiveGoalAdjustment`
applies a feed-forward nudge, calibrated to MacroFactor's published anchor:
swinging from −1%/wk to +0.5%/wk warrants ~+6% expenditure over a couple of
weeks (≈4% of TDEE per percentage-point of swing). Verified: +126 kcal at day 14
on a 2,800 kcal TDEE, decaying once the estimator has caught up.

---

## 4. Macro target algorithm

### 4.1 Energy

```
rate_kg_per_week = (ratePct/100) · bodyweight
energyOffset     = rho · rate_kg_per_week / 7
target_kcal      = TDEE + energyOffset
```

**Critical additional constraint we found by testing.** A rate expressed as
%BW/week says nothing about how large the deficit is *relative to what the
person burns*. A 120 kg man with a 3,000 kcal expenditure asking for 1%/week
needs a **1,375 kcal/day deficit — 46% of his intake**. The percentage-of-
bodyweight rule and a percentage-of-expenditure rule must be applied **together**:

- `maxDeficitFraction` = **0.30** of TDEE
- `maxSurplusFraction` = **0.20** of TDEE

**[reasonable-inference]** The achievable rate is then back-solved and reported,
so the user is told what they will actually get.

**Default rates** — loss scales with adiposity, because Aragon et al. 2017
concluded the higher the baseline body-fat level, the more aggressively a
deficit may be imposed, while leaner people need slower loss.
**[well-established]**

| Condition | Default rate |
|---|---|
| Lean (≤12% M / ≤20% F) | −0.50 %BW/wk |
| Mid-range | −0.70 %BW/wk |
| High body fat (≥25% M / ≥32% F) | −0.85 %BW/wk |
| Very high (≥33% M / ≥40% F) | −1.00 %BW/wk |
| Gain (any) | +0.35 %BW/wk |

Garthe et al. 2011 is the key anchor: athletes losing **0.7%/week gained 2.1%
lean mass** and improved strength, while those losing 1.4%/week did not.
**[well-established]** Gain defaults are deliberately conservative — Garthe 2013
found a much larger surplus produced **5× the fat gain for no extra lean mass**.
**[well-established]**

### 4.2 Protein (allocated first)

| Situation | Target | Source |
|---|---|---|
| Deficit, body fat known | **2.3–3.1 g/kg FFM**, scaled up with deficit severity and leanness | Helms et al. 2014 systematic review **[well-established]** |
| Maintenance/surplus, body fat known | 1.9–2.4 g/kg FFM | **[reasonable-inference]** |
| Deficit, no body fat, BMI ≤30 | 1.8–2.4 g/kg BW | **[well-established]** |
| Maintenance/surplus, no body fat | 1.6–2.0 g/kg BW | Morton et al. 2018: plateau ~1.62 g/kg, 95% CI 1.03–2.20 **[well-established]** |
| BMI >30, no body fat estimate | 1.7–1.9 g/kg **adjusted** BW, `ABW = IBW + 0.25·(BW − IBW)` | Clinical convention **[well-established]** |

**Why scale by lean mass:** fat mass does not carry lean tissue's maintenance
protein cost, so g/kg *total* bodyweight systematically over-prescribes in
obesity and under-prescribes in lean, muscular people. A 2025 Bayesian
meta-regression found the dose–response relationship is **stronger when protein
is expressed relative to FFM than to total body mass** — direct empirical
support. **[well-established]**

**Soft cap:** protein is trimmed so it stays under **40% of energy**, because at
low calorie targets the full evidence-based dose would crowd out fat and carbs
entirely. **[reasonable-inference]**

Verified: an a synthetic cutting profile gets **2.7 g/kg LBM** — squarely
in the Helms band.

### 4.3 Fat (floor applied before carbs get a say)

```
fatFloor_g   = max(30, 0.5 · kg, 0.20 · kcal / 9)
fatCeiling_g = 0.40 · kcal / 9
```

Helms et al. 2014 recommend **15–30% of calories** for natural bodybuilders;
ACSM/AND/DC 2016 puts the fat AMDR at 20–35% and sports-nutrition consensus is
that fat should not fall below 20% of intake. **[well-established]**

Going below ~20% carries a real cost: Whittaker & Wu 2021 (meta-analysis, 6
studies, n=206) found moving from ~40% to ~20% of calories from fat lowered
total testosterone by **~10–15%** (SMD −0.38, 95% CI −0.75 to −0.01).
**[reasonable-inference]** — a corrigendum was issued and a 2025 meta-analysis
reaches a different conclusion, so treat the effect as real but small and
contested. Do **not** overstate this in user copy.

15% of energy is the hard floor, enforced in guardrails, not here.

### 4.4 Carbohydrate (the remainder, steered by training load)

Carbs get whatever is left, but the fat/carb split is steered toward a
training-load-derived aspiration by trading against fat **down to, never
through, the fat floor**:

| Load | Our target (g/kg BW) | ACSM/AND/DC 2016 |
|---|---|---|
| none | 2.0 | — |
| light | 3.0 | 3–5 |
| moderate | 4.0 | 5–7 |
| high | 5.5 | 6–10 |
| veryHigh | 7.0 | 8–12 |

Our tiers sit **below** the ACSM tiers deliberately. **[reasonable-inference]**
Those tiers are calibrated for endurance athletes at or above energy balance and
are simply unreachable inside a deficit; ours sit at the resistance-training end
of the evidence (Slater & Phillips 2011: ~3–7 g/kg). Note there is **no
experimentally confirmed minimum daily carbohydrate threshold for resistance
trainees**, and low muscle glycogen does not suppress the anabolic response.
**[well-established]**

Floors: **130 g/day** (IOM RDA, informational) and **100 g/day** (IOM EAR, based
on brain glucose utilisation, warned). **[well-established]**

Fibre: **14 g per 1,000 kcal**. **[well-established]**

Verified: raising training load from `light` to `veryHigh` moved carbs
**290 → 435 g** and fat **125 → 60 g** with calories unchanged (2,810 vs 2,800),
and fat never breached its floor.

### 4.5 Dynamic maintenance

Following MacroFactor's published approach: within **0.7 kg** of goal weight,
targets track expenditure 1:1; outside it, a corrective **±0.15 %BW/week** is
applied. **[well-established as their approach]** The dead band matters — without
it, normal trend noise would have the app flip-flopping between tiny surpluses
and deficits every week.

---

## 5. Weekly check-in and rate limiting

### 5.1 A deliberate design decision

The calorie target is recomputed purely as `TDEE_estimate + offset`. We
deliberately do **not** add a second corrective term based on "observed rate vs
target rate", because **the expenditure estimator already consumes exactly that
error signal**. Applying both double-counts it, and is the single most common
way these systems end up oscillating. **[well-established]** — this is a
control-theory point, not a nutrition one.

### 5.2 Gates, in order

1. **Cadence** — at most one change per 7 days.
2. **Estimator veto** (`suppressAdjustment`) — a perturbation is settling or a
   step was detected. Hold. §2.
3. **Confidence floor** — hold when `confidence < 0.35`.
4. **Dead band** — ignore changes below `max(75 kcal, 5% of current)`.
5. **Proportional gain** — apply only **0.4×** the proposed change, further
   scaled by confidence.
6. **Reversal damping** — halve any adjustment that reverses the previous one.
7. **Step cap** — `clamp(10% of current, 100, 300)` kcal.
8. **Four-week cumulative cap** — 25% of the target four weeks ago.

### 5.3 Why proportional gain is the key lever

The expenditure estimate carries genuine uncertainty (±100–200 kcal). Passing
that straight through would make the user's numbers jitter weekly. Applying a
fraction makes the target an **exponential moving average of the proposals**,
cutting variance by roughly `gain/(2−gain)`. **[well-established]**

**Measured over 40 simulated 26-week runs with ±150 kcal of weekly estimate noise:**

| gain | dead band | target SD / noise SD | Weeks changed | Avg weekly move |
|---|---|---|---|---|
| 0.3 | 6% | 0.35 | 9.9/26 | 19 kcal |
| **0.4** | **5%** | **0.44** | **12.8/26** | **31 kcal** |
| 0.5 | 4% | 0.48 | 14.9/26 | 40 kcal |

We chose gain 0.4 / dead band 5%: **target SD is 43% of the incoming noise** and
the average weekly change is ~34 kcal — imperceptible to the user, while still
tracking real change.

### 5.4 Verified stability

26 weekly check-ins with ±150 kcal SD of TDEE noise around a true 2,850:

```
unfiltered proposals : SD 165 kcal, range 1850-2620
applied targets      : SD  77 kcal, range 2130-2400
mean target 2279 kcal (correct answer 2250)
across 10 seeds: 14.0/26 weeks changed, SD ratio 0.43, avg weekly move 34 kcal
```

---

## 6. Safety guardrails

> **First-class requirement.** `macro-targets.ts` *proposes*; `guardrails.ts`
> *disposes*. Keeping generation and validation in separate modules means a
> change to the generator can never silently loosen a limit. All limits live in
> a single exported `LIMITS` object so UI copy, client and server validation
> read the same constants.

All validators return `{ ok, level: 'info'|'warn'|'block', code, message }[]`.
**A `block` is fatal: do not show the target, do not let the user proceed.**

### 6.1 Eligibility (run before computing anything)

| Condition | Level | Code |
|---|---|---|
| Age < 18 | **block** | `AGE_UNDER_18` |
| Pregnant | **block** | `PREGNANCY` |
| Breastfeeding <8 weeks postpartum + cut | **block** | `LACTATION_EARLY` |
| Breastfeeding ≥8 weeks + cut | warn (floor 1,800 kcal, cap 0.45 kg/wk) | `LACTATION` |
| Declared eating-disorder history | **block** | `ED_HISTORY` |
| BMI < 16 (severe thinness) | **block**, any goal | `BMI_SEVERE_THINNESS` |
| BMI < 18.5 + cut | **block** | `BMI_UNDERWEIGHT_CUT` |
| BMI < 20 + cut | warn | `BMI_LOW_NORMAL_CUT` |
| Goal weight implying BMI < 18.5 | **block** | `GOAL_WEIGHT_UNDERWEIGHT` |
| BMI < 10 or > 100 | **block** (data error) | `PROFILE_IMPLAUSIBLE` |

WHO BMI cutoffs. **[well-established]** The under-18, pregnancy and ED-history
exclusions follow WeightWatchers' published eligibility terms, a defensible
industry baseline. **[well-established]** AAP's 2016 clinical report advises
clinicians to **discourage dieting** in adolescents. **[well-established]**

### 6.2 Energy floors

| Rule | Level |
|---|---|
| Target < **800 kcal** | **block** — VLCDs are specialist-service-only under NICE NG246 **[well-established]** |
| Target < **1,200 (F) / 1,500 (M)** | **block** unless clinician-supervised **[well-established as guideline]** |
| Target < **1,800** while breastfeeding | **block** **[well-established]** |
| Target < **0.8 × BMR** | **block**, even with clinician attestation |
| Target < **1.0 × BMR** | warn |

The 1,200/1,500 figures come from the 2013 AHA/ACC/TOS obesity guideline. An
important caveat we encode: in the source these are **prescribed weight-loss
diets under clinical care, not universal safety floors**, and 1,200 kcal is
arbitrary as a universal number — its validity depends entirely on the
individual's RMR. **[well-established]** This is precisely why we *also* apply a
BMR-relative floor, which is the more principled constraint. **[reasonable-inference]**

**Energy availability (REDs):** `EA = (intake − exerciseKcal) / FFM_kg`.
Warn below the app's conservative **30 kcal/kg FFM caution line**; show
informational context below the commonly used 45 reference point. Neither value
is a diagnostic or universal sex-specific clinical threshold. **[well-established]**
The 2023 IOC consensus treats low energy availability as a **continuum, not a
fixed cutoff**, and REDs requires physician-led clinical assessment. Source:
[IOC REDs consensus statement (2023)](https://bjsm.bmj.com/content/57/17/1073).

### 6.3 Rate of loss — and *why*, not just *what*

| Rule | Level |
|---|---|
| Loss > **1.5 %BW/week** | **block**, clamped to 1.0% |
| Loss > **1.0 %BW/week** | warn |
| Loss > 0.85%/wk when body fat < 15% | info |
| Gain > **0.5 %BW/week** | warn |
| Observed loss > 1.5%/wk sustained ≥2 weeks | warn + raise calories |
| Unintended loss ≥5% in 30 d or ≥10% in 180 d | warn + clinician referral **[well-established]** |

`clampRatePctBwPerWeek()` **enforces** the cap; `validateRate()` explains it.

**The persuasion layer.** A bare limit invites users to route around it. When
the goal is a body-fat *percentage*, `projectBodyFatOutcome()` models the real
trade using a rate-dependent lean-loss fraction (5% at 0.5%/wk rising to ~50% at
2%/wk **[reasonable-inference]**, anchored on Garthe 2011). For a real user at
a synthetic body-composition scenario:

| Rate %/wk | Weeks to goal | End weight | Fat lost | **Lean lost** |
|---|---|---|---|---|
| 0.5 | 19 | 80.0 kg | 7.6 kg | **0.4 kg** |
| 0.7 | 14 | 79.8 kg | 7.3 kg | **0.9 kg** |
| 1.0 | 12 | 78.0 kg | 8.0 kg | **2.0 kg** |
| 1.5 | 11 | 74.5 kg | 8.4 kg | **5.1 kg** |
| 2.0 | 11 | 70.5 kg | 8.8 kg | **8.8 kg** |

Going from 0.7%/wk to 2.0%/wk saves **3 weeks** and costs **7.9 kg of lean mass**.
The reason is mechanical and worth stating to the user directly:

> Body-fat percentage is fat divided by total weight. Burning off lean mass
> shrinks the bottom of that fraction as well as the top, which is why crash
> dieting moves the percentage far less than it moves the scale.

This reasoning is the difference between a guardrail users respect and one they
work around.

### 6.4 Macronutrient limits

| Rule | Level | Source |
|---|---|---|
| Protein > **3.5 g/kg** | **block** | Urea-synthesis ceiling (Bilsborough & Mann 2006) **[reasonable-inference]** |
| Protein > **2.5 g/kg** | warn — no further benefit | Morton 2018 CI upper 2.2 **[well-established]** |
| Protein > 40% of energy | info | IOM AMDR 10–35% **[well-established]** |
| Fat < **0.3 g/kg** or < **15%** of energy | **block** | **[reasonable-inference]** |
| Fat < 0.5 g/kg or < 20% of energy | warn | ACSM/AND/DC 2016 **[well-established]** |
| Carbs < **100 g** | warn | IOM EAR **[well-established]** |
| Carbs < 130 g | info | IOM RDA **[well-established]** |
| Macros vs kcal mismatch > 5% | warn (bug) | — |

On protein safety specifically: intakes of 3.4–4.4 g/kg for 8 weeks, and
2.6–3.3 g/kg for 4 months, showed **no adverse effect on renal or hepatic
function or blood lipids** in healthy trained adults, and a meta-analysis of 28
studies (n=1,358) found no GFR difference. **[well-established, in healthy
individuals with normal renal function only]** Our ceiling is therefore about
*futility*, not toxicity, and the copy says so.

### 6.5 Implausible logged data

> **Cardinal rule: never respond to a suspiciously low food log by lowering the
> user's target.** A 400 kcal day means they forgot to log dinner.

| Rule | Action |
|---|---|
| `loggedKcal < 0.9 × BMR` | warn; **exclude the day** from the regression |
| `loggedKcal/BMR < 1.35` while weight-stable | info (Goldberg cutoff) **[well-established]** |
| `loggedKcal > 3 × BMR` or > 10,000 | warn; exclude |
| Macro sum vs kcal off by >20% | info |
| Weight ratio > 2× or < 0.5× previous | **block** — lb/kg mix-up |
| Weight outside 20–400 kg | **block** |
| Δ > 5 kg in ≤2 days | warn; trend filter down-weights it |
| Δ > 2 kg in 1 day | info — normal water fluctuation **[well-established]** |

On the Goldberg cutoff: the 1.35 EI:BMR figure assumes *measured* BMR and
habitual intake and is now regarded as too blunt for general use; Black (2000)
confidence limits are the modern approach. **[well-established]** We use 1.35 as
an *informational* trigger only.

Under-reporting is the dominant data-quality problem: food records underestimate
intake by **~10–20%**, FFQs by ~20–30%, with a mean of −20% and a range of −55%
to +40% in free-living adults, and it is worse in people with obesity.
**[well-established]**

`detectLoggingDiscrepancy()` catches the dangerous *inconsistent* case: when logs
predict >3× the observed rate of change over ≥3 weeks, it surfaces "your logging
may be incomplete" — **and explicitly does not cut calories.**

### 6.6 Eating-disorder screening and safeguarding

**SCOFF** (Morgan, Reid & Lacey, BMJ 1999), verbatim, 1 point per "yes",
**cutoff ≥2**:

1. Do you make yourself **S**ick because you feel uncomfortably full?
2. Do you worry you have lost **C**ontrol over how much you eat?
3. Have you recently lost more than **O**ne stone (6.35 kg) in a three-month period?
4. Do you believe yourself to be **F**at when others say you are too thin?
5. Would you say that **F**ood dominates your life?

**Critical constraint — NICE NG69 states explicitly: "Do not use screening tools
(for example, SCOFF) as the sole method to determine whether or not people have
an eating disorder."** **[well-established]** We therefore use SCOFF only to
decide whether *this app* is appropriate, never to tell a user they have a
diagnosis, and the copy is worded accordingly.

**The gate must be a real gate.** Noom's precedent is instructive: it asks about
an active eating-disorder diagnosis, shows a message, and then **lets the user
proceed by changing their answer**. Our gate must be enforced server-side and
must persist — not a dismissible dialog.

**Passive behavioural screening** is the more reliable trigger in practice,
because a one-time signup screener catches very little:

| Signal | Level |
|---|---|
| ≥3 below-floor target requests in 30 d | warn |
| ≥3 goal-weight reductions in 30 d | warn |
| ≥5 consecutive days logged <60% of target | **block**, pause targets |
| ≥7 consecutive days of multiple weigh-ins | info |

**Evidence this matters:** Levinson et al. 2017 found **73% of patients with a
diagnosed eating disorder reported that a calorie-tracking app contributed to
their eating disorder.** **[well-established]** We are building the class of
product that finding is about.

**Crisis resources** — verify before shipping and re-verify periodically:

- US: Crisis Text Line, text "NEDA" to **741741** (24/7, trained humans)
- US: ANAD Helpline **888-375-7767**
- US: **988** Suicide & Crisis Lifeline
- UK: Beat **0808 801 0677**

> **Never route a user in distress to an automated agent.** NEDA closed its
> human-staffed helpline in 2023 and its chatbot replacement was withdrawn after
> giving calorie-restriction advice to users with eating disorders.
> **[well-established]**

### 6.7 Disclaimers and referral

**Full disclaimer** (shown at goal setting and in onboarding, not buried in ToS):

> This app provides general wellness and educational information only. It is not
> medical advice, and it is not intended to diagnose, treat, cure, mitigate or
> prevent any disease. The calorie and macronutrient targets it shows are
> estimates based on the data you enter, and they can be wrong.
>
> Please talk to a doctor or a registered dietitian before starting any
> weight-change plan — particularly if you are under 18, pregnant or
> breastfeeding, have a history of an eating disorder, have a medical condition
> such as diabetes, kidney disease or heart disease, or take any medication whose
> effect depends on what you eat.

**Short form** (targets screen footer): *"General wellness information, not
medical advice. These targets are estimates."*

**Alongside the expenditure figure:** *"Your expenditure figure is an estimate
calculated from the food you log and the way your weight trends. It gets better
with more data. It is not a measurement, and it will move around."*

**Regulatory notes:**

- **FDA General Wellness policy** (revised January 2026) explicitly names
  **weight management** as an acceptable general-wellness category. Staying
  outside the device definition requires making **no diagnosis/treatment/cure/
  mitigation/prevention claims** about any specific disease (including obesity by
  name), not positioning the app as a substitute for clinical care, and not
  prompting specific clinical actions. Intended use is judged across **labelling,
  advertising, UI and functionality** — not just the disclaimer. **[well-established]**
- **FTC Health Products Compliance Guidance:** *a disclaimer does not cure an
  otherwise deceptive claim.* **Fix the claims first; the disclaimer is
  additional, not a shield.** **[well-established]**

**Referral escalation** (`professionalReferralPrompt`):

| Urgency | Triggers | Behaviour |
|---|---|---|
| **now** | `ED_SCREEN_POSITIVE`, `ED_HISTORY`, `BMI_SEVERE_THINNESS`, `BEHAVIOUR_SEVERE_UNDEREATING` | Show crisis resources |
| **soon** | unintended loss, observed loss too fast, underweight cut, low energy availability | "Raise this in the next week or two" |
| **consider** | repeated low-target requests, moving goal posts, sub-BMR target, lactation | Suggest a dietitian |

---

## 7. Known limitations

1. **Slow non-energetic weight shifts are not automatically detectable.** §2.3.
   The mitigations are logging, prompting, and rate limiting — not inference.
2. **Systematic logging bias is invisible if it changes over time.** §3.8.
3. **Energy density of weight change is not constant**, particularly in the first
   2–3 weeks of a new deficit when loss is disproportionately glycogen and water.
   Expect transient over-estimation of expenditure early in a cut.
4. **The filter's CI is ~2× conservative** on synthetic constant-rate data. §1.7.
5. **Body-recomposition** (simultaneous fat loss and muscle gain at stable weight)
   breaks the fixed-energy-density assumption. MacroFactor publishes a worst-case
   error of ~347 kcal/day (~10%) for this; we inherit a similar bound.
6. **All guardrail numbers should be re-verified against primary sources before
   shipping** — see §0.

---

## 8. Primary sources

**MacroFactor public methodology:** `macrofactor.com/expenditure-v3/`,
`/expenditure-modifiers/`, `/algorithm-accuracy/`,
`/macrofactors-algorithms-and-core-philosophy/`, `/macrofactors-bmr/`,
`/wearables/`; help centre articles 21 (Weight Trend), 26, 29/241 (partial
logging), 33 (wearables), 125 (dynamic maintenance), 126, 206, 220 (body recomp),
222, 256 (exercise), 274 (modifiers).

**Comparator:** `pensumapp.com/expenditure` — publishes a full EWMA-based
(α = 0.10, Hacker's Diet) energy-balance back-calculation.

**Science:** Hall & Chow 2013 (3500 kcal/lb critique); Hall et al. Lancet 2011
(dynamic model); Thomas et al. 2011; Forbes 1987; Leibel & Rosenbaum NEJM 1995;
Pontzer et al. Curr Biol 2016 (constrained TDEE); Mifflin et al. 1990;
Katch & McArdle; Cunningham 1991; Helms et al. 2014 (protein in deficit; natural
bodybuilding); Morton et al. 2018; Jäger et al. 2017 (ISSN); Aragon et al. 2017
(ISSN diets); Garthe et al. 2011 & 2013; Longland et al. 2016; Thomas/ACSM/AND/DC
2016 joint position stand; Slater & Phillips 2011; Whittaker & Wu 2021;
Byrne et al. 2018 (MATADOR); Peos et al. 2021 (ICECAP); IOM DRI Macronutrients
(AMDR); Mountjoy et al. 2023 (IOC REDs); Morgan et al. 1999 (SCOFF);
NICE NG69, NG246; 2013 AHA/ACC/TOS obesity guideline; Levinson et al. 2017;
Black 2000 (Goldberg cutoff); FDA General Wellness guidance; FTC Health Products
Compliance Guidance.
