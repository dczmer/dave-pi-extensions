# Plan: Subagent Delegation System-Prompt Rules

Status: **design complete, ready for implementation**

Inject a small, fixed block of subagent-delegation rules into the primary
session's system prompt, delivered by the existing `subagent` extension
(`extensions/subagent/`) so the rules are present exactly when the
`subagent` tool is, and never inside spawned children. Defer the heavier
orchestration machinery (review loops, ledgers, model tiering) to a future
skill; this document specifies both.

## Part 1 — Research synthesis (what the rules are based on)

Sources consulted:

- **Claude Code sub-agents docs** (code.claude.com/docs/en/sub-agents)
- **superpowers** `subagent-driven-development` skill (github.com/obra/superpowers)
- **OpenAI Codex subagents docs** (developers.openai.com/codex/subagents.md)
- **Anthropic multi-agent research system** (anthropic.com/engineering/multi-agent-research-system)

Convergent findings across all four:

1. **The trigger rule is context pollution, not task size.** Claude Code's
   framing: delegate when a side task would flood the main conversation
   with search results, logs, or file contents you won't reference again;
   the subagent works in its own context and returns only the summary.
   Codex adds the vocabulary: *context pollution* and *context rot*.
2. **Subagents see none of the parent's conversation.** Claude Code
   subagents receive only their own system prompt plus basic environment
   details. Therefore every dispatch prompt must be self-contained.
   Superpowers cites a real failure where a dispatch prompt hit 42k chars,
   99% pasted session history.
3. **Parallel for reads, serial for writes.** Codex: start with parallel
   subagents for read-heavy work (exploration, tests, triage,
   summarization); be careful with parallel write-heavy work (edit
   conflicts, coordination overhead). Superpowers is stricter: never run
   implementation subagents in parallel; batch small same-shape edits into
   one dispatch instead.
4. **Reports must be small.** Superpowers: "everything a subagent prints
   back stays resident in your context forever." Implementers return only
   status, commits, a one-line test summary, and concerns; full reports go
   to files. Codex: subagents return summaries instead of raw intermediate
   output.
5. **The main agent owns coordination.** Keep requirements, decisions, and
   final outputs on the main thread. Don't redo delegated work inline;
   re-dispatch with better context.
6. **Complex orchestration belongs in loadable instructions, not the base
   prompt.** Superpowers' review loops, ledgers, and model-tiering tables
   are a *skill* — loaded only when executing a multi-task plan — not
   system-prompt content. System prompts get the always-true rules; skills
   get the situational machinery.

## Part 2 — The system-prompt block (full verbatim content)

This is the exact text to append to the primary session's system prompt.
It is written to be model-agnostic and to name the concrete tool interface
this repo's `subagent` extension exposes (single mode `{agent, task, cwd?}`
and parallel mode `{tasks: [...]}`).

```markdown
## Subagent Delegation

You have a `subagent` tool that runs tasks in isolated child sessions. A
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
  output), dispatch them in parallel using the tool's `tasks` array mode.
- Never dispatch in parallel subagents that edit overlapping files or
  otherwise share mutable state.
- Instruct the subagent to return a short report (status, key results,
  concerns), not raw logs or file dumps.

Reporting rule:
- When a subagent finishes, report a brief summary to the user (1-3
  lines): what it did, its outcome, and anything that changes your plan.
  Never paste the subagent's raw output into your reply.
- If a subagent's result is inadequate, re-dispatch with better context
  rather than silently redoing the work in this session.
```

Length: ~260 words (~350 tokens). This is deliberately small: it sits in
every primary-session turn, so it states only always-true rules.

## Part 3 — Implementation

### 3.1 Where the block lives

`extensions/subagent/index.ts`, inside the existing
`createSubagentExtension(env)` factory, registered via the
`before_agent_start` event.

Why this location and mechanism:

- **Exactly-when-needed presence.** The rules only make sense when the
  `subagent` tool exists. Registering them from the same extension that
  registers the tool guarantees the pairing; a user who disables the
  extension loses both together.
- **Automatic child exclusion.** The factory already early-returns when
  `env.PI_SUBAGENT_CHILD` is set (`index.ts:87`), so children never
  receive delegation rules for a tool they cannot call. No new guard code
  needed — the handler registration simply sits after that return.
