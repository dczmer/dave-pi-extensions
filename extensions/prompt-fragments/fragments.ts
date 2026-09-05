import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

/** A named prompt fragment from prompt-fragments.json. */
export interface PromptFragment {
  name: string;
  prompt: string;
}

/** Fragments load result: valid fragments plus non-fatal problems found. */
export interface LoadFragmentsResult {
  fragments: PromptFragment[];
  warnings: string[];
}

const FRAGMENTS_FILE = 'prompt-fragments.json';

/** Absolute path to the fragments config file. */
export function fragmentsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, FRAGMENTS_FILE);
}

/** Validate raw parsed JSON: skip malformed entries and duplicate names. */
export function parseFragments(raw: unknown): LoadFragmentsResult {
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { fragments: [], warnings: ['top-level value is not an array'] };
  }
  const fragments: PromptFragment[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of raw) {
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
  if (skipped > 0) warnings.push(`${skipped} malformed/duplicate fragment(s) skipped`);
  return { fragments, warnings };
}

/** Load fragments from disk; a missing file is not an error. */
export function loadFragments(agentDir: string = getAgentDir()): LoadFragmentsResult {
  const path = fragmentsPath(agentDir);
  if (!existsSync(path)) return { fragments: [], warnings: [] };
  try {
    return parseFragments(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    return { fragments: [], warnings: [`failed to parse ${path}: ${String(err)}`] };
  }
}
