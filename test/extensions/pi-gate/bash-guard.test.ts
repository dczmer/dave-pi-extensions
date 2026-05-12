import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { type ConfigResult } from "../../../extensions/pi-gate/config.ts";
import { checkBashCommand, parseCommandStatements } from "../../../extensions/pi-gate/bash-guard.ts";
import { resetSessionState, approveBashPattern } from "../../../extensions/pi-gate/session.ts";

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

function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const empty = () => ({
    bashAllow: [] as string[],
    externalAllow: [] as string[],
    projectDeny: [] as string[],
  });
  return {
    merged: { ...empty(), ...(overrides?.merged || {}) },
    global: { ...empty(), ...(overrides?.global || {}) },
    project: { ...empty(), ...(overrides?.project || {}) },
    globalPath: "/fake/global.json",
    projectPath: "/fake/project.json",
    ...overrides,
  };
}

test("command allowed by config bashAllow pattern", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["ls *"], externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["ls *"], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("ls -la", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("command allowed by session approved pattern", async () => {
  resetSessionState();
  approveBashPattern("cat *");
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [], projectDeny: [] },
    project: { bashAllow: [], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cat file.txt", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("command with project files all allowed", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cat *"], externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["cat *"], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cat main.ts", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("command with external files all allowed", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cat *"], externalAllow: ["/tmp/*"], projectDeny: [] },
    project: { bashAllow: ["cat *"], externalAllow: ["/tmp/*"], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cat /tmp/foo.txt", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("no match prompts user, allows, persists to project, recurses, succeeds", async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, ".pi", "extensions", "pi-gate.json");
    const globalPath = join(dir, "global.json");
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueEditor("xyz-custom-cmd *");
    ctx.queueSelect("Project");

    const result = await checkBashCommand("xyz-custom-cmd arg", dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, ["xyz-custom-cmd *"]);

    const saved = JSON.parse(readFileSync(projectPath, "utf-8"));
    deepStrictEqual(saved, { bashAllow: ["xyz-custom-cmd *"], externalAllow: [], projectDeny: [] });
  });
});

test("no match prompts user, allows, persists to global, recurses, succeeds", async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, ".pi", "extensions", "pi-gate.json");
    const globalPath = join(dir, "global.json");
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueEditor("abc-global-test-cmd *");
    ctx.queueSelect("Global");

    const result = await checkBashCommand("abc-global-test-cmd arg", dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, []);
    deepStrictEqual(configResult.global.bashAllow, ["abc-global-test-cmd *"]);

    const saved = JSON.parse(readFileSync(globalPath, "utf-8"));
    deepStrictEqual(saved, { bashAllow: ["abc-global-test-cmd *"], externalAllow: [], projectDeny: [] });
  });
});

test("no match prompts user, allows, skips persist, recurses, succeeds", async () => {
  withTempDir(async (dir) => {
    const projectPath = join(dir, ".pi", "extensions", "pi-gate.json");
    const globalPath = join(dir, "global.json");
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createMockCtx();
    ctx.queueConfirm(true);
    ctx.queueEditor("def-skip-test-cmd *");
    ctx.queueSelect("No");

    const result = await checkBashCommand("def-skip-test-cmd arg", dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, []);
    deepStrictEqual(configResult.global.bashAllow, []);

    strictEqual(existsSync(projectPath), false);
    strictEqual(existsSync(globalPath), false);
  });
});

