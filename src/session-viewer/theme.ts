/**
 * Minimal truecolor theme loader for the session viewer.
 *
 * pi-coding-agent exports the `Theme` class but not `loadThemeFromPath`, so
 * this re-implements only what a viewer needs: JSON parsing, `vars`
 * indirection, and the fg/bg key split. Fallback chains (searchMatch*,
 * scrollbar*, thinkingMax) are applied by the Theme constructor itself.
 *
 * Only truecolor output is supported: `#rrggbb` values render as
 * `38;2;r;g;b` / `48;2;r;g;b` ANSI codes and 256-color indices render as-is.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { Theme } from '@earendil-works/pi-coding-agent';

/** Keys that are background colors in pi themes (mirrors pi's theme loader). */
const BG_KEYS = new Set([
  'selectedBg',
  'searchMatchBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
]);

/** Shape of a pi theme JSON file (the subset the viewer uses). */
interface ThemeJson {
  name?: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
}

/** Theme constructor color-map parameter types (kept via ConstructorParameters to avoid re-declaring pi's color-key unions). */
type ThemeFgColors = NonNullable<ConstructorParameters<typeof Theme>[0]>;
type ThemeBgColors = NonNullable<ConstructorParameters<typeof Theme>[1]>;

/**
 * Resolve one theme color value against the vars map, following indirections.
 * @param value - Raw value: hex string, 256-color index, empty string, or var name.
 * @param vars - Variable name -> value map from the theme file.
 * @param visited - Variable names already on the resolution path (cycle guard).
 * @returns The resolved color value.
 * @throws {Error} On circular references or unknown variable names.
 */
function resolveValue(
  value: string | number,
  vars: Record<string, string | number>,
  visited: Set<string>,
): string | number {
  if (typeof value === 'number' || value === '' || value.startsWith('#')) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  const referenced = vars[value];
  if (referenced === undefined) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveValue(referenced, vars, visited);
}

/**
 * Load a pi theme JSON file and construct a truecolor Theme.
 *
 * @param path - Path to the theme `.json` file.
 * @returns A Theme whose fg()/bg() methods emit truecolor ANSI codes.
 * @throws {Error} If the file is unreadable, lacks a colors section, or references unknown/circular variables.
 */
export function loadViewerTheme(path: string): Theme {
  let json: ThemeJson;
  try {
    json = JSON.parse(readFileSync(path, 'utf-8')) as ThemeJson;
  } catch (err) {
    throw new Error(`Could not load theme ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (!json || typeof json !== 'object' || !json.colors) {
    throw new Error(`Theme ${path} has no colors section`);
  }
  const vars = json.vars ?? {};
  const fgColors: Record<string, string | number> = {};
  const bgColors: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(json.colors)) {
    const resolved = resolveValue(value, vars, new Set());
    if (BG_KEYS.has(key)) {
      bgColors[key] = resolved;
    } else {
      fgColors[key] = resolved;
    }
  }
  // The Theme constructor resolves fallback chains (scrollbarTrack <- muted,
  // scrollbarThumb/searchMatchText <- text, thinkingMax <- thinkingXhigh,
  // searchMatchBg <- selectedBg) and throws on undefined values, so every
  // anchor those chains read must be present. Real themes define them all;
  // fill in neutral defaults so partial themes still load.
  const text = fgColors.text ?? '#cccccc';
  fgColors.text = text;
  fgColors.muted ??= text;
  fgColors.thinkingXhigh ??= text;
  bgColors.selectedBg ??= '#333333';
  return new Theme(fgColors as ThemeFgColors, bgColors as ThemeBgColors, 'truecolor', {
    name: json.name ?? basename(path, '.json'),
    sourcePath: path,
  });
}
