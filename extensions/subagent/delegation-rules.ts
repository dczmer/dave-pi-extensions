/**
 * System-prompt section teaching the primary session when and how to
 * delegate to the subagent tool. Appended via `before_agent_start` so the
 * rules are present exactly when the tool is, and never inside spawned
 * children (the extension factory early-returns for children before
 * registering this handler).
 */
export const DELEGATION_RULES: string = `## Subagent Delegation

You have a \`subagent\` tool that runs tasks in isolated child sessions. A
subagent sees none of this conversation; it receives only the prompt you
write and returns only its final report.

Delegate a task to a subagent when ALL of these hold:
- It is self-contained: you can fully specify it without this
  conversation's history.
- You only need the final result, not the intermediate steps.
- Its intermediate output (search hits, logs, file contents, test runs)
  would clutter this session without being referenced again.

Do NOT delegate when the task depends on conversation context, decisions
made this session, or user preferences the subagent cannot see, or when
you must interleave its steps with your own work.

Dispatch rules:
- Write a self-contained dispatch: the goal, exact file paths, relevant
  constraints, and the report format you expect. Never paste conversation
  history into a dispatch.
- If multiple delegatable tasks are independent (neither needs the other's
  output), dispatch them in parallel using the tool's \`tasks\` array mode.
- Never dispatch in parallel subagents that edit overlapping files or
  otherwise share mutable state.
- Instruct the subagent to return a short report (status, key results,
  concerns), not raw logs or file dumps.

Reporting rule:
- When a subagent finishes, report a brief summary to the user (1-3
  lines): what it did, its outcome, and anything that changes your plan.
  Never paste the subagent's raw output into your reply.
- If a subagent's result is inadequate, re-dispatch with better context
  rather than silently redoing the work in this session.`;

/** Append the delegation rules to an assembled system prompt. */
export function appendDelegationRules(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DELEGATION_RULES}`;
}
