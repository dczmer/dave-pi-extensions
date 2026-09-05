import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Key } from '@mariozechner/pi-tui';
import { fragmentsPath, loadFragments } from './fragments.ts';
import { composePrompt, type FragmentMode } from './compose.ts';
import { pickFragments } from './picker.ts';

/** Guard against re-entrant picker opens (shortcut double-fire). */
let pickerOpen = false;

/**
 * Shared flow for shortcuts and the /fragment command: load fragments,
 * run the picker, then compose the new editor text. The editor text must
 * be read and written only after pickFragments resolves — custom()
 * restores the pre-open editor snapshot on close, wiping any earlier
 * setEditorText call.
 */
async function runFragmentPicker(mode: FragmentMode, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || pickerOpen) return;

  const { fragments, warnings } = loadFragments();
  if (warnings.length > 0) ctx.ui.notify(warnings.join('; '), 'warning');
  if (fragments.length === 0) {
    ctx.ui.notify(`No fragments defined — add some to ${fragmentsPath()}`, 'info');
    return;
  }

  pickerOpen = true;
  try {
    const picked = await pickFragments(ctx, fragments);
    if (!picked) return; // cancelled / empty accept: leave editor untouched
    const selected = fragments.filter((f) => picked.includes(f.name));
    const next = composePrompt(ctx.ui.getEditorText(), selected, mode);
    ctx.ui.setEditorText(next);
    ctx.ui.notify(`${mode === 'prepend' ? 'Prepended' : 'Appended'} ${selected.length} fragment(s)`, 'info');
  } finally {
    pickerOpen = false;
  }
}

/**
 * prompt-fragments extension: prepend/append reusable prompt fragments
 * from ~/.pi/agent/prompt-fragments.json to the editor via a multi-select
 * picker.
 */
export default function (pi: ExtensionAPI) {
  pi.registerShortcut(Key.ctrlShift('f'), {
    description: 'Append prompt fragment(s) to the editor',
    handler: async (ctx) => runFragmentPicker('append', ctx),
  });
  pi.registerShortcut(Key.ctrlShift('b'), {
    description: 'Prepend prompt fragment(s) to the editor',
    handler: async (ctx) => runFragmentPicker('prepend', ctx),
  });

  // Command fallback: works with custom editors and is discoverable via /help.
  pi.registerCommand('fragment', {
    description: 'Pick prompt fragments to prepend/append (usage: /fragment [a|p])',
    handler: async (args, ctx) => {
      const mode = args.trim() === 'p' ? 'prepend' : 'append';
      await runFragmentPicker(mode, ctx);
    },
  });
}
