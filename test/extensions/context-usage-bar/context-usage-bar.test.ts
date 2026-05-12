import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { renderProgressBar, formatTokens } from '../../../extensions/context-usage-bar.ts';

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
