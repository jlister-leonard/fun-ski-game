import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRADEOFF_COPY } from "@/lib/training/program";
import { LIMITS } from "@/lib/algorithms/guardrails";
import { toAboutAnswers, toBirthDate, type AboutDraft } from "../AboutStep";
import { STEP_COPY, skippedCopy } from "../copy";
import {
  EMPTY_GOALS,
  conflictCopy,
  defaultRateText,
  readRate,
} from "../GoalsStep";
import { creatineStartDate, mentionsCreatine } from "../HealthStep";
import { requiresInstallBeforeVault } from "../InstallStep";
import {
  EMPTY_TRAINING_DRAFT,
  SEED_LIFTS,
  toTrainingIntake,
} from "../TrainingStep";
import { INTAKE_STEPS } from "../store";
import type { AboutAnswers } from "../store";

/**
 * The intake's arithmetic and its copy.
 *
 * Two kinds of assertion here, and the second matters as much as the first.
 *
 * The conversions are tested because every one of them is a place a pound can
 * be stored as a kilogram — `AGENTS.md` is explicit that display is US
 * customary and storage is SI, and the boundary is exactly these functions.
 *
 * The copy is tested because `nutrition-personalization.md` §3.4 is normative
 * and not overridable by any later change: no streaks, no gamification, and
 * never framing eating less or losing weight as an achievement. A copy lint is
 * the only thing that keeps a well-meaning edit from reintroducing "great job"
 * in six months, and the spec's own verification script uses the same
 * technique.
 */

const ABOUT: AboutDraft = {
  sex: "male",
  month: "6",
  day: "14",
  year: "1988",
  feet: "5",
  inches: "11",
  cm: "",
  weight: "187.4",
  bodyFat: "21",
  bodyFatMethod: "dexa",
};

describe("iOS install-before-vault gate", () => {
  const IPHONE_BROWSER = {
    standalone: false,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15",
    maxTouchPoints: 5,
  };

  it("requires installation before an iPhone browser may create a vault", () => {
    expect(requiresInstallBeforeVault(IPHONE_BROWSER)).toBe(true);
  });

  it("recognises iPadOS even when it identifies itself as a Mac", () => {
    expect(
      requiresInstallBeforeVault({
        standalone: false,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      })
    ).toBe(true);
  });

  it("allows setup after the iOS Home Screen app is launched", () => {
    expect(
      requiresInstallBeforeVault({
        ...IPHONE_BROWSER,
        standalone: true,
      })
    ).toBe(false);
  });

  it("does not block desktop, Android, or non-browser rendering", () => {
    expect(
      requiresInstallBeforeVault({
        standalone: false,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        maxTouchPoints: 0,
      })
    ).toBe(false);
    expect(
      requiresInstallBeforeVault({
        standalone: false,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
        maxTouchPoints: 5,
      })
    ).toBe(false);
    expect(
      requiresInstallBeforeVault({
        standalone: false,
        userAgent: "",
        maxTouchPoints: 0,
      })
    ).toBe(false);
  });

  it("guards both setup navigation and the vault write boundary", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/app/Onboarding.tsx"),
      "utf8"
    );
    const createStart = source.indexOf("const create");
    const vaultWrite = source.indexOf("await initializeVault");
    const gateCalls = [...source.matchAll(/requiresInstallBeforeVault\(\)/g)]
      .map((match) => match.index ?? -1)
      .filter((index) => index >= 0);

    expect(createStart).toBeGreaterThan(0);
    expect(vaultWrite).toBeGreaterThan(createStart);
    expect(gateCalls.some((index) => index < createStart)).toBe(true);
    expect(
      gateCalls.some((index) => index > createStart && index < vaultWrite)
    ).toBe(true);
  });

  it("does not repeat the obsolete Chrome-on-iPhone restriction", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/onboarding/InstallStep.tsx"),
      "utf8"
    );
    expect(source).not.toContain("Chrome on iPhone cannot install");
    expect(source).toContain("supported third-party browsers");
  });
});

describe("date of birth", () => {
  it("assembles a padded ISO date", () => {
    expect(toBirthDate("6", "14", "1988")).toBe("1988-06-14");
  });

  it("refuses a day the month does not have rather than clamping it", () => {
    // Clamping to the 28th would put a wrong age into the BMR equation and
    // never tell anyone it had done so.
    expect(toBirthDate("2", "31", "1988")).toBeNull();
  });

  it("refuses implausible years in both directions", () => {
    const year = new Date().getFullYear();
    expect(toBirthDate("6", "14", String(year - 130))).toBeNull();
    expect(toBirthDate("6", "14", String(year))).toBeNull();
  });

  it("returns null for a partially filled date", () => {
    expect(toBirthDate("6", "", "1988")).toBeNull();
  });
});

