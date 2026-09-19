import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { test, mock } from 'node:test';
import type { EventBus } from '@mariozechner/pi-coding-agent';
import { runPiGateBashCommand, runPiGateExternalCommand } from '../../../extensions/pi-gate/command.ts';
import {
  resetSessionState,
  isBashEnabled,
  isExternalEnabled,
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

/** Minimal EventBus stub: records emits, ignores subscriptions. */
function createEventBusStub() {
  const emit = mock.fn();
  const on = mock.fn(() => () => {});
  return { bus: { emit, on } as unknown as EventBus, emit, on };
}

test('/pi-gate-bash toggles the bash guard off and notifies', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });
  const { bus, emit } = createEventBusStub();

  await runPiGateBashCommand('', ctx, bus);

  strictEqual(isBashEnabled(), false);
  strictEqual(isExternalEnabled(), true); // independent
  strictEqual(calls.length, 1);
  strictEqual(calls[0]!.message, 'pi-gate: bash guard OFF (session)');
  strictEqual(calls[0]!.type, 'info');
  strictEqual(emit.mock.calls.length, 1);
  deepStrictEqual(emit.mock.calls[0]!.arguments, ['pi-gate:toggled', { system: 'bash', enabled: false }]);
  resetSessionState();
});

test('/pi-gate-bash toggles the bash guard back on', async () => {
  resetSessionState();
  setBashEnabled(false);
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });
  const { bus, emit } = createEventBusStub();

  await runPiGateBashCommand('', ctx, bus);

  strictEqual(isBashEnabled(), true);
  strictEqual(calls[0]!.message, 'pi-gate: bash guard ON (session)');
  deepStrictEqual(emit.mock.calls[0]!.arguments, ['pi-gate:toggled', { system: 'bash', enabled: true }]);
  resetSessionState();
});

test('/pi-gate-external toggles the external guard off and notifies', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });
  const { bus, emit } = createEventBusStub();

  await runPiGateExternalCommand('', ctx, bus);

  strictEqual(isExternalEnabled(), false);
  strictEqual(isBashEnabled(), true); // independent
  strictEqual(calls[0]!.message, 'pi-gate: external guard OFF (session)');
  strictEqual(calls[0]!.type, 'info');
  deepStrictEqual(emit.mock.calls[0]!.arguments, ['pi-gate:toggled', { system: 'external', enabled: false }]);
  resetSessionState();
});

test('/pi-gate-external toggles the external guard back on', async () => {
  resetSessionState();
  setExternalEnabled(false);
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });

  await runPiGateExternalCommand('', ctx, createEventBusStub().bus);

  strictEqual(isExternalEnabled(), true);
  strictEqual(calls[0]!.message, 'pi-gate: external guard ON (session)');
  resetSessionState();
});

test('commands are independent: each flips only its own guard', async () => {
  resetSessionState();
  const ctx = createCommandContext({ ui: createUIContext() });

  await runPiGateBashCommand('', ctx, createEventBusStub().bus);
  strictEqual(isBashEnabled(), false);
  strictEqual(isExternalEnabled(), true);

  await runPiGateExternalCommand('', ctx, createEventBusStub().bus);
  strictEqual(isBashEnabled(), false);
  strictEqual(isExternalEnabled(), false);

  await runPiGateBashCommand('', ctx, createEventBusStub().bus);
  strictEqual(isBashEnabled(), true);
  strictEqual(isExternalEnabled(), false);
  resetSessionState();
});

test('/pi-gate-bash warns and leaves state unchanged when given arguments', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });
  const { bus, emit } = createEventBusStub();

  await runPiGateBashCommand('off', ctx, bus);

  strictEqual(isBashEnabled(), true);
  strictEqual(emit.mock.calls.length, 0);
  strictEqual(calls.length, 1);
  strictEqual(calls[0]!.type, 'warning');
  ok(calls[0]!.message.includes('/pi-gate-bash takes no arguments'));
  resetSessionState();
});

test('/pi-gate-external warns and leaves state unchanged when given arguments', async () => {
  resetSessionState();
  const { notify, calls } = createNotifySpy();
  const ctx = createCommandContext({ ui: createUIContext({ notify }) });
  const { bus, emit } = createEventBusStub();

  await runPiGateExternalCommand('on', ctx, bus);

  strictEqual(isExternalEnabled(), true);
  strictEqual(emit.mock.calls.length, 0);
  strictEqual(calls[0]!.type, 'warning');
  ok(calls[0]!.message.includes('/pi-gate-external takes no arguments'));
  resetSessionState();
});
