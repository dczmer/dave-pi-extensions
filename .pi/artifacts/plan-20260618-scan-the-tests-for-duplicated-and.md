# Extract duplicated test helpers into `test/utils`

## Context

Test suite has grown ad-hoc helpers. Same patterns copied across extension tests. Duplication makes updates brittle and increases boilerplate. Consolidating helpers into `test/utils` aligns with project instructions (tempfs isolation, config mocking patterns already documented in `AGENTS.md`) and existing utilities (`pi-context.ts`, `pi-harness.ts`).

## Recommended approach

Create focused utility modules under `test/utils/`, then replace inline copies with imports. Extend `test/utils/pi-context.ts` with the queue UI helper and keep `test/utils/pi-harness.ts` unchanged for harness creation. Add remaining helpers as separate modules beside them.

## Duplicates found

### 1. `withTempDir` — filesystem isolation helper

Appears in **7 files** with slight variations (sync vs async, prefix, force flag):

- `test/extensions/error-logger/index.test.ts` — async, prefix `pi-errlog-`
- `test/extensions/error-logger/logger.test.ts` — sync, prefix `pi-errlog-`
- `test/extensions/pi-gate/bash-guard.test.ts` — sync, prefix `pi-gate-`, called with async callbacks
- `test/extensions/pi-gate/config.test.ts` — sync, prefix `pi-gate-`
- `test/extensions/pi-gate/file-access.test.ts` — sync, prefix `pi-gate-`, called with async callbacks
- `test/extensions/pi-gate/index.test.ts` — async, prefix `pi-gate-`
- `test/extensions/plan-mode/index.test.ts` — sync **and** async (`withTempDirAsync`), prefix `pi-plan-`

All use `mkdtempSync(join(tmpdir(), '<prefix>'))` and `rmSync(dir, { recursive: true })`.

**Consolidate to a single function.** One implementation handles sync and async callbacks. No need for separate `withTempDirAsync`.

**Extract to:** `test/utils/temp-dir.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T;
export function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>;
export function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => T | Promise<T>,
): T | Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const result = fn(dir);
    if (result instanceof Promise) {
      return result.finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    }
    return result;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
```

Update all call sites to import from `../../utils/temp-dir.ts` (or `../../../utils/temp-dir.ts` depending on depth). Use per-extension prefixes (`pi-gate-`, `pi-errlog-`, `pi-plan-`).

For async callbacks, call sites must `await` or `return` the result so cleanup runs before the test finishes. Several current tests call `withTempDir(async ...)` inside an async test without awaiting; fix those as part of the refactor.

### 2. `createConfigResult` — pi-gate config factory

Identical implementation in:

- `test/extensions/pi-gate/bash-guard.test.ts`
- `test/extensions/pi-gate/file-access.test.ts`

Not shareable outside pi-gate because it imports `ConfigResult` from pi-gate source. Keep it scoped to the extension test directory.

**Extract to:** `test/extensions/pi-gate/utils/config.ts`

```ts
import { type ConfigResult } from '../../../extensions/pi-gate/config.ts';

export function createConfigResult(overrides?: Partial<ConfigResult>): ConfigResult {
  const empty = () => ({ bashAllow: [] as string[], externalAllow: [] as string[] });
  return {
    merged: { ...empty(), ...(overrides?.merged || {}) },
    global: { ...empty(), ...(overrides?.global || {}) },
    project: { ...empty(), ...(overrides?.project || {}) },
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    ...overrides,
  };
}
```

Import with `./utils/config.ts` from `bash-guard.test.ts` and `file-access.test.ts`.

### 3. `createQueuedUIContext` — queue-based UI mock for pi-gate

Very similar queue-driven mock context in:

- `test/extensions/pi-gate/bash-guard.test.ts` — editor/select/confirm queues + notifications
- `test/extensions/pi-gate/file-access.test.ts` — editor/select queues + notifications
- `test/extensions/pi-gate/prompts.test.ts` — simpler `createMockCtx` but same concept

**Extract to:** `test/utils/pi-context.ts`

Add `createQueuedUIContext` to `test/utils/pi-context.ts` to keep context factories together. It builds a full `ExtensionContext` via the existing `createExtensionContext`, then overrides `ui.editor`, `ui.select`, and `ui.confirm` with queue-backed implementations and exposes `_notifications`, `queueEditor`, `queueSelect`, and `queueConfirm`.

```ts
/** ExtensionContext whose editor/select/confirm calls drain queued values. */
export interface QueuedUIContext extends ExtensionContext {
  _notifications: Array<{ message: string; level: string }>;
  queueEditor: (v: string | null) => void;
  queueSelect: (v: string | null) => void;
  queueConfirm: (v: boolean) => void;
}

/** Build a full ExtensionContext with queue-backed UI inputs. */
export function createQueuedUIContext(
  overrides?: Partial<ExtensionContext>,
): QueuedUIContext { ... }
```

Use it in `bash-guard.test.ts`, `file-access.test.ts`, and `prompts.test.ts`.

### 4. Harness event capture pattern

Repeated block-event capture setup:

```ts
const emitted: unknown[] = [];
harness.eventBus.on('harness:block', (data) => emitted.push(data));
```

Appears in:

- `test/extensions/error-logger/index.test.ts`
- `test/extensions/pi-gate/index.test.ts`
- `test/extensions/plan-mode/index.test.ts` (multiple tests)

**Extract to:** `test/utils/pi-harness.ts` (new standalone helper, no interface change)

Expose a standalone helper:

