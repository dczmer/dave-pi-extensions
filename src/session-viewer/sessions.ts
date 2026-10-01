/**
 * Session discovery: load all sessions under a sessions root and group them
 * into per-cwd folders sorted by recency.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';

/** A folder of sessions, grouped by their cwd. */
export interface SessionFolder {
  /** Working directory that groups this folder (`<no cwd>` for old sessions). */
  cwd: string;
  /** Session summaries in the folder, most recently modified first. */
  sessions: SessionInfo[];
}

/**
 * Load all sessions under a sessions root, grouped into per-cwd folders.
 *
 * pi's `SessionManager.listAll(sessionDir)` only globs top-level `*.jsonl`
 * files in the given directory and does not recurse, so the root is scanned
 * one level here: each subdirectory is a per-cwd folder and the root itself
 * may hold sessions directly. File parsing stays in pi's listAll so the
 * viewer never re-implements session-file semantics.
 *
 * @param root - Root session directory (e.g. `~/.pi/agent/sessions`).
 * @returns Folders sorted by newest modification (desc), each with sessions
 *   sorted by most recently modified first.
 */
export async function loadSessionFolders(root: string): Promise<SessionFolder[]> {
  const infos: SessionInfo[] = [];
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of dirents) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const dir = join(root, entry.name);
    try {
      if (entry.isSymbolicLink() && !statSync(dir).isDirectory()) {
        continue;
      }
      infos.push(...(await SessionManager.listAll(dir)));
    } catch {
      // Unreadable directory or dangling symlink: skip.
    }
  }
  // Sessions stored directly in the root (e.g. sessions with an empty cwd).
  try {
    infos.push(...(await SessionManager.listAll(root)));
  } catch {
    // Root itself is unreadable: return what was gathered above.
  }

  const byCwd = new Map<string, SessionInfo[]>();
  for (const info of infos) {
    const key = info.cwd || '<no cwd>';
    const list = byCwd.get(key);
    if (list) {
      list.push(info);
    } else {
      byCwd.set(key, [info]);
    }
  }
  const folders: SessionFolder[] = [];
  for (const [cwd, sessions] of byCwd) {
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    folders.push({ cwd, sessions });
  }
  folders.sort((a, b) => latestOf(b) - latestOf(a));
  return folders;
}

/**
 * Newest modification time of a folder.
 * @param folder - Session folder.
 * @returns Milliseconds since epoch of the folder's newest session.
 */
function latestOf(folder: SessionFolder): number {
  const newest = folder.sessions[0];
  return newest ? newest.modified.getTime() : 0;
}
