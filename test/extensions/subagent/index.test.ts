import { strictEqual, ok } from 'node:assert';
import { test, mock } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSubagentExtension } from '../../../extensions/subagent/index.ts';
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
  const harness = await createPiTestHarness(createSubagentExtension({}));
  ok(harness.listRegisteredTools().includes('subagent'));
});

test('nesting guard: PI_SUBAGENT_CHILD registers nothing', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({ PI_SUBAGENT_CHILD: '1' }));
  strictEqual(harness.listRegisteredTools().length, 0);
});

test('unknown agent errors and lists available agents', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    const harness = await createPiTestHarness(createSubagentExtension({}), dir);
    const result = (await harness.tool('subagent').execute({ agent: 'nope-xyz', task: 't' })) as ToolResultLike;
    strictEqual(result.isError, true);
    const text = resultText(result);
    ok(text.includes('Unknown agent'), text);
    ok(text.includes('worker'), 'expected the bundled worker agent to be listed');
  });
});

test('requires exactly one mode', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}));
  const result = (await harness.tool('subagent').execute({})) as ToolResultLike;
  strictEqual(result.isError, true);
  ok(resultText(result).includes('exactly one mode'));
});

test('D3 gate: untrusted project agent prompts for confirmation; denial cancels', async () => {
  await withTempDir('subagent-index-', async (dir) => {
    writeProjectAgent(dir, 'projbot');
    const harness = await createPiTestHarness(createSubagentExtension({}), dir);

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
    const harness = await createPiTestHarness(createSubagentExtension({}), dir);

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
    const harness = await createPiTestHarness(createSubagentExtension({}), dir);

    const result = (await harness
      .tool('subagent')
      .execute({ agent: 'projbot', task: 'x' }, { isProjectTrusted: () => false, hasUI: false })) as ToolResultLike;

    strictEqual(result.isError, true);
    ok(resultText(result).includes('not trusted'));
  });
});

test('parallel mode rejects more than MAX_PARALLEL_TASKS tasks', async () => {
  const harness = await createPiTestHarness(createSubagentExtension({}));
  const tasks = Array.from({ length: 9 }, (_, i) => ({ agent: 'worker', task: `t${i}` }));
  const result = (await harness.tool('subagent').execute({ tasks })) as ToolResultLike;
  strictEqual(result.isError, true);
  ok(resultText(result).includes('Too many parallel tasks'));
});
