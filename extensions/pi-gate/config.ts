import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

/** Access control configuration for pi-gate. */
export interface PiGateConfig {
  bashAllow: string[];
  externalAllow: string[];
}

/** Result of loading and merging global + project configs. */
export interface ConfigResult {
  merged: PiGateConfig;
  global: PiGateConfig;
  project: PiGateConfig;
  globalPath: string;
  projectPath: string;
}

function isPiGateConfig(v: unknown): v is PiGateConfig {
  if (typeof v !== 'object' || v === null) return false;
  const keys: (keyof PiGateConfig)[] = ['bashAllow', 'externalAllow'];
  for (const key of keys) {
    if (!(key in v)) return false;
    const arr = (v as Record<string, unknown>)[key];
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) return false;
  }
  return true;
}

const home = homedir() ?? '/';
const DEFAULT_GLOBAL_CONFIG_PATH = join(home, '.pi', 'agent', 'extensions', 'pi-gate.json');

function createEmptyConfig(): PiGateConfig {
  return {
    bashAllow: [],
    externalAllow: [],
  };
}

function loadSingleConfig(configPath: string): PiGateConfig {
  if (!existsSync(configPath)) {
    return createEmptyConfig();
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return createEmptyConfig();
  }

  // Handle empty file
  if (raw.trim().length === 0) {
    return createEmptyConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(
      `pi-gate: JSON syntax error in ${configPath}.\n` +
        `Common cause: trailing commas are not allowed in strict JSON.\n` +
        `Please fix the file and try again.\n` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`pi-gate: config must be an object in ${configPath}`);
  }

  if (!isPiGateConfig(parsed)) {
    return createEmptyConfig();
  }

  return parsed;
}

function mergeConfigs(global: PiGateConfig, project: PiGateConfig): PiGateConfig {
  return {
    bashAllow: [...global.bashAllow, ...project.bashAllow],
    externalAllow: [...global.externalAllow, ...project.externalAllow],
  };
}

/**
 * Load global and project pi-gate configs, merge them, and return the
 * combined result.  Project config lives at `{cwd}/.pi/extensions/pi-gate.json`;
 * global config at the standard agent extensions path.
 *
 * @param cwd - Project working directory used to locate the project config.
 * @returns Merged configuration along with the raw global and project configs
 *          and their filesystem paths.
 */
export function loadConfig(cwd: string): ConfigResult {
  const globalPath = DEFAULT_GLOBAL_CONFIG_PATH;
  const projectPath = join(cwd, '.pi', 'extensions', 'pi-gate.json');

  const global = loadSingleConfig(globalPath);
  const project = loadSingleConfig(projectPath);
  const merged = mergeConfigs(global, project);

  return {
    merged,
    global,
    project,
    globalPath,
    projectPath,
  };
}

/**
 * Atomically save a pi-gate config to the given path.  Writes to a temporary
 * file first, then renames it over the target to avoid corruption.
 *
 * @param config - The configuration object to persist.
 * @param configPath - Absolute filesystem path for the JSON file.
 */
export function saveConfig(config: PiGateConfig, configPath: string): void {
  const tempPath = configPath + '.tmp';

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(tempPath, configPath);
}
