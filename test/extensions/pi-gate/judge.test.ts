import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import type { AssistantMessage, Context, Model, ModelsApiStreamOptions } from '@earendil-works/pi-ai';
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  judgeBashCommand,
  parseJudgeDetails,
  parseModelRef,
  parseVerdict,
  type JudgePromptInput,
} from '../../../extensions/pi-gate/judge.ts';
import { resetSessionState, approveBashPattern, approveExternalPattern } from '../../../extensions/pi-gate/session.ts';
import {
  createQueuedUIContext,
  createAssistantMessage,
  createModelRegistryStub,
  createSessionManagerStub,
} from '../../utils/pi-context.ts';
import { createConfigResult } from './utils/config.ts';

const JUDGE_RESPONSE = `VERDICT: YES
SUMMARY: Lists the project directory.
AFFECTED PATHS: /fake/cwd
REASON: Benign read-only listing confined to the project.`;

const fakeModel = { provider: 'p', id: 'm' } as unknown as Model<any>;

function createJudgeConfig(model?: string) {
  return createConfigResult({
    global: {
      bashAllow: ['ls *'],
      externalAllow: [],
      ...(model !== undefined ? { commandVerificationModel: model } : {}),
    },
  });
}

function createJudgeContext(overrides: Parameters<typeof createQueuedUIContext>[0] = {}) {
  return createQueuedUIContext({
    modelRegistry: createModelRegistryStub({ models: [fakeModel] }),
    ...overrides,
  });
}

/** Context with a capturable `setStatus` mock for progress-indicator assertions. */
function createSetStatusContext() {
  const setStatus = mock.fn();
  const ctx = createQueuedUIContext({
    ui: { ...createQueuedUIContext().ui, setStatus },
    modelRegistry: createModelRegistryStub({ models: [fakeModel] }),
  });
  return { ctx, setStatus };
}

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

test('buildJudgePrompt includes command, cwd, configs, paths, and allow lists', () => {
  const input: JudgePromptInput = {
    command: 'cat <<EOF\nhello\nEOF',
    cwd: '/fake/cwd',
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    globalConfig: { bashAllow: ['ls *'], externalAllow: [] },
    projectConfig: { bashAllow: [], externalAllow: ['/tmp/*'] },
    sessionBashAllow: ['cat *'],
    sessionExternalAllow: ['/var/tmp/*'],
  };
  const prompt = buildJudgePrompt(input);

  ok(prompt.includes('cat <<EOF\nhello\nEOF'));
  ok(prompt.includes('/fake/cwd'));
  ok(prompt.includes('## Global pi-gate config (/fake/global.json)'));
  ok(prompt.includes('"bashAllow": [\n    "ls *"\n  ]'));
  ok(prompt.includes('## Project pi-gate config (/fake/project.json)'));
  ok(prompt.includes('"/tmp/*"'));
  ok(prompt.includes('- cat *'));
  ok(prompt.includes('- /var/tmp/*'));
  ok(prompt.includes('VERDICT: YES or NO'));
  ok(prompt.includes('## Required response format'));
});

test('buildJudgePrompt prints (none) for empty session allow lists', () => {
  const input: JudgePromptInput = {
    command: 'cmd',
    cwd: '/fake/cwd',
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    globalConfig: {},
    projectConfig: {},
    sessionBashAllow: [],
    sessionExternalAllow: [],
  };
  const prompt = buildJudgePrompt(input);
  strictEqual((prompt.match(/- \(none\)/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

test('parseVerdict accepts plain, compact, lowercase, indented, and trailing-period forms', () => {
  strictEqual(parseVerdict('VERDICT: YES'), 'YES');
  strictEqual(parseVerdict('VERDICT:NO'), 'NO');
  strictEqual(parseVerdict('verdict: yes'), 'YES');
  strictEqual(parseVerdict('  VERDICT  :  NO  '), 'NO');
  strictEqual(parseVerdict('VERDICT: YES.'), 'YES');
  strictEqual(parseVerdict('preamble\nVERDICT: NO\nSUMMARY: x'), 'NO');
});

test('parseVerdict rejects format-spec echoes, verdict mentions, and empty text', () => {
  strictEqual(parseVerdict('VERDICT: YES or NO'), null);
  strictEqual(parseVerdict('the verdict is unclear'), null);
  strictEqual(parseVerdict('VERDICT: MAYBE'), null);
  strictEqual(parseVerdict(''), null);
});

// ---------------------------------------------------------------------------
// parseJudgeDetails
// ---------------------------------------------------------------------------

test('parseJudgeDetails extracts all fields case-insensitively in any order', () => {
  const details = parseJudgeDetails(
    'verdict: yes\nReason: because it is safe\nsome prose\nsummary: does a thing\naffected paths: /a, /b',
  );
  deepStrictEqual(details, {
    summary: 'does a thing',
    affectedPaths: '/a, /b',
    reason: 'because it is safe',
  });
});

test('parseJudgeDetails: first occurrence wins and missing fields become empty strings', () => {
  const details = parseJudgeDetails('SUMMARY: first\nSUMMARY: second\nREASON: only reason');
  deepStrictEqual(details, { summary: 'first', affectedPaths: '', reason: 'only reason' });
});

test('parseJudgeDetails: values do not span lines', () => {
  const details = parseJudgeDetails('SUMMARY: wrapped\nonto another line');
  strictEqual(details.summary, 'wrapped');
});

// ---------------------------------------------------------------------------
// parseModelRef
// ---------------------------------------------------------------------------

test('parseModelRef splits on the first slash', () => {
  deepStrictEqual(parseModelRef('openrouter/anthropic/claude-sonnet'), {
    provider: 'openrouter',
    id: 'anthropic/claude-sonnet',
  });
  deepStrictEqual(parseModelRef('p/m'), { provider: 'p', id: 'm' });
});

test('parseModelRef rejects malformed refs', () => {
  strictEqual(parseModelRef('foo'), null);
  strictEqual(parseModelRef('/id'), null);
  strictEqual(parseModelRef('provider/'), null);
  strictEqual(parseModelRef(''), null);
});

// ---------------------------------------------------------------------------
// judgeBashCommand
// ---------------------------------------------------------------------------

test('judgeBashCommand YES → allow with details', async () => {
  resetSessionState();
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cat <<EOF\nx\nEOF', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => createAssistantMessage(JUDGE_RESPONSE),
  });

  strictEqual(result.decision, 'allow');
  strictEqual(result.outcome, 'allowed');
  deepStrictEqual(result.details, {
    summary: 'Lists the project directory.',
    affectedPaths: '/fake/cwd',
    reason: 'Benign read-only listing confined to the project.',
  });
});

test('judgeBashCommand NO → deny', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () =>
      createAssistantMessage('VERDICT: NO\nSUMMARY: deletes data\nAFFECTED PATHS: /\nREASON: destructive'),
  });

  strictEqual(result.decision, 'deny');
  strictEqual(result.outcome, 'denied');
  strictEqual(result.details?.summary, 'deletes data');
});

