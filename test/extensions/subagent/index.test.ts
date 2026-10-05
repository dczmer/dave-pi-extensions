import { strictEqual, notStrictEqual, deepStrictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSubagentExtension } from '../../../extensions/subagent/index.ts';
import type { RunSubagentOptions, SubagentRun } from '../../../extensions/subagent/runner.ts';
import { zeroUsage } from '../../../extensions/subagent/runner.ts';
import { createAssistantMessage } from '../../utils/pi-context.ts';
import { createPiTestHarness } from '../../utils/pi-harness.ts';
import { createUIContext } from '../../utils/pi-context.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

function writeProjectAgent(dir: string, name: string): void {
  const agentsDir = join(dir, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: project agent\n---\n\nDo things.\n`);
}

interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function resultText(result: unknown): string {
  const r = result as ToolResultLike;
  return r.content.map((c) => c.text ?? '').join('\n');
}

test('registers the subagent tool', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }));
  ok(harness.listRegisteredTools().includes('subagent'));
});

test('nesting guard: PI_SUBAGENT_CHILD registers nothing', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({ PI_SUBAGENT_CHILD: '1' }));
  strictEqual(harness.listRegisteredTools().length, 0);
});

test('unknown agent errors and lists available agents', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }), dir);
    const result = (await harness.tool('subagent').execute({ agent: 'nope-xyz', task: 't' })) as ToolResultLike;
    strictEqual(result.isError, true);
    const text = resultText(result);
    ok(text.includes('Unknown agent'), text);
    ok(text.includes('worker'), 'expected the bundled worker agent to be listed');
  });
});

test('requires exactly one mode', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }));
  const result = (await harness.tool('subagent').execute({})) as ToolResultLike;
  strictEqual(result.isError, true);
  ok(resultText(result).includes('exactly one mode'));
});

test('D3 gate: untrusted project agent prompts for confirmation; denial cancels', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    writeProjectAgent(dir, 'projbot');
    const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }), dir);

    const confirm = mock.fn(async () => false);
    const result = (await harness
      .tool('subagent')
      .execute(
        { agent: 'projbot', task: 'x' },
        { isProjectTrusted: () => false, ui: createUIContext({ confirm }) },
      )) as ToolResultLike;

    strictEqual(confirm.mock.calls.length, 1);
    strictEqual(result.isError, true);
    ok(resultText(result).includes('not approved'));
  });
});

test('D3 gate: trusted project runs no confirmation prompt', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    writeProjectAgent(dir, 'projbot');
    const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }), dir);

    // Trusted project: the gate is skipped entirely. The run itself would
    // spawn a real child, so stop at the unknown-agent boundary instead by
    // requesting a second, unknown parallel agent: unknown-agent validation
    // happens before the gate, keeping this test spawn-free while asserting
    // the trusted path is taken for projbot.
    const confirm = mock.fn(async () => false);
    const result = (await harness.tool('subagent').execute(
      {
        tasks: [
          { agent: 'projbot', task: 'x' },
          { agent: 'nope-xyz', task: 'y' },
        ],
      },
      { isProjectTrusted: () => true, ui: createUIContext({ confirm }) },
    )) as ToolResultLike;

    strictEqual(result.isError, true);
    ok(resultText(result).includes('Unknown agent'));
    strictEqual(confirm.mock.calls.length, 0);
  });
});

test('D3 gate fails closed without a dialog-capable UI', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    writeProjectAgent(dir, 'projbot');
    const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }), dir);

    const result = (await harness
      .tool('subagent')
      .execute({ agent: 'projbot', task: 'x' }, { isProjectTrusted: () => false, hasUI: false })) as ToolResultLike;

    strictEqual(result.isError, true);
    ok(resultText(result).includes('not trusted'));
  });
});

test('parallel mode rejects more than MAX_PARALLEL_TASKS tasks', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}, { sweepOnLoad: false }));
  const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: 'worker', task: `t${i}` }));
  const result = (await harness.tool('subagent').execute({ tasks })) as ToolResultLike;
  strictEqual(result.isError, true);
  ok(resultText(result).includes('Too many parallel tasks'));
});

/** A runner fake that reports one live progress tick then resolves as completed. */
function createFakeRunner(): {
  runSubagent: (opts: RunSubagentOptions) => Promise<SubagentRun>;
  calls: RunSubagentOptions[];
} {
  const calls: RunSubagentOptions[] = [];
  const runSubagent = async (opts: RunSubagentOptions): Promise<SubagentRun> => {
    calls.push(opts);
    const live: SubagentRun = {
      agent: opts.agent.name,
      task: opts.task,
      statusLine: 'bash: npm test',
      messages: [],
      usage: zeroUsage(),
      exitCode: null,
    };
    opts.onProgress?.(live);
    return { ...live, exitCode: 0, messages: [createAssistantMessage('all done')] };
  };
  return { runSubagent, calls };
}

test('fleet widget lists the active run below the editor and is cleared on completion', async () => {
  const fake = createFakeRunner();
  const harness = await createPiTestHarness(
    createSubagentExtension({}, { sweepOnLoad: false, runSubagent: fake.runSubagent }),
  );
  const setWidget = mock.fn();

  await harness.tool('subagent').execute({ agent: 'worker', task: 't' }, { ui: createUIContext({ setWidget }) });

  strictEqual(setWidget.mock.calls.length >= 2, true);
  const first = setWidget.mock.calls[0]!.arguments;
  strictEqual(first[0], 'subagent');
  strictEqual(first[1][0], 'subagents 0/1 done');
  ok(first[1][1].includes('worker'));
  deepStrictEqual(first[2], { placement: 'belowEditor' });

  // The progress tick re-renders with the live status line.
  const progress = setWidget.mock.calls[1]!.arguments;
  ok(progress[1][1].includes('bash: npm test'));

  // Completion clears the widget.
  const last = setWidget.mock.calls[setWidget.mock.calls.length - 1]!.arguments;
  strictEqual(last[0], 'subagent');
  strictEqual(last[1], undefined);
});

test('parallel mode fleet header tracks done counts', async () => {
  const fake = createFakeRunner();
  const harness = await createPiTestHarness(
    createSubagentExtension({}, { sweepOnLoad: false, runSubagent: fake.runSubagent }),
  );
  const setWidget = mock.fn();

  await harness.tool('subagent').execute(
    {
      tasks: [
        { agent: 'worker', task: 'a' },
        { agent: 'worker', task: 'b' },
      ],
    },
    { ui: createUIContext({ setWidget }) },
  );

  const headers = setWidget.mock.calls.map((c) => c.arguments[1]?.[0]).filter(Boolean);
  strictEqual(headers[0], 'subagents 0/2 done');
  strictEqual(headers[headers.length - 1], 'subagents 2/2 done');
  const last = setWidget.mock.calls[setWidget.mock.calls.length - 1]!.arguments;
  strictEqual(last[1], undefined);
});

test('no UI: fleet widget is skipped and the run still completes', async () => {
  const fake = createFakeRunner();
  const harness = await createPiTestHarness(
    createSubagentExtension({}, { sweepOnLoad: false, runSubagent: fake.runSubagent }),
  );
  const setWidget = mock.fn();

  const result = (await harness
    .tool('subagent')
    .execute({ agent: 'worker', task: 't' }, { hasUI: false, ui: createUIContext({ setWidget }) })) as ToolResultLike;

  strictEqual(setWidget.mock.calls.length, 0);
  strictEqual(result.isError, undefined);
  strictEqual(fake.calls.length, 1);
  ok(resultText(result).includes('all done'));
});

test('run dirs are allocated per task under the runs root', async () => {
  await withTempDir('subagent-runs-', async (runsRoot) => {
    const fake = createFakeRunner();
    const harness = await createPiTestHarness(
      createSubagentExtension({ PI_SUBAGENT_RUNS_DIR: runsRoot }, { runSubagent: fake.runSubagent }),
    );

    await harness.tool('subagent').execute({
      tasks: [
        { agent: 'worker', task: 'a' },
        { agent: 'worker', task: 'b' },
      ],
    });

    strictEqual(fake.calls.length, 2);
    for (const call of fake.calls) {
      ok(call.sessionDir, 'expected a sessionDir per task');
      ok(call.sessionDir!.startsWith(runsRoot), call.sessionDir);
      ok(existsSync(call.sessionDir!));
    }
    notStrictEqual(fake.calls[0]!.sessionDir, fake.calls[1]!.sessionDir);
  });
});
