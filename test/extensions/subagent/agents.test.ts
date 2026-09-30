import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverAgents, findNearestProjectAgentsDir, type AgentDirs } from '../../../extensions/subagent/agents.ts';
import { withTempDir } from '../../utils/temp-dir.ts';

function writeAgent(dir: string, filename: string, frontmatter: string, body = 'You are a test agent.'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Build injected dirs rooted at a temp dir; all tiers exist but start empty. */
function makeDirs(root: string): AgentDirs {
  return {
    bundled: join(root, 'bundled'),
    user: join(root, 'user'),
    project: join(root, 'project'),
  };
}

test('precedence: project > user > bundled on name collision', () => {
  withTempDir('subagent-agents-', (dir) => {
    const dirs = makeDirs(dir);
    writeAgent(dirs.bundled, 'dup.md', 'name: dup\ndescription: bundled one');
    writeAgent(dirs.user, 'dup.md', 'name: dup\ndescription: user one');
    writeAgent(dirs.project!, 'dup.md', 'name: dup\ndescription: project one');
    writeAgent(dirs.user, 'shared.md', 'name: shared\ndescription: user shadow');
    writeAgent(dirs.bundled, 'shared.md', 'name: shared\ndescription: bundled original');

    const agents = discoverAgents(dirs, 'both');
    strictEqual(agents.length, 2);
    const dup = agents.find((a) => a.name === 'dup')!;
    strictEqual(dup.source, 'project');
    strictEqual(dup.description, 'project one');
    const shared = agents.find((a) => a.name === 'shared')!;
    strictEqual(shared.source, 'user');
    strictEqual(shared.description, 'user shadow');
  });
});

test('scope "user" excludes project agents; scope "project" excludes bundled and user agents', () => {
  withTempDir('subagent-agents-', (dir) => {
    const dirs = makeDirs(dir);
    writeAgent(dirs.bundled, 'b.md', 'name: b\ndescription: bundled');
    writeAgent(dirs.user, 'u.md', 'name: u\ndescription: user');
    writeAgent(dirs.project!, 'p.md', 'name: p\ndescription: project');

    const userScope = discoverAgents(dirs, 'user').map((a) => a.name);
    deepStrictEqual(userScope.sort(), ['b', 'u']);

    const projectScope = discoverAgents(dirs, 'project');
    strictEqual(projectScope.length, 1);
    strictEqual(projectScope[0]!.name, 'p');
    strictEqual(projectScope[0]!.source, 'project');
  });
});

test('tools frontmatter accepts a comma-separated string or an array', () => {
  withTempDir('subagent-agents-', (dir) => {
    const dirs = makeDirs(dir);
    writeAgent(dirs.user, 'str.md', 'name: str-agent\ndescription: x\ntools: read, bash');
    writeAgent(dirs.user, 'arr.md', 'name: arr-agent\ndescription: x\ntools:\n  - read\n  - grep');

    const agents = discoverAgents(dirs, 'user');
    deepStrictEqual(agents.find((a) => a.name === 'str-agent')!.tools, ['read', 'bash']);
    deepStrictEqual(agents.find((a) => a.name === 'arr-agent')!.tools, ['read', 'grep']);
  });
});

test('malformed agent files are skipped without failing discovery', () => {
  withTempDir('subagent-agents-', (dir) => {
    const dirs = makeDirs(dir);
    writeAgent(dirs.user, 'good.md', 'name: good\ndescription: fine');
    // Missing description -> skipped.
    writeAgent(dirs.user, 'noname.md', 'name: noname');
    // Not markdown -> ignored entirely.
    writeFileSync(join(dirs.user, 'notes.txt'), 'name: notes\ndescription: not an agent');

    const agents = discoverAgents(dirs, 'user');
    strictEqual(agents.length, 1);
    strictEqual(agents[0]!.name, 'good');
    strictEqual(agents[0]!.systemPrompt.includes('You are a test agent.'), true);
  });
});

test('missing directories yield no agents', () => {
  withTempDir('subagent-agents-', (dir) => {
    const agents = discoverAgents(makeDirs(dir), 'both');
    deepStrictEqual(agents, []);
  });
});

test('findNearestProjectAgentsDir walks up from nested directories', () => {
  withTempDir('subagent-agents-', (dir) => {
    const nested = join(dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const agentsDir = join(dir, 'a', '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    strictEqual(findNearestProjectAgentsDir(nested), agentsDir);
    strictEqual(findNearestProjectAgentsDir(join(dir, 'a')), agentsDir);
  });
});

test('findNearestProjectAgentsDir returns null when no .pi/agents exists', () => {
  withTempDir('subagent-agents-', (dir) => {
    const nested = join(dir, 'x', 'y');
    mkdirSync(nested, { recursive: true });
    const found = findNearestProjectAgentsDir(nested);
    ok(found === null || !found.startsWith(dir), `expected no project agents dir under temp dir, got ${found}`);
  });
});