test('judgeBashCommand shows and clears the verifying status', async () => {
  const { ctx, setStatus } = createSetStatusContext();
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => createAssistantMessage('VERDICT: YES'),
  });

  deepStrictEqual(setStatus.mock.calls[0]?.arguments, ['pi-gate', 'pi-gate: Verifying bash command...']);
  deepStrictEqual(setStatus.mock.calls[1]?.arguments, ['pi-gate', undefined]);
});

test('judgeBashCommand forwards the session id and abort signal to the completer', async () => {
  const ctx = createJudgeContext({
    sessionManager: createSessionManagerStub({ getSessionId: mock.fn(() => 'sess-1') }),
  });
  let seenOptions: ModelsApiStreamOptions<any> | undefined;
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async (_model, _context, options) => {
      seenOptions = options;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  strictEqual(seenOptions?.sessionId, 'sess-1');
  ok(seenOptions?.signal instanceof AbortSignal);
});

test('judgeBashCommand sends x-opencode-session headers for opencode providers', async () => {
  const opencodeModel = {
    provider: 'opencode-go',
    id: 'm',
    baseUrl: 'https://opencode.ai/api',
  } as unknown as Model<any>;
  const ctx = createJudgeContext({
    modelRegistry: createModelRegistryStub({ models: [opencodeModel] }),
    sessionManager: createSessionManagerStub({ getSessionId: mock.fn(() => 'sess-1') }),
  });
  let seenOptions: ModelsApiStreamOptions<any> | undefined;
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('opencode-go/m'), ctx, {
    complete: async (_model, _context, options) => {
      seenOptions = options;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  deepStrictEqual(seenOptions?.headers, { 'x-opencode-session': 'sess-1', 'x-opencode-client': 'pi' });
});

test('judgeBashCommand omits attribution headers for non-opencode providers', async () => {
  const otherModel = {
    provider: 'p',
    id: 'm',
    baseUrl: 'https://api.example.com/v1',
  } as unknown as Model<any>;
  const ctx = createJudgeContext({
    modelRegistry: createModelRegistryStub({ models: [otherModel] }),
    sessionManager: createSessionManagerStub({ getSessionId: mock.fn(() => 'sess-1') }),
  });
  let seenOptions: ModelsApiStreamOptions<any> | undefined;
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async (_model, _context, options) => {
      seenOptions = options;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  strictEqual(seenOptions?.headers, undefined);
});

test('judgeBashCommand matches opencode attribution by baseUrl host, not only provider id', async () => {
  const hostedModel = {
    provider: 'custom-opencode',
    id: 'm',
    baseUrl: 'https://opencode.ai/zen',
  } as unknown as Model<any>;
  const ctx = createJudgeContext({
    modelRegistry: createModelRegistryStub({ models: [hostedModel] }),
    sessionManager: createSessionManagerStub({ getSessionId: mock.fn(() => 'sess-1') }),
  });
  let seenOptions: ModelsApiStreamOptions<any> | undefined;
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('custom-opencode/m'), ctx, {
    complete: async (_model, _context, options) => {
      seenOptions = options;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  deepStrictEqual(seenOptions?.headers, { 'x-opencode-session': 'sess-1', 'x-opencode-client': 'pi' });
});

test('judgeBashCommand stopReason error → escalate/error', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => createAssistantMessage('VERDICT: YES', 'error'),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  strictEqual(result.error, 'stopReason: error');
});

test('judgeBashCommand stopReason error surfaces provider errorMessage', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () =>
      createAssistantMessage('', 'error', {
        errorMessage: '401 Unauthorized: invalid API key',
        rawStopReason: 'authentication_error',
      }),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  strictEqual(
    result.error,
    'stopReason: error — rawStopReason: authentication_error — 401 Unauthorized: invalid API key',
  );
});

test('judgeBashCommand aborted on judge deadline reports timeout', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    timeoutMs: 1,
    complete: (_model, _context, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () =>
          resolve(createAssistantMessage('', 'aborted', { errorMessage: 'Request was aborted' })),
        );
      }),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  strictEqual(result.error, 'stopReason: aborted — judge timed out after 1ms — Request was aborted');
});

test('judgeBashCommand thrown error → escalate/error', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => {
      throw new Error('boom');
    },
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  strictEqual(result.error, 'boom');
});

