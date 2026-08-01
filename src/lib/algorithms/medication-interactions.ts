/**
 * medication-interactions.ts
 *
 * Makes the app medication-aware in three ways:
 *
 * 1. **Lab interpretation correction.** A medication changes what a lab value
 *    *means*. Finasteride roughly halves PSA; an uncorrected PSA on finasteride
 *    is falsely reassuring, which is the single highest-consequence error this
 *    module exists to prevent.
 * 2. **Supplement ↔ medication interaction checking** over the user's logged
 *    stack, returning {@link Finding}s.
 * 3. **A physiological confounder registry** so the weight-trend, readiness and
 *    nutrition engines can compensate for effects the medications produce.
 *
 * ## Boundaries this module enforces in code
 *
 * Per `advice-policy.md` Tier 3 rule 1, **nothing here may suggest starting,
 * stopping, changing the dose of, or re-timing a prescribed medication.**
 * Supplement timing is in scope and is genuinely useful ("keep the psyllium two
 * hours away from anything else you swallow"); medication timing is not, at any
 * level of hedging. `assertNoMedicationDirective()` is a lint over the copy in
 * this file and `verify-medications.mjs` runs it over every string.
 *
 * Per Tier 3 rule 2, nothing here names or implies a diagnosis, and no consumer
 * may infer one from the medication list. Sertraline in particular is treated as
 * a pharmacological input and nothing else.
 *
 * ## What this module deliberately does NOT do
 *
 * - **Upper-limit arithmetic.** That is `micronutrients.ts`
 *   (`countsTowardUpperLimit`, `analyseStackCoverage`). Two implementations of a
 *   UL check will eventually disagree, and the one that disagrees quietly is the
 *   dangerous one. {@link SUPPLEMENTS_WITH_UL_CONSIDERATIONS} tells the UI which
 *   of our flagged items also need that engine run over them.
 * - **Pre-analytical artifact rules** (fasting, draw time, recent training).
 *   Those are `lab-panels.json → artifactRules[]` per
 *   `integration-health-records.md` §9.6. Medication effects merge with them;
 *   they do not replace them.
 * - **Overwriting a stored lab value.** {@link correctLabValue} returns a derived
 *   number for display alongside the raw result. The raw value is immutable.
 *
 * Data mirror: `specs/medication-effects.json`. `verify-medications.mjs` asserts
 * the two stay in sync, so edit both or neither.
 *
 * Zero runtime dependencies. Pure functions. No I/O.
 *
 * @module medication-interactions
 */

import type { Finding, FindingLevel } from './guardrails';

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

/** Confidence tagging required by `advice-policy.md` on every output. */
export type Confidence = 'well-established' | 'reasonable-inference' | 'uncertain';

/** An agent the user takes. `prescription` items are Tier 3 rule 1 territory. */
export type AgentKind = 'prescription' | 'prescription-or-otc' | 'supplement';

/** A medication or supplement as logged by the user. */
export interface MedicationEntry {
  /** Canonical id, e.g. `'sertraline'`. Resolve free text with {@link resolveAgentId}. */
  id: string;
  /** What the user typed. Kept for display; never parsed for meaning. */
  label?: string;
  /** ISO date the user started it. Required for anything time-dependent. */
  startedOn?: string;
  /** ISO date they stopped. `undefined` means still taking it. */
  stoppedOn?: string;
  /** ISO date of the most recent dose change, if logged. */
  doseChangedOn?: string;
  /** Free text, never interpreted. */
  note?: string;
}

/** A supplement product in the user's stack, reduced to what this module needs. */
export interface SupplementEntry {
  /** Canonical id, e.g. `'5-htp'`. Resolve free text with {@link resolveSupplementId}. */
  id: string;
  label?: string;
  /** Daily amount, when known. Used only for dose-thresholded rules. */
  amountPerDay?: number;
  /** Unit for {@link amountPerDay}, e.g. `'mcg'`, `'mg'`, `'IU'`, `'g'`. */
  unit?: string;
}

/* ------------------------------------------------------------------ */
/* Finding constructors (shape borrowed from guardrails.ts, verbatim)  */
/* ------------------------------------------------------------------ */

function mk(level: FindingLevel, code: string, message: string): Finding {
  return { ok: false, level, code, message };
}
const info = (code: string, message: string): Finding => mk('info', code, message);
const warn = (code: string, message: string): Finding => mk('warn', code, message);
// `block` findings are produced through `mk(rule.level, …)` from the interaction
// table, so that the severity of an interaction lives in the data rather than in
// a call site — which is what makes the levels auditable in one place.
const okFinding = (code: string): Finding => ({ ok: true, level: 'info', code, message: '' });

/* ------------------------------------------------------------------ */
/* Agent catalogue                                                     */
/* ------------------------------------------------------------------ */

export interface AgentDefinition {
  id: string;
  kind: AgentKind;
  displayName: string;
  aliases: readonly string[];
  drugClass: string;
}

export const AGENTS: readonly AgentDefinition[] = [
  {
    id: 'sertraline',
    kind: 'prescription',
    displayName: 'Sertraline',
    aliases: ['sertraline', 'zoloft', 'lustral'],
    drugClass: 'SSRI',
  },
  {
    id: 'finasteride',
    kind: 'prescription',
    displayName: 'Finasteride',
    aliases: ['finasteride', 'propecia', 'proscar', 'finpecia'],
    drugClass: '5-alpha-reductase inhibitor',
  },
  {
    id: 'minoxidil-topical',
    kind: 'prescription-or-otc',
    displayName: 'Minoxidil 5% (topical)',
    aliases: ['minoxidil', 'rogaine', 'regaine', 'topical minoxidil'],
    drugClass: 'vasodilator (topical)',
  },
  {
    id: 'creatine',
    kind: 'supplement',
    displayName: 'Creatine monohydrate',
    aliases: ['creatine', 'creatine monohydrate', 'creapure'],
    drugClass: 'ergogenic substrate',
  },
];

/**
 * Resolve free text to a canonical agent id.
 *
 * Matching is loose and bidirectional on substring, deliberately: a false match
 * produces an extra caveat, a missed match produces a silently uncorrected PSA.
 * The asymmetry of cost decides the design.
 *
 * @returns the agent id, or `null` when nothing matches
 */
