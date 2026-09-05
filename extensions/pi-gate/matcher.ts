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
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) {
      v++;
      p++;
    } else if (p < pattern.length && pattern[p] === '*') {
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

  while (p < pattern.length && pattern[p] === '*') {
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

/**
 * Test whether a path is allowed by any entry, using pi-gate's uniform
 * whitelist semantics: exact match, directory-prefix match, or glob match.
 * First match wins; any match allows.
 *
 * Entries are stripped of trailing slashes before comparison (root `/`
 * excepted) so raw config strings like `/nix/blahblah/` behave identically
 * to `/nix/blahblah`.
 *
 * @param path - Normalized absolute path to check.
 * @param entries - Whitelist entries (plain paths, directory paths, or globs).
 * @returns `true` if any entry approves the path.
 */
export function matchesAnyWhitelistEntry(path: string, entries: Iterable<string>): boolean {
  for (const rawEntry of entries) {
    const entry = rawEntry.length > 1 ? rawEntry.replace(/\/+$/, '') : rawEntry;
    if (entry === path) return true;
    if (path.startsWith(entry + '/')) return true;
    if (matchesGlob(path, entry)) return true;
  }
  return false;
}
