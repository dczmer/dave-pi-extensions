import type { AssistantMessage, Context, Model, ModelsApiStreamOptions } from '@earendil-works/pi-ai';
import type { ConfigResult } from './config.ts';
import { getSessionState } from './session.ts';
import type { ExtensionContext } from './prompts.ts';

/**
 * System prompt for the unparsable-command judge. Fixed and deterministic so
 * every verdict request is identical in shape.
 */
export const JUDGE_SYSTEM_PROMPT = `You are the bash-command safety judge for the pi-gate tool-access extension.
Decide whether the supplied bash command should be allowed to run on the user's
machine.

Be conservative: deny commands that could destroy or corrupt data, exfiltrate
secrets, alter system state outside the project, escalate privileges, or are
otherwise destructive or unrelated to the stated project. Allow commands that
are clearly benign and confined to the project directory.

Respond using exactly this format, with one field per line and no extra prose
before VERDICT:

VERDICT: YES or NO
SUMMARY: one or two sentences describing what the command does
AFFECTED PATHS: comma-separated files/directories read or written, or "none"
REASON: one or two sentences justifying the verdict`;

/** Fixed response format echoed into the user prompt (must match the system prompt). */
const RESPONSE_FORMAT = `VERDICT: YES or NO
SUMMARY: one or two sentences describing what the command does
AFFECTED PATHS: comma-separated files/directories read or written, or "none"
REASON: one or two sentences justifying the verdict`;

/** Inputs for {@link buildJudgePrompt}; all sections are rendered verbatim. */
export interface JudgePromptInput {
  command: string;
  cwd: string;
  globalPath: string;
  projectPath: string;
  globalConfig: unknown;
  projectConfig: unknown;
  sessionBashAllow: string[];
  sessionExternalAllow: string[];
}

/**
 * Build the deterministic judge prompt: the raw command, the working
 * directory, both pi-gate config files (pretty-printed JSON), and the
 * in-memory session allow lists.
 */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const patterns = (list: string[]) => (list.length > 0 ? list.map((p) => `- ${p}`).join('\n') : '- (none)');

  return `## Command under review

${input.command}

## Working directory

${input.cwd}

## Global pi-gate config (${input.globalPath})

${JSON.stringify(input.globalConfig, null, 2)}

## Project pi-gate config (${input.projectPath})

${JSON.stringify(input.projectConfig, null, 2)}

## Session-approved bash patterns

${patterns(input.sessionBashAllow)}

## Session-approved external path patterns

${patterns(input.sessionExternalAllow)}

## Required response format

${RESPONSE_FORMAT}`;
}

/** Judge verdict values. */
export type Verdict = 'YES' | 'NO';

/**
 * Parse the verdict line from a judge response. Line-anchored at both ends so
 * a discussion of the word "verdict" or a format-spec echo like
 * `VERDICT: YES or NO` does not false-positive; a single trailing period is
 * tolerated. Anything else on the verdict line is "no verdict".
 */
export function parseVerdict(text: string): Verdict | null {
  const match = /(?:^|\n)[ \t]*VERDICT[ \t]*:[ \t]*(YES|NO)[ \t]*\.?[ \t]*\r?$/im.exec(text);
  return match ? (match[1]!.toUpperCase() as Verdict) : null;
}

/** Judge fields surfaced when the transcript entry is expanded. */
export interface JudgeVerdictDetails {
  summary: string;
  affectedPaths: string;
  reason: string;
}

/**
 * Extract SUMMARY / AFFECTED PATHS / REASON from the judge response. Missing
 * or malformed fields become empty strings; the verdict is parsed separately
 * by {@link parseVerdict}.
 *
 * Rules (deterministic, display-only data):
 * - Keys are matched line-anchored and case-insensitive; first occurrence
 *   wins; fields may appear in any order.
 * - The value is the rest of the key's own line, trimmed. Values do NOT span
 *   lines — a wrapped summary simply truncates.
 * - Text before, between, or after fields is ignored.
 */
export function parseJudgeDetails(text: string): JudgeVerdictDetails {
  const details: JudgeVerdictDetails = { summary: '', affectedPaths: '', reason: '' };
  const seen = new Set<string>();

  const fields: Array<{ key: keyof JudgeVerdictDetails; label: string }> = [
    { key: 'summary', label: 'SUMMARY' },
    { key: 'affectedPaths', label: 'AFFECTED PATHS' },
    { key: 'reason', label: 'REASON' },
  ];

  for (const line of text.split('\n')) {
    for (const { key, label } of fields) {
      if (seen.has(key)) continue;
      const match = new RegExp(`^[ \\t]*${label.replace(' ', '[ \\t]+')}[ \\t]*:[ \\t]*(.*)$`, 'i').exec(line);
      if (match) {
        details[key] = match[1]!.trim();
        seen.add(key);
      }
    }
  }

  return details;
}

