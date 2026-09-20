import { strictEqual, deepStrictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type PiGateConfig,
  loadConfig,
  saveConfig,
  normalizeExternalEntry,
} from '../../../extensions/pi-gate/config.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

test('normalizeExternalEntry expands paths and preserves glob-led entries', () => {
  strictEqual(normalizeExternalEntry('~/.pi', '/cwd'), join(homedir(), '.pi'));
  strictEqual(normalizeExternalEntry('logs/*', '/cwd'), '/cwd/logs/*');
  strictEqual(normalizeExternalEntry('/abs/*', '/cwd'), '/abs/*');
  strictEqual(normalizeExternalEntry('*', '/cwd'), '*');
  strictEqual(normalizeExternalEntry('?tmp', '/cwd'), '?tmp');
});

test('loadConfig returns merged config from project file', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({
        bashAllow: ['ls *'],
        externalAllow: ['/tmp/*'],
      }),
    );

    const result = loadConfig(dir);
    // Project config should have the values we set
    deepStrictEqual(result.project.bashAllow, ['ls *']);
    deepStrictEqual(result.project.externalAllow, ['/tmp/*']);
    // Merged should include project values (may also include global values)
    strictEqual(result.merged.bashAllow.includes('ls *'), true);
    strictEqual(result.merged.externalAllow.includes('/tmp/*'), true);
  });
});

test('loadConfig merges global and project configs', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({
        bashAllow: ['project-cmd *'],
        externalAllow: ['/project/*'],
      }),
    );

    const result = loadConfig(dir);
    // Project should have the values
    deepStrictEqual(result.project.bashAllow, ['project-cmd *']);
    deepStrictEqual(result.project.externalAllow, ['/project/*']);
    // Merged should include project config (may also include global values)
    strictEqual(result.merged.bashAllow.includes('project-cmd *'), true);
    strictEqual(result.merged.externalAllow.includes('/project/*'), true);
  });
});

test('loadConfig returns empty project config when project file missing', () => {
  withTempDir('pi-gate-', (dir) => {
    const result = loadConfig(dir);
    // Project should be empty when no project file exists
    deepStrictEqual(result.project.bashAllow, []);
    deepStrictEqual(result.project.externalAllow, []);
  });
});

test('loadConfig handles empty project file', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'pi-gate.json'), '');

    const result = loadConfig(dir);
    // Project should be empty when file is empty
    deepStrictEqual(result.project.bashAllow, []);
    deepStrictEqual(result.project.externalAllow, []);
  });
});

test('saveConfig and reload roundtrip preserves data', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    const configPath = join(projectConfigDir, 'pi-gate.json');

    const original: PiGateConfig = {
      bashAllow: ['cat *'],
      externalAllow: ['/etc/*'],
    };
    saveConfig(original, configPath);
    const result = loadConfig(dir);
    deepStrictEqual(result.project.bashAllow, ['cat *']);
    deepStrictEqual(result.project.externalAllow, ['/etc/*']);
  });
});

test('append to project bashAllow and save', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });

    const result = loadConfig(dir);
    result.project.bashAllow.push('git *');
    saveConfig(result.project, result.projectPath);

    const reloaded = loadConfig(dir);
    deepStrictEqual(reloaded.project.bashAllow, ['git *']);
  });
});

test('append to project externalAllow and save', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });

    const result = loadConfig(dir);
    result.project.externalAllow.push('/var/log/*');
    saveConfig(result.project, result.projectPath);

    const reloaded = loadConfig(dir);
    deepStrictEqual(reloaded.project.externalAllow, ['/var/log/*']);
  });
});

test('malformed JSON in project file throws error with clear message', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    const configPath = join(projectConfigDir, 'pi-gate.json');
    writeFileSync(configPath, '{ not json');

    throws(
      () => loadConfig(dir),
      (err: Error) =>
        err instanceof SyntaxError && err.message.includes(configPath) && err.message.includes('trailing comma'),
    );
  });
});

test('save creates parent directories if needed', () => {
  withTempDir('pi-gate-', (dir) => {
    const nested = join(dir, 'a', 'b', 'c');
    const configPath = join(nested, 'pi-gate.json');
    const config: PiGateConfig = { bashAllow: [], externalAllow: [] };
    saveConfig(config, configPath);
    const stat = statSync(join(nested, 'pi-gate.json'));
    strictEqual(stat.isFile(), true);
  });
});

test('atomic save operation (temp file + rename)', () => {
  withTempDir('pi-gate-', (dir) => {
    const configPath = join(dir, 'pi-gate.json');
    const config: PiGateConfig = {
      bashAllow: ['ls'],
      externalAllow: [],
    };
    saveConfig(config, configPath);
    const entries = readdirSync(dir);
    strictEqual(entries.includes('pi-gate.json'), true);
  });
});

