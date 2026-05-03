import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type PiGateConfig } from "../config.ts";
import { checkFileAccess } from "../file-access.ts";
import { approveExternal, resetSessionState } from "../session.ts";

function createMockCtx() {
  const confirmQueue: boolean[] = [];
  const inputQueue: (string | null)[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const ctx = {
    ui: {
      confirm: () => Promise.resolve(confirmQueue.shift() ?? false),
      input: () => Promise.resolve(inputQueue.shift() ?? null),
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    _notifications: notifications,
    queueConfirm: (v: boolean) => confirmQueue.push(v),
    queueInput: (v: string | null) => inputQueue.push(v),
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

test("project file allowed with empty deny list", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("project file allowed when not matching deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["*.secret"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("external file allowed when in config externalAllow", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: ["/tmp/*"],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("external file allowed when in session approved list", async () => {
  await withTempDir(async (dir) => {
    resetSessionState();
    approveExternal("/tmp/bar.txt");
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/bar.txt", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("external file approved by user and persisted to config", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(true);
    ctx.queueInput("/tmp/*");

    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx, configPath);
    strictEqual(result, true);

    const reloaded = loadConfig(configPath);
    deepStrictEqual(reloaded.externalAllow, ["/tmp/*"]);
  });
});

test("external file approved by user but not persisted", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(false);

    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx);
    strictEqual(result, true);

    const reloaded = loadConfig(configPath);
    deepStrictEqual(reloaded.externalAllow, []);
  });
});

test("project file blocked by exact deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("secret.txt", dir, config, ctx);
    strictEqual(result, false);
    strictEqual(ctx._notifications.length, 1);
    strictEqual(ctx._notifications[0].level, "warning");
  });
});

test("project file blocked by glob deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["*.secret"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("foo.secret", dir, config, ctx);
    strictEqual(result, false);
  });
});

test("external file denied by user at prompt", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(false);

    const result = await checkFileAccess("/etc/passwd", dir, config, ctx);
    strictEqual(result, false);
  });
});
