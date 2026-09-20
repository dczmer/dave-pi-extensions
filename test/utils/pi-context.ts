import { mock } from 'node:test';
import type {
  ExtensionUIContext,
  ExtensionContext,
  ExtensionCommandContext,
  SessionManager,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Context, Model, ModelsApiStreamOptions, StopReason } from '@earendil-works/pi-ai';

type ReadonlySessionManager = Pick<
  SessionManager,
  | 'getCwd'
  | 'getSessionDir'
  | 'getSessionId'
  | 'getSessionFile'
  | 'getLeafId'
  | 'getLeafEntry'
  | 'getEntry'
  | 'getLabel'
  | 'getBranch'
  | 'buildContextEntries'
  | 'getHeader'
  | 'getEntries'
  | 'getTree'
  | 'getSessionName'
>;

function createMockTheme(): ExtensionUIContext['theme'] {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => '',
    getBgAnsi: () => '',
    getColorMode: () => 'truecolor' as const,
    getThinkingBorderColor: () => (str: string) => str,
    getBashModeBorderColor: () => (str: string) => str,
  } as unknown as ExtensionUIContext['theme'];
}

/** Build an ExtensionUIContext where every method is a `node:test` mock.fn() spy. */
export function createUIContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
  return {
    select: mock.fn(async () => undefined),
    confirm: mock.fn(async () => false),
    input: mock.fn(async () => undefined),
    notify: mock.fn(),
    onTerminalInput: mock.fn(() => () => {}),
    setStatus: mock.fn(),
    setWorkingMessage: mock.fn(),
    setWorkingVisible: mock.fn(),
    setWorkingIndicator: mock.fn(),
    setHiddenThinkingLabel: mock.fn(),
    setWidget: mock.fn(),
    setFooter: mock.fn(),
    setHeader: mock.fn(),
    setTitle: mock.fn(),
    custom: mock.fn(async () => undefined as unknown),
    pasteToEditor: mock.fn(),
    setEditorText: mock.fn(),
    getEditorText: mock.fn(() => ''),
    editor: mock.fn(async () => undefined),
    addAutocompleteProvider: mock.fn(),
    setEditorComponent: mock.fn(),
    getEditorComponent: mock.fn(() => undefined),
    theme: createMockTheme(),
    getAllThemes: mock.fn(() => []),
    getTheme: mock.fn(() => undefined),
    setTheme: mock.fn(() => ({ success: true })),
    getToolsExpanded: mock.fn(() => false),
    setToolsExpanded: mock.fn(),
    ...overrides,
  } as ExtensionUIContext;
}

export function createSessionManagerStub(overrides: Partial<ReadonlySessionManager> = {}): ReadonlySessionManager {
  return {
    getCwd: mock.fn(() => ''),
    getSessionDir: mock.fn(() => ''),
    getSessionId: mock.fn(() => ''),
    getSessionFile: mock.fn(() => undefined),
    getLeafId: mock.fn(() => null),
    getLeafEntry: mock.fn(() => undefined),
    getEntry: mock.fn(() => undefined),
    getLabel: mock.fn(() => undefined),
    getBranch: mock.fn(() => []),
    buildContextEntries: mock.fn(() => []),
    getHeader: mock.fn(() => null),
    getEntries: mock.fn(() => []),
    getTree: mock.fn(() => []),
    getSessionName: mock.fn(() => undefined),
    ...overrides,
  } as ReadonlySessionManager;
}

