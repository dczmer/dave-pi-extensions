# Plan: pi-gate Indicators in context-usage-bar

Status: **all decisions resolved (see Part 1); ready for implementation**

Adds `B` (bash guard) and `E` (external path guard) status indicators to the
left of the context usage bar in `extensions/context-usage-bar.ts`, showing
pi-gate's per-session guard states. Indicators are hidden entirely when
pi-gate is not loaded.

Target layout:

```
| ● B | ● E | [██████░░░░░░░░░░] 34% (41.0k/120.0k)  …right side…
```

- `|` separators between elements, colored with the theme's `border` color
  (same convention as the bar's `[` `]` in `renderProgressBar`).
- `●` circle to the left of each letter, inside the bordered section.
- Circle color: `success` (green) when the guard is enabled, `error` (red)
  when disabled. **No hard-coded colors** — only palette names resolved
  through `theme.fg()` at render time.
- Colors verified present in all bundled themes (`themes/carbonfox.json`,
  `cyberdream.json`, `dracula.json`): `border`, `success` (→ green),
  `error` (→ red).
- The indicator section renders unconditionally whenever pi-gate is loaded —
  including when the context bar itself is absent (no model / no usage yet),
  in which case the left side is just `| ● B | ● E | ` plus padding.

## Part 1 — Decisions (interviewed with user, all resolved)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Cross-extension state sharing | **Resolved by loader evidence (design review):** pi's extension loader (`dist/core/extensions/loader.js`, `loadExtensionModule`) creates a *new jiti instance per extension* with `moduleCache: false`, so a direct `import './pi-gate/session.ts'` from context-usage-bar would get a **separate module copy** with private all-defaults state. The shared-state registry is therefore the **primary** design (§2.1): back the `session.ts` singleton with `globalThis` via `Symbol.for`. The event bus *is* shared across extensions (`loadExtensions` passes one `resolvedEventBus` to every extension API), so events remain viable for the re-render trigger. |
| Q2 | Event-bus plumbing into `command.ts` | **Option (a) — explicit parameter.** `runPiGateCommand(args, ctx, events)`; `index.ts` passes `pi.events`. `EventBus` is exported from `@mariozechner/pi-coding-agent`. ~8 call sites in `command.test.ts` gain a stub (`{ emit: mock.fn(), on: () => () => {} }`). |
| Q3 | Event channel & payload | Channel `'pi-gate:toggled'`, payload `{ system: 'bash' \| 'external', enabled: boolean }` — consistent with the existing `'harness:block'` namespacing precedent. |
| Q4 | Reset semantics for loaded flag | **Separate `resetPiGateLoaded()`** — the flag is process-lifetime state, not session-lifetime; `resetSessionState()` semantics stay untouched. |
| Q5 | Bordered format & spacing | `| ● B | ● E | ` exactly: each indicator is a self-contained bordered cell, the trailing `|` closes the last cell and separates the group from the context bar, single space before the bar. Renders unconditionally (no empty-context conditional layout). |
| Q6 | Live re-render event | **Keep the event subscription — it is required, not optional.** Footers render on demand (`requestRender` pattern; verified in SDK's `custom-footer.ts` example). Relying on `ctx.ui.notify`'s incidental repaint is an undocumented side effect. |

## Part 2 — Design

### 2.1 `extensions/pi-gate/session.ts` — shared state + loaded flag

**Critical (Q1):** the singleton must be backed by `globalThis` so both
extension copies (pi-gate's and context-usage-bar's, loaded via separate jiti
instances) operate on one shared state object:

```ts
/** Per-session approvals and guard toggles; everything expires when pi exits. */
export interface SessionState {
  approvedExternalPatterns: Set<string>;
  approvedBashPatterns: Set<string>;
  /** Whether the bash command-pattern guard is active this session. */
  bashEnabled: boolean;
  /** Whether the external file-path guard is active this session. */
  externalEnabled: boolean;
  /** Whether the pi-gate extension entry point ran in this process. */
  piGateLoaded: boolean;
}

const SHARED_KEY = Symbol.for('pi-gate:session-state');

/**
 * Retrieve the mutable session-state singleton, shared across all module
 * copies in this process via globalThis (pi loads each extension with a
 * separate jiti instance, so module-level state would NOT be shared).
 */
export function getSessionState(): SessionState {
  const g = globalThis as Record<symbol, SessionState | undefined>;
  return (g[SHARED_KEY] ??= {
    approvedExternalPatterns: new Set(),
    approvedBashPatterns: new Set(),
    bashEnabled: true,
    externalEnabled: true,
    piGateLoaded: false,
  });
}
```

All existing accessors (`isBashEnabled`, `setBashEnabled`, etc.) change from
reading the module-level `state` constant to `getSessionState()` — a
mechanical internal change, no signature changes. New accessors:

```ts
/** Mark pi-gate as loaded in this process (called once by the extension entry point). */
export function markPiGateLoaded(): void {
  getSessionState().piGateLoaded = true;
}

/** Whether the pi-gate extension was actually loaded this session. */
export function isPiGateLoaded(): boolean {
  return getSessionState().piGateLoaded;
}

/** Reset the loaded flag (primarily for testing). */
export function resetPiGateLoaded(): void {
  getSessionState().piGateLoaded = false;
}
```

`resetSessionState()` is **not** touched (Q4): it continues to clear only
approvals and restore both guards.

### 2.2 `extensions/pi-gate/index.ts` — mark loaded + wire events

```ts
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { loadConfig, type ConfigResult } from './config.ts';
import { checkBashCommand } from './bash-guard.ts';
import { checkFileAccess } from './file-access.ts';
import { runPiGateCommand, piGateCompletions } from './command.ts';
import { markPiGateLoaded } from './session.ts';

export default function (pi: ExtensionAPI) {
  markPiGateLoaded(); // first statement

  pi.registerCommand('pi-gate', {
    description: 'Toggle pi-gate guards (usage: /pi-gate [bash|external] [on|off], or /pi-gate status)',
    getArgumentCompletions: (prefix) => piGateCompletions(prefix),
    handler: async (args, ctx) => runPiGateCommand(args, ctx, pi.events), // Q2
  });

  // ... existing tool_call hook unchanged
}
```

### 2.3 `extensions/pi-gate/command.ts` — emit toggle events

Per Q2 option (a), the public entry gains an `events` parameter:

```ts
import type { EventBus, ExtensionCommandContext } from '@mariozechner/pi-coding-agent';

export async function runPiGateCommand(
  args: string,
  ctx: ExtensionCommandContext,
  events: EventBus, // NEW
): Promise<void> {
```

Single emit site — `setSystemEnabled` gains the bus and emits (Q3):

```ts
function setSystemEnabled(system: GuardSystem, enabled: boolean, events: EventBus): void {
  if (system === 'bash') {
    setBashEnabled(enabled);
  } else {
    setExternalEnabled(enabled);
  }
  events.emit('pi-gate:toggled', { system, enabled });
}
```

**Checklist item:** the picker loop in `runPicker` currently flips guards
inline (`setBashEnabled(!isBashEnabled())`); both flips must be rerouted
through `setSystemEnabled(system, !enabled, events)` so they emit too.
`runPicker` also needs the `events` parameter threaded from
`runPiGateCommand`.

### 2.4 `extensions/context-usage-bar.ts` — render indicators

New imports — safe now because state is `globalThis`-backed (Q1):

```ts
import { isBashEnabled, isExternalEnabled, isPiGateLoaded } from './pi-gate/session.ts';
```

New pure render helper, exported for testing, typed against the SDK `Theme`:

```ts
import type { Theme } from '@mariozechner/pi-coding-agent';

/**
 * Render one pi-gate indicator section: `| ● X ` with the circle colored
 * by guard state (`success` enabled, `error` disabled).
 */
export function renderGateIndicator(label: 'B' | 'E', enabled: boolean, theme: Theme): string {
  const circle = theme.fg(enabled ? 'success' : 'error', '●');
  return `${theme.fg('border', '|')} ${circle} ${label} `;
}
```

Footer render changes inside `render(width)` (Q5 — unconditional):

```ts
let gateSection = '';
if (isPiGateLoaded()) {
  gateSection =
    renderGateIndicator('B', isBashEnabled(), theme) +
    renderGateIndicator('E', isExternalEnabled(), theme) +
    theme.fg('border', '|');
}

contextSection = (gateSection ? gateSection + ' ' : '') + contextSection;
```

`gateSection` is concatenated *into* `contextSection`, so the existing
`visibleWidth(contextSection)` padding math and final `truncateToWidth`
remain correct with no changes.

`installFooter` gains the required re-render subscription (Q6), with `pi`
threaded through from the default export:

```ts
function installFooter(ctx: ExtensionContext, pi: ExtensionAPI) {
  ctx.ui.setFooter((tui, theme, footerData) => {
    footerData.onBranchChange(() => tui.requestRender());
    const unsub = pi.events.on('pi-gate:toggled', () => tui.requestRender());

    return {
      dispose() { unsub(); },
      invalidate() {},
      render(width: number): string[] { /* ...existing, plus gateSection... */ },
    };
  });
}
```

Both `installFooter(ctx)` call sites (the `/context-bar` handler and the
`session_start` handler) become `installFooter(ctx, pi)`.

## Part 3 — Tests

Existing locations: `test/extensions/context-usage-bar/context-usage-bar.test.ts`,
`test/extensions/pi-gate/command.test.ts`. The existing `mockTheme()` in the
context-usage-bar tests (`fg` returning `<color>…</color>` tags) already
supports palette-name assertions.

New cases for `renderGateIndicator`:
- enabled → fg color name argument is `'success'`; output contains `●`, the label, and `|`.
- disabled → fg color name argument is `'error'`.
- borders: output starts with `|`; `border` used for separators.

Integration-level render test (the `render(width)` path):
- `isPiGateLoaded() === false` → line contains no `●`; layout identical to current output.
- after `markPiGateLoaded()` → `| ● B | ● E |` present, circles `'success'`.
- `setBashEnabled(false)` → B circle flips to `'error'`; `setExternalEnabled(false)` likewise.
- Teardown calls `resetSessionState()` **and** `resetPiGateLoaded()` (Q4) so
  the shared global state doesn't leak. Each test sets the flag state it
  needs explicitly — no ordering assumptions.

`command.test.ts`:
- All ~8 existing `runPiGateCommand(args, ctx)` call sites gain the stub bus
  `{ emit: mock.fn(), on: () => () => {} }`.
- New assertion: `bash on` emits `('pi-gate:toggled', { system: 'bash', enabled: true })`;
  one emit per toggle (verify `emit` called exactly once, and picker flips emit too).

`session.test.ts`:
- New cases for `markPiGateLoaded` / `isPiGateLoaded` / `resetPiGateLoaded`.
- Verify `resetSessionState()` does **not** clear the loaded flag (Q4).

## Part 4 — Verification commands

```bash
# 1. Focused tests first
node --test test/extensions/context-usage-bar/context-usage-bar.test.ts
node --test test/extensions/pi-gate/*.test.ts

# 2. Full suite + static checks
npm test
npm run typecheck
npx eslint .
npm run format:check
```

Manual verification:

```bash
# run pi from a repo dir, then:
#   /pi-gate bash off     → B circle turns red, re-renders live
#   /pi-gate external off → E circle turns red
#   /pi-gate bash on      → back to green
# disable pi-gate in ~/.pi/agent config → indicators absent entirely
```

## Part 5 — Files touched (summary)

| File | Change |
|------|--------|
| `extensions/pi-gate/session.ts` | `globalThis`/`Symbol.for`-backed singleton; `piGateLoaded` flag; `markPiGateLoaded()` / `isPiGateLoaded()` / `resetPiGateLoaded()`; accessors read via `getSessionState()` |
| `extensions/pi-gate/index.ts` | call `markPiGateLoaded()`; pass `pi.events` to `runPiGateCommand` |
| `extensions/pi-gate/command.ts` | `events: EventBus` parameter on `runPiGateCommand` and `runPicker`; single emit site in `setSystemEnabled`; picker flips routed through it |
| `extensions/context-usage-bar.ts` | `renderGateIndicator()`; gate section in `render()`; required `pi-gate:toggled` subscription with `dispose()` cleanup; `installFooter(ctx, pi)` |
| `test/extensions/context-usage-bar/context-usage-bar.test.ts` | new render + integration cases |
| `test/extensions/pi-gate/command.test.ts` | stubbed bus at ~8 call sites; emit assertions |
| `test/extensions/pi-gate/session.test.ts` | loaded-flag cases; `resetSessionState()` non-interference |