test('judgeBashCommand no verdict → escalate/no-verdict', async () => {
  const ctx = createJudgeContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => createAssistantMessage('I cannot decide.'),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'no-verdict');
});

test('judgeBashCommand missing model → escalate/unavailable with notify naming ref and path', async () => {
  const ctx = createQueuedUIContext(); // default stub: find → undefined
  let completeCalled = false;
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => {
      completeCalled = true;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'unavailable');
  strictEqual(completeCalled, false);
  strictEqual(ctx._notifications.length, 1);
  ok(ctx._notifications[0]!.message.includes('"p/m"'));
  ok(ctx._notifications[0]!.message.includes('/fake/global.json'));
  strictEqual(ctx._notifications[0]!.level, 'warning');
});

test('judgeBashCommand unauthed model → escalate/unavailable', async () => {
  const registry = createModelRegistryStub({ models: [fakeModel] });
  mock.method(registry, 'hasConfiguredAuth', () => false);
  const ctx = createQueuedUIContext({ modelRegistry: registry });
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async () => createAssistantMessage('VERDICT: YES'),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'unavailable');
  strictEqual(ctx._notifications.length, 1);
});

test('judgeBashCommand malformed ref → escalate/unavailable and complete never called', async () => {
  const ctx = createJudgeContext();
  let completeCalled = false;
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('foo'), ctx, {
    complete: async () => {
      completeCalled = true;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'unavailable');
  strictEqual(completeCalled, false);
  ok(ctx._notifications[0]!.message.includes('"foo"'));
});

test('judgeBashCommand no model configured → escalate/no-judge without notify', async () => {
  const ctx = createJudgeContext();
  let completeCalled = false;
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig(undefined), ctx, {
    complete: async () => {
      completeCalled = true;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'no-judge');
  strictEqual(completeCalled, false);
  strictEqual(ctx._notifications.length, 0);
});

test('judgeBashCommand timeout → escalate/error and status cleared', async () => {
  const { ctx, setStatus } = createSetStatusContext();
  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    timeoutMs: 1,
    // Never resolves on its own, but rejects when the deadline aborts the
    // signal — mirroring how the real modelRegistry.complete behaves.
    complete: (_model, _context, options) =>
      new Promise<AssistantMessage>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  deepStrictEqual(setStatus.mock.calls.at(-1)?.arguments, ['pi-gate', undefined]);

  // No dangling timer: the deadline is cleared in `finally`, so a pending
  // setTimeout would otherwise keep the process alive past the test run.
  await new Promise((resolve) => setImmediate(resolve));
});

test('judgeBashCommand external abort → escalate/error and status cleared', async () => {
  const { ctx, setStatus } = createSetStatusContext();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const completePromise = new Promise<AssistantMessage>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  setTimeout(() => controller.abort(), 5);

  const result = await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: () => completePromise,
  });

  strictEqual(result.decision, 'escalate');
  strictEqual(result.outcome, 'error');
  deepStrictEqual(setStatus.mock.calls.at(-1)?.arguments, ['pi-gate', undefined]);
});

test('judgeBashCommand prompt embeds session allow lists', async () => {
  resetSessionState();
  approveBashPattern('cat *');
  approveExternalPattern('/var/tmp/*');
  const ctx = createJudgeContext();
  let capturedContext: Context | undefined;
  await judgeBashCommand('cmd', '/fake/cwd', createJudgeConfig('p/m'), ctx, {
    complete: async (_model, context) => {
      capturedContext = context;
      return createAssistantMessage('VERDICT: YES');
    },
  });

  const content = (capturedContext!.messages[0] as { content: string }).content;
  ok(content.includes('- cat *'));
  ok(content.includes('- /var/tmp/*'));
  strictEqual(capturedContext!.systemPrompt, JUDGE_SYSTEM_PROMPT);
  resetSessionState();
});
