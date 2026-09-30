import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { Key, matchesKey, type Editor, type TUI } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { createQuestionComponent, TYPE_RESPONSE_LABEL } from '../../../extensions/question/component.ts';
import type { QuestionAnswer } from '../../../extensions/question/types.ts';

/** Identity theme so render assertions run against plain text. */
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

interface FakeEditor {
  onSubmit: ((text: string) => void) | null;
  render: (width: number) => string[];
  handleInput: (data: string) => void;
  getText: () => string;
}

/** Deterministic editor stand-in for the free-form flow. */
function makeFakeEditor(): FakeEditor {
  let text = '';
  const editor: FakeEditor = {
    onSubmit: null,
    render: () => ['[EDITOR]'],
    handleInput: (data: string) => {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
        const value = text;
        text = '';
        editor.onSubmit?.(value);
      } else if (data === '\x7f' || data === '\b' || matchesKey(data, Key.backspace)) {
        text = text.slice(0, -1);
      } else {
        text += data;
      }
    },
    getText: () => text,
  };
  return editor;
}

interface Fixture {
  render: () => string;
  getAnswer: () => QuestionAnswer | undefined;
  getRenderCount: () => number;
}

function makeFixture(overrides?: { allowOther?: boolean; description?: string }): Fixture {
  let answer: QuestionAnswer | undefined;
  let renderCount = 0;
  const tui = {
    requestRender: () => {
      renderCount += 1;
    },
  } as unknown as TUI;
  const comp = createQuestionComponent({
    title: 'Pick a color',
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
    options: [{ label: 'Alpha', description: 'first option' }, { label: 'Beta' }],
    allowOther: overrides?.allowOther ?? true,
    theme: fakeTheme,
    tui,
    done: (a) => {
      answer = a;
    },
    createEditor: () => makeFakeEditor() as unknown as Editor,
  });
  return {
    render: () => comp.render(80).join('\n'),
    getAnswer: () => answer,
    getRenderCount: () => renderCount,
  };
}

test('renders title, description, options, and the always-on free-form entry', () => {
  const fx = makeFixture();
  const out = fx.render();
  ok(out.includes('Pick a color'), out);
  ok(out.includes('first option'), out);
  ok(out.includes('Beta'), out);
  ok(out.includes(TYPE_RESPONSE_LABEL), out);
  ok(out.includes('> 1. Alpha'), 'first option should be selected by default');
  ok(out.includes('· 2. Beta'), out);
});

test('omits the free-form entry when allowOther is false', () => {
  const fx = makeFixture({ allowOther: false });
  const out = fx.render();
  ok(!out.includes(TYPE_RESPONSE_LABEL), out);
  ok(out.includes('> 1. Alpha'), out);
});

test('navigating down moves the selection and requests a re-render', () => {
  let count = 0;
  const tui = {
    requestRender: () => {
      count += 1;
    },
  } as unknown as TUI;
  const c = createQuestionComponent({
    title: 'Pick a color',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
    allowOther: false,
    theme: fakeTheme,
    tui,
    done: () => {},
  });
  c.render(80);
  const base = count;
  c.handleInput('\u001b[B'); // down
  strictEqual(count, base + 1, 'down should invalidate and request a render');
  ok(c.render(80).join('\n').includes('> 2. Beta'));
});

test('Enter on an option resolves with that option (and its description)', () => {
  const { comp, answer } = makeComponentForInput();
  comp.handleInput('\r'); // enter
  deepStrictEqual(answer(), { kind: 'option', index: 0, label: 'Alpha', description: 'first option' });
});

test('Esc in the menu cancels (resolves null)', () => {
  const { comp, answer } = makeComponentForInput();
  comp.handleInput('\u001b');
  strictEqual(answer(), null);
});

test('the free-form flow: enter editor, type, submit', () => {
  const { comp, answer, render } = makeComponentForInput();
  // Move to the "Type a response" row (index 2) and enter the editor.
  comp.handleInput('\u001b[B'); // down -> Beta
  comp.handleInput('\u001b[B'); // down -> Type a response
  comp.handleInput('\r'); // enter -> editor mode
  ok(render().includes('[EDITOR]'), render());
  comp.handleInput('h');
  comp.handleInput('i');
  comp.handleInput('\r'); // submit
  deepStrictEqual(answer(), { kind: 'custom', text: 'hi' });
});

test('Esc in the editor returns to the menu without answering', () => {
  const { comp, answer, render } = makeComponentForInput();
  comp.handleInput('\u001b[B');
  comp.handleInput('\u001b[B');
  comp.handleInput('\r'); // enter editor
  comp.handleInput('\u001b'); // Esc -> back to menu
  strictEqual(answer(), undefined, 'should not resolve when returning to menu');
  ok(render().includes(`> 3. ${TYPE_RESPONSE_LABEL}`), render());
});

test('empty submit in the editor returns to the menu without answering', () => {
  const { comp, answer, render } = makeComponentForInput();
  comp.handleInput('\u001b[B');
  comp.handleInput('\u001b[B');
  comp.handleInput('\r'); // enter editor
  comp.handleInput('\r'); // empty submit
  strictEqual(answer(), undefined, 'empty submit should not resolve');
  ok(render().includes(`> 3. ${TYPE_RESPONSE_LABEL}`), render());
});

test('done is called exactly once (later input is ignored)', () => {
  let calls = 0;
  const tui = { requestRender: () => {} } as unknown as TUI;
  const comp = createQuestionComponent({
    title: 'Pick a color',
    options: [{ label: 'Alpha' }],
    allowOther: false,
    theme: fakeTheme,
    tui,
    done: () => {
      calls += 1;
    },
  });
  comp.handleInput('\r'); // resolve
  comp.handleInput('\r'); // ignored
  comp.handleInput('\u001b'); // ignored
  strictEqual(calls, 1);
});

/** Build a driven component with a captured answer for input-flow tests. */
function makeComponentForInput() {
  let answer: QuestionAnswer | undefined;
  const tui = { requestRender: () => {} } as unknown as TUI;
  const comp = createQuestionComponent({
    title: 'Pick a color',
    description: 'Choose one',
    options: [{ label: 'Alpha', description: 'first option' }, { label: 'Beta' }],
    allowOther: true,
    theme: fakeTheme,
    tui,
    done: (a) => {
      answer = a;
    },
    createEditor: () => makeFakeEditor() as unknown as Editor,
  });
  return {
    comp,
    answer: () => answer,
    render: () => comp.render(80).join('\n'),
  };
}
