/**
 * The algorithm layer — pure, dependency-free TypeScript.
 *
 * Everything re-exported here is a pure function or a plain constant table. No
 * I/O, no `db`, no `vault`, no `crypto`, no React. That is a hard rule
 * (`ARCHITECTURE.md` §6.3): these modules must stay auditable and testable in
 * isolation, and the tests in `__tests__/` run them with no environment at all.
 *
 * Modules are promoted here from `docs/kg/specs/algorithms/`, which is a
 * staging area excluded from lint and typecheck. The copies in `docs/` are the
 * reference implementations and are not imported by the app.
 *
 * Three names are declared identically in more than one module (`Sex`, `Goal`,
 * `DEFAULT_KCAL_PER_KG`). They are re-exported explicitly below so the star
 * exports are unambiguous; the definitions are structurally identical, so which
 * module wins is immaterial.
 */

export * from './weight-trend';
export * from './expenditure';
export * from './macro-targets';
export * from './guardrails';
export * from './micronutrients';
export * from './dietary-guardrails';
export * from './labs';
export * from './medication-interactions';
export * from './readiness';
export * from './coach';

export type { Sex, Goal } from './guardrails';
export { DEFAULT_KCAL_PER_KG } from './expenditure';