describe("about → SI", () => {
  it("converts feet and inches to centimetres", () => {
    const answers = toAboutAnswers(ABOUT, "imperial");
    expect(answers.heightCm).toBeCloseTo(180.3, 1);
  });

  it("converts pounds to kilograms", () => {
    const answers = toAboutAnswers(ABOUT, "imperial");
    expect(answers.weightKg).toBeCloseTo(85.0, 1);
  });

  it("stores centimetres unchanged in metric", () => {
    const answers = toAboutAnswers(
      { ...ABOUT, cm: "180", feet: "", inches: "" },
      "metric"
    );
    expect(answers.heightCm).toBe(180);
  });

  it("reads a metric weight as kilograms, not pounds", () => {
    const answers = toAboutAnswers({ ...ABOUT, weight: "85" }, "metric");
    expect(answers.weightKg).toBe(85);
  });

  it("drops a weight that is almost certainly a units mix-up", () => {
    // 187 entered while the app is in metric would be 187 kg.
    expect(toAboutAnswers({ ...ABOUT, weight: "420" }, "metric").weightKg).toBeNull();
  });

  it("drops an out-of-range body-fat reading but keeps the weight", () => {
    const answers = toAboutAnswers({ ...ABOUT, bodyFat: "89" }, "imperial");
    expect(answers.bodyFatPct).toBeNull();
    expect(answers.weightKg).not.toBeNull();
  });

  it("leaves every unanswered field null rather than inventing one", () => {
    const answers = toAboutAnswers(
      { ...ABOUT, sex: null, weight: "", bodyFat: "", month: "", day: "", year: "" },
      "imperial"
    );
    expect(answers).toEqual({
      sex: null,
      birthDate: null,
      heightCm: expect.any(Number),
      weightKg: null,
      bodyFatPct: null,
    });
  });
});

const PERSON: AboutAnswers = {
  sex: "male",
  birthDate: "1988-06-14",
  heightCm: 180,
  weightKg: 85,
  bodyFatPct: 21,
};

describe("rate", () => {
  it("signs a cut negative and a gain positive", () => {
    const cut = readRate({ ...EMPTY_GOALS, rate: "1.2" }, PERSON, "imperial");
    expect(cut.rateKgPerWeek).toBeLessThan(0);
    const gain = readRate(
      { ...EMPTY_GOALS, direction: "gain", rate: "0.5" },
      PERSON,
      "imperial"
    );
    expect(gain.rateKgPerWeek).toBeGreaterThan(0);
  });

  it("expresses the rate as a percentage of bodyweight", () => {
    const reading = readRate(
      { ...EMPTY_GOALS, rate: "1.2" },
      PERSON,
      "imperial"
    );
    // 1.2 lb ≈ 0.544 kg, against 85 kg.
    expect(Math.abs(reading.ratePctBw ?? 0)).toBeCloseTo(0.64, 2);
  });

  it("blocks a rate past the hard limit", () => {
    const reading = readRate({ ...EMPTY_GOALS, rate: "4" }, PERSON, "imperial");
    expect(Math.abs(reading.ratePctBw ?? 0)).toBeGreaterThan(
      LIMITS.BLOCK_LOSS_PCT_BW_PER_WEEK
    );
    expect(reading.blocked).toBe(true);
  });

  it("warns without blocking between the recommended ceiling and the hard cap", () => {
    const reading = readRate({ ...EMPTY_GOALS, rate: "2.2" }, PERSON, "imperial");
    expect(reading.blocked).toBe(false);
    expect(reading.findings.some((f) => f.level === "warn")).toBe(true);
  });

  it("cannot validate without a complete profile, and says so by finding nothing", () => {
    const reading = readRate(
      { ...EMPTY_GOALS, rate: "4" },
      { ...PERSON, sex: null },
      "imperial"
    );
    expect(reading.profile).toBeNull();
    expect(reading.findings).toEqual([]);
    expect(reading.blocked).toBe(false);
  });

  it("is zero, not null, when maintaining", () => {
    const reading = readRate(
      { ...EMPTY_GOALS, direction: "maintain", rate: "" },
      PERSON,
      "imperial"
    );
    expect(reading.rateKgPerWeek).toBe(0);
  });

  it("defaults to a rate inside the recommended band", () => {
    const text = defaultRateText("cut", PERSON, "imperial");
    const reading = readRate(
      { ...EMPTY_GOALS, rate: text },
      PERSON,
      "imperial"
    );
    expect(Math.abs(reading.ratePctBw ?? 0)).toBeLessThanOrEqual(
      LIMITS.MAX_LOSS_PCT_BW_PER_WEEK
    );
    expect(reading.findings.some((f) => f.level !== "info")).toBe(false);
  });

  it("still offers a default when no bodyweight is known", () => {
    expect(
      defaultRateText("cut", { ...PERSON, weightKg: null }, "imperial")
    ).not.toBe("");
  });
});

