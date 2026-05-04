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
    select<T extends string>(title: string, options: { label: string; value: T }[], initial?: T): Promise<T | undefined>;
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
  const confirmed = await ctx.ui.confirm(
    "pi-gate",
    `Add to pi-gate.json -> "${section}"?${valueInfo}`,
  );

  if (!confirmed) {
    return { confirmed: false, target: "project" };
  }

  // Use select to choose target (project is default)
  const target = await ctx.ui.select<ConfigTarget>(
    "pi-gate: Select config location (Tab to switch)",
    [
      { label: "Project (.pi/extensions/pi-gate.json)", value: "project" },
      { label: "Global (~/.pi/agent/extensions/pi-gate.json)", value: "global" },
    ],
    "project", // default to project
  );

  return {
    confirmed: true,
    target: target ?? "project", // fallback to project if undefined
  };
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
