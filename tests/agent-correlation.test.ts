import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/session.js';

let mgr: SessionManager;

beforeEach(() => {
  mgr = new SessionManager();
  mgr.registerSession('sess-1', 'my-project');
});

afterEach(() => {
  mgr.cleanup();
});

// ---------------------------------------------------------------------------
// FIFO correlation: spawn then file
// ---------------------------------------------------------------------------

describe('FIFO correlation: spawn then file', () => {
  it('maps file agentId to toolUseId after spawn', () => {
    mgr.trackTaskSpawn('sess-1', 'toolu_01XyZ');
    mgr.correlateAgentFile('sess-1', 'agent-abc123');

    expect(mgr.resolveAgentId('sess-1', 'agent-abc123')).toBe('toolu_01XyZ');
  });
});

// ---------------------------------------------------------------------------
// FIFO ordering with multiple agents
// ---------------------------------------------------------------------------

describe('FIFO ordering with multiple agents', () => {
  it('correctly maps two spawns to two files in order', () => {
    mgr.trackTaskSpawn('sess-1', 'toolu_first');
    mgr.trackTaskSpawn('sess-1', 'toolu_second');

    mgr.correlateAgentFile('sess-1', 'agent-aaa');
    mgr.correlateAgentFile('sess-1', 'agent-bbb');

    expect(mgr.resolveAgentId('sess-1', 'agent-aaa')).toBe('toolu_first');
    expect(mgr.resolveAgentId('sess-1', 'agent-bbb')).toBe('toolu_second');
  });
});

// ---------------------------------------------------------------------------
// Deferred correlation: file before spawn
// ---------------------------------------------------------------------------

describe('deferred correlation: file before spawn', () => {
  it('returns original when no spawn exists yet, then auto-correlates on spawn', () => {
    mgr.correlateAgentFile('sess-1', 'agent-early');

    expect(mgr.resolveAgentId('sess-1', 'agent-early')).toBe('agent-early');

    mgr.trackTaskSpawn('sess-1', 'toolu_late');

    expect(mgr.resolveAgentId('sess-1', 'agent-early')).toBe('toolu_late');
  });
});

// ---------------------------------------------------------------------------
// No mapping returns original
// ---------------------------------------------------------------------------

describe('no mapping returns original', () => {
  it('returns the original agentId for unknown file agent', () => {
    expect(mgr.resolveAgentId('sess-1', 'agent-unknown')).toBe('agent-unknown');
  });

  it('returns original for unknown session', () => {
    expect(mgr.resolveAgentId('nonexistent', 'agent-x')).toBe('agent-x');
  });
});

// ---------------------------------------------------------------------------
// Cleanup on agentCompleted
// ---------------------------------------------------------------------------

describe('cleanup on agentCompleted', () => {
  it('removes correlation map entry after completion', () => {
    mgr.trackTaskSpawn('sess-1', 'toolu_done');
    mgr.correlateAgentFile('sess-1', 'agent-done');

    expect(mgr.resolveAgentId('sess-1', 'agent-done')).toBe('toolu_done');

    mgr.agentCompleted('sess-1', 'toolu_done');

    expect(mgr.resolveAgentId('sess-1', 'agent-done')).toBe('agent-done');
  });
});

// ---------------------------------------------------------------------------
// Duplicate file correlation is idempotent
// ---------------------------------------------------------------------------

describe('duplicate file correlation', () => {
  it('does not re-correlate an already-mapped file', () => {
    mgr.trackTaskSpawn('sess-1', 'toolu_a');
    mgr.trackTaskSpawn('sess-1', 'toolu_b');

    mgr.correlateAgentFile('sess-1', 'agent-x');
    mgr.correlateAgentFile('sess-1', 'agent-x');

    expect(mgr.resolveAgentId('sess-1', 'agent-x')).toBe('toolu_a');

    mgr.correlateAgentFile('sess-1', 'agent-y');
    expect(mgr.resolveAgentId('sess-1', 'agent-y')).toBe('toolu_b');
  });
});
