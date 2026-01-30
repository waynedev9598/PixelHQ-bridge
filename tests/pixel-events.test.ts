import { describe, it, expect } from 'vitest';
import {
  createSessionEvent,
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  createSummaryEvent,
  toBasename,
  toProjectName,
} from '../src/pixel-events.js';

// ---------------------------------------------------------------------------
// createSessionEvent
// ---------------------------------------------------------------------------

describe('createSessionEvent', () => {
  it('creates a session event with required fields', () => {
    const event = createSessionEvent('sess-1', 'started');
    expect(event.id).toBeDefined();
    expect(event.type).toBe('session');
    expect(event.sessionId).toBe('sess-1');
    expect(event.action).toBe('started');
    expect(event.timestamp).toBeDefined();
  });

  it('includes optional fields when provided', () => {
    const event = createSessionEvent('sess-1', 'started', {
      project: 'my-project',
      model: 'opus-4.5',
      source: 'claude-code',
    });
    expect(event.project).toBe('my-project');
    expect(event.model).toBe('opus-4.5');
    expect(event.source).toBe('claude-code');
  });

  it('omits optional fields when not provided', () => {
    const event = createSessionEvent('sess-1', 'ended');
    expect(event).not.toHaveProperty('project');
    expect(event).not.toHaveProperty('model');
    expect(event).not.toHaveProperty('source');
  });
});

// ---------------------------------------------------------------------------
// createActivityEvent
// ---------------------------------------------------------------------------

describe('createActivityEvent', () => {
  it('creates an activity event with action and no tokens', () => {
    const event = createActivityEvent('sess-1', null, '2026-01-29T00:00:00Z', 'thinking');
    expect(event.type).toBe('activity');
    expect(event.action).toBe('thinking');
    expect(event).not.toHaveProperty('agentId');
    expect(event).not.toHaveProperty('tokens');
  });

  it('includes agentId when provided', () => {
    const event = createActivityEvent('sess-1', 'agent-abc', '2026-01-29T00:00:00Z', 'responding');
    expect(event.agentId).toBe('agent-abc');
  });

  it('includes tokens when provided', () => {
    const tokens = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 };
    const event = createActivityEvent('sess-1', null, '2026-01-29T00:00:00Z', 'responding', tokens);
    expect(event.tokens).toEqual(tokens);
  });
});

// ---------------------------------------------------------------------------
// createToolEvent
// ---------------------------------------------------------------------------

describe('createToolEvent', () => {
  it('creates a tool event with required fields', () => {
    const event = createToolEvent('sess-1', null, '2026-01-29T00:00:00Z', {
      tool: 'file_read',
      status: 'started',
      toolUseId: 'toolu_01',
    });
    expect(event.type).toBe('tool');
    expect(event.tool).toBe('file_read');
    expect(event.status).toBe('started');
    expect(event.toolUseId).toBe('toolu_01');
    expect(event).not.toHaveProperty('agentId');
    expect(event).not.toHaveProperty('detail');
    expect(event).not.toHaveProperty('context');
  });

  it('includes optional detail and context', () => {
    const event = createToolEvent('sess-1', 'agent-1', '2026-01-29T00:00:00Z', {
      tool: 'file_read',
      detail: 'grep',
      status: 'started',
      toolUseId: 'toolu_02',
      context: '*.ts',
    });
    expect(event.agentId).toBe('agent-1');
    expect(event.detail).toBe('grep');
    expect(event.context).toBe('*.ts');
  });
});

// ---------------------------------------------------------------------------
// createAgentEvent
// ---------------------------------------------------------------------------

describe('createAgentEvent', () => {
  it('creates an agent event', () => {
    const event = createAgentEvent('sess-1', 'agent-1', '2026-01-29T00:00:00Z', 'spawned', 'explore');
    expect(event.type).toBe('agent');
    expect(event.action).toBe('spawned');
    expect(event.agentRole).toBe('explore');
  });

  it('omits agentRole when null', () => {
    const event = createAgentEvent('sess-1', 'agent-1', '2026-01-29T00:00:00Z', 'completed');
    expect(event).not.toHaveProperty('agentRole');
  });
});

// ---------------------------------------------------------------------------
// createErrorEvent
// ---------------------------------------------------------------------------

describe('createErrorEvent', () => {
  it('creates an error event', () => {
    const event = createErrorEvent('sess-1', null, '2026-01-29T00:00:00Z', 'error');
    expect(event.type).toBe('error');
    expect(event.severity).toBe('error');
    expect(event).not.toHaveProperty('agentId');
  });
});

// ---------------------------------------------------------------------------
// createSummaryEvent
// ---------------------------------------------------------------------------

describe('createSummaryEvent', () => {
  it('creates a summary event with required fields', () => {
    const event = createSummaryEvent('sess-1', '2026-01-29T00:00:00Z');
    expect(event.id).toBeDefined();
    expect(event.type).toBe('summary');
    expect(event.sessionId).toBe('sess-1');
    expect(event.timestamp).toBe('2026-01-29T00:00:00Z');
  });

  it('does not include extra fields', () => {
    const event = createSummaryEvent('sess-1', '2026-01-29T00:00:00Z');
    expect(Object.keys(event)).toEqual(['id', 'type', 'sessionId', 'timestamp']);
  });
});

// ---------------------------------------------------------------------------
// toBasename (privacy utility)
// ---------------------------------------------------------------------------

describe('toBasename', () => {
  it('strips a full path to basename', () => {
    expect(toBasename('/Users/wayne/Projects/secret/src/auth.ts')).toBe('auth.ts');
  });

  it('handles a single filename', () => {
    expect(toBasename('file.txt')).toBe('file.txt');
  });

  it('handles trailing slash', () => {
    expect(toBasename('/some/path/')).toBe(null);
  });

  it('returns null for null input', () => {
    expect(toBasename(null)).toBe(null);
  });

  it('returns null for undefined input', () => {
    expect(toBasename(undefined)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(toBasename('')).toBe(null);
  });

  it('returns null for non-string', () => {
    expect(toBasename(42)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// toProjectName (privacy utility)
// ---------------------------------------------------------------------------

describe('toProjectName', () => {
  it('strips a full path to last segment', () => {
    expect(toProjectName('/Users/wayne/Projects/pixel-office')).toBe('pixel-office');
  });

  it('handles trailing slash', () => {
    expect(toProjectName('/Users/wayne/Projects/pixel-office/')).toBe('pixel-office');
  });

  it('handles a single segment', () => {
    expect(toProjectName('my-project')).toBe('my-project');
  });

  it('returns null for null input', () => {
    expect(toProjectName(null)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(toProjectName('')).toBe(null);
  });
});
