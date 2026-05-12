/**
 * RTK Bash Wrapper Extension
 *
 * Wraps every bash tool call with `rtk` for command tracking.
 *
 * Place in .pi/extensions/ for project-local use,
 * or ~/.pi/agent/extensions/ for global use.
 */

import { spawnSync } from 'node:child_process';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { isToolCallEventType } from '@mariozechner/pi-coding-agent';

function isRtkAvailable(): boolean {
  const result = spawnSync('command', ['-v', 'rtk'], { shell: true, encoding: 'utf-8' });
  return result.status === 0;
}

export default function (pi: ExtensionAPI) {
  if (!isRtkAvailable()) {
    console.log('[rtk-bash-wrapper] rtk not found in PATH, skipping bash wrapping');
    return;
  }

  pi.on('tool_call', async (event) => {
    // Only intercept bash tool calls
    if (isToolCallEventType('bash', event)) {
      const originalCommand = event.input.command;

      // Skip if already wrapped or if it's a simple cd/pwd/noop
      if (originalCommand.startsWith('rtk ') || originalCommand.match(/^[\s]*(?:cd|pwd|echo)[\s]*$/)) {
        return;
      }

      // Handle compound commands
      const hasAnd = originalCommand.includes(' && ');
      const hasOr = originalCommand.includes(' || ');

      if (hasAnd || hasOr) {
        // Only handle 'cd $PATH && $COMMAND' pattern
        if (originalCommand.startsWith('cd ') && hasAnd) {
          const parts = originalCommand.split(' && ');
          if (parts.length === 2) {
            event.input.command = `${parts[0]} && rtk ${parts[1]}`;
          }
        }
        // Other compound commands: skip wrapping
        return;
      }

      // Wrap command with rtk
      event.input.command = `rtk ${originalCommand}`;
    }
  });
}
