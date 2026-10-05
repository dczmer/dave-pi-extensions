/**
 * Spawns and drives one headless `pi --mode rpc` child process.
 *
 * The parent extension is the RPC client of the child: prompts are sent as
 * commands on stdin, session events stream back on stdout, and any child-side
 * dialog (`ctx.ui.confirm/select/input/editor` from a loaded extension) is
 * relayed to the primary session's TUI via the `extension_ui_request` /
 * `extension_ui_response` subprotocol.
 *
 * JSONL framing follows pi's `docs/json.md`: split stdout on LF only (never
 * `readline`), strip an optional trailing CR, and keep draining stdout so the
 * child never stalls on pipe backpressure.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '@earendil-works/pi-ai';
import { withFileMutationQueue, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { createProgressState, statusLineFromEvent, truncateStatus } from './progress.ts';

/** Injectable process factory so tests never spawn real processes. */
export interface SpawnFn {
  (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
}

/** Usage accumulator, ported from the official subagent example. */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** One live subagent run. */
export interface SubagentRun {
  agent: string;
  task: string;
  /** Live progress line, at most 80 display columns. */
  statusLine: string;
  messages: Message[];
  usage: UsageStats;
  /** `null` while the child is still running. */
  exitCode: number | null;
  stopReason?: string;
  errorMessage?: string;
  /** Absolute path of the child's persisted session file, when session persistence is enabled. */
  sessionFile?: string;
}

/** Options for {@link runSubagent}. */
export interface RunSubagentOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  /** Inherits the parent model when `agent.model` is unset. */
  model?: string | undefined;
  /** Passed as `--thinking` only when the model is inherited. */
  thinkingLevel?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Relay target for child dialogs; omitted → dialogs auto-cancel. */
  ui?: Pick<ExtensionContext['ui'], 'confirm' | 'select' | 'input' | 'editor' | 'notify'> | undefined;
  /** When false, child dialogs are answered with an immediate cancellation. */
  hasRelayUI: boolean;
  /**
   * Maximum time a relayed dialog may wait for the parent UI before the child
   * receives an automatic cancellation. Guards against the TUI silently
   * dropping a dialog (whose promise then never settles), which would
   * otherwise hang the child forever. Defaults to
   * {@link DEFAULT_DIALOG_TIMEOUT_MS}.
   */
  dialogTimeoutMs?: number | undefined;
  onProgress?: (run: SubagentRun) => void;
  spawnFn?: SpawnFn;
  /**
   * When set, the child runs with `--session-dir <sessionDir>` instead of
   * `--no-session`, persisting its session for post-hoc inspection
   * (`pi --resume <sessionFile>`). After `agent_settled` the runner asks
   * the child for its session file path via `get_session_stats`.
   */
  sessionDir?: string | undefined;
  /**
   * Maximum time to wait for the `get_session_stats` response after
   * `agent_settled` before shutting the child down without a session
   * path. Defaults to {@link DEFAULT_STATS_TIMEOUT_MS}.
   */
  statsTimeoutMs?: number | undefined;
}

/** Create a zeroed usage accumulator. */
export function zeroUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** A run failed if it carries an error message, a non-zero exit code, or an error/abort stop reason. */
export function isFailedRun(run: SubagentRun): boolean {
  return (
    run.errorMessage !== undefined ||
    (run.exitCode !== null && run.exitCode !== 0) ||
    run.stopReason === 'error' ||
    run.stopReason === 'aborted'
  );
}

/** Extract the last assistant text from a message list. */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
    }
  }
  return '';
}

/**
 * Resolve how to spawn a `pi` child, ported from the official example:
 * re-exec the current script when there is one, spawn a branded binary
 * directly, otherwise fall back to `pi` on PATH.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
}

const defaultSpawn: SpawnFn = (command, args, opts) =>
  spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

type UiRelay = RunSubagentOptions['ui'];

/** Default ceiling for {@link RunSubagentOptions.dialogTimeoutMs}: 10 minutes. */
const DEFAULT_DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/** Default ceiling for {@link RunSubagentOptions.statsTimeoutMs}: 2 seconds. */
const DEFAULT_STATS_TIMEOUT_MS = 2000;

/**
 * Process-wide mutex serializing dialog relays to the parent TUI, shared
 * across all module copies via globalThis (pi loads each extension with a
 * separate jiti instance, so module-level state would NOT be shared).
 */
const RELAY_MUTEX_KEY = Symbol.for('pi-subagent:relay-mutex');

interface RelayMutex {
  tail: Promise<unknown>;
}

function getRelayMutex(): RelayMutex {
  const g = globalThis as Record<symbol, RelayMutex | undefined>;
  return (g[RELAY_MUTEX_KEY] ??= { tail: Promise.resolve() });
}

/**
 * Run `fn` once every previously queued dialog relay has settled, and queue
 * subsequent relays behind it. The parent TUI can only show one extension
 * dialog at a time — a second concurrent dialog overwrites the first and
 * orphans its promise — so relays from parallel children must be serialized
 * rather than raced.
 *
 * @param fn - The dialog relay to run once the lock is acquired.
 * @returns The result of `fn`.
 */
