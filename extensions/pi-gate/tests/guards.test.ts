import { assertEquals } from "@std/assert";
import { classifyPath, normalizePath, extractPathsFromCommand } from "../guards.ts";

Deno.test("project file classification", () => {
  assertEquals(classifyPath("/project/src/main.ts", "/project"), "project");
});

Deno.test("external file classification", () => {
  assertEquals(classifyPath("/etc/passwd", "/project"), "external");
});

Deno.test("tilde expansion to home directory", () => {
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", "/home/testuser");
  try {
    assertEquals(normalizePath("~/file.txt", "/cwd"), "/home/testuser/file.txt");
  } finally {
    if (originalHome !== undefined) Deno.env.set("HOME", originalHome);
    else Deno.env.delete("HOME");
  }
});

Deno.test("relative path resolution with ./", () => {
  assertEquals(normalizePath("./file.txt", "/project"), "/project/file.txt");
});

Deno.test("relative path without dot prefix", () => {
  assertEquals(normalizePath("file.txt", "/project"), "/project/file.txt");
});

Deno.test("extract simple file arguments from command", () => {
  assertEquals(extractPathsFromCommand("cat foo.txt"), ["foo.txt"]);
});

Deno.test("parent directory escape", () => {
  assertEquals(classifyPath("../../../etc/passwd", "/project"), "external");
});

Deno.test("double slash normalization", () => {
  assertEquals(normalizePath("/project//src//file.ts", "/project"), "/project/src/file.ts");
});

Deno.test("trailing slash on directory", () => {
  assertEquals(normalizePath("/project/src/", "/project"), "/project/src");
});

Deno.test("current directory redundancy", () => {
  assertEquals(normalizePath("./././file.txt", "/project"), "/project/file.txt");
});

Deno.test("file at cwd boundary", () => {
  assertEquals(classifyPath("/project", "/project"), "project");
});

Deno.test("command with flags filtered, paths extracted", () => {
  assertEquals(extractPathsFromCommand("ls -la /tmp"), ["/tmp"]);
});

Deno.test("command with no paths returns empty array", () => {
  assertEquals(extractPathsFromCommand("ls -la"), []);
});

Deno.test("quoted paths with spaces naively parsed", () => {
  assertEquals(extractPathsFromCommand('cat "my file.txt"'), ['"my', 'file.txt"']);
});

Deno.test("environment variables not expanded", () => {
  assertEquals(extractPathsFromCommand("echo $HOME"), ["$HOME"]);
});
