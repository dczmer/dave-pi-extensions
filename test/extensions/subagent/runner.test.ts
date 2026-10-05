import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { runSubagent, type RunSubagentOptions, type SpawnFn } from '../../../extensions/subagent/runner.ts';
import type { AgentConfig } from '../../../extensions/subagent/agents.ts';

const testAgent: AgentConfig = {
  name: 'worker',
  description: 'test agent',
  systemPrompt: '',
  source: 'bundled',
  filePath: '/fake/worker.md',
};

/** Flush pending microtasks and synchronous stream emissions. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Wait until the spawn callback has recorded a launch. Spawning is preceded
 * by an async temp-file write (mkdtemp + realpath + writeFile), which a
 * fixed flush is not always enough to cover.
 */
async function waitForSpawn(child: MockChild): Promise<void> {
  for (let i = 0; i < 100 && child.spawned.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface MockChild {
  proc: ChildProcess;
  spawnFn: SpawnFn;
  kill: ReturnType<typeof mock.fn>;
  spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  stdinRecords(): Array<Record<string, unknown>>;
  emitRecord(record: Record<string, unknown>): void;
  emitStderr(text: string): void;
  close(code: number | null): void;
}

function createMockChild(): MockChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on('data', (d) => stdinChunks.push(d.toString()));

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
  }) as unknown as ChildProcess;

  const kill = mock.fn(() => {
    (proc as unknown as { killed: boolean }).killed = true;
    return true;
  });
  (proc as unknown as { kill: unknown }).kill = kill;

  const spawned: MockChild['spawned'] = [];
  const spawnFn: SpawnFn = (command, args, opts) => {
    spawned.push({ command, args, env: opts.env });
    return proc;
  };

  return {
    proc,
    spawnFn,
    kill,
    spawned,
    stdinRecords() {
      return stdinChunks
        .join('')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    emitRecord(record) {
      stdout.write(`${JSON.stringify(record)}\n`);
    },
    emitStderr(text) {
      stderr.write(text);
    },
    close(code) {
      stdout.end();
      proc.emit('close', code);
    },
  };
}

function acceptPrompt(child: MockChild): void {
  child.emitRecord({
    type: 'response',
    id: 'prompt-1',
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  });
}

test('writes the prompt command to stdin and resolves on agent_settled', async () => {
  const child = createMockChild();
  const promise = runSubagent({
    agent: testAgent,
    task: 'do it',
    cwd: '/tmp',
    hasRelayUI: false,
    spawnFn: child.spawnFn,
  });
  await flush();

  const prompt = child.stdinRecords().find((r) => r.type === 'prompt');
  ok(prompt, 'expected a prompt command on stdin');
  strictEqual(prompt.id, 'prompt-1');
  strictEqual(prompt.message, 'Task: do it');

  // Spawn args: headless rpc mode, isolated session, companion extension, child marker env.
  const { args, env } = child.spawned[0]!;
  ok(args.includes('--mode') && args.includes('rpc'));
  ok(args.includes('--no-session'));
  ok(args.some((a) => a.endsWith('child-extension.ts')));
  strictEqual(env.PI_SUBAGENT_CHILD, '1');

  acceptPrompt(child);
  child.emitRecord({ type: 'agent_settled' });
  const run = await promise;
  strictEqual(run.exitCode, 0);
  strictEqual(run.errorMessage, undefined);
});

test('prompt response success:false fails the run without hanging', async () => {
  const child = createMockChild();
  const promise = runSubagent({ agent: testAgent, task: 'x', cwd: '/tmp', hasRelayUI: false, spawnFn: child.spawnFn });
  await flush();

  child.emitRecord({ type: 'response', id: 'prompt-1', command: 'prompt', success: false, error: 'boom' });
  const run = await promise;
  strictEqual(run.exitCode, 1);
  ok(run.errorMessage?.includes('boom'));
  ok(child.kill.mock.calls.length >= 1);
  strictEqual(child.kill.mock.calls[0]!.arguments[0], 'SIGTERM');
});

