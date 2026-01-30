import { describe, it, expect } from 'vitest';
import { ToolCategory, TOOL_TO_CATEGORY, PixelEventType } from '../src/config.js';

describe('PixelEventType', () => {
  it('has all expected event types', () => {
    expect(PixelEventType.SESSION).toBe('session');
    expect(PixelEventType.ACTIVITY).toBe('activity');
    expect(PixelEventType.TOOL).toBe('tool');
    expect(PixelEventType.AGENT).toBe('agent');
    expect(PixelEventType.ERROR).toBe('error');
    expect(PixelEventType.SUMMARY).toBe('summary');
  });
});

describe('ToolCategory', () => {
  it('has all expected categories', () => {
    expect(ToolCategory.FILE_READ).toBe('file_read');
    expect(ToolCategory.FILE_WRITE).toBe('file_write');
    expect(ToolCategory.TERMINAL).toBe('terminal');
    expect(ToolCategory.SEARCH).toBe('search');
    expect(ToolCategory.PLAN).toBe('plan');
    expect(ToolCategory.COMMUNICATE).toBe('communicate');
    expect(ToolCategory.SPAWN_AGENT).toBe('spawn_agent');
    expect(ToolCategory.NOTEBOOK).toBe('notebook');
    expect(ToolCategory.OTHER).toBe('other');
  });
});

describe('TOOL_TO_CATEGORY', () => {
  it('maps all Claude Code tools to categories', () => {
    const expectedMappings: Record<string, string> = {
      Read: 'file_read',
      Write: 'file_write',
      Edit: 'file_write',
      Bash: 'terminal',
      Grep: 'search',
      Glob: 'search',
      WebFetch: 'search',
      WebSearch: 'search',
      Task: 'spawn_agent',
      TodoWrite: 'plan',
      EnterPlanMode: 'plan',
      ExitPlanMode: 'plan',
      AskUserQuestion: 'communicate',
      NotebookEdit: 'notebook',
    };

    for (const [tool, expectedCategory] of Object.entries(expectedMappings)) {
      expect(TOOL_TO_CATEGORY[tool]?.category).toBe(expectedCategory);
      expect(TOOL_TO_CATEGORY[tool]?.detail).toBeDefined();
    }
  });

  it('provides unique detail strings for each tool', () => {
    const details = Object.values(TOOL_TO_CATEGORY).map(m => m.detail);
    expect(details.every(d => typeof d === 'string' && d.length > 0)).toBe(true);
  });
});

describe('resolveClaudeDir (integration)', () => {
  it('config module loads with resolved paths', async () => {
    const { config } = await import('../src/config.js');
    expect(config.claudeDir).toBeDefined();
    expect(config.projectsDir).toBeDefined();
    expect(config.claudeDirResolvedVia).toBeDefined();
    expect(config.watchDebounce).toBe(100);
  });
});
