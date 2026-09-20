import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

/** A named prompt fragment from prompt-fragments.json. */
export interface PromptFragment {
  name: string;
  prompt: string;
}

/** Fragment lists keyed by the action that consumes them. */
export interface FragmentLists {
  prepend: PromptFragment[];
  append: PromptFragment[];
}

/** Fragments load result: valid fragments plus non-fatal problems found. */
export interface LoadFragmentsResult {
  fragments: FragmentLists;
  warnings: string[];
}

const FRAGMENTS_FILE = 'prompt-fragments.json';

/** Absolute path to the fragments config file. */
export function fragmentsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, FRAGMENTS_FILE);
}

/** Validate one mode's raw list, skipping malformed entries and duplicate names. */
function parseList(rawList: unknown, label: string, warnings: string[]): PromptFragment[] {
  if (rawList === undefined) return [];
  if (!Array.isArray(rawList)) {
    warnings.push(`"${label}" is not an array`);
    return [];
  }
  const fragments: PromptFragment[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of rawList) {
    const name = (entry as { name?: unknown })?.name;
    const prompt = (entry as { prompt?: unknown })?.prompt;
    if (typeof name !== 'string' || typeof prompt !== 'string' || name.trim() === '' || prompt.trim() === '') {
      skipped++;
      continue;
    }
    if (seen.has(name)) {
      skipped++;
      continue;
    }
    seen.add(name);
    fragments.push({ name, prompt });
  }
  if (skipped > 0) warnings.push(`${label}: ${skipped} malformed/duplicate fragment(s) skipped`);
  return fragments;
}

/** Validate raw parsed JSON: an object with independent prepend/append lists. */
export function parseFragments(raw: unknown): LoadFragmentsResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { fragments: { prepend: [], append: [] }, warnings: ['top-level value is not an object'] };
  }
  const record = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const prepend = parseList(record.prepend, 'prepend', warnings);
  const append = parseList(record.append, 'append', warnings);
  return { fragments: { prepend, append }, warnings };
}

/** Load fragments from disk; a missing file is not an error. */
export function loadFragments(agentDir: string = getAgentDir()): LoadFragmentsResult {
  const path = fragmentsPath(agentDir);
  if (!existsSync(path)) return { fragments: { prepend: [], append: [] }, warnings: [] };
  try {
    return parseFragments(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    return { fragments: { prepend: [], append: [] }, warnings: [`failed to parse ${path}: ${String(err)}`] };
  }
}
