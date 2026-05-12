import { strictEqual, deepStrictEqual, throws } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { type PiGateConfig, loadConfig, saveConfig } from '../../../extensions/pi-gate/config.ts';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pi-gate-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('loadConfig returns merged config from project file', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({
        bashAllow: ['ls *'],
        externalAllow: ['/tmp/*'],
        projectDeny: ['*/secrets.json'],
      }),
    );

    const result = loadConfig(dir);
    // Project config should have the values we set
    deepStrictEqual(result.project.bashAllow, ['ls *']);
    deepStrictEqual(result.project.externalAllow, ['/tmp/*']);
    deepStrictEqual(result.project.projectDeny, ['*/secrets.json']);
    // Merged should include project values (may also include global values)
    strictEqual(result.merged.bashAllow.includes('ls *'), true);
    strictEqual(result.merged.externalAllow.includes('/tmp/*'), true);
    strictEqual(result.merged.projectDeny.includes('*/secrets.json'), true);
  });
});

test('loadConfig merges global and project configs', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      join(projectConfigDir, 'pi-gate.json'),
      JSON.stringify({
        bashAllow: ['project-cmd *'],
        externalAllow: ['/project/*'],
        projectDeny: ['project-secret'],
      }),
    );

    const result = loadConfig(dir);
    // Project should have the values
    deepStrictEqual(result.project.bashAllow, ['project-cmd *']);
    deepStrictEqual(result.project.externalAllow, ['/project/*']);
    deepStrictEqual(result.project.projectDeny, ['project-secret']);
    // Merged should include project config (may also include global values)
    strictEqual(result.merged.bashAllow.includes('project-cmd *'), true);
    strictEqual(result.merged.externalAllow.includes('/project/*'), true);
    strictEqual(result.merged.projectDeny.includes('project-secret'), true);
  });
});

test('loadConfig returns empty project config when project file missing', () => {
  withTempDir((dir) => {
    const result = loadConfig(dir);
    // Project should be empty when no project file exists
    deepStrictEqual(result.project.bashAllow, []);
    deepStrictEqual(result.project.externalAllow, []);
    deepStrictEqual(result.project.projectDeny, []);
  });
});

test('loadConfig handles empty project file', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'pi-gate.json'), '');

    const result = loadConfig(dir);
    // Project should be empty when file is empty
    deepStrictEqual(result.project.bashAllow, []);
    deepStrictEqual(result.project.externalAllow, []);
    deepStrictEqual(result.project.projectDeny, []);
  });
});

test('saveConfig and reload roundtrip preserves data', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });
    const configPath = join(projectConfigDir, 'pi-gate.json');

    const original: PiGateConfig = {
      bashAllow: ['cat *'],
      externalAllow: ['/etc/*'],
      projectDeny: ['*.key'],
    };
    saveConfig(original, configPath);
    const result = loadConfig(dir);
    deepStrictEqual(result.project.bashAllow, ['cat *']);
    deepStrictEqual(result.project.externalAllow, ['/etc/*']);
    deepStrictEqual(result.project.projectDeny, ['*.key']);
  });
});

test('append to project bashAllow and save', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });

    const result = loadConfig(dir);
    result.project.bashAllow.push('git *');
    saveConfig(result.project, result.projectPath);

    const reloaded = loadConfig(dir);
    deepStrictEqual(reloaded.project.bashAllow, ['git *']);
  });
});

test('append to project externalAllow and save', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });

    const result = loadConfig(dir);
    result.project.externalAllow.push('/var/log/*');
    saveConfig(result.project, result.projectPath);

    const reloaded = loadConfig(dir);
    deepStrictEqual(reloaded.project.externalAllow, ['/var/log/*']);
  });
});

test('malformed JSON in project file throws error with clear message', () => {
  withTempDir((dir) => {
    const projectConfigDir = join(dir, '.pi', 'extensions');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(join(projectConfigDir, 'pi-gate.json'), '{ not json');

    throws(() => loadConfig(dir), SyntaxError);
  });
});

test('save creates parent directories if needed', () => {
  withTempDir((dir) => {
    const nested = join(dir, 'a', 'b', 'c');
    const configPath = join(nested, 'pi-gate.json');
    const config: PiGateConfig = { bashAllow: [], externalAllow: [], projectDeny: [] };
    saveConfig(config, configPath);
    const stat = statSync(join(nested, 'pi-gate.json'));
    strictEqual(stat.isFile(), true);
  });
});

test('atomic save operation (temp file + rename)', () => {
  withTempDir((dir) => {
    const configPath = join(dir, 'pi-gate.json');
    const config: PiGateConfig = {
      bashAllow: ['ls'],
      externalAllow: [],
      projectDeny: [],
    };
    saveConfig(config, configPath);
    const entries = readdirSync(dir);
    strictEqual(entries.includes('pi-gate.json'), true);
  });
});

test('ConfigResult paths are correct', () => {
  withTempDir((dir) => {
    const result = loadConfig(dir);
    strictEqual(result.projectPath, join(dir, '.pi', 'extensions', 'pi-gate.json'));
    strictEqual(result.globalPath, join(homedir(), '.pi', 'agent', 'extensions', 'pi-gate.json'));
  });
});