test('prompt disposition "handled" fails the run instead of waiting for agent_settled', async () => {
  const child = createMockChild();
  const promise = runSubagent({ agent: testAgent, task: 'x', cwd: '/tmp', hasRelayUI: false, spawnFn: child.spawnFn });
  await flush();

  child.emitRecord({
    type: 'response',
    id: 'prompt-1',
    command: 'prompt',
    success: true,
    data: { disposition: 'handled' },
  });
  const run = await promise;
  strictEqual(run.exitCode, 1);
  ok(run.errorMessage?.includes('handled'));
});

test('confirm dialog is relayed to the parent UI and the answer returned to the child', async () => {
  const child = createMockChild();
  const confirm = mock.fn(async () => true);
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: true,
    ui: { confirm, select: mock.fn(), input: mock.fn(), editor: mock.fn(), notify: mock.fn() },
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);

  child.emitRecord({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Allow?', message: 'rm -rf /' });
  await flush();

  strictEqual(confirm.mock.calls.length, 1);
  deepStrictEqual(confirm.mock.calls[0]!.arguments.slice(0, 2), ['Allow?', 'rm -rf /']);
  const response = child.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'u1');
  deepStrictEqual(response, { type: 'extension_ui_response', id: 'u1', confirmed: true });

  child.emitRecord({ type: 'agent_settled' });
  await promise;
});

test('input dialog answered with undefined responds with cancelled:true', async () => {
  const child = createMockChild();
  const input = mock.fn(async () => undefined);
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: true,
    ui: { confirm: mock.fn(), select: mock.fn(), input, editor: mock.fn(), notify: mock.fn() },
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);

  child.emitRecord({
    type: 'extension_ui_request',
    id: 'u2',
    method: 'input',
    title: 'Subagent asks',
    placeholder: 'q',
  });
  await flush();

  const response = child.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'u2');
  deepStrictEqual(response, { type: 'extension_ui_response', id: 'u2', cancelled: true });

  child.emitRecord({ type: 'agent_settled' });
  await promise;
});

test('dialogs from parallel children are serialized through the parent UI', async () => {
  const childA = createMockChild();
  const childB = createMockChild();
  // Deferred editor promises: the harness controls when each dialog "answers".
  const deferreds: Array<{ resolve: (value: string) => void }> = [];
  const editor = mock.fn(
    () =>
      new Promise<string>((resolve) => {
        deferreds.push({ resolve });
      }),
  );
  const ui: RunSubagentOptions['ui'] = {
    confirm: mock.fn(),
    select: mock.fn(),
    input: mock.fn(),
    editor,
    notify: mock.fn(),
  };

  const runA = runSubagent({ agent: testAgent, task: 'a', cwd: '/tmp', hasRelayUI: true, ui, spawnFn: childA.spawnFn });
  const runB = runSubagent({ agent: testAgent, task: 'b', cwd: '/tmp', hasRelayUI: true, ui, spawnFn: childB.spawnFn });
  await flush();
  acceptPrompt(childA);
  acceptPrompt(childB);

  // Both children request an editor dialog concurrently.
  childA.emitRecord({ type: 'extension_ui_request', id: 'a1', method: 'editor', title: 'A', prefill: 'a' });
  childB.emitRecord({ type: 'extension_ui_request', id: 'b1', method: 'editor', title: 'B', prefill: 'b' });
  await flush();

  // Only one dialog reaches the parent UI at a time; the second queues.
  strictEqual(editor.mock.calls.length, 1);

  // Answering the first dialog unblocks the queued second dialog.
  deferreds[0]!.resolve('answer-a');
  await flush();
  strictEqual(editor.mock.calls.length, 2);
  deepStrictEqual(editor.mock.calls[1]!.arguments, ['B', 'b']);

  // The first child's response carries its own request id.
  const responseA = childA.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'a1');
  deepStrictEqual(responseA, { type: 'extension_ui_response', id: 'a1', value: 'answer-a' });

  deferreds[1]!.resolve('answer-b');
  await flush();
  const responseB = childB.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'b1');
  deepStrictEqual(responseB, { type: 'extension_ui_response', id: 'b1', value: 'answer-b' });

  childA.emitRecord({ type: 'agent_settled' });
  childB.emitRecord({ type: 'agent_settled' });
  await runA;
  await runB;
});

