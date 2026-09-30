/**
 * Agent discovery and configuration for the subagent extension.
 *
 * Agents are markdown files with YAML frontmatter (`name`, `description`,
 * optional `tools`, optional `model`) discovered from three tiers:
 * bundled with this extension, the user's global agent directory, and the
 * nearest project-local `.pi/agents` directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

/** Where an agent definition came from. */
export type AgentSource = 'bundled' | 'user' | 'project';

/** A parsed agent definition. */
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

/** Which agent directories to search. */
export type AgentScope = 'user' | 'project' | 'both';

/** Injectable agent directories (tests pass temp dirs). */
export interface AgentDirs {
  bundled: string;
  user: string;
  project: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
  const raw =
    Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(',')
    : [];
  const tools = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/** Load every valid agent definition from one directory; unreadable or malformed files are skipped. */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

    if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from `cwd` to find the nearest `.pi/agents` directory. */
export function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, 'agents');
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** Resolve default dirs: bundled next to this module, user from getAgentDir(), project walked up from cwd. */
export function resolveAgentDirs(cwd: string): AgentDirs {
  return {
    bundled: path.join(fileURLToPath(new URL('.', import.meta.url)), 'agents'),
    user: path.join(getAgentDir(), 'agents'),
    project: findNearestProjectAgentsDir(cwd),
  };
}

/**
 * Discover agents; precedence project > user > bundled per name.
 *
 * Scope `"user"` searches bundled + user dirs, `"project"` only the project
 * dir, and `"both"` all three tiers.
 */
export function discoverAgents(dirs: AgentDirs, scope: AgentScope): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();

  if (scope !== 'project') {
    for (const agent of loadAgentsFromDir(dirs.bundled, 'bundled')) agentMap.set(agent.name, agent);
    for (const agent of loadAgentsFromDir(dirs.user, 'user')) agentMap.set(agent.name, agent);
  }
  if (scope !== 'user' && dirs.project) {
    for (const agent of loadAgentsFromDir(dirs.project, 'project')) agentMap.set(agent.name, agent);
  }

  return Array.from(agentMap.values());
}
