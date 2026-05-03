import { assertEquals } from "@std/assert";
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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("project file allowed with empty deny list", async () => {
  await withTempDir(async (dir) => {
    const config = loadConfig(dir);
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("project file allowed when not matching deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["*.secret"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("src/main.ts", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("external file allowed when in config externalAllow", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: ["/tmp/*"],
      projectDeny: [],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("external file allowed when in session approved list", async () => {
  await withTempDir(async (dir) => {
    resetSessionState();
    approveExternal("/tmp/bar.txt");
    const config = loadConfig(dir);
    const ctx = createMockCtx();
    const result = await checkFileAccess("/tmp/bar.txt", dir, config, ctx);
    assertEquals(result, true);
  });
});

Deno.test("external file approved by user and persisted to config", async () => {
  await withTempDir(async (dir) => {
    const config = loadConfig(dir);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(true);
    ctx.queueInput("/tmp/*");

    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx);
    assertEquals(result, true);

    const reloaded = loadConfig(dir);
    assertEquals(reloaded.externalAllow, ["/tmp/*"]);
  });
});

Deno.test("external file approved by user but not persisted", async () => {
  await withTempDir(async (dir) => {
    const config = loadConfig(dir);
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueConfirm(false);

    const result = await checkFileAccess("/tmp/foo.txt", dir, config, ctx);
    assertEquals(result, true);

    const reloaded = loadConfig(dir);
    assertEquals(reloaded.externalAllow, []);
  });
});

Deno.test("project file blocked by exact deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["secret.txt"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("secret.txt", dir, config, ctx);
    assertEquals(result, false);
    assertEquals(ctx._notifications.length, 1);
    assertEquals(ctx._notifications[0].level, "warning");
  });
});

Deno.test("project file blocked by glob deny pattern", async () => {
  await withTempDir(async (dir) => {
    const config: PiGateConfig = {
      bashAllow: [],
      externalAllow: [],
      projectDeny: ["*.secret"],
    };
    const ctx = createMockCtx();
    const result = await checkFileAccess("foo.secret", dir, config, ctx);
    assertEquals(result, false);
  });
});

Deno.test("external file denied by user at prompt", async () => {
  await withTempDir(async (dir) => {
    const config = loadConfig(dir);
    const ctx = createMockCtx();
    ctx.queueConfirm(false);

    const result = await checkFileAccess("/etc/passwd", dir, config, ctx);
    assertEquals(result, false);
  });
});
