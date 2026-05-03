/**
 * Minimal glob matching supporting `*` (any chars, including empty)
 * and `?` (single char). Matches full strings.
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

/** Match value against any pattern in the list. */
export function matchesAnyGlob(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchesGlob(value, pattern)) return true;
  }
  return false;
}
