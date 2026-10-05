import { matchesGlob } from './matcher.ts';
import type { ConfigResult } from './config.ts';
import { getSharedView, persistRecord, setStateLogOverride } from './state-log.ts';

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
const CONFIG_OVERRIDE_KEY = Symbol.for('pi-gate:config-override');

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
  persistRecord({ op: 'approve-external', pattern });
}

/** Mark a bash glob pattern as approved for the current session. */
export function approveBashPattern(pattern: string): void {
  getSessionState().approvedBashPatterns.add(pattern);
  persistRecord({ op: 'approve-bash', pattern });
}

/**
 * Check whether the bash command-pattern guard is active this session.
 * When disabled, bash commands skip pattern matching and prompting, but
 * file paths inside commands are still checked by the external-path guard.
 */
export function isBashEnabled(): boolean {
  // The shared log is the global latest (every toggle is persisted); fall
  // back to the local singleton when the log is inactive or has no toggle yet.
  return getSharedView().bashEnabled ?? getSessionState().bashEnabled;
}

/** Enable or disable the bash command-pattern guard for this session. */
export function setBashEnabled(enabled: boolean): void {
  getSessionState().bashEnabled = enabled;
  persistRecord({ op: 'toggle', guard: 'bash', enabled });
}

/**
 * Check whether the external file-path guard is active this session.
 * When disabled, external paths are allowed for both file tools and paths
 * referenced inside bash commands.
 */
export function isExternalEnabled(): boolean {
  return getSharedView().externalEnabled ?? getSessionState().externalEnabled;
}

/** Enable or disable the external file-path guard for this session. */
export function setExternalEnabled(enabled: boolean): void {
  getSessionState().externalEnabled = enabled;
  persistRecord({ op: 'toggle', guard: 'external', enabled });
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
 * Override the config result the extension entry point uses for every tool
 * call in this process. Only ever set by tests; production always leaves
 * this unset and loads config from disk. Shared via globalThis so the
 * override survives pi loading the extension with separate module copies.
 */
export function setConfigResultOverride(result: ConfigResult | undefined): void {
  (globalThis as Record<symbol, ConfigResult | undefined>)[CONFIG_OVERRIDE_KEY] = result;
}

/** Config result registered by {@link setConfigResultOverride}, if any. */
export function getConfigResultOverride(): ConfigResult | undefined {
  return (globalThis as Record<symbol, ConfigResult | undefined>)[CONFIG_OVERRIDE_KEY];
}

/** All approved bash patterns: local session ∪ shared log. Refreshes from the log. */
export function getApprovedBashPatterns(): Set<string> {
  return new Set([...getSessionState().approvedBashPatterns, ...getSharedView().bash]);
}

/** All approved external path patterns: local session ∪ shared log. Refreshes from the log. */
export function getApprovedExternalPatterns(): Set<string> {
  return new Set([...getSessionState().approvedExternalPatterns, ...getSharedView().external]);
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
  for (const rawEntry of getApprovedExternalPatterns()) {
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
  for (const pattern of getApprovedBashPatterns()) {
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
  setStateLogOverride(undefined); // drop handle + cached view
}
