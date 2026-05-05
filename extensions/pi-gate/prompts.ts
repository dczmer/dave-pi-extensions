export type ConfigSection = "bashAllow" | "externalAllow" | "projectDeny";
export type ConfigTarget = "project" | "global";

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

export async function confirmAddToConfigWithTarget(
  section: ConfigSection,
  ctx: ExtensionContext,
  value?: string,
): Promise<AddToConfigResult> {
  const valueInfo = value ? `\n\nValue: "${value}"` : "";
  const choice = await ctx.ui.select(
    `pi-gate: Save to pi-gate.json -> "${section}"?${valueInfo}`,
    ["No", "Project", "Global"],
  );

  if (choice === "Project") {
    return { confirmed: true, target: "project" };
  } else if (choice === "Global") {
    return { confirmed: true, target: "global" };
  }

  return { confirmed: false, target: "project" };
}

// Backward compatibility - deprecated, use confirmAddToConfigWithTarget
export async function confirmAddToConfig(
  section: ConfigSection,
  ctx: ExtensionContext,
  value?: string,
): Promise<boolean> {
  const result = await confirmAddToConfigWithTarget(section, ctx, value);
  return result.confirmed;
}
