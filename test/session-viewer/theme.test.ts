import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { loadViewerTheme } from '../../src/session-viewer/theme.ts';
import { withTempDir } from '../utils/temp-dir.ts';

/** Write a theme JSON file into the temp dir and return its path. */
function writeTheme(dir: string, name: string, theme: Record<string, unknown>): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(theme));
  return path;
}

test('loadViewerTheme renders truecolor codes for hex values', () => {
  withTempDir('sv-theme-', (dir) => {
    const path = writeTheme(dir, 'hex', {
      name: 'hex-theme',
      colors: { text: '#dddddd', selectedBg: '#203040' },
    });
    const theme = loadViewerTheme(path);
    assert.strictEqual(theme.name, 'hex-theme');
    assert.strictEqual(theme.fg('text', 'x'), '\x1b[38;2;221;221;221mx\x1b[39m');
    assert.strictEqual(theme.bg('selectedBg', 'x'), '\x1b[48;2;32;48;64mx\x1b[49m');
  });
});

test('loadViewerTheme resolves var references and passes through 256-color indices', () => {
  withTempDir('sv-theme-', (dir) => {
    const path = writeTheme(dir, 'vars', {
      vars: { base: '#102030', accent2: '#ff8000' },
      colors: {
        muted: 'base',
        accent: 'accent2',
        dim: 240,
      },
    });
    const theme = loadViewerTheme(path);
    assert.strictEqual(theme.fg('muted', 'x'), '\x1b[38;2;16;32;48mx\x1b[39m');
    assert.strictEqual(theme.fg('accent', 'x'), '\x1b[38;2;255;128;0mx\x1b[39m');
    assert.strictEqual(theme.fg('dim', 'x'), '\x1b[38;5;240mx\x1b[39m');
    // Theme name defaults to the file name without extension.
    assert.strictEqual(theme.name, 'vars');
  });
});

test('loadViewerTheme applies search-match fallbacks from the Theme constructor', () => {
  withTempDir('sv-theme-', (dir) => {
    const path = writeTheme(dir, 'fallback', {
      colors: { text: '#dddddd', selectedBg: '#203040' },
    });
    const theme = loadViewerTheme(path);
    // searchMatchText falls back to text; searchMatchBg falls back to selectedBg.
    assert.strictEqual(theme.fg('searchMatchText', 'x'), theme.fg('text', 'x'));
    assert.strictEqual(theme.bg('searchMatchBg', 'x'), theme.bg('selectedBg', 'x'));
  });
});

test('loadViewerTheme throws for unknown and circular variable references', () => {
  withTempDir('sv-theme-', (dir) => {
    const unknown = writeTheme(dir, 'unknown', { colors: { text: 'missing-var' } });
    assert.throws(() => loadViewerTheme(unknown), /Variable reference not found: missing-var/);

    const circular = writeTheme(dir, 'circular', {
      vars: { a: 'b', b: 'a' },
      colors: { text: 'a' },
    });
    assert.throws(() => loadViewerTheme(circular), /Circular variable reference/);
  });
});

test('loadViewerTheme throws for unreadable files and missing colors sections', () => {
  withTempDir('sv-theme-', (dir) => {
    assert.throws(() => loadViewerTheme(join(dir, 'nope.json')), /Could not load theme/);
    const noColors = writeTheme(dir, 'no-colors', { name: 'no-colors' });
    assert.throws(() => loadViewerTheme(noColors), /no colors section/);
  });
});
