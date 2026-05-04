import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ConfigResult } from "../config.ts";
import { checkFileAccess } from "../file-access.ts";
import { approveExternal, resetSessionState } from "../session.ts";

function createMockCtx() {
  const confirmQueue: boolean[] = [];
  const editorQueue: (string | null)[] = [];
  const selectQueue: (string | null)[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const ctx = {
    ui: {
      confirm: () => Promise.resolve(confirmQueue.shift() ?? false),
      editor: () => Promise.resolve(editorQueue.shift() ?? null),
      select: <T extends string>() => Promise.resolve((selectQueue.shift() ?? "project") as T),
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    _notifications: notifications,
    queueConfirm: (v: boolean) => confirmQueue.push(v),
    queueEditor: (v: string | null) => editorQueue.push(v),
    queueSelect: (v: string | null) => selectQueue.push(v),
  };

  return ctx as typeof ctx & Parameters<typeof checkFileAccess>[3];
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const base = {
    bashAllow: [] as string[],
    externalAllow: [] as string[],
    projectDeny: [] as string[],
  };
  return {
    merged: { ...base, ...(overrides?.merged || {}) },
    global: { ...base, ...(overrides?.global || {}) },
    project: { ...base, ...(overrides?.project || {}) },
    globalPath: "/tmp/global.json",
    projectPath: "/tmp/project.json",
    ...overrides,
  };
}

test("project file allowed with empty deny list", async () => {
  await withTempDir(async (dir) => {
    const configResult = loadConfig(dir);
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, configResult, ctx);
    strictEqual(result, true);
  });
});

test("project file allowed when not matching deny pattern", async () => {
  await withTempDir(async (dir) => {
    const configResult = createConfigResult({
      merged: { bashAllow: [], externalAllow: [], projectDeny: ["*.secret"] },
      project: { bashAllow: [], externalAllow: [], projectDeny: ["*.secret"] },
      global: { bashAllow: [], externalAllow: [], projectDeny: [] },
    });
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, configResult, ctx);
    strictEqual(result, true);
  });
});

test("external file allowed when in config externalAllow", async () => {
  await withTempDir(async (dir) => {
    const configResult = createConfigResult({
      merged: { bashAllow: [], externalAllow: ["/tmp/*"], projectDeny: [] },
      project: { bashAllow: [], externalAllow: ["/tmp/*"], projectDeny: [] },
      global: { bashAllow: [], externalAllow: [], projectDeny: [] },
    });
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/foo.txt", dir, configResult, ctx);
    strictEqual(result, true);
  });
});

test("external file allowed when in session approved list", async () => {
  await withTempDir(async (dir) => {
    resetSessionState();
    approveExternal("/tmp/bar.txt");
    const configResult = loadConfig(dir);
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/bar.txt", dir, configResult, ctx);
    strictEqual(result, true);
  });
});

test("external file approved by user and persisted to project config", async () => {
  await withTempDir(async (dir) => {
    const projectConfigDir = join(dir, ".pi", "extensions");
    mkdirSync(projectConfigDir, { recursive: true });

    // Use temp file for global config to ensure isolation from real config
    const tempGlobalPath = join(dir, "global-pi-gate.json");
    process.env.PI_GATE_GLOBAL_CONFIG_PATH = tempGlobalPath;

    try {
      const configResult = loadConfig(dir);
      const ctx = createMockCtx();
      ctx.queueConfirm(true); // Allow access
      ctx.queueEditor("/xyz-custom-path/*"); // Pattern
      ctx.queueConfirm(true); // Add to config
      ctx.queueSelect("project"); // Save to project

      const result = await checkFileAccess("/xyz-custom-path/foo.txt", dir, configResult, ctx);
      strictEqual(result, true);

      const reloaded = loadConfig(dir);
      deepStrictEqual(reloaded.project.externalAllow, ["/xyz-custom-path/*"]);
    } finally {
      delete process.env.PI_GATE_GLOBAL_CONFIG_PATH;
    }
  });
});

