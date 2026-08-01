/**
 * @file Every user-facing string on the nutrition diary, in one place.
 *
 * ## Why the copy lives in a constant table rather than inline in JSX
 *
 * `docs/kg/specs/nutrition-personalization.md` §3.4 makes a set of design
 * requirements normative and machine-checked: `checkDaySummaryCopy()` in
 * `@/lib/algorithms/dietary-guardrails` `block`s day-summary strings that
 * congratulate a deficit, and the test in `__tests__/` runs it over **every
 * string exported here**. That check is only worth anything if there is a
 * single enumerable set of strings to run it over — copy scattered through ten
 * components is copy nobody lints.
 *
 * ## The rules this file follows
 *
 * 1. **Report what has been eaten. Never "remaining", never "left".** Budget
 *    framing constructs eating as overspending and exceeding as failure. The
 *    word "remaining" does not appear in this file and a test asserts it.
 * 2. **Over-target is neutral information.** No red, no warning tone, no
 *    apology. `OVER_TARGET_NOTE` is deliberately flat.
 * 3. **Nothing celebrates a low day.** Not even implicitly — no "on track",
 *    which is praise wearing a neutral hat.
 * 4. **Adequacy language is about floors being reached, never about a ceiling
 *    being respected.**
 * 5. **A food log measures intake, not nutritional status.** Where the copy
 *    touches a nutrient it says so.
 */

import type { MealSlot } from '@/lib/db/types';
import type { TrackingSafetyConfig } from '@/lib/algorithms';

/**
 * The tracking-safety configuration this screen actually runs with.
 *
 * Not a preference blob: the `false` literals are the type. `hideCalories` is
 * the one genuine user choice, and it is supplied at runtime — the value here
 * is only the default a fresh install starts from.
 *
 * `validateTrackingSafety()` is run over this in the test suite, so a future
 * edit that turns on streaks or celebration fails the build rather than
 * shipping.
 */
export const NUTRITION_SAFETY_DEFAULTS: TrackingSafetyConfig = {
  hideCalories: false,
  adequacyProminence: 'equal-or-greater',
  gamification: false,
  streaks: false,
  celebrateUnderBudget: false,
  weightProjections: false,
};

/** Meal-slot labels, in the order the day view renders them. */
export const SLOT_LABELS: Readonly<Record<MealSlot, string>> = {
  breakfast: 'Breakfast',
  preworkout: 'Before training',
  lunch: 'Lunch',
  postworkout: 'After training',
  dinner: 'Dinner',
  snack: 'Snacks',
};

/** Render order for meal sections. Matches `foodLogs.getForDate()`. */
export const SLOT_ORDER: readonly MealSlot[] = [
  'breakfast',
  'preworkout',
  'lunch',
  'postworkout',
  'dinner',
  'snack',
];

/**
 * Screen-level copy.
 *
 * Every value is either a string or a function returning one. The test walks
 * this object recursively, calls each function with representative arguments,
 * and runs `checkDaySummaryCopy` over the result.
 */
