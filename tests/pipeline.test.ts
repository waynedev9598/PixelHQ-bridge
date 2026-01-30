import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/session.js';
import { parseJsonlLine, transformToPixelEvents } from '../src/parser.js';
import { createAgentEvent } from '../src/pixel-events.js';
import type { PixelEvent } from '../src/types.js';

/**
 * End-to-end pipeline test.
 *
 * Simulates the full bridge flow:
 *   JSONL line → parseJsonlLine → transformToPixelEvents → SessionManager → broadcast
 */

let sessionManager: SessionManager;
let broadcast: PixelEvent[];

function handleNewLine(line: string, sessionId: string, agentId: string | null = null): void {
  const raw = parseJsonlLine(line, sessionId, agentId);
  if (!raw) return;

  const events = transformToPixelEvents(raw);
  sessionManager.recordActivity(sessionId);

  for (const event of events) {
    if (event.type === 'tool' && event.tool === 'spawn_agent' && event.status === 'started') {
      sessionManager.trackTaskSpawn(sessionId, event.toolUseId);
    }
    if (event.type === 'tool' && (event.status === 'completed' || event.status === 'error')) {
      if (sessionManager.handleTaskResult(sessionId, event.toolUseId)) {
        const agentCompleted = createAgentEvent(
          sessionId,
          event.toolUseId,
          event.timestamp,
          event.status === 'error' ? 'error' : 'completed',
        );
        broadcast.push(agentCompleted);
      }
    }
    broadcast.push(event);
  }
}

beforeEach(() => {
  sessionManager = new SessionManager();
  broadcast = [];
  sessionManager.on('event', (e) => broadcast.push(e));
});

afterEach(() => {
  sessionManager.cleanup();
});

// ---------------------------------------------------------------------------
// Basic session + event pipeline
// ---------------------------------------------------------------------------

describe('session event pipeline', () => {
  it('session start → thinking → tool → response → end', () => {
    const sid = 'sess-pipeline-1';

    // 1. Session discovered
    sessionManager.registerSession(sid, 'pixel-office');
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]!.type).toBe('session');
    expect('action' in broadcast[0]! && broadcast[0]!.action).toBe('started');
    expect('project' in broadcast[0]! && broadcast[0]!.project).toBe('pixel-office');

    // 2. Assistant starts thinking
    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: { content: [{ type: 'thinking', thinking: 'Let me analyze...' }] },
    }), sid);
    expect(broadcast[1]!.type).toBe('activity');
    expect('action' in broadcast[1]! && broadcast[1]!.action).toBe('thinking');

    // 3. Assistant uses Read tool
    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:01Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'Read',
          input: { file_path: '/Users/me/project/src/app.ts' },
        }],
      },
    }), sid);
    expect(broadcast[2]!.type).toBe('tool');
    expect((broadcast[2]! as { tool: string }).tool).toBe('file_read');
    expect((broadcast[2]! as { context: string }).context).toBe('app.ts');

    // 4. Tool result comes back
    handleNewLine(JSON.stringify({
      type: 'user',
      userType: 'tool_result',
      timestamp: '2026-01-29T12:00:02Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_read_1',
          content: 'export default function App() { ... }',
        }],
      },
    }), sid);
    expect(broadcast[3]!.type).toBe('tool');
    expect((broadcast[3]! as { status: string }).status).toBe('completed');

    // 5. Assistant responds
    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:03Z',
      message: {
        content: [{ type: 'text', text: 'I found the App component.' }],
        usage: { input_tokens: 5000, output_tokens: 200 },
      },
    }), sid);
    expect(broadcast[4]!.type).toBe('activity');
    expect((broadcast[4]! as { action: string }).action).toBe('responding');
    expect((broadcast[4]! as { tokens: { input: number; output: number } }).tokens).toEqual({ input: 5000, output: 200 });

    // 6. Session removed
    sessionManager.removeSession(sid);
    const endedEvent = broadcast.find(e => 'action' in e && e.action === 'ended');
    expect(endedEvent).toBeDefined();
    expect(endedEvent!.type).toBe('session');
  });
});

