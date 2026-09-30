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
  onProgress?: (run: SubagentRun) => void;
  spawnFn?: SpawnFn;
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

/**
 * Relay one `extension_ui_request` from the child to the primary session's
 * UI and write the matching `extension_ui_response` back to the child.
 *
 * Dialog methods (`confirm`/`select`/`input`/`editor`) block the child until
 * answered; fire-and-forget methods are forwarded (`notify`) or ignored.
 * Without a relay-capable UI, dialogs are cancelled immediately so children
 * never hang.
 */
async function relayDialog(
  record: Record<string, unknown>,
  ui: UiRelay,
  hasRelayUI: boolean,
  writeRecord: (record: Record<string, unknown>) => void,
): Promise<void> {
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const respond = (fields: Record<string, unknown>) => writeRecord({ type: 'extension_ui_response', id, ...fields });

  const isDialog = method === 'confirm' || method === 'select' || method === 'input' || method === 'editor';
  if (!hasRelayUI || !ui) {
    if (isDialog) respond({ cancelled: true });
    return;
  }

  try {
    switch (method) {
      case 'confirm': {
        const confirmed = await ui.confirm(String(record.title ?? ''), String(record.message ?? ''));
        respond({ confirmed });
        break;
      }
      case 'select': {
        const options = Array.isArray(record.options) ? record.options.map(String) : [];
        const value = await ui.select(String(record.title ?? ''), options);
        if (value === undefined) respond({ cancelled: true });
        else respond({ value });
        break;
      }
      case 'input': {
        const value = await ui.input(
          String(record.title ?? ''),
          record.placeholder === undefined ? undefined : String(record.placeholder),
        );
        if (value === undefined) respond({ cancelled: true });
        else respond({ value });
        break;
      }
      case 'editor': {
        const value = await ui.editor(
          String(record.title ?? ''),
          record.prefill === undefined ? undefined : String(record.prefill),
        );
        if (value === undefined) respond({ cancelled: true });
        else respond({ value });
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
    if (isDialog) respond({ cancelled: true });
  }
}

/** Spawn the child, send the prompt, and pump events until the run resolves. */
function driveChild(proc: ChildProcess, run: SubagentRun, opts: RunSubagentOptions): Promise<void> {
  return new Promise((resolve) => {
    const PROMPT_ID = 'prompt-1';
    const progress = createProgressState();
    let buffer = '';
    let stderr = '';
    let settled = false;
    let finished = false;
    let abortTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (abortTimer) clearTimeout(abortTimer);
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
        // Orderly RPC shutdown: closing stdin asks the idle child to exit.
        try {
          proc.stdin?.end();
        } catch {
          /* already closed */
        }
        finish();
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

      if (record.type === 'extension_ui_request') {
        // Dialog handling is async; the read loop must not block on it.
        void relayDialog(record, opts.ui, opts.hasRelayUI, writeRecord);
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

  const args: string[] = ['--mode', 'rpc', '--no-session', '--name', agent.name];
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
