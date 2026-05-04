import { strictEqual } from "node:assert";
import { test } from "node:test";
import {
  promptAllowDeny,
  promptPattern,
  confirmAddToConfig,
  confirmAddToConfigWithTarget,
} from "../prompts.ts";

function createMockCtx(ui: {
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
}) {
  return { ui } as unknown as Parameters<typeof promptAllowDeny>[1];
}

test("promptAllowDeny returns true when user selects Allow", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
  });
  const result = await promptAllowDeny("Allow access to /tmp?", ctx);
  strictEqual(result, true);
});

test("promptAllowDeny returns false when user selects Deny", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(false),
  });
  const result = await promptAllowDeny("Allow access to /tmp?", ctx);
  strictEqual(result, false);
});

test("promptPattern returns edited value", async () => {
  const ctx = createMockCtx({
    editor: () => Promise.resolve("/tmp/*"),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, "/tmp/*");
});

test("promptPattern returns null when input cleared", async () => {
  const ctx = createMockCtx({
    editor: () => Promise.resolve(""),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});

test("promptPattern returns null on cancel", async () => {
  const ctx = createMockCtx({
    editor: () => Promise.resolve(undefined),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});

test("confirmAddToConfig returns true when user selects Yes and project", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve("project"),
  });
  const result = await confirmAddToConfig("bashAllow", ctx);
  strictEqual(result, true);
});

test("confirmAddToConfig returns true when user selects Yes and global", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve("global"),
  });
  const result = await confirmAddToConfig("bashAllow", ctx);
  strictEqual(result, true);
});

test("confirmAddToConfig returns false when user selects No", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(false),
  });
  const result = await confirmAddToConfig("bashAllow", ctx);
  strictEqual(result, false);
});

test("confirmAddToConfigWithTarget returns confirmed true and project target", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve("project"),
  });
  const result = await confirmAddToConfigWithTarget("bashAllow", ctx);
  strictEqual(result.confirmed, true);
  strictEqual(result.target, "project");
});

test("confirmAddToConfigWithTarget returns confirmed true and global target", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve("global"),
  });
  const result = await confirmAddToConfigWithTarget("bashAllow", ctx);
  strictEqual(result.confirmed, true);
  strictEqual(result.target, "global");
});

test("confirmAddToConfigWithTarget returns confirmed false when user denies", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(false),
  });
  const result = await confirmAddToConfigWithTarget("bashAllow", ctx);
  strictEqual(result.confirmed, false);
  strictEqual(result.target, "project"); // default fallback
});

test("confirmAddToConfigWithTarget defaults to project when select returns undefined", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve(undefined),
  });
  const result = await confirmAddToConfigWithTarget("bashAllow", ctx);
  strictEqual(result.confirmed, true);
  strictEqual(result.target, "project");
});

test("promptPattern trims whitespace from input", async () => {
  const ctx = createMockCtx({
    editor: () => Promise.resolve("  /tmp/*  "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, "/tmp/*");
});

test("promptPattern empty string after trim returns null", async () => {
  const ctx = createMockCtx({
    editor: () => Promise.resolve("   "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});
