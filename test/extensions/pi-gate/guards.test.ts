import { strictEqual, deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyPath, normalizePath, extractPathsFromCommand } from "../../../extensions/pi-gate/guards.ts";

test("project file classification", () => {
  strictEqual(classifyPath("/project/src/main.ts", "/project"), "project");
});

test("external file classification", () => {
  strictEqual(classifyPath("/etc/passwd", "/project"), "external");
});

test("tilde expansion to home directory", () => {
  strictEqual(normalizePath("~/file.txt", "/cwd"), join(homedir(), "file.txt"));
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

test("quoted paths are skipped (not treated as file paths)", () => {
  deepStrictEqual(extractPathsFromCommand('cat "my file.txt"'), []);
});

test("environment variables not expanded", () => {
  deepStrictEqual(extractPathsFromCommand("echo $HOME"), ["$HOME"]);
});

test("paths inside single quotes are skipped", () => {
  deepStrictEqual(extractPathsFromCommand("cat '/etc/passwd'"), []);
});

test("paths inside double quotes are skipped", () => {
  deepStrictEqual(extractPathsFromCommand('cat "/tmp/test.txt"'), []);
});

test("paths inside ANSI-C quotes are skipped", () => {
  deepStrictEqual(extractPathsFromCommand("cat $'/tmp/file\\n.txt'"), []);
});

test("paths inside command substitutions are skipped", () => {
  deepStrictEqual(extractPathsFromCommand("cat $(echo /tmp/test.txt)"), []);
});

test("unquoted paths are still extracted", () => {
  deepStrictEqual(extractPathsFromCommand("cat /tmp/test.txt"), ["/tmp/test.txt"]);
});

test("mixed quoted and unquoted paths", () => {
  deepStrictEqual(extractPathsFromCommand('cat "/tmp/quoted.txt" /tmp/unquoted.txt'), ["/tmp/unquoted.txt"]);
});
