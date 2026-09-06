import { strictEqual } from 'node:assert';
import { test, mock } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import contextUsageBar, {
  renderProgressBar,
  formatTokens,
  renderGateIndicator,
} from '../../../extensions/context-usage-bar.ts';
import {
  markPiGateLoaded,
  resetPiGateLoaded,
  resetSessionState,
  setBashEnabled,
  setExternalEnabled,
} from '../../../extensions/pi-gate/session.ts';
import { createExtensionContext } from '../../utils/pi-context.ts';

function mockTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
  };
}

test('renderProgressBar returns empty string when width < 1', () => {
  const theme = mockTheme();
  strictEqual(renderProgressBar(0, 100, 0, theme), '');
});

test('renderProgressBar at 0% shows empty track inside border brackets', () => {
  const theme = mockTheme();
  const result = renderProgressBar(0, 100, 5, theme);
  strictEqual(result, '<border>[</border>     <border>]</border>');
});

test('renderProgressBar at 100% shows all filled blocks inside border brackets', () => {
  const theme = mockTheme();
  const result = renderProgressBar(100, 100, 5, theme);
  strictEqual(result, '<border>[</border><success>█████</success><border>]</border>');
});

test('renderProgressBar at 50% shows half filled with space track remainder', () => {
  const theme = mockTheme();
  const result = renderProgressBar(50, 100, 10, theme);
  // 50% of 10 = 5.0 exact, partial = 0 -> space track char
  strictEqual(result, '<border>[</border><success>█████</success>     <border>]</border>');
});

test('renderProgressBar uses partial block for non-integer fills', () => {
  const theme = mockTheme();
  const result = renderProgressBar(37, 100, 10, theme);
  // 37% of 10 = 3.7, filledFull = 3, partial = floor(0.7*8)=5 -> BAR_CHARS[5]='▋'
  strictEqual(result, '<border>[</border><success>███</success><success>▋</success>      <border>]</border>');
});

test('renderProgressBar uses warning color at yellow threshold', () => {
  const theme = mockTheme();
  const result = renderProgressBar(80_000, 100_000, 10, theme);
  strictEqual(result.includes('<warning>'), true);
  strictEqual(result.includes('<success>'), false);
  strictEqual(result.includes('<error>'), false);
});

test('renderProgressBar uses error color at red threshold', () => {
  const theme = mockTheme();
  const result = renderProgressBar(120_000, 120_000, 10, theme);
  strictEqual(result.includes('<error>'), true);
  strictEqual(result.includes('<success>'), false);
  strictEqual(result.includes('<warning>'), false);
});

test('formatTokens leaves small numbers unchanged', () => {
  strictEqual(formatTokens(0), '0');
  strictEqual(formatTokens(500), '500');
  strictEqual(formatTokens(999), '999');
});

test('formatTokens formats thousands with k suffix', () => {
  strictEqual(formatTokens(1000), '1.0k');
  strictEqual(formatTokens(1500), '1.5k');
  strictEqual(formatTokens(999999), '1000.0k');
});

test('formatTokens formats millions with M suffix', () => {
  strictEqual(formatTokens(1_000_000), '1.0M');
  strictEqual(formatTokens(2_500_000), '2.5M');
});

test('renderGateIndicator colors the letter success when enabled', () => {
  const theme = mockTheme();
  const result = renderGateIndicator('B', true, theme as never);
  strictEqual(result, '<border>|</border> <success>B</success> ');
  strictEqual(result.startsWith('<border>|</border>'), true);
});

test('renderGateIndicator colors the letter error when disabled', () => {
  const theme = mockTheme();
  const result = renderGateIndicator('E', false, theme as never);
  strictEqual(result, '<border>|</border> <error>E</error> ');
});

interface FakePi {
  pi: ExtensionAPI;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>;
  events: { emit: ReturnType<typeof mock.fn>; on: ReturnType<typeof mock.fn> };
}

/** Build a minimal ExtensionAPI stub capturing `on` handlers and the events bus. */
function createFakePi(): FakePi {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const events = {
    emit: mock.fn(),
    on: mock.fn(() => () => {}),
  };
  const pi = {
    registerCommand: mock.fn(),
    on: mock.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
      handlers.set(event, handler);
    }),
    events,
  } as unknown as ExtensionAPI;
  return { pi, handlers, events };
}

interface RenderOptions {
  piGateLoaded?: boolean;
  bashEnabled?: boolean;
  externalEnabled?: boolean;
  withUsage?: boolean;
}

