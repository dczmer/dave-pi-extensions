import { assertEquals } from "@std/assert";
import { matchesGlob, matchesAnyGlob } from "../matcher.ts";

Deno.test("exact string match", () => {
  assertEquals(matchesGlob("ls", "ls"), true);
});

Deno.test("single wildcard * matches any chars", () => {
  assertEquals(matchesGlob("anything", "*"), true);
});

Deno.test("wildcard at end only", () => {
  assertEquals(matchesGlob("cat foo.txt", "cat *"), true);
});

Deno.test("wildcard in middle", () => {
  assertEquals(matchesGlob("file123.txt", "file*.txt"), true);
  assertEquals(matchesGlob("file.txt", "file*.txt"), true);
});

Deno.test("multiple wildcards", () => {
  assertEquals(matchesGlob("src/main.txt", "*/*.txt"), true);
  assertEquals(matchesGlob("a/b/c.txt", "*/*/*.txt"), true);
});

Deno.test("? single character match", () => {
  assertEquals(matchesGlob("abc", "a?c"), true);
});

Deno.test("? rejects zero chars", () => {
  assertEquals(matchesGlob("ac", "a?c"), false);
});

Deno.test("? rejects multiple chars", () => {
  assertEquals(matchesGlob("abbc", "a?c"), false);
});

Deno.test("matchesAnyGlob first match", () => {
  assertEquals(matchesAnyGlob("ls", ["ls", "cat"]), true);
});

Deno.test("matchesAnyGlob second match", () => {
  assertEquals(matchesAnyGlob("cat", ["ls", "cat"]), true);
});

Deno.test("matchesAnyGlob no match", () => {
  assertEquals(matchesAnyGlob("rm", ["ls", "cat"]), false);
});

Deno.test("empty pattern returns false", () => {
  assertEquals(matchesGlob("ls", ""), false);
});

Deno.test("empty value matches *", () => {
  assertEquals(matchesGlob("", "*"), true);
});

Deno.test("pattern equals value with literal * char", () => {
  assertEquals(matchesGlob("ls -la *", "ls -la *"), true);
});

Deno.test("case sensitivity (Unix-style)", () => {
  assertEquals(matchesGlob("LS", "ls"), false);
  assertEquals(matchesGlob("ls", "LS"), false);
});

Deno.test("special regex chars treated as literal", () => {
  assertEquals(matchesGlob("a.b", "a.b"), true);
  assertEquals(matchesGlob("a+b", "a+b"), true);
  assertEquals(matchesGlob("a(b)", "a(b)"), true);
});

Deno.test("pattern longer than value returns false", () => {
  assertEquals(matchesGlob("ls", "ls -l"), false);
});

Deno.test("value longer than pattern returns false", () => {
  assertEquals(matchesGlob("ls -l", "ls"), false);
});
