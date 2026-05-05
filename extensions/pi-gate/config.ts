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

function isPiGateConfig(v: unknown): v is PiGateConfig {
  if (typeof v !== "object" || v === null) return false;
  const keys: (keyof PiGateConfig)[] = ["bashAllow", "externalAllow", "projectDeny"];
  for (const key of keys) {
    if (!(key in v)) return false;
    const arr = (v as Record<string, unknown>)[key];
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) return false;
  }
  return true;
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
  } catch (err) {
    throw new SyntaxError(
      `pi-gate: malformed JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
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
