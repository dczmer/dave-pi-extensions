import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type PiGateConfig,
  loadConfig,
  saveConfig,
} from "../config.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("load valid config file with all sections", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: ["ls *"],
      externalAllow: ["/tmp/*"],
      projectDeny: ["*/secrets.json"],
    }));
    const config = loadConfig(dir);
    assertEquals(config.bashAllow, ["ls *"]);
    assertEquals(config.externalAllow, ["/tmp/*"]);
    assertEquals(config.projectDeny, ["*/secrets.json"]);
  });
});

Deno.test("load missing config returns empty defaults", async () => {
  await withTempDir((dir) => {
    const config = loadConfig(dir);
    assertEquals(config.bashAllow, []);
    assertEquals(config.externalAllow, []);
    assertEquals(config.projectDeny, []);
    return Promise.resolve();
  });
});

Deno.test("save and reload roundtrip preserves data", async () => {
  await withTempDir((dir) => {
    const original: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: ["/etc/*"],
      projectDeny: ["*.key"],
    };
    saveConfig(dir, original);
    const loaded = loadConfig(dir);
    assertEquals(loaded.bashAllow, ["cat *"]);
    assertEquals(loaded.externalAllow, ["/etc/*"]);
    assertEquals(loaded.projectDeny, ["*.key"]);
    return Promise.resolve();
  });
});

Deno.test("append to bashAllow section", async () => {
  await withTempDir((dir) => {
    const config = loadConfig(dir);
    config.bashAllow.push("git *");
    saveConfig(dir, config);
    const loaded = loadConfig(dir);
    assertEquals(loaded.bashAllow, ["git *"]);
    return Promise.resolve();
  });
});

Deno.test("append to externalAllow section", async () => {
  await withTempDir((dir) => {
    const config = loadConfig(dir);
    config.externalAllow.push("/var/log/*");
    saveConfig(dir, config);
    const loaded = loadConfig(dir);
    assertEquals(loaded.externalAllow, ["/var/log/*"]);
    return Promise.resolve();
  });
});

Deno.test("malformed JSON throws error with clear message", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, "{ not json");
    assertThrows(() => loadConfig(dir), SyntaxError);
  });
});

Deno.test("missing bashAllow section throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      externalAllow: [],
      projectDeny: [],
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "bashAllow",
    );
  });
});

Deno.test("missing externalAllow section throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: [],
      projectDeny: [],
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "externalAllow",
    );
  });
});

Deno.test("missing projectDeny section throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: [],
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "projectDeny",
    );
  });
});

Deno.test("bashAllow is not array throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: "not-array",
      externalAllow: [],
      projectDeny: [],
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "bashAllow",
    );
  });
});

Deno.test("externalAllow is not array throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: 123,
      projectDeny: [],
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "externalAllow",
    );
  });
});

Deno.test("projectDeny is not array throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, JSON.stringify({
      bashAllow: [],
      externalAllow: [],
      projectDeny: null,
    }));
    assertThrows(
      () => loadConfig(dir),
      Error,
      "projectDeny",
    );
  });
});

Deno.test("empty JSON object throws error", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    await Deno.writeTextFile(configPath, "{}");
    assertThrows(
      () => loadConfig(dir),
      Error,
    );
  });
});

Deno.test("save creates parent directories if needed", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "a", "b", "c");
    const config: PiGateConfig = { bashAllow: [], externalAllow: [], projectDeny: [] };
    saveConfig(nested, config);
    const stat = await Deno.stat(join(nested, "pi-gate.json"));
    assertEquals(stat.isFile, true);
  });
});

Deno.test("atomic save operation (temp file + rename)", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["ls"],
      externalAllow: [],
      projectDeny: [],
    };
    saveConfig(dir, config);
    const entries = [];
    for await (const e of Deno.readDir(dir)) {
      entries.push(e.name);
    }
    assertEquals(entries.includes("pi-gate.json"), true);
  });
});
