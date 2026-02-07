import {
  createActivityEvent,
  createToolEvent,
  createAgentEvent,
  createErrorEvent,
  toBasename,
} from '../pixel-events.js';
import { CODEX_TOOL_TO_CATEGORY, ToolCategory } from '../config.js';
import type { PixelEvent, RawJsonlEvent, TokenUsage } from '../types.js';

// ---------------------------------------------------------------------------
// Codex rollout payload types (untyped — accessed via casting)
// ---------------------------------------------------------------------------

interface CodexPayload {
  type?: string;
  [key: string]: unknown;
}

/**
 * Transform a raw Codex CLI JSONL rollout line into PixelEvent(s).
 * Privacy-safe: strips all text content, full paths, commands, and queries.
 */
export function codexAdapter(raw: RawJsonlEvent): PixelEvent[] {
  const sessionId = raw._sessionId;
  const agentId = raw._agentId || null;
  const timestamp = raw.timestamp || new Date().toISOString();
  const payload = (raw as unknown as Record<string, unknown>).payload as CodexPayload | undefined;

  switch (raw.type) {
    case 'response_item':
      return handleResponseItem(payload, sessionId, agentId, timestamp);

    case 'session_meta':
    case 'turn_context':
    case 'compacted':
    case 'event_msg':
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// response_item dispatch
// ---------------------------------------------------------------------------

function handleResponseItem(
  payload: CodexPayload | undefined,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  if (!payload?.type) return [];

  switch (payload.type) {
    case 'message':
      return handleMessage(payload, sessionId, agentId, timestamp);
    case 'reasoning':
      return [createActivityEvent(sessionId, agentId, timestamp, 'thinking')];
    case 'function_call':
      return handleFunctionCall(payload, sessionId, agentId, timestamp);
    case 'function_call_output':
      return handleFunctionCallOutput(payload, sessionId, agentId, timestamp);
    case 'local_shell_call':
      return handleLocalShellCall(payload, sessionId, agentId, timestamp);
    case 'web_search_call':
      return handleWebSearchCall(payload, sessionId, agentId, timestamp);
    case 'custom_tool_call':
      return handleCustomToolCall(payload, sessionId, agentId, timestamp);
    case 'custom_tool_call_output':
      return handleCustomToolCallOutput(payload, sessionId, agentId, timestamp);
    case 'ghost_snapshot':
    case 'compaction':
    case 'other':
      return [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// message (user / assistant)
// ---------------------------------------------------------------------------

function handleMessage(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const role = payload.role as string | undefined;

  if (role === 'user') {
    const content = payload.content as unknown[] | undefined;
    if (!content || !Array.isArray(content)) return [];
    const hasText = content.some(
      (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'input_text',
    );
    if (hasText) {
      return [createActivityEvent(sessionId, agentId, timestamp, 'user_prompt')];
    }
    return [];
  }

  if (role === 'assistant') {
    const content = payload.content as unknown[] | undefined;
    if (!content || !Array.isArray(content)) return [];
    const hasOutput = content.some(
      (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'output_text',
    );
    if (hasOutput) {
      return [createActivityEvent(sessionId, agentId, timestamp, 'responding')];
    }
    return [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// function_call → tool.started
// ---------------------------------------------------------------------------

function handleFunctionCall(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const toolName = (payload.name as string) || 'unknown';
  const callId = (payload.call_id as string) || (payload.id as string) || 'unknown';
  const argsStr = payload.arguments as string | undefined;

  const mapping = CODEX_TOOL_TO_CATEGORY[toolName] || {
    category: ToolCategory.OTHER,
    detail: toolName,
  };

  const context = extractSafeContext(toolName, argsStr);

  events.push(
    createToolEvent(sessionId, agentId, timestamp, {
      tool: mapping.category,
      detail: mapping.detail,
      status: 'started',
      toolUseId: callId,
      context,
    }),
  );

  if (toolName === 'request_user_input') {
    events.push(createActivityEvent(sessionId, agentId, timestamp, 'waiting'));
  }

  if (toolName === 'spawn_agent') {
    events.push(
      createAgentEvent(sessionId, callId, timestamp, 'spawned', 'collab'),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// function_call_output → tool.completed / tool.error
// ---------------------------------------------------------------------------

function handleFunctionCallOutput(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const events: PixelEvent[] = [];
  const callId = (payload.call_id as string) || 'unknown';
  const output = (payload.output as string) || '';
  const isError = typeof output === 'string' && output.includes('Error');

  events.push(
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.OTHER,
      status: isError ? 'error' : 'completed',
      toolUseId: callId,
    }),
  );

  if (isError) {
    events.push(createErrorEvent(sessionId, agentId, timestamp, 'warning'));
  }

  return events;
}

// ---------------------------------------------------------------------------
// local_shell_call → terminal events
// ---------------------------------------------------------------------------

function handleLocalShellCall(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const id = (payload.call_id as string) || (payload.id as string) || 'unknown';
  const status = payload.status as string | undefined;

  if (status === 'completed' || status === 'failed') {
    const events: PixelEvent[] = [
      createToolEvent(sessionId, agentId, timestamp, {
        tool: ToolCategory.TERMINAL,
        detail: 'shell',
        status: status === 'failed' ? 'error' : 'completed',
        toolUseId: id,
      }),
    ];
    if (status === 'failed') {
      events.push(createErrorEvent(sessionId, agentId, timestamp, 'warning'));
    }
    return events;
  }

  // Default: started
  return [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.TERMINAL,
      detail: 'shell',
      status: 'started',
      toolUseId: id,
    }),
  ];
}

// ---------------------------------------------------------------------------
// web_search_call → search events
// ---------------------------------------------------------------------------

function handleWebSearchCall(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const id = (payload.id as string) || 'unknown';
  const status = payload.status as string | undefined;

  return [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.SEARCH,
      detail: 'web_search',
      status: status === 'completed' ? 'completed' : status === 'failed' ? 'error' : 'started',
      toolUseId: id,
    }),
  ];
}

// ---------------------------------------------------------------------------
// custom_tool_call → other events
// ---------------------------------------------------------------------------

function handleCustomToolCall(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const toolName = (payload.name as string) || 'custom';
  const callId = (payload.call_id as string) || (payload.id as string) || 'unknown';

  return [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.OTHER,
      detail: toolName,
      status: 'started',
      toolUseId: callId,
    }),
  ];
}

// ---------------------------------------------------------------------------
// custom_tool_call_output → completed/error
// ---------------------------------------------------------------------------

function handleCustomToolCallOutput(
  payload: CodexPayload,
  sessionId: string,
  agentId: string | null,
  timestamp: string,
): PixelEvent[] {
  const callId = (payload.call_id as string) || 'unknown';
  const output = (payload.output as string) || '';
  const isError = typeof output === 'string' && output.includes('Error');

  const events: PixelEvent[] = [
    createToolEvent(sessionId, agentId, timestamp, {
      tool: ToolCategory.OTHER,
      status: isError ? 'error' : 'completed',
      toolUseId: callId,
    }),
  ];

  if (isError) {
    events.push(createErrorEvent(sessionId, agentId, timestamp, 'warning'));
  }

  return events;
}

// ---------------------------------------------------------------------------
// Safe context extraction (privacy-preserving)
// ---------------------------------------------------------------------------

function extractSafeContext(toolName: string, argsStr: string | undefined): string | null {
  if (!argsStr) return null;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  switch (toolName) {
    case 'read_file':
    case 'view_image':
      return toBasename(args.path as string) || toBasename(args.file_path as string);

    case 'grep_files':
      return (args.pattern as string) || null;

    default:
      return null;
  }
}
