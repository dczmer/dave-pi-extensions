import type {
  Extension,
  ExtensionFactory,
  ExtensionRuntime,
  EventBus,
  ExtensionContext,
  ExtensionCommandContext,
} from '@mariozechner/pi-coding-agent';
import { createEventBus, createExtensionRuntime } from '@mariozechner/pi-coding-agent';
import { createCommandContext, createExtensionContext } from './pi-context.ts';

export interface PiTestHarness {
  cwd: string;
  extension: Extension;
  runtime: ExtensionRuntime;
  eventBus: EventBus;
  command(name: string): {
    execute(args?: string, overrides?: Partial<ExtensionCommandContext>): Promise<ExtensionCommandContext>;
  };
  tool(name: string): {
    execute(params: Record<string, unknown>): Promise<unknown>;
  };
  emitEvent(
    eventName: string,
    event: unknown,
    ctxOverrides?: Partial<ExtensionContext>,
  ): Promise<{ results: unknown[]; ctx: ExtensionContext }>;
  listRegisteredCommands(): string[];
  listRegisteredTools(): string[];
}

async function loadExtensionFromFactoryInternal(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  extensionPath?: string,
): Promise<Extension> {
  const indexPath = await import.meta.resolve('@mariozechner/pi-coding-agent');
  const loaderPath = indexPath.replace('/index.js', '/core/extensions/loader.js');
  const { loadExtensionFromFactory } = await import(loaderPath);
  return loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath);
}

/** Load an extension through real pi internals and return a test harness. */
export async function createPiTestHarness(
  factory: ExtensionFactory,
  cwd: string = process.cwd(),
): Promise<PiTestHarness> {
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactoryInternal(factory, cwd, eventBus, runtime);

  return {
    cwd,
    extension,
    runtime,
    eventBus,
    command(name: string) {
      const cmd = extension.commands.get(name);
      if (!cmd) {
        throw new Error(`Command "${name}" not registered on extension`);
      }
      return {
        async execute(args?: string, overrides?: Partial<ExtensionCommandContext>) {
          const ctx = createCommandContext({ cwd, ...overrides });
          await cmd.handler(args ?? '', ctx);
          return ctx;
        },
      };
    },
    tool(name: string) {
      const registered = extension.tools.get(name);
      if (!registered) {
        throw new Error(`Tool "${name}" not registered on extension`);
      }
      return {
        async execute(params: Record<string, unknown>) {
          const ctx = createCommandContext({ cwd });
          return registered.definition.execute('test-call-id', params, undefined, undefined, ctx);
        },
      };
    },
    async emitEvent(eventName: string, event: unknown, ctxOverrides?: Partial<ExtensionContext>) {
      const handlers = extension.handlers.get(eventName) ?? [];
      const ctx = createExtensionContext({ cwd, ...ctxOverrides });
      const results: unknown[] = [];
      for (const handler of handlers) {
        results.push(await handler(event, ctx));
      }
      return { results, ctx };
    },
    listRegisteredCommands() {
      return Array.from(extension.commands.keys());
    },
    listRegisteredTools() {
      return Array.from(extension.tools.keys());
    },
  };
}