test("external file approved by user and persisted to global config", async () => {
  await withTempDir(async (dir) => {
    const projectConfigDir = join(dir, ".pi", "extensions");
    mkdirSync(projectConfigDir, { recursive: true });

    // Use temp file for global config to avoid modifying real config
    const tempGlobalPath = join(dir, "global-pi-gate.json");
    process.env.PI_GATE_GLOBAL_CONFIG_PATH = tempGlobalPath;

    try {
      const configResult = loadConfig(dir);
      const ctx = createMockCtx();
      ctx.queueConfirm(true); // Allow access
      ctx.queueEditor("/abc-global-test/*"); // Pattern - unique
      ctx.queueConfirm(true); // Add to config
      ctx.queueSelect("global"); // Save to global

      const result = await checkFileAccess("/abc-global-test/foo.txt", dir, configResult, ctx);
      strictEqual(result, true);

      // Project should be empty
      const reloaded = loadConfig(dir);
      deepStrictEqual(reloaded.project.externalAllow, []);
      // Global should have the pattern
      deepStrictEqual(reloaded.global.externalAllow, ["/abc-global-test/*"]);
    } finally {
      delete process.env.PI_GATE_GLOBAL_CONFIG_PATH;
    }
  });
});

test("external file approved by user but not persisted", async () => {
  await withTempDir(async (dir) => {
    const projectConfigDir = join(dir, ".pi", "extensions");
    mkdirSync(projectConfigDir, { recursive: true });

    const configResult = loadConfig(dir);
    const ctx = createMockCtx();
    ctx.queueConfirm(true); // Allow access
    ctx.queueEditor("/def-skip-test/*"); // Pattern
    ctx.queueConfirm(false); // Don't add to config

    const result = await checkFileAccess("/def-skip-test/foo.txt", dir, configResult, ctx);
    strictEqual(result, true);

    const reloaded = loadConfig(dir);
    deepStrictEqual(reloaded.project.externalAllow, []);
  });
});

test("project file blocked by exact deny pattern", async () => {
  await withTempDir(async (dir) => {
    const configResult = createConfigResult({
      merged: { bashAllow: [], externalAllow: [], projectDeny: ["secret.txt"] },
      project: { bashAllow: [], externalAllow: [], projectDeny: ["secret.txt"] },
      global: { bashAllow: [], externalAllow: [], projectDeny: [] },
    });
    const ctx = createMockCtx();
    const result = await checkFileAccess("secret.txt", dir, configResult, ctx);
    strictEqual(result, false);
    strictEqual(ctx._notifications.length, 1);
    strictEqual(ctx._notifications[0].level, "warning");
  });
});

test("project file blocked by glob deny pattern", async () => {
  await withTempDir(async (dir) => {
    const configResult = createConfigResult({
      merged: { bashAllow: [], externalAllow: [], projectDeny: ["*.secret"] },
      project: { bashAllow: [], externalAllow: [], projectDeny: ["*.secret"] },
      global: { bashAllow: [], externalAllow: [], projectDeny: [] },
    });
    const ctx = createMockCtx();
    const result = await checkFileAccess("foo.secret", dir, configResult, ctx);
    strictEqual(result, false);
  });
});

test("external file denied by user at prompt", async () => {
  await withTempDir(async (dir) => {
    const configResult = loadConfig(dir);
    const ctx = createMockCtx();
    ctx.queueConfirm(false);

    const result = await checkFileAccess("/etc/passwd", dir, configResult, ctx);
    strictEqual(result, false);
  });
});

test("merged config includes both global and project patterns", async () => {
  await withTempDir(async (dir) => {
    const configResult = createConfigResult({
      merged: {
        bashAllow: [],
        externalAllow: ["/global/*", "/project/*"],
        projectDeny: [],
      },
      global: { bashAllow: [], externalAllow: ["/global/*"], projectDeny: [] },
      project: { bashAllow: [], externalAllow: ["/project/*"], projectDeny: [] },
    });
    const ctx = createMockCtx();
    // Should match /global/file.txt from global config
    const result = await checkFileAccess("/global/file.txt", dir, configResult, ctx);
    strictEqual(result, true);
  });
});
