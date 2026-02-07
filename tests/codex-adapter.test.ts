import { describe, it, expect } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import type { RawJsonlEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers — mock raw Codex rollout JSONL objects
// ---------------------------------------------------------------------------

function makeCodexEvent(type: string, payload: unknown): RawJsonlEvent {
  return {
    type,
    payload,
    _sessionId: 'sess-codex-1',
    _agentId: null,
    timestamp: '2026-01-29T00:00:00Z',
  } as unknown as RawJsonlEvent;
}

function makeResponseItem(payloadType: string, extra: Record<string, unknown> = {}): RawJsonlEvent {
  return makeCodexEvent('response_item', { type: payloadType, ...extra });
}

// ---------------------------------------------------------------------------
// message: user
// ---------------------------------------------------------------------------

describe('codex: user message', () => {
  it('emits activity.user_prompt for user input_text', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'user',
      content: [{ type: 'input_text', text: 'Fix the bug in main.py' }],
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('user_prompt');
    expect(JSON.stringify(events)).not.toContain('Fix the bug');
  });

  it('skips user message with no text content', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'user',
      content: [],
    }));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// message: assistant
// ---------------------------------------------------------------------------

describe('codex: assistant message', () => {
  it('emits activity.responding for output_text', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I will fix the authentication module' }],
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('responding');
    expect(JSON.stringify(events)).not.toContain('authentication');
  });

  it('skips assistant message with no output_text', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'assistant',
      content: [],
    }));
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reasoning
// ---------------------------------------------------------------------------

describe('codex: reasoning', () => {
  it('emits activity.thinking', () => {
    const events = codexAdapter(makeResponseItem('reasoning', {
      summary: [{ type: 'summary_text', text: 'deep analysis' }],
      content: [{ type: 'thinking', thinking: 'secret reasoning' }],
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
  });

  it('does NOT leak reasoning content', () => {
    const events = codexAdapter(makeResponseItem('reasoning', {
      content: [{ type: 'thinking', thinking: 'The API key sk-secret is exposed' }],
    }));
    expect(JSON.stringify(events)).not.toContain('sk-secret');
    expect(JSON.stringify(events)).not.toContain('API key');
  });
});

// ---------------------------------------------------------------------------
// function_call: tool mapping
// ---------------------------------------------------------------------------

describe('codex: function_call tool mapping', () => {
  it('maps shell to terminal/bash', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'shell',
      call_id: 'call_001',
      arguments: JSON.stringify({ cmd: 'rm -rf /', workdir: '/Users/me' }),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { tool: string; detail: string; status: string };
    expect(e.tool).toBe('terminal');
    expect(e.detail).toBe('bash');
    expect(e.status).toBe('started');
    expect(JSON.stringify(events)).not.toContain('rm -rf');
    expect(JSON.stringify(events)).not.toContain('/Users/me');
  });

  it('maps exec_command to terminal/bash', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'exec_command',
      call_id: 'call_002',
      arguments: JSON.stringify({ cmd: 'cat /etc/passwd' }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('terminal');
    expect(e.detail).toBe('bash');
    expect(JSON.stringify(events)).not.toContain('/etc/passwd');
  });

  it('maps apply_patch to file_write/patch', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'apply_patch',
      call_id: 'call_003',
      arguments: JSON.stringify({ patch: '--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new' }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('file_write');
    expect(e.detail).toBe('patch');
    expect(JSON.stringify(events)).not.toContain('old');
    expect(JSON.stringify(events)).not.toContain('new');
    expect(JSON.stringify(events)).not.toContain('foo.py');
  });

  it('maps read_file to file_read/read with basename context', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'read_file',
      call_id: 'call_004',
      arguments: JSON.stringify({ path: '/Users/me/project/src/auth.ts' }),
    }));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('file_read');
    expect(e.detail).toBe('read');
    expect(e.context).toBe('auth.ts');
    expect(JSON.stringify(events)).not.toContain('/Users/me');
  });

  it('maps list_dir to search/list_dir', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'list_dir',
      call_id: 'call_005',
      arguments: JSON.stringify({ path: '/Users/me/project' }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('list_dir');
    expect(JSON.stringify(events)).not.toContain('/Users/me');
  });

  it('maps grep_files to search/grep with pattern context', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'grep_files',
      call_id: 'call_006',
      arguments: JSON.stringify({ pattern: 'TODO', path: '/Users/me/project' }),
    }));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('grep');
    expect(e.context).toBe('TODO');
    expect(JSON.stringify(events)).not.toContain('/Users/me');
  });

  it('maps view_image to file_read/image with basename', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'view_image',
      call_id: 'call_007',
      arguments: JSON.stringify({ path: '/Users/me/project/screenshot.png' }),
    }));
    const e = events[0]! as { tool: string; detail: string; context: string };
    expect(e.tool).toBe('file_read');
    expect(e.detail).toBe('image');
    expect(e.context).toBe('screenshot.png');
  });

  it('maps plan to plan/plan', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'plan',
      call_id: 'call_008',
      arguments: JSON.stringify({ items: ['Step 1: Delete production DB'] }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('plan');
    expect(e.detail).toBe('plan');
    expect(JSON.stringify(events)).not.toContain('Delete production');
  });

  it('maps request_user_input to communicate + activity.waiting', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'request_user_input',
      call_id: 'call_009',
      arguments: JSON.stringify({ prompt: 'Should I delete this file?' }),
    }));
    expect(events).toHaveLength(2);
    const e0 = events[0]! as { tool: string; detail: string };
    expect(e0.tool).toBe('communicate');
    expect(e0.detail).toBe('ask_user');
    expect(events[1]!.type).toBe('activity');
    expect('action' in events[1]! && events[1]!.action).toBe('waiting');
    expect(JSON.stringify(events)).not.toContain('delete this file');
  });

  it('maps spawn_agent to spawn_agent + agent.spawned', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'spawn_agent',
      call_id: 'call_010',
      arguments: JSON.stringify({ prompt: 'Search for API endpoints' }),
    }));
    expect(events).toHaveLength(2);
    const e0 = events[0]! as { tool: string; detail: string };
    expect(e0.tool).toBe('spawn_agent');
    expect(e0.detail).toBe('collab');
    expect(events[1]!.type).toBe('agent');
    expect('action' in events[1]! && events[1]!.action).toBe('spawned');
    expect(JSON.stringify(events)).not.toContain('Search for API');
  });

  it('maps web_search to search/web_search', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'web_search',
      call_id: 'call_011',
      arguments: JSON.stringify({ query: 'social security number lookup' }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('web_search');
    expect(JSON.stringify(events)).not.toContain('social security');
  });

  it('maps unknown tools to other/<name>', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'future_tool',
      call_id: 'call_099',
      arguments: JSON.stringify({ foo: 'bar' }),
    }));
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('other');
    expect(e.detail).toBe('future_tool');
  });

  it('uses call_id as toolUseId', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'shell',
      call_id: 'call_xyz',
      arguments: '{}',
    }));
    expect((events[0]! as { toolUseId: string }).toolUseId).toBe('call_xyz');
  });

  it('handles malformed arguments JSON gracefully', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'read_file',
      call_id: 'call_bad',
      arguments: '{broken json',
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    expect(events[0]!).not.toHaveProperty('context');
  });

  it('handles missing arguments', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'shell',
      call_id: 'call_noargs',
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
  });
});

