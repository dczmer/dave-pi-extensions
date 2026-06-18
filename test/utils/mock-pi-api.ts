import { mock, type Mock } from 'node:test';
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

/**
 * Build a minimal mock ExtensionAPI for tests that exercise extension
 * registration and lifecycle without loading through real pi internals.
 *
 * @param options - Optional overrides, including a custom `getFlag` impl.
 * @returns A mock API cast to ExtensionAPI.
 */
export function createMockExtensionAPI(options?: {
  getFlag?: (name: string) => boolean | string | undefined;
}): MockedExtensionAPI {
  return {
    registerFlag: mock.fn(),
    getFlag: mock.fn(options?.getFlag ?? (() => false)),
    registerCommand: mock.fn(),
    registerShortcut: mock.fn(),
    on: mock.fn(),
    sendMessage: mock.fn(),
    events: { emit: mock.fn() },
    appendEntry: mock.fn(),
  } as unknown as MockedExtensionAPI;
}
