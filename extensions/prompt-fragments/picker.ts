import { DynamicBorder, getSelectListTheme, keyHint, type ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Container, matchesKey, SelectList, Text, type Component, type SelectItem } from '@mariozechner/pi-tui';
import { classifyPickerInput, filterItems, nextIndex, type KeyFacts, type PickerAction } from './picker-nav.ts';
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
    let filterMode = false;
    // Mirror of SelectList's private selectedIndex, within the mirrored
    // filtered list. Reset to 0 on every setFilter (SelectList does the same).
    let index = 0;

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
        filterMode ?
          `filter: "${filter}"${filter ? '' : '…'} • type to filter • ${keyHint('tui.select.cancel', 'clear filter')}`
        : `j/k or ${keyHint('tui.select.up', '↑/↓')} navigate • space/l toggle • / filter • ` +
          `${keyHint('tui.input.submit', 'accept')} • ${keyHint('tui.select.cancel', 'cancel')}`;
      hintText.setText(theme.fg('dim', hint));
      tui.requestRender();
    };
    refresh();

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const facts: KeyFacts = {
          submit: keybindings.matches(data, 'tui.input.submit'),
          cancel: keybindings.matches(data, 'tui.select.cancel'),
          space: matchesKey(data, 'space'),
          backspace: matchesKey(data, 'backspace'),
          // tui.select.up/down (not raw matchesKey 'up'/'down') so user remaps keep working.
          arrow:
            keybindings.matches(data, 'tui.select.up') ? -1
            : keybindings.matches(data, 'tui.select.down') ? 1
            : 0,
        };
        const action: PickerAction = classifyPickerInput(data, filterMode ? 'filter' : 'nav', facts);

        // Single choke point for filter changes: SelectList resets its
        // selection to 0 on setFilter — mirror that unconditionally.
        const applyFilter = (next: string) => {
          filter = next;
          selectList.setFilter(filter);
          index = 0;
        };

        switch (action.kind) {
          case 'toggle': {
            // Same item object → label mutation for the ● marker still works.
            const current = filterItems(items, filter)[index];
            if (current) {
              state = toggleChecked(state, current.value);
              // Row marker: mutate the shared item's label and re-render.
              current.label = state.checked.has(current.value) ? `● ${current.value}` : current.value;
              selectList.invalidate();
            }
            break;
          }
          case 'accept': {
            const picked = checkedInOrder(state, fragments);
            done(picked.length > 0 ? picked : null); // empty accept = cancel
            break;
          }
          case 'cancel':
            done(null); // reachable only in nav mode
            break;
          case 'enter-filter':
            filterMode = true;
            break;
          case 'exit-filter':
            // Q1=(a): clear the filter and return to nav; picker stays open.
            filterMode = false;
            applyFilter('');
            break;
          case 'filter-char':
            applyFilter(filter + action.char);
            break;
          case 'filter-backspace':
            if (filter.length > 0) applyFilter(filter.slice(0, -1));
            break;
          case 'move': {
            const length = filterItems(items, filter).length;
            index = nextIndex(index, action.delta, length);
            selectList.setSelectedIndex(index); // clamps; render() reads live
            break;
          }
          case 'ignore':
            break;
        }
        refresh();
      },
    } satisfies Component & { handleInput(data: string): void };
  });
}
