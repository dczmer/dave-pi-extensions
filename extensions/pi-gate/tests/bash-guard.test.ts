import { assertEquals } from "@std/assert";
import { loadConfig, type PiGateConfig } from "../config.ts";
import { checkBashCommand } from "../bash-guard.ts";
import { resetSessionState, approveBashPattern } from "../session.ts";
import { join } from "@std/path";

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

  return ctx as typeof ctx & Parameters<typeof checkBashCommand>[3];
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("command allowed by config bashAllow pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["ls *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("ls -la", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("command allowed by session approved pattern", async () => {
  await withTempDir(async (dir) => {
    resetSessionState();
    approveBashPattern("cat *");
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat file.txt", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("command with project files all allowed", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "main.ts"), "hello");
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat main.ts", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("command with external files all allowed", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: ["/tmp/*"],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat /tmp/foo.txt", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("no match prompts user, allows, persists, recurses, succeeds", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(true);
    ctx.queueInput("grep *");

    const result = await checkBashCommand("grep hello file.txt", dir, config, ctx, configPath);
    assertEquals(result, true);

    const reloaded = loadConfig(configPath);
    assertEquals(reloaded.bashAllow, ["grep *"]);
  });
});

Deno.test("no match prompts user, allows, skips persist, recurses, succeeds", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(false);
    ctx.queueInput("grep *");

    const result = await checkBashCommand("grep hello file.txt", dir, config, ctx, configPath);
    assertEquals(result, true);

    const reloaded = loadConfig(configPath);
    assertEquals(reloaded.bashAllow, []);
  });
});

Deno.test("pattern matches but file access denies", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat secret.txt", dir, config, ctx);
    assertEquals(result, false);
    assertEquals(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
  });
});

Deno.test("user denies command at prompt", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(false);

    const result = await checkBashCommand("rm -rf /", dir, config, ctx);
    assertEquals(result, false);
  });
});

Deno.test("user allows command but clears pattern", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueInput("");

    const result = await checkBashCommand("rm -rf /", dir, config, ctx);
    assertEquals(result, false);
  });
});

Deno.test("multiple files in command, one denied", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "main.ts"), "hello");
    const config: PiGateConfig = {
      bashAllow: ["cat *"],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("cat main.ts secret.txt", dir, config, ctx);
    assertEquals(result, false);
    assertEquals(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
  });
});

Deno.test("command with no file arguments", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: ["ls *"],
      externalAllow: [],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkBashCommand("ls -la", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("recursion doesn't cause infinite loop", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "pi-gate.json");
    const config = loadConfig(configPath);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueInput("custom-cmd *");
    ctx.queueConfirm(false);

    const result = await checkBashCommand("custom-cmd arg", dir, config, ctx);
    assertEquals(result, true);
  });
});
