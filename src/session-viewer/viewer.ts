/**
 * TUI shell for the session viewer.
 *
 * A fixed-width bordered session tree on the left (j/k to navigate, enter to
 * open) and a transcript scroll view on the right. Arrow keys, space, j/k
 * (when the tree pane is not focused), and pageUp/pageDown scroll the
 * transcript; 'gg' jumps to the top and shift+G to the bottom. The
 * alt-screen's built-in search opens with '/'
 * (ctrl+shift+f as an alternative); enter/shift+enter navigate matches, esc
 * closes it. tab toggles tree/transcript focus, z toggles detail meta
 * entries, and q or ctrl+c quits.
 */

import {
  HStack,
  ScrollView,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiAltScreen,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import type { SessionInfo, Theme } from '@earendil-works/pi-coding-agent';

import type { SessionFolder } from './sessions.ts';
import { getRenderedTranscript } from './transcript.ts';

/** Fixed width (columns) of the session tree pane. */
export const TREE_PANE_WIDTH = 34;

/** Milliseconds window in which a second 'g' completes the 'gg' chord. */
const GG_CHORD_TIMEOUT_MS = 800;

/** Lines of overlap between pages (matches TuiAltScreen's pageUp/pageDown). */
const PAGE_SCROLL_OVERLAP = 4;

/** One navigable row in the session tree. */
export type TreeRow = { kind: 'folder'; cwd: string } | { kind: 'session'; info: SessionInfo };

/**
 * Left pane: a bordered list of session folders and sessions.
 *
 * j/k moves the cursor (skipping folder rows), enter opens the session under
 * the cursor, and the visible window stays centered on the cursor.
 */
export class SessionTreePane implements Component, Focusable {
  focused = false;

  private rows: TreeRow[];
  private cursor = 0;
  private theme: Theme;
  private getVisibleRows: () => number;
  private openSession: (info: SessionInfo) => void;

  constructor(
    folders: SessionFolder[],
    theme: Theme,
    getVisibleRows: () => number,
    openSession: (info: SessionInfo) => void,
  ) {
    this.theme = theme;
    this.getVisibleRows = getVisibleRows;
    this.openSession = openSession;
    this.rows = [];
    for (const folder of folders) {
      this.rows.push({ kind: 'folder', cwd: folder.cwd });
      for (const info of folder.sessions) {
        this.rows.push({ kind: 'session', info });
      }
    }
    const firstSession = this.rows.findIndex((row) => row.kind === 'session');
    if (firstSession >= 0) this.cursor = firstSession;
  }

  invalidate(): void {}

  /** j/k move the cursor; enter opens the session under the cursor. */
  handleInput(data: string): void {
    if (!this.focused) return;
    if (data === 'k') {
      this.moveCursor(-1);
    } else if (data === 'j') {
      this.moveCursor(1);
    } else if (data === '\r') {
      const row = this.rows[this.cursor];
      if (row && row.kind === 'session') this.openSession(row.info);
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const visible = Math.max(1, this.getVisibleRows());
    const start = clampWindowStart(this.cursor, visible, this.rows.length);
    const lines: string[] = [this.renderBorderTop(inner)];
    for (let i = 0; i < visible; i++) {
      const row = this.rows[start + i];
      lines.push(`│${padTo(row ? this.renderRow(row, start + i, inner) : '', inner)}│`);
    }
    lines.push(`└${'─'.repeat(inner)}┘`);
    return lines;
  }

  private renderBorderTop(inner: number): string {
    if (inner < 4) return `┌${'─'.repeat(inner - 2)}┐`;
    const title = truncateToWidth(this.theme.bold(this.theme.fg('accent', 'sessions')), inner - 2);
    return `┌${title}${'─'.repeat(Math.max(0, inner - 2 - visibleWidth(title)))}┐`;
  }

  private renderRow(row: TreeRow, index: number, inner: number): string {
    if (row.kind === 'folder') {
      const label = truncateToWidth(`▸ ${row.cwd}`, Math.max(1, inner - 1));
      return padTo(this.theme.bold(this.theme.fg('accent', label)), inner);
    }
    const label = row.info.name ?? row.info.id.slice(0, 8);
    const date = row.info.modified.toISOString().slice(5, 16).replace('T', ' ');
    const text = truncateToWidth(`${label}  ${date}`, Math.max(1, inner - 2));
    const line = ` ${text}`;
    if (this.focused && index === this.cursor) {
      return this.theme.bg('selectedBg', this.theme.fg('text', padTo(line, inner)));
    }
    return padTo(line, inner);
  }

  private moveCursor(delta: number): void {
    let next = this.cursor + delta;
    while (next >= 0 && next < this.rows.length) {
      const row = this.rows[next];
      if (row && row.kind === 'session') {
        this.cursor = next;
        return;
      }
      next += delta;
    }
  }
}

/**
 * Wires the session tree pane and transcript scroll view into the
 * alt-screen TUI and owns the global key handling.
 */
export class App {
  private tui: TuiAltScreen;
  private theme: Theme;
  private treePane: SessionTreePane;
  private transcriptScroll: ScrollView;
  private transcriptText: Text;
  private current: SessionInfo | null = null;
  private showMeta = true;
  private unsubscribeInput?: () => void;
  private offResize?: () => void;
  /** Timestamp of the first 'g' in an in-flight 'gg' chord, if any. */
  private pendingG: number | null = null;

  constructor(tui: TuiAltScreen, theme: Theme, folders: SessionFolder[]) {
    this.tui = tui;
    this.theme = theme;
    this.treePane = new SessionTreePane(
      folders,
      theme,
      () => Math.max(1, tui.terminal.rows - 2),
      (info) => this.openSession(info),
    );
    this.transcriptText = new Text('');
    this.transcriptScroll = new ScrollView(this.transcriptText, { primary: true, scrollbar: 'auto' });
    const root = new HStack(
      [
        { component: this.treePane, basis: TREE_PANE_WIDTH },
        { component: this.transcriptScroll, grow: 1 },
      ],
      { gap: 1 },
    );
    tui.setLayoutRoot(root);
    tui.setFocus(this.treePane);
    this.unsubscribeInput = tui.addInputListener(this.handleInput);
    const onResize = () => this.refreshTranscript();
    process.stdout.on('resize', onResize);
    this.offResize = () => process.stdout.removeListener('resize', onResize);
    const first = folders[0]?.sessions[0];
    if (first) this.openSession(first);
  }

  /** Open a session in the transcript pane and reset its scroll position to the top. */
  openSession(info: SessionInfo): void {
    this.current = info;
    this.refreshTranscript();
    this.transcriptScroll.scrollToStart();
  }

  /**
   * Rebuild the transcript text for the current session, meta flag, and
   * current terminal width.
   */
  refreshTranscript(): void {
    if (!this.current) return;
    const contentWidth = Math.max(1, this.tui.terminal.columns - TREE_PANE_WIDTH - 1 - 2);
    const lines = getRenderedTranscript(this.current.path, contentWidth, this.showMeta, this.theme, this.current.name);
    this.transcriptText.setText(lines.join('\n'));
    this.tui.requestRender();
  }

  /** Remove listeners (call before stopping the TUI). */
  dispose(): void {
    this.unsubscribeInput?.();
    this.offResize?.();
  }

  private handleInput: TuiInputListener = (data) => {
    // While search (or any overlay) is open, let it handle everything so
    // query text like 'q'/'z' still reaches the search editor.
    if (this.tui.hasOverlay()) {
      this.pendingG = null;
      return undefined;
    }
    if (data === 'q' || matchesKey(data, 'ctrl+c')) {
      this.dispose();
      this.tui.stop();
      return { consume: true };
    }
    if (data === 'z') {
      this.showMeta = !this.showMeta;
      this.refreshTranscript();
      return { consume: true };
    }
    if (data === '\t') {
      const focused = this.tui.getFocusedComponent();
      this.tui.setFocus(focused === this.treePane ? null : this.treePane);
      return { consume: true };
    }
    // Arrow keys scroll the transcript in either focus mode.
    if (matchesKey(data, 'up')) {
      this.tui.scrollBy(-1);
      return { consume: true };
    }
    if (matchesKey(data, 'down')) {
      this.tui.scrollBy(1);
      return { consume: true };
    }
    // space pages down; shift+G jumps to the end; 'gg' jumps to the top.
    if (matchesKey(data, 'space')) {
      this.tui.scrollBy(Math.max(1, this.tui.terminal.rows - PAGE_SCROLL_OVERLAP));
      return { consume: true };
    }
    if (data === 'G' || matchesKey(data, 'shift+g')) {
      this.tui.scrollToBottom();
      return { consume: true };
    }
    if (matchesKey(data, 'g')) {
      if (this.pendingG !== null && Date.now() - this.pendingG <= GG_CHORD_TIMEOUT_MS) {
        this.pendingG = null;
        this.tui.scrollToTop();
      } else {
        this.pendingG = Date.now();
      }
      return { consume: true };
    }
    if (this.pendingG !== null) {
      // Any other key cancels an in-flight 'gg' chord.
      this.pendingG = null;
    }
    // j/k scroll the transcript when the tree pane is not focused (the tree
    // pane itself consumes j/k for cursor movement while focused).
    if (this.tui.getFocusedComponent() !== this.treePane) {
      if (data === 'j') {
        this.tui.scrollBy(1);
        return { consume: true };
      }
      if (data === 'k') {
        this.tui.scrollBy(-1);
        return { consume: true };
      }
    }
    return undefined;
  };
}

/** Center a cursor within a sliding window over a row list. */
function clampWindowStart(cursor: number, visible: number, total: number): number {
  const maxStart = Math.max(0, total - visible);
  const ideal = cursor - Math.floor(visible / 2);
  return Math.min(maxStart, Math.max(0, ideal));
}

/** Pad a line with spaces up to exactly `width` visible columns. */
function padTo(line: string, width: number): string {
  const remaining = width - visibleWidth(line);
  return remaining > 0 ? line + ' '.repeat(remaining) : line;
}
