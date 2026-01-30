import { TypedEmitter } from './typed-emitter.js';
import { createSessionEvent } from './pixel-events.js';
import { config } from './config.js';
import { logger } from './logger.js';
import type { PixelEvent, SessionInfo, BridgeState } from './types.js';

interface SessionManagerEvents {
  event: [PixelEvent];
}

/**
 * Manages active sessions, agent tracking, and state sync.
 * Stateless event registry — idle detection lives on the iOS client.
 */
export class SessionManager extends TypedEmitter<SessionManagerEvents> {
  sessions: Map<string, SessionInfo>;
  private _reapTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    super();
    this.sessions = new Map();
    this._reapTimer = null;
  }

  startReaper(): void {
    this.stopReaper();
    this._reapTimer = setInterval(() => this._reapStaleSessions(), config.sessionReapIntervalMs);
    this._reapTimer.unref();
  }

  stopReaper(): void {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }

  _reapStaleSessions(): void {
    const now = Date.now();
    for (const [sessionId, info] of this.sessions) {
      const age = now - info.lastEventAt.getTime();
      if (age > config.sessionTtlMs) {
        logger.verbose('Session', `Reaping stale session: ${sessionId.slice(0, 8)}... (idle ${Math.round(age / 1000)}s)`);
        this.removeSession(sessionId);
      }
    }
  }

  registerSession(
    sessionId: string,
    project: string,
    agentId: string | null = null,
    source: string = 'claude-code',
  ): SessionInfo {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        sessionId,
        project,
        source,
        lastEventAt: new Date(),
        agentIds: new Set(),
        pendingTaskIds: new Set(),
        pendingSpawnQueue: [],
        agentIdMap: new Map(),
        deferredAgentFiles: [],
      };
      this.sessions.set(sessionId, session);

      logger.verbose('Session', `New session registered: ${sessionId.slice(0, 8)}... (${project})`);
      logger.status(`\u2191 streaming session ${sessionId.slice(0, 8)}...`);

      this.emit('event', createSessionEvent(sessionId, 'started', {
        project,
        source,
      }));
    }

    if (agentId && !session.agentIds.has(agentId)) {
      session.agentIds.add(agentId);
    }

    return session;
  }

  recordActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastEventAt = new Date();
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    logger.verbose('Session', `Session removed: ${sessionId.slice(0, 8)}...`);

    this.emit('event', createSessionEvent(sessionId, 'ended', {
      project: session.project,
      source: session.source,
    }));
  }

  // -------------------------------------------------------------------------
  // Agent / Task tracking
  // -------------------------------------------------------------------------

  trackTaskSpawn(sessionId: string, toolUseId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingTaskIds.add(toolUseId);
    session.pendingSpawnQueue.push(toolUseId);
    this._processDeferredAgentFiles(sessionId);
  }

  handleTaskResult(sessionId: string, toolUseId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.pendingTaskIds.delete(toolUseId);
  }

  isTaskPending(sessionId: string, toolUseId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.pendingTaskIds.has(toolUseId);
  }

  agentCompleted(sessionId: string, agentId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.agentIds.delete(agentId);

    for (const [fileId, mappedId] of session.agentIdMap) {
      if (mappedId === agentId) {
        session.agentIdMap.delete(fileId);
        break;
      }
    }

    logger.verbose('Session', `Agent completed: ${agentId} in session ${sessionId.slice(0, 8)}...`);
  }

  // -------------------------------------------------------------------------
  // Agent file correlation (FIFO)
  // -------------------------------------------------------------------------

  correlateAgentFile(sessionId: string, fileAgentId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.agentIdMap.has(fileAgentId)) return;

    if (session.pendingSpawnQueue.length > 0) {
      const toolUseId = session.pendingSpawnQueue.shift()!;
      session.agentIdMap.set(fileAgentId, toolUseId);
      logger.verbose('Session', `Correlated agent file ${fileAgentId} \u2192 ${toolUseId}`);
    } else {
      if (!session.deferredAgentFiles.includes(fileAgentId)) {
        session.deferredAgentFiles.push(fileAgentId);
      }
    }
  }

  private _processDeferredAgentFiles(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    while (session.deferredAgentFiles.length > 0 && session.pendingSpawnQueue.length > 0) {
      const fileAgentId = session.deferredAgentFiles.shift()!;
      const toolUseId = session.pendingSpawnQueue.shift()!;
      session.agentIdMap.set(fileAgentId, toolUseId);
      logger.verbose('Session', `Deferred correlation: ${fileAgentId} \u2192 ${toolUseId}`);
    }
  }

  resolveAgentId(sessionId: string, fileAgentId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return fileAgentId;
    return session.agentIdMap.get(fileAgentId) ?? fileAgentId;
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  getState(): BridgeState {
    const sessions = [];

    for (const [sessionId, info] of this.sessions) {
      sessions.push({
        sessionId,
        project: info.project,
        source: info.source,
        lastEventAt: info.lastEventAt.toISOString(),
        agentIds: Array.from(info.agentIds),
        pendingTaskIds: Array.from(info.pendingTaskIds),
      });
    }

    return {
      sessions,
      timestamp: new Date().toISOString(),
    };
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  cleanup(): void {
    this.stopReaper();
    this.sessions.clear();
  }
}