export function resolveAgentId(text: string): string | null {
  const t = normalise(text);
  if (!t) return null;
  for (const a of AGENTS) {
    if (normalise(a.id) === t) return a.id;
    for (const alias of a.aliases) {
      if (fuzzyMatch(t, normalise(alias))) return a.id;
    }
  }
  return null;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Loose bidirectional substring match with length floors.
 *
 * The floors exist because unbounded containment is unsafe in the short
 * direction: a placeholder id of `'y'` matches `'5 hydroxytryptophan'`, which
 * would silently attach a serotonin-syndrome finding to an unrelated product.
 * Matching remains deliberately generous above the floors — a spurious caveat
 * costs a sentence, a missed one costs the finding.
 *
 * @param query normalised user text
 * @param alias normalised catalogue alias
 */
function fuzzyMatch(query: string, alias: string): boolean {
  if (query === alias) return true;
  if (alias.length >= 3 && query.includes(alias)) return true;
  if (query.length >= 4 && alias.includes(query)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 1. Lab interpretation                                               */
/* ------------------------------------------------------------------ */

/** What the labs screen should do with an out-of-range marker on this analyte. */
export type FlagBehaviour =
  /** Leave the lab's own flag exactly as it is; attach the note beside it. */
  | 'annotate-only'
  /** Remove the *low* flag: the suppression is the intended pharmacology. */
  | 'suppress-low-flag'
  /** Downgrade severity within a stated band only. Never below it, never critical. */
  | 'downgrade-mild'
  /** No effect exists. Recorded so engines stop offering the drug as an explanation. */
  | 'no-effect';

export interface LabEffect {
  agentId: string;
  analyteId: string;
  displayName: string;
  loinc: string | null;
  loincConfidence: Confidence;
  direction: 'increase' | 'decrease' | 'none' | 'none-or-minimal' | 'false-positive';
  /** Central proportional effect, e.g. `-50` for "halves it". `null` where none is defensible. */
  centralPct: number | null;
  /** Days on the drug before the effect is fully expressed. */
  onsetDays: number | null;
  /** Days after stopping before the effect has gone. `null` = unknown. */
  washoutDays: number | null;
  /** Multiplicative correction, or `null` where no defensible factor exists. */
  correctionFactor: number | null;
  /** Minimum days on drug before {@link correctionFactor} may be applied. */
  correctionMinDays: number;
  /** Supplement ids whose presence invalidates the correction entirely. */
  correctionInvalidatedBy: readonly string[];
  flagBehaviour: FlagBehaviour;
  /** For `downgrade-mild`: the [low, high] band inside which severity may drop. */
  downgradeBand?: readonly [number, number];
  confidence: Confidence;
  message: string;
}

/**
 * Medication → analyte effects.
 *
 * Kept as a flat array rather than a nested map so a single analyte affected by
 * two agents is expressible without special-casing — which is precisely the
 * situations such as PSA interpretation with finasteride or creatinine with creatine.
 */
export const LAB_EFFECTS: readonly LabEffect[] = [
  /* ---- finasteride ------------------------------------------------ */
  {
    agentId: 'finasteride',
    analyteId: 'psa-total',
    displayName: 'PSA (total)',
    loinc: '2857-1',
    loincConfidence: 'well-established',
    direction: 'decrease',
    centralPct: -50,
    onsetDays: 180,
    washoutDays: null,
    correctionFactor: 2.0,
    correctionMinDays: 180,
    correctionInvalidatedBy: ['saw-palmetto', 'biotin-high-dose', 'claimed-5ar-botanicals'],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'Double it. Finasteride roughly halves PSA, so this number is about half of what your prostate is actually producing — a PSA of 1.0 on finasteride reads like a 2.0 off it. This matters more than anything else on the screen, because an uncorrected PSA on finasteride is falsely reassuring: it makes a rising number look normal. The doubling rule comes from the 5 mg dose studied over one to three years; a randomised trial at 1 mg found the same 40-50% suppression across the first year, so doubling is the right default here too, with the honest caveat that nobody has validated it for years of 1 mg use. Two practical things: the suppression takes about six months to settle, and over time the trend from your lowest on-treatment value tells you more than any single reading. Tell whoever orders or reads a PSA that you take finasteride — it changes their reading too.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'psa-free',
    displayName: 'PSA (free) and free:total ratio',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'decrease',
    centralPct: -50,
    onsetDays: 180,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 180,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'reasonable-inference',
    message:
      'Free PSA falls alongside total PSA on finasteride, so the free:total ratio stays roughly where it was. We do not double this one — that adjustment was only ever validated for total PSA.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'dht',
    displayName: 'Dihydrotestosterone (DHT)',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'decrease',
    centralPct: -65,
    onsetDays: 1,
    washoutDays: 14,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'suppress-low-flag',
    confidence: 'well-established',
    message:
      'A low DHT here is the medication doing its job, not a problem. Finasteride blocks the enzyme that converts testosterone to DHT and drops serum DHT by around 65%, most of it within a day of the first dose. We are not flagging it as abnormal, because against a reference range built from men who are not taking it, abnormal is exactly what success looks like.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'testosterone-total',
    displayName: 'Testosterone (total)',
    loinc: '2986-8',
    loincConfidence: 'reasonable-inference',
    direction: 'increase',
    centralPct: 15,
    onsetDays: 30,
    washoutDays: 28,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'Total testosterone runs about 15% above where it would sit without finasteride — testosterone that is not being converted to DHT stays in circulation. It remains inside the normal range, and it is not evidence that anything in your training or nutrition moved.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'estradiol',
    displayName: 'Estradiol',
    loinc: '2243-4',
    loincConfidence: 'reasonable-inference',
    direction: 'increase',
    centralPct: 15,
    onsetDays: 30,
    washoutDays: 28,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'Estradiol runs about 15% higher on finasteride, within the normal range, for the same reason testosterone does.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'lh-fsh',
    displayName: 'LH / FSH / prolactin / TSH / free T4 / cortisol',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'none',
    centralPct: null,
    onsetDays: null,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'no-effect',
    confidence: 'well-established',
    message:
      'Finasteride does not meaningfully move LH, FSH, prolactin, thyroid tests or cortisol. If one of those is off, finasteride is not the explanation.',
  },
  {
    agentId: 'finasteride',
    analyteId: 'lipid-panel',
    displayName: 'Lipid panel',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'none-or-minimal',
    centralPct: null,
    onsetDays: null,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'no-effect',
    confidence: 'reasonable-inference',
    message: 'Finasteride is not a lipid drug and does not meaningfully move a lipid panel.',
  },

  /* ---- sertraline -------------------------------------------------- */
  {
    agentId: 'sertraline',
    analyteId: 'sodium',
    displayName: 'Sodium (serum)',
    loinc: '2951-2',
    loincConfidence: 'well-established',
    direction: 'decrease',
    centralPct: null,
    onsetDays: 30,
    washoutDays: 30,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'A sodium at the low end reads differently on an SSRI. SSRIs are a recognised cause of low sodium, through the hormone that controls how much water your kidneys hold on to. This is not a fixed shift to subtract — most people on an SSRI have a completely normal sodium — and the risk is concentrated in the first weeks on a new dose rather than on long-standing treatment. It matters more for you than for most people because heavy sweating replaced with plain water is the other common route to a low sodium, and you train hard three times a week. If this number is low or has moved, it is worth raising with your prescriber or pharmacist alongside the result.',
  },
  {
    agentId: 'sertraline',
    analyteId: 'urine-drug-screen-benzodiazepine',
    displayName: 'Urine drug screen — benzodiazepines',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'false-positive',
    centralPct: null,
    onsetDays: 1,
    washoutDays: 7,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'Sertraline is a documented cause of a false positive for benzodiazepines — and for LSD — on the quick immunoassay screens used for employment and pre-op testing. It is on the manufacturer label. Confirmatory testing by mass spectrometry sorts it out and is close to definitive. If a screen ever comes back positive, say what you take and ask for confirmatory testing.',
  },
  {
    agentId: 'sertraline',
    analyteId: 'urine-drug-screen-lsd',
    displayName: 'Urine drug screen — LSD',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'false-positive',
    centralPct: null,
    onsetDays: 1,
    washoutDays: 7,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'reasonable-inference',
    message: 'See the note on benzodiazepine screens — the same applies to LSD immunoassays.',
  },
  {
    agentId: 'sertraline',
    analyteId: 'platelet-function-bleeding-time',
    displayName: 'Bleeding time / platelet function',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'increase',
    centralPct: null,
    onsetDays: 28,
    washoutDays: 21,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'SSRIs slightly reduce platelet stickiness, because platelets use serotonin to clump together and they take theirs from the bloodstream. It shows up as easier bruising more often than as anything on a lab report. It matters mainly if several blood-thinning supplements are stacked on top.',
  },
  {
    agentId: 'sertraline',
    analyteId: 'prolactin',
    displayName: 'Prolactin',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'increase',
    centralPct: null,
    onsetDays: null,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'uncertain',
    message:
      'SSRIs are an occasionally reported cause of a raised prolactin. It is uncommon, and it is one of several possible explanations rather than the explanation. A clinician can settle it.',
  },
  {
    agentId: 'sertraline',
    analyteId: 'alt-ast',
    displayName: 'ALT / AST',
    loinc: null,
    loincConfidence: 'uncertain',
    direction: 'increase',
    centralPct: null,
    onsetDays: null,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'uncertain',
    message:
      'Antidepressants are a rare cause of raised liver enzymes. In someone training hard this is a long way down the list — skeletal muscle contains AST and ALT, and a heavy session in the days before a draw is a far more common explanation. GGT tells them apart, because muscle does not raise it.',
  },

  /* ---- creatine ---------------------------------------------------- */
  {
    agentId: 'creatine',
    analyteId: 'creatinine',
    displayName: 'Creatinine (serum)',
    loinc: '2160-0',
    loincConfidence: 'well-established',
    direction: 'increase',
    centralPct: null,
    onsetDays: 28,
    washoutDays: 28,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'annotate-only',
    confidence: 'well-established',
    message:
      'Creatine can modestly raise serum creatinine without reducing measured filtration in healthy trial participants. That can change how this result reads, but it does not prove that an abnormal value is harmless. Tell the clinician who reads these results that you take creatine; no numeric correction is applied.',
  },
  {
    agentId: 'creatine',
    analyteId: 'egfr-creatinine',
    displayName: 'eGFR (creatinine-based)',
    loinc: '33914-3',
    loincConfidence: 'uncertain',
    direction: 'decrease',
    centralPct: null,
    onsetDays: 28,
    washoutDays: 28,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'downgrade-mild',
    downgradeBand: [60, 89],
    confidence: 'well-established',
    message:
      'You take creatine, and that can change how this number reads. In randomized trials of healthy adults, creatine sometimes raised serum creatinine without reducing measured kidney filtration; because eGFR is calculated from creatinine, it can fall in step. That is one possible explanation, not proof that an abnormal result is harmless. Tell whoever reads these results that you take creatine and ask whether a combined creatinine-cystatin C eGFR or measured GFR is appropriate when creatinine is unreliable.',
  },
  {
    agentId: 'creatine',
    analyteId: 'cystatin-c',
    displayName: 'Cystatin C / eGFRcr-cys',
    loinc: '33863-2',
    loincConfidence: 'reasonable-inference',
    direction: 'none',
    centralPct: null,
    onsetDays: null,
    washoutDays: null,
    correctionFactor: null,
    correctionMinDays: 0,
    correctionInvalidatedBy: [],
    flagBehaviour: 'no-effect',
    confidence: 'well-established',
    message:
      'Cystatin C is less dependent on muscle mass than creatinine, but it has other non-kidney influences. A combined creatinine-cystatin C eGFR is generally more accurate than either marker alone and can help when creatinine is unreliable.',
  },
];

/** Result of {@link correctLabValue}. */
export interface LabCorrectionResult {
  /** The value to display as the corrected reading. Equals the input when `corrected` is false. */
  value: number;
  corrected: boolean;
  /** The multiplier applied, or `null` when none was. */
  factor: number | null;
  /** Plain-language explanation. Always populated. */
  note: string;
  /** The raw value, unchanged. Stored results are never overwritten. */
  rawValue: number;
  confidence: Confidence;
  /** Agent ids that contributed. */
  attributedTo: string[];
  flagBehaviour: FlagBehaviour;
  /** For `downgrade-mild`, the band inside which severity may drop. */
  downgradeBand: readonly [number, number] | null;
}

export interface CorrectLabValueOptions {
  /** ISO date of the blood draw. Enables the duration-on-drug rules. */
  drawnOn?: string;
  /** The user's supplement stack. Some supplements invalidate a correction. */
  supplements?: readonly SupplementEntry[];
}

/**
 * Correct a lab value for the medications the user takes, where a defensible
 * correction exists — and refuse to invent one where it does not.
 *
 * The refusal path is the important one. Some analytes in a typical
 * panel are affected by a medication with **no defensible numeric correction**:
 * eGFR on creatine, sodium on sertraline, DHT on finasteride. For each, the
 * function returns `corrected: false` with an explanation rather than a factor,
 * because a fabricated factor on eGFR would silently normalise a genuinely
 * falling number.
 *
 * @param analyte the analyte id (from `lab-panels.json`) or a LOINC code
 * @param value the value exactly as the lab reported it
 * @param meds the user's current medication list
 * @param opts draw date and supplement stack
 * @returns `null` when nothing the user takes affects this analyte — which is
 *   the common case and must be cheap for the caller to handle
 *
 * @example
 * // PSA 1.2 ng/mL, on finasteride for 2 years
 * correctLabValue('psa-total', 1.2, [{ id: 'finasteride', startedOn: '2024-01-01' }],
 *                 { drawnOn: '2026-07-01' });
 * // → { value: 2.4, corrected: true, factor: 2 , ... }
 */
export function correctLabValue(
  analyte: string,
  value: number,
  meds: readonly MedicationEntry[],
  opts: CorrectLabValueOptions = {},
): LabCorrectionResult | null {
  if (!Number.isFinite(value)) return null;
  const key = normalise(analyte);
  const activeIds = new Set(meds.filter((m) => isActiveOn(m, opts.drawnOn)).map((m) => m.id));

  const effects = LAB_EFFECTS.filter(
    (e) =>
      activeIds.has(e.agentId) &&
      (normalise(e.analyteId) === key || (e.loinc !== null && e.loinc === analyte)),
  );
  if (effects.length === 0) return null;

  const attributedTo = effects.map((e) => e.agentId);
  const notes = effects.map((e) => e.message);
  const flagBehaviour = pickFlagBehaviour(effects);
  const downgradeBand = effects.find((e) => e.downgradeBand)?.downgradeBand ?? null;
  const confidence = weakestConfidence(effects.map((e) => e.confidence));

  const correctable = effects.filter((e) => e.correctionFactor !== null);
  if (correctable.length === 0) {
    return {
      value,
      corrected: false,
      factor: null,
      note: `${notes.join(' ')} There is no defensible numeric correction for this one, so the value is shown exactly as the lab reported it and read with that in mind.`,
      rawValue: value,
      confidence,
      attributedTo,
      flagBehaviour,
      downgradeBand,
    };
  }

  // More than one correctable medication effect on one analyte is not something
  // we can compose safely: two factors multiplied is a guess, not a correction.
  if (correctable.length > 1) {
    return {
      value,
      corrected: false,
      factor: null,
      note: `${notes.join(' ')} More than one thing you take affects this result, and there is no validated way to combine their corrections — so we are not applying one. Worth raising with your prescriber or pharmacist, who can interpret it with the full picture.`,
      rawValue: value,
      confidence: 'uncertain',
      attributedTo,
      flagBehaviour,
      downgradeBand,
    };
  }

  const eff = correctable[0]!;

  // Guard 1: a supplement in the stack invalidates the correction.
  const supplementIds = new Set((opts.supplements ?? []).map((s) => s.id));
  const blockers = eff.correctionInvalidatedBy.filter((id) => supplementIds.has(id));
  if (blockers.length > 0) {
    return {
      value,
      corrected: false,
      factor: null,
      note: `${eff.message} We are not applying the correction on this result, because ${blockers
        .map(supplementDisplayName)
        .join(' and ')} in your stack ${blockers.length > 1 ? 'affect' : 'affects'} the same number, and there is no validated adjustment for the combination. The value below is exactly as the lab reported it.`,
      rawValue: value,
      confidence: 'uncertain',
      attributedTo,
      flagBehaviour,
      downgradeBand,
    };
  }

  // Guard 2: not long enough on the drug for the effect to have settled.
  const days = daysOnDrug(meds, eff.agentId, opts.drawnOn);
  if (days !== null && days < eff.correctionMinDays) {
    return {
      value,
      corrected: false,
      factor: null,
      note: `${eff.message} This draw is ${days} days after you started, and the effect takes about ${eff.correctionMinDays} days to settle — so the true figure is somewhere between the reported value and double it, and we are not going to pretend to know where. Shown as reported.`,
      rawValue: value,
      confidence: 'reasonable-inference',
      attributedTo,
      flagBehaviour,
      downgradeBand,
    };
  }

  return {
    value: round3(value * eff.correctionFactor!),
    corrected: true,
    factor: eff.correctionFactor,
    note: eff.message,
    rawValue: value,
    confidence: eff.confidence,
    attributedTo,
    flagBehaviour,
    downgradeBand,
  };
}

function pickFlagBehaviour(effects: readonly LabEffect[]): FlagBehaviour {
  // Order of precedence: the least interventionist behaviour that any effect
  // asks for wins, except that an explicit no-effect never overrides a real one.
  if (effects.some((e) => e.flagBehaviour === 'annotate-only')) return 'annotate-only';
  if (effects.some((e) => e.flagBehaviour === 'downgrade-mild')) return 'downgrade-mild';
  if (effects.some((e) => e.flagBehaviour === 'suppress-low-flag')) return 'suppress-low-flag';
  return 'no-effect';
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  'well-established': 0,
  'reasonable-inference': 1,
  uncertain: 2,
};
function weakestConfidence(cs: readonly Confidence[]): Confidence {
  return cs.reduce((a, b) => (CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a), 'well-established');
}

function supplementDisplayName(id: string): string {
  const r = INTERACTIONS.find((i) => i.supplementId === id);
  return r ? r.supplementDisplayName : id;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/* ---- date helpers (no Date-parsing surprises, no dependencies) ----- */

function toEpochDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
}

function daysBetween(a: string, b: string): number | null {
  const ea = toEpochDay(a);
  const eb = toEpochDay(b);
  if (ea === null || eb === null) return null;
  return eb - ea;
}

/** True when the entry is being taken on `isoDate` (or "now" when undefined). */
export function isActiveOn(m: MedicationEntry, isoDate?: string): boolean {
  if (!isoDate) return !m.stoppedOn;
  const day = toEpochDay(isoDate);
  if (day === null) return !m.stoppedOn;
  if (m.startedOn) {
    const s = toEpochDay(m.startedOn);
    if (s !== null && day < s) return false;
  }
  if (m.stoppedOn) {
    const e = toEpochDay(m.stoppedOn);
    if (e !== null && day > e) return false;
  }
  return true;
}

function daysOnDrug(
  meds: readonly MedicationEntry[],
  agentId: string,
  isoDate?: string,
): number | null {
  const m = meds.find((x) => x.id === agentId);
  if (!m || !m.startedOn || !isoDate) return null;
  return daysBetween(m.startedOn, isoDate);
}

/* ------------------------------------------------------------------ */
/* 2. Supplement ↔ medication interactions                             */
/* ------------------------------------------------------------------ */

export type InteractionMechanism =
  | 'pharmacodynamic-serotonergic'
  | 'pharmacodynamic-serotonergic+pharmacokinetic-induction'
  | 'pharmacodynamic-same-target'
  | 'pharmacodynamic-claimed-same-target'
  | 'additive-antiplatelet'
  | 'additive-sedation'
  | 'additive-sedation+hepatic'
  | 'additive-physiological'
  | 'assay-interference'
  | 'absorption-timing';

export interface InteractionRule {
  id: string;
  /** Agent id, or `'*'` for a rule that applies alongside any oral medication. */
  agentId: string;
  supplementId: string;
  supplementDisplayName: string;
  supplementAliases: readonly string[];
  mechanism: InteractionMechanism;
  level: FindingLevel;
  code: string;
  confidence: Confidence;
  message: string;
  /** Only fires at or above this daily amount, when the amount is known. */
  doseThreshold?: { amount: number; unit: string };
  /** Counts toward {@link ANTIPLATELET_STACK_RULE}. */
  antiplateletClassMember?: boolean;
  /** Lab corrections this supplement invalidates. */
  invalidatesLabCorrection?: readonly string[];
}

export const INTERACTIONS: readonly InteractionRule[] = [
  {
    id: 'sert-5htp',
    agentId: 'sertraline',
    supplementId: '5-htp',
    supplementDisplayName: '5-HTP',
    supplementAliases: ['5 htp', '5htp', '5 hydroxytryptophan', 'griffonia', 'griffonia simplicifolia'],
    mechanism: 'pharmacodynamic-serotonergic',
    level: 'block',
    code: 'MED_SEROTONERGIC_STACK_5HTP',
    confidence: 'well-established',
    message:
      '5-HTP is a direct precursor to serotonin and crosses into the brain without needing a transporter, which makes it the highest-risk of the serotonin precursors to combine with an SSRI. Combining two things that raise serotonin by different routes is the mechanism behind serotonin syndrome — rare, but serious, and the reason every reference source says not to do this without a prescriber involved. Documented cases with an SSRI specifically are few and muddied by other products, so the case here is mechanistic rather than statistical. That is still enough. Worth raising with your prescriber or pharmacist before you take it.',
  },
  {
    id: 'sert-tryptophan',
    agentId: 'sertraline',
    supplementId: 'l-tryptophan',
    supplementDisplayName: 'L-tryptophan',
    supplementAliases: ['l tryptophan', 'tryptophan', 'trp'],
    mechanism: 'pharmacodynamic-serotonergic',
    level: 'block',
    code: 'MED_SEROTONERGIC_STACK_TRYPTOPHAN',
    confidence: 'well-established',
    message:
      'L-tryptophan is the raw material your body makes serotonin from. Taken with an SSRI it adds serotonin by a different route than the medication does, and that combination is the recognised setup for serotonin syndrome. The risk is lower than with 5-HTP, because tryptophan has to compete for transport into the brain — but the reasoning is the same and so is the recommendation. This applies to sleep and mood blends containing tryptophan, not just the standalone amino acid. Worth raising with your prescriber or pharmacist.',
  },
  {
    id: 'sert-sjw',
    agentId: 'sertraline',
    supplementId: 'st-johns-wort',
    supplementDisplayName: "St John's wort",
    supplementAliases: ['st john s wort', 'st johns wort', 'hypericum', 'hypericum perforatum'],
    mechanism: 'pharmacodynamic-serotonergic+pharmacokinetic-induction',
    level: 'block',
    code: 'MED_SEROTONERGIC_STACK_SJW',
    confidence: 'well-established',
    message:
      "St John's wort is the one that goes wrong in two directions at once. It raises serotonin by a mechanism similar to the medication's, which is the serotonin syndrome risk. It is also a strong inducer of the liver enzymes CYP3A4, CYP2C9 and CYP2C19 — hyperforin acting on the pregnane X receptor — and sertraline is metabolised partly through CYP2C19, so it can pull the medication's own blood levels down as well. Induction takes ten to fourteen days to reach full effect and about the same to wear off, so the timing never makes it obvious. This is the clearest do-not-combine in the supplement aisle. Worth raising with your prescriber or pharmacist rather than working around.",
  },
  {
    id: 'sert-same',
    agentId: 'sertraline',
    supplementId: 'sam-e',
    supplementDisplayName: 'SAM-e',
    supplementAliases: ['sam e', 'same', 's adenosyl methionine', 's adenosylmethionine', 'ademetionine'],
    mechanism: 'pharmacodynamic-serotonergic',
    level: 'block',
    code: 'MED_SEROTONERGIC_STACK_SAME',
    confidence: 'reasonable-inference',
    message:
      'SAM-e is sold for mood and acts on the same monoamine systems the medication does. Every major reference lists this combination as one to avoid without a prescriber involved, for the same serotonin syndrome reason as 5-HTP. The evidence is mechanistic and consensus-based rather than a body of documented cases — we are telling you what the references say and why, not inflating the case. Worth raising with your prescriber or pharmacist.',
  },
  {
    id: 'sert-kratom',
    agentId: 'sertraline',
    supplementId: 'kratom',
    supplementDisplayName: 'Kratom',
    supplementAliases: ['kratom', 'mitragyna', 'mitragynine'],
    mechanism: 'pharmacodynamic-serotonergic',
    level: 'block',
    code: 'MED_SEROTONERGIC_STACK_KRATOM',
    confidence: 'reasonable-inference',
    message:
      'Kratom is sold as a botanical supplement and acts on serotonergic and opioid receptors. With an SSRI it carries a serotonin syndrome risk, and it has its own separate safety questions on top. Worth raising with your prescriber or pharmacist.',
  },
  {
    id: 'sert-rhodiola',
    agentId: 'sertraline',
    supplementId: 'rhodiola',
    supplementDisplayName: 'Rhodiola rosea',
    supplementAliases: ['rhodiola', 'rhodiola rosea', 'golden root', 'arctic root'],
    mechanism: 'pharmacodynamic-serotonergic',
    level: 'warn',
    code: 'MED_SEROTONERGIC_STACK_RHODIOLA',
    confidence: 'uncertain',
    message:
      'Rhodiola shows weak monoamine-oxidase-inhibiting activity in laboratory work and gets routinely listed as one to be careful with alongside serotonergic medication. The human evidence is thin and we are not going to inflate it — so this is a flag rather than a stop, and it is worth mentioning to your pharmacist if you want to take it.',
  },
  {
    id: 'sert-omega3',
    agentId: 'sertraline',
    supplementId: 'omega-3',
    supplementDisplayName: 'Omega-3 (fish or algal oil)',
    supplementAliases: ['omega 3', 'fish oil', 'epa', 'dha', 'algal oil', 'krill oil', 'cod liver oil'],
    mechanism: 'additive-antiplatelet',
    level: 'info',
    code: 'MED_BLEEDING_OMEGA3',
    confidence: 'well-established',
    antiplateletClassMember: true,
    message:
      'Both an SSRI and fish oil nudge platelets in the same direction — the medication by reducing the serotonin platelets use to clump, fish oil by changing the fats they are built from. On paper that reads like additive bleeding risk. In practice it has not shown up: European regulators reviewing the available studies concluded that up to 5 g a day of EPA plus DHA does not raise the risk of spontaneous bleeding, and sources looking specifically at fish oil alongside SSRIs say the same. The 1-2 g this app suggests is well inside that. Worth mentioning before surgery or dental work, which is a conversation worth having anyway.',
  },
  {
    id: 'sert-ginkgo',
    agentId: 'sertraline',
    supplementId: 'ginkgo',
    supplementDisplayName: 'Ginkgo biloba',
    supplementAliases: ['ginkgo', 'ginkgo biloba', 'gingko'],
    mechanism: 'additive-antiplatelet',
    level: 'warn',
    code: 'MED_BLEEDING_GINKGO',
    confidence: 'reasonable-inference',
    antiplateletClassMember: true,
    message:
      'Ginkgo has antiplatelet activity and has been associated with bleeding events on its own, which puts it in a different category from fish oil. On top of an SSRI it is worth a word with a pharmacist, particularly around any procedure.',
  },
  {
    id: 'sert-garlic',
    agentId: 'sertraline',
    supplementId: 'garlic-extract',
    supplementDisplayName: 'Concentrated garlic extract',
    supplementAliases: ['garlic extract', 'aged garlic', 'allicin', 'garlic supplement'],
    mechanism: 'additive-antiplatelet',
    level: 'info',
    code: 'MED_BLEEDING_GARLIC',
    confidence: 'reasonable-inference',
    antiplateletClassMember: true,
    message:
      'Concentrated garlic supplements have mild antiplatelet activity. On its own alongside an SSRI this is a footnote; it counts toward the stacking check. Garlic in food is not what this is about.',
  },
  {
    id: 'sert-curcumin',
    agentId: 'sertraline',
    supplementId: 'curcumin',
    supplementDisplayName: 'Curcumin',
    supplementAliases: ['curcumin', 'turmeric extract', 'meriva', 'theracurmin'],
    mechanism: 'additive-antiplatelet',
    level: 'info',
    code: 'MED_BLEEDING_CURCUMIN',
    confidence: 'reasonable-inference',
    antiplateletClassMember: true,
    message:
      'High-dose curcumin extracts have mild antiplatelet activity and inhibit several liver enzymes in laboratory work. Counts toward the stacking check. Turmeric in food does not.',
  },
  {
    id: 'sert-vitamin-e-high',
    agentId: 'sertraline',
    supplementId: 'vitamin-e-high-dose',
    supplementDisplayName: 'Vitamin E above 400 IU/day',
    supplementAliases: ['vitamin e', 'alpha tocopherol', 'tocopherol'],
    mechanism: 'additive-antiplatelet',
    level: 'info',
    code: 'MED_BLEEDING_VITAMIN_E',
    confidence: 'reasonable-inference',
    antiplateletClassMember: true,
    doseThreshold: { amount: 400, unit: 'IU' },
    message:
      'Vitamin E above about 400 IU a day has mild antiplatelet activity. Counts toward the stacking check. It also has its own upper limit, which the micronutrient engine checks separately — that check is not duplicated here.',
  },
  {
    id: 'sert-nattokinase',
    agentId: 'sertraline',
    supplementId: 'nattokinase',
    supplementDisplayName: 'Fibrinolytic enzymes (nattokinase, serrapeptase)',
    supplementAliases: ['nattokinase', 'serrapeptase', 'lumbrokinase'],
    mechanism: 'additive-antiplatelet',
    level: 'warn',
    code: 'MED_BLEEDING_FIBRINOLYTIC',
    confidence: 'reasonable-inference',
    antiplateletClassMember: true,
    message:
      'Fibrinolytic enzyme supplements act directly on clot formation. Stacked on an SSRI it is worth raising with a pharmacist, especially before any procedure.',
  },
  {
    id: 'sert-melatonin',
    agentId: 'sertraline',
    supplementId: 'melatonin',
    supplementDisplayName: 'Melatonin',
    supplementAliases: ['melatonin'],
    mechanism: 'additive-sedation',
    level: 'info',
    code: 'MED_SEDATION_MELATONIN',
    confidence: 'reasonable-inference',
    message:
      'Melatonin alongside an SSRI is a common and generally unremarkable combination. Some people notice more grogginess. It is not a serotonin syndrome risk — melatonin sits downstream of serotonin rather than being a way of raising it.',
  },
  {
    id: 'sert-ashwagandha',
    agentId: 'sertraline',
    supplementId: 'ashwagandha',
    supplementDisplayName: 'Ashwagandha',
    supplementAliases: ['ashwagandha', 'withania', 'withania somnifera', 'ksm 66', 'sensoril'],
    mechanism: 'additive-sedation+hepatic',
    level: 'warn',
    code: 'MED_ASHWAGANDHA',
    confidence: 'reasonable-inference',
    message:
      'Two things here, neither of them serotonin syndrome. Ashwagandha has GABA-ergic activity and can add to the drowsiness of anything sedating taken at the same time of day. Separately, it carries a documented liver-injury signal — a 2020 case series in Liver International collected ten cases from Iceland and the US drug-induced liver injury network, in otherwise healthy people, one of whom was assessed for transplant. Rare, but real, and worth knowing before it becomes a daily habit. It also raises T3 and T4 and lowers TSH, which will muddle a thyroid panel. Worth raising with your prescriber or pharmacist.',
  },
  {
    id: 'fin-saw-palmetto',
    agentId: 'finasteride',
    supplementId: 'saw-palmetto',
    supplementDisplayName: 'Saw palmetto',
    supplementAliases: ['saw palmetto', 'serenoa', 'serenoa repens', 'permixon'],
    mechanism: 'pharmacodynamic-same-target',
    level: 'warn',
    code: 'MED_5AR_STACK_SAW_PALMETTO',
    confidence: 'reasonable-inference',
    invalidatesLabCorrection: ['psa-total'],
    message:
      'Saw palmetto is sold for the same purpose as finasteride and is claimed to work on the same enzyme. Two consequences. Stacking two things aimed at one enzyme means you can no longer tell what is doing what, and the combination has not been studied. More concretely for your bloods: saw palmetto lowers PSA on its own, and there is no validated adjustment for the pair — so the doubling rule we apply to your PSA stops being reliable, and the app will stop applying it and say why on the result. Worth mentioning to your prescriber; it is a common combination and it mostly goes undeclared.',
  },
  {
    id: 'fin-biotin',
    agentId: 'finasteride',
    supplementId: 'biotin-high-dose',
    supplementDisplayName: 'High-dose biotin',
    supplementAliases: ['biotin', 'vitamin b7', 'vitamin h', 'hair skin and nails'],
    mechanism: 'assay-interference',
    level: 'warn',
    code: 'MED_BIOTIN_PSA_INTERFERENCE',
    confidence: 'well-established',
    doseThreshold: { amount: 1000, unit: 'mcg' },
    invalidatesLabCorrection: ['psa-total', 'psa-free', 'testosterone-total'],
    message:
      'This one compounds, which is why it is worth reading twice. High-dose biotin interferes with the streptavidin-biotin immunoassays most labs run, and for PSA the interference is negative — it makes total and free PSA read falsely low. Finasteride is separately and genuinely halving your PSA. A falsely low result on top of a truly suppressed one is the most reassuring-looking wrong number this app could put in front of you. Biotin pushes testosterone the other way, falsely high. Hair and nail products routinely carry 5,000-10,000 mcg, many multiples of what anyone needs. The fix is timing, and supplement timing is entirely yours to set: guidance for people taking more than 5 mg a day is to leave at least 8 hours between the last dose and the blood draw, and many labs advise 48-72 hours to be safe. Tell the lab you take it.',
  },
  {
    id: 'fin-claimed-5ar-botanicals',
    agentId: 'finasteride',
    supplementId: 'claimed-5ar-botanicals',
    supplementDisplayName: 'Botanicals claimed to block 5-alpha-reductase',
    supplementAliases: [
      'pumpkin seed oil',
      'beta sitosterol',
      'stinging nettle root',
      'nettle root',
      'reishi',
      'ganoderma',
      'pygeum',
      'green tea extract',
      'egcg',
    ],
    mechanism: 'pharmacodynamic-claimed-same-target',
    level: 'info',
    code: 'MED_5AR_CLAIMED_BOTANICAL',
    confidence: 'uncertain',
    message:
      'These turn up in hair-loss stacks with claims of blocking the same enzyme finasteride blocks. The human evidence that they meaningfully do is weak, so this is a note rather than a warning. Log them anyway: if any of them do work, they move PSA in the same direction as the medication, and the PSA adjustment assumes only one thing is doing that. Green tea extract carries a separate liver-injury signal at concentrated doses.',
  },
  {
    id: 'minox-vasodilators',
    agentId: 'minoxidil-topical',
    supplementId: 'nitrate-vasodilators',
    supplementDisplayName: 'Beetroot / nitrate, citrulline, arginine',
    supplementAliases: ['beetroot', 'beet juice', 'nitrate', 'citrulline', 'l citrulline', 'arginine', 'l arginine'],
    mechanism: 'additive-physiological',
    level: 'info',
    code: 'MED_VASODILATOR_STACK',
    confidence: 'uncertain',
    message:
      'Beetroot juice and citrulline work by widening blood vessels, and so does minoxidil. In theory that stacks toward lightheadedness on standing. In practice only about 1-2% of topical minoxidil reaches the bloodstream and its blood-pressure effect at scalp doses is described as clinically insignificant in people with normal blood pressure, so this is a low-likelihood note and not a reason to change anything. It is flagged mainly because this app recommends a beetroot shot before hard sessions, and it should check its own suggestions against what you already take rather than leaving you to join it up.',
  },
  {
    id: 'any-fibre-timing',
    agentId: '*',
    supplementId: 'fibre-supplement',
    supplementDisplayName: 'Bulk-forming fibre',
    supplementAliases: [
      'psyllium',
      'psyllium husk',
      'metamucil',
      'fybogel',
      'glucomannan',
      'methylcellulose',
      'inulin',
      'acacia fibre',
      'fibre supplement',
    ],
    mechanism: 'absorption-timing',
    level: 'warn',
    code: 'SUP_TIMING_FIBRE_MEDICATION',
    confidence: 'well-established',
    message:
      'Bulk-forming fibre makes a gel in the gut, and a gel traps whatever else is in there — including tablets. Psyllium labelling says to keep other oral medicines at least two hours either side, and that is the whole fix. Take the fibre at least two hours away from anything else you swallow, before or after, whichever fits your day. Note what this is: guidance about when to take the fibre. If two hours cannot be found around your existing routine, the fibre is the thing that moves.',
  },
  {
    id: 'mineral-competition',
    agentId: '*',
    supplementId: 'mineral-competition',
    supplementDisplayName: 'Iron, zinc, calcium and magnesium together',
    supplementAliases: ['iron', 'ferrous sulphate', 'ferrous bisglycinate', 'zinc', 'calcium'],
    mechanism: 'absorption-timing',
    level: 'info',
    code: 'SUP_TIMING_MINERAL_COMPETITION',
    confidence: 'well-established',
    message:
      'Iron, zinc, calcium and magnesium compete for the same absorption routes, so taking them in one sitting means getting less of each. Two hours between iron and the others is enough. Vitamin C in the same sitting as iron works the other way and helps.',
  },
  {
    id: 'fat-soluble-timing',
    agentId: '*',
    supplementId: 'fat-soluble',
    supplementDisplayName: 'Fat-soluble vitamins and carotenoids',
    supplementAliases: ['vitamin d', 'vitamin d3', 'vitamin k1', 'phylloquinone', 'vitamin k2', 'mk 7', 'lutein', 'zeaxanthin'],
    mechanism: 'absorption-timing',
    level: 'info',
    code: 'SUP_TIMING_FAT_SOLUBLE',
    confidence: 'well-established',
    message:
      'Fat-soluble vitamins and the carotenoids absorb far better with fat present. One meal, all of them, is simpler than a schedule and works as well.',
  },
];

/**
 * Resolve free text to a canonical supplement id.
 *
 * Same loose bidirectional substring match as {@link resolveAgentId}, and for
 * the same reason. `filterReactedFoods()` in `dietary-guardrails.ts` uses the
 * identical strategy for the identical reason.
 */
export function resolveSupplementId(text: string): string | null {
  const t = normalise(text);
  if (!t) return null;
  for (const r of INTERACTIONS) {
    if (normalise(r.supplementId) === t) return r.supplementId;
    for (const alias of r.supplementAliases) {
      if (fuzzyMatch(t, normalise(alias))) return r.supplementId;
    }
  }
  return null;
}

/**
 * The stacking rule that carries the defensible bleeding warning.
 *
 * No single antiplatelet-active supplement has demonstrated additive clinical
 * bleeding risk with an SSRI, and flagging each one individually would be crying
 * wolf — which is the mechanism by which real warnings stop being read. Several
 * of them together is a different proposition and is worth a conversation.
 */
export const ANTIPLATELET_STACK_RULE = {
  code: 'MED_BLEEDING_STACK',
  level: 'warn' as FindingLevel,
  triggerCount: 2,
  confidence: 'reasonable-inference' as Confidence,
} as const;

/**
 * Supplements flagged here that ALSO need the upper-limit engine run over them.
 * This module does no UL arithmetic — see the module docblock.
 */
/**
 * Agents that are swallowed and are prescriptions. The fibre timing rule needs
 * one of these to be about; a topical and a supplement do not qualify.
 */
export const ORAL_MEDICATION_IDS: readonly string[] = ['sertraline', 'finasteride'];

export const SUPPLEMENTS_WITH_UL_CONSIDERATIONS: readonly string[] = [
  'biotin-high-dose',
  'vitamin-e-high-dose',
  'zinc',
  'selenium',
  'vitamin-d',
  'vitamin-a',
  'niacin',
  'vitamin-b6',
  'folate',
  'iron',
];

export interface CheckStackOptions {
  /** ISO date to evaluate against. Defaults to "whatever is not stopped". */
  asOf?: string;
  /** Include the absorption/timing rules that apply to any oral medication. */
  includeTimingRules?: boolean;
}

/**
 * Check a supplement stack against a medication list.
 *
 * @param meds the user's medications and supplement-class agents
 * @param supplements the user's logged supplement stack
 * @param opts evaluation date and whether to include generic timing rules
 * @returns findings, highest severity first. A single `ok` finding when the
 *   stack is clean, so callers can distinguish "checked, clean" from "not run".
 *
 * @example
 * checkStack([{ id: 'sertraline' }], [{ id: '5-htp' }]);
 * // → [ { level: 'block', code: 'MED_SEROTONERGIC_STACK_5HTP', ... } ]
 */
export function checkStack(
  meds: readonly MedicationEntry[],
  supplements: readonly SupplementEntry[],
  opts: CheckStackOptions = {},
): Finding[] {
  const out: Finding[] = [];
  const activeMeds = meds.filter((m) => isActiveOn(m, opts.asOf));
  const activeIds = new Set(activeMeds.map((m) => m.id));
  const hasAnyOralMed = activeMeds.some((m) => ORAL_MEDICATION_IDS.includes(m.id));
  const supplementIds = new Set(supplements.map((s) => s.id));
  const includeTiming = opts.includeTimingRules !== false;

  for (const rule of INTERACTIONS) {
    if (!supplementIds.has(rule.supplementId)) continue;

    if (rule.agentId === '*') {
      // Generic timing rules. The fibre rule needs an oral medication to be
      // about; the mineral and fat-soluble ones are supplement-only advice.
      if (!includeTiming) continue;
      if (rule.supplementId === 'fibre-supplement' && !hasAnyOralMed) continue;
    } else if (!activeIds.has(rule.agentId)) {
      continue;
    }

    // Dose-thresholded rules stay silent below threshold when the dose is known,
    // and fire when it is not — an unknown biotin dose in a hair product is far
    // more likely to be 5,000 mcg than 30 mcg.
    if (rule.doseThreshold) {
      const s = supplements.find((x) => x.id === rule.supplementId);
      const amount = s?.amountPerDay;
      if (typeof amount === 'number' && amount < rule.doseThreshold.amount) continue;
    }

    out.push(mk(rule.level, rule.code, rule.message));
  }

  // Antiplatelet stacking, only relevant alongside an SSRI.
  if (activeIds.has('sertraline')) {
    const stacked = INTERACTIONS.filter(
      (r) => r.antiplateletClassMember && supplementIds.has(r.supplementId),
    );
    if (stacked.length >= ANTIPLATELET_STACK_RULE.triggerCount) {
      const names = stacked.map((r) => r.supplementDisplayName);
      out.push(
        warn(
          ANTIPLATELET_STACK_RULE.code,
          `You have ${stacked.length} supplements that each nudge platelets in the same direction — ${listOf(
            names,
          )} — on top of an SSRI, which does the same thing by a different route. No one of these is a problem by itself, and the evidence on any single pairing is reassuring. Several together is worth mentioning to a pharmacist, and definitely worth mentioning before any surgery or dental work.`,
        ),
      );
    }
  }

  if (out.length === 0) return [okFinding('MED_STACK_OK')];
  const rank: Record<FindingLevel, number> = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Resolve a stack of free-text supplement entries, reporting what could not be
 * matched rather than dropping it.
 *
 * The stack is expected to arrive **partial**. A user types "hair vitamins" and
 * a brand name; the app should still run every check it can and say plainly what
 * it could not read, so the absence of a warning is never mistaken for a clean
 * result. Silence about an unrecognised product is the failure mode here.
 *
 * @param raw entries with free-text labels and/or ids
 * @returns resolved entries plus the labels that matched nothing
 */
export function resolveStack(
  raw: readonly SupplementEntry[],
): { resolved: SupplementEntry[]; unrecognised: string[] } {
  const resolved: SupplementEntry[] = [];
  const unrecognised: string[] = [];
  for (const s of raw) {
    const known = INTERACTIONS.some((r) => r.supplementId === s.id);
    if (known) {
      resolved.push(s);
      continue;
    }
    // The label is what the user actually typed; an id that is not already
    // canonical is usually a placeholder, so the label is tried first.
    const id = (s.label ? resolveSupplementId(s.label) : null) ?? resolveSupplementId(s.id);
    if (id) {
      resolved.push({ ...s, id });
    } else {
      unrecognised.push(s.label ?? s.id);
    }
  }
  return { resolved, unrecognised };
}

/**
 * Check one newly added supplement against the medication list and the stack it
 * is joining, without re-checking everything the user has already seen.
 *
 * This is the call the "add a supplement" flow makes. It returns only findings
 * the new item is responsible for — including the antiplatelet stacking finding
 * when the new item is the one that tips the count — so nothing already
 * acknowledged reappears.
 *
 * @param meds the medication list
 * @param existing the stack before this addition
 * @param added the new product
 */
export function checkNewSupplement(
  meds: readonly MedicationEntry[],
  existing: readonly SupplementEntry[],
  added: SupplementEntry,
  opts: CheckStackOptions = {},
): Finding[] {
  const before = new Set(
    checkStack(meds, existing, opts)
      .filter((f) => !f.ok)
      .map((f) => f.code),
  );
  return checkStack(meds, [...existing, added], opts).filter(
    (f) => !f.ok && !before.has(f.code),
  );
}

/* ------------------------------------------------------------------ */
/* Saying "that's your prescriber's call" out loud                     */
/* ------------------------------------------------------------------ */

/**
 * Topics on which the app declines, and what it says instead of going quiet.
 *
 * Silence reads as the app having nothing to offer. A stated boundary reads as
 * an app that knows where its lane ends — which is the stance `advice-policy.md`
 * asks for, and it is more useful besides, because it tells the user *who* to
 * ask.
 */
export type PrescriptionBoundaryTopic =
  | 'dose'
  | 'timing'
  | 'stopping'
  | 'switching'
  | 'side-effect'
  | 'interaction-with-supplement';

/**
 * The app's answer when a question lands in prescription territory.
 *
 * @returns an `info` Finding — never a `block`, because the user did nothing
 *   wrong by asking, and the answer is genuinely informative
 */
export function prescriptionBoundaryResponse(
  topic: PrescriptionBoundaryTopic,
  medicationDisplayName = 'your medication',
): Finding {
  const tail =
    ' Your prescriber or pharmacist can answer it properly, and a pharmacist is usually the faster of the two for this kind of question.';
  const bodies: Record<PrescriptionBoundaryTopic, string> = {
    dose: `Dose is your prescriber's call, not mine — that is a hard line here rather than caution.${tail}`,
    timing: `When you take ${medicationDisplayName} is your prescriber's call. What I can help with is the other side of it: supplement timing is mine, so if something in your stack needs spacing away from it, I will tell you to move the supplement.${tail}`,
    stopping: `Whether to stay on ${medicationDisplayName} is a conversation with the person who prescribed it. I will not weigh in on it in either direction.${tail}`,
    switching: `Choosing between medications is your prescriber's call.${tail}`,
    'side-effect': `I can tell you what is documented about ${medicationDisplayName} and how it affects the numbers this app tracks. What to do about a side effect is your prescriber's call.${tail}`,
    'interaction-with-supplement': `I can tell you what is known about how a supplement interacts with ${medicationDisplayName}, and I will — that is squarely my job. What I will not do is suggest changing ${medicationDisplayName} to accommodate a supplement. If they clash, the supplement is the thing that moves.${tail}`,
  };
  return info(`MED_BOUNDARY_${topic.toUpperCase().replace(/-/g, '_')}`, bodies[topic]);
}

/** The one-line version, for a UI that needs it inline. */
export const PRESCRIPTION_BOUNDARY_SHORT =
  "Anything about the prescription itself — dose, timing, whether to stay on it — is your prescriber's call, not this app's. Everything around it is fair game.";

/* ------------------------------------------------------------------ */
/* 3. Physiological confounder registry                                */
/* ------------------------------------------------------------------ */

/** Which engine has to compensate. */
export type ConfounderDomain =
  | 'weight-trend'
  | 'readiness'
  | 'hydration-electrolyte'
  | 'expenditure';

/**
 * What the consuming engine must do. Note that only ONE value permits touching
 * a number, and it is the one whose magnitude another agent already owns.
 */
export type ConfounderAction =
  /** Offer a `PerturbationEvent` to `weight-trend.ts`. Requires a real magnitude. */
  | 'offer-trend-offset'
  /** Do not shift the mean; do widen the confidence band / slow re-baselining. */
  | 'widen-uncertainty'
  /** Show as a candidate explanation only, and only when the user confirms it. */
  | 'annotate-only'
  /** Register, explain, change nothing. Used where the evidence is contested. */
  | 'do-not-adjust';

/**
 * A `PerturbationEvent`-shaped seed for `weight-trend.ts`.
 *
 * Structurally compatible with that module's exported interface, deliberately
 * duplicated as a local type rather than imported, so this module keeps its
 * zero-dependency property and so a change to weight-trend cannot silently
 * change behaviour here. `verify-medications.mjs` asserts the shape still fits.
 */
export interface PerturbationSeed {
  startDate: string;
  type: 'creatine-start' | 'creatine-stop' | 'other';
  expectedShiftKg?: number;
  settlingDays?: number;
  reversesAfterDays?: number;
  label: string;
}

export interface Confounder {
  id: string;
  agentId: string;
  domain: ConfounderDomain;
  label: string;
  /** `transition` fires on start/stop/dose-change; `persistent-baseline` is always on. */
  kind: 'transition' | 'persistent-baseline';
  action: ConfounderAction;
  /** Non-null only where a magnitude another module already owns exists. */
  perturbation: PerturbationSeed | null;
  /** Whether the app may act on this without asking the user first. */
  requiresUserConfirmation: boolean;
  evidence: Confidence;
  message: string;
  /** For deduping against events the user already logged. */
  dedupeKey: string;
}

interface ConfounderDefinition {
  id: string;
  agentId: string;
  domain: ConfounderDomain;
  label: string;
  kind: 'transition' | 'persistent-baseline';
  action: ConfounderAction;
  requiresUserConfirmation: boolean;
  evidence: Confidence;
  message: string;
  /** Days after the triggering transition during which a `transition` fires. */
  windowDays: number | null;
  perturbationType?: PerturbationSeed['type'];
  perturbationLabel?: string;
}

export const CONFOUNDER_DEFINITIONS: readonly ConfounderDefinition[] = [
  {
    id: 'sertraline-weight-drift',
    agentId: 'sertraline',
    domain: 'weight-trend',
    label: 'Slow weight drift on long-term SSRI treatment',
    kind: 'persistent-baseline',
    action: 'do-not-adjust',
    requiresUserConfirmation: false,
    evidence: 'uncertain',
    windowDays: 730,
    message:
      'Long-term SSRI treatment is associated with a slow upward drift in weight — for sertraline specifically, on the order of a kilo or so over a couple of years in cohort studies, which is the low end for this class of medication. It is small, it is slow, and it is not a reason to change anything. It is worth knowing only so that a stubborn trend does not get read as a logging failure. We are not adjusting your trend for it: the effect is about the same size as a fortnight of normal progress and it is measured with far less precision than your scale, so subtracting it would make the estimate worse, not better.',
  },
  {
    id: 'sertraline-sweating',
    agentId: 'sertraline',
    domain: 'hydration-electrolyte',
    label: 'Antidepressant-induced excessive sweating',
    kind: 'persistent-baseline',
    action: 'widen-uncertainty',
    requiresUserConfirmation: false,
    evidence: 'reasonable-inference',
    windowDays: null,
    message:
      'Sweating more on an SSRI is common — estimates run from about one in twenty to one in five people, and it comes from the brain’s thermostat rather than from the skin. Two practical consequences. Your weigh-ins will bounce around a bit more than average, so the trend line is what to read, not the day. And on hard conditioning sessions, replacing heavy sweat losses with plain water alone is the combination most likely to push sodium down — so get salt in alongside the fluid rather than drinking to a schedule.',
  },
  {
    id: 'sertraline-autonomic',
    agentId: 'sertraline',
    domain: 'readiness',
    label: 'Possible shift in resting heart rate / HRV baseline',
    kind: 'transition',
    action: 'do-not-adjust',
    requiresUserConfirmation: false,
    evidence: 'uncertain',
    windowDays: 90,
    message:
      'Whether SSRIs shift heart-rate variability is genuinely unsettled — the largest meta-analysis found no effect, while some cohort studies found a small reduction. We are not adjusting your readiness score for it, because adjusting by an unknown amount is worse than not adjusting at all. What it does mean in practice: readiness is measured against your own baseline, so a stable long-standing dose changes nothing day to day. If the dose has recently changed, give the baseline a few weeks to re-settle before reading much into it.',
  },
  {
    id: 'sertraline-thermoregulation',
    agentId: 'sertraline',
    domain: 'readiness',
    label: 'Thermoregulation during hard training in the heat',
    kind: 'persistent-baseline',
    action: 'do-not-adjust',
    requiresUserConfirmation: false,
    evidence: 'uncertain',
    windowDays: null,
    message:
      'Serotonin is part of how the brain regulates temperature, and more sweating is the visible end of that. Whether it actually makes hard training in the heat harder is not established, so we are not going to pretend it does or dock your session for it. The practical advice is the same as for the sweating: sodium alongside the fluid.',
  },
  {
    id: 'minoxidil-fluid-retention',
    agentId: 'minoxidil-topical',
    domain: 'weight-trend',
    label: 'Possible fluid retention from systemically absorbed topical minoxidil',
    kind: 'transition',
    action: 'annotate-only',
    requiresUserConfirmation: true,
    evidence: 'uncertain',
    windowDays: 60,
    message:
      'You started topical minoxidil recently, which is one candidate explanation for a step up on the scale that your food log does not account for. Being straight about how strong this is: minoxidil taken as a tablet causes fluid retention reliably, but only about 1-2% of what goes on your scalp reaches the bloodstream, and fluid retention from the topical version sits at the level of individual case reports rather than something trials measure. So hold this loosely — it is a possibility, not a finding. If it is fluid, it appears within weeks and then stops climbing. We are not putting a number on it or subtracting anything from your trend, because there is no honest number to use.',
  },
  {
    id: 'minoxidil-heart-rate',
    agentId: 'minoxidil-topical',
    domain: 'readiness',
    label: 'Possible mild heart-rate elevation from topical minoxidil',
    kind: 'transition',
    action: 'annotate-only',
    requiresUserConfirmation: true,
    evidence: 'uncertain',
    windowDays: 60,
    message:
      'A step up in resting heart rate within a couple of months of starting topical minoxidil is worth noting, though the honest position is that this is much better documented for the tablet than for the scalp solution — controlled trials of topical minoxidil have not shown extra cardiac events. If your resting heart rate has genuinely moved and training does not explain it, that is worth mentioning to a clinician rather than filing under "probably the minoxidil".',
  },
  {
    id: 'creatine-water-retention',
    agentId: 'creatine',
    domain: 'weight-trend',
    label: 'Intracellular water gain from creatine',
    kind: 'transition',
    action: 'offer-trend-offset',
    requiresUserConfirmation: false,
    evidence: 'reasonable-inference',
    windowDays: 28,
    perturbationType: 'creatine-start',
    perturbationLabel: 'Creatine started',
    message:
      'The 1-2 kg that appears in the first weeks on creatine is water inside muscle cells, not fat. Your trend line already accounts for it, and it is not a reason to widen the deficit to cancel it out.',
  },
];

/**
 * Which confounders are live for this medication list on this date.
 *
 * The design rule worth stating explicitly, because it is the thing a naive
 * implementation gets wrong: **a stable chronic medication is not a confounder
 * of change — it is a shift in baseline.** Readiness and trend engines compare
 * against the user's own recent history, and a constant offset cancels out of
 * that comparison. Confounders therefore fire on *transitions* (start, stop,
 * dose change), except for the handful whose effect is a persistent change in
 * day-to-day variance rather than in level — sweating is the example.
 *
 * @param meds the user's medication list, with `startedOn` where known
 * @param date ISO date to evaluate
 * @returns live confounders; `[]` is the expected steady-state answer for a user
 *   whose medications have all been stable for years
 */
export function activeConfounders(
  meds: readonly MedicationEntry[],
  date: string,
): Confounder[] {
  const out: Confounder[] = [];

  for (const def of CONFOUNDER_DEFINITIONS) {
    const m = meds.find((x) => x.id === def.agentId);
    if (!m) continue;
    if (!isActiveOn(m, date) && def.kind === 'persistent-baseline') continue;

    if (def.kind === 'transition') {
      const anchor = m.doseChangedOn ?? m.stoppedOn ?? m.startedOn;
      if (!anchor) continue;
      const elapsed = daysBetween(anchor, date);
      if (elapsed === null || elapsed < 0) continue;
      if (def.windowDays !== null && elapsed > def.windowDays) continue;
    } else if (def.windowDays !== null && m.startedOn) {
      // A bounded persistent effect (the weight drift) stops being offered as an
      // explanation once treatment is long-standing and the trend has settled.
      const elapsed = daysBetween(m.startedOn, date);
      if (elapsed !== null && elapsed > def.windowDays) continue;
    }

    out.push({
      id: def.id,
      agentId: def.agentId,
      domain: def.domain,
      label: def.label,
      kind: def.kind,
      action: def.action,
      perturbation:
        def.action === 'offer-trend-offset' && def.perturbationType && m.startedOn
          ? {
              startDate: m.startedOn,
              type: def.perturbationType,
              label: def.perturbationLabel ?? def.label,
            }
          : null,
      requiresUserConfirmation: def.requiresUserConfirmation,
      evidence: def.evidence,
      message: def.message,
      dedupeKey: `${def.agentId}:${def.id}:${m.startedOn ?? 'unknown'}`,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Copy lint — Tier 3 rule 1, enforced rather than asserted            */
/* ------------------------------------------------------------------ */

/**
 * Phrases that would constitute advice about a prescribed medication.
 *
 * This is a blunt instrument and that is the point: it is cheaper to reword a
 * false positive than to ship a sentence that tells someone to change their
 * dose. `verify-medications.mjs` runs it over every user-facing string in this
 * module and over `medication-effects.json`.
 */
export const FORBIDDEN_COPY_PATTERNS: readonly RegExp[] = [
  /\b(stop|start|reduce|increase|lower|raise|halve|double|adjust|change|skip|pause|hold|come off|taper|wean)\s+(your|the|taking)\s+(sertraline|finasteride|minoxidil|medication|dose|prescription|tablet)/i,
  /\b(take|move|shift)\s+your\s+(sertraline|finasteride|minoxidil|medication|dose|tablet)\s+(at|to|in|earlier|later|before|after)/i,
  /\b(switch|swap)\s+(to|from)\s+(another|a different)\s+(ssri|antidepressant|medication)/i,
  /\byou (should|could|might want to|may want to) (stop|start|reduce|increase|change) (taking )?(your )?(sertraline|finasteride|minoxidil|medication|dose)/i,
  /\b(don't|do not|avoid) (taking|take) your (sertraline|finasteride|minoxidil|medication)/i,
];

/**
 * Assert a user-facing string does not advise on a prescribed medication.
 *
 * @returns `null` when clean, or the offending pattern's source when not
 */
export function assertNoMedicationDirective(text: string): string | null {
  for (const p of FORBIDDEN_COPY_PATTERNS) {
    if (p.test(text)) return p.source;
  }
  return null;
}

/**
 * Every user-facing string this module can emit. Used by the copy lint.
 *
 * The lint is deliberately syntactic, so a sentence that *refuses* to give
 * medication advice reads to it much like one that gives it. Refusal copy —
 * everything from {@link prescriptionBoundaryResponse} — is therefore worded to
 * pass the lint and is additionally reviewed by hand; the lint is a floor, not a
 * substitute for reading it.
 */
export function allUserFacingCopy(): string[] {
  const topics: PrescriptionBoundaryTopic[] = [
    'dose',
    'timing',
    'stopping',
    'switching',
    'side-effect',
    'interaction-with-supplement',
  ];
  return [
    ...LAB_EFFECTS.map((e) => e.message),
    ...INTERACTIONS.map((r) => r.message),
    ...CONFOUNDER_DEFINITIONS.map((c) => c.message),
    ...topics.map((t) => prescriptionBoundaryResponse(t).message),
    PRESCRIPTION_BOUNDARY_SHORT,
  ];
}

/* ------------------------------------------------------------------ */
/* Convenience                                                         */
/* ------------------------------------------------------------------ */

export interface MedicationAwarenessResult {
  stackFindings: Finding[];
  confounders: Confounder[];
  /** Analytes whose interpretation changes, for the labs screen to pre-flag. */
  affectedAnalytes: { analyteId: string; agentId: string; hasCorrection: boolean }[];
}

/**
 * Everything this module knows about one user, in one call. The individual
 * functions stay exported for targeted use and testing.
 */
export function assessMedicationAwareness(
  meds: readonly MedicationEntry[],
  supplements: readonly SupplementEntry[],
  date: string,
): MedicationAwarenessResult {
  const activeIds = new Set(meds.filter((m) => isActiveOn(m, date)).map((m) => m.id));
  return {
    stackFindings: checkStack(meds, supplements, { asOf: date }),
    confounders: activeConfounders(meds, date),
    affectedAnalytes: LAB_EFFECTS.filter(
      (e) => activeIds.has(e.agentId) && e.flagBehaviour !== 'no-effect',
    ).map((e) => ({
      analyteId: e.analyteId,
      agentId: e.agentId,
      hasCorrection: e.correctionFactor !== null,
    })),
  };
}
