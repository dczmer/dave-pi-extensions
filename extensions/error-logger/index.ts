import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { buildEntry, writeEntry, countEntries, getDefaultLogPath, detectCategory, extractBashInfo } from './logger.ts';

interface BlockEvent {
  toolCallId: string;
  tool: string;
  extension: string;
  reason: string;
}

/**
 * Register the error-logger extension.
 *
 * Listens to `tool_execution_start` to stash tool arguments, `tool_execution_end`
 * to log execution failures, and the shared event bus `harness:block` channel to
 * log blocked tools. Deduplicates blocked tools so they are never double-logged.
 *
 * Appends structured JSONL records to `--error-log-path` (default:
 * `~/.pi/agent/harness-errors.jsonl`).
 *
 * @param pi - Extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  const stashedArgs = new Map<string, unknown>();
  const loggedIds = new Set<string>();
  let writeFailedNotified = false;

  pi.registerFlag('error-log-path', {
    description: 'Path to the harness error log JSONL file',
    type: 'string',
    default: getDefaultLogPath(),
  });

  pi.registerCommand('error-log', {
    description: 'Show error log stats and path',
    handler: async (_args, ctx: ExtensionContext) => {
      const logPath = String(pi.getFlag('error-log-path') ?? getDefaultLogPath());
      const count = countEntries(logPath);
      ctx.ui.notify(`Error log: ${count} entries at ${logPath}`, 'info');
    },
  });

  pi.on('tool_execution_start', async (event) => {
    stashedArgs.set(event.toolCallId, event.args);
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    if (!event.isError) return;
    if (loggedIds.has(event.toolCallId)) return;

    const logPath = String(pi.getFlag('error-log-path') ?? getDefaultLogPath());
    const input = stashedArgs.get(event.toolCallId);
    const session = ctx.sessionManager.getSessionFile() ?? undefined;
    const reason = typeof event.result === 'string' ? event.result : undefined;
    const category = detectCategory(reason);
    const bashInfo = extractBashInfo(event.result, event.toolName);

    const entry = buildEntry(
      new Date().toISOString(),
      session,
      event.toolName,
      event.toolCallId,
      input,
      category,
      'execution',
      reason,
      bashInfo.exitCode,
      bashInfo.outputPreview,
    );

    const ok = writeEntry(logPath, entry);
    if (!ok && !writeFailedNotified) {
      writeFailedNotified = true;
      ctx.ui.notify('Error logger failed to write to log file', 'warning');
    }

    loggedIds.add(event.toolCallId);
    stashedArgs.delete(event.toolCallId);
  });

  const unsubscribe = pi.events.on('harness:block', (data: unknown) => {
    const block = data as BlockEvent;
    if (!block.toolCallId) return;
    if (loggedIds.has(block.toolCallId)) return;

    const logPath = String(pi.getFlag('error-log-path') ?? getDefaultLogPath());
    // ExtensionContext is not available for event-bus callbacks.
    // Session file and tool name are best-effort via stashed state.
    const input = stashedArgs.get(block.toolCallId);
    const entry = buildEntry(
      new Date().toISOString(),
      undefined,
      block.tool,
      block.toolCallId,
      input,
      'blocked',
      block.extension,
      block.reason,
    );

    writeEntry(logPath, entry);
    loggedIds.add(block.toolCallId);
  });

  pi.on('session_shutdown', async () => {
    unsubscribe();
  });
}
