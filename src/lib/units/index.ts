/**
 * Units.
 *
 * The rule: **everything is stored in SI and converted only for display.**
 *
 * Body mass in kilograms, length in centimetres, volume in millilitres,
 * distance in metres, temperature in Celsius — in the vault, in the algorithms,
 * and in every function signature. The user sees pounds, feet and inches,
 * fluid ounces and miles.
 *
 * This is not fussiness. Three concrete reasons:
 *   1. The nutrition algorithms use kcal-per-kg-of-tissue constants. Storing
 *      pounds would mean converting on every iteration of the trend filter and
 *      the expenditure estimator, and rounding drift accumulates.
 *   2. Apple Health exports carry explicit units and are usually metric. One
 *      conversion at ingest beats one per read.
 *   3. Changing the display preference must never alter stored data. If the
 *      vault held pounds, flipping the toggle would either rewrite every row
 *      or leave the units ambiguous.
 *
 * Macronutrients stay in **grams** in both systems — that is what US nutrition
 * labels use, so converting them to ounces would be actively worse.
 */

export type UnitSystem = "imperial" | "metric";

/** US customary is the default: this app was built for a US user. */
export const DEFAULT_UNIT_SYSTEM: UnitSystem = "imperial";

// --- exact conversion factors ----------------------------------------------
const KG_PER_LB = 0.45359237; // exact, by definition
const CM_PER_INCH = 2.54; // exact
const ML_PER_FL_OZ = 29.5735295625; // US fluid ounce, exact
const G_PER_OZ = 28.349523125; // avoirdupois, exact
const M_PER_MILE = 1609.344; // exact

// --- mass -------------------------------------------------------------------

export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const gToOz = (g: number): number => g / G_PER_OZ;
export const ozToG = (oz: number): number => oz * G_PER_OZ;

// --- length -----------------------------------------------------------------

export const cmToIn = (cm: number): number => cm / CM_PER_INCH;
export const inToCm = (inches: number): number => inches * CM_PER_INCH;

/** Centimetres to whole feet plus remaining inches, e.g. 180 cm → 5'11". */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = cmToIn(cm);
  let feet = Math.floor(totalInches / 12);
  let inches = Math.round(totalInches - feet * 12);
  // Rounding 11.6" up to 12" must roll over into the next foot.
  if (inches === 12) {
    feet += 1;
    inches = 0;
  }
  return { feet, inches };
}

export const feetInchesToCm = (feet: number, inches: number): number =>
  inToCm(feet * 12 + inches);

// --- volume -----------------------------------------------------------------

export const mlToFlOz = (ml: number): number => ml / ML_PER_FL_OZ;
export const flOzToMl = (flOz: number): number => flOz * ML_PER_FL_OZ;

// --- distance ---------------------------------------------------------------

export const mToMi = (m: number): number => m / M_PER_MILE;
export const miToM = (mi: number): number => mi * M_PER_MILE;
export const mToKm = (m: number): number => m / 1000;

// --- temperature ------------------------------------------------------------

export const cToF = (c: number): number => c * 1.8 + 32;
export const fToC = (f: number): number => (f - 32) / 1.8;

// --- formatting -------------------------------------------------------------

/** Trailing-zero-free fixed formatting: 182.0 → "182", 182.4 → "182.4". */
function trim(value: number, digits: number): string {
  const s = value.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export interface Formatted {
  /** The number alone, e.g. "182.4". Use where the unit is a separate label. */
  value: string;
  unit: string;
  /** Value and unit together, e.g. "182.4 lb". */
  text: string;
}

/**
 * Body mass for display.
 *
 * One decimal place, deliberately. Body weight moves by fractions of a pound
 * day to day and the trend filter needs that resolution to be visible — but
 * two decimals invites reading noise as signal.
 */
export function formatBodyMass(kg: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    return { value: trim(kg, 1), unit: "kg", text: `${trim(kg, 1)} kg` };
  }
  const lb = kgToLb(kg);
  return { value: trim(lb, 1), unit: "lb", text: `${trim(lb, 1)} lb` };
}

/**
 * A *change* in body mass, always signed.
 *
 * Separate from `formatBodyMass` because the sign carries meaning here and
 * must never be dropped — "0.4 lb" and "−0.4 lb" are opposite outcomes.
 */
export function formatBodyMassDelta(
  kg: number,
  system: UnitSystem
): Formatted {
  const converted = system === "metric" ? kg : kgToLb(kg);
  const unit = system === "metric" ? "kg" : "lb";
  const sign = converted > 0 ? "+" : converted < 0 ? "−" : "";
  const body = trim(Math.abs(converted), 1);
  return { value: `${sign}${body}`, unit, text: `${sign}${body} ${unit}` };
}

