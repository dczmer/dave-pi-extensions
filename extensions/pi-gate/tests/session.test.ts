import { assertEquals } from "@std/assert";
import {
  approveExternal,
  approveBashPattern,
  getSessionState,
  isExternalApproved,
  isBashPatternApproved,
  resetSessionState,
} from "../session.ts";

Deno.test("approve and check external path", () => {
  resetSessionState();
  approveExternal("/tmp/test.txt");
  assertEquals(isExternalApproved("/tmp/test.txt"), true);
});

Deno.test("approve and check bash pattern", () => {
  resetSessionState();
  approveBashPattern("ls *");
  assertEquals(isBashPatternApproved("ls -la"), true);
});

Deno.test("multiple externals approved", () => {
  resetSessionState();
  approveExternal("/tmp/a.txt");
  approveExternal("/tmp/b.txt");
  assertEquals(isExternalApproved("/tmp/a.txt"), true);
  assertEquals(isExternalApproved("/tmp/b.txt"), true);
});

Deno.test("multiple bash patterns approved", () => {
  resetSessionState();
  approveBashPattern("ls *");
  approveBashPattern("cat *");
  assertEquals(isBashPatternApproved("ls -la"), true);
  assertEquals(isBashPatternApproved("cat file.txt"), true);
});

Deno.test("getSessionState returns current state", () => {
  resetSessionState();
  approveExternal("/tmp/x.txt");
  const s = getSessionState();
  assertEquals(s.approvedExternals.has("/tmp/x.txt"), true);
});

Deno.test("unapproved external returns false", () => {
  resetSessionState();
  assertEquals(isExternalApproved("/tmp/nope.txt"), false);
});

Deno.test("unapproved bash pattern returns false", () => {
  resetSessionState();
  assertEquals(isBashPatternApproved("rm -rf /"), false);
});

Deno.test("session isolation (fresh session has no approvals)", () => {
  resetSessionState();
  assertEquals(isExternalApproved("/anything"), false);
  assertEquals(isBashPatternApproved("anything"), false);
});

Deno.test("approving same path twice is idempotent", () => {
  resetSessionState();
  approveExternal("/tmp/same.txt");
  approveExternal("/tmp/same.txt");
  assertEquals(getSessionState().approvedExternals.size, 1);
});

Deno.test("approving same pattern twice is idempotent", () => {
  resetSessionState();
  approveBashPattern("ls *");
  approveBashPattern("ls *");
  assertEquals(getSessionState().approvedBashPatterns.size, 1);
});

Deno.test("empty session state (fresh sets are empty)", () => {
  resetSessionState();
  assertEquals(getSessionState().approvedExternals.size, 0);
  assertEquals(getSessionState().approvedBashPatterns.size, 0);
});
