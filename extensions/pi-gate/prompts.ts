export type ConfigSection = 'bashAllow' | 'externalAllow' | 'projectDeny';
export type ConfigTarget = 'project' | 'global';

export interface AddToConfigResult {
  confirmed: boolean;
  target: ConfigTarget;
}

export interface ExtensionContext {
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

/**
 * Open a pi editor dialog pre-filled with a suggested pattern so the user can
 * refine it before saving to config.
 *
 * @param suggestion - Initial text shown in the editor.
 * @param description - Descriptive label for the dialog.
 * @param ctx - Pi extension context providing UI primitives.
 * @returns The user-edited pattern (trimmed), or `null` if cancelled/empty.
 */
export async function promptPattern(
  suggestion: string,
  description: string,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await ctx.ui.editor(`pi-gate: ${description}`, suggestion);
  if (result === undefined) return null;
  const trimmed = result.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ask the user which config target (project, global, or neither) to persist a
 * new allow/deny entry to.
 *
 * @param section - The config section being modified
 *                  (`"bashAllow"`, `"externalAllow"`, or `"projectDeny"`).
 * @param ctx - Pi extension context providing UI primitives.
 * @param value - Optional value being saved (shown to the user for context).
 * @returns Object indicating whether to save and which config target to use.
 */
export async function confirmAddToConfigWithTarget(
  section: ConfigSection,
  ctx: ExtensionContext,
  value?: string,
): Promise<AddToConfigResult> {
  const valueInfo = value ? `\n\nValue: "${value}"` : '';
  const choice = await ctx.ui.select(`pi-gate: Save to pi-gate.json -> "${section}"?${valueInfo}`, [
    'No',
    'Project',
    'Global',
  ]);

  if (choice === 'Project') {
    return { confirmed: true, target: 'project' };
  } else if (choice === 'Global') {
    return { confirmed: true, target: 'global' };
  }

  return { confirmed: false, target: 'project' };
}

/**
 * @deprecated Use {@link confirmAddToConfigWithTarget} instead.
 *
 * Legacy yes/no config-save prompt.  Internally delegates to
 * `confirmAddToConfigWithTarget` and discards the target choice.
 */
export async function confirmAddToConfig(
  section: ConfigSection,
  ctx: ExtensionContext,
  value?: string,
): Promise<boolean> {
  const result = await confirmAddToConfigWithTarget(section, ctx, value);
  return result.confirmed;
}
