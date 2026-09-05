import { strictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import { runPiGateCommand, piGateCompletions, statusMessage } from '../../../extensions/pi-gate/command.ts';
import {
  resetSessionState,
  isBashEnabled,
  isExternalEnabled,
  approveBashPattern,
  approveExternalPattern,
  setBashEnabled,
  setExternalEnabled,
} from '../../../extensions/pi-gate/session.ts';
import { createCommandContext, createUIContext } from '../../utils/pi-context.ts';

type NotifyCall = { message: string; type?: 'info' | 'warning' | 'error' | undefined };

function createNotifySpy() {
  const calls: NotifyCall[] = [];
  const notify = mock.fn((message: string, type?: 'info' | 'warning' | 'error') => {
    calls.push({ message, type });
  });
  return { notify, calls };
}

test('bash off disables the bash guard and notifies', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateCommand('bash off', ctx);

  strictEqual(isBashEnabled(), false);
  strictEqual(isExternalEnabled(), true); // independent
  strictEqual(calls.length, 1);
  strictEqual(calls[0]!.message, 'pi-gate: bash guard OFF (session)');
  strictEqual(calls[0]!.type, 'info');
  resetSessionState();
});

test('external off disables the external guard and notifies', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateCommand('external off', ctx);

  strictEqual(isExternalEnabled(), false);
  strictEqual(isBashEnabled(), true); // independent
  strictEqual(calls[0]!.message, 'pi-gate: external guard OFF (session)');
  resetSessionState();
});

test('arguments are case-insensitive', async () => {
  resetSessionState();
  const ctx = createCommandContext({ ui: createUIContext() });

  await runPiGateCommand('BASH OFF', ctx);
  strictEqual(isBashEnabled(), false);

  await runPiGateCommand('bash ON', ctx);
  strictEqual(isBashEnabled(), true);
  resetSessionState();
});

test('status notifies with both guard states and approval counts', async () => {
  resetSessionState();
  approveBashPattern('ls *');
  approveExternalPattern('/tmp/x');
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateCommand('status', ctx);

  strictEqual(calls.length, 1);
  ok(calls[0]!.message.includes('bash guard ON'));
  ok(calls[0]!.message.includes('external path guard ON'));
  ok(calls[0]!.message.includes('1 bash pattern(s)'));
  ok(calls[0]!.message.includes('1 external path(s)'));
  strictEqual(calls[0]!.type, 'info');
  resetSessionState();
});

test('status message reflects disabled guards', () => {
  resetSessionState();
  strictEqual(statusMessage().includes('bash guard ON'), true);
  strictEqual(statusMessage().includes('external path guard ON'), true);

  setBashEnabled(false);
  setExternalEnabled(false);
  strictEqual(statusMessage().includes('bash guard OFF'), true);
  strictEqual(statusMessage().includes('external path guard OFF'), true);
  resetSessionState();
});

test('unknown usage warns and leaves state unchanged', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateCommand('frobnicate on', ctx);

  strictEqual(isBashEnabled(), true);
  strictEqual(isExternalEnabled(), true);
  strictEqual(calls.length, 1);
  strictEqual(calls[0]!.type, 'warning');
  ok(calls[0]!.message.includes('unknown usage'));
  resetSessionState();
});

test('partial usage warns and leaves state unchanged', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateCommand('bash', ctx);

  strictEqual(isBashEnabled(), true);
  strictEqual(calls[0]!.type, 'warning');
  resetSessionState();
});

test('no args opens the picker and applies the selected toggle', async () => {
  resetSessionState();
  let pickerOptions: string[] = [];
  const select = mock.fn(async (_title: string, options: string[]) => {
    pickerOptions = options;
    return 'external off';
  });
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ select, notify }) });

  await runPiGateCommand('', ctx);

  strictEqual(select.mock.calls.length, 1);
  deepStrictEqualSet(pickerOptions, ['bash on', 'bash off', 'external on', 'external off']);
  strictEqual(isExternalEnabled(), false);
  strictEqual(calls[0]!.message, 'pi-gate: external guard OFF (session)');
  resetSessionState();
});

test('picker cancellation leaves state unchanged', async () => {
  resetSessionState();
  const select = mock.fn(async () => undefined);
  const ctx = createCommandContext({ ui: createUIContext({ select }) });

  await runPiGateCommand('', ctx);

  strictEqual(select.mock.calls.length, 1);
  strictEqual(isBashEnabled(), true);
  strictEqual(isExternalEnabled(), true);
  resetSessionState();
});

test('completions filter by prefix', () => {
  const bashItems = piGateCompletions('bash');
  strictEqual(bashItems?.length, 2);
  strictEqual(bashItems?.[0]!.value, 'bash on');
  strictEqual(bashItems?.[1]!.value, 'bash off');

  const all = piGateCompletions('');
  strictEqual(all?.length, 5);
  ok(all?.some((i) => i.value === 'status'));

  strictEqual(piGateCompletions('zzz'), null);
});

function deepStrictEqualSet(actual: string[], expected: string[]) {
  strictEqual(actual.length, expected.length);
  for (const item of expected) {
    ok(actual.includes(item), `missing option: ${item}`);
  }
}