- **Correct pi mechanism.** `before_agent_start` exposes `systemPrompt`
  and returns `{ systemPrompt }` as a chained replacement
  (`BeforeAgentStartEventResult`, types.d.ts:845). Per
  docs/extensions.md, returning `systemPrompt` replaces the prompt for
  that run while pi keeps recording the structured sections, and multiple
  extensions' replacements chain. Appending a clearly-headed
  `## Subagent Delegation` section composes safely with other extensions:
  even if another extension also returns `systemPrompt`, ours is a pure
  suffix append (`event.systemPrompt + "\n\n" + BLOCK`) applied to
  whatever string the chain hands us.
- **Idempotent across runs.** `before_agent_start` fires per agent run and
  pi reassembles the system prompt each time, so a pure append can never
  duplicate the block within one prompt.

### 3.2 Code shape

New module `extensions/subagent/delegation-rules.ts`:

```typescript
/** System-prompt section teaching the primary session when and how to
 *  delegate to the subagent tool. Appended via before_agent_start. */
export const DELEGATION_RULES: string = `## Subagent Delegation
...`; // exact block from Part 2

/** Build the before_agent_start handler result by appending the rules. */
export function appendDelegationRules(systemPrompt: string): string {
  return `${systemPrompt}\n\n${DELEGATION_RULES}`;
}
```

In `createSubagentExtension`, after the `PI_SUBAGENT_CHILD` early return:

```typescript
pi.on('before_agent_start', (event) => ({
  systemPrompt: appendDelegationRules(event.systemPrompt),
}));
```

That is the entire runtime change: one constant, one pure function, one
event registration. No config file, no toggle in v1 — the block is short,
always correct when the tool is present, and removing the extension
removes it.

### 3.3 Tests

`test/extensions/subagent/delegation-rules.test.ts`:

- `appendDelegationRules` appends the block exactly once, separated by a
  blank line, and leaves the input prompt untouched otherwise.
- The returned block contains the four load-bearing rules (self-contained
  dispatch, parallel `tasks` mode, no parallel overlapping edits, brief
  summary reporting) — assert on distinctive phrases so a silent text
  regression fails loudly.
- Child exclusion: constructing the extension via
  `createSubagentExtension({ PI_SUBAGENT_CHILD: '1' })` with a stub
  `ExtensionAPI` registers neither the tool nor a `before_agent_start`
  handler (the factory's existing env-injection pattern keeps this free of
  `process.env` mutation, per the repo's test-isolation rules).
- Handler integration: with a stub `ExtensionAPI`, capture the registered
  `before_agent_start` handler, invoke it with
  `{ systemPrompt: 'BASE' }`, assert the result's `systemPrompt` is
  `'BASE\n\n' + DELEGATION_RULES`.

### 3.4 Verification commands

- `npm test` — all tests
- `npm run typecheck`
- `npx eslint .`
- `npm run format:check`
- Manual smoke: run pi with the extension, ask "what are your subagent
  delegation rules?" — the answer should quote the block.

## Part 4 — Deferred to a skill (detailed suggestions)

Everything below is real, evidence-backed orchestration machinery that was
deliberately **excluded** from the system-prompt block. Each item fails at
least one of the criteria for prompt inclusion:

- **Situational, not universal.** It only applies when executing a
  multi-task implementation plan, not to every delegation.
- **Too long.** Tables, flowcharts, and templates would cost thousands of
  tokens in every turn of every session.
- **Procedural, not declarative.** It describes a multi-step process with
  checkpoints, which models follow better as an on-demand document than as
  prompt law.

The natural home is a pi skill at `skills/subagent-driven-development/
SKILL.md`, adapted from superpowers' skill of the same name but rebuilt
around this repo's `subagent` tool (blocking single/parallel dispatch,
`contact_supervisor`, approval relay) instead of Claude Code's Task tool.
Candidate contents, in rough priority order:

### 4.1 Implementer / reviewer loop

Superpowers' core pattern: a fresh implementer subagent per plan task,
then a separate reviewer subagent (spec compliance + code quality) per
task, then one broad whole-branch review at the end. The controller never
implements and never fixes review findings itself — its context stays
clean for coordination, and controller fixes would skip review.

Why deferred: the loop needs dispatch templates (implementer prompt,
reviewer prompt, re-review prompt), status taxonomy (DONE /
DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED with different handling per
status), and a bounded fix loop (cap of N rounds, then adjudication with
recorded rulings). That is pages of procedure, only relevant during plan
execution.

Pi-specific notes: the `worker` bundled agent plays implementer; a future
`reviewer` agent definition (read-only mandate, findings-first output
contract) plays reviewer. Fix rounds could re-dispatch fresh children
(since our tool has no resume) carrying the prior report file as memory.

### 4.2 Progress ledger and plan workspace