describe("goal conflicts", () => {
  it("uses the spec's wording verbatim", () => {
    const entries = conflictCopy("cut", ["strength", "vo2max"]);
    const bodies = entries.map((e) => e.body);
    expect(bodies).toContain(TRADEOFF_COPY.strength_held.body);
    expect(bodies).toContain(TRADEOFF_COPY.vo2max_realistic.body);
  });

  it("states the fat-loss / muscle-gain conflict rather than promising both", () => {
    const entries = conflictCopy("cut", ["hypertrophy"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toMatch(/deficit by definition does not provide/);
  });

  it("says nothing when there is no conflict to state", () => {
    expect(conflictCopy("maintain", ["strength", "hypertrophy"])).toEqual([]);
    expect(conflictCopy("cut", [])).toEqual([]);
  });
});

describe("training", () => {
  it("converts working weights to kilograms", () => {
    const intake = toTrainingIntake(
      { ...EMPTY_TRAINING_DRAFT, lifts: { "back-squat": "225" } },
      "imperial"
    );
    expect(intake.workingWeights).toHaveLength(1);
    expect(intake.workingWeights[0].kg).toBeCloseTo(102.1, 1);
  });

  it("drops a load that is a typo rather than seeding a progression from it", () => {
    const intake = toTrainingIntake(
      { ...EMPTY_TRAINING_DRAFT, lifts: { "back-squat": "2250" } },
      "metric"
    );
    expect(intake.workingWeights).toEqual([]);
  });

  it("keeps every other answer when no weights are given", () => {
    const intake = toTrainingIntake(
      {
        ...EMPTY_TRAINING_DRAFT,
        trainingAge: "beginner",
        daysPerWeek: 4,
        sessionMinutes: 60,
        trainerDays: [2, 3, 4],
        trainerFocus: "full-body strength",
      },
      "imperial"
    );
    expect(intake.trainingAge).toBe("beginner");
    expect(intake.trainerDays).toEqual([2, 3, 4]);
    expect(intake.workingWeights).toEqual([]);
  });

  it("only offers lifts that resolve in the bundled library", async () => {
    const { exerciseBySlug } = await import("@/lib/training/library");
    for (const lift of SEED_LIFTS) {
      expect(exerciseBySlug(lift.slug), lift.slug).not.toBeNull();
    }
  });
});

describe("creatine", () => {
  it("recognises creatine however it is written", () => {
    expect(mentionsCreatine(["Creatine monohydrate"])).toBe(true);
    expect(mentionsCreatine(["creatine"])).toBe(true);
    expect(mentionsCreatine(["Vitamin D", "Fish oil"])).toBe(false);
  });

  it("logs a window for a start inside the 42-day settling period", () => {
    const today = new Date(2026, 6, 26);
    expect(creatineStartDate("this-week", today)).toBe("2026-07-24");
    expect(creatineStartDate("weeks", today)).toBe("2026-07-05");
  });

  it("logs nothing once the water is already in the baseline", () => {
    // `athlete-profile.md` §6.5: past saturation the estimator is unbiased, so
    // opening a window would suppress six weeks of good data for nothing.
    expect(creatineStartDate("months")).toBeNull();
    expect(creatineStartDate("long")).toBeNull();
    expect(creatineStartDate(null)).toBeNull();
  });
});

describe("copy", () => {
  it("tells the user what every skippable step turns off", () => {
    for (const id of INTAKE_STEPS) {
      expect(STEP_COPY[id].disables.length, id).toBeGreaterThan(30);
      expect(STEP_COPY[id].skipLabel.length, id).toBeGreaterThan(0);
    }
  });

  it("lists skipped steps in flow order, not selection order", () => {
    const listed = skippedCopy(["health", "about"]).map((s) => s.id);
    expect(listed).toEqual(["about", "health"]);
  });

  /**
   * The eating-disorder-aware copy lint.
   *
   * `nutrition-personalization.md` §3.4 requirements 3–5: no streaks, no
   * gamification, and "under budget" is never framed as success. This is the
   * screen where goals get set, which is where those framings would do the most
   * damage, so the whole surface is scanned rather than a curated list of
   * strings.
   */
  it("contains no gamified or congratulatory framing anywhere in the flow", () => {
    const banned = [
      "great job",
      "well done",
      "congrat",
      "streak",
      "badge",
      "you saved",
      "under budget",
      "keep it up",
      "nice work",
      "you've got this",
      "level up",
      "reward",
    ];
    const dir = join(process.cwd(), "src/components/onboarding");
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      // Comments are stripped first: this file's own prose explains what the
      // flow must not say, and a lint that cannot tell an example from an
      // instance would forbid documenting the rule it enforces.
      const source = readFileSync(join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^[ \t]*\/\/.*$/gm, " ")
        .toLowerCase();
      for (const phrase of banned) {
        expect(source.includes(phrase), `${file} contains "${phrase}"`).toBe(
          false
        );
      }
    }
  });
});
