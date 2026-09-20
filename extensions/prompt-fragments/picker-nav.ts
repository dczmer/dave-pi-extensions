/**
 * Pure input-navigation logic for the fragment picker: mode-aware key
 * classification, wrap-around index arithmetic, and the filter mirror.
 * Kept free of TUI/SelectList dependencies so it is unit-testable.
 */
import type { SelectItem } from '@mariozechner/pi-tui';

/** Picker modes: nav (default) or filter (entered via `/`). */
export type PickerMode = 'nav' | 'filter';

/**
 * Semantic action for one key event, independent of who consumes it.
 * The TUI layer (picker.ts) maps actions to side effects.
 */
export type PickerAction =
  | { kind: 'move'; delta: -1 | 1 }
  | { kind: 'toggle' }
  | { kind: 'accept' }
  | { kind: 'cancel' }
  | { kind: 'enter-filter' }
  | { kind: 'exit-filter' } // caller clears the filter and the mode
  | { kind: 'filter-char'; char: string }
  | { kind: 'filter-backspace' }
  | { kind: 'ignore' };

/**
 * Modifier/key facts about raw input, pre-computed by the caller with
 * pi-tui's matchesKey / keybindings.matches so this module stays pure.
 */
export interface KeyFacts {
  /** data matches the tui.input.submit binding (Enter). */
  submit: boolean;
  /** data matches tui.select.cancel (Esc or Ctrl+C — identical handling). */
  cancel: boolean;
  /** data is the space key. */
  space: boolean;
  /** data is backspace. */
  backspace: boolean;
  /** -1/1 for arrow up/down, else 0. Pre-resolved because arrow key data is not length-1. */
  arrow: -1 | 0 | 1;
}

/** Nav-mode movement keys (locked decision Q2=(c): j/k only; l toggles, h unbound). */
const NAV_MOVE_KEYS: Readonly<Record<string, -1 | 1>> = {
  j: 1,
  k: -1,
};

/**
 * Classify one raw key event given the current mode.
 * Pure: caller supplies KeyFacts; no keybinding lookups here.
 */
export function classifyPickerInput(data: string, mode: PickerMode, facts: KeyFacts): PickerAction {
  // --- Filter mode: only editing keys and exit keys are live (Q3=(a)) ---
  if (mode === 'filter') {
    if (facts.cancel) return { kind: 'exit-filter' }; // Q1=(a): Esc AND Ctrl+C
    if (facts.backspace) return { kind: 'filter-backspace' };
    if (data.length === 1 && data >= ' ') return { kind: 'filter-char', char: data };
    return { kind: 'ignore' }; // arrows and Enter ignored while editing (j/k are filter chars)
  }

  // --- Nav mode ---
  if (facts.submit) return { kind: 'accept' };
  if (facts.cancel) return { kind: 'cancel' };
  if (facts.arrow !== 0) return { kind: 'move', delta: facts.arrow };
  // Q2=(c): l toggles alongside space (h stays unbound). In filter mode l is
  // unreachable here — the filter branch above returns first, so l edits there.
  if (facts.space || data === 'l') return { kind: 'toggle' };
  if (data === '/') return { kind: 'enter-filter' };
  const delta = NAV_MOVE_KEYS[data];
  if (delta !== undefined) return { kind: 'move', delta };
  return { kind: 'ignore' }; // printable keys no longer type into the filter
}

/**
 * Next selection index with vim-style wrap: moving up from the first item
 * lands on the last, moving down from the last lands on the first.
 * Matches SelectList's native arrow behavior (select-list.js:66-75).
 * Returns 0 for an empty list (no-op).
 */
export function nextIndex(current: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/**
 * Mirror of SelectList.setFilter's filtering (select-list.js:25-29):
 * case-insensitive prefix match on item.value. Returns the SAME item
 * objects (not copies) so the checked-marker label mutation in picker.ts
 * keeps working.
 */
export function filterItems(items: readonly SelectItem[], filter: string): SelectItem[] {
  if (filter === '') return [...items];
  const prefix = filter.toLowerCase();
  return items.filter((item) => item.value.toLowerCase().startsWith(prefix));
}