test('a dialog whose parent UI never settles is auto-cancelled after the timeout', async () => {
  const child = createMockChild();
  // Simulates the TUI dropping the dialog: the promise never settles.
  const editor = mock.fn(() => new Promise<string>(() => {}));
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: true,
    dialogTimeoutMs: 40,
    ui: { confirm: mock.fn(), select: mock.fn(), input: mock.fn(), editor, notify: mock.fn() },
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);

  child.emitRecord({ type: 'extension_ui_request', id: 'u4', method: 'editor', title: 't', prefill: 'p' });
  await new Promise((r) => setTimeout(r, 150));

  const response = child.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'u4');
  deepStrictEqual(response, { type: 'extension_ui_response', id: 'u4', cancelled: true });

  child.emitRecord({ type: 'agent_settled' });
  await promise;
});

test('dialogs auto-cancel when the parent has no relay UI', async () => {
  const child = createMockChild();
  const confirm = mock.fn(async () => true);
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    ui: { confirm, select: mock.fn(), input: mock.fn(), editor: mock.fn(), notify: mock.fn() },
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);

  child.emitRecord({ type: 'extension_ui_request', id: 'u3', method: 'confirm', title: 't', message: 'm' });
  await flush();

  strictEqual(confirm.mock.calls.length, 0);
  const response = child.stdinRecords().find((r) => r.type === 'extension_ui_response' && r.id === 'u3');
  deepStrictEqual(response, { type: 'extension_ui_response', id: 'u3', cancelled: true });

  child.emitRecord({ type: 'agent_settled' });
  await promise;
});

test('accumulates usage from assistant message_end events and tracks progress lines', async () => {
  const child = createMockChild();
  const progressLines: string[] = [];
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    spawnFn: child.spawnFn,
    onProgress: (r) => progressLines.push(r.statusLine),
  });
  await flush();
  acceptPrompt(child);

  child.emitRecord({
    type: 'tool_execution_start',
    toolCallId: 'c1',
    toolName: 'bash',
    args: { command: 'npm test' },
  });
  child.emitRecord({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 3,
        totalTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
    },
  });
  child.emitRecord({ type: 'agent_settled' });
  const run = await promise;

  strictEqual(run.usage.turns, 1);
  strictEqual(run.usage.input, 100);
  strictEqual(run.usage.output, 20);
  strictEqual(run.usage.cacheRead, 5);
  strictEqual(run.usage.cost, 0.001);
  strictEqual(run.usage.contextTokens, 128);
  strictEqual(run.stopReason, 'stop');
  strictEqual(run.messages.length, 1);
  ok(progressLines.some((l) => l.includes('bash')));
});

test('abort sends the abort command then SIGTERMs the child', async () => {
  const child = createMockChild();
  const controller = new AbortController();
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    signal: controller.signal,
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);

  controller.abort();
  await flush();

  ok(
    child.stdinRecords().some((r) => r.type === 'abort'),
    'expected an abort command on stdin',
  );
  strictEqual(child.kill.mock.calls[0]!.arguments[0], 'SIGTERM');

  child.close(null);
  const run = await promise;
  strictEqual(run.errorMessage, 'Subagent was aborted');
  strictEqual(run.exitCode, 1);
});