/**
 * Run the extension's session_start handler, capture the footer installed via
 * setFooter, and render one footer line at a generous width (no truncation).
 */
async function renderFooterLine(opts: RenderOptions): Promise<string> {
  resetSessionState();
  resetPiGateLoaded();
  if (opts.piGateLoaded) markPiGateLoaded();
  if (opts.bashEnabled === false) setBashEnabled(false);
  if (opts.externalEnabled === false) setExternalEnabled(false);

  const withUsage = opts.withUsage !== false;
  const ctx = createExtensionContext({
    getContextUsage: mock.fn(() => (withUsage ? { tokens: 40_000, contextWindow: 120_000, percent: 33 } : undefined)),
    model: (withUsage ?
      { id: 'test-model', provider: 'test-provider', contextWindow: 120_000 }
    : undefined) as ExtensionContext['model'],
  });

  const { pi, handlers } = createFakePi();
  contextUsageBar(pi);
  await handlers.get('session_start')!({}, ctx);

  const setFooter = ctx.ui.setFooter as unknown as ReturnType<typeof mock.fn>;
  const factory = setFooter.mock.calls[0]!.arguments[0] as (
    tui: unknown,
    theme: unknown,
    footerData: unknown,
  ) => { render(width: number): string[] };
  const component = factory({ requestRender: mock.fn() }, mockTheme(), {
    onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map(),
    getGitBranch: () => null,
    getAvailableProviderCount: () => 0,
  });
  return component.render(400)[0]!;
}

function resetGateState() {
  resetSessionState();
  resetPiGateLoaded();
}

test('footer omits gate indicators when pi-gate is not loaded', async (t) => {
  t.after(resetGateState);
  const line = await renderFooterLine({ piGateLoaded: false });
  strictEqual(line.includes('<success>B</success>'), false);
  strictEqual(line.includes('33%'), true);
});

test('footer shows both gate indicators with success letters when pi-gate is loaded', async (t) => {
  t.after(resetGateState);
  const line = await renderFooterLine({ piGateLoaded: true });
  strictEqual(
    line.includes(
      '<border>|</border> <success>B</success> <border>|</border> <success>E</success> <border>|</border>',
    ),
    true,
  );
  strictEqual(line.includes('33%'), true);
});

test('footer flips the B indicator to error when the bash guard is disabled', async (t) => {
  t.after(resetGateState);
  const line = await renderFooterLine({ piGateLoaded: true, bashEnabled: false });
  strictEqual(line.includes('<error>B</error> '), true);
  strictEqual(line.includes('<success>E</success> '), true);
});

test('footer flips the E indicator to error when the external guard is disabled', async (t) => {
  t.after(resetGateState);
  const line = await renderFooterLine({ piGateLoaded: true, externalEnabled: false });
  strictEqual(line.includes('<success>B</success> '), true);
  strictEqual(line.includes('<error>E</error> '), true);
});

test('footer renders gate indicators even without context usage', async (t) => {
  t.after(resetGateState);
  const line = await renderFooterLine({ piGateLoaded: true, withUsage: false });
  strictEqual(line.startsWith('<border>|</border> <success>B</success> '), true);
  strictEqual(line.includes('%'), false); // no context bar, indicators only
});

test('footer subscribes to pi-gate:toggled re-render events and disposes cleanly', async (t) => {
  t.after(resetGateState);
  resetSessionState();
  resetPiGateLoaded();
  markPiGateLoaded();

  const ctx = createExtensionContext();
  const { pi, handlers, events } = createFakePi();
  contextUsageBar(pi);
  await handlers.get('session_start')!({}, ctx);

  const setFooter = ctx.ui.setFooter as unknown as ReturnType<typeof mock.fn>;
  const factory = setFooter.mock.calls[0]!.arguments[0] as (
    tui: { requestRender: ReturnType<typeof mock.fn> },
    theme: unknown,
    footerData: unknown,
  ) => { dispose(): void; render(width: number): string[] };
  const requestRender = mock.fn();
  const component = factory({ requestRender }, mockTheme(), {
    onBranchChange: () => () => {},
    getExtensionStatuses: () => new Map(),
    getGitBranch: () => null,
  });

  strictEqual(events.on.mock.calls.length, 1);
  strictEqual(events.on.mock.calls[0]!.arguments[0], 'pi-gate:toggled');

  // Invoking the subscribed handler requests a re-render.
  const subscribed = events.on.mock.calls[0]!.arguments[1] as () => void;
  subscribed();
  strictEqual(requestRender.mock.calls.length, 1);

  component.dispose();
});
