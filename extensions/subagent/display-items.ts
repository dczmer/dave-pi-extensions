/**
 * Display-item extraction for subagent run transcripts.
 *
 * A display item is one line of "what the child did": either a formatted
 * tool call (`$ npm test`, `read ~/src/foo.ts:1-40`) or an assistant text
 * block. Tool results are deliberately excluded (decision D2) — they stay
 * available in `run.messages` for programmatic use.
 */
import * as os from 'node:os';
import type { Message } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';

/** One renderable step of a subagent run. */
export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

/** Flatten assistant messages into ordered display items (text blocks and tool calls). */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'text') items.push({ type: 'text', text: part.text });
      else if (part.type === 'toolCall') {
        items.push({ type: 'toolCall', name: part.name, args: part.arguments as Record<string, unknown> });
      }
    }
  }
  return items;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Format a tool call the way pi's built-in tool renderers do (`$ cmd`, `read path:1-10`, ...). */
export function formatToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): string {
  switch (toolName) {
    case 'bash':
      return theme.fg('muted', '$ ') + theme.fg('toolOutput', clip(String(args.command ?? '...'), 60));
    case 'read': {
      const filePath = shortenPath(String(args.path ?? '...'));
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = theme.fg('accent', filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : '';
        text += theme.fg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
      }
      return theme.fg('muted', 'read ') + text;
    }
    case 'write': {
      const filePath = shortenPath(String(args.path ?? '...'));
      const lines = String(args.content ?? '').split('\n').length;
      let text = theme.fg('muted', 'write ') + theme.fg('accent', filePath);
      if (lines > 1) text += theme.fg('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit':
      return theme.fg('muted', 'edit ') + theme.fg('accent', shortenPath(String(args.path ?? '...')));
    case 'ls':
      return theme.fg('muted', 'ls ') + theme.fg('accent', shortenPath(String(args.path ?? '.')));
    case 'find':
      return (
        theme.fg('muted', 'find ') +
        theme.fg('accent', String(args.pattern ?? '*')) +
        theme.fg('dim', ` in ${shortenPath(String(args.path ?? '.'))}`)
      );
    case 'grep':
      return (
        theme.fg('muted', 'grep ') +
        theme.fg('accent', `/${String(args.pattern ?? '')}/`) +
        theme.fg('dim', ` in ${shortenPath(String(args.path ?? '.'))}`)
      );
    default:
      return theme.fg('accent', toolName) + theme.fg('dim', ` ${clip(JSON.stringify(args), 50)}`);
  }
}
