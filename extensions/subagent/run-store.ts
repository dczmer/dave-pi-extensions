/**
 * On-disk run directory management for persisted child sessions.
 *
 * Every subagent run gets a directory under the runs root; the child pi
 * process stores its session file(s) inside (pi groups session files by
 * cwd beneath --session-dir). Directories older than RUNS_RETENTION_DAYS
 * are swept once per extension load.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/** Run directories older than this are deleted on extension load. */
export const RUNS_RETENTION_DAYS = 7;

/** Env var overriding the runs root (tests use it to stay in tempfs). */
export const RUNS_DIR_ENV = 'PI_SUBAGENT_RUNS_DIR';

/** Resolve the runs root: env override, else ~/.pi/agent/subagent-runs. */
export function resolveRunsRoot(env: NodeJS.ProcessEnv): string {
  return env[RUNS_DIR_ENV] ?? path.join(getAgentDir(), 'subagent-runs');
}

function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Create `<root>/<yyyymmdd-hhmmss>-<agent>-<rand>` with 0700 and return its path. */
export function createRunDir(root: string, agentName: string, now: Date = new Date()): string {
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const rand = Math.random().toString(36).slice(2, 8);
  const dir = path.join(root, `${timestamp(now)}-${safeName}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Delete run directories older than `maxAgeDays`, keyed by the timestamp
 * prefix in the directory name (immune to mtime changes from late writes).
 * Best-effort: unreadable entries and races with concurrent sweeps are
 * ignored. Returns the removed directory names.
 */
export function sweepOldRuns(root: string, maxAgeDays: number = RUNS_RETENTION_DAYS, now: Date = new Date()): string[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(entry.name);
    if (!m) continue;
    const dirDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (dirDate.getTime() >= cutoff) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      /* concurrent sweep or locked file — leave it */
    }
  }
  return removed;
}
