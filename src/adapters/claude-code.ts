import {
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  createSummaryEvent,
  toBasename,
} from '../pixel-events.js';
import { TOOL_TO_CATEGORY, ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, RawUsage, TokenUsage } from '../types.js';

/**
 * Transform a raw Claude Code JSONL object into PixelEvent(s).
 * Privacy-safe: strips all text content, full paths, commands, URLs, and queries.
 */
export function claudeCodeAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const sessionId = raw._sessionId;
  const agentId = raw._agentId || null;
  const timestamp = raw.timestamp || new Date().toISOString();

  switch (raw.type) {
    case 'assistant':
      return handleAssistant(raw, sessionId, agentId, timestamp);

    case 'user':
      return handleUser(raw, sessionId, agentId, timestamp);

    case 'summary':
      return [createSummaryEvent(sessionId, timestamp)];

    case 'system':
    case 'progress':
    case 'queue-operation':
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Assistant message handling
// ---------------------------------------------------------------------------

function handleAssistant(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  if (!message?.content) return events;

  // content must be an array for assistant messages
  if (!Array.isArray(message.content)) return events;

  const tokens = extractTokens(message.usage ?? null);

  for (const block of message.content) {
    switch (block.type) {
      case 'thinking':
        events.push(
          createActivityEvent(sessionId, agentId, timestamp, 'thinking'),
        );
        break;

      case 'text':
        if (block.text === '(no content)') {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'thinking'),
          );
        } else {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'responding', tokens),
          );
        }
        break;

      case 'tool_use':
        events.push(
          buildToolStartedEvent(sessionId, agentId, timestamp, block),
        );
        if (block.name === 'Task') {
          events.push(
            createAgentEvent(
              sessionId,
              block.id,
              timestamp,
              'spawned',
              (block.input as Record<string, unknown>)?.subagent_type as string || 'general',
            ),
          );
        }
        if (block.name === 'AskUserQuestion') {
          events.push(
            createActivityEvent(sessionId, agentId, timestamp, 'waiting'),
          );
        }
        break;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// User message handling
// ---------------------------------------------------------------------------

function handleUser(
  raw: RawJsonlEvent,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const message = raw.message;
  if (!message?.content) return events;

  const content = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content;

  if (raw.userType === 'tool_result') {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const isError =
          block.is_error === true ||
          (typeof block.content === 'string' && block.content.includes('Error'));

        events.push(
          createToolEvent(sessionId, agentId, timestamp, {
            tool: ToolCategory.OTHER,
            status: isError ? 'error' : 'completed',
            toolUseId: block.tool_use_id,
          }),
        );

        if (isError) {
          events.push(
            createErrorEvent(sessionId, agentId, timestamp, 'warning'),
          );
        }
      }
    }
  } else {
    const hasText = content.some(
      (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim(),
    );
    if (hasText) {
      events.push(
        createActivityEvent(sessionId, agentId, timestamp, 'user_prompt'),
      );
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function buildToolStartedEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  block: ToolUseBlock,
): PixelEvent {
  const toolName = block.name;
  const mapping = TOOL_TO_CATEGORY[toolName] || {
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

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return toBasename(input.file_path as string);

    case 'Bash':
      return (input.description as string) || null;

    case 'Grep':
      return (input.pattern as string) || null;

    case 'Glob':
      return (input.pattern as string) || null;

    case 'Task':
      return (input.subagent_type as string) || null;

    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} items` : null;

    case 'NotebookEdit':
      return toBasename(input.notebook_path as string);

    default:
      return null;
  }
}

function extractTokens(usage: RawUsage | null): TokenUsage | null {
  if (!usage) return null;

  const tokens: TokenUsage = {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
  };

  if (usage.cache_read_input_tokens) {
    tokens.cacheRead = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens) {
    tokens.cacheWrite = usage.cache_creation_input_tokens;
  }

  return tokens;
}
