import { dirname, join } from "@std/path";

export interface PiGateConfig {
  bashAllow: string[];
  externalAllow: string[];
  projectDeny: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const home = Deno.env.get("HOME") ?? "/";
const DEFAULT_CONFIG_PATH = join(home, ".pi", "agent", "extensions", "pi-gate.json");

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): PiGateConfig {

  let raw: string;
  try {
    raw = Deno.readTextFileSync(configPath);
  } catch {
    return { bashAllow: [], externalAllow: [], projectDeny: [] };
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

  const obj = parsed as Record<string, unknown>;

  for (const key of ["bashAllow", "externalAllow", "projectDeny"]) {
    if (!(key in obj)) {
      throw new Error(`pi-gate: missing "${key}" in ${configPath}`);
    }
    if (!isStringArray(obj[key])) {
      throw new Error(`pi-gate: "${key}" must be an array of strings in ${configPath}`);
    }
  }

  return {
    bashAllow: obj.bashAllow as string[],
    externalAllow: obj.externalAllow as string[],
    projectDeny: obj.projectDeny as string[],
  };
}

export function saveConfig(config: PiGateConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  const tempPath = configPath + ".tmp";

  Deno.mkdirSync(dirname(configPath), { recursive: true });
  Deno.writeTextFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
  Deno.renameSync(tempPath, configPath);
}
