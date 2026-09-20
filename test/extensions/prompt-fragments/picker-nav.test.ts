import { deepStrictEqual, strictEqual } from 'node:assert';
import { test } from 'node:test';
import type { SelectItem } from '@mariozechner/pi-tui';
import {
  classifyPickerInput,
  filterItems,
  nextIndex,
  type KeyFacts,
} from '../../../extensions/prompt-fragments/picker-nav.ts';

const facts = (over: Partial<KeyFacts> = {}): KeyFacts => ({
  submit: false,
  cancel: false,
  space: false,
  backspace: false,
  arrow: 0,
  ...over,
});

// --- Classification: nav mode ---

test('nav mode: j moves down', () => {
  deepStrictEqual(classifyPickerInput('j', 'nav', facts()), { kind: 'move', delta: 1 });
});

test('nav mode: k moves up', () => {
  deepStrictEqual(classifyPickerInput('k', 'nav', facts()), { kind: 'move', delta: -1 });
});

test('nav mode: h is unbound (Q2=(c))', () => {
  deepStrictEqual(classifyPickerInput('h', 'nav', facts()), { kind: 'ignore' });
});

test('nav mode: / enters filter mode, not a filter char', () => {
  deepStrictEqual(classifyPickerInput('/', 'nav', facts()), { kind: 'enter-filter' });
});

test('nav mode: space and h toggle', () => {
  deepStrictEqual(classifyPickerInput(' ', 'nav', facts({ space: true })), { kind: 'toggle' });
  deepStrictEqual(classifyPickerInput('l', 'nav', facts()), { kind: 'toggle' });
});

test('nav mode: Enter accepts', () => {
  deepStrictEqual(classifyPickerInput('\r', 'nav', facts({ submit: true })), { kind: 'accept' });
});

test('nav mode: Esc and Ctrl+C both cancel (Q1=(a))', () => {
  deepStrictEqual(classifyPickerInput('\x1b', 'nav', facts({ cancel: true })), { kind: 'cancel' });
  deepStrictEqual(classifyPickerInput('\x03', 'nav', facts({ cancel: true })), { kind: 'cancel' });
});

test('nav mode: arrows move with matching delta', () => {
  deepStrictEqual(classifyPickerInput('\x1b[A', 'nav', facts({ arrow: -1 })), { kind: 'move', delta: -1 });
  deepStrictEqual(classifyPickerInput('\x1b[B', 'nav', facts({ arrow: 1 })), { kind: 'move', delta: 1 });
});

test('nav mode: printable char is ignored (always-on filter is gone)', () => {
  deepStrictEqual(classifyPickerInput('a', 'nav', facts()), { kind: 'ignore' });
});

// --- Classification: filter mode ---

test('filter mode: printable char edits the filter', () => {
  deepStrictEqual(classifyPickerInput('a', 'filter', facts()), { kind: 'filter-char', char: 'a' });
});

test('filter mode: space edits the filter, never toggles', () => {
  deepStrictEqual(classifyPickerInput(' ', 'filter', facts({ space: true })), { kind: 'filter-char', char: ' ' });
});

test('filter mode: backspace edits the filter', () => {
  deepStrictEqual(classifyPickerInput('\x7f', 'filter', facts({ backspace: true })), { kind: 'filter-backspace' });
});

test('filter mode: Esc and Ctrl+C exit the filter, never cancel (Q1=(a))', () => {
  deepStrictEqual(classifyPickerInput('\x1b', 'filter', facts({ cancel: true })), { kind: 'exit-filter' });
  deepStrictEqual(classifyPickerInput('\x03', 'filter', facts({ cancel: true })), { kind: 'exit-filter' });
});

test('filter mode: Enter and arrows are ignored (Q3=(a)); j/k edit the filter', () => {
  deepStrictEqual(classifyPickerInput('\r', 'filter', facts({ submit: true })), { kind: 'ignore' });
  // j/k are printable chars — they edit the filter rather than moving (Q3=(a)).
  deepStrictEqual(classifyPickerInput('j', 'filter', facts()), { kind: 'filter-char', char: 'j' });
  deepStrictEqual(classifyPickerInput('k', 'filter', facts()), { kind: 'filter-char', char: 'k' });
  deepStrictEqual(classifyPickerInput('\x1b[A', 'filter', facts({ arrow: -1 })), { kind: 'ignore' });
  deepStrictEqual(classifyPickerInput('\x1b[B', 'filter', facts({ arrow: 1 })), { kind: 'ignore' });
});

// --- nextIndex wrap-around ---

test('nextIndex wraps in both directions', () => {
  strictEqual(nextIndex(0, -1, 3), 2);
  strictEqual(nextIndex(2, 1, 3), 0);
  strictEqual(nextIndex(1, 1, 3), 2);
  strictEqual(nextIndex(1, -1, 3), 0);
});

test('nextIndex returns 0 for an empty list', () => {
  strictEqual(nextIndex(0, 1, 0), 0);
  strictEqual(nextIndex(0, -1, 0), 0);
});

// --- filterItems parity with SelectList.setFilter ---

const item = (value: string): SelectItem => ({ value, label: value });
const ITEMS = [item('alpha'), item('Beta'), item('alpine')];

test('filterItems: empty filter returns all items as a new array', () => {
  const result = filterItems(ITEMS, '');
  deepStrictEqual(
    result.map((i) => i.value),
    ['alpha', 'Beta', 'alpine'],
  );
  strictEqual(result.length, 3);
  strictEqual(result[0], ITEMS[0]); // same object references
});

test('filterItems: case-insensitive prefix match on value', () => {
  deepStrictEqual(
    filterItems(ITEMS, 'AL').map((i) => i.value),
    ['alpha', 'alpine'],
  );
  deepStrictEqual(
    filterItems(ITEMS, 'be').map((i) => i.value),
    ['Beta'],
  );
});

test('filterItems: no match yields empty; same object references returned', () => {
  strictEqual(filterItems(ITEMS, 'zzz').length, 0);
  const [first, second] = filterItems(ITEMS, 'alp');
  strictEqual(first, ITEMS[0]);
  strictEqual(second, ITEMS[2]);
});

test('filterItems: checked-marker labels never corrupt value-based filtering', () => {
  const marked = [item('alpha'), item('Beta'), item('alpine')];
  const [markedFirst] = marked;
  if (markedFirst) markedFirst.label = '● alpha';
  deepStrictEqual(
    filterItems(marked, 'al').map((i) => i.value),
    ['alpha', 'alpine'],
  );
});
