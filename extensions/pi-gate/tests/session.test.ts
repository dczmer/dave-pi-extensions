import { strictEqual } from "node:assert";
import { test } from "node:test";
import {
  approveExternal,
  approveBashPattern,
  getSessionState,
  isExternalApproved,
  isBashPatternApproved,
  resetSessionState,
} from "../session.ts";

test("approve and check external path", () => {
  resetSessionState();
  approveExternal("/tmp/test.txt");
  strictEqual(isExternalApproved("/tmp/test.txt"), true);
});

test("approve and check bash pattern", () => {
  resetSessionState();
  approveBashPattern("ls *");
  strictEqual(isBashPatternApproved("ls -la"), true);
});

test("multiple externals approved", () => {
  resetSessionState();
  approveExternal("/tmp/a.txt");
  approveExternal("/tmp/b.txt");
  strictEqual(isExternalApproved("/tmp/a.txt"), true);
  strictEqual(isExternalApproved("/tmp/b.txt"), true);
});

test("multiple bash patterns approved", () => {
  resetSessionState();
  approveBashPattern("ls *");
  approveBashPattern("cat *");
  strictEqual(isBashPatternApproved("ls -la"), true);
  strictEqual(isBashPatternApproved("cat file.txt"), true);
});

test("getSessionState returns current state", () => {
  resetSessionState();
  approveExternal("/tmp/x.txt");
  const s = getSessionState();
  strictEqual(s.approvedExternals.has("/tmp/x.txt"), true);
});

test("unapproved external returns false", () => {
  resetSessionState();
  strictEqual(isExternalApproved("/tmp/nope.txt"), false);
});

test("unapproved bash pattern returns false", () => {
  resetSessionState();
  strictEqual(isBashPatternApproved("rm -rf /"), false);
});

test("session isolation (fresh session has no approvals)", () => {
  resetSessionState();
  strictEqual(isExternalApproved("/anything"), false);
  strictEqual(isBashPatternApproved("anything"), false);
});

test("approving same path twice is idempotent", () => {
  resetSessionState();
  approveExternal("/tmp/same.txt");
  approveExternal("/tmp/same.txt");
  strictEqual(getSessionState().approvedExternals.size, 1);
});

test("approving same pattern twice is idempotent", () => {
  resetSessionState();
  approveBashPattern("ls *");
  approveBashPattern("ls *");
  strictEqual(getSessionState().approvedBashPatterns.size, 1);
});

test("empty session state (fresh sets are empty)", () => {
  resetSessionState();
  strictEqual(getSessionState().approvedExternals.size, 0);
  strictEqual(getSessionState().approvedBashPatterns.size, 0);
});
