import { describe, it, expect } from 'vitest';
import { claudeCodeAdapter } from '../src/adapters/claude-code.js';
import type { RawJsonlEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers — mock raw JSONL objects
// ---------------------------------------------------------------------------

function makeAssistant(content: unknown[], usage: Record<string, number> | null = null): RawJsonlEvent {
  return {
    type: 'assistant',
    _sessionId: 'sess-1',
    _agentId: null,
    timestamp: '2026-01-29T00:00:00Z',
    message: {
      content: content as RawJsonlEvent['message'] extends { content?: infer C } ? C : never,
      ...(usage && { usage }),
    },
  };
}

function makeToolResult(blocks: unknown[], userType: string = 'tool_result'): RawJsonlEvent {
  return {
    type: 'user',
    userType,
    _sessionId: 'sess-1',
    _agentId: null,
    timestamp: '2026-01-29T00:00:00Z',
    message: { content: blocks as RawJsonlEvent['message'] extends { content?: infer C } ? C : never },
  };
}

function makeUserText(text: string): RawJsonlEvent {
  return {
    type: 'user',
    userType: 'external',
    _sessionId: 'sess-1',
    _agentId: null,
    timestamp: '2026-01-29T00:00:00Z',
    message: { content: [{ type: 'text', text }] as RawJsonlEvent['message'] extends { content?: infer C } ? C : never },
  };
}

// ---------------------------------------------------------------------------
// Assistant: thinking block
// ---------------------------------------------------------------------------

describe('assistant: thinking', () => {
  it('emits activity.thinking', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'thinking', thinking: 'deep thought' }]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
    expect(events[0]!.sessionId).toBe('sess-1');
  });

  it('does NOT leak thinking text', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'thinking', thinking: 'secret plan' }]));
    expect(JSON.stringify(events[0])).not.toContain('secret plan');
  });
});

// ---------------------------------------------------------------------------
// Assistant: text block
// ---------------------------------------------------------------------------

describe('assistant: text "(no content)"', () => {
  it('emits activity.thinking for "(no content)" text block', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: '(no content)' }]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
    expect(events[0]!.sessionId).toBe('sess-1');
  });

  it('does NOT emit responding for "(no content)"', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: '(no content)' }]));
    expect('action' in events[0]! && events[0]!.action).not.toBe('responding');
  });
});

describe('assistant: text', () => {
  it('emits activity.responding with no preview text', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: 'Hello world' }]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('responding');
    expect(events[0]!).not.toHaveProperty('preview');
    expect(events[0]!).not.toHaveProperty('text');
  });

  it('does NOT leak message text', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: 'My secret API key is abc123' }]));
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('abc123');
  });

  it('includes token usage when present', () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: 'hi' }], usage));
    expect('tokens' in events[0]! && events[0]!.tokens).toEqual({ input: 1000, output: 500 });
  });

  it('includes cache token fields', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    };
    const events = claudeCodeAdapter(makeAssistant([{ type: 'text', text: 'hi' }], usage));
    expect('tokens' in events[0]! && events[0]!.tokens).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Assistant: tool_use blocks — category & context mapping
// ---------------------------------------------------------------------------

