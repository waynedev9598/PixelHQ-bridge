import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/session.js';
import type { PixelEvent } from '../src/types.js';

let mgr: SessionManager;
let emitted: PixelEvent[];

beforeEach(() => {
  mgr = new SessionManager();
  emitted = [];
  mgr.on('event', (e) => emitted.push(e));
});

afterEach(() => {
  mgr.cleanup();
});

// ---------------------------------------------------------------------------
// Registration & session.started
// ---------------------------------------------------------------------------

describe('registerSession', () => {
  it('emits session.started on first registration', () => {
    mgr.registerSession('sess-1', 'pixel-office');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe('session');
    expect('action' in emitted[0]! && emitted[0]!.action).toBe('started');
    expect('project' in emitted[0]! && emitted[0]!.project).toBe('pixel-office');
    expect('source' in emitted[0]! && emitted[0]!.source).toBe('claude-code');
  });

  it('does NOT emit again for duplicate registration', () => {
    mgr.registerSession('sess-1', 'pixel-office');
    mgr.registerSession('sess-1', 'pixel-office');
    expect(emitted).toHaveLength(1);
  });

  it('tracks agentIds', () => {
    mgr.registerSession('sess-1', 'p', 'agent-a');
    mgr.registerSession('sess-1', 'p', 'agent-b');
    const state = mgr.getState();
    expect(state.sessions[0]!.agentIds).toEqual(['agent-a', 'agent-b']);
  });

  it('accepts custom source', () => {
    mgr.registerSession('sess-1', 'p', null, 'cursor');
    expect('source' in emitted[0]! && emitted[0]!.source).toBe('cursor');
  });
});

// ---------------------------------------------------------------------------
// recordActivity — updates lastEventAt
// ---------------------------------------------------------------------------

describe('recordActivity', () => {
  it('updates lastEventAt', () => {
    mgr.registerSession('sess-1', 'p');
    const before = mgr.getState().sessions[0]!.lastEventAt;

    mgr.recordActivity('sess-1');
    const after = mgr.getState().sessions[0]!.lastEventAt;

    expect(after).toBeDefined();
    expect(typeof after).toBe('string');
  });

  it('does nothing for unknown session', () => {
    mgr.recordActivity('nonexistent');
    expect(mgr.getState().sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task tracking
// ---------------------------------------------------------------------------

describe('task tracking', () => {
  it('tracks spawn and result', () => {
    mgr.registerSession('sess-1', 'p');

    mgr.trackTaskSpawn('sess-1', 'toolu_task_1');
    expect(mgr.isTaskPending('sess-1', 'toolu_task_1')).toBe(true);

    const wasTracked = mgr.handleTaskResult('sess-1', 'toolu_task_1');
    expect(wasTracked).toBe(true);
    expect(mgr.isTaskPending('sess-1', 'toolu_task_1')).toBe(false);
  });

  it('returns false for unknown task result', () => {
    mgr.registerSession('sess-1', 'p');
    expect(mgr.handleTaskResult('sess-1', 'toolu_unknown')).toBe(false);
  });

  it('returns false for unknown session', () => {
    expect(mgr.isTaskPending('nonexistent', 'toolu_1')).toBe(false);
    expect(mgr.handleTaskResult('nonexistent', 'toolu_1')).toBe(false);
  });

  it('tracks multiple pending tasks', () => {
    mgr.registerSession('sess-1', 'p');
    mgr.trackTaskSpawn('sess-1', 'toolu_1');
    mgr.trackTaskSpawn('sess-1', 'toolu_2');
    expect(mgr.isTaskPending('sess-1', 'toolu_1')).toBe(true);
    expect(mgr.isTaskPending('sess-1', 'toolu_2')).toBe(true);

    mgr.handleTaskResult('sess-1', 'toolu_1');
    expect(mgr.isTaskPending('sess-1', 'toolu_1')).toBe(false);
    expect(mgr.isTaskPending('sess-1', 'toolu_2')).toBe(true);
  });

  it('shows pending tasks in state', () => {
    mgr.registerSession('sess-1', 'p');
    mgr.trackTaskSpawn('sess-1', 'toolu_1');
    const state = mgr.getState();
    expect(state.sessions[0]!.pendingTaskIds).toEqual(['toolu_1']);
  });
});

// ---------------------------------------------------------------------------
// State sync (getState)
// ---------------------------------------------------------------------------

describe('getState', () => {
  it('returns state shape', () => {
    mgr.registerSession('sess-1', 'my-project');
    const state = mgr.getState();

    expect(state.timestamp).toBeDefined();
    expect(state.sessions).toHaveLength(1);

    const s = state.sessions[0]!;
    expect(s.sessionId).toBe('sess-1');
    expect(s.project).toBe('my-project');
    expect(s.source).toBe('claude-code');
    expect(s.lastEventAt).toBeDefined();
    expect(s.agentIds).toEqual([]);
    expect(s.pendingTaskIds).toEqual([]);

    expect(s).not.toHaveProperty('isActive');
    expect(s).not.toHaveProperty('isIdle');
    expect(s).not.toHaveProperty('idleSince');
  });
});

// ---------------------------------------------------------------------------
// Session removal
// ---------------------------------------------------------------------------

describe('removeSession', () => {
  it('emits session.ended', () => {
    mgr.registerSession('sess-1', 'p');
    emitted.length = 0;

    mgr.removeSession('sess-1');
    expect(emitted).toHaveLength(1);
    expect('action' in emitted[0]! && emitted[0]!.action).toBe('ended');
  });

  it('clears from state', () => {
    mgr.registerSession('sess-1', 'p');
    mgr.removeSession('sess-1');
    expect(mgr.getState().sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Active count
// ---------------------------------------------------------------------------

describe('getActiveCount', () => {
  it('counts registered sessions', () => {
    mgr.registerSession('sess-1', 'p');
    mgr.registerSession('sess-2', 'p');

    expect(mgr.getActiveCount()).toBe(2);

    mgr.removeSession('sess-1');
    expect(mgr.getActiveCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session reaper (TTL-based cleanup)
// ---------------------------------------------------------------------------

describe('session reaper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps sessions idle longer than TTL', () => {
    mgr.registerSession('sess-old', 'p');
    emitted.length = 0;

    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    mgr._reapStaleSessions();

    expect(mgr.getActiveCount()).toBe(0);
    expect(emitted).toHaveLength(1);
    expect('action' in emitted[0]! && emitted[0]!.action).toBe('ended');
  });

  it('does NOT reap sessions with recent activity', () => {
    mgr.registerSession('sess-active', 'p');
    emitted.length = 0;

    vi.advanceTimersByTime(60 * 1000);
    mgr.recordActivity('sess-active');

    vi.advanceTimersByTime(90 * 1000);
    mgr._reapStaleSessions();

    expect(mgr.getActiveCount()).toBe(1);
    expect(emitted).toHaveLength(0);
  });

  it('startReaper / stopReaper lifecycle', () => {
    mgr.registerSession('sess-1', 'p');
    emitted.length = 0;

    mgr.startReaper();

    vi.advanceTimersByTime(2 * 60 * 1000 + 30 * 1000 + 1);

    expect(mgr.getActiveCount()).toBe(0);

    mgr.stopReaper();
  });
});