// ---------------------------------------------------------------------------
// Agent spawn → complete lifecycle
// ---------------------------------------------------------------------------

describe('agent lifecycle through pipeline', () => {
  it('Task spawn → agent.spawned → tool_result → agent.completed', () => {
    const sid = 'sess-agent-1';
    sessionManager.registerSession(sid, 'my-project');
    broadcast.length = 0;

    // 1. Assistant spawns a Task
    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_task_abc',
          name: 'Task',
          input: { subagent_type: 'explore', prompt: 'Search the codebase' },
        }],
      },
    }), sid);

    expect(broadcast).toHaveLength(2);
    expect(broadcast[0]!.type).toBe('tool');
    expect((broadcast[0]! as { tool: string }).tool).toBe('spawn_agent');
    expect((broadcast[0]! as { status: string }).status).toBe('started');
    expect(broadcast[1]!.type).toBe('agent');
    expect((broadcast[1]! as { action: string }).action).toBe('spawned');
    expect((broadcast[1]! as { agentRole: string }).agentRole).toBe('explore');

    expect(sessionManager.isTaskPending(sid, 'toolu_task_abc')).toBe(true);

    // 2. Task completes
    handleNewLine(JSON.stringify({
      type: 'user',
      userType: 'tool_result',
      timestamp: '2026-01-29T12:00:10Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_abc',
          content: 'Agent found 5 API endpoints',
        }],
      },
    }), sid);

    const agentCompleted = broadcast.find(
      e => e.type === 'agent' && 'action' in e && e.action === 'completed',
    );
    expect(agentCompleted).toBeDefined();
    expect((agentCompleted! as { agentId: string }).agentId).toBe('toolu_task_abc');

    const toolCompleted = broadcast.find(
      e => e.type === 'tool' && 'status' in e && e.status === 'completed' && 'toolUseId' in e && e.toolUseId === 'toolu_task_abc',
    );
    expect(toolCompleted).toBeDefined();

    expect(sessionManager.isTaskPending(sid, 'toolu_task_abc')).toBe(false);
  });

  it('Task error produces agent.error', () => {
    const sid = 'sess-agent-2';
    sessionManager.registerSession(sid, 'p');
    broadcast.length = 0;

    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_task_err',
          name: 'Task',
          input: { subagent_type: 'bash', prompt: 'Run tests' },
        }],
      },
    }), sid);

    handleNewLine(JSON.stringify({
      type: 'user',
      userType: 'tool_result',
      timestamp: '2026-01-29T12:00:05Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task_err',
          is_error: true,
          content: 'Error: Agent timed out',
        }],
      },
    }), sid);

    const agentError = broadcast.find(
      e => e.type === 'agent' && 'action' in e && e.action === 'error',
    );
    expect(agentError).toBeDefined();
    expect((agentError! as { agentId: string }).agentId).toBe('toolu_task_err');
  });
});

// ---------------------------------------------------------------------------
// Multi-tool scenario
// ---------------------------------------------------------------------------

describe('multi-tool scenario', () => {
  it('handles a sequence of different tools', () => {
    const sid = 'sess-multi';
    sessionManager.registerSession(sid, 'app');
    broadcast.length = 0;

    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use', id: 'toolu_grep', name: 'Grep',
          input: { pattern: 'handleError', path: '/secret/path' },
        }],
      },
    }), sid);
    expect((broadcast[0]! as { tool: string }).tool).toBe('search');
    expect((broadcast[0]! as { context: string }).context).toBe('handleError');
    expect(JSON.stringify(broadcast)).not.toContain('/secret/path');

    handleNewLine(JSON.stringify({
      type: 'user', userType: 'tool_result', timestamp: '2026-01-29T12:00:01Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_grep', content: 'found 3 matches' }],
      },
    }), sid);

    handleNewLine(JSON.stringify({
      type: 'assistant', timestamp: '2026-01-29T12:00:02Z',
      message: {
        content: [{
          type: 'tool_use', id: 'toolu_edit', name: 'Edit',
          input: { file_path: '/a/b/handler.ts', old_string: 'old code', new_string: 'new code' },
        }],
      },
    }), sid);
    expect((broadcast[2]! as { tool: string }).tool).toBe('file_write');
    expect((broadcast[2]! as { context: string }).context).toBe('handler.ts');
    expect(JSON.stringify(broadcast)).not.toContain('old code');

    handleNewLine(JSON.stringify({
      type: 'user', userType: 'tool_result', timestamp: '2026-01-29T12:00:02.5Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }],
      },
    }), sid);

    handleNewLine(JSON.stringify({
      type: 'assistant', timestamp: '2026-01-29T12:00:03Z',
      message: {
        content: [{
          type: 'tool_use', id: 'toolu_bash', name: 'Bash',
          input: { command: 'npm test --coverage', description: 'Run test suite' },
        }],
      },
    }), sid);
    expect((broadcast[4]! as { tool: string }).tool).toBe('terminal');
    expect((broadcast[4]! as { context: string }).context).toBe('Run test suite');
    expect(JSON.stringify(broadcast)).not.toContain('npm test');
  });
});

