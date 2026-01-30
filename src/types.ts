// ---------------------------------------------------------------------------
// Shared types for the Pixel Office bridge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ---------------------------------------------------------------------------
// PixelEvent discriminated union
// ---------------------------------------------------------------------------

interface BaseEvent {
  id: string;
  sessionId: string;
  timestamp: string;
}

export interface SessionEvent extends BaseEvent {
  type: 'session';
  action: 'started' | 'ended';
  project?: string;
  model?: string;
  source?: string;
}

export interface ActivityEvent extends BaseEvent {
  type: 'activity';
  agentId?: string;
  action: 'thinking' | 'responding' | 'waiting' | 'user_prompt';
  tokens?: TokenUsage;
}

export interface ToolEvent extends BaseEvent {
  type: 'tool';
  agentId?: string;
  tool: string;
  detail?: string;
  status: 'started' | 'completed' | 'error';
  toolUseId: string;
  context?: string;
}

export interface AgentEvent extends BaseEvent {
  type: 'agent';
  agentId?: string;
  action: 'spawned' | 'completed' | 'error';
  agentRole?: string;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  agentId?: string;
  severity: 'warning' | 'error';
}

export interface SummaryEvent extends BaseEvent {
  type: 'summary';
}

export type PixelEvent =
  | SessionEvent
  | ActivityEvent
  | ToolEvent
  | AgentEvent
  | ErrorEvent
  | SummaryEvent;

// ---------------------------------------------------------------------------
// Session info (managed by SessionManager)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  project: string;
  source: string;
  lastEventAt: Date;
  agentIds: Set<string>;
  pendingTaskIds: Set<string>;
  pendingSpawnQueue: string[];
  agentIdMap: Map<string, string>;
  deferredAgentFiles: string[];
}

// ---------------------------------------------------------------------------
// Bridge state (returned by getState)
// ---------------------------------------------------------------------------

export interface SessionStateEntry {
  sessionId: string;
  project: string;
  source: string;
  lastEventAt: string;
  agentIds: string[];
  pendingTaskIds: string[];
}

export interface BridgeState {
  sessions: SessionStateEntry[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Token entry (persisted by AuthManager)
// ---------------------------------------------------------------------------

export interface TokenEntry {
  token: string;
  deviceName: string;
  pairedAt: string;
}

// ---------------------------------------------------------------------------
// Tool category mapping
// ---------------------------------------------------------------------------

export interface ToolMapping {
  category: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Raw JSONL types (from Claude Code session files)
// ---------------------------------------------------------------------------

export interface RawJsonlEvent {
  type: string;
  timestamp?: string;
  message?: RawMessage;
  userType?: string;
  _sessionId: string;
  _agentId: string | null;
}

export interface RawMessage {
  content?: RawContentBlock[] | string;
  usage?: RawUsage;
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type RawContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: string; is_error?: boolean };

// ---------------------------------------------------------------------------
// Watcher events
// ---------------------------------------------------------------------------

export interface WatcherSessionEvent {
  sessionId: string;
  agentId: string | null;
  project: string;
  filePath: string;
  action: 'discovered';
}

export interface WatcherLineEvent {
  line: string;
  sessionId: string;
  agentId: string | null;
  filePath: string;
}

export interface ParsedFilePath {
  sessionId: string;
  agentId: string | null;
  project: string;
}

// ---------------------------------------------------------------------------
// WebSocket client messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'auth'; token?: string; pairingCode?: string; deviceName?: string }
  | { type: 'subscribe'; sessionId?: string }
  | { type: 'get_state' };

// ---------------------------------------------------------------------------
// WebSocket server messages
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'welcome'; payload: { message: string; version: string; authRequired: boolean } }
  | { type: 'pong' }
  | { type: 'auth_success'; payload: { token: string } }
  | { type: 'auth_failed'; payload: { reason: string } }
  | { type: 'event'; payload: PixelEvent }
  | { type: 'state'; payload: BridgeState };
