import { strictEqual, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { checkBashCommand, parseCommandStatements } from '../../../extensions/pi-gate/bash-guard.ts';
import { resetSessionState, approveBashPattern } from '../../../extensions/pi-gate/session.ts';
import { withTempDir } from '../../utils/temp-dir.ts';
import { createQueuedUIContext } from '../../utils/pi-context.ts';
import { createConfigResult } from './utils/config.ts';

test('command allowed by config bashAllow pattern', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['ls *'], externalAllow: [] },
    project: { bashAllow: ['ls *'], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('ls -la', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('command allowed by session approved pattern', async () => {
  resetSessionState();
  approveBashPattern('cat *');
  const configResult = createConfigResult({
    merged: { bashAllow: [], externalAllow: [] },
    project: { bashAllow: [], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('cat file.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('command with project files all allowed', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['cat *'], externalAllow: [] },
    project: { bashAllow: ['cat *'], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('cat main.ts', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('command with external files all allowed', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['cat *'], externalAllow: ['/tmp/*'] },
    project: { bashAllow: ['cat *'], externalAllow: ['/tmp/*'] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('cat /tmp/foo.txt', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('no match prompts user, allows, persists to project, recurses, succeeds', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('xyz-custom-cmd *');
    ctx.queueSelect('Project');

    const result = await checkBashCommand('xyz-custom-cmd arg', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, ['xyz-custom-cmd *']);

    const saved = JSON.parse(readFileSync(projectPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: ['xyz-custom-cmd *'], externalAllow: [] });
  });
});

test('no match prompts user, allows, persists to global, recurses, succeeds', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('abc-global-test-cmd *');
    ctx.queueSelect('Global');

    const result = await checkBashCommand('abc-global-test-cmd arg', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, []);
    deepStrictEqual(configResult.global.bashAllow, ['abc-global-test-cmd *']);

    const saved = JSON.parse(readFileSync(globalPath, 'utf-8'));
    deepStrictEqual(saved, { bashAllow: ['abc-global-test-cmd *'], externalAllow: [] });
  });
});

test('no match prompts user, allows, skips persist, recurses, succeeds', async () => {
  await withTempDir('pi-gate-', async (dir) => {
    const projectPath = join(dir, '.pi', 'extensions', 'pi-gate.json');
    const globalPath = join(dir, 'global.json');
    mkdirSync(dirname(projectPath), { recursive: true });

    const configResult = createConfigResult({ projectPath, globalPath });
    const ctx = createQueuedUIContext();
    ctx.queueEditor('def-skip-test-cmd *');
    ctx.queueSelect('No');

    const result = await checkBashCommand('def-skip-test-cmd arg', dir, configResult, ctx);
    strictEqual(result, true);
    deepStrictEqual(configResult.project.bashAllow, []);
    deepStrictEqual(configResult.global.bashAllow, []);

    strictEqual(existsSync(projectPath), false);
    strictEqual(existsSync(globalPath), false);
  });
});

test('user denies command at prompt', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueEditor(null);

  const result = await checkBashCommand('rm -rf /', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('user allows command but clears pattern', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueEditor('');

  const result = await checkBashCommand('rm -rf /', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('command with no file arguments', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['ls *'], externalAllow: [] },
    project: { bashAllow: ['ls *'], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('ls -la', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test("recursion doesn't cause infinite loop", async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueEditor('custom-cmd *');
  ctx.queueSelect('No');

  const result = await checkBashCommand('custom-cmd arg', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('parseCommandStatements: simple command', () => {
  const result = parseCommandStatements('ls -la');
  deepStrictEqual(result, ['ls -la']);
});

test('parseCommandStatements: cd && npm test', () => {
  const result = parseCommandStatements('cd /home/dave && npm test');
  deepStrictEqual(result, ['cd /home/dave', 'npm test']);
});

test('parseCommandStatements: cd /path && cmd', () => {
  const result = parseCommandStatements('cd /some/path && ls -la');
  deepStrictEqual(result, ['cd /some/path', 'ls -la']);
});

test('parseCommandStatements: semicolon separator', () => {
  const result = parseCommandStatements('cd /home; ls');
  deepStrictEqual(result, ['cd /home', 'ls']);
});

test('parseCommandStatements: multiple semicolons', () => {
  const result = parseCommandStatements('echo a; echo b; echo c');
  deepStrictEqual(result, ['echo a', 'echo b', 'echo c']);
});

test('parseCommandStatements: || separator', () => {
  const result = parseCommandStatements("cat file || echo 'not found'");
  deepStrictEqual(result, ['cat file', "echo 'not found'"]);
});

test('parseCommandStatements: mixed separators', () => {
  const result = parseCommandStatements('cd /tmp && ls || echo fail; echo done');
  deepStrictEqual(result, ['cd /tmp', 'ls', 'echo fail', 'echo done']);
});

test('parseCommandStatements: command substitution $(...)', () => {
  const result = parseCommandStatements('echo "my name is $(whoami)."');
  deepStrictEqual(result, ['echo "my name is $(whoami)."', 'whoami']);
});

test('parseCommandStatements: multiple substitutions', () => {
  const result = parseCommandStatements('echo $(date) && echo $(pwd)');
  deepStrictEqual(result, ['echo $(date)', 'date', 'echo $(pwd)', 'pwd']);
});

test('parseCommandStatements: nested substitutions', () => {
  const result = parseCommandStatements('echo $(echo $(whoami))');
  strictEqual(result, null);
});

test('parseCommandStatements: handles quoted strings with separators', () => {
  const result = parseCommandStatements('echo "foo && bar" && ls');
  deepStrictEqual(result, ['echo "foo && bar"', 'ls']);
});

test('parseCommandStatements: heredoc with && inside not split', () => {
  const cmd = `cat <<EOF
Fix bug && close issue
Handle edge; case properly
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test('parseCommandStatements: heredoc with <<- strips leading tabs', () => {
  const cmd = `cat <<-EOF
\t\tcontent with && and ;
\tEOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test('parseCommandStatements: quoted heredoc delimiter', () => {
  const cmd = `cat <<'EOF'
Fix bug && close issue
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test('parseCommandStatements: heredoc followed by && command', () => {
  const cmd = `cat <<EOF
content
EOF && echo done`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test('parseCommandStatements: git commit with heredoc message', () => {
  const cmd = `git commit -F - <<EOF
Fix bug && close issue

Handle edge; case properly
EOF`;
  const result = parseCommandStatements(cmd);
  strictEqual(result, null);
});

test('compound command: all statements allowed', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['cd *', 'ls *'], externalAllow: [] },
    project: { bashAllow: ['cd *', 'ls *'], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();
  const result = await checkBashCommand('cd subdir && ls -la', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
});

test('compound command: one statement denied', async () => {
  const configResult = createConfigResult({
    merged: { bashAllow: ['cd *'], externalAllow: [] },
    project: { bashAllow: ['cd *'], externalAllow: [] },
    global: { bashAllow: [], externalAllow: [] },
  });
  const ctx = createQueuedUIContext();

  const result = await checkBashCommand('cd /home && rm -rf /', '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
});

test('unparsable command: user confirms allows', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueConfirm(true);

  const result = await checkBashCommand('echo $(echo $(whoami))', '/fake/cwd', configResult, ctx);
  strictEqual(result, true);
  strictEqual(ctx._notifications.length, 1);
  strictEqual(ctx._notifications[0]!.message, 'Command not parsable — manual approval required');
  strictEqual(ctx._notifications[0]!.level, 'warning');
});

test('unparsable command: user rejects blocks', async () => {
  const configResult = createConfigResult();
  const ctx = createQueuedUIContext();
  ctx.queueConfirm(false);

  const result = await checkBashCommand("echo 'unclosed", '/fake/cwd', configResult, ctx);
  strictEqual(result, false);
  strictEqual(ctx._notifications.length, 1);
  strictEqual(ctx._notifications[0]!.message, 'Command not parsable — manual approval required');
});
