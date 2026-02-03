
import {
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  createSummaryEvent,
  toBasename,
} from '../pixel-events.js';
import { ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, RawUsage, TokenUsage } from '../types.js';

// Antigravity Tool Mapping
const ANTIGRAVITY_TOOL_MAP: Record<string, { category: string; detail: string }> = {
  // File operations
  readFile:      { category: ToolCategory.FILE_READ,    detail: 'read' },
  writeFile:     { category: ToolCategory.FILE_WRITE,   detail: 'write' },
  editFile:      { category: ToolCategory.FILE_WRITE,   detail: 'edit' },
  
  // Terminal
  runCommand:    { category: ToolCategory.TERMINAL,     detail: 'bash' },
  
  // Search
  grepSearch:    { category: ToolCategory.SEARCH,       detail: 'grep' },
  globSearch:    { category: ToolCategory.SEARCH,       detail: 'glob' },
  findByName:    { category: ToolCategory.SEARCH,       detail: 'find' },
  
  // Web
  searchWeb:     { category: ToolCategory.SEARCH,       detail: 'web_search' },
  readUrl:       { category: ToolCategory.SEARCH,       detail: 'web_fetch' },

  // Agent/Planning
  spawnAgent:    { category: ToolCategory.SPAWN_AGENT,  detail: 'task' },
  listTasks:     { category: ToolCategory.PLAN,         detail: 'todo' },
  
  // Communication
  askUser:       { category: ToolCategory.COMMUNICATE,  detail: 'ask_user' },
};

/**
 * Transform a raw Antigravity JSONL object into PixelEvent(s).
 * Assumes a schema similar to:
 * {
 *   "type": "model" | "user" | "tool",
 *   "content": "...",
 *   "tool_calls": [...],
 *   "usage": { ... }
 * }
 */
export function antigravityAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const sessionId = raw._sessionId;
  const agentId = raw._agentId || null;
  const timestamp = raw.timestamp || new Date().toISOString();

  // Basic routing based on top-level type
  switch (raw.type) {
    case 'assistant':
    case 'model': 
      return handleModel(raw, sessionId, agentId, timestamp);

    case 'user':
      return handleUser(raw, sessionId, agentId, timestamp);

    case 'summary':
      return [createSummaryEvent(sessionId, timestamp)];

    default:
      return [];
  }
}

function handleModel(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  
  // If undefined message, skip
  if (!message) return events;

  // 1. Handle Thinking / Content
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'thinking') {
        events.push(createActivityEvent(sessionId, agentId, timestamp, 'thinking'));
      } else if (block.type === 'text') {
        // Only emit responding if there is actual text
        if (block.text && block.text.trim().length > 0) {
           events.push(createActivityEvent(sessionId, agentId, timestamp, 'responding', extractTokens(message.usage || null)));
        }
      } else if (block.type === 'tool_use') {
        events.push(buildToolStartedEvent(sessionId, agentId, timestamp, block));
        
        // Spawn special handling
        if (block.name === 'spawnAgent' || block.name === 'Task') { // Support both naming conventions
             events.push(
            createAgentEvent(
              sessionId,
              block.id,
              timestamp,
              'spawned',
              (block.input as any)?.type || 'general'
            ),
          );
        }
      }
    }
  }

  // 2. Handle Usage
  // (Usage is attached to the activity event above if text exists)

  return events;
}

function handleUser(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  if (!message?.content) return events;

  // Handle Tool Results
  if (raw.userType === 'tool_result') {
     const contentList = Array.isArray(message.content) ? message.content : [];
     for (const block of contentList) {
        if (block.type === 'tool_result') {
            const isError = block.is_error || (typeof block.content === 'string' && block.content.includes('Error'));
            events.push(createToolEvent(sessionId, agentId, timestamp, {
                tool: ToolCategory.OTHER,
                status: isError ? 'error' : 'completed',
                toolUseId: block.tool_use_id,
                // detail: 'result' // Optional
            }));
             if (isError) {
                events.push(createErrorEvent(sessionId, agentId, timestamp, 'warning'));
             }
        }
     }
  } else {
    // Regular user message
    events.push(createActivityEvent(sessionId, agentId, timestamp, 'user_prompt'));
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolStartedEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  block: any,
): PixelEvent {
  const toolName = block.name;
  const mapping = ANTIGRAVITY_TOOL_MAP[toolName] || {
    category: ToolCategory.OTHER,
    detail: toolName,
  };

  return createToolEvent(sessionId, agentId, timestamp, {
    tool: mapping.category,
    detail: mapping.detail,
    status: 'started',
    toolUseId: block.id,
    context: extractSafeContext(toolName, block.input),
  });
}

function extractSafeContext(toolName: string, input: Record<string, unknown> | null): string | null {
  if (!input) return null;

  // Antigravity standard tool arguments often use Capitalized keys in some versions,
  // or specific argument names like 'CommandLine' vs 'command'.
  // We check generic patterns here.
  
  if (input.file_path) return toBasename(input.file_path);
  if (input.target_file) return toBasename(input.target_file);
  if (input.TargetFile) return toBasename(input.TargetFile);
  if (input.AbsolutePath) return toBasename(input.AbsolutePath);
  
  if (toolName === 'runCommand' || toolName === 'Bash') {
      return (input.CommandLine as string) || (input.command as string) || 'terminal';
  }
  
  if (toolName === 'searchWeb' || toolName === 'WebSearch') {
      return 'web search'; // Privacy: don't leak query
  }

  return null;
}

function extractTokens(usage: RawUsage | null): TokenUsage | null {
  if (!usage) return null;
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
  };
}