// ---------------------------------------------------------------------------
// Summary event
// ---------------------------------------------------------------------------

describe('summary event', () => {
  it('broadcasts summary event without triggering idle', () => {
    const sid = 'sess-summary-1';
    sessionManager.registerSession(sid, 'my-project');
    broadcast.length = 0;

    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: { content: [{ type: 'text', text: 'Done!' }], usage: { input_tokens: 100, output_tokens: 50 } },
    }), sid);

    handleNewLine(JSON.stringify({
      type: 'summary',
      timestamp: '2026-01-29T12:00:01Z',
    }), sid);

    const summaryEvent = broadcast.find(e => e.type === 'summary');
    expect(summaryEvent).toBeDefined();

    const idleEvent = broadcast.find(e => e.type === 'session' && 'action' in e && e.action === 'idle');
    expect(idleEvent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent file correlation through pipeline
// ---------------------------------------------------------------------------

describe('agent file correlation pipeline', () => {
  it('Task spawn → sub-agent file discovered → sub-agent activity → broadcast has correlated toolUseId', () => {
    const sid = 'sess-corr-1';
    sessionManager.registerSession(sid, 'my-project');
    broadcast.length = 0;

    handleNewLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:00Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_corr_abc',
          name: 'Task',
          input: { subagent_type: 'explore', prompt: 'Search codebase' },
        }],
      },
    }), sid);

    expect(sessionManager.isTaskPending(sid, 'toolu_corr_abc')).toBe(true);

    const fileAgentId = 'agent-file-xyz';
    sessionManager.registerSession(sid, 'my-project', fileAgentId);
    sessionManager.correlateAgentFile(sid, fileAgentId);

    const resolvedAgentId = sessionManager.resolveAgentId(sid, fileAgentId);
    expect(resolvedAgentId).toBe('toolu_corr_abc');

    const activityLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-29T12:00:05Z',
      message: { content: [{ type: 'thinking', thinking: 'analyzing...' }] },
    });
    const raw = parseJsonlLine(activityLine, sid, resolvedAgentId);
    const events = transformToPixelEvents(raw!);

    const activityEvent = events.find(e => e.type === 'activity');
    expect(activityEvent).toBeDefined();
    expect((activityEvent! as { agentId: string }).agentId).toBe('toolu_corr_abc');
  });
});

// ---------------------------------------------------------------------------
// Privacy across the full pipeline
// ---------------------------------------------------------------------------

