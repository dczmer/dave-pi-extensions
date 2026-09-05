import { matchesGlob } from './matcher.ts';

/** Per-session approvals that expire when pi exits. */
export interface SessionState {
  approvedExternalPatterns: Set<string>;
  approvedBashPatterns: Set<string>;
}

const state: SessionState = {
  approvedExternalPatterns: new Set(),
  approvedBashPatterns: new Set(),
};

/**
 * Retrieve the mutable session-state singleton.  Modifications are reflected
 * in all subsequent lookups during the current pi process.
 */
export function getSessionState(): SessionState {
  return state;
}

/** Mark an external path pattern as approved for the current session. */
export function approveExternalPattern(pattern: string): void {
  state.approvedExternalPatterns.add(pattern);
}

/** Mark a bash glob pattern as approved for the current session. */
export function approveBashPattern(pattern: string): void {
  state.approvedBashPatterns.add(pattern);
}

/**
 * Check whether an external path has been approved during this session.
 *
 * An entry approves the path when it:
 *   1. exactly equals the path,
 *   2. is a directory prefix of the path (entry + '/'),
 *   3. matches the path as a glob (`*` crosses '/').
 *
 * Entries are stripped of trailing slashes before comparison (root `/`
 * excepted).
 */
export function isExternalApproved(path: string): boolean {
  for (const rawEntry of state.approvedExternalPatterns) {
    const entry = rawEntry.length > 1 ? rawEntry.replace(/\/+$/, '') : rawEntry;
    if (entry === path) return true;
    if (path.startsWith(entry + '/')) return true;
    if (matchesGlob(path, entry)) return true;
  }
  return false;
}

/**
 * Check whether a bash command matches any session-approved glob pattern.
 */
export function isBashPatternApproved(command: string): boolean {
  for (const pattern of state.approvedBashPatterns) {
    if (matchesGlob(command, pattern)) return true;
  }
  return false;
}

/** Clear all in-memory session approvals (primarily for testing). */
export function resetSessionState(): void {
  state.approvedExternalPatterns.clear();
  state.approvedBashPatterns.clear();
}
