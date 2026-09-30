import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { OptionAnswer, QuestionAnswer, QuestionOption } from './types.ts';

/** A menu row: either a model option or the always-on free-form entry. */
interface MenuRow {
  label: string;
  description?: string;
  isType: boolean;
}

/** Label for the built-in free-form entry. */
export const TYPE_RESPONSE_LABEL = 'Type a response';

/** Options passed to {@link createQuestionComponent}. */
export interface QuestionComponentOptions {
  /** Bold title shown at the top of the window. */
  title: string;
  /** Optional muted description shown under the title. */
  description?: string;
  /** The model-supplied options (the free-form entry is appended separately). */
  options: QuestionOption[];
  /** Whether to append the free-form "Type a response" entry. */
  allowOther: boolean;
  /** The active pi theme. */
  theme: Theme;
  /** The terminal UI (used to request re-renders). */
  tui: TUI;
  /** Called exactly once with the user's answer, or `null` if they cancelled. */
  done: (answer: QuestionAnswer) => void;
  /**
   * Injectable editor factory. Defaults to constructing a real pi-tui `Editor`.
   * Overridable in tests to drive the free-form flow without a terminal.
   */
  createEditor?: (tui: TUI, theme: EditorTheme) => Editor;
}

/** The interactive component returned by {@link createQuestionComponent}. */
export interface QuestionComponent {
  /** Render the component to terminal lines of the given width. */
  render(width: number): string[];
  /** Clear the render cache and schedule a re-render. */
  invalidate(): void;
  /** Handle a chunk of terminal input. */
  handleInput(data: string): void;
}

/** Build the display rows from model options, optionally appending the free-form entry. */
function buildRows(options: QuestionOption[], allowOther: boolean): MenuRow[] {
  const rows: MenuRow[] = options.map((option) => {
    const row: MenuRow = { label: option.label, isType: false };
    if (option.description !== undefined) {
      row.description = option.description;
    }
    return row;
  });
  if (allowOther) {
    rows.push({ label: TYPE_RESPONSE_LABEL, isType: true });
  }
  return rows;
}

/**
 * Create the focused question UI: a titled prompt, a description, a selectable
 * list of options, and an always-available free-form "Type a response" entry.
 *
 * @param opts - Title, options, theme, TUI, completion callback, and an optional editor factory.
 * @returns A pi-tui component with `render`, `invalidate`, and `handleInput`.
 */
export function createQuestionComponent(opts: QuestionComponentOptions): QuestionComponent {
  const rows = buildRows(opts.options, opts.allowOther);
  let index = 0;
  let editorMode = false;
  let editor: Editor | undefined;
  let finished = false;
  let cache: { width: number; mode: 'menu' | 'editor'; lines: string[] } | undefined;

  function makeEditorTheme(): EditorTheme {
    return {
      borderColor: (str: string) => opts.theme.fg('dim', str),
      selectList: {
        selectedPrefix: (text: string) => opts.theme.fg('accent', text),
        selectedText: (text: string) => opts.theme.fg('text', text),
        description: (text: string) => opts.theme.fg('dim', text),
        scrollInfo: (text: string) => opts.theme.fg('dim', text),
        noMatch: (text: string) => opts.theme.fg('dim', text),
      },
    };
  }

  /** Lazily create the free-form editor and wire its submit handler. */
  function ensureEditor(): Editor {
    if (editor) {
      return editor;
    }
    const theme = makeEditorTheme();
    editor = opts.createEditor ? opts.createEditor(opts.tui, theme) : new Editor(opts.tui, theme);
    editor.onSubmit = (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        finish({ kind: 'custom', text: trimmed });
      } else {
        // Empty submit: return to the option menu without answering.
        editorMode = false;
        invalidate();
      }
    };
    return editor;
  }

  function invalidate(): void {
    cache = undefined;
    opts.tui.requestRender();
  }

  /** Resolve the interaction exactly once. */
  function finish(answer: QuestionAnswer): void {
    if (finished) {
      return;
    }
    finished = true;
    opts.done(answer);
  }

  function renderHint(): string {
    const dim = (text: string) => opts.theme.fg('dim', text);
    if (editorMode) {
      return `  ${dim('Enter')} ${dim('send ·')} ${dim('Esc')} ${dim('back to options')}`;
    }
    return `  ${dim('↑/↓')} ${dim('move ·')} ${dim('Enter')} ${dim('select ·')} ${dim('Esc')} ${dim('cancel')}`;
  }

  function renderMenu(width: number): string[] {
    const lines: string[] = [];
    const rule = (text: string) => opts.theme.fg('accent', text);
    const titleWidth = Math.max(4, width - 2);

    lines.push(rule('─'.repeat(width)));
    lines.push('');
    lines.push(`  ${opts.theme.bold(opts.theme.fg('accent', 'question:'))}  ${opts.theme.fg('text', opts.title)}`);
    if (opts.description) {
      for (const line of wrapTextWithAnsi(opts.theme.fg('dim', opts.description), titleWidth)) {
        lines.push(`  ${line}`);
      }
    }
    lines.push('');

    rows.forEach((row, i) => {
      const selected = i === index;
      const prefix = selected ? opts.theme.fg('accent', '>') : opts.theme.fg('muted', '·');
      const label = selected ? opts.theme.fg('accent', row.label) : row.label;
      lines.push(`  ${prefix} ${i + 1}. ${label}`);
      if (row.description) {
        for (const line of wrapTextWithAnsi(row.description, Math.max(4, width - 4))) {
          lines.push(`     ${opts.theme.fg('dim', line)}`);
        }
      }
    });

    if (editorMode && editor) {
      for (const line of editor.render(width)) {
        lines.push(`  ${line}`);
      }
    }

    lines.push('');
    lines.push(renderHint());
    lines.push(rule('─'.repeat(width)));
    return lines;
  }

  function render(width: number): string[] {
    const mode = editorMode ? 'editor' : 'menu';
    if (cache && cache.width === width && cache.mode === mode) {
      return cache.lines;
    }
    const lines = renderMenu(width).map((line) => truncateToWidth(line, width));
    cache = { width, mode, lines };
    return lines;
  }

  function handleInput(data: string): void {
    if (finished) {
      return;
    }

    if (editorMode && editor) {
      if (matchesKey(data, Key.escape)) {
        // Esc returns to the option menu; selection stays on "Type a response".
        editorMode = false;
        invalidate();
        return;
      }
      editor.handleInput(data);
      invalidate();
      return;
    }

    // Option-menu mode.
    if (matchesKey(data, Key.up)) {
      index = (index - 1 + rows.length) % rows.length;
      invalidate();
    } else if (matchesKey(data, Key.down)) {
      index = (index + 1) % rows.length;
      invalidate();
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const row = rows[index];
      if (row === undefined) {
        return;
      }
      if (row.isType) {
        ensureEditor();
        editorMode = true;
        invalidate();
      } else {
        const answer: OptionAnswer = { kind: 'option', index, label: row.label };
        if (row.description !== undefined) {
          answer.description = row.description;
        }
        finish(answer);
      }
    } else if (matchesKey(data, Key.escape)) {
      finish(null);
    }
  }

  return { render, invalidate, handleInput };
}