async function withRelayLock<T>(fn: () => Promise<T>): Promise<T> {
  const mutex = getRelayMutex();
  const result = mutex.tail.then(fn, fn);
  mutex.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Resolve with the dialog result, or `undefined` when the parent UI promise
 * does not settle within `timeoutMs`. The TUI can silently drop extension
 * dialogs (e.g. when another dialog replaces them), leaving their promise
 * pending forever; the timeout guarantees the child always receives a
 * response instead of hanging.
 *
 * @param promise - The parent UI dialog promise to bound.
 * @param timeoutMs - Maximum wait before resolving `undefined`.
 * @returns The settled value, or `undefined` on timeout/rejection.
 */
function withDialogTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Relay one `extension_ui_request` from the child to the primary session's
 * UI and write the matching `extension_ui_response` back to the child.
 *
 * Dialog methods (`confirm`/`select`/`input`/`editor`) block the child until
 * answered; fire-and-forget methods are forwarded (`notify`) or ignored.
 * Without a relay-capable UI, dialogs are cancelled immediately so children
 * never hang. Dialogs are serialized process-wide (the parent TUI shows one
 * dialog at a time) and bounded by `dialogTimeoutMs`, so every child always
 * receives exactly one response — a lost or displaced dialog yields an
 * automatic cancellation instead of a hung child.
 */
async function relayDialog(
  record: Record<string, unknown>,
  ui: UiRelay,
  hasRelayUI: boolean,
  writeRecord: (record: Record<string, unknown>) => void,
  dialogTimeoutMs: number,
): Promise<void> {
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const respond = (fields: Record<string, unknown>) => writeRecord({ type: 'extension_ui_response', id, ...fields });

  const isDialog = method === 'confirm' || method === 'select' || method === 'input' || method === 'editor';
  if (!hasRelayUI || !ui) {
    if (isDialog) respond({ cancelled: true });
    return;
  }

  let responded = false;
  const respondOnce = (fields: Record<string, unknown>) => {
    if (responded) return;
    responded = true;
    respond(fields);
  };

  try {
    switch (method) {
      case 'confirm': {
        const confirmed = await withRelayLock(() =>
          withDialogTimeout(ui.confirm!(String(record.title ?? ''), String(record.message ?? '')), dialogTimeoutMs),
        );
        if (confirmed === undefined) respondOnce({ cancelled: true });
        else respondOnce({ confirmed });
        break;
      }
      case 'select': {
        const options = Array.isArray(record.options) ? record.options.map(String) : [];
        const value = await withRelayLock(() =>
          withDialogTimeout(ui.select!(String(record.title ?? ''), options), dialogTimeoutMs),
        );
        if (value === undefined) respondOnce({ cancelled: true });
        else respondOnce({ value });
        break;
      }
      case 'input': {
        const value = await withRelayLock(() =>
          withDialogTimeout(
            ui.input!(
              String(record.title ?? ''),
              record.placeholder === undefined ? undefined : String(record.placeholder),
            ),
            dialogTimeoutMs,
          ),
        );
        if (value === undefined) respondOnce({ cancelled: true });
        else respondOnce({ value });
        break;
      }
      case 'editor': {
        const value = await withRelayLock(() =>
          withDialogTimeout(
            ui.editor!(String(record.title ?? ''), record.prefill === undefined ? undefined : String(record.prefill)),
            dialogTimeoutMs,
          ),
        );
        if (value === undefined) respondOnce({ cancelled: true });
        else respondOnce({ value });
        break;
      }
      case 'notify': {
        const notifyType =
          record.notifyType === 'warning' || record.notifyType === 'error' ? record.notifyType : 'info';
        ui.notify?.(String(record.message ?? ''), notifyType);
        break;
      }
      default:
        // Other fire-and-forget methods (setStatus, setWidget, setTitle, ...)
        // are ignored: the child has no terminal of its own.
        break;
    }
  } catch {
    // A relay failure must never wedge the child waiting on a response.
    if (isDialog) respondOnce({ cancelled: true });
  }
}

/** Spawn the child, send the prompt, and pump events until the run resolves. */
function driveChild(proc: ChildProcess, run: SubagentRun, opts: RunSubagentOptions): Promise<void> {
  return new Promise((resolve) => {
    const PROMPT_ID = 'prompt-1';
    const STATS_ID = 'stats-1';
    const progress = createProgressState();
    let buffer = '';
    let stderr = '';
    let settled = false;
    let finished = false;
    let abortTimer: NodeJS.Timeout | undefined;
    let statsTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (abortTimer) clearTimeout(abortTimer);
      if (statsTimer) clearTimeout(statsTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const writeRecord = (record: Record<string, unknown>) => {
      try {
        proc.stdin?.write(`${JSON.stringify(record)}\n`);
      } catch {
        // Child is gone; the close handler will resolve the run.
      }
    };

    const killProc = () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      abortTimer = setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 5000);
      abortTimer.unref?.();
    };

    const onAbort = () => {
      run.errorMessage = 'Subagent was aborted';
      writeRecord({ type: 'abort' });
      killProc();
    };

    const shutdownChild = () => {
      if (statsTimer) clearTimeout(statsTimer);
      // Orderly RPC shutdown: closing stdin asks the idle child to exit.
      try {
        proc.stdin?.end();
      } catch {
        /* already closed */
      }
      finish();
    };

    const handleEvent = (event: Record<string, unknown>) => {
      const line = statusLineFromEvent(event, progress);
      if (line !== undefined) {
        run.statusLine = truncateStatus(line);
        opts.onProgress?.(run);
      }

      if (event.type === 'message_end' && event.message) {
        const msg = event.message as Message;
        run.messages.push(msg);
        if (msg.role === 'assistant') {
          run.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            run.usage.input += usage.input || 0;
            run.usage.output += usage.output || 0;
            run.usage.cacheRead += usage.cacheRead || 0;
            run.usage.cacheWrite += usage.cacheWrite || 0;
            run.usage.cost += usage.cost?.total || 0;
            run.usage.contextTokens = usage.totalTokens || 0;
          }
          if (msg.stopReason) run.stopReason = msg.stopReason;
          if (msg.errorMessage) run.errorMessage = msg.errorMessage;
        }
      }

      if (event.type === 'tool_result_end' && event.message) {
        run.messages.push(event.message as Message);
      }

      if (event.type === 'agent_settled') {
        settled = true;
        run.exitCode = run.exitCode ?? 0;
        if (opts.sessionDir === undefined) {
          shutdownChild();
          return;
        }
        // Persisted session: ask the idle child for its session file path
        // before shutdown. Bounded by a timeout so a child that never
        // answers cannot wedge the run.
        writeRecord({ id: STATS_ID, type: 'get_session_stats' });
        statsTimer = setTimeout(shutdownChild, opts.statsTimeoutMs ?? DEFAULT_STATS_TIMEOUT_MS);
        statsTimer.unref?.();
      }
    };

    const handleLine = (raw: string) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line.trim()) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (record.type === 'response' && record.id === PROMPT_ID) {
        if (record.success === false) {
          run.errorMessage = `Prompt rejected by child: ${String(record.error ?? 'unknown error')}`;
          run.exitCode = 1;
          killProc();
          finish();
          return;
        }
        const disposition = (record.data as { disposition?: string } | undefined)?.disposition;
        if (disposition === 'handled') {
          // No run started for this prompt; waiting for agent_settled would hang.
          run.errorMessage = 'Prompt was handled without starting an agent run';
          run.exitCode = 1;
          killProc();
          finish();
        }
        return;
      }

      if (record.type === 'response' && record.id === STATS_ID) {
        const data = record.data as { sessionFile?: unknown } | undefined;
        if (record.success === true && typeof data?.sessionFile === 'string') {
          run.sessionFile = data.sessionFile;
        }
        shutdownChild();
        return;
      }

      if (record.type === 'extension_ui_request') {
        // Dialog handling is async; the read loop must not block on it.
        // Dialogs serialize process-wide inside relayDialog so parallel
        // children never race the single parent-TUI dialog slot.
        void relayDialog(
          record,
          opts.ui,
          opts.hasRelayUI,
          writeRecord,
          opts.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS,
        );
        return;
      }

      handleEvent(record);
    };

    proc.stdout?.on('data', (data: Buffer | string) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    proc.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });

    proc.on('error', (err) => {
      run.exitCode = 1;
      run.errorMessage = `Failed to spawn subagent child: ${err.message}`;
      finish();
    });

    proc.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (run.exitCode === null) run.exitCode = code ?? 1;
      if (!settled && run.errorMessage === undefined && code !== 0) {
        const detail = stderr.trim().split('\n').pop();
        run.errorMessage =
          detail ?
            `Child exited with code ${code ?? 'unknown'}: ${detail}`
          : `Child exited with code ${code ?? 'unknown'} before settling`;
      }
      finish();
    });

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    writeRecord({ id: PROMPT_ID, type: 'prompt', message: `Task: ${opts.task}` });
  });
}

/** Run one subagent task in a headless child and resolve with the completed run. */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentRun> {
  const { agent } = opts;
  const run: SubagentRun = {
    agent: agent.name,
    task: opts.task,
    statusLine: '',
    messages: [],
    usage: zeroUsage(),
    exitCode: null,
  };

  const args: string[] = [
    '--mode',
    'rpc',
    ...(opts.sessionDir ? ['--session-dir', opts.sessionDir] : ['--no-session']),
    '--name',
    agent.name,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.thinkingLevel) args.push('--thinking', opts.thinkingLevel);
  if (agent.tools && agent.tools.length > 0) args.push('--tools', agent.tools.join(','));
  args.push('--extension', fileURLToPath(new URL('./child-extension.ts', import.meta.url)));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push('--append-system-prompt', tmpPromptPath);
    }

    const spawnFn = opts.spawnFn ?? defaultSpawn;
    const invocation = getPiInvocation(args);
    const proc = spawnFn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      env: { ...process.env, PI_SUBAGENT_CHILD: '1' },
    });

    await driveChild(proc, run, opts);
    return run;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tmpPromptDir) {
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
}
