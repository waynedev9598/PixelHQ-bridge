import { claudeCodeAdapter } from './adapters/claude-code.js';
import type { PixelEvent, RawJsonlEvent } from './types.js';

type Adapter = (raw: RawJsonlEvent) => PixelEvent[];

const adapters: Record<string, Adapter> = {
  'claude-code': claudeCodeAdapter,
};

/**
 * Parse a raw JSONL line from a session file.
 * Source-agnostic — just validates JSON and injects session metadata.
 */
export function parseJsonlLine(
  line: string,
  sessionId: string,
  agentId: string | null = null,
): RawJsonlEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const raw = JSON.parse(trimmed) as RawJsonlEvent;
    raw._sessionId = sessionId;
    raw._agentId = agentId;
    return raw;
  } catch (err) {
    console.error(`[Parser] Failed to parse JSONL: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Transform a raw parsed JSONL object into PixelEvent(s) using the appropriate adapter.
 */
export function transformToPixelEvents(
  raw: RawJsonlEvent,
  source: string = 'claude-code',
): PixelEvent[] {
  const adapter = adapters[source];
  if (!adapter) {
    console.warn(`[Parser] No adapter for source: ${source}`);
    return [];
  }
  return adapter(raw);
}
