/**
 * Companion extension injected into subagent child processes via `--extension`.
 *
 * Registers the child-only `contact_supervisor` tool. In the child's RPC mode,
 * `ctx.ui.input` emits an `extension_ui_request` on stdout and blocks; the
 * parent's runner relays it to the primary session's TUI and writes the
 * response back to the child's stdin. No separate channel needed.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'contact_supervisor',
    label: 'Contact Supervisor',
    description:
      'Ask the supervising pi session a question when blocked (e.g. an ambiguity, ' +
      'a destructive action you are unsure about). Blocks until the supervisor answers.',
    parameters: Type.Object({
      question: Type.String({ description: 'The question to ask the supervisor' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: 'text', text: 'No supervisor channel available.' }], details: undefined };
      }
      const answer = await ctx.ui.input('Subagent asks', params.question);
      if (answer === undefined) {
        return {
          content: [{ type: 'text', text: 'Supervisor dismissed the question. Proceed with best judgment.' }],
          details: undefined,
        };
      }
      return { content: [{ type: 'text', text: `Supervisor reply: ${answer}` }], details: undefined };
    },
  });
}
