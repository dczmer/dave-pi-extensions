import { strictEqual } from 'node:assert';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTempDir } from '../../../test/utils/temp-dir.ts';
import { setStateLogOverride, initSharedState, isSharedStateActive } from '../../../extensions/pi-gate/state-log.ts';
import {
  approveExternalPattern,
  approveBashPattern,
  getApprovedBashPatterns,
  getApprovedExternalPatterns,
  getSessionState,
  isExternalApproved,
  isBashPatternApproved,
  resetSessionState,
  isBashEnabled,
  setBashEnabled,
  isExternalEnabled,
  setExternalEnabled,
  markPiGateLoaded,
  isPiGateLoaded,
  resetPiGateLoaded,
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

test('guards default to enabled in a fresh session', () => {
  resetSessionState();
  strictEqual(isBashEnabled(), true);
  strictEqual(isExternalEnabled(), true);
});

test('bash guard can be disabled and re-enabled', () => {
  resetSessionState();
  setBashEnabled(false);
  strictEqual(isBashEnabled(), false);
  strictEqual(isExternalEnabled(), true); // independent
  setBashEnabled(true);
  strictEqual(isBashEnabled(), true);
});

test('external guard can be disabled and re-enabled', () => {
  resetSessionState();
  setExternalEnabled(false);
  strictEqual(isExternalEnabled(), false);
  strictEqual(isBashEnabled(), true); // independent
  setExternalEnabled(true);
  strictEqual(isExternalEnabled(), true);
});

test('resetSessionState restores both guards to enabled', () => {
  setBashEnabled(false);
  setExternalEnabled(false);
  resetSessionState();
  strictEqual(isBashEnabled(), true);
  strictEqual(isExternalEnabled(), true);
});

test('piGateLoaded defaults to false in a fresh process', () => {
  resetPiGateLoaded();
  strictEqual(isPiGateLoaded(), false);
});

test('markPiGateLoaded sets the loaded flag', () => {
  resetPiGateLoaded();
  markPiGateLoaded();
  strictEqual(isPiGateLoaded(), true);
  resetPiGateLoaded();
});

test('resetPiGateLoaded clears the loaded flag', () => {
  markPiGateLoaded();
  strictEqual(isPiGateLoaded(), true);
  resetPiGateLoaded();
  strictEqual(isPiGateLoaded(), false);
});

test('resetSessionState does not clear the loaded flag', () => {
  markPiGateLoaded();
  resetSessionState();
  strictEqual(isPiGateLoaded(), true);
  resetPiGateLoaded();
});

test('session state singleton is shared via globalThis across getSessionState calls', () => {
  resetSessionState();
  getSessionState().approvedBashPatterns.add('shared-*');
  strictEqual(isBashPatternApproved('shared-anything'), true);
  resetSessionState();
});

test('resetSessionState drops the shared-log handle and override', () =>
  withTempDir('pi-gate-', (dir) => {
    resetSessionState();
    setStateLogOverride(join(dir, 'state.jsonl'));
    initSharedState(dir);
    strictEqual(isSharedStateActive(), true);

    resetSessionState();

    strictEqual(isSharedStateActive(), false);
  }));

test('approval write-through: shared log approves for a fresh handle', () =>
  withTempDir('pi-gate-', (dir) => {
    resetSessionState();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    approveExternalPattern('/shared/dir');
    approveBashPattern('npm run *');
    strictEqual(isExternalApproved('/shared/dir'), true);

    // Fresh handle (subagent child) sees the approvals.
    setStateLogOverride(undefined);
    setStateLogOverride(file);
    initSharedState(dir);
    strictEqual(isExternalApproved('/shared/dir/sub/file.txt'), true);
    strictEqual(isBashPatternApproved('npm run build'), true);
    strictEqual(getApprovedExternalPatterns().has('/shared/dir'), true);
    strictEqual(getApprovedBashPatterns().has('npm run *'), true);
    resetSessionState();
  }));

test('toggle write-through: a fresh handle sees the guard disabled', () =>
  withTempDir('pi-gate-', (dir) => {
    resetSessionState();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    setBashEnabled(false);
    setExternalEnabled(false);

    setStateLogOverride(undefined);
    setStateLogOverride(file);
    initSharedState(dir);
    strictEqual(isBashEnabled(), false);
    strictEqual(isExternalEnabled(), false);
    resetSessionState();
  }));

test('local approvals merge with shared-log approvals in the getters', () =>
  withTempDir('pi-gate-', (dir) => {
    resetSessionState();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    approveBashPattern('local *');
    // Simulate a sibling process writing to the log directly.
    appendFileSync(
      file,
      JSON.stringify({ v: 1, op: 'approve-bash', ts: Date.now(), pid: 123456, pattern: 'shared *' }) + '\n',
    );

    strictEqual(isBashPatternApproved('local x'), true);
    strictEqual(isBashPatternApproved('shared x'), true);
    resetSessionState();
  }));

test('/new semantics: approvals persist while toggles re-enable write-through', () =>
  withTempDir('pi-gate-', (dir) => {
    resetSessionState();
    const file = join(dir, 'state.jsonl');
    setStateLogOverride(file);
    initSharedState(dir);

    approveBashPattern('persist *');
    setBashEnabled(false);
    setExternalEnabled(false);

    // /new: drop in-process state, then re-enable both guards.
    resetSessionState();
    setStateLogOverride(file);
    initSharedState(dir);
    setBashEnabled(true);
    setExternalEnabled(true);

    // Approvals survived; toggles read back enabled even from a fresh handle.
    strictEqual(isBashPatternApproved('persist x'), true);
    strictEqual(isBashEnabled(), true);
    strictEqual(isExternalEnabled(), true);
    setStateLogOverride(undefined);
    setStateLogOverride(file);
    initSharedState(dir);
    strictEqual(isBashEnabled(), true);
    strictEqual(isExternalEnabled(), true);
    strictEqual(isBashPatternApproved('persist x'), true);
    resetSessionState();
  }));