/**
 * Split a "provider/modelId" reference on the FIRST `/` (the id may itself
 * contain `/`, e.g. `openrouter/anthropic/claude-...`). Returns null unless
 * both parts are non-empty — `'foo'`, `'/id'`, `'provider/'`, and `''` are
 * malformed. A malformed ref is treated by the resolver as `unavailable`.
 */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

/** Result of resolving the configured verification model. */
export type ModelResolution =
  | { ok: true; model: Model<any> }
  | { ok: false; kind: 'unavailable'; error: string } // configured but missing/no auth — notify already shown
  | { ok: false; kind: 'not-configured' }; // no model configured — no notify; caller logs "No judge LLM"

/**
 * Resolve the global-only `commandVerificationModel` setting against the
 * model registry. A configured-but-broken reference (malformed, missing
 * model, or missing auth) shows a `notify` naming the ref and the global
 * config path, then reports `unavailable`.
 */
function resolveVerificationModel(configResult: ConfigResult, ctx: ExtensionContext): ModelResolution {
  const ref = configResult.global.commandVerificationModel;
  if (ref === undefined) {
    return { ok: false, kind: 'not-configured' };
  }

  const fail = (reason: string): ModelResolution => {
    const error = `pi-gate: verification model "${ref}" ${reason}`;
    ctx.ui.notify(`${error} — edit ${configResult.globalPath} or remove the setting`, 'warning');
    return { ok: false, kind: 'unavailable', error };
  };

  const parsed = parseModelRef(ref);
  if (!parsed) {
    return fail('is not a valid "provider/modelId" reference');
  }

  const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
  if (!model) {
    return fail('was not found in the model registry');
  }

  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return fail('has no configured auth');
  }

  return { ok: true, model };
}

/** Outcome of a judge run; each value maps to a fixed transcript message. */
export type JudgeOutcome = 'allowed' | 'denied' | 'no-judge' | 'unavailable' | 'error' | 'no-verdict';

/** Coarse decision reported back to the bash guard. */
export type JudgeDecision = 'allow' | 'deny' | 'escalate';

/** Result of judging an unparsable command. */
export interface JudgeResult {
  decision: JudgeDecision;
  /** Present when the caller should log a verdict message. */
  outcome?: JudgeOutcome;
  /** Parsed judge output for the transcript entry, when available. */
  details?: JudgeVerdictDetails;
  /** Underlying failure detail when the outcome is 'error' (for diagnostics). */
  error?: string;
}

/** Hard deadline for the judge call; on expiry we abort and escalate. */
export const JUDGE_TIMEOUT_MS = 60_000;

/** Injected LLM call; defaults to `ctx.modelRegistry.complete`. */
export interface Completer {
  (model: Model<any>, context: Context, options?: ModelsApiStreamOptions<any>): Promise<AssistantMessage>;
}

