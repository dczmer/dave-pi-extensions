/**
 * Rendering for the `subagent` tool: call previews, live per-run status
 * lines, and final markdown output with usage stats.
 */
import {
  getMarkdownTheme,
  type AgentToolResult,
  type Theme,
  type ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui';
import type { AgentScope } from './agents.ts';
import { getFinalOutput, isFailedRun, type SubagentRun } from './runner.ts';

/** Tool result details shared between the tool implementation and renderers. */
export interface SubagentDetails {
  mode: 'single' | 'parallel';
  agentScope: AgentScope;
  results: SubagentRun[];
}

/** Loosely-typed view of the tool call arguments, as passed to `renderCall`. */
export interface SubagentCallArgs {
  agent?: string;
  task?: string;
  cwd?: string;
  tasks?: Array<{ agent: string; task: string; cwd?: string }>;
  agentScope?: AgentScope;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** Format a compact usage line like `2 turns ↑12k ↓3k $0.0042`. */
export function formatUsageStats(usage: SubagentRun['usage']): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  return parts.join(' ');
}

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Render the pending tool call line(s). */
export function renderSubagentCall(args: SubagentCallArgs, theme: Theme): Component {
  const scope: AgentScope = args.agentScope ?? 'both';
  if (args.tasks && args.tasks.length > 0) {
    let text =
      theme.fg('toolTitle', theme.bold('subagent ')) +
      theme.fg('accent', `parallel (${args.tasks.length} tasks)`) +
      theme.fg('muted', ` [${scope}]`);
    for (const t of args.tasks.slice(0, 3)) {
      text += `\n  ${theme.fg('accent', t.agent)}${theme.fg('dim', ` ${preview(t.task, 40)}`)}`;
    }
    if (args.tasks.length > 3) text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }
  let text =
    theme.fg('toolTitle', theme.bold('subagent ')) +
    theme.fg('accent', args.agent || '...') +
    theme.fg('muted', ` [${scope}]`);
  text += `\n  ${theme.fg('dim', args.task ? preview(args.task, 60) : '...')}`;
  return new Text(text, 0, 0);
}

function runIcon(run: SubagentRun, theme: Theme): string {
  if (run.exitCode === null) return theme.fg('warning', '⏳');
  return isFailedRun(run) ? theme.fg('error', '✗') : theme.fg('success', '✓');
}

/** One-line summary of a run: icon, agent name, live status or error. */
function collapsedRunLine(run: SubagentRun, theme: Theme): string {
  let line = `${runIcon(run, theme)} ${theme.fg('toolTitle', theme.bold(run.agent))}`;
  if (run.exitCode === null) {
    line += `\n  ${theme.fg('dim', run.statusLine || '(starting...)')}`;
  } else if (isFailedRun(run)) {
    line += `\n  ${theme.fg('error', run.errorMessage ?? run.statusLine ?? 'failed')}`;
  } else {
    line += `\n  ${theme.fg('toolOutput', run.statusLine || '(done)')}`;
  }
  return line;
}

function aggregateUsage(results: SubagentRun[]): SubagentRun['usage'] {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens);
    total.turns += r.usage.turns;
  }
  return total;
}

/** Expanded per-run section: header, task, final output as markdown, usage. */
function expandedRunSection(container: Container, run: SubagentRun, theme: Theme): void {
  const mdTheme = getMarkdownTheme();
  container.addChild(new Spacer(1));
  container.addChild(new Text(`${runIcon(run, theme)} ${theme.fg('toolTitle', theme.bold(run.agent))}`, 0, 0));
  container.addChild(new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', run.task), 0, 0));
  if (isFailedRun(run) && run.errorMessage) {
    container.addChild(new Text(theme.fg('error', `Error: ${run.errorMessage}`), 0, 0));
  }
  const output = getFinalOutput(run.messages).trim();
  if (output) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(output, 0, 0, mdTheme));
  } else {
    container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0));
  }
  const usageStr = formatUsageStats(run.usage);
  if (usageStr) container.addChild(new Text(theme.fg('dim', usageStr), 0, 0));
}

/** Render the tool result; partial results show live per-run status lines. */
export function renderSubagentResult(
  result: AgentToolResult<SubagentDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const details = result.details;
  if (!details || details.results.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0);
  }

  const { expanded } = options;

  if (expanded) {
    const container = new Container();
    const done = details.results.filter((r) => r.exitCode !== null).length;
    const header =
      details.mode === 'parallel' ?
        `${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', `${done}/${details.results.length} done`)}`
      : theme.fg('toolTitle', theme.bold('subagent'));
    container.addChild(new Text(header, 0, 0));
    for (const run of details.results) expandedRunSection(container, run, theme);
    if (details.results.length > 1) {
      const totalStr = formatUsageStats(aggregateUsage(details.results));
      if (totalStr) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg('dim', `Total: ${totalStr}`), 0, 0));
      }
    }
    return container;
  }

  // Collapsed: live status lines while running, summary once finished.
  if (details.mode === 'parallel') {
    const running = details.results.filter((r) => r.exitCode === null).length;
    const failed = details.results.filter((r) => r.exitCode !== null && isFailedRun(r)).length;
    const done = details.results.length - running;
    const icon =
      running > 0 ? theme.fg('warning', '⏳')
      : failed > 0 ? theme.fg('warning', '◐')
      : theme.fg('success', '✓');
    let text = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', `${done}/${details.results.length} done`)}`;
    for (const run of details.results) text += `\n${collapsedRunLine(run, theme)}`;
    if (running === 0) {
      const totalStr = formatUsageStats(aggregateUsage(details.results));
      if (totalStr) text += `\n${theme.fg('dim', `Total: ${totalStr}`)}`;
    }
    return new Text(text, 0, 0);
  }

  const run = details.results[0]!;
  let text = collapsedRunLine(run, theme);
  if (run.exitCode !== null) {
    const usageStr = formatUsageStats(run.usage);
    if (usageStr) text += `\n${theme.fg('dim', usageStr)}`;
  }
  return new Text(text, 0, 0);
}
