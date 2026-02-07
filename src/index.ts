import { existsSync } from 'fs';
import { SessionWatcher } from './watcher.js';
import { SessionManager } from './session.js';
import { BroadcastServer } from './websocket.js';
import { BonjourAdvertiser } from './bonjour.js';
import { AuthManager } from './auth.js';
import { parseJsonlLine, transformToPixelEvents } from './parser.js';
import { createAgentEvent } from './pixel-events.js';
import { config } from './config.js';
import { logger } from './logger.js';

export interface PreflightResult {
  claudeDir: string;
  codexDir: string | null;
  port: number;
  pairedDevices: number;
}

/**
 * Pixel Office Bridge Server
 *
 * Watches AI agent session files (Claude Code, Codex CLI) and broadcasts
 * events to connected iOS clients via WebSocket.
 */
export class PixelOfficeBridge {
  private watcher: SessionWatcher;
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private server: BroadcastServer;
  private bonjour: BonjourAdvertiser;
  private isRunning: boolean;

  constructor() {
    this.watcher = new SessionWatcher();
    this.sessionManager = new SessionManager();
    this.authManager = new AuthManager();
    this.server = new BroadcastServer(this.authManager);
    this.bonjour = new BonjourAdvertiser();
    this.isRunning = false;
  }

  /** Run pre-flight validation without starting anything */
  preflight(): PreflightResult {
    const hasClaudeCode = existsSync(config.claudeDir);
    const hasCodex = config.codexDir !== null && existsSync(config.codexDir);

    if (!hasClaudeCode && !hasCodex) {
      throw new Error(
        'No supported agent found. Tried:\n' +
        `  - Claude Code at ${config.claudeDir}\n` +
        (config.codexDir ? `  - Codex at ${config.codexDir}\n` : '') +
        '\nInstall Claude Code or Codex CLI to use the bridge.'
      );
    }

    return {
      claudeDir: config.claudeDir,
      codexDir: config.codexDir,
      port: config.wsPort,
      pairedDevices: this.authManager.tokens.size,
    };
  }

  /** Get the pairing code (generated at construction) */
  get pairingCode(): string {
    return this.authManager.pairingCode;
  }

  /** Get the local IP address after bonjour starts */
  get localIP(): string {
    return this.bonjour.localIP;
  }

  async start(): Promise<void> {
    try {
      await this.server.start();
      logger.info('\u2713 WebSocket server on port ' + config.wsPort);

      this.server.setStateRequestHandler(() => {
        return this.sessionManager.getState();
      });

      this.bonjour.start();
      logger.info('\u2713 Broadcasting on local network (' + this.bonjour.localIP + ')');

      this.setupEventHandlers();
      this.watcher.start();
      this.sessionManager.startReaper();

      this.isRunning = true;

      logger.verbose('Bridge', `Claude dir: ${config.claudeDir} (${config.claudeDirResolvedVia})`);
      logger.verbose('Bridge', `Watching: ${config.projectsDir}`);

      if (config.codexDir) {
        logger.verbose('Bridge', `Codex dir: ${config.codexDir} (${config.codexDirResolvedVia})`);
        logger.verbose('Bridge', `Watching: ${config.codexSessionsDir}`);
      }

      this.setupShutdownHandlers();

    } catch (error) {
      logger.error('Bridge', `Failed to start: ${(error as Error).message}`);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    this.watcher.on('session', ({ sessionId, agentId, project, source }) => {
      this.sessionManager.registerSession(sessionId, project, agentId, source || 'claude-code');

      if (agentId) {
        this.sessionManager.correlateAgentFile(sessionId, agentId);
      }
    });

    this.watcher.on('line', ({ line, sessionId, agentId, filePath, source }) => {
      this.handleNewLine(line, sessionId, agentId, filePath, source || 'claude-code');
    });

    this.watcher.on('error', (error) => {
      logger.error('Bridge', `Watcher error: ${error.message}`);
    });

    this.sessionManager.on('event', (event) => {
      this.server.broadcast(event);
    });
  }

  private handleNewLine(
    line: string,
    sessionId: string,
    agentId: string | null,
    filePath: string,
    source: string = 'claude-code',
  ): void {
    if (!this.sessionManager.sessions.has(sessionId)) {
      const { project } = this.watcher.parseFilePath(filePath);
      this.sessionManager.registerSession(sessionId, project, agentId, source);
    }

    const resolvedAgentId = agentId
      ? this.sessionManager.resolveAgentId(sessionId, agentId)
      : agentId;
    const raw = parseJsonlLine(line, sessionId, resolvedAgentId);
    if (!raw) return;

    const events = transformToPixelEvents(raw, source);

    this.sessionManager.recordActivity(sessionId);

    for (const event of events) {
      if (event.type === 'tool' && event.tool === 'spawn_agent' && event.status === 'started') {
        this.sessionManager.trackTaskSpawn(sessionId, event.toolUseId);
      }

      if (event.type === 'tool' && (event.status === 'completed' || event.status === 'error')) {
        if (this.sessionManager.handleTaskResult(sessionId, event.toolUseId)) {
          const agentCompletedEvent = createAgentEvent(
            sessionId,
            event.toolUseId,
            event.timestamp,
            event.status === 'error' ? 'error' : 'completed',
          );
          this.server.broadcast(agentCompletedEvent);
          this.sessionManager.agentCompleted(sessionId, event.toolUseId);
        }
      }

      this.server.broadcast(event);
    }
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.blank();
      logger.verbose('Bridge', `Received ${signal}, shutting down...`);

      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    await this.watcher.stop();
    this.bonjour.stop();
    await this.server.stop();
    this.sessionManager.cleanup();

    logger.verbose('Bridge', 'Shutdown complete');
  }
}
