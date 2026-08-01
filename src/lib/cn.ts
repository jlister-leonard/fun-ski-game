/**
 * Joins class names, dropping falsy values.
 *
 * Deliberately not `clsx` + `tailwind-merge`: this app ships to a phone over a
 * cellular connection and every kilobyte of dependency is a kilobyte the user
 * waits for. Conflicting utilities are avoided by convention instead — pass
 * overrides last and keep component internals narrow.
 */
/**
 * Anything falsy is dropped. The wide falsy union exists so `someNode && "cls"`
 * type-checks — a `ReactNode` guard can narrow to `0`, `0n` or `""`, not just
 * `false`.
 */
export type ClassValue = string | false | 0 | 0n | "" | null | undefined;

export function cn(...values: ClassValue[]): string {
  let out = "";
  for (const v of values) {
    if (!v) continue;
    out = out ? `${out} ${v}` : v;
  }
  return out;
}
