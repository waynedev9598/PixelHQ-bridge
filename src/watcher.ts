import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, statSync } from 'fs';
import { createInterface } from 'readline';
import { join, basename, dirname } from 'path';
import { TypedEmitter } from './typed-emitter.js';
import { config } from './config.js';
import { logger } from './logger.js';
import type { WatcherSessionEvent, WatcherLineEvent, ParsedFilePath } from './types.js';

interface WatcherEvents {
  session: [WatcherSessionEvent];
  line: [WatcherLineEvent];
  error: [Error];
}

/**
 * Watches Claude Code session JSONL files for new events.
 * Emits 'line' events for each new JSONL line.
 */
export class SessionWatcher extends TypedEmitter<WatcherEvents> {
  private watcher: FSWatcher | null;
  private filePositions: Map<string, number>;
  private trackedSessions: Set<string>;

  constructor() {
    super();
    this.watcher = null;
    this.filePositions = new Map();
    this.trackedSessions = new Set();
  }

  start(): void {
    const watchPatterns = [
      join(config.projectsDir, '*', '*.jsonl'),
      join(config.projectsDir, '*', '*', 'subagents', '*.jsonl'),
    ];

    logger.verbose('Watcher', 'Starting file watcher...');

    this.watcher = watch(watchPatterns, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: config.watchDebounce,
        pollInterval: 50,
      },
      usePolling: false,
    });

    this.watcher
      .on('add', (filePath: string) => this.handleFileAdd(filePath))
      .on('change', (filePath: string) => this.handleFileChange(filePath))
      .on('error', (error: Error) => this.emit('error', error));

    logger.verbose('Watcher', 'File watcher started');
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.verbose('Watcher', 'File watcher stopped');
    }
  }

  handleFileAdd(filePath: string): void {
    try {
      const stats = statSync(filePath);
      const now = Date.now();
      const modifiedAgo = now - stats.mtimeMs;

      const recencyThreshold = 10 * 60 * 1000;

      if (modifiedAgo > recencyThreshold) {
        this.filePositions.set(filePath, stats.size);
        return;
      }

      const { sessionId, agentId, project } = this.parseFilePath(filePath);
      const minutesAgo = Math.round(modifiedAgo / 60000);

      logger.verbose('Watcher', `Tracking recent session: ${sessionId.slice(0, 8)}... (${minutesAgo}m ago)`);

      this.filePositions.set(filePath, stats.size);
      this.trackedSessions.add(sessionId);

      this.emit('session', {
        sessionId,
        agentId,
        project,
        filePath,
        action: 'discovered',
      });
    } catch (err) {
      logger.error('Watcher', `Error reading file stats: ${(err as Error).message}`);
    }
  }

  async handleFileChange(filePath: string): Promise<void> {
    const { sessionId, agentId } = this.parseFilePath(filePath);
    const previousPosition = this.filePositions.get(filePath) || 0;

    try {
      const stats = statSync(filePath);
      const currentSize = stats.size;

      if (currentSize <= previousPosition) {
        return;
      }

      if (!this.trackedSessions.has(sessionId)) {
        const { project } = this.parseFilePath(filePath);
        logger.verbose('Watcher', `Session became active: ${sessionId.slice(0, 8)}...`);
        this.trackedSessions.add(sessionId);

        this.emit('session', {
          sessionId,
          agentId,
          project,
          filePath,
          action: 'discovered',
        });
      }

      const newLines = await this.readNewLines(filePath, previousPosition);
      this.filePositions.set(filePath, currentSize);

      for (const line of newLines) {
        if (line.trim()) {
          this.emit('line', {
            line,
            sessionId,
            agentId,
            filePath,
          });
        }
      }
    } catch (err) {
      logger.error('Watcher', `Error reading file changes: ${(err as Error).message}`);
    }
  }

  readNewLines(filePath: string, startPosition: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const stream = createReadStream(filePath, {
        start: startPosition,
        encoding: 'utf8',
      });

      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => lines.push(line));
      rl.on('close', () => resolve(lines));
      rl.on('error', reject);
    });
  }

  parseFilePath(filePath: string): ParsedFilePath {
    const fileName = basename(filePath, '.jsonl');
    const dirPath = dirname(filePath);

    const isSubagent = dirPath.includes('/subagents');

    let sessionId: string;
    let agentId: string | null = null;
    let project: string;

    if (isSubagent) {
      agentId = fileName;
      const subagentsDir = dirname(dirPath);
      sessionId = basename(subagentsDir);
      project = basename(dirname(subagentsDir));
    } else {
      sessionId = fileName;
      project = basename(dirPath);
    }

    const projectPath = project.replace(/^-/, '/').replace(/-/g, '/');

    return {
      sessionId,
      agentId,
      project: projectPath,
    };
  }
}