Superpowers' most-cited failure mode: a controller that loses its place
after context compaction re-dispatches already-completed tasks — the
single most expensive failure they observed. The fix is a per-plan
git-ignored workspace (e.g. `.pi/sdd/<plan>/`) containing a
`progress.md` ledger whose first line names the plan file, with one line
per completed task (`Task <N>: complete (commits <base>..<head>, review
clean)`), plus rulings and parked findings. After compaction, trust the
ledger and `git log` over recollection.

Why deferred: it is a file-format spec plus recovery procedure — pure
skill content, and meaningless outside plan execution.

### 4.3 Model tiering per role

Superpowers: use the least powerful model that can handle each role;
*always specify the model explicitly* because an omitted model inherits
the session's (often most expensive) model; turn count beats token price
(a cheap model taking 3× the turns costs more, so mid-tier is the floor
for reviewers); escalate rounds 4-5 of a fix loop to a higher tier.
Codex mirrors this with per-agent `model` / `model_reasoning_effort`
settings.

Why deferred: requires our `subagent` tool and agent frontmatter to grow
a `model` field (a code change of its own, worth doing), plus a judgment
table that only matters when dispatching many subagents.

### 4.4 Artifacts as files, not tokens

Superpowers' discipline: task briefs, reports, and review packages (commit
list + diff stat + full diff with context) are handed to subagents as
*file paths*, never pasted into dispatch prompts; everything pasted into a
prompt, and everything a subagent prints back, stays resident in the
parent context forever. Small helper scripts generate the brief and the
review package so diffs never transit the controller's context.

Why deferred: needs the brief/review-package conventions and helper
scripts; the system prompt's "return a short report" rule captures the
spirit, but the file-handoff machinery is skill material.

### 4.5 Batching and parallelism policy for writes

Beyond the prompt's one-line "never parallel-edit overlapping files":
compose several small same-shape edits (the same one-line fix across many
files) into ONE dispatch listing every file and its change, reviewed as
one unit; reserve one-dispatch-per-task for work needing its own judgment
or tests. For genuinely parallelizable *implementation*, run each
implementer in its own git worktree and merge sequentially (Claude Code's
`isolation: worktree` is the reference design; pi would implement it as a
wrapper that creates the worktree and passes `cwd`).

Why deferred: worktree isolation needs helper scripts and a merge-back
procedure; batching needs judgment rules with examples.

### 4.6 Review-gate discipline

Never skip the per-task review; never accept a report missing either
verdict (spec AND quality); implementer self-review never replaces the
task review; never pre-judge findings for the reviewer ("do not flag X"
is forbidden); minor findings are recorded in the ledger as deferred,
never silently dropped; adjudication happens only at the fix-loop cap and
every adjudication is a ledger entry.

Why deferred: a checklist plus rationalization table (superpowers
maintains an "excuse → reality" table) — classic skill content.

### Suggested skill skeleton

```
skills/subagent-driven-development/
├── SKILL.md                  # when-to-use, the task loop, fix loop, ledger
├── implementer-prompt.md     # dispatch template incl. report-file contract
├── reviewer-prompt.md        # spec + quality verdict template
├── re-review-prompt.md       # scoped re-review template
└── scripts/
    ├── sdd-workspace         # create/print the plan's workspace dir
    ├── task-brief            # extract task N text to a brief file
    └── review-package        # write commit list + diff to one file
```

Trigger description (frontmatter): "Use when executing a multi-task
implementation plan by delegating tasks to subagents." The base
system-prompt block from Part 2 stays silent about all of this — the two
layers compose: the prompt makes everyday delegation well-behaved; the
skill adds process when a plan justifies it.

## Part 5 — Explicitly out of scope

- A `model` field on agent frontmatter / per-dispatch model selection
  (prerequisite for 4.3; its own change).
- Async/background subagent dispatch (the tool stays blocking; already
  decided in `plans/subagent-extension.md`).
- Resume/follow-up messaging to a live child (fix rounds re-dispatch
  fresh children with the report file instead).
- Any changes to the `worker` bundled agent's own system prompt.

## References

- Claude Code sub-agents: https://code.claude.com/docs/en/sub-agents
- superpowers subagent-driven-development:
  https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md
- OpenAI Codex subagents: https://developers.openai.com/codex/subagents.md
- Anthropic multi-agent research system:
  https://www.anthropic.com/engineering/multi-agent-research-system
- pi extension events (before_agent_start):
  pi docs/extensions.md; `BeforeAgentStartEvent(Result)` in
  `@earendil-works/pi-coding-agent` types.d.ts
- Existing subagent tool plan: `plans/subagent-extension.md`
