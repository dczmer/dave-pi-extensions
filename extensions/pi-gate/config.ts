import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { normalizePath } from './guards.ts';

/** Access control configuration for pi-gate. */
export interface PiGateConfig {
  bashAllow: string[];
  externalAllow: string[];
  /**
   * Global-only model reference ("provider/modelId") used to judge
   * unparsable bash commands. Ignored when read from the project config.
   */
  commandVerificationModel?: string;
}

/** Result of loading and merging global + project configs. */
export interface ConfigResult {
  merged: PiGateConfig;
  global: PiGateConfig;
  project: PiGateConfig;
  globalPath: string;
  projectPath: string;
}

/**
 * Parse an unknown value into a `PiGateConfig`, normalizing tolerant
 * defaults: absent `bashAllow` / `externalAllow` default to `[]` (so a
 * minimal hand-edited config like `{ "commandVerificationModel": "p/m" }`
 * loads), while a present-but-malformed field (including explicit `null`)
 * rejects the whole file.
 */
function parsePiGateConfig(v: unknown): PiGateConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const rec = v as Record<string, unknown>;
  // `=== undefined` (not `??`) so an explicit `null` is malformed, not absent.
  const bashAllow = rec.bashAllow === undefined ? [] : rec.bashAllow;
  const externalAllow = rec.externalAllow === undefined ? [] : rec.externalAllow;
  if (!Array.isArray(bashAllow) || !bashAllow.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(externalAllow) || !externalAllow.every((x) => typeof x === 'string')) return null;
  const model = rec.commandVerificationModel;
  if (model !== undefined && typeof model !== 'string') return null;
  const config: PiGateConfig = { bashAllow, externalAllow };
  if (model !== undefined) config.commandVerificationModel = model;
  return config;
}

const home = homedir() ?? '/';
const DEFAULT_GLOBAL_CONFIG_PATH = join(home, '.pi', 'agent', 'pi-gate.json');

function createEmptyConfig(): PiGateConfig {
  return {
    bashAllow: [],
    externalAllow: [],
  };
}

/** Leading glob operator; such entries are deliberately unscoped, not paths. */
const LEADING_GLOB_OPERATOR = /^[*?]/;

/**
 * Normalize one `externalAllow` entry into an absolute path pattern.
 *
 * Paths are always probed after `normalizePath` (tilde expanded, relative
 * segments resolved), so a raw `~`-prefixed or relative config entry would
 * never match anything.  Entries beginning with a glob operator (`*` or `?`)
 * are intentionally unscoped — e.g. a bare `*` meaning "any external path" —
 * and are returned verbatim.
 *
 * @param entry - Raw entry from a config file or the pattern prompt.
 * @param cwd - Project working directory used to resolve relative entries.
 * @returns An absolute pattern, or the entry unchanged when glob-led.
 */
export function normalizeExternalEntry(entry: string, cwd: string): string {
  return LEADING_GLOB_OPERATOR.test(entry) ? entry : normalizePath(entry, cwd);
}

/** Apply {@link normalizeExternalEntry} to a whole config's `externalAllow` list. */
function normalizeExternalEntries(config: PiGateConfig, cwd: string): PiGateConfig {
  return {
    ...config,
    externalAllow: config.externalAllow.map((entry) => normalizeExternalEntry(entry, cwd)),
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

  return parsePiGateConfig(parsed) ?? createEmptyConfig();
}

function mergeConfigs(global: PiGateConfig, project: PiGateConfig): PiGateConfig {
  return {
    bashAllow: [...global.bashAllow, ...project.bashAllow],
    externalAllow: [...global.externalAllow, ...project.externalAllow],
  };
}

/**
 * Load global and project pi-gate configs, merge them, and return the
 * combined result.  Project config lives at `{cwd}/.pi/pi-gate.json`;
 * global config at `~/.pi/agent/pi-gate.json` unless `globalPathOverride`
 * is given (used by tests to stay in temp directories).
 *
 * Every `externalAllow` entry is normalized (see
 * {@link normalizeExternalEntry}) on load so hand-written `~`-prefixed or
 * relative entries match the normalized absolute paths the guards probe with.
 * `bashAllow` patterns are matched against raw command text and are left as-is.
 *
 * @param cwd - Project working directory used to locate the project config.
 * @param globalPathOverride - Optional explicit global config path.
 * @returns Merged configuration along with the raw global and project configs
 *          and their filesystem paths.
 */
export function loadConfig(cwd: string, globalPathOverride?: string): ConfigResult {
  const globalPath = globalPathOverride ?? DEFAULT_GLOBAL_CONFIG_PATH;
  const projectPath = join(cwd, '.pi', 'pi-gate.json');

  const global = normalizeExternalEntries(loadSingleConfig(globalPath), cwd);
  const project = normalizeExternalEntries(loadSingleConfig(projectPath), cwd);
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
