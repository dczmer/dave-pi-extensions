import { strictEqual, ok } from 'node:assert';
import { test } from 'node:test';
import type { CustomEntry, ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { registerVerdictRenderer, logJudgeOutcome, VERDICT_ENTRY_TYPE } from '../../../extensions/pi-gate/log.ts';
import type { JudgeOutcome } from '../../../extensions/pi-gate/judge.ts';

/** Capturable stand-ins for the ExtensionAPI entry APIs used by log.ts. */
function createFakePi() {
  const renderers = new Map<
    string,
    (entry: CustomEntry<any>, options: { expanded: boolean }, theme: Theme) => Component | undefined
  >();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerEntryRenderer: (customType: string, renderer: any) => renderers.set(customType, renderer),
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, renderers, entries };
}

const identityTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

function renderToLines(component: Component, width = 120): string[] {
  // Text pads its line to the render width (and Box adds left padding);
  // trim for content assertions.
  return component.render(width).map((line) => line.trim());
}

test('logJudgeOutcome appends a pi-gate-verdict entry with the exact fixed text per outcome', () => {
  const { pi, entries } = createFakePi();

  const expected: Record<JudgeOutcome, string> = {
    allowed: 'pi-gate: Allowed bash command.',
    denied: 'pi-gate: Denied bash command.',
    'no-judge': 'pi-gate: No judge LLM. Escalating to user.',
    unavailable: 'pi-gate: Verification model unavailable. Escalating to user.',
    error: 'pi-gate: Error calling judgment LLM. Escalating to user.',
    'no-verdict': 'pi-gate: Judgment LLM did not return a verdict. Escalating to user.',
  };

  for (const [outcome, text] of Object.entries(expected) as Array<[JudgeOutcome, string]>) {
    logJudgeOutcome(pi, outcome, 'some command');
    const entry = entries.at(-1)!;
    strictEqual(entry.customType, VERDICT_ENTRY_TYPE);
    const data = entry.data as { text: string; command: string; outcome: JudgeOutcome; details?: unknown };
    strictEqual(data.text, text);
    strictEqual(data.command, 'some command');
    strictEqual(data.outcome, outcome);
    strictEqual(data.details, undefined);
  }

  strictEqual(entries.length, 6);
});

test('logJudgeOutcome stores details when provided', () => {
  const { pi, entries } = createFakePi();
  const details = { summary: 's', affectedPaths: 'a', reason: 'r' };
  logJudgeOutcome(pi, 'allowed', 'cmd', details);

  const data = entries[0]!.data as { details?: typeof details };
  deepStrictEqualFix(data.details, details);
});

function deepStrictEqualFix(actual: unknown, expected: unknown) {
  strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

test('registerVerdictRenderer renderer returns undefined for missing data and the verdict line collapsed', () => {
  const { pi, renderers } = createFakePi();
  registerVerdictRenderer(pi);

  const renderer = renderers.get(VERDICT_ENTRY_TYPE)!;
  strictEqual(
    renderer({ type: 'custom', customType: VERDICT_ENTRY_TYPE } as CustomEntry, { expanded: false }, identityTheme),
    undefined,
  );

  const entry = {
    type: 'custom',
    customType: VERDICT_ENTRY_TYPE,
    data: { text: 'pi-gate: Allowed bash command.', command: 'cmd', outcome: 'allowed' as const },
  } as CustomEntry;
  const component = renderer(entry, { expanded: false }, identityTheme);
  ok(component);
  const lines = renderToLines(component);
  strictEqual(lines.length, 1);
  strictEqual(lines[0], 'pi-gate: Allowed bash command.');
});

test('registerVerdictRenderer expanded output includes summary, paths, reason, and command', () => {
  const { pi, renderers } = createFakePi();
  registerVerdictRenderer(pi);
  const renderer = renderers.get(VERDICT_ENTRY_TYPE)!;

  const entry = {
    type: 'custom',
    customType: VERDICT_ENTRY_TYPE,
    data: {
      text: 'pi-gate: Denied bash command.',
      command: 'rm -rf /',
      outcome: 'denied' as const,
      details: { summary: 'Deletes everything.', affectedPaths: '/', reason: 'Destructive.' },
    },
  } as CustomEntry;

  const component = renderer(entry, { expanded: true }, identityTheme);
  ok(component);
  const lines = renderToLines(component);
  strictEqual(lines[0], 'pi-gate: Denied bash command.');
  ok(lines.includes('SUMMARY: Deletes everything.'));
  ok(lines.includes('AFFECTED PATHS: /'));
  ok(lines.includes('REASON: Destructive.'));
  ok(lines.includes('COMMAND: rm -rf /'));
});
