import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { classifyPath, normalizePath, extractPathsFromCommand } from "../guards.ts";

test("project file classification", () => {
  strictEqual(classifyPath("/project/src/main.ts", "/project"), "project");
});

test("external file classification", () => {
  strictEqual(classifyPath("/etc/passwd", "/project"), "external");
});

test("tilde expansion to home directory", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/home/testuser";
  try {
    strictEqual(normalizePath("~/file.txt", "/cwd"), "/home/testuser/file.txt");
  } finally {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  }
});

test("relative path resolution with ./", () => {
  strictEqual(normalizePath("./file.txt", "/project"), "/project/file.txt");
});

test("relative path without dot prefix", () => {
  strictEqual(normalizePath("file.txt", "/project"), "/project/file.txt");
});

test("extract simple file arguments from command", () => {
  deepStrictEqual(extractPathsFromCommand("cat foo.txt"), ["foo.txt"]);
});

test("parent directory escape", () => {
  strictEqual(classifyPath("../../../etc/passwd", "/project"), "external");
});

test("double slash normalization", () => {
  strictEqual(normalizePath("/project//src//file.ts", "/project"), "/project/src/file.ts");
});

test("trailing slash on directory", () => {
  strictEqual(normalizePath("/project/src/", "/project"), "/project/src");
});

test("current directory redundancy", () => {
  strictEqual(normalizePath("./././file.txt", "/project"), "/project/file.txt");
});

test("file at cwd boundary", () => {
  strictEqual(classifyPath("/project", "/project"), "project");
});

test("command with flags filtered, paths extracted", () => {
  deepStrictEqual(extractPathsFromCommand("ls -la /tmp"), ["/tmp"]);
});

test("command with no paths returns empty array", () => {
  deepStrictEqual(extractPathsFromCommand("ls -la"), []);
});

test("quoted paths with spaces naively parsed", () => {
  deepStrictEqual(extractPathsFromCommand('cat "my file.txt"'), ['"my', 'file.txt"']);
});

test("environment variables not expanded", () => {
  deepStrictEqual(extractPathsFromCommand("echo $HOME"), ["$HOME"]);
});
