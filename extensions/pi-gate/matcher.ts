/**
 * Match a full string against a glob pattern.
 *
 * Supports `*` (zero or more characters) and `?` (exactly one character).
 * The entire value must match the pattern; there is no implicit `*` at either
 * end.
 *
 * @param value - The concrete string to test.
 * @param pattern - A glob pattern possibly containing `*` and `?`.
 * @returns `true` if the value satisfies the pattern.
 */
export function matchesGlob(value: string, pattern: string): boolean {
  let v = 0;
  let p = 0;
  let starIdx = -1;
  let match = 0;

  while (v < value.length) {
    if (
      p < pattern.length &&
      (pattern[p] === "?" || pattern[p] === value[v])
    ) {
      v++;
      p++;
    } else if (p < pattern.length && pattern[p] === "*") {
      starIdx = p;
      match = v;
      p++;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      match++;
      v = match;
    } else {
      return false;
    }
  }

  while (p < pattern.length && pattern[p] === "*") {
    p++;
  }

  return p === pattern.length;
}

/**
 * Test whether a value matches at least one pattern in the provided list.
 * Short-circuits on the first match.
 *
 * @param value - The concrete string to test.
 * @param patterns - List of glob patterns.
 * @returns `true` if any pattern matches the value.
 */
export function matchesAnyGlob(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesGlob(value, pattern)) return true;
  }
  return false;
}