export const DIARY_COPY = {
  title: 'Food',
  subtitle: 'What you ate today',
  locked: 'Unlock the vault to see your diary.',
  loading: 'Loading your diary…',
  unavailable: 'Your diary could not be read. Nothing has been treated as unlogged.',
  done: 'Done',
  brandPlaceholder: 'Brand (optional)',
  optional: 'optional',

  // --- day totals ---------------------------------------------------------
  eatenHeading: 'Eaten so far',
  eatenNothingYet: 'Nothing logged yet today.',
  energyLabel: 'Energy',
  targetReference: (kcal: number) => `Target ${kcal.toLocaleString('en-US')} kcal`,
  /**
   * Shown when intake is above the energy target. Flat by construction: this
   * is the string most likely to acquire a tone during polish work, and the
   * one where tone does the most harm.
   */
  overTargetNote: (kcal: number) =>
    `${kcal.toLocaleString('en-US')} kcal above the target. That is information, not a problem to fix.`,
  caloriesHiddenNote:
    'Energy numbers are switched off. Protein, fibre and nutrient adequacy still work exactly as before.',

  // --- macros -------------------------------------------------------------
  proteinLabel: 'Protein',
  carbLabel: 'Carbs',
  fatLabel: 'Fat',
  fiberLabel: 'Fibre',
  gramsSuffix: 'g',
  ofTarget: (target: number) => `of ${Math.round(target)} g`,

  // --- adequacy -----------------------------------------------------------
  adequacyHeading: 'Adequacy',
  adequacySubtitle: 'Floors worth reaching',
  proteinFloorMet: 'Protein floor reached.',
  proteinFloorShort: (shortG: number) =>
    `${Math.round(shortG)} g of protein short of the floor so far today.`,
  fiberFloorMet: 'Fibre floor reached.',
  fiberFloorShort: (shortG: number) =>
    `${Math.round(shortG)} g of fibre short of the floor so far today.`,
  intakeNotStatus:
    'This is what you ate, not what is in your blood. A food log can point at a likely gap; only a blood test can confirm one.',
  micronutrientSuppressed: (n: number) =>
    n === 1
      ? '1 item today has no nutrient data, so this check is switched off rather than guessed at.'
      : `${n} items today have no nutrient data, so this check is switched off rather than guessed at.`,
  micronutrientNoData:
    'None of today’s foods carry nutrient data, so there is nothing to assess yet.',
  upperLimitExceeded: (name: string, intake: string, limit: string) =>
    `${name}: ${intake} today, against an upper limit of ${limit}. Worth knowing — this one is about the form in the food, not about eating too much.`,
  supplementsNote:
    'Supplements you take are not counted here yet. Add them in Settings when that screen lands.',

  // --- targets ------------------------------------------------------------
  targetsHeading: 'Targets',
  targetsInsufficient: 'Not enough data to set a target yet.',
  targetsInsufficientDetail: (missing: readonly string[]) =>
    `Still needed: ${missing.join(', ')}. Until then the diary records what you eat and checks the protein and fibre floors, which do not depend on a target.`,
  targetsBlocked:
    'Targets are switched off for now. The safety checks in this app returned something that has to be looked at by a person, not worked around by an app.',
  targetsSource: (confidence: string) =>
    `From your logged intake and weight trend (confidence: ${confidence}).`,
  targetsColdStart:
    'Estimated from your height, weight and age. It will get more accurate as you log.',

  // --- logging ------------------------------------------------------------
  addFood: 'Add food',
  searchPlaceholder: 'Search 1,557 foods',
  searchEmptyHint: 'Start typing. Search works offline.',
  searchNoResults: (query: string) =>
    `Nothing matched “${query}”. You can add it as a custom food.`,
  recentHeading: 'Recent',
  frequentHeading: 'You log these often',
  unverifiedBadge: 'Estimate',
  unverifiedNote:
    'These figures are an estimate rather than a published label. Correct them if you have the packet.',
  openFoodFactsNote:
    'Open Food Facts is crowd-sourced and unverified. Check these figures against the packet before relying on them.',
  rawCookedNote:
    'Raw and cooked are separate entries. Cooking drives off water, so the same meat is about 40% denser once cooked — pick the one that matches what you ate.',
  restaurantNote:
    'Restaurant figures come from published panels divided by a published item weight, and chains reformulate. Log these by the named item rather than by grams.',

  portionHeading: 'How much?',
  servingsHeading: 'Servings',
  customAmount: 'Type an amount',
  gramsUnit: 'g',
  ouncesUnit: 'oz',
  slotHeading: 'Which meal',
  saveEntry: 'Add to diary',
  updateEntry: 'Save changes',
  removeEntry: 'Remove',

  // --- quick actions ------------------------------------------------------
  quickHeading: 'Quick add',
  repeatYesterday: 'Repeat yesterday',
  repeatYesterdayEmpty: 'Nothing was logged yesterday.',
  repeatYesterdayDetail: (n: number, slots: number) =>
    `${n} ${n === 1 ? 'item' : 'items'} across ${slots} ${slots === 1 ? 'meal' : 'meals'}.`,
  customFood: 'Custom food',
  customFoodDetail: 'Type the numbers off a packet.',
  customFoodName: 'Name',
  customFoodBasis: 'Per 100 g',
  customFoodSaved: 'Saved. It will show up in search from now on.',

  // --- settings -----------------------------------------------------------
  settingsRow: 'Display and safety settings',
  settingsHeading: 'Display and safety',
  settingsIntro:
    'These can be changed at any time, in either direction. Nothing here is a one-off question.',
  hideCaloriesLabel: 'Hide energy numbers',
  hideCaloriesDetail:
    'Turns off every calorie figure in the app. Protein, fibre and nutrient adequacy keep working. Some people track better without the energy number in front of them; if that is you, this is not a compromise.',
  reOfferHeading: 'A setting worth knowing about',
  reOfferBody:
    'Energy numbers can be switched off entirely, with everything else still working. It is in Display and safety, and it can be switched back on just as easily.',
  reOfferDismiss: 'Not now',
  reOfferOpen: 'Open settings',

  // --- under-eating -------------------------------------------------------
  underEatingHeading: 'Worth a look',

  // --- disclaimers --------------------------------------------------------
  notMedicalAdvice:
    'Not medical advice. This app estimates; it does not diagnose, and it does not replace a dietitian or a doctor.',
} as const;

/**
 * Every string this module can produce, flattened.
 *
 * Exists so the copy lint has something to iterate. Functions are invoked with
 * representative arguments — the lint cares about the constant fragments around
 * the interpolation, and those are what a careless edit changes.
 */
export function allCopyStrings(): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      // Representative arguments. Every copy function in this file takes
      // numbers, strings or string arrays, so this covers all of them.
      const attempts: unknown[][] = [
        [1200],
        [1],
        [2],
        ['Vitamin A', '3,400 mcg', '3,000 mcg'],
        [['a weigh-in', 'your height']],
        [1200, 2],
      ];
      for (const args of attempts) {
        try {
          const result = fn(...args);
          if (typeof result === 'string') out.push(result);
        } catch {
          // A signature this attempt does not fit. Another attempt will.
        }
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(DIARY_COPY);
  visit(SLOT_LABELS);
  return out;
}