// ---------------------------------------------------------------------------
// function_call_output
// ---------------------------------------------------------------------------

describe('codex: function_call_output', () => {
  it('emits tool.completed for successful output', () => {
    const events = codexAdapter(makeResponseItem('function_call_output', {
      call_id: 'call_001',
      output: 'File contents here with secrets',
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    expect((events[0]! as { status: string }).status).toBe('completed');
    expect((events[0]! as { toolUseId: string }).toolUseId).toBe('call_001');
    expect(JSON.stringify(events)).not.toContain('secrets');
    expect(JSON.stringify(events)).not.toContain('File contents');
  });

  it('emits tool.error + error event when output contains Error', () => {
    const events = codexAdapter(makeResponseItem('function_call_output', {
      call_id: 'call_002',
      output: 'Error: ENOENT: no such file /etc/shadow',
    }));
    expect(events).toHaveLength(2);
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(events[1]!.type).toBe('error');
    expect((events[1]! as { severity: string }).severity).toBe('warning');
    expect(JSON.stringify(events)).not.toContain('ENOENT');
    expect(JSON.stringify(events)).not.toContain('/etc/shadow');
  });
});

// ---------------------------------------------------------------------------
// local_shell_call
// ---------------------------------------------------------------------------

describe('codex: local_shell_call', () => {
  it('emits terminal tool.started', () => {
    const events = codexAdapter(makeResponseItem('local_shell_call', {
      id: 'shell_001',
      call_id: 'shell_001',
      action: { type: 'exec', cmd: ['npm', 'test'] },
    }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { tool: string; detail: string; status: string };
    expect(e.tool).toBe('terminal');
    expect(e.detail).toBe('shell');
    expect(e.status).toBe('started');
    expect(JSON.stringify(events)).not.toContain('npm');
  });

  it('emits terminal tool.completed', () => {
    const events = codexAdapter(makeResponseItem('local_shell_call', {
      id: 'shell_002',
      call_id: 'shell_002',
      status: 'completed',
    }));
    expect(events).toHaveLength(1);
    expect((events[0]! as { status: string }).status).toBe('completed');
  });

  it('emits terminal tool.error for failed', () => {
    const events = codexAdapter(makeResponseItem('local_shell_call', {
      id: 'shell_003',
      call_id: 'shell_003',
      status: 'failed',
    }));
    expect(events).toHaveLength(2);
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(events[1]!.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// web_search_call
// ---------------------------------------------------------------------------

describe('codex: web_search_call', () => {
  it('emits search tool event', () => {
    const events = codexAdapter(makeResponseItem('web_search_call', {
      id: 'ws_001',
      action: { type: 'search', query: 'confidential info' },
    }));
    expect(events).toHaveLength(1);
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('search');
    expect(e.detail).toBe('web_search');
    expect(JSON.stringify(events)).not.toContain('confidential');
  });
});

// ---------------------------------------------------------------------------
// custom_tool_call / custom_tool_call_output
// ---------------------------------------------------------------------------

describe('codex: custom_tool_call', () => {
  it('emits other tool event', () => {
    const events = codexAdapter(makeResponseItem('custom_tool_call', {
      name: 'my_mcp_tool',
      call_id: 'ct_001',
      input: { secret: 'value' },
    }));
    expect(events).toHaveLength(1);
    const e = events[0]! as { tool: string; detail: string };
    expect(e.tool).toBe('other');
    expect(e.detail).toBe('my_mcp_tool');
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('value');
  });
});

describe('codex: custom_tool_call_output', () => {
  it('emits tool.completed', () => {
    const events = codexAdapter(makeResponseItem('custom_tool_call_output', {
      call_id: 'ct_001',
      output: 'success result',
    }));
    expect(events).toHaveLength(1);
    expect((events[0]! as { status: string }).status).toBe('completed');
    expect(JSON.stringify(events)).not.toContain('success result');
  });

  it('emits tool.error when output contains Error', () => {
    const events = codexAdapter(makeResponseItem('custom_tool_call_output', {
      call_id: 'ct_002',
      output: 'Error: permission denied',
    }));
    expect(events).toHaveLength(2);
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(events[1]!.type).toBe('error');
    expect(JSON.stringify(events)).not.toContain('permission denied');
  });
});

// ---------------------------------------------------------------------------
// No-op types
// ---------------------------------------------------------------------------

describe('codex: no-op types', () => {
  it('session_meta returns empty', () => {
    const events = codexAdapter(makeCodexEvent('session_meta', {
      id: 'uuid-here',
      cwd: '/Users/me/secret-project',
      source: 'cli',
    }));
    expect(events).toEqual([]);
  });

  it('turn_context returns empty', () => {
    const events = codexAdapter(makeCodexEvent('turn_context', {
      cwd: '/Users/me/project',
      model: 'gpt-5',
    }));
    expect(events).toEqual([]);
  });

  it('compacted returns empty', () => {
    const events = codexAdapter(makeCodexEvent('compacted', {
      message: 'Summary of previous conversation with secrets',
    }));
    expect(events).toEqual([]);
  });

  it('event_msg returns empty', () => {
    const events = codexAdapter(makeCodexEvent('event_msg', {
      message: 'internal event',
    }));
    expect(events).toEqual([]);
  });

  it('unknown type returns empty', () => {
    const events = codexAdapter(makeCodexEvent('future_type', { data: 'secret' }));
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// response_item: skip types
// ---------------------------------------------------------------------------

describe('codex: response_item skip types', () => {
  it('ghost_snapshot returns empty', () => {
    const events = codexAdapter(makeResponseItem('ghost_snapshot', {
      ghost_commit: 'abc123',
    }));
    expect(events).toEqual([]);
  });

  it('compaction returns empty', () => {
    const events = codexAdapter(makeResponseItem('compaction', {
      encrypted_content: 'encrypted data here',
    }));
    expect(events).toEqual([]);
  });

  it('other returns empty', () => {
    const events = codexAdapter(makeResponseItem('other', {}));
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('codex: edge cases', () => {
  it('returns empty for response_item with no payload', () => {
    const events = codexAdapter(makeCodexEvent('response_item', undefined));
    expect(events).toEqual([]);
  });

  it('returns empty for response_item with empty payload', () => {
    const events = codexAdapter(makeCodexEvent('response_item', {}));
    expect(events).toEqual([]);
  });

  it('uses current timestamp when raw has no timestamp', () => {
    const raw = makeResponseItem('reasoning', {
      content: [{ type: 'thinking', thinking: '' }],
    });
    delete raw.timestamp;
    const events = codexAdapter(raw);
    expect(events[0]!.timestamp).toBeDefined();
  });

  it('includes agentId when raw has _agentId', () => {
    const raw = makeResponseItem('reasoning', {});
    raw._agentId = 'agent-codex-1';
    const events = codexAdapter(raw);
    expect((events[0]! as { agentId: string }).agentId).toBe('agent-codex-1');
  });

  it('omits agentId when _agentId is null', () => {
    const events = codexAdapter(makeResponseItem('reasoning', {}));
    expect(events[0]!).not.toHaveProperty('agentId');
  });
});

// ---------------------------------------------------------------------------
// Comprehensive privacy audit
// ---------------------------------------------------------------------------

describe('codex: privacy audit', () => {
  it('never includes shell commands', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'shell',
      call_id: 'p1',
      arguments: JSON.stringify({ cmd: 'cat /etc/passwd | grep root', workdir: '/Users/secret' }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('cat /etc/passwd');
    expect(json).not.toContain('grep root');
    expect(json).not.toContain('/Users/secret');
  });

  it('never includes file contents from read_file output', () => {
    const events = codexAdapter(makeResponseItem('function_call_output', {
      call_id: 'p2',
      output: 'API_KEY=sk-secret-123\nDB_PASS=hunter2',
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('API_KEY');
  });

  it('never includes patch content', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'apply_patch',
      call_id: 'p3',
      arguments: JSON.stringify({
        patch: '--- a/config.json\n+++ b/config.json\n-"password": "hunter2"\n+"password": process.env.PW',
      }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('process.env.PW');
    expect(json).not.toContain('config.json');
  });

  it('never includes full file paths', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'read_file',
      call_id: 'p4',
      arguments: JSON.stringify({ path: '/Users/wayne/secret-project/.env' }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('/Users/wayne');
    expect(json).not.toContain('secret-project');
    expect(json).toContain('.env');
  });

  it('never includes reasoning text', () => {
    const events = codexAdapter(makeResponseItem('reasoning', {
      summary: [{ type: 'summary_text', text: 'Found API key sk-abc123' }],
      content: [{ type: 'thinking', thinking: 'The secret API key is sk-abc123' }],
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('sk-abc123');
    expect(json).not.toContain('API key');
  });

  it('never includes assistant response text', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Your API_KEY=sk-abc123 should be rotated immediately' }],
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('sk-abc123');
    expect(json).not.toContain('rotated');
  });

  it('never includes user prompt text', () => {
    const events = codexAdapter(makeResponseItem('message', {
      role: 'user',
      content: [{ type: 'input_text', text: 'My password is hunter2, please fix the auth' }],
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('password');
  });

  it('never includes search queries', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'web_search',
      call_id: 'p5',
      arguments: JSON.stringify({ query: 'how to hack NASA' }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('NASA');
    expect(json).not.toContain('hack');
  });

  it('never includes spawn_agent prompts', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'spawn_agent',
      call_id: 'p6',
      arguments: JSON.stringify({ prompt: 'Find all SSH keys and private credentials' }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('SSH keys');
    expect(json).not.toContain('private credentials');
  });

  it('never includes plan content', () => {
    const events = codexAdapter(makeResponseItem('function_call', {
      name: 'plan',
      call_id: 'p7',
      arguments: JSON.stringify({ items: ['Delete production database'] }),
    }));
    const json = JSON.stringify(events);
    expect(json).not.toContain('Delete production');
  });
});

// ---------------------------------------------------------------------------
// Parser integration: codex source routing
// ---------------------------------------------------------------------------

describe('codex: parser integration', () => {
  it('transforms via codex adapter when source=codex', async () => {
    const { parseJsonlLine, transformToPixelEvents } = await import('../src/parser.js');
    const line = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-29T12:00:00Z',
      payload: {
        type: 'reasoning',
        content: [{ type: 'thinking', thinking: 'analyzing...' }],
      },
    });
    const raw = parseJsonlLine(line, 'sess-codex-int');
    expect(raw).not.toBeNull();
    const events = transformToPixelEvents(raw!, 'codex');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
    expect(JSON.stringify(events)).not.toContain('analyzing');
  });

  it('round-trips a function_call through parser + adapter', async () => {
    const { parseJsonlLine, transformToPixelEvents } = await import('../src/parser.js');
    const line = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-01-29T12:00:00Z',
      payload: {
        type: 'function_call',
        name: 'read_file',
        call_id: 'call_rt_1',
        arguments: JSON.stringify({ path: '/Users/me/project/src/main.rs' }),
      },
    });
    const raw = parseJsonlLine(line, 'sess-codex-rt');
    const events = transformToPixelEvents(raw!, 'codex');
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { tool: string; context: string; toolUseId: string };
    expect(e.tool).toBe('file_read');
    expect(e.context).toBe('main.rs');
    expect(e.toolUseId).toBe('call_rt_1');
    expect(JSON.stringify(events)).not.toContain('/Users/me');
  });
});
