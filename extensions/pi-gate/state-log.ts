/**
 * Cross-process session-state log for pi-gate.
 *
 * Subagents run as separate `pi` processes, so the globalThis singleton in
 * session.ts cannot share approvals/toggles with them. This module persists
 * session state as an append-only JSONL log in $TMPDIR, keyed by project cwd,
 * and lets every pi-gate process (main agent, subagent children, sibling
 * sessions in the same project) write-through and lazily refresh from it.
 *
 * Appends use O_APPEND (atomic for record-sized writes), so no lock file is
 * needed. Readers cache by mtime/size and re-read only appended bytes.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** One line in the state log. */
export interface StateLogRecord {
  v: 1;
  op: 'init' | 'approve-bash' | 'approve-external' | 'toggle';
  ts: number;
  pid: number;
  /** Pattern for approve-* ops. */
  pattern?: string;
  /** Guard name for toggle ops. */
  guard?: 'bash' | 'external';
  /** New value for toggle ops. */
  enabled?: boolean;
}

/** Replayed view of the shared log (last toggle wins). */
export interface LogView {
  bash: Set<string>;
  external: Set<string>;
  bashEnabled: boolean | undefined;
  externalEnabled: boolean | undefined;
}

/** Live reader/writer handle for one state log file; cached on globalThis. */
interface StateLogHandle {
  file: string;
  offset: number;
  mtimeMs: number;
  /** Trailing partial line from the previous read (concurrent writer mid-append). */
  pending: string;
  view: LogView;
}

const HANDLE_KEY = Symbol.for('pi-gate:state-log');
const OVERRIDE_KEY = Symbol.for('pi-gate:state-log-override');

/** Env var exporting the state file path to spawned subagent children. */
export const STATE_FILE_ENV = 'PI_GATE_STATE_FILE';

/** Fresh replay view with no approvals and no recorded toggles. */
function emptyView(): LogView {
  return { bash: new Set(), external: new Set(), bashEnabled: undefined, externalEnabled: undefined };
}

function getHandle(): StateLogHandle | undefined {
  return (globalThis as Record<symbol, StateLogHandle | undefined>)[HANDLE_KEY];
}

function setHandle(h: StateLogHandle | undefined): void {
  (globalThis as Record<symbol, StateLogHandle | undefined>)[HANDLE_KEY] = h;
}

/**
 * Override the state file location (tests only; mirrors
 * setConfigResultOverride in session.ts). Production always leaves this unset.
 */
export function setStateLogOverride(file: string | undefined): void {
  (globalThis as Record<symbol, string | undefined>)[OVERRIDE_KEY] = file;
  setHandle(undefined); // force re-init at the new location
}

/** Configured override, if any. */
function getOverride(): string | undefined {
  return (globalThis as Record<symbol, string | undefined>)[OVERRIDE_KEY];
}

/** State file path inherited from a parent pi process via env, if any. */
function getInheritedStateFile(): string | undefined {
  return process.env[STATE_FILE_ENV];
}

/** Resolve the state file path: override → inherited env → cwd-keyed tmpdir. */
export function resolveStateFile(cwd: string): string {
  const override = getOverride();
  if (override) return override;
  const inherited = getInheritedStateFile();
  if (inherited) return inherited;
  const hash = createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(tmpdir(), `pi-gate-${hash}`, 'state.jsonl');
}

/** True when pid is not running (ESRCH); conservatively false on EPERM/other. */
function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Parse the log, skipping malformed lines. */
export function parseRecords(text: string): StateLogRecord[] {
  const records: StateLogRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as StateLogRecord;
      if (rec && rec.v === 1 && typeof rec.op === 'string') records.push(rec);
    } catch {
      // Skip malformed line (interrupted write, manual edit).
    }
  }
  return records;
}

/** Fold one record into a LogView. */
export function applyRecord(view: LogView, rec: StateLogRecord): void {
  switch (rec.op) {
    case 'approve-bash':
      if (rec.pattern) view.bash.add(rec.pattern);
      break;
    case 'approve-external':
      if (rec.pattern) view.external.add(rec.pattern);
      break;
    case 'toggle':
      if (rec.guard === 'bash') view.bashEnabled = rec.enabled;
      else if (rec.guard === 'external') view.externalEnabled = rec.enabled;
      break;
    case 'init':
      break; // metadata only
  }
}