/** Build the minimal complete `AssistantMessage` literal (every field mandatory in 0.85.1). */
export function createAssistantMessage(text: string, stopReason: StopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export interface ModelRegistryStubOptions {
  /** Models resolved by `find(provider, modelId)`. */
  models?: Model<any>[];
  /** Implementation for `complete`; defaults to a `VERDICT: YES` message. */
  complete?: (model: Model<any>, context: Context, options?: ModelsApiStreamOptions<any>) => Promise<AssistantMessage>;
}

/**
 * Build a `ModelRegistry` stub whose `find` resolves from `models`, whose
 * `hasConfiguredAuth` returns true, and whose `complete` is a `mock.fn()`
 * resolving to a configurable assistant message.
 */
export function createModelRegistryStub(options: ModelRegistryStubOptions = {}): ModelRegistry {
  const models = options.models ?? [];
  const completeImpl = options.complete ?? (async () => createAssistantMessage('VERDICT: YES'));
  return {
    refresh: mock.fn(),
    getError: mock.fn(() => undefined),
    getAll: mock.fn(() => models),
    getAvailable: mock.fn(() => models),
    find: mock.fn((provider: string, modelId: string) =>
      models.find((m) => {
        const model = m as { provider?: string; id?: string };
        return model.provider === provider && model.id === modelId;
      }),
    ),
    hasConfiguredAuth: mock.fn(() => true),
    getApiKeyAndHeaders: mock.fn(async () => ({ ok: false, error: 'stub' })),
    getProviderAuthStatus: mock.fn(() => ({ status: 'none' as const })),
    getProviderDisplayName: mock.fn(() => ''),
    getApiKeyForProvider: mock.fn(async () => undefined),
    isUsingOAuth: mock.fn(() => false),
    registerProvider: mock.fn(),
    unregisterProvider: mock.fn(),
    complete: mock.fn(completeImpl),
  } as unknown as ModelRegistry;
}

/** Build an ExtensionContext where every method is a `node:test` mock.fn() spy. */
export function createExtensionContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const ui = overrides.ui ?? createUIContext();
  const sessionManager = overrides.sessionManager ?? createSessionManagerStub();
  const base: ExtensionContext = {
    cwd: overrides.cwd ?? process.cwd(),
    mode: overrides.mode ?? 'tui',
    hasUI: overrides.hasUI ?? true,
    ui,
    sessionManager,
    modelRegistry: overrides.modelRegistry ?? createModelRegistryStub(),
    model: overrides.model ?? undefined,
    scopedModels: overrides.scopedModels ?? [],
    isIdle: mock.fn(() => true),
    isProjectTrusted: mock.fn(() => true),
    signal: overrides.signal ?? undefined,
    abort: mock.fn(),
    hasPendingMessages: mock.fn(() => false),
    shutdown: mock.fn(),
    getContextUsage: mock.fn(() => undefined),
    compact: mock.fn(),
    getSystemPrompt: mock.fn(() => ''),
  };
  return Object.assign({}, base, overrides, { ui, sessionManager }) as ExtensionContext;
}

/** ExtensionContext whose editor/select/confirm calls drain queued values. */
export interface QueuedUIContext extends ExtensionContext {
  _notifications: Array<{ message: string; level: string }>;
  queueEditor(value: string | null): void;
  queueSelect(value: string | null): void;
  queueConfirm(value: boolean): void;
}

/**
 * Build a full ExtensionContext with queue-backed UI inputs.
 *
 * Useful for testing code paths that prompt the user via editor, select, or
 * confirm and emit notifications.
 */
export function createQueuedUIContext(overrides: Partial<ExtensionContext> = {}): QueuedUIContext {
  const base = createExtensionContext(overrides);
  const editorQueue: (string | null)[] = [];
  const selectQueue: (string | null)[] = [];
  const confirmQueue: boolean[] = [];
  const notifications: Array<{ message: string; level: string }> = [];

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const ctx = Object.assign(base, {
    ui: {
      ...base.ui,
      editor: async (_title: string, _prefill?: string) => editorQueue.shift() ?? undefined,
      select: async <T extends string>(_title: string, _options: T[]) =>
        (selectQueue.shift() ?? undefined) as T | undefined,
      confirm: async (_title: string, _message: string) => confirmQueue.shift() ?? false,
      notify: (message: string, level: 'info' | 'warning' | 'error' = 'info') => {
        notifications.push({ message, level });
      },
    },
    _notifications: notifications,
    queueEditor: (v: string | null) => editorQueue.push(v),
    queueSelect: (v: string | null) => selectQueue.push(v),
    queueConfirm: (v: boolean) => confirmQueue.push(v),
  });
  /* eslint-enable @typescript-eslint/no-unused-vars */

  return ctx as QueuedUIContext;
}

/** Build an ExtensionCommandContext where every method is a `node:test` mock.fn() spy. */
export function createCommandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  const base = createExtensionContext(overrides);
  const commandExtras = {
    waitForIdle: mock.fn(async () => {}),
    newSession: mock.fn(async () => ({ cancelled: false })),
    fork: mock.fn(async () => ({ cancelled: false })),
    navigateTree: mock.fn(async () => ({ cancelled: false })),
    switchSession: mock.fn(async () => ({ cancelled: false })),
    reload: mock.fn(async () => {}),
  };
  return Object.assign({}, base, commandExtras, overrides) as ExtensionCommandContext;
}
