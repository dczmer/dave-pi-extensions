/**
 * Entry point for the pi-sessions viewer: loads the theme and sessions, then
 * runs the alt-screen TUI.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  KeybindingsManager,
  ProcessTerminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  setKeybindings,
} from '@earendil-works/pi-tui';

import { loadViewerTheme } from './theme.ts';
import { loadSessionFolders } from './sessions.ts';
import { App } from './viewer.ts';

/** Directory containing the package's bundled themes. */
const themesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'themes');

/**
 * Run the session viewer for the given CLI arguments.
 * @param argv - Arguments after `node bin/pi-sessions.ts` (i.e. without the script itself).
 */
export async function runViewer(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const theme = loadViewerTheme(resolveThemePath(options.theme));
  const sessionRoot = options.sessions ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(getAgentDir(), 'sessions');
  const folders = await loadSessionFolders(sessionRoot);
  if (folders.length === 0) {
    console.error(`no sessions found in ${sessionRoot}`);
    process.exit(1);
  }
  // Open the built-in search with '/' (ctrl+shift+f kept as an alternative).
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.altScreen.search': ['/', 'ctrl+shift+f'] }));
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, {
    searchMatchStyle: (text) => theme.bg('searchMatchBg', theme.fg('searchMatchText', text)),
    searchCurrentMatchStyle: (text) => theme.bold(theme.bg('searchMatchBg', theme.fg('text', text))),
    searchNavigationButtonStyle: (text) => theme.fg('muted', text),
  });
  new App(tui, theme, folders);
  tui.start();
}

/** Parsed command-line options. */
interface ViewerOptions {
  theme?: string;
  sessions?: string;
}

/**
 * Parse viewer command-line arguments.
 * @param argv - Raw argument list.
 * @returns Parsed options.
 * @throws When an unknown flag or a flag without a value is given.
 */
function parseArgs(argv: string[]): ViewerOptions {
  const options: ViewerOptions = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag ?? ''}`);
    }
    if (flag === '--theme') {
      options.theme = value;
    } else if (flag === '--sessions') {
      options.sessions = value;
    } else {
      throw new Error(`unknown option: ${flag ?? ''}`);
    }
  }
  return options;
}

/**
 * Resolve the theme file for a name or path.
 * @param themeArg - Theme name (looked up in the package themes dir) or a path.
 * @returns Absolute path of the theme JSON file.
 * @throws When no such file exists.
 */
function resolveThemePath(themeArg?: string): string {
  const candidates =
    themeArg ? [resolve(themeArg), join(themesDir, `${themeArg}.json`)] : [join(themesDir, 'cyberdream.json')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const wanted = themeArg ?? 'cyberdream';
  throw new Error(`theme not found: ${wanted} (looked in ${themesDir})`);
}
