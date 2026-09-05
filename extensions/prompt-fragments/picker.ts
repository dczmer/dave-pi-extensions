import { DynamicBorder, getSelectListTheme, keyHint, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Container, matchesKey, SelectList, Text, type Component, type SelectItem } from '@mariozechner/pi-tui';
import type { PromptFragment } from './fragments.ts';

/** Checked-set state for the picker, independent of rendering. */
export interface PickerState {
  checked: ReadonlySet<string>;
}

/** Create an empty picker state. */
export function createPickerState(): PickerState {
  return { checked: new Set() };
}

/** Return a new state with the given name toggled. */
export function toggleChecked(state: PickerState, name: string): PickerState {
  const checked = new Set(state.checked);
  if (checked.has(name)) checked.delete(name);
  else checked.add(name);
  return { checked };
}

/** Names of checked fragments, in file order (deterministic). */
export function checkedInOrder(state: PickerState, fragments: PromptFragment[]): string[] {
  return fragments.filter((f) => state.checked.has(f.name)).map((f) => f.name);
}

/**
 * Show the multi-select fragment picker. Returns checked names in file
 * order, or null when cancelled / accepted with no selection.
 * Must NOT touch ctx.ui.setEditorText — the editor snapshot is restored
 * after custom() closes; callers write the composed text only after this
 * promise resolves.
 */
export async function pickFragments(ctx: ExtensionContext, fragments: PromptFragment[]): Promise<string[] | null> {
  const items: SelectItem[] = fragments.map((f) => ({ value: f.name, label: f.name }));

  return ctx.ui.custom<string[] | null>((tui, theme, keybindings, done) => {
    let state = createPickerState();
    let filter = '';

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
    container.addChild(new Text(theme.fg('accent', theme.bold('Select prompt fragments')), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      ...getSelectListTheme(),
      selectedPrefix: (t: string) => theme.fg('accent', t),
      selectedText: (t: string) => theme.fg('accent', t),
    });
    container.addChild(selectList);

    const selectedText = new Text('', 1, 0);
    container.addChild(selectedText);

    const hintText = new Text('', 1, 0);
    container.addChild(hintText);
    container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

    const refresh = () => {
      const picked = checkedInOrder(state, fragments);
      selectedText.setText(theme.fg('accent', picked.length > 0 ? `Selected: ${picked.join(', ')}` : 'Selected: none'));
      const hint =
        `${keyHint('tui.select.up', 'navigate')} • space toggle • ` +
        `${keyHint('tui.input.submit', 'accept')} • ${keyHint('tui.select.cancel', 'cancel')}` +
        (filter ? ` • filter: "${filter}"` : ' • type to filter');
      hintText.setText(theme.fg('dim', hint));
      tui.requestRender();
    };
    refresh();

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Space toggles only when the filter is empty (else it's filter text).
        if (filter === '' && matchesKey(data, 'space')) {
          const current = selectList.getSelectedItem();
          if (current) {
            state = toggleChecked(state, current.value);
            // Row marker: mutate the shared item's label and re-render.
            current.label = state.checked.has(current.value) ? `● ${current.value}` : current.value;
            selectList.invalidate();
            refresh();
          }
          return;
        }
        if (keybindings.matches(data, 'tui.input.submit')) {
          const picked = checkedInOrder(state, fragments);
          done(picked.length > 0 ? picked : null); // empty accept = cancel
          return;
        }
        if (keybindings.matches(data, 'tui.select.cancel')) {
          done(null);
          return;
        }
        // Own the filter: printable keys mutate our filter; backspace edits
        // it. setFilter() resets the selection to 0, so only call it when the
        // filter actually changed — never on navigation keys.
        if (data.length === 1 && data >= ' ') {
          filter += data;
          selectList.setFilter(filter);
        } else if (matchesKey(data, 'backspace') && filter.length > 0) {
          filter = filter.slice(0, -1);
          selectList.setFilter(filter);
        } else {
          selectList.handleInput(data); // navigation (up/down) still delegated
        }
        refresh();
      },
    } satisfies Component & { handleInput(data: string): void };
  });
}