/**
 * Initialize the shared state log for this project. Idempotent.
 *
 * A process that inherited PI_GATE_STATE_FILE (subagent child) adopts the file
 * and never truncates. A fresh process (no inherited env) truncates the log
 * when the recorded init pid is dead — this is what makes approvals expire
 * with the session tree while still allowing sibling live sessions to share.
 * Also exports PI_GATE_STATE_FILE so children spawned later inherit the path.
 *
 * Known limitation (accepted): reaping checks only the init record's pid, so
 * a fresh session started after the creator exited — but while a sibling
 * session that adopted the log is still alive — will truncate the log and
 * wipe that sibling's live approvals.
 *
 * @param cwd - Project directory (used for the cwd-keyed path when no
 *   override or inherited env var is set).
 * @param inherited - Whether this process inherited PI_GATE_STATE_FILE.
 *   Defaults to reading the env var; tests pass an explicit value so they
 *   never touch process.env.
 */
export function initSharedState(cwd: string, inherited = getInheritedStateFile() !== undefined): void {
  if (getHandle()) return;
  const file = resolveStateFile(cwd);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  if (!inherited && existsSync(file)) {
    const first = parseRecords(readFileSync(file, 'utf-8'))[0];
    if (first?.op === 'init' && typeof first.pid === 'number' && isPidDead(first.pid)) {
      writeFileSync(file, '', { mode: 0o600 }); // stale session: expire approvals
    }
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    appendRecordRaw(file, { v: 1, op: 'init', ts: Date.now(), pid: process.pid });
  }

  setHandle({ file, offset: 0, mtimeMs: 0, pending: '', view: emptyView() });
  refreshSharedState();

  if (!inherited && getOverride() === undefined) {
    process.env[STATE_FILE_ENV] = file; // bootstrap for future subagent children
  }
}

/** Append one raw record line (O_APPEND; concurrent writers are race-free). */
function appendRecordRaw(file: string, rec: StateLogRecord): void {
  appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** Whether the shared log is active in this process. */
export function isSharedStateActive(): boolean {
  return getHandle() !== undefined;
}

/**
 * Re-read appended bytes when the file changed; reset on truncation.
 * No-op when the shared log is not initialized.
 */
export function refreshSharedState(): void {
  const h = getHandle();
  if (!h) return;
  let st;
  try {
    st = statSync(h.file);
  } catch {
    return; // file vanished (e.g. tmp cleaner); keep current view
  }
  if (st.mtimeMs === h.mtimeMs && st.size === h.offset) return;
  if (st.size < h.offset) {
    h.view = emptyView();
    h.offset = 0;
    h.pending = '';
  }
  const buf = Buffer.alloc(st.size - h.offset);
  const fd = openSync(h.file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, h.offset);
  } finally {
    closeSync(fd);
  }
  const text = h.pending + buf.toString('utf-8');
  const lines = text.split('\n');
  h.pending = lines.pop() ?? '';
  for (const rec of parseRecords(lines.join('\n'))) applyRecord(h.view, rec);
  h.offset = st.size;
  h.mtimeMs = st.mtimeMs;
}

/** Merged shared view: refreshes and returns the log view (empty when inactive). */
export function getSharedView(): LogView {
  refreshSharedState();
  return getHandle()?.view ?? emptyView();
}

/**
 * Append one record write-through (no-op when the shared log is inactive).
 *
 * After the append we re-read from the cached offset instead of advancing it
 * arithmetically: another process may have appended in between, and its
 * record would land below our offset and be skipped forever. The re-read
 * applies foreign + own records in file order; re-applying our own record is
 * harmless (set-add and last-wins-toggle are idempotent). Probe-verified:
 * the arithmetic variant loses interleaved records, this one preserves them.
 */
export function persistRecord(rec: Omit<StateLogRecord, 'v' | 'ts' | 'pid'>): void {
  const h = getHandle();
  if (!h) return;
  appendRecordRaw(h.file, { v: 1, ts: Date.now(), pid: process.pid, ...rec });
  refreshSharedState();
}
