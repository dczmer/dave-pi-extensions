import { matchesGlob } from './matcher.ts';

/** Per-session approvals and guard toggles; everything expires when pi exits. */
export interface SessionState {
  approvedExternalPatterns: Set<string>;
  approvedBashPatterns: Set<string>;
  /** Whether the bash command-pattern guard is active this session. */
  bashEnabled: boolean;
  /** Whether the external file-path guard is active this session. */
  externalEnabled: boolean;
  /** Whether the pi-gate extension entry point ran in this process. */
  piGateLoaded: boolean;
}

const SHARED_KEY = Symbol.for('pi-gate:session-state');

/**
 * Retrieve the mutable session-state singleton, shared across all module
 * copies in this process via globalThis (pi loads each extension with a
 * separate jiti instance, so module-level state would NOT be shared).
 */
export function getSessionState(): SessionState {
  const g = globalThis as Record<symbol, SessionState | undefined>;
  return (g[SHARED_KEY] ??= {
    approvedExternalPatterns: new Set(),
    approvedBashPatterns: new Set(),
    bashEnabled: true,
    externalEnabled: true,
    piGateLoaded: false,
  });
}

/** Mark an external path pattern as approved for the current session. */
export function approveExternalPattern(pattern: string): void {
  getSessionState().approvedExternalPatterns.add(pattern);
}

/** Mark a bash glob pattern as approved for the current session. */
export function approveBashPattern(pattern: string): void {
  getSessionState().approvedBashPatterns.add(pattern);
}

/**
 * Check whether the bash command-pattern guard is active this session.
 * When disabled, bash commands skip pattern matching and prompting, but
 * file paths inside commands are still checked by the external-path guard.
 */
export function isBashEnabled(): boolean {
  return getSessionState().bashEnabled;
}

/** Enable or disable the bash command-pattern guard for this session. */
export function setBashEnabled(enabled: boolean): void {
  getSessionState().bashEnabled = enabled;
}

/**
 * Check whether the external file-path guard is active this session.
 * When disabled, external paths are allowed for both file tools and paths
 * referenced inside bash commands.
 */
export function isExternalEnabled(): boolean {
  return getSessionState().externalEnabled;
}

/** Enable or disable the external file-path guard for this session. */
export function setExternalEnabled(enabled: boolean): void {
  getSessionState().externalEnabled = enabled;
}

/** Mark pi-gate as loaded in this process (called once by the extension entry point). */
export function markPiGateLoaded(): void {
  getSessionState().piGateLoaded = true;
}

/** Whether the pi-gate extension was actually loaded this session. */
export function isPiGateLoaded(): boolean {
  return getSessionState().piGateLoaded;
}

/** Reset the loaded flag (primarily for testing). */
export function resetPiGateLoaded(): void {
  getSessionState().piGateLoaded = false;
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
  for (const rawEntry of getSessionState().approvedExternalPatterns) {
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
  for (const pattern of getSessionState().approvedBashPatterns) {
    if (matchesGlob(command, pattern)) return true;
  }
  return false;
}

/** Clear all in-memory session approvals and restore both guards (primarily for testing). */
export function resetSessionState(): void {
  const state = getSessionState();
  state.approvedExternalPatterns.clear();
  state.approvedBashPatterns.clear();
  state.bashEnabled = true;
  state.externalEnabled = true;
}
