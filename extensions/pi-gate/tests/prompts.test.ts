import { strictEqual } from "node:assert";
import { test } from "node:test";
import {
  promptAllowDeny,
  promptPattern,
  confirmAddToConfig,
} from "../prompts.ts";

function createMockCtx(ui: {
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
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
    input: () => Promise.resolve("/tmp/*"),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, "/tmp/*");
});

test("promptPattern returns null when input cleared", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve(""),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});

test("promptPattern returns null on cancel", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve(undefined),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});

test("confirmAddToConfig returns true when user selects Yes", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
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

test("promptPattern trims whitespace from input", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve("  /tmp/*  "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, "/tmp/*");
});

test("promptPattern empty string after trim returns null", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve("   "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  strictEqual(result, null);
});