test('loadConfig normalizes tilde and relative externalAllow entries to absolute paths', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({ bashAllow: [], externalAllow: ['~/.pi', 'tmp/logs/*', '/abs/*'] }),
    );

    // Explicit global path so the developer's real ~/.pi config is not merged in.
    const result = loadConfig(dir, join(dir, 'missing-global.json'));
    // A raw `~/.pi` entry could never match a normalized probe path, so it must
    // be expanded at load time (regression: pi-gate always re-prompted for
    // `~/.pi` despite the entry being present in the config file).
    deepStrictEqual(result.project.externalAllow, [join(homedir(), '.pi'), join(dir, 'tmp', 'logs', '*'), '/abs/*']);
    deepStrictEqual(result.merged.externalAllow, result.project.externalAllow);
  });
});

test('loadConfig leaves glob-led externalAllow entries unscoped', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ externalAllow: ['*', '?tmp'] }));

    const result = loadConfig(dir, globalPath);
    // A bare `*` means "any external path"; resolving it against cwd would
    // silently narrow it to the project tree.
    deepStrictEqual(result.global.externalAllow, ['*', '?tmp']);
  });
});

test('loadConfig normalizes global and project externalAllow entries with the same cwd', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ externalAllow: ['~/shared'] }));
    writeFileSync(join(projectConfigDir, 'pi-gate.json'), JSON.stringify({ externalAllow: ['../outside'] }));

    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global.externalAllow, [join(homedir(), 'shared')]);
    deepStrictEqual(result.project.externalAllow, [join(dir, '..', 'outside')]);
    deepStrictEqual(result.merged.externalAllow, [join(homedir(), 'shared'), join(dir, '..', 'outside')]);
  });
});

test('ConfigResult paths are correct', () => {
  withTempDir('pi-gate-', (dir) => {
    const result = loadConfig(dir);
    strictEqual(result.projectPath, join(dir, '.pi', 'pi-gate.json'));
    strictEqual(result.globalPath, join(homedir(), '.pi', 'agent', 'pi-gate.json'));
  });
});

test('loadConfig preserves commandVerificationModel from the global config only', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ commandVerificationModel: 'p/m' }));

    const result = loadConfig(dir, globalPath);
    strictEqual(result.global.commandVerificationModel, 'p/m');
    // Never merged into the effective whitelist config.
    strictEqual(result.merged.commandVerificationModel, undefined);
  });
});

test('loadConfig parses commandVerificationModel from a project file but it stays project-scoped', () => {
  withTempDir('pi-gate-', (dir) => {
    const projectConfigDir = join(dir, '.pi');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({ bashAllow: [], externalAllow: [], commandVerificationModel: 'p/m' }),
    );

    const result = loadConfig(dir);
    strictEqual(result.project.commandVerificationModel, 'p/m');
    strictEqual(result.merged.commandVerificationModel, undefined);
  });
});

test('saveConfig round-trip preserves commandVerificationModel', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    const original: PiGateConfig = {
      bashAllow: ['cat *'],
      externalAllow: ['/etc/*'],
      commandVerificationModel: 'p/m',
    };
    saveConfig(original, globalPath);

    const result = loadConfig(dir, globalPath);
    strictEqual(result.global.commandVerificationModel, 'p/m');
    deepStrictEqual(result.global.bashAllow, ['cat *']);
  });
});

test('non-string commandVerificationModel falls back to an empty config', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ commandVerificationModel: 42 }));

    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global, { bashAllow: [], externalAllow: [] });
  });
});

test('config with only commandVerificationModel loads with defaulted arrays', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ commandVerificationModel: 'p/m' }));

    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global.bashAllow, []);
    deepStrictEqual(result.global.externalAllow, []);
    strictEqual(result.global.commandVerificationModel, 'p/m');
  });
});

test('config with only one allow array defaults the other to empty', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ bashAllow: ['ls *'] }));

    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global.bashAllow, ['ls *']);
    deepStrictEqual(result.global.externalAllow, []);
  });
});

test('present-but-malformed allow array still rejects the whole config', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ bashAllow: [1, 2], commandVerificationModel: 'p/m' }));

    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global, { bashAllow: [], externalAllow: [] });
  });
});

test('explicit null for an allow array is malformed and rejects the whole config', () => {
  withTempDir('pi-gate-', (dir) => {
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify({ bashAllow: null, commandVerificationModel: 'p/m' }));

    // The whole file falls back to empty, so the valid model setting is
    // discarded rather than silently honored alongside the null array.
    const result = loadConfig(dir, globalPath);
    deepStrictEqual(result.global, { bashAllow: [], externalAllow: [] });
  });
});
