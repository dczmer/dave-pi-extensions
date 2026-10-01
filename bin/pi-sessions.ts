#!/usr/bin/env node
/**
 * pi-sessions entry point: a read-only browser for pi coding agent sessions.
 */

import { runViewer } from '../src/session-viewer/main.ts';

runViewer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
