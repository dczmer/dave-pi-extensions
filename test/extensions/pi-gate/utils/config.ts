import { type ConfigResult } from '../../../../extensions/pi-gate/config.ts';

/** Build a fake pi-gate ConfigResult for unit tests. */
export function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const empty = () => ({
    bashAllow: [] as string[],
    externalAllow: [] as string[],
  });
  return {
    merged: { ...empty(), ...(overrides?.merged || {}) },
    global: { ...empty(), ...(overrides?.global || {}) },
    project: { ...empty(), ...(overrides?.project || {}) },
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    ...overrides,
  };
}
