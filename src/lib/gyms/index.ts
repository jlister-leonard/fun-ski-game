/**
 * @file The gym / equipment package.
 *
 * Three layers, importable separately so nothing drags IndexedDB into a unit
 * test that does not need it:
 *
 * - `equipment` — the vocabulary. Pure, no imports outside this directory.
 * - `requirements` / `profiles` — the model. Pure; reads the bundled exercise
 *   library, writes nothing.
 * - `store` — the vault wiring. The only module here that does I/O.
 */

export * from './equipment';
export * from './requirements';
export * from './profiles';
export * from './store';
