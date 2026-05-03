import { matchesGlob } from "./matcher.ts";

export interface SessionState {
  approvedExternals: Set<string>;
  approvedBashPatterns: Set<string>;
}

const state: SessionState = {
  approvedExternals: new Set(),
  approvedBashPatterns: new Set(),
};

export function getSessionState(): SessionState {
  return state;
}

export function approveExternal(path: string): void {
  state.approvedExternals.add(path);
}

export function approveBashPattern(pattern: string): void {
  state.approvedBashPatterns.add(pattern);
}

export function isExternalApproved(path: string): boolean {
  return state.approvedExternals.has(path);
}

export function isBashPatternApproved(command: string): boolean {
  for (const pattern of state.approvedBashPatterns) {
    if (matchesGlob(command, pattern)) return true;
  }
  return false;
}

export function resetSessionState(): void {
  state.approvedExternals.clear();
  state.approvedBashPatterns.clear();
}
