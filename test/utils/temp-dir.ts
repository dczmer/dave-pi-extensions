import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a temporary directory, run a callback, and clean up afterwards.
 *
 * Works with both synchronous and asynchronous callbacks. Async callbacks must
 * be awaited so cleanup runs before the test completes.
 *
 * @param prefix - Temp directory prefix (e.g. `"pi-gate-"`).
 * @param fn - Callback that receives the temp directory path.
 * @returns The callback's return value, or a promise for it.
 */
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T;
export function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): T | Promise<T> {
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
