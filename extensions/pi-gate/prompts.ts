export type ConfigSection = "bashAllow" | "externalAllow" | "projectDeny";

export interface ExtensionContext {
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export async function promptAllowDeny(
  message: string,
  ctx: ExtensionContext,
): Promise<boolean> {
  return await ctx.ui.confirm("pi-gate", message);
}

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

export async function confirmAddToConfig(
  section: ConfigSection,
  ctx: ExtensionContext,
  value?: string,
): Promise<boolean> {
  const valueInfo = value ? `\n\nValue: "${value}"` : "";
  return await ctx.ui.confirm(
    "pi-gate",
    `Add to pi-gate.json -> "${section}"?${valueInfo}`,
  );
}