describe('assistant: tool_use', () => {
  it('maps Read to file_read with basename context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_01',
      name: 'Read',
      input: { file_path: '/Users/wayne/Projects/secret/src/auth.ts' },
    }]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { tool: string; detail: string; status: string; context: string };
    expect(e.tool).toBe('file_read');
    expect(e.detail).toBe('read');
    expect(e.status).toBe('started');
    expect(e.context).toBe('auth.ts');
    expect(JSON.stringify(events)).not.toContain('/Users/wayne');
  });

  it('maps Write to file_write with basename context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_02',
      name: 'Write',
      input: { file_path: '/home/user/project/index.js', content: 'secret code' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('file_write');
    expect(e.detail).toBe('write');
    expect(e.context).toBe('index.js');
    expect(JSON.stringify(events)).not.toContain('secret code');
  });

  it('maps Edit to file_write with basename context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_03',
      name: 'Edit',
      input: { file_path: '/a/b/c.py', old_string: 'old', new_string: 'new' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('file_write');
    expect(e.detail).toBe('edit');
    expect(e.context).toBe('c.py');
    expect(JSON.stringify(events)).not.toContain('old');
    expect(JSON.stringify(events)).not.toContain('new');
  });

  it('maps Bash to terminal with description context only', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_04',
      name: 'Bash',
      input: { command: 'rm -rf / --no-preserve-root', description: 'Run tests' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('terminal');
    expect(e.detail).toBe('bash');
    expect(e.context).toBe('Run tests');
    expect(JSON.stringify(events)).not.toContain('rm -rf');
    expect(JSON.stringify(events)).not.toContain('no-preserve-root');
  });

  it('Bash with no description has null context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_04b',
      name: 'Bash',
      input: { command: 'echo hello' },
    }]));
    expect(events[0]!).not.toHaveProperty('context');
  });

  it('maps Grep to search with pattern context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_05',
      name: 'Grep',
      input: { pattern: 'TODO', path: '/Users/wayne/Projects/secret' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('grep');
    expect(e.context).toBe('TODO');
    expect(JSON.stringify(events)).not.toContain('/Users/wayne');
  });

  it('maps Glob to search with pattern context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_06',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('glob');
    expect(e.context).toBe('**/*.ts');
  });

  it('maps WebFetch to search with NO url context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_07',
      name: 'WebFetch',
      input: { url: 'https://secret-api.com/token', prompt: 'extract the key' },
    }]));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('web_fetch');
    expect(events[0]!).not.toHaveProperty('context');
    expect(JSON.stringify(events)).not.toContain('secret-api');
    expect(JSON.stringify(events)).not.toContain('extract the key');
  });

  it('maps WebSearch to search with NO query context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_08',
      name: 'WebSearch',
      input: { query: 'how to hack NASA' },
    }]));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('web_search');
    expect(events[0]!).not.toHaveProperty('context');
    expect(JSON.stringify(events)).not.toContain('NASA');
  });

  it('maps TodoWrite to plan with item count context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_09',
      name: 'TodoWrite',
      input: { todos: [{ content: 'a' }, { content: 'b' }, { content: 'c' }] },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('plan');
    expect(e.detail).toBe('todo');
    expect(e.context).toBe('3 items');
    expect(JSON.stringify(events)).not.toContain('"a"');
  });

  it('maps EnterPlanMode to plan', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_10',
      name: 'EnterPlanMode',
      input: {},
    }]));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('plan');
    expect(e.detail).toBe('enter_plan');
  });

  it('maps ExitPlanMode to plan', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_11',
      name: 'ExitPlanMode',
      input: {},
    }]));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('plan');
    expect(e.detail).toBe('exit_plan');
  });

  it('maps AskUserQuestion to communicate + emits activity.waiting', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_12',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'What color?' }] },
    }]));
    expect(events).toHaveLength(2);
    const e0 = events[0]! as { tool: string; detail: string };
    expect(e0.tool).toBe('communicate');
    expect(e0.detail).toBe('ask_user');
    expect(events[1]!.type).toBe('activity');
    expect('action' in events[1]! && events[1]!.action).toBe('waiting');
    expect(JSON.stringify(events)).not.toContain('What color');
  });

  it('maps NotebookEdit to notebook with basename context', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_13',
      name: 'NotebookEdit',
      input: { notebook_path: '/Users/wayne/analysis.ipynb', new_source: 'import pandas' },
    }]));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('notebook');
    expect(e.detail).toBe('notebook');
    expect(e.context).toBe('analysis.ipynb');
    expect(JSON.stringify(events)).not.toContain('import pandas');
  });

  it('maps unknown tools to other category', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_99',
      name: 'FutureTool',
      input: { foo: 'bar' },
    }]));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('other');
    expect(e.detail).toBe('FutureTool');
  });
});

// ---------------------------------------------------------------------------
// Assistant: Task tool → agent.spawned
// ---------------------------------------------------------------------------

describe('assistant: Task tool → agent', () => {
  it('emits tool.started AND agent.spawned for Task', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_task_1',
      name: 'Task',
      input: { subagent_type: 'explore', prompt: 'Find all API endpoints', description: 'Search APIs' },
    }]));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('tool');
    const e0 = events[0]! as { tool: string; detail: string; context: string };
    expect(e0.tool).toBe('spawn_agent');
    expect(e0.detail).toBe('task');
    expect(e0.context).toBe('explore');
    expect(events[1]!.type).toBe('agent');
    const e1 = events[1]! as { action: string; agentRole: string; agentId: string };
    expect(e1.action).toBe('spawned');
    expect(e1.agentRole).toBe('explore');
    expect(e1.agentId).toBe('toolu_task_1');
    expect(JSON.stringify(events)).not.toContain('Find all API');
  });

  it('defaults agentRole to general when subagent_type missing', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use',
      id: 'toolu_task_2',
      name: 'Task',
      input: { prompt: 'do stuff' },
    }]));
    expect((events[1]! as { agentRole: string }).agentRole).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// Assistant: agent context (agentId propagation)
