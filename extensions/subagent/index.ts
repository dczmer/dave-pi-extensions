/**
 * subagent extension: delegate tasks to headless `pi --mode rpc` child
 * processes, with approvals relayed to this session and live progress.
 *
 * One `subagent` tool, two modes: single `{agent, task, cwd?}` and parallel
 * `{tasks: [{agent, task, cwd?}, ...]}` (one child process per task, all
 * concurrent, blocking until every child finishes).
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { discoverAgents, resolveAgentDirs, type AgentConfig, type AgentScope } from './agents.ts';
import { renderSubagentCall, renderSubagentResult, type SubagentCallArgs, type SubagentDetails } from './render.ts';
import { getFinalOutput, isFailedRun, runSubagent, type RunSubagentOptions, type SubagentRun } from './runner.ts';

/** Maximum number of tasks accepted in one parallel call. */
export const MAX_PARALLEL_TASKS = 8;
/** Maximum number of child processes running at once. */
export const MAX_CONCURRENCY = 4;
/** Per-task output cap in bytes; overflow is truncated with a note. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: 'Name of the agent to invoke (single mode)' })),
  task: Type.Optional(Type.String({ description: 'Task to delegate (single mode)' })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process (single mode)' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Array of {agent, task, cwd?} for parallel execution' })),
  agentScope: Type.Optional(
    StringEnum(['user', 'project', 'both'] as const, {
      description: 'Which agent directories to use. Default: "both" (bundled + user + project).',
      default: 'both',
    }),
  ),
});

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return 'none';
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join('; ');
}

function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, 'utf8') > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`;
}

function runOutput(run: SubagentRun): string {
  if (isFailedRun(run)) return run.errorMessage ?? getFinalOutput(run.messages) ?? '(no output)';
  return getFinalOutput(run.messages) || '(no output)';
}

/** Factory with injectable environment (tests pass a fake env; no process.env mutation). */
export function createSubagentExtension(env: NodeJS.ProcessEnv) {
  return function (pi: ExtensionAPI) {
    // Inside a spawned child, only the companion extension's tools are
    // wanted; never allow a subagent to spawn its own subagents.
    if (env.PI_SUBAGENT_CHILD) return;

    pi.registerTool<typeof SubagentParams, SubagentDetails>({
      name: 'subagent',
      label: 'Subagent',
      description: [
        'Delegate tasks to specialized subagents running in headless pi child processes with isolated context.',
        'Modes: single (agent + task) or parallel (tasks array, one process per task, all concurrent).',
        'Agents are .md files with frontmatter discovered from this extension (bundled), ~/.pi/agent/agents (user), and .pi/agents (project; wins on name collision).',
        'The bundled agent "worker" (general-purpose, full capabilities) is always available under the default agentScope; use it unless a task calls for a specialized agent.',
        'Approvals requested inside a child are relayed to this session; a blocked child can ask you a question via its contact_supervisor tool.',
      ].join(' '),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const agentScope: AgentScope = params.agentScope ?? 'both';
        const dirs = resolveAgentDirs(ctx.cwd);
        const agents = discoverAgents(dirs, agentScope);

        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const makeDetails =
          (mode: 'single' | 'parallel') =>
          (results: SubagentRun[]): SubagentDetails => ({ mode, agentScope, results });

        if (Number(hasTasks) + Number(hasSingle) !== 1) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid parameters: provide exactly one mode (agent + task, or tasks).\nAvailable agents: ${formatAgentList(agents)}`,
              },
            ],
            details: makeDetails('single')([]),
            isError: true,
          };
        }

        const requested: Array<{ agent: string; task: string; cwd?: string }> =
          hasTasks ?
            params.tasks!
          : [{ agent: params.agent!, task: params.task!, ...(params.cwd !== undefined ? { cwd: params.cwd } : {}) }];

        if (requested.length > MAX_PARALLEL_TASKS) {
          return {
            content: [
              { type: 'text', text: `Too many parallel tasks (${requested.length}). Max is ${MAX_PARALLEL_TASKS}.` },
            ],
            details: makeDetails('parallel')([]),
            isError: true,
          };
        }

        const resolved = requested.map((t) => ({ request: t, agent: agents.find((a) => a.name === t.agent) }));
        const unknown = resolved.filter((r) => !r.agent);
        if (unknown.length > 0) {
          const names = unknown.map((r) => `"${r.request.agent}"`).join(', ');
          return {
            content: [
              { type: 'text', text: `Unknown agent(s): ${names}.\nAvailable agents: ${formatAgentList(agents)}` },
            ],
            details: makeDetails(hasTasks ? 'parallel' : 'single')([]),
            isError: true,
          };
        }

        // D3 gate: project-sourced agents from an untrusted project need a
        // one-shot confirmation. Without a dialog-capable UI the gate cannot
        // be shown, so fail closed instead of spawning repo-controlled code.
        const projectAgents = resolved.filter((r) => r.agent!.source === 'project');
        if (projectAgents.length > 0 && !ctx.isProjectTrusted()) {
          if (!ctx.hasUI) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Refusing to run project-local agent(s) ${projectAgents.map((r) => `"${r.agent!.name}"`).join(', ')}: project is not trusted and no UI is available to confirm.`,
                },
              ],
              details: makeDetails(hasTasks ? 'parallel' : 'single')([]),
              isError: true,
            };
          }
          const names = projectAgents.map((r) => r.agent!.name).join(', ');
          const ok = await ctx.ui.confirm(
            'Run project-local agents?',
            `Agents: ${names}\nSource: ${dirs.project ?? '(unknown)'}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
              details: makeDetails(hasTasks ? 'parallel' : 'single')([]),
              isError: true,
            };
          }
        }

        const dispatchModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const relayUi: RunSubagentOptions['ui'] = ctx.hasUI ? ctx.ui : undefined;
        const emitUpdate =
          onUpdate === undefined ? undefined : (
            (mode: 'single' | 'parallel', runs: SubagentRun[], text: string) =>
              onUpdate({ content: [{ type: 'text', text }], details: makeDetails(mode)(runs) })
          );

        const setStatus = (text: string | undefined) => {
          if (ctx.hasUI) ctx.ui.setStatus('subagent', text);
        };

        const runOne = (
          agent: AgentConfig,
          task: string,
          cwd: string,
          onProgress?: (run: SubagentRun) => void,
        ): Promise<SubagentRun> =>
          runSubagent({
            agent,
            task,
            cwd,
            model: agent.model ?? dispatchModel,
            thinkingLevel: agent.model ? undefined : ctx.thinkingLevel,
            signal,
            ui: relayUi,
            hasRelayUI: ctx.hasUI,
            ...(onProgress !== undefined ? { onProgress } : {}),
          });

        try {
          if (!hasTasks) {
            const { agent, request } = resolved[0]!;
            const a = agent!;
            const update = emitUpdate;
            setStatus(`subagent(${a.name}): starting...`);
            const run = await runOne(a, request.task, request.cwd ?? ctx.cwd, (r) => {
              setStatus(`subagent(${a.name}): ${r.statusLine}`);
              update?.('single', [r], r.statusLine || '(running...)');
            });
            const details = makeDetails('single')([run]);
            if (isFailedRun(run)) {
              return { content: [{ type: 'text', text: truncateOutput(runOutput(run)) }], details, isError: true };
            }
            return { content: [{ type: 'text', text: truncateOutput(runOutput(run)) }], details };
          }

          // Parallel mode: one child process per task, all concurrent.
          const allRuns: SubagentRun[] = requested.map((t) => ({
            agent: t.agent,
            task: t.task,
            statusLine: '',
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            exitCode: null,
          }));

          const emitParallel = () => {
            const done = allRuns.filter((r) => r.exitCode !== null).length;
            setStatus(`subagent: ${done}/${allRuns.length} done`);
            emitUpdate?.('parallel', [...allRuns], `Parallel: ${done}/${allRuns.length} done`);
          };
          emitParallel();

          await mapWithConcurrencyLimit(resolved, MAX_CONCURRENCY, async ({ request, agent }, index) => {
            const run = await runOne(agent!, request.task, request.cwd ?? ctx.cwd, (r) => {
              allRuns[index] = r;
              emitParallel();
            });
            allRuns[index] = run;
            emitParallel();
          });

          const successCount = allRuns.filter((r) => !isFailedRun(r)).length;
          const summaries = allRuns.map((r) => {
            const status = isFailedRun(r) ? 'failed' : 'completed';
            return `### [${r.agent}] ${status}\n\n${truncateOutput(runOutput(r))}`;
          });
          return {
            content: [
              {
                type: 'text',
                text: `Parallel: ${successCount}/${allRuns.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
              },
            ],
            details: makeDetails('parallel')(allRuns),
            isError: successCount === 0,
          };
        } finally {
          setStatus(undefined);
        }
      },

      renderCall: (args, theme) => renderSubagentCall(args as SubagentCallArgs, theme),
      renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),
    });
  };
}

export default createSubagentExtension(process.env);
