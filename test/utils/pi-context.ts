import { mock } from 'node:test';
import type {
  ExtensionUIContext,
  ExtensionContext,
  ExtensionCommandContext,
  SessionManager,
  ModelRegistry,
} from '@mariozechner/pi-coding-agent';

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
    getHeader: mock.fn(() => null),
    getEntries: mock.fn(() => []),
    getTree: mock.fn(() => []),
    getSessionName: mock.fn(() => undefined),
    ...overrides,
  } as ReadonlySessionManager;
}

function createModelRegistryStub(): ModelRegistry {
  return {
    authStorage: {} as ModelRegistry['authStorage'],
    refresh: mock.fn(),
    getError: mock.fn(() => undefined),
    getAll: mock.fn(() => []),
    getAvailable: mock.fn(() => []),
    find: mock.fn(() => undefined),
    hasConfiguredAuth: mock.fn(() => false),
    getApiKeyAndHeaders: mock.fn(async () => ({ ok: false, error: 'stub' })),
    getProviderAuthStatus: mock.fn(() => ({ status: 'none' as const })),
    getProviderDisplayName: mock.fn(() => ''),
    getApiKeyForProvider: mock.fn(async () => undefined),
    isUsingOAuth: mock.fn(() => false),
    registerProvider: mock.fn(),
    unregisterProvider: mock.fn(),
  } as unknown as ModelRegistry;
}

/** Build an ExtensionContext where every method is a `node:test` mock.fn() spy. */
export function createExtensionContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const ui = overrides.ui ?? createUIContext();
  const sessionManager = overrides.sessionManager ?? createSessionManagerStub();
  const base: ExtensionContext = {
    cwd: overrides.cwd ?? process.cwd(),
    hasUI: overrides.hasUI ?? true,
    ui,
    sessionManager,
    modelRegistry: overrides.modelRegistry ?? createModelRegistryStub(),
    model: overrides.model ?? undefined,
    isIdle: mock.fn(() => true),
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