test('process close without agent_settled resolves the run; non-zero exit is an error', async () => {
  const child = createMockChild();
  const promise = runSubagent({ agent: testAgent, task: 'x', cwd: '/tmp', hasRelayUI: false, spawnFn: child.spawnFn });
  await flush();
  acceptPrompt(child);

  child.emitStderr('panic: something broke');
  child.close(2);
  const run = await promise;
  strictEqual(run.exitCode, 2);
  ok(run.errorMessage?.includes('2'));
  ok(run.errorMessage?.includes('panic'));
});

test('sessionDir switches the child to --session-dir and captures the session file via RPC', async () => {
  const child = createMockChild();
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    sessionDir: '/tmp/runs/run-1',
    spawnFn: child.spawnFn,
  });
  await flush();

  const { args } = child.spawned[0]!;
  ok(args.includes('--session-dir'));
  strictEqual(args[args.indexOf('--session-dir') + 1], '/tmp/runs/run-1');
  ok(!args.includes('--no-session'));

  acceptPrompt(child);
  child.emitRecord({ type: 'agent_settled' });
  await flush();

  // After settle the child is asked for its session stats before shutdown.
  const stats = child.stdinRecords().find((r) => r.type === 'get_session_stats');
  ok(stats, 'expected a get_session_stats command on stdin');
  strictEqual(stats.id, 'stats-1');

  child.emitRecord({
    type: 'response',
    id: 'stats-1',
    command: 'get_session_stats',
    success: true,
    data: { sessionFile: '/tmp/runs/run-1/group/session.jsonl' },
  });
  const run = await promise;
  strictEqual(run.sessionFile, '/tmp/runs/run-1/group/session.jsonl');
  strictEqual(run.exitCode, 0);
});

test('stats timeout: run finishes without a session path when the child never answers', async () => {
  const child = createMockChild();
  const promise = runSubagent({
    agent: testAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    sessionDir: '/tmp/runs/run-2',
    statsTimeoutMs: 40,
    spawnFn: child.spawnFn,
  });
  await flush();
  acceptPrompt(child);
  child.emitRecord({ type: 'agent_settled' });

  const run = await promise;
  strictEqual(run.exitCode, 0);
  strictEqual(run.sessionFile, undefined);
  ok(child.stdinRecords().some((r) => r.type === 'get_session_stats'));
});

test('sessionDir unset keeps --no-session and skips the stats roundtrip', async () => {
  const child = createMockChild();
  const promise = runSubagent({ agent: testAgent, task: 'x', cwd: '/tmp', hasRelayUI: false, spawnFn: child.spawnFn });
  await flush();
  acceptPrompt(child);
  child.emitRecord({ type: 'agent_settled' });
  const run = await promise;
  ok(child.spawned[0]!.args.includes('--no-session'));
  ok(!child.stdinRecords().some((r) => r.type === 'get_session_stats'));
  strictEqual(run.sessionFile, undefined);
});

test('temporary system-prompt file is removed after the run', async () => {
  const promptAgent: AgentConfig = { ...testAgent, systemPrompt: 'You are a test agent.' };
  const before = readdirSync(tmpdir()).filter((d) => d.startsWith('pi-subagent-'));

  const child = createMockChild();
  const promise = runSubagent({
    agent: promptAgent,
    task: 'x',
    cwd: '/tmp',
    hasRelayUI: false,
    spawnFn: child.spawnFn,
  });
  await flush();
  await waitForSpawn(child);

  // The prompt file path must have been passed to the child.
  const { args } = child.spawned[0]!;
  const flagIndex = args.indexOf('--append-system-prompt');
  ok(flagIndex >= 0, 'expected --append-system-prompt for an agent with a system prompt');
  ok(args[flagIndex + 1]!.startsWith(`${tmpdir()}/pi-subagent-`));

  acceptPrompt(child);
  child.emitRecord({ type: 'agent_settled' });
  await promise;

  const after = readdirSync(tmpdir()).filter((d) => d.startsWith('pi-subagent-'));
  deepStrictEqual(
    after.filter((d) => !before.includes(d)),
    [],
  );
});
