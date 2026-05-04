import { dirname, join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";

export interface PiGateConfig {
  bashAllow: string[];
  externalAllow: string[];
  projectDeny: string[];
}

export interface ConfigResult {
  merged: PiGateConfig;
  global: PiGateConfig;
  project: PiGateConfig;
  globalPath: string;
  projectPath: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const home = homedir() ?? "/";
const DEFAULT_GLOBAL_CONFIG_PATH = join(home, ".pi", "agent", "extensions", "pi-gate.json");

function getGlobalConfigPath(): string {
  // Allow tests to override global config path via env var
  return process.env.PI_GATE_GLOBAL_CONFIG_PATH ?? DEFAULT_GLOBAL_CONFIG_PATH;
}

function createEmptyConfig(): PiGateConfig {
  return {
    bashAllow: [],
    externalAllow: [],
    projectDeny: [],
  };
}

// TODO: i think the `unknown` can be `string` and we can lose `isStringArray`;
//  in fact, `obj` is a PiGateConfig so we could use that instead and fix it's `[]` types
//  and then we can fix the key look up by using `key in PiGateConfig`
function validateConfig(obj: Record<string, unknown>, configPath: string): PiGateConfig {
  for (const key of ["bashAllow", "externalAllow", "projectDeny"]) {
    if (!(key in obj)) {
      throw new Error(`pi-gate: missing "${key}" in ${configPath}`);
    }
    if (!isStringArray(obj[key])) {
      throw new Error(`pi-gate: "${key}" must be an array of strings in ${configPath}`);
    }
  }

  return {
    // TODO: :(
    bashAllow: obj.bashAllow as string[],
    externalAllow: obj.externalAllow as string[],
    projectDeny: obj.projectDeny as string[],
  };
}

function loadSingleConfig(configPath: string): PiGateConfig {
  if (!existsSync(configPath)) {
    return createEmptyConfig();
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
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
  } catch (e) {
    throw new SyntaxError(
      `pi-gate: malformed JSON in ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`pi-gate: config must be an object in ${configPath}`);
  }

  // TODO: i think this is a PiGateConfig as well...
  const obj = parsed as Record<string, unknown>;

  // If any required keys are missing, treat as empty config (for partial/invalid files)
  const hasAllKeys = ["bashAllow", "externalAllow", "projectDeny"].every(
    (key) => key in obj
  );
  if (!hasAllKeys) {
    return createEmptyConfig();
  }

  return validateConfig(obj, configPath);
}

function mergeConfigs(global: PiGateConfig, project: PiGateConfig): PiGateConfig {
  return {
    bashAllow: [...global.bashAllow, ...project.bashAllow],
    externalAllow: [...global.externalAllow, ...project.externalAllow],
    projectDeny: [...global.projectDeny, ...project.projectDeny],
  };
}

export function loadConfig(cwd: string): ConfigResult {
  const globalPath = getGlobalConfigPath();
  const projectPath = join(cwd, ".pi", "extensions", "pi-gate.json");

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

export function saveConfig(config: PiGateConfig, configPath: string): void {
  const tempPath = configPath + ".tmp";

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tempPath, configPath);
}