// ---------------------------------------------------------------------------

describe('agentId propagation', () => {
  it('includes agentId when raw has _agentId', () => {
    const raw = makeAssistant([{ type: 'thinking', thinking: '' }]);
    raw._agentId = 'agent-abc';
    const events = claudeCodeAdapter(raw);
    expect((events[0]! as { agentId: string }).agentId).toBe('agent-abc');
  });

  it('omits agentId when _agentId is null', () => {
    const events = claudeCodeAdapter(makeAssistant([{ type: 'thinking', thinking: '' }]));
    expect(events[0]!).not.toHaveProperty('agentId');
  });
});

// ---------------------------------------------------------------------------
// User: tool_result
// ---------------------------------------------------------------------------

describe('user: tool_result', () => {
  it('emits tool.completed for successful result', () => {
    const events = claudeCodeAdapter(makeToolResult([{
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'file contents...',
    }]));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { status: string; toolUseId: string };
    expect(e.status).toBe('completed');
    expect(e.toolUseId).toBe('toolu_01');
    expect(JSON.stringify(events)).not.toContain('file contents');
  });

  it('emits tool.error + error event for is_error=true', () => {
    const events = claudeCodeAdapter(makeToolResult([{
      type: 'tool_result',
      tool_use_id: 'toolu_02',
      is_error: true,
      content: 'Permission denied: /etc/shadow',
    }]));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('tool');
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(JSON.stringify(events)).not.toContain('Permission denied');
    expect(JSON.stringify(events)).not.toContain('/etc/shadow');
    expect(events[1]!.type).toBe('error');
    expect((events[1]! as { severity: string }).severity).toBe('warning');
  });

  it('detects errors from content containing "Error"', () => {
    const events = claudeCodeAdapter(makeToolResult([{
      type: 'tool_result',
      tool_use_id: 'toolu_03',
      content: 'Error: ENOENT: no such file',
    }]));
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(events[1]!.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// User: external text
// ---------------------------------------------------------------------------

describe('user: external text', () => {
  it('emits activity.user_prompt for user text', () => {
    const events = claudeCodeAdapter(makeUserText('Please fix the bug'));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect((events[0]! as { action: string }).action).toBe('user_prompt');
    expect(JSON.stringify(events)).not.toContain('fix the bug');
  });

  it('skips empty user text', () => {
    const events = claudeCodeAdapter(makeUserText('   '));
    expect(events).toHaveLength(0);
  });

  it('handles string content (terminal CLI format)', () => {
    const raw: RawJsonlEvent = {
      type: 'user',
      userType: 'external',
      _sessionId: 'sess-1',
      _agentId: null,
      timestamp: '2026-01-29T00:00:00Z',
      message: { content: 'Please fix the bug in auth.ts' },
    };
    const events = claudeCodeAdapter(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect((events[0]! as { action: string }).action).toBe('user_prompt');
    expect(JSON.stringify(events)).not.toContain('fix the bug');
    expect(JSON.stringify(events)).not.toContain('auth.ts');
  });

  it('skips empty string content', () => {
    const raw: RawJsonlEvent = {
      type: 'user',
      userType: 'external',
      _sessionId: 'sess-1',
      _agentId: null,
      timestamp: '2026-01-29T00:00:00Z',
      message: { content: '   ' },
    };
    const events = claudeCodeAdapter(raw);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Summary type
// ---------------------------------------------------------------------------

describe('summary', () => {
  it('emits a summary event', () => {
    const events = claudeCodeAdapter({
      type: 'summary',
      _sessionId: 'sess-1',
      _agentId: null,
      timestamp: '2026-01-29T00:00:00Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary');
    expect(events[0]!.sessionId).toBe('sess-1');
    expect(events[0]!.timestamp).toBe('2026-01-29T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Recognized but no-op types
// ---------------------------------------------------------------------------

describe('system', () => {
  it('returns empty array', () => {
    const events = claudeCodeAdapter({
      type: 'system', _sessionId: 'sess-1', _agentId: null, timestamp: '2026-01-29T00:00:00Z',
    });
    expect(events).toEqual([]);
  });
});

describe('progress', () => {
  it('returns empty array', () => {
    const events = claudeCodeAdapter({
      type: 'progress', _sessionId: 'sess-1', _agentId: null, timestamp: '2026-01-29T00:00:00Z',
    });
    expect(events).toEqual([]);
  });
});

describe('queue-operation', () => {
  it('returns empty array', () => {
    const events = claudeCodeAdapter({
      type: 'queue-operation', _sessionId: 'sess-1', _agentId: null, timestamp: '2026-01-29T00:00:00Z',
    });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('returns empty for unknown raw.type', () => {
    const events = claudeCodeAdapter({
      type: 'file-history-snapshot', _sessionId: 'sess-1', _agentId: null,
    });
    expect(events).toEqual([]);
  });

  it('returns empty for assistant with no content', () => {
    const events = claudeCodeAdapter({
      type: 'assistant', _sessionId: 'sess-1', _agentId: null, message: {},
    });
    expect(events).toEqual([]);
  });

  it('returns empty for user with no content', () => {
    const events = claudeCodeAdapter({
      type: 'user', userType: 'tool_result', _sessionId: 'sess-1', _agentId: null, message: {},
    });
    expect(events).toEqual([]);
  });

  it('handles multiple content blocks in one assistant message', () => {
    const events = claudeCodeAdapter(makeAssistant([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Here is my answer' },
      { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/a/b.ts' } },
    ]));
    expect(events).toHaveLength(3);
    expect((events[0]! as { action: string }).action).toBe('thinking');
    expect((events[1]! as { action: string }).action).toBe('responding');
    expect(events[2]!.type).toBe('tool');
  });

  it('uses current timestamp when raw has no timestamp', () => {
    const raw = makeAssistant([{ type: 'thinking', thinking: '' }]);
    delete raw.timestamp;
    const events = claudeCodeAdapter(raw);
    expect(events[0]!.timestamp).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Comprehensive privacy audit
// ---------------------------------------------------------------------------

describe('privacy audit', () => {
  it('never includes full file paths', () => {
    const events = claudeCodeAdapter(makeAssistant([
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/Users/wayne/secret/passwords.txt' } },
      { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/home/user/.env', content: 'KEY=abc' } },
      { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/var/log/auth.log', old_string: 'x', new_string: 'y' } },
    ]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('/Users/wayne');
    expect(json).not.toContain('/home/user');
    expect(json).not.toContain('/var/log');
    expect(json).toContain('passwords.txt');
    expect(json).toContain('.env');
    expect(json).toContain('auth.log');
  });

  it('never includes bash commands', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use', id: 't1', name: 'Bash',
      input: { command: 'cat /etc/passwd | grep root', description: 'Check system users' },
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('cat /etc/passwd');
    expect(json).not.toContain('grep root');
    expect(json).toContain('Check system users');
  });

  it('never includes URLs or search queries', () => {
    const events = claudeCodeAdapter(makeAssistant([
      { type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://internal.corp.com/api', prompt: 'extract key' } },
      { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'social security number lookup' } },
    ]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('internal.corp.com');
    expect(json).not.toContain('social security');
    expect(json).not.toContain('extract key');
  });

  it('never includes task prompts', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use', id: 't1', name: 'Task',
      input: { subagent_type: 'bash', prompt: 'Find all SSH keys and private credentials', description: 'Security audit' },
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('SSH keys');
    expect(json).not.toContain('private credentials');
    expect(json).not.toContain('Security audit');
  });

  it('never includes todo content', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use', id: 't1', name: 'TodoWrite',
      input: { todos: [{ content: 'Delete production database', status: 'pending' }] },
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('Delete production');
  });

  it('never includes file content from Write', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use', id: 't1', name: 'Write',
      input: { file_path: '/a/config.json', content: '{"apiKey":"sk-secret-123"}' },
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('apiKey');
  });

  it('never includes edit strings from Edit', () => {
    const events = claudeCodeAdapter(makeAssistant([{
      type: 'tool_use', id: 't1', name: 'Edit',
      input: { file_path: '/a/b.js', old_string: 'const password = "hunter2"', new_string: 'const password = process.env.PW' },
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('process.env.PW');
  });

  it('never includes tool result content', () => {
    const events = claudeCodeAdapter(makeToolResult([{
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'File contents:\nSECRET_KEY=abc123\nDB_PASSWORD=hunter2',
    }]));
    const json = JSON.stringify(events);
    expect(json).not.toContain('SECRET_KEY');
    expect(json).not.toContain('hunter2');
  });
});
