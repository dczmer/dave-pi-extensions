import { assertEquals } from "@std/assert";
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

Deno.test("promptAllowDeny returns true when user selects Allow", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
  });
  const result = await promptAllowDeny("Allow access to /tmp?", ctx);
  assertEquals(result, true);
});

Deno.test("promptAllowDeny returns false when user selects Deny", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(false),
  });
  const result = await promptAllowDeny("Allow access to /tmp?", ctx);
  assertEquals(result, false);
});

Deno.test("promptPattern returns edited value", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve("/tmp/*"),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  assertEquals(result, "/tmp/*");
});

Deno.test("promptPattern returns null when input cleared", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve(""),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  assertEquals(result, null);
});

Deno.test("promptPattern returns null on cancel", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve(undefined),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  assertEquals(result, null);
});

Deno.test("confirmAddToConfig returns true when user selects Yes", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(true),
  });
  const result = await confirmAddToConfig("bashAllow", ctx);
  assertEquals(result, true);
});

Deno.test("confirmAddToConfig returns false when user selects No", async () => {
  const ctx = createMockCtx({
    confirm: () => Promise.resolve(false),
  });
  const result = await confirmAddToConfig("bashAllow", ctx);
  assertEquals(result, false);
});

Deno.test("promptPattern trims whitespace from input", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve("  /tmp/*  "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  assertEquals(result, "/tmp/*");
});

Deno.test("promptPattern empty string after trim returns null", async () => {
  const ctx = createMockCtx({
    input: () => Promise.resolve("   "),
  });
  const result = await promptPattern("/tmp/test.txt", "External path pattern", ctx);
  assertEquals(result, null);
});
