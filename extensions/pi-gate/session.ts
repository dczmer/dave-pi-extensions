import { matchesGlob } from "./matcher.ts";

/** Per-session approvals that expire when pi exits. */
export interface SessionState {
  approvedExternals: Set<string>;
  approvedBashPatterns: Set<string>;
}

const state: SessionState = {
  approvedExternals: new Set(),
  approvedBashPatterns: new Set(),
};

/**
 * Retrieve the mutable session-state singleton.  Modifications are reflected
 * in all subsequent lookups during the current pi process.
 */
export function getSessionState(): SessionState {
  return state;
}

/** Mark an external file path as approved for the current session. */
export function approveExternal(path: string): void {
  state.approvedExternals.add(path);
}

/** Mark a bash glob pattern as approved for the current session. */
export function approveBashPattern(pattern: string): void {
  state.approvedBashPatterns.add(pattern);
}

/**
 * Check whether an external file path has been approved during this session.
 */
export function isExternalApproved(path: string): boolean {
  return state.approvedExternals.has(path);
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
  state.approvedExternals.clear();
  state.approvedBashPatterns.clear();
}