```ts
/** Capture all payloads emitted on `harness.eventBus` for `eventName`. */
export function captureEvents(harness: PiTestHarness, eventName: string): unknown[];
```

The helper attaches a listener, records payloads in an array, and detaches after the test returns the array. Since current tests never call `clear()`, no object wrapper is needed.

### 5. Mock `ExtensionAPI` factory for plan-mode

Nearly identical mock `ExtensionAPI` objects in two tests in `test/extensions/plan-mode/index.test.ts`:

- `'default export registers all handlers even when --no-plan flag is set'`
- `'session_start with --no-plan initializes disabled'`
- `'session_start without --no-plan initializes enabled'`

**Extract to:** `test/utils/mock-pi-api.ts`

Use a small local interface with the methods exercised by the tests, build it as a plain object, and return it `as unknown as ExtensionAPI`. This avoids mocking the full `ExtensionAPI` surface.

```ts
import { mock } from 'node:test';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

/** Methods of ExtensionAPI used by plan-mode tests. */
export interface MockedExtensionAPI {
  registerFlag: Mock<ExtensionAPI['registerFlag']>;
  getFlag: Mock<ExtensionAPI['getFlag']>;
  registerCommand: Mock<ExtensionAPI['registerCommand']>;
  registerShortcut: Mock<ExtensionAPI['registerShortcut']>;
  on: Mock<ExtensionAPI['on']>;
  sendMessage: Mock<ExtensionAPI['sendMessage']>;
  events: { emit: Mock<(...args: unknown[]) => void> };
  appendEntry: Mock<ExtensionAPI['appendEntry']>;
}

export function createMockExtensionAPI(options?: {
  getFlag?: (name: string) => boolean | string | undefined;
}): MockedExtensionAPI { ... }
```

The factory accepts an optional `getFlag` implementation so the three tests can supply their own flag behavior (including `() => false`).

## Critical files to modify

| File | Change |
| ---- | ------ |
| `test/utils/temp-dir.ts` | **New** — `withTempDir` (sync + async)
| `test/extensions/pi-gate/utils/config.ts` | **New** — `createConfigResult` |
| `test/utils/pi-context.ts` | **Extend** — `createQueuedUIContext` |
| `test/utils/pi-harness.ts` | **Unchanged** — add standalone `captureEvents` helper exported from this file |
| `test/utils/mock-pi-api.ts` | **New** — `createMockExtensionAPI` |
| `test/extensions/error-logger/index.test.ts` | Replace inline `withTempDir` with import |
| `test/extensions/error-logger/logger.test.ts` | Replace inline `withTempDir` with import |
| `test/extensions/pi-gate/bash-guard.test.ts` | Replace `withTempDir`, `createConfigResult` (import from `./utils/config.ts`), `createMockCtx` |
| `test/extensions/pi-gate/config.test.ts` | Replace `withTempDir` |
| `test/extensions/pi-gate/file-access.test.ts` | Replace `withTempDir`, `createConfigResult` (import from `./utils/config.ts`), `createMockCtx` |
| `test/extensions/pi-gate/index.test.ts` | Replace `withTempDir`, use event capture helper |
| `test/extensions/pi-gate/prompts.test.ts` | Optionally adopt `createQueuedUIContext` |
| `test/extensions/plan-mode/index.test.ts` | Replace `withTempDir`, remove `withTempDirAsync`, inline harness setup with new `withTempDir`, mock API factory, event capture |
| `test/extensions/plan-mode/plan-artifact.test.ts` | None — already minimal |

## Existing utilities to reuse

- `test/utils/pi-context.ts` — `createUIContext`, `createExtensionContext`, `createCommandContext`, `createSessionManagerStub`
- `test/utils/pi-harness.ts` — `createPiTestHarness`, `PiTestHarness`

## Structural diagram

```
test/utils/
├── pi-context.ts          (existing)  UI/context stubs + createQueuedUIContext
├── pi-harness.ts          (existing)  extension loader + standalone captureEvents helper
├── temp-dir.ts            (new)       withTempDir (sync + async)
└── mock-pi-api.ts         (new)       createMockExtensionAPI

test/extensions/pi-gate/utils/
└── config.ts              (new)       createConfigResult

test/extensions/
├── error-logger/*.test.ts  -> import withTempDir
├── pi-gate/*.test.ts       -> import temp-dir, ./utils/config, createQueuedUIContext
└── plan-mode/*.test.ts     -> import temp-dir, mock-pi-api, captureEvents
```

## Verification

Run full verification sequence after refactor:

```bash
npm test
npm run typecheck
npx eslint .
npm run format:check
```

Expected result: all tests pass, no type errors, no lint errors, formatting clean. Since only test code moves, behavior should be unchanged.

**Risk note:** `pi-gate/bash-guard.test.ts` and `pi-gate/file-access.test.ts` currently call `withTempDir(async (dir) => { ... })` without `await` or `return` inside async tests. The tests pass vacuously today. Once the new `withTempDir` is awaited, hidden failures may surface and must be fixed as part of this refactor.

## Decisions

User clarified all questions:

1. Add `createQueuedUIContext` to `test/utils/pi-context.ts` and build a full `ExtensionContext` via `createExtensionContext`.
2. Refactor `prompts.test.ts` to use `createQueuedUIContext`.
3. Use a minimal local `MockedExtensionAPI` interface and return `as unknown as ExtensionAPI`.
4. Add standalone `captureEvents(harness, eventName)` returning `unknown[]`.
5. Inline `withPlanModeHarness` with new `withTempDir` instead of extracting a generic helper.
6. Fix unawaited `withTempDir` calls and address any surfaced test failures during implementation.
