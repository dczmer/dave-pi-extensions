import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import {
  approveExternalPattern,
  approveBashPattern,
  getSessionState,
  isExternalApproved,
  isBashPatternApproved,
  resetSessionState,
} from '../../../extensions/pi-gate/session.ts';

test('approve and check external path (exact match)', () => {
  resetSessionState();
  approveExternalPattern('/tmp/test.txt');
  strictEqual(isExternalApproved('/tmp/test.txt'), true);
  strictEqual(isExternalApproved('/tmp/test.txtx'), false);
});

test('approve and check bash pattern', () => {
  resetSessionState();
  approveBashPattern('ls *');
  strictEqual(isBashPatternApproved('ls -la'), true);
});

test('directory prefix approves descendants', () => {
  resetSessionState();
  approveExternalPattern('/tmp/allowed-dir');
  strictEqual(isExternalApproved('/tmp/allowed-dir/sub/file.txt'), true);
  strictEqual(isExternalApproved('/tmp/allowed-dir'), true); // exact match
});

test('directory prefix rejects siblings and prefixes without slash', () => {
  resetSessionState();
  approveExternalPattern('/tmp/allowed-dir');
  strictEqual(isExternalApproved('/tmp/allowed-dir2/x.txt'), false); // sibling, not descendant
  strictEqual(isExternalApproved('/tmp/allowed'), false); // prefix without '/' is not a descendant
});

test('glob pattern with * crossing slashes', () => {
  resetSessionState();
  approveExternalPattern('/nix/blahblah/*');
  strictEqual(isExternalApproved('/nix/blahblah/foo'), true);
  strictEqual(isExternalApproved('/nix/blahblah/a/b/c'), true); // '*' crosses '/'
  strictEqual(isExternalApproved('/nix/blahblah'), false);
});

test('trailing-slash entries are sanitized at check time', () => {
  resetSessionState();
  approveExternalPattern('/tmp/slashed-dir/');
  strictEqual(isExternalApproved('/tmp/slashed-dir/file.txt'), true); // descendant after strip
  strictEqual(isExternalApproved('/tmp/slashed-dir'), true); // exact after strip
});

test('multiple externals approved', () => {
  resetSessionState();
  approveExternalPattern('/tmp/a.txt');
  approveExternalPattern('/tmp/b.txt');
  strictEqual(isExternalApproved('/tmp/a.txt'), true);
  strictEqual(isExternalApproved('/tmp/b.txt'), true);
});

test('multiple bash patterns approved', () => {
  resetSessionState();
  approveBashPattern('ls *');
  approveBashPattern('cat *');
  strictEqual(isBashPatternApproved('ls -la'), true);
  strictEqual(isBashPatternApproved('cat file.txt'), true);
});

test('getSessionState returns current state', () => {
  resetSessionState();
  approveExternalPattern('/tmp/x.txt');
  const s = getSessionState();
  strictEqual(s.approvedExternalPatterns.has('/tmp/x.txt'), true);
});

test('unapproved external returns false', () => {
  resetSessionState();
  strictEqual(isExternalApproved('/tmp/nope.txt'), false);
});

test('unapproved bash pattern returns false', () => {
  resetSessionState();
  strictEqual(isBashPatternApproved('rm -rf /'), false);
});

test('session isolation (fresh session has no approvals)', () => {
  resetSessionState();
  strictEqual(isExternalApproved('/anything'), false);
  strictEqual(isBashPatternApproved('anything'), false);
});

test('approving same path twice is idempotent', () => {
  resetSessionState();
  approveExternalPattern('/tmp/same.txt');
  approveExternalPattern('/tmp/same.txt');
  strictEqual(getSessionState().approvedExternalPatterns.size, 1);
});

test('approving same pattern twice is idempotent', () => {
  resetSessionState();
  approveBashPattern('ls *');
  approveBashPattern('ls *');
  strictEqual(getSessionState().approvedBashPatterns.size, 1);
});

test('empty session state (fresh sets are empty)', () => {
  resetSessionState();
  strictEqual(getSessionState().approvedExternalPatterns.size, 0);
  strictEqual(getSessionState().approvedBashPatterns.size, 0);
});
