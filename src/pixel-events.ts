import { v4 as uuidv4 } from 'uuid';
import type {
  SessionEvent,
  ActivityEvent,
  ToolEvent,
  AgentEvent,
  ErrorEvent,
  SummaryEvent,
  TokenUsage,
} from './types.js';

export function createSessionEvent(
  sessionId: string,
  action: 'started' | 'ended',
  { project, model, source }: { project?: string; model?: string; source?: string } = {},
): SessionEvent {
  return {
    id: uuidv4(),
    type: 'session',
    sessionId,
    timestamp: new Date().toISOString(),
    action,
    ...(project && { project }),
    ...(model && { model }),
    ...(source && { source }),
  };
}

export function createActivityEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  action: 'thinking' | 'responding' | 'waiting' | 'user_prompt',
  tokens: TokenUsage | null = null,
): ActivityEvent {
  return {
    id: uuidv4(),
    type: 'activity',
    sessionId,
    ...(agentId && { agentId }),
    timestamp,
    action,
    ...(tokens && { tokens }),
  };
}

export function createToolEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  { tool, detail, status, toolUseId, context }: {
    tool: string;
    detail?: string;
    status: 'started' | 'completed' | 'error';
    toolUseId: string;
    context?: string | null;
  },
): ToolEvent {
  return {
    id: uuidv4(),
    type: 'tool',
    sessionId,
    ...(agentId && { agentId }),
    timestamp,
    tool,
    ...(detail && { detail }),
    status,
    toolUseId,
    ...(context && { context }),
  };
}

export function createAgentEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  action: 'spawned' | 'completed' | 'error',
  agentRole: string | null = null,
): AgentEvent {
  return {
    id: uuidv4(),
    type: 'agent',
    sessionId,
    ...(agentId && { agentId }),
    timestamp,
    action,
    ...(agentRole && { agentRole }),
  };
}

export function createErrorEvent(
  sessionId: string,
  agentId: string | null,
  timestamp: string,
  severity: 'warning' | 'error',
): ErrorEvent {
  return {
    id: uuidv4(),
    type: 'error',
    sessionId,
    ...(agentId && { agentId }),
    timestamp,
    severity,
  };
}

export function createSummaryEvent(
  sessionId: string,
  timestamp: string,
): SummaryEvent {
  return {
    id: uuidv4(),
    type: 'summary',
    sessionId,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Privacy utilities
// ---------------------------------------------------------------------------

export function toBasename(filePath: unknown): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  const parts = filePath.split('/');
  return parts[parts.length - 1] || null;
}

export function toProjectName(projectPath: unknown): string | null {
  if (!projectPath || typeof projectPath !== 'string') return null;
  const cleaned = projectPath.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || null;
}
