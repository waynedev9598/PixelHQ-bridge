import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ToolMapping } from './types.js';

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find package.json');
    dir = parent;
  }
}

const pkg = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as {
  version: string;
};

// ---------------------------------------------------------------------------
// Claude directory auto-detection
// ---------------------------------------------------------------------------

function getCliArg(name: string): string | null {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1]! : null;
}

function hasCliFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface ResolvedClaudeDir {
  claudeDir: string;
  projectsDir: string;
  resolvedVia: string;
}

export function resolveClaudeDir(): ResolvedClaudeDir {
  const home = homedir();
  const candidates: { path: string | null | undefined; via: string }[] = [
    { path: getCliArg('claude-dir'), via: '--claude-dir flag' },
    { path: process.env.CLAUDE_CONFIG_DIR, via: 'CLAUDE_CONFIG_DIR env' },
    { path: join(home, '.claude'), via: 'default (~/.claude)' },
    { path: join(home, '.config', 'claude'), via: 'XDG (~/.config/claude)' },
  ];

  for (const { path, via } of candidates) {
    if (!path) continue;
    const projectsDir = join(path, 'projects');
    if (existsSync(projectsDir)) {
      return { claudeDir: path, projectsDir, resolvedVia: via };
    }
    if (existsSync(path)) {
      return { claudeDir: path, projectsDir, resolvedVia: `${via} (no projects/ yet)` };
    }
  }

  throw new Error(
    'Could not find Claude config directory. Tried:\n' +
    candidates
      .filter(c => c.path)
      .map(c => `  - ${c.path} (${c.via})`)
      .join('\n') +
    '\n\nUse --claude-dir <path> to specify the directory manually.'
  );
}

// ---------------------------------------------------------------------------
// Codex directory auto-detection
// ---------------------------------------------------------------------------

interface ResolvedCodexDir {
  codexDir: string;
  codexSessionsDir: string;
  resolvedVia: string;
}

export function resolveCodexDir(): ResolvedCodexDir | null {
  const home = homedir();
  const candidates: { path: string | null | undefined; via: string }[] = [
    { path: getCliArg('codex-dir'), via: '--codex-dir flag' },
    { path: process.env.CODEX_HOME, via: 'CODEX_HOME env' },
    { path: join(home, '.codex'), via: 'default (~/.codex)' },
  ];

  for (const { path, via } of candidates) {
    if (!path) continue;
    const sessionsDir = join(path, 'sessions');
    if (existsSync(sessionsDir)) {
      return { codexDir: path, codexSessionsDir: sessionsDir, resolvedVia: via };
    }
    if (existsSync(path)) {
      return { codexDir: path, codexSessionsDir: sessionsDir, resolvedVia: `${via} (no sessions/ yet)` };
    }
  }

  return null;
}

// Resolve once at import time
const resolved = resolveClaudeDir();
const resolvedCodex = resolveCodexDir();

// ---------------------------------------------------------------------------
// Bridge server configuration
// ---------------------------------------------------------------------------

export const config = {
  claudeDir: resolved.claudeDir,
  projectsDir: resolved.projectsDir,
  claudeDirResolvedVia: resolved.resolvedVia,
  codexDir: resolvedCodex?.codexDir ?? null as string | null,
  codexSessionsDir: resolvedCodex?.codexSessionsDir ?? null as string | null,
  codexDirResolvedVia: resolvedCodex?.resolvedVia ?? null as string | null,
  version: pkg.version,
  wsPort: Number(getCliArg('port') || process.env.PIXEL_OFFICE_PORT || 8765),
  bonjourName: 'Pixel Office Bridge',
  bonjourType: 'pixeloffice',
  watchDebounce: 100,
  sessionTtlMs: 2 * 60 * 1000,
  sessionReapIntervalMs: 30 * 1000,
  authTokenFile: join(resolved.claudeDir, 'pixel-office-auth.json'),
  verbose: hasCliFlag('verbose'),
  nonInteractive: hasCliFlag('yes') || hasCliFlag('y') || process.env.CI === 'true',
};

// ---------------------------------------------------------------------------
// PixelEvent types
// ---------------------------------------------------------------------------

export const PixelEventType = {
  SESSION: 'session',
  ACTIVITY: 'activity',
  TOOL: 'tool',
  AGENT: 'agent',
  ERROR: 'error',
  SUMMARY: 'summary',
} as const;

// ---------------------------------------------------------------------------
// Tool category mapping
// ---------------------------------------------------------------------------

export const ToolCategory = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  TERMINAL: 'terminal',
  SEARCH: 'search',
  PLAN: 'plan',
  COMMUNICATE: 'communicate',
  SPAWN_AGENT: 'spawn_agent',
  NOTEBOOK: 'notebook',
  OTHER: 'other',
} as const;

export const TOOL_TO_CATEGORY: Record<string, ToolMapping> = {
  Read:            { category: ToolCategory.FILE_READ,    detail: 'read' },
  Write:           { category: ToolCategory.FILE_WRITE,   detail: 'write' },
  Edit:            { category: ToolCategory.FILE_WRITE,   detail: 'edit' },
  Bash:            { category: ToolCategory.TERMINAL,     detail: 'bash' },
  Grep:            { category: ToolCategory.SEARCH,       detail: 'grep' },
  Glob:            { category: ToolCategory.SEARCH,       detail: 'glob' },
  WebFetch:        { category: ToolCategory.SEARCH,       detail: 'web_fetch' },
  WebSearch:       { category: ToolCategory.SEARCH,       detail: 'web_search' },
  Task:            { category: ToolCategory.SPAWN_AGENT,  detail: 'task' },
  TodoWrite:       { category: ToolCategory.PLAN,         detail: 'todo' },
  EnterPlanMode:   { category: ToolCategory.PLAN,         detail: 'enter_plan' },
  ExitPlanMode:    { category: ToolCategory.PLAN,         detail: 'exit_plan' },
  AskUserQuestion: { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
  NotebookEdit:    { category: ToolCategory.NOTEBOOK,     detail: 'notebook' },
};

// ---------------------------------------------------------------------------
// Codex tool category mapping
// ---------------------------------------------------------------------------

export const CODEX_TOOL_TO_CATEGORY: Record<string, ToolMapping> = {
  shell:              { category: ToolCategory.TERMINAL,     detail: 'bash' },
  exec_command:       { category: ToolCategory.TERMINAL,     detail: 'bash' },
  apply_patch:        { category: ToolCategory.FILE_WRITE,   detail: 'patch' },
  read_file:          { category: ToolCategory.FILE_READ,    detail: 'read' },
  list_dir:           { category: ToolCategory.SEARCH,       detail: 'list_dir' },
  grep_files:         { category: ToolCategory.SEARCH,       detail: 'grep' },
  view_image:         { category: ToolCategory.FILE_READ,    detail: 'image' },
  get_memory:         { category: ToolCategory.OTHER,        detail: 'memory' },
  plan:               { category: ToolCategory.PLAN,         detail: 'plan' },
  update_plan:        { category: ToolCategory.PLAN,         detail: 'plan' },
  request_user_input: { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
  spawn_agent:        { category: ToolCategory.SPAWN_AGENT,  detail: 'collab' },
  send_input:         { category: ToolCategory.SPAWN_AGENT,  detail: 'collab' },
  wait:               { category: ToolCategory.SPAWN_AGENT,  detail: 'collab' },
  close_agent:        { category: ToolCategory.SPAWN_AGENT,  detail: 'collab' },
  web_search:         { category: ToolCategory.SEARCH,       detail: 'web_search' },
};