/** Dependency injection for tests. */
export interface JudgeDeps {
  /** Injected judge completer; defaults to `ctx.modelRegistry.complete`. */
  complete?: Completer;
  /** Timeout override for tests; defaults to {@link JUDGE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Build the opencode session-attribution headers for a judge request.
 *
 * The extension-facing `modelRegistry.complete` forwards options straight to
 * the provider runtime, so pi's own `x-opencode-session` attribution (added
 * by the agent's main loop via `transformHeaders`) never runs and passing
 * `sessionId` alone is silently ignored. Providers like opencode-go
 * hard-reject requests without the header (HTTP 400 `MissingSessionID`), so
 * it must be set explicitly. Matching mirrors pi's `getSessionHeaders`
 * (provider id or opencode.ai host).
 *
 * @param model - Resolved verification model.
 * @param sessionId - Current session id, sent as the routing header value.
 * @returns The attribution headers for opencode models, else `undefined`.
 */
function opencodeSessionHeaders(model: Model<any>, sessionId: string): Record<string, string> | undefined {
  let opencodeHost: boolean;
  try {
    opencodeHost = new URL(model.baseUrl).hostname === 'opencode.ai';
  } catch {
    opencodeHost = false;
  }
  const isOpencode = model.provider === 'opencode' || model.provider === 'opencode-go' || opencodeHost;
  if (!isOpencode) return undefined;
  return { 'x-opencode-session': sessionId, 'x-opencode-client': 'pi' };
}

/** Join all text blocks of an assistant message into one string. */
function joinTextBlocks(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Build the diagnostic text for a judge message that did not stop cleanly.
 *
 * `complete()` resolves (rather than throws) on provider failure, so
 * `stopReason` alone is just `"error"` and says nothing. The actionable cause
 * lives in `errorMessage` (provider error text), `rawStopReason` (provider
 * stop token), and `diagnostics`; an expired judge deadline is called out
 * explicitly so a timeout is not mistaken for a provider fault.
 *
 * @param message - Assistant message returned by the judge completer.
 * @param timedOut - Whether the judge deadline (not the caller) aborted the call.
 * @param timeoutMs - Deadline in milliseconds, for the timeout message.
 * @returns Human-readable failure detail, `" — "`-joined.
 */
function describeJudgeFailure(message: AssistantMessage, timedOut: boolean, timeoutMs: number): string {
  const parts = [`stopReason: ${message.stopReason}`];
  if (timedOut) parts.push(`judge timed out after ${timeoutMs}ms`);
  if (message.rawStopReason) parts.push(`rawStopReason: ${message.rawStopReason}`);
  if (message.errorMessage) parts.push(message.errorMessage);
  for (const diagnostic of message.diagnostics ?? []) {
    const detail = diagnostic.error?.message ?? (diagnostic.details ? JSON.stringify(diagnostic.details) : undefined);
    if (detail) parts.push(`${diagnostic.type}: ${detail}`);
  }
  return parts.join(' — ');
}

/**
 * Judge an unparsable bash command with the configured verification model.
 *
 * Resolution failures escalate without an LLM call; an LLM error, abort,
 * timeout, non-stop finish, or ambiguous verdict also escalates (the caller
 * falls back to manual approval). Only a clean `YES`/`NO` verdict decides.
 *
 * @param command - Raw bash command that failed parsing.
 * @param cwd - Project working directory.
 * @param configResult - Loaded pi-gate config (model read from `global` only).
 * @param ctx - Pi extension context (registry, UI status, abort signal).
 * @param deps - Optional injected completer and timeout override.
 * @returns The judge decision plus the outcome/details for transcript logging.
 */
export async function judgeBashCommand(
  command: string,
  cwd: string,
  configResult: ConfigResult,
  ctx: ExtensionContext,
  deps: JudgeDeps = {},
): Promise<JudgeResult> {
  const resolution = resolveVerificationModel(configResult, ctx);
  if (!resolution.ok) {
    return {
      decision: 'escalate',
      outcome: resolution.kind === 'not-configured' ? 'no-judge' : 'unavailable',
    };
  }

  const sessionState = getSessionState();
  const prompt = buildJudgePrompt({
    command,
    cwd,
    globalPath: configResult.globalPath,
    projectPath: configResult.projectPath,
    globalConfig: configResult.global,
    projectConfig: configResult.project,
    sessionBashAllow: [...sessionState.approvedBashPatterns],
    sessionExternalAllow: [...sessionState.approvedExternalPatterns],
  });

  const complete = deps.complete ?? ((model, context, options) => ctx.modelRegistry.complete(model, context, options));
  // The extension-facing registry ignores `sessionId`; opencode providers
  // need the attribution header set explicitly or they reject the request.
  const sessionId = ctx.sessionManager.getSessionId();
  const attributionHeaders = opencodeSessionHeaders(resolution.model, sessionId);

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
  const signal = AbortSignal.any([deadline.signal, ...(ctx.signal ? [ctx.signal] : [])]);

  ctx.ui.setStatus('pi-gate', 'pi-gate: Verifying bash command...');
  try {
    const message = await complete(
      resolution.model,
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      },
      // Providers like opencode-go reject requests without the session
      // attribution header; `sessionId` alone is ignored on the extension
      // registry path, so opencode models also get explicit headers.
      { signal, sessionId, ...(attributionHeaders ? { headers: attributionHeaders } : {}) },
    );

    if (message.stopReason !== 'stop') {
      const timeoutMs = deps.timeoutMs ?? JUDGE_TIMEOUT_MS;
      return {
        decision: 'escalate',
        outcome: 'error',
        error: describeJudgeFailure(message, deadline.signal.aborted, timeoutMs),
      };
    }

    const text = joinTextBlocks(message);
    const details = parseJudgeDetails(text);
    const verdict = parseVerdict(text);

    if (verdict === 'YES') return { decision: 'allow', outcome: 'allowed', details };
    if (verdict === 'NO') return { decision: 'deny', outcome: 'denied', details };
    return { decision: 'escalate', outcome: 'no-verdict' };
  } catch (err) {
    return {
      decision: 'escalate',
      outcome: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    ctx.ui.setStatus('pi-gate', undefined);
  }
}
