# fun-ski-game — local-first health coach PWA

**Read `docs/kg/ARCHITECTURE.md` and `docs/kg/PRIVATE_DATA_BOUNDARY.md` before writing any code.**

TL;DR: iPhone-first PWA. **No application backend, no database server, no account.** All health
data lives in encrypted IndexedDB on the device. "Login" decrypts the local vault. ChatGPT Sites'
Vinext worker serves only the public app shell and rejects server-side writes.

- Task graph & dependencies: `docs/kg/GRAPH.md`
- Reusable specs / contracts: `docs/kg/specs/`
- Private-data boundary: `docs/kg/PRIVATE_DATA_BOUNDARY.md`

## Units — US customary

The product defaults to US customary display units: pounds, feet and inches,
fluid ounces, miles and Fahrenheit. Users can change this in the local settings vault.

But storage and every function signature stay **SI**: kilograms, centimetres,
millilitres, metres, Celsius. Convert only at the display boundary, via
`src/lib/units`. Three reasons this is not fussiness:

1. The nutrition algorithms use kcal-per-kg-of-tissue constants. Storing pounds
   means converting inside the trend filter and expenditure estimator on every
   iteration, and the rounding drift accumulates.
2. Apple Health exports carry explicit units and are usually metric. One
   conversion at ingest beats one per read.
3. Flipping the display preference must never alter stored data.

**Macronutrients stay in grams in both systems** — that is what US nutrition
labels use. Converting them to ounces would be worse, not better.

## Hard rules
1. No same-origin network request may ever carry health data.
2. No third-party analytics, CDN fonts, or error reporting. Strict CSP.
3. Algorithms are pure, zero-dependency TypeScript.
4. Every coaching recommendation passes through `guardrails.ts`. Not medical advice.
5. Offline is the default state, not an error state.
