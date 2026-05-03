import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { checkBashCommand } from "./bash-guard.ts";
import { checkFileAccess } from "./file-access.ts";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);

    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command;
      if (!command) return;

      const allowed = await checkBashCommand(command, ctx.cwd, config, ctx);
      if (!allowed) {
        return { block: true, reason: "Blocked by pi-gate" };
      }
      return;
    }

    const fileTools = ["read", "write", "edit", "grep", "find"];
    if (fileTools.includes(event.toolName)) {
      const path = (event.input as { path?: string }).path;
      if (!path) return;

      const allowed = await checkFileAccess(path, ctx.cwd, config, ctx);
      if (!allowed) {
        return { block: true, reason: "Blocked by pi-gate" };
      }
      return;
    }
  });
}
