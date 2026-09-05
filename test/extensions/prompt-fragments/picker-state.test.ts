import { deepStrictEqual, strictEqual } from 'node:assert';
import { test } from 'node:test';
import { checkedInOrder, createPickerState, toggleChecked } from '../../../extensions/prompt-fragments/picker.ts';

const fr = (name: string) => ({ name, prompt: `prompt ${name}` });
const FRAGMENTS = [fr('a'), fr('b'), fr('c')];

test('initial state has nothing checked', () => {
  const state = createPickerState();
  strictEqual(state.checked.size, 0);
  deepStrictEqual(checkedInOrder(state, FRAGMENTS), []);
});

test('toggle adds then removes a name', () => {
  let state = createPickerState();
  state = toggleChecked(state, 'a');
  strictEqual(state.checked.has('a'), true);
  state = toggleChecked(state, 'a');
  strictEqual(state.checked.has('a'), false);
});

test('toggle does not mutate the input state', () => {
  const before = createPickerState();
  const after = toggleChecked(before, 'a');
  strictEqual(before.checked.has('a'), false);
  strictEqual(after.checked.has('a'), true);
});

test('checkedInOrder returns file order regardless of toggle order', () => {
  let state = createPickerState();
  state = toggleChecked(state, 'c');
  state = toggleChecked(state, 'a');
  deepStrictEqual(checkedInOrder(state, FRAGMENTS), ['a', 'c']);
});

test('unknown checked names are ignored by checkedInOrder', () => {
  let state = createPickerState();
  state = toggleChecked(state, 'nope');
  deepStrictEqual(checkedInOrder(state, FRAGMENTS), []);
});