/** Height. Imperial renders as feet and inches, e.g. 5'11". */
export function formatHeight(cm: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    return { value: trim(cm, 0), unit: "cm", text: `${trim(cm, 0)} cm` };
  }
  const { feet, inches } = cmToFeetInches(cm);
  const text = `${feet}'${inches}"`;
  return { value: text, unit: "", text };
}

/**
 * Food portion mass.
 *
 * Grams are shown in both systems below an ounce, because that is the
 * resolution nutrition labels use and rounding 12 g to 0.4 oz loses accuracy
 * that matters when logging.
 */
export function formatFoodMass(g: number, system: UnitSystem): Formatted {
  if (system === "metric" || g < G_PER_OZ) {
    return { value: trim(g, g < 10 ? 1 : 0), unit: "g", text: `${trim(g, g < 10 ? 1 : 0)} g` };
  }
  const oz = gToOz(g);
  return { value: trim(oz, 1), unit: "oz", text: `${trim(oz, 1)} oz` };
}

/** Liquid volume. */
export function formatVolume(ml: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    return { value: trim(ml, 0), unit: "ml", text: `${trim(ml, 0)} ml` };
  }
  const flOz = mlToFlOz(ml);
  return { value: trim(flOz, 1), unit: "fl oz", text: `${trim(flOz, 1)} fl oz` };
}

/** Distance covered — runs, rides, sled work, walks. */
export function formatDistance(m: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    const km = mToKm(m);
    return km < 1
      ? { value: trim(m, 0), unit: "m", text: `${trim(m, 0)} m` }
      : { value: trim(km, 2), unit: "km", text: `${trim(km, 2)} km` };
  }
  const mi = mToMi(m);
  if (mi < 0.1) {
    // Short efforts — sled pushes, shuttles — read better in yards.
    const yd = m * 1.0936133;
    return { value: trim(yd, 0), unit: "yd", text: `${trim(yd, 0)} yd` };
  }
  return { value: trim(mi, 2), unit: "mi", text: `${trim(mi, 2)} mi` };
}

/** Load on the bar. Plates are imperial in US gyms, so this rounds sensibly. */
export function formatLoad(kg: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    return { value: trim(kg, 1), unit: "kg", text: `${trim(kg, 1)} kg` };
  }
  const lb = kgToLb(kg);
  // Gym loads land on 2.5 lb increments; showing 137.8 lb is noise.
  const rounded = Math.round(lb * 2) / 2;
  return { value: trim(rounded, 1), unit: "lb", text: `${trim(rounded, 1)} lb` };
}

export function formatTemperature(c: number, system: UnitSystem): Formatted {
  if (system === "metric") {
    return { value: trim(c, 1), unit: "°C", text: `${trim(c, 1)}°C` };
  }
  const f = cToF(c);
  return { value: trim(f, 0), unit: "°F", text: `${trim(f, 0)}°F` };
}

/**
 * Pace, for conditioning work.
 * Minutes per mile in imperial, minutes per kilometre in metric.
 */
export function formatPace(
  metresPerSecond: number,
  system: UnitSystem
): Formatted {
  if (metresPerSecond <= 0) return { value: "—", unit: "", text: "—" };
  const secondsPerUnit =
    system === "metric" ? 1000 / metresPerSecond : M_PER_MILE / metresPerSecond;
  const minutes = Math.floor(secondsPerUnit / 60);
  const seconds = Math.round(secondsPerUnit - minutes * 60);
  const unit = system === "metric" ? "/km" : "/mi";
  const text = `${minutes}:${String(seconds).padStart(2, "0")}${unit}`;
  return { value: `${minutes}:${String(seconds).padStart(2, "0")}`, unit, text };
}

/**
 * Parse a user-entered body mass in their own units back to kilograms.
 * Returns `null` for anything unparseable, so callers must handle it rather
 * than silently storing NaN.
 */
export function parseBodyMass(input: string, system: UnitSystem): number | null {
  const n = Number.parseFloat(input.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return system === "metric" ? n : lbToKg(n);
}

/** Labels for input fields, so screens don't hardcode unit strings. */
export function unitLabel(
  quantity: "bodyMass" | "load" | "height" | "distance" | "volume" | "temperature",
  system: UnitSystem
): string {
  const metric = system === "metric";
  switch (quantity) {
    case "bodyMass":
    case "load":
      return metric ? "kg" : "lb";
    case "height":
      return metric ? "cm" : "ft / in";
    case "distance":
      return metric ? "km" : "mi";
    case "volume":
      return metric ? "ml" : "fl oz";
    case "temperature":
      return metric ? "°C" : "°F";
  }
}
