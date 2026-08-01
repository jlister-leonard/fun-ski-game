/**
 * Verification for the unit layer — node src/lib/units/units.verify.mjs
 *
 * Unit bugs are the quiet kind: nothing crashes, the number is just wrong, and
 * a wrong body weight silently corrupts the expenditure estimate and every
 * macro target downstream. So the conversions get real assertions, including
 * round-trips and the rounding edge cases.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "units-"));
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      outDir: dir,
sourceMap: false,
    },
    files: [join(process.cwd(), "src/lib/units/index.ts")],
  })
);
execFileSync("npx", ["tsc", "-p", join(dir, "tsconfig.json")], { stdio: "inherit" });
const U = await import(pathToFileURL(join(dir, "index.js")).href);

let pass = 0;
let fail = 0;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n1. Known reference conversions");
ok("1 kg is 2.20462 lb", near(U.kgToLb(1), 2.2046226218, 1e-9), U.kgToLb(1).toFixed(8));
ok("100 lb is 45.359237 kg", near(U.lbToKg(100), 45.359237, 1e-9));
ok("1 inch is exactly 2.54 cm", near(U.inToCm(1), 2.54));
ok("1 mile is exactly 1609.344 m", near(U.miToM(1), 1609.344));
ok("1 US fl oz is 29.5735 ml", near(U.flOzToMl(1), 29.5735295625, 1e-9));
ok("1 oz is 28.349523125 g", near(U.ozToG(1), 28.349523125, 1e-9));
ok("0 C is 32 F", near(U.cToF(0), 32));
ok("100 C is 212 F", near(U.cToF(100), 212));
ok("-40 is the same in both", near(U.cToF(-40), -40));

console.log("\n2. Round trips must not drift");
for (const kg of [45.5, 82.3, 113.4, 0.001, 250]) {
  ok(`kg -> lb -> kg at ${kg}`, near(U.lbToKg(U.kgToLb(kg)), kg, 1e-9));
}
for (const cm of [150, 178, 193.5]) {
  ok(`cm -> in -> cm at ${cm}`, near(U.inToCm(U.cmToIn(cm)), cm, 1e-9));
}
ok("m -> mi -> m at 5000", near(U.miToM(U.mToMi(5000)), 5000, 1e-9));
ok("C -> F -> C at 21.5", near(U.fToC(U.cToF(21.5)), 21.5, 1e-9));

console.log("\n3. Feet and inches, including the rollover trap");
{
  const a = U.cmToFeetInches(180);
  ok("180 cm is 5 ft 11 in", a.feet === 5 && a.inches === 11, `${a.feet}'${a.inches}"`);
  const b = U.cmToFeetInches(182.88);
  ok("182.88 cm is exactly 6 ft", b.feet === 6 && b.inches === 0, `${b.feet}'${b.inches}"`);
  // 11.6 inches rounds to 12, which must roll into the next foot rather than
  // rendering as 5'12".
  const c = U.cmToFeetInches(182.5);
  ok("no 12-inch remainder is ever emitted", c.inches < 12, `${c.feet}'${c.inches}"`);
  const d = U.cmToFeetInches(152.4);
  ok("152.4 cm is 5 ft 0 in", d.feet === 5 && d.inches === 0, `${d.feet}'${d.inches}"`);
  ok(
    "feet/inches round trip",
    near(U.feetInchesToCm(5, 11), 180.34, 1e-9),
    U.feetInchesToCm(5, 11).toFixed(2)
  );
}

console.log("\n4. Display formatting defaults to imperial");
ok("default system is imperial", U.DEFAULT_UNIT_SYSTEM === "imperial");
ok(
  "82.3 kg shows as 181.4 lb",
  U.formatBodyMass(82.3, "imperial").text === "181.4 lb",
  U.formatBodyMass(82.3, "imperial").text
);
ok(
  "same mass in metric shows kg",
  U.formatBodyMass(82.3, "metric").text === "82.3 kg",
  U.formatBodyMass(82.3, "metric").text
);
ok(
  "trailing zeros are trimmed",
  U.formatBodyMass(U.lbToKg(180), "imperial").text === "180 lb",
  U.formatBodyMass(U.lbToKg(180), "imperial").text
);

console.log("\n5. Signed deltas never lose their sign");
{
  const down = U.formatBodyMassDelta(-0.34, "imperial");
  const up = U.formatBodyMassDelta(0.34, "imperial");
  ok("a loss renders with a minus", down.text.startsWith("−"), down.text);
  ok("a gain renders with a plus", up.text.startsWith("+"), up.text);
  ok("zero renders unsigned", U.formatBodyMassDelta(0, "imperial").text === "0 lb");
  ok("a loss and a gain are not the same string", down.text !== up.text);
}

console.log("\n6. Food mass keeps grams where grams are better");
ok(
  "12 g stays in grams",
  U.formatFoodMass(12, "imperial").unit === "g",
  U.formatFoodMass(12, "imperial").text
);
ok(
  "170 g becomes ounces",
  U.formatFoodMass(170, "imperial").unit === "oz",
  U.formatFoodMass(170, "imperial").text
);

console.log("\n7. Distance, load and pace");
ok(
  "short sled work renders in yards",
  U.formatDistance(18, "imperial").unit === "yd",
  U.formatDistance(18, "imperial").text
);
ok(
  "a 5k renders in miles",
  U.formatDistance(5000, "imperial").unit === "mi",
  U.formatDistance(5000, "imperial").text
);
ok(
  "load rounds to half-pound increments",
  U.formatLoad(62.5, "imperial").text === "138 lb",
  U.formatLoad(62.5, "imperial").text
);
// The case that actually matters day to day: a load the user typed in pounds
// must come back out as the same number, not 134.9 or 135.1.
for (const lb of [45, 95, 135, 185, 225, 315, 405]) {
  const stored = U.lbToKg(lb);
  ok(
    `${lb} lb round-trips through storage unchanged`,
    U.formatLoad(stored, "imperial").text === `${lb} lb`,
    U.formatLoad(stored, "imperial").text
  );
}
ok(
  "pace renders as min:sec per mile",
  U.formatPace(3.0, "imperial").text === "8:56/mi",
  U.formatPace(3.0, "imperial").text
);
ok("zero speed does not divide by zero", U.formatPace(0, "imperial").text === "—");

console.log("\n8. Parsing user input");
ok("parses pounds back to kg", near(U.parseBodyMass("180", "imperial"), U.lbToKg(180), 1e-9));
ok("parses kg as kg", near(U.parseBodyMass("82.3", "metric"), 82.3, 1e-9));
ok("rejects gibberish", U.parseBodyMass("abc", "imperial") === null);
ok("rejects negatives", U.parseBodyMass("-5", "imperial") === null);
ok("rejects zero", U.parseBodyMass("0", "imperial") === null);

console.log("\n" + "=".repeat(58));
console.log(`${pass} passed, ${fail} failed`);
console.log("=".repeat(58));
if (fail > 0) process.exit(1);
