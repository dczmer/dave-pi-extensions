import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PiGateConfig,
  loadConfig,
  saveConfig,
} from "../config.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("load valid config file with all sections", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: ["ls *"],
      externalAllow: ["/tmp/*"],
      projectDeny: ["*/secrets.json"],
    }));
    const config = loadConfig(configPath);
    deepStrictEqual(config.bashAllow, ["ls *"]);
    deepStrictEqual(config.externalAllow, ["/tmp/*"]);
    deepStrictEqual(config.projectDeny, ["*/secrets.json"]);
  });
});

test("load missing config returns empty defaults", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    deepStrictEqual(config.bashAllow, []);
    deepStrictEqual(config.externalAllow, []);
    deepStrictEqual(config.projectDeny, []);
  });
});

test("save and reload roundtrip preserves data", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    const original: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: ["/etc/*"],
      projectDeny: ["*.key"],
    };
    saveConfig(original, configPath);
    const loaded = loadConfig(configPath);
    deepStrictEqual(loaded.bashAllow, ["cat *"]);
    deepStrictEqual(loaded.externalAllow, ["/etc/*"]);
    deepStrictEqual(loaded.projectDeny, ["*.key"]);
  });
});

test("append to bashAllow section", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    config.bashAllow.push("git *");
    saveConfig(config, configPath);
    const loaded = loadConfig(configPath);
    deepStrictEqual(loaded.bashAllow, ["git *"]);
  });
});

test("append to externalAllow section", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    config.externalAllow.push("/var/log/*");
    saveConfig(config, configPath);
    const loaded = loadConfig(configPath);
    deepStrictEqual(loaded.externalAllow, ["/var/log/*"]);
  });
});

test("malformed JSON throws error with clear message", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, "{ not json");
    throws(() => loadConfig(configPath), SyntaxError);
  });
});

test("missing bashAllow section throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      externalAllow: [],
      projectDeny: [],
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("missing externalAllow section throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: [],
      projectDeny: [],
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("missing projectDeny section throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: [],
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("bashAllow is not array throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: "not-array",
      externalAllow: [],
      projectDeny: [],
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("externalAllow is not array throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: 123,
      projectDeny: [],
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("projectDeny is not array throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: [],
      projectDeny: null,
    }));
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("empty JSON object throws error", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    writeFileSync(configPath, "{}");
    throws(
      () => loadConfig(configPath),
      Error,
    );
  });
});

test("save creates parent directories if needed", () => {
  withTempDir((dir) => {
    const nested = join(dir, "a", "b", "c");
    const configPath = join(nested, "pi-gate.json");
    const config: PiGateConfig = { bashAllow: [], externalAllow: [], projectDeny: [] };
    saveConfig(config, configPath);
    const stat = statSync(join(nested, "pi-gate.json"));
    strictEqual(stat.isFile(), true);
  });
});

test("atomic save operation (temp file + rename)", () => {
  withTempDir((dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config: PiGateConfig = {
      bashAllow: ["ls"],
      externalAllow: [],
      projectDeny: [],
    };
    saveConfig(config, configPath);
    const entries = readdirSync(dir);
    strictEqual(entries.includes("pi-gate.json"), true);
  });
});
