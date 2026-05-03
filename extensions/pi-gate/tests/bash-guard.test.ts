import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type PiGateConfig } from "../config.ts";
import { checkBashCommand } from "../bash-guard.ts";
import { resetSessionState, approveBashPattern } from "../session.ts";

function createMockCtx() {
  const confirmQueue: boolean[] = [];
  const editorQueue: (string | null)[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  const ctx = {
    ui: {
      confirm: () => Promise.resolve(confirmQueue.shift() ?? false),
      editor: () => Promise.resolve(editorQueue.shift() ?? null),
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    _notifications: notifications,
    queueConfirm: (v: boolean) => confirmQueue.push(v),
    queueEditor: (v: string | null) => editorQueue.push(v),
  };

  return ctx as typeof ctx & Parameters<typeof checkBashCommand>[3];
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("command allowed by config bashAllow pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["ls *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("ls -la", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("command allowed by session approved pattern", async () => {
  await withTempDir(async (dir) => {
    resetSessionState();
    approveBashPattern("cat *");
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat file.txt", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("command with project files all allowed", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "main.ts"), "hello");
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat main.ts", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("command with external files all allowed", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: ["/tmp/*"],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat /tmp/foo.txt", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("no match prompts user, allows, persists, recurses, succeeds", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(true);
    ctx.queueEditor("grep *");

    const result = await checkBashCommand("grep hello file.txt", dir, config, ctx, configPath);
    strictEqual(result, true);

    const reloaded = loadConfig(configPath);
    deepStrictEqual(reloaded.bashAllow, ["grep *"]);
  });
});

test("no match prompts user, allows, skips persist, recurses, succeeds", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(false);
    ctx.queueEditor("grep *");

    const result = await checkBashCommand("grep hello file.txt", dir, config, ctx, configPath);
    strictEqual(result, true);

    const reloaded = loadConfig(configPath);
    deepStrictEqual(reloaded.bashAllow, []);
  });
});

test("pattern matches but file access denies", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat secret.txt", dir, config, ctx);
    strictEqual(result, false);
    strictEqual(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
  });
});

test("user denies command at prompt", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(false);

    const result = await checkBashCommand("rm -rf /", dir, config, ctx);
    strictEqual(result, false);
  });
});

test("user allows command but clears pattern", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueEditor("");

    const result = await checkBashCommand("rm -rf /", dir, config, ctx);
    strictEqual(result, false);
  });
});

test("multiple files in command, one denied", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "main.ts"), "hello");
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat main.ts secret.txt", dir, config, ctx);
    strictEqual(result, false);
    strictEqual(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
  });
});

test("command with no file arguments", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["ls *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("ls -la", dir, config, ctx);
    strictEqual(result, true);
  });
});

test("recursion doesn't cause infinite loop", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueEditor("custom-cmd *");
    ctx.queueConfirm(false);

    const result = await checkBashCommand("custom-cmd arg", dir, config, ctx);
    strictEqual(result, true);
  });
});