test("pattern matches but file access denies", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cat *"], externalAllow: [], projectDeny: ["secret.txt"] },
    project: { bashAllow: ["cat *"], externalAllow: [], projectDeny: ["secret.txt"] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cat secret.txt", "/fake/cwd", configResult, ctx);
  strictEqual(result, false);
  strictEqual(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
});

test("user denies command at prompt", async () => {
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  ctx.queueConfirm(false);

  const result = await checkBashCommand("rm -rf /", "/fake/cwd", configResult, ctx);
  strictEqual(result, false);
});

test("user allows command but clears pattern", async () => {
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  ctx.queueConfirm(true);
  ctx.queueEditor("");

  const result = await checkBashCommand("rm -rf /", "/fake/cwd", configResult, ctx);
  strictEqual(result, false);
});

test("multiple files in command, one denied", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cat *"], externalAllow: [], projectDeny: ["secret.txt"] },
    project: { bashAllow: ["cat *"], externalAllow: [], projectDeny: ["secret.txt"] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cat main.ts secret.txt", "/fake/cwd", configResult, ctx);
  strictEqual(result, false);
  strictEqual(ctx._notifications.some((n) => n.message.includes("Blocked")), true);
});

test("command with no file arguments", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["ls *"], externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["ls *"], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("ls -la", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("recursion doesn't cause infinite loop", async () => {
  const configResult = createConfigResult();
  const ctx = createMockCtx();
  ctx.queueConfirm(true);
  ctx.queueEditor("custom-cmd *");
  ctx.queueSelect("No");

  const result = await checkBashCommand("custom-cmd arg", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("parseCommandStatements: simple command", () => {
  const result = parseCommandStatements("ls -la");
  deepStrictEqual(result, ["ls -la"]);
});

test("parseCommandStatements: cd && npm test", () => {
  const result = parseCommandStatements("cd /home/dave && npm test");
  deepStrictEqual(result, ["cd /home/dave", "npm test"]);
});

test("parseCommandStatements: cd /path && cmd", () => {
  const result = parseCommandStatements("cd /some/path && ls -la");
  deepStrictEqual(result, ["cd /some/path", "ls -la"]);
});

test("parseCommandStatements: semicolon separator", () => {
  const result = parseCommandStatements("cd /home; ls");
  deepStrictEqual(result, ["cd /home", "ls"]);
});

test("parseCommandStatements: multiple semicolons", () => {
  const result = parseCommandStatements("echo a; echo b; echo c");
  deepStrictEqual(result, ["echo a", "echo b", "echo c"]);
});

test("parseCommandStatements: || separator", () => {
  const result = parseCommandStatements("cat file || echo 'not found'");
  deepStrictEqual(result, ["cat file", "echo 'not found'"]);
});

test("parseCommandStatements: mixed separators", () => {
  const result = parseCommandStatements("cd /tmp && ls || echo fail; echo done");
  deepStrictEqual(result, ["cd /tmp", "ls", "echo fail", "echo done"]);
});

test("parseCommandStatements: command substitution $(...)", () => {
  const result = parseCommandStatements('echo "my name is $(whoami)."');
  deepStrictEqual(result, ['echo "my name is $(whoami)."', "whoami"]);
});

test("parseCommandStatements: multiple substitutions", () => {
  const result = parseCommandStatements("echo $(date) && echo $(pwd)");
  deepStrictEqual(result, ["echo $(date)", "date", "echo $(pwd)", "pwd"]);
});

test("parseCommandStatements: nested substitutions", () => {
  const result = parseCommandStatements("echo $(echo $(whoami))");
  strictEqual(result, null);
});

test("parseCommandStatements: handles quoted strings with separators", () => {
  const result = parseCommandStatements('echo "foo && bar" && ls');
  deepStrictEqual(result, ['echo "foo && bar"', "ls"]);
});

test("parseCommandStatements: heredoc with && inside not split", () => {
  const cmd = `cat <<EOF
Fix bug && close issue
Handle edge; case properly
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test("parseCommandStatements: heredoc with <<- strips leading tabs", () => {
  const cmd = `cat <<-EOF
\t\tcontent with && and ;
\tEOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test("parseCommandStatements: quoted heredoc delimiter", () => {
  const cmd = `cat <<'EOF'
Fix bug && close issue
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test("parseCommandStatements: heredoc followed by && command", () => {
  const cmd = `cat <<EOF
content
EOF && echo done`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test("parseCommandStatements: git commit with heredoc message", () => {
  const cmd = `git commit -F - <<EOF
Fix bug && close issue

Handle edge; case properly
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test("compound command: all statements allowed", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cd *", "ls *"], externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["cd *", "ls *"], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  const result = await checkBashCommand("cd subdir && ls -la", "/fake/cwd", configResult, ctx);
  strictEqual(result, true);
});

test("compound command: one statement denied", async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ["cd *"], externalAllow: [], projectDeny: [] },
    project: { bashAllow: ["cd *"], externalAllow: [], projectDeny: [] },
    global: { bashAllow: [], externalAllow: [], projectDeny: [] },
  });
  const ctx = createMockCtx();
  ctx.queueConfirm(false);

  const result = await checkBashCommand("cd /home && rm -rf /", "/fake/cwd", configResult, ctx);
  strictEqual(result, false);
});
