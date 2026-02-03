
import { describe, it, expect } from 'vitest';
import { antigravityAdapter } from '../src/adapters/antigravity.js';
import type { RawJsonlEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelMessage(content: unknown[], usage: Record<string, number> | null = null): RawJsonlEvent {
  return {
    type: 'model',
    _sessionId: 'sess-ag-1',
    _agentId: null,
    timestamp: '2026-02-01T00:00:00Z',
    message: {
      content: content as RawJsonlEvent['message'] extends { content?: infer C } ? C : never,
      ...(usage && { usage }),
    },
  };
}

function makeToolResult(toolUseId: string, isError: boolean = false, content: string = 'result'): RawJsonlEvent {
    return {
        type: 'user',
        userType: 'tool_result',
        _sessionId: 'sess-ag-1',
        _agentId: null,
        timestamp: '2026-02-01T00:00:00Z',
        message: {
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseId,
                is_error: isError,
                content
            }]
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Antigravity Adapter', () => {

  describe('Activity', () => {
    it('emits thinking', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'thinking', thinking: 'planning...' }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0] as any).action).toBe('thinking');
    });

    it('emits responding', () => {
      const events = antigravityAdapter(makeModelMessage([{ type: 'text', text: 'Hello' }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('activity');
      expect((events[0] as any).action).toBe('responding');
    });
  });

  describe('File Tools', () => {
    it('maps readFile to file_read', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't1',
        name: 'readFile',
        input: { file_path: '/abs/path/to/script.ts' }
      }]));
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('tool');
      const e = events[0] as any;
      expect(e.tool).toBe('file_read');
      expect(e.detail).toBe('read');
      expect(e.context).toBe('script.ts');
    });

    it('maps writeFile to file_write', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't2',
        name: 'writeFile',
        input: { target_file: '/src/main.rs', content: 'fn main() {}' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('file_write');
      expect(e.context).toBe('main.rs');
    });
  });

  describe('Terminal Tools', () => {
    it('maps runCommand to terminal (bash)', () => {
      const events = antigravityAdapter(makeModelMessage([{
        type: 'tool_use',
        id: 't3',
        name: 'runCommand',
        input: { CommandLine: 'ls -la', Cwd: '/tmp' }
      }]));
      const e = events[0] as any;
      expect(e.tool).toBe('terminal');
      expect(e.detail).toBe('bash');
      expect(e.context).toBe('ls -la');
    });
  });

  describe('Search Tools', () => {
    it('maps grepSearch to search (grep)', () => {
        const events = antigravityAdapter(makeModelMessage([{
            type: 'tool_use',
            id: 't4',
            name: 'grepSearch',
            input: { Query: 'FIXME', SearchPath: '/src' }
        }]));
        const e = events[0] as any;
        expect(e.tool).toBe('search');
        expect(e.detail).toBe('grep');
    });
  });
  
  describe('Agent Spawning', () => {
      it('maps spawnAgent to spawn_agent AND emits agent event (PixelHQ Protocol)', () => {
          const events = antigravityAdapter(makeModelMessage([{
              type: 'tool_use',
              id: 't5',
              name: 'spawnAgent',
              input: { type: 'planner', prompt: 'Make a plan' }
          }]));
          
          expect(events).toHaveLength(2);
          
          // Tool event
          expect(events[0]!.type).toBe('tool');
          const e0 = events[0] as any;
          expect(e0.tool).toBe('spawn_agent');
          expect(e0.detail).toBe('task');
          
          // Agent spawned event
          expect(events[1]!.type).toBe('agent');
          const e1 = events[1] as any;
          expect(e1.action).toBe('spawned');
          expect(e1.agentRole).toBe('planner');
      });
  });

  describe('Privacy', () => {
      it('does not leak full paths in readFile', () => {
          const events = antigravityAdapter(makeModelMessage([{
              type: 'tool_use',
              id: 'p1',
              name: 'readFile',
              input: { file_path: '/Users/sensitive/docs/report.pdf' }
          }]));
          const e = events[0] as any;
          expect(e.context).toBe('report.pdf');
          expect(JSON.stringify(events)).not.toContain('/Users/sensitive');
      });
      
      it('does not leak content in writeFile', () => {
           const events = antigravityAdapter(makeModelMessage([{
              type: 'tool_use',
              id: 'p2',
              name: 'writeFile',
              input: { target_file: 'a.txt', content: 'SECRET_API_KEY' }
          }]));
          expect(JSON.stringify(events)).not.toContain('SECRET_API_KEY');
      });
  });
});
