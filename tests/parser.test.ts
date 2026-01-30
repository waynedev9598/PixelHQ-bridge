import { describe, it, expect, vi } from 'vitest';
import { parseJsonlLine, transformToPixelEvents } from '../src/parser.js';

// ---------------------------------------------------------------------------
// parseJsonlLine
// ---------------------------------------------------------------------------

describe('parseJsonlLine', () => {
  it('parses valid JSON and injects session metadata', () => {
    const line = '{"type":"assistant","message":{"content":[]}}';
    const raw = parseJsonlLine(line, 'sess-1');
    expect(raw!.type).toBe('assistant');
    expect(raw!._sessionId).toBe('sess-1');
    expect(raw!._agentId).toBeNull();
  });

  it('injects agentId when provided', () => {
    const line = '{"type":"assistant","message":{"content":[]}}';
    const raw = parseJsonlLine(line, 'sess-1', 'agent-abc');
    expect(raw!._agentId).toBe('agent-abc');
  });

  it('returns null for empty line', () => {
    expect(parseJsonlLine('', 'sess-1')).toBeNull();
  });

  it('returns null for whitespace-only line', () => {
    expect(parseJsonlLine('   \n  ', 'sess-1')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseJsonlLine('{broken', 'sess-1')).toBeNull();
    spy.mockRestore();
  });

  it('trims whitespace before parsing', () => {
    const line = '  {"type":"user"}  ';
    const raw = parseJsonlLine(line, 'sess-1');
    expect(raw!.type).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// transformToPixelEvents
// ---------------------------------------------------------------------------

describe('transformToPixelEvents', () => {
  it('transforms via claude-code adapter by default', () => {
    const raw = {
      type: 'assistant',
      _sessionId: 'sess-1',
      _agentId: null,
      timestamp: '2026-01-29T00:00:00Z',
      message: {
        content: [{ type: 'thinking' as const, thinking: 'hmm' }],
      },
    };
    const events = transformToPixelEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
  });

  it('returns empty for unknown source', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = transformToPixelEvents({ type: 'assistant', _sessionId: 's', _agentId: null }, 'unknown-source');
    expect(events).toEqual([]);
    spy.mockRestore();
  });

  it('returns empty for unrecognized raw type', () => {
    const raw = {
      type: 'system',
      _sessionId: 'sess-1',
      _agentId: null,
    };
    const events = transformToPixelEvents(raw);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: parseJsonlLine → transformToPixelEvents
// ---------------------------------------------------------------------------

describe('parseJsonlLine → transformToPixelEvents round-trip', () => {
  it('processes a thinking block end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{ type: 'thinking', thinking: 'analyzing the codebase' }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    expect(raw).not.toBeNull();

    const events = transformToPixelEvents(raw!);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect('action' in events[0]! && events[0]!.action).toBe('thinking');
    expect(events[0]!.sessionId).toBe('sess-42');
    expect(JSON.stringify(events)).not.toContain('analyzing the codebase');
  });

  it('processes a tool_use block end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'Read',
          input: { file_path: '/Users/secret/src/main.rs' },
        }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    const events = transformToPixelEvents(raw!);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { tool: string; status: string; toolUseId: string; context: string };
    expect(e.tool).toBe('file_read');
    expect(e.status).toBe('started');
    expect(e.toolUseId).toBe('toolu_abc');
    expect(e.context).toBe('main.rs');
    expect(JSON.stringify(events)).not.toContain('/Users/secret');
  });

  it('processes a tool_result end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      userType: 'tool_result',
      timestamp: '2026-01-29T12:00:01Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: 'fn main() { println!("hello"); }',
        }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    const events = transformToPixelEvents(raw!);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool');
    const e = events[0]! as { status: string; toolUseId: string };
    expect(e.status).toBe('completed');
    expect(e.toolUseId).toBe('toolu_abc');
    expect(JSON.stringify(events)).not.toContain('println');
  });

  it('processes a Task spawn end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_task_1',
          name: 'Task',
          input: { subagent_type: 'explore', prompt: 'Find API endpoints' },
        }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    const events = transformToPixelEvents(raw!);

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('tool');
    expect((events[0]! as { tool: string }).tool).toBe('spawn_agent');
    expect(events[1]!.type).toBe('agent');
    expect((events[1]! as { action: string }).action).toBe('spawned');
    expect((events[1]! as { agentRole: string }).agentRole).toBe('explore');
    expect((events[1]! as { agentId: string }).agentId).toBe('toolu_task_1');
  });

  it('processes a user prompt end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      userType: 'external',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{ type: 'text', text: 'Please fix the authentication bug' }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    const events = transformToPixelEvents(raw!);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('activity');
    expect((events[0]! as { action: string }).action).toBe('user_prompt');
    expect(JSON.stringify(events)).not.toContain('authentication');
  });

  it('processes a summary event end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'summary',
      timestamp: '2026-01-29T12:00:00Z',
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    expect(raw).not.toBeNull();

    const events = transformToPixelEvents(raw!);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('summary');
    expect(events[0]!.sessionId).toBe('sess-42');
    expect(events[0]!.timestamp).toBe('2026-01-29T12:00:00Z');
  });

  it('processes an error tool_result end-to-end', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      userType: 'tool_result',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_err',
          is_error: true,
          content: 'Error: ENOENT: no such file',
        }],
      },
    });

    const raw = parseJsonlLine(jsonl, 'sess-42');
    const events = transformToPixelEvents(raw!);

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('tool');
    expect((events[0]! as { status: string }).status).toBe('error');
    expect(events[1]!.type).toBe('error');
    expect((events[1]! as { severity: string }).severity).toBe('warning');
  });
});
