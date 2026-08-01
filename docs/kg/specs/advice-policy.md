# Advice Policy

**Normative. Every screen that renders a recommendation implements this.**

## The problem this solves

An app that displays a number and says "consult your doctor" has told the user
nothing they couldn't read off the PDF themselves. Disclaimers are cheap; useful
steer is the product. The user has asked for real recommendations and that is
the right call — so this document replaces vague caution with explicit tiers.

The app's stance: **be a well-read coach who tells you what they'd do and why,
is honest about confidence, and knows where their lane ends.**

---

## The boundary, stated once

The user's own framing, and it is the right one: **prescribed medication is the
doctor's, everything else is fair game.**

So the hard boundary is narrow and specific — prescriptions, naming a diagnosis,
and critical values (§Tier 3). It is not a general licence to hedge. Outside
those, the app should be *generous and direct*: supplements with named compounds
and doses, nutrition targets, training prescriptions, conditioning protocols,
sleep and recovery guidance. If a knowledgeable coach or dietitian would say it
without hesitating, say it.

Hedging everything to feel safe is its own failure. It makes the app useless,
which is not a neutral outcome — it just moves the user to worse sources.

## Tier 1 — Recommend directly

No hedging, no "consider possibly." State the recommendation, the reasoning, and
the confidence. All of this is squarely within what a good coach, trainer or
sports dietitian gives every day.

- **Training**: programming, volume, intensity, load progression, exercise
  selection and substitution, deloads, conditioning prescription, technique cues.
- **Nutrition**: calorie and macro targets, protein/fat/fibre floors, meal
  timing, pre- and intra-workout fuelling, hydration and electrolytes.
- **Supplements for identified gaps**: name the supplement, give a dose range and
  timing, and say what it's closing. Run the upper-limit check first (see below).
- **Lab context**: interpret a value against the lab's own reference range *and*
  against athlete- or goal-relevant ranges where a defensible one exists — say
  which is which. Explain what typically moves the number in each direction.
- **"What I'd change this week"**: concrete, specific, actionable. This is the
  whole point of the app.

Every Tier 1 output must carry: the reasoning, the inputs that drove it, and a
confidence tag (`[well-established]` / `[reasonable-inference]` / `[uncertain]`).

## Tier 2 — Recommend, with the caveat stated plainly

Same directness, plus one sentence naming the specific uncertainty. Not a generic
disclaimer — a concrete one the user can act on.

- An out-of-range lab with several plausible causes → give the most likely
  explanations and what would distinguish them, and say a clinician can settle it.
- A dose approaching the tolerable upper intake level.
- A recommendation that interacts with a condition or medication the user has
  logged.
- Anything where the evidence is genuinely contested — say so and give the
  default with rationale.

## Tier 3 — Don't, and say why

Short list, and the app states the reason rather than going silent.

1. **Never suggest starting, stopping, or changing the dose of a prescribed
   medication.** Not hedged — not at all.
2. **Never name a diagnosis.** "Your TSH is above range and has risen across
   three draws; thyroid function is what that panel measures, and a clinician
   can tell you whether it means anything" — not "you have hypothyroidism."
3. **Critical values get an urgent prompt, not an explanation.** Far-out-of-range
   results that can indicate an emergency surface as "this needs a doctor
   promptly" with no interpretation attached, because a reassuring-sounding
   explanation is the dangerous failure mode here.
4. **Never contradict an explicit clinical instruction the user has logged.** If
   they've recorded that a clinician told them something, the app defers and says
   it's deferring.
5. **Never tell the user a food is safe to eat** given a diagnosed allergy. It may
   explain mechanisms (e.g. that PR-10 proteins are heat-labile and nsLTPs are
   not) — that's education, and it's useful. Clearing a specific food is not.

## Always-on guardrails

These bound Tier 1 and 2 output regardless of how confident the engine is:

- Bounded adjustments — see `training-methodology.md` §8.5 and
  `nutrition-algorithms.md` §Safety. The engine proposes, the guardrails dispose.
- Upper-limit checking on every supplement recommendation, accounting for the
  user's whole logged stack. Stacking a multivitamin with singles is the common
  way to exceed a UL.
- Rate-limiting: targets don't oscillate, and low estimator confidence
  suppresses aggressive changes.
- The eating-disorder-aware rules in `nutrition-personalization.md` are not
  overridable by any recommendation tier.
- Never celebrate weight loss unconditionally; never reward a larger deficit.

## Tone

Matter-of-fact. A recommendation reads like a knowledgeable friend who has done
the reading — not like a legal department, and not like a wellness brand.

Say "your ferritin is 18 — that's inside your lab's range but low for someone
chasing VO2 max, and iron status is one of the few things that measurably caps
endurance. Worth retesting with transferrin saturation before supplementing,
because iron overload is a real risk and you can't tell from ferritin alone."

Not "your ferritin value falls within normal limits. Consult your healthcare
provider."

The disclaimer belongs once, in Settings and at onboarding. Not stapled to every
sentence, where it trains the user to ignore it.