describe('pipeline privacy', () => {
  it('never leaks sensitive data through the full pipeline', () => {
    const sid = 'sess-privacy';
    sessionManager.registerSession(sid, 'top-secret-project');
    broadcast.length = 0;

    const sensitiveLines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:00Z',
        message: {
          content: [{
            type: 'tool_use', id: 't1', name: 'Read',
            input: { file_path: '/Users/wayne/top-secret-project/.env' },
          }],
        },
      }),
      JSON.stringify({
        type: 'user', userType: 'tool_result', timestamp: '2026-01-29T12:00:01Z',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'API_KEY=sk-abc123\nDB_PASS=hunter2' }],
        },
      }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:02Z',
        message: {
          content: [{ type: 'thinking', thinking: 'The API key sk-abc123 is exposed in .env' }],
        },
      }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:03Z',
        message: {
          content: [{ type: 'text', text: 'Your API_KEY=sk-abc123 should be rotated immediately' }],
        },
      }),
    ];

    for (const line of sensitiveLines) {
      handleNewLine(line, sid);
    }

    const allJson = JSON.stringify(broadcast);
    expect(allJson).not.toContain('sk-abc123');
    expect(allJson).not.toContain('hunter2');
    expect(allJson).not.toContain('API_KEY');
    expect(allJson).not.toContain('DB_PASS');
    expect(allJson).not.toContain('/Users/wayne');
    expect(allJson).not.toContain('should be rotated');
  });
});

// ---------------------------------------------------------------------------
// iOS decode contract
// ---------------------------------------------------------------------------

describe('iOS decode contract', () => {
  function assertDecodable(event: PixelEvent): void {
    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(typeof event.type).toBe('string');
    expect(['session', 'activity', 'tool', 'agent', 'error', 'summary']).toContain(event.type);
    expect(typeof event.sessionId).toBe('string');
    expect(typeof event.timestamp).toBe('string');

    const e = event as Record<string, unknown>;
    for (const field of ['agentId', 'action', 'project', 'model', 'source', 'detail', 'toolUseId', 'context', 'agentRole']) {
      if (field in e) {
        expect(typeof e[field]).toBe('string');
      }
    }

    if ('tool' in e && e.tool) {
      expect(['file_read', 'file_write', 'terminal', 'search', 'plan', 'communicate', 'spawn_agent', 'notebook', 'other']).toContain(e.tool);
    }
    if ('status' in e && e.status) {
      expect(['started', 'completed', 'error']).toContain(e.status);
    }
    if ('severity' in e && e.severity) {
      expect(['warning', 'error']).toContain(e.severity);
    }

    if ('tokens' in e && e.tokens) {
      const tokens = e.tokens as Record<string, unknown>;
      expect(typeof tokens.input).toBe('number');
      expect(typeof tokens.output).toBe('number');
      if ('cacheRead' in tokens) expect(typeof tokens.cacheRead).toBe('number');
      if ('cacheWrite' in tokens) expect(typeof tokens.cacheWrite).toBe('number');
    }
  }

  it('all session events are iOS-decodable', () => {
    const sid = 'sess-ios';
    sessionManager.registerSession(sid, 'my-app');
    sessionManager.removeSession(sid);

    for (const event of broadcast) {
      assertDecodable(event);
    }

    expect(broadcast.find(e => 'action' in e && e.action === 'started')).toBeDefined();
    expect(broadcast.find(e => 'action' in e && e.action === 'ended')).toBeDefined();
  });

  it('all adapter events are iOS-decodable', () => {
    const sid = 'sess-ios-2';
    sessionManager.registerSession(sid, 'app');
    broadcast.length = 0;

    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:00Z',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
      }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:01Z',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        },
      }),
      ...['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
        'Task', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'NotebookEdit',
      ].map((name, i) => JSON.stringify({
        type: 'assistant', timestamp: '2026-01-29T12:00:02Z',
        message: {
          content: [{
            type: 'tool_use', id: `toolu_${i}`, name,
            input: { file_path: '/a/b.ts', pattern: '*.ts', command: 'ls', description: 'list', subagent_type: 'explore', prompt: 'x', todos: [{ content: 'a' }], notebook_path: '/a/nb.ipynb', new_source: 'x' },
          }],
        },
      })),
      JSON.stringify({
        type: 'user', userType: 'tool_result', timestamp: '2026-01-29T12:00:03Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'user', userType: 'tool_result', timestamp: '2026-01-29T12:00:04Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Error' }] },
      }),
      JSON.stringify({
        type: 'user', userType: 'external', timestamp: '2026-01-29T12:00:05Z',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ];

    for (const line of lines) {
      handleNewLine(line, sid);
    }

    expect(broadcast.length).toBeGreaterThan(0);
    for (const event of broadcast) {
      assertDecodable(event);
    }
  });
});
