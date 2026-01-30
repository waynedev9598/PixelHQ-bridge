import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { config } from './config.js';
import { logger } from './logger.js';
import type { AuthManager } from './auth.js';
import type { PixelEvent, BridgeState, ClientMessage } from './types.js';

/**
 * WebSocket server for broadcasting events to authenticated iOS clients.
 */
export class BroadcastServer {
  private wss: WebSocketServer | null;
  private clients: Set<WebSocket>;
  private authenticatedClients: Set<WebSocket>;
  private authManager: AuthManager;
  private onStateRequest: (() => BridgeState) | null;

  constructor(authManager: AuthManager) {
    this.wss = null;
    this.clients = new Set();
    this.authenticatedClients = new Set();
    this.authManager = authManager;
    this.onStateRequest = null;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: config.wsPort,
        clientTracking: true,
      });

      this.wss.on('listening', () => {
        logger.verbose('WebSocket', `Server listening on port ${config.wsPort}`);
        resolve();
      });

      this.wss.on('error', (error: Error) => {
        logger.error('WebSocket', `Server error: ${error.message}`);
        reject(error);
      });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleConnection(ws, req);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        for (const client of this.clients) {
          client.close();
        }
        this.clients.clear();
        this.authenticatedClients.clear();

        this.wss.close(() => {
          logger.verbose('WebSocket', 'Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientIp = req.socket.remoteAddress;
    logger.verbose('WebSocket', `Client connected: ${clientIp}`);
    logger.status('\u25CF Device connected');

    this.clients.add(ws);

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data);
    });

    ws.on('close', () => {
      logger.verbose('WebSocket', `Client disconnected: ${clientIp}`);
      logger.status('\u25CF Device disconnected');
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
    });

    ws.on('error', (error: Error) => {
      logger.error('WebSocket', `Client error: ${error.message}`);
      this.clients.delete(ws);
      this.authenticatedClients.delete(ws);
    });

    this.sendTo(ws, {
      type: 'welcome',
      payload: {
        message: 'Connected to Pixel Office Bridge',
        version: config.version,
        authRequired: true,
      },
    });
  }

  private handleMessage(ws: WebSocket, data: Buffer): void {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;

      if (!this.authenticatedClients.has(ws)) {
        if (message.type === 'ping') {
          this.sendTo(ws, { type: 'pong' });
          return;
        }
        if (message.type === 'auth') {
          this.handleAuth(ws, message);
          return;
        }
        this.sendTo(ws, {
          type: 'auth_failed',
          payload: { reason: 'Authentication required' },
        });
        return;
      }

      switch (message.type) {
        case 'ping':
          this.sendTo(ws, { type: 'pong' });
          break;

        case 'subscribe':
          logger.verbose('WebSocket', `Client subscribed to: ${message.sessionId || 'all'}`);
          break;

        case 'get_state':
          if (this.onStateRequest) {
            const state = this.onStateRequest();
            this.sendTo(ws, { type: 'state', payload: state });
          }
          break;

        default:
          logger.verbose('WebSocket', `Unknown message type: ${(message as { type: string }).type}`);
      }
    } catch (err) {
      logger.error('WebSocket', `Failed to parse message: ${(err as Error).message}`);
    }
  }

  private handleAuth(ws: WebSocket, message: ClientMessage & { type: 'auth' }): void {
    if (message.token) {
      if (this.authManager.validateToken(message.token)) {
        this.authenticatedClients.add(ws);
        logger.verbose('WebSocket', 'Client authenticated via token');
        logger.status('\u25CF Device reconnected');
        this.sendTo(ws, {
          type: 'auth_success',
          payload: { token: message.token },
        });
        return;
      }
      logger.verbose('WebSocket', 'Token auth failed \u2014 invalid token');
      this.sendTo(ws, {
        type: 'auth_failed',
        payload: { reason: 'Invalid or revoked token' },
      });
      return;
    }

    if (message.pairingCode) {
      const result = this.authManager.validatePairingCode(
        message.pairingCode,
        message.deviceName,
      );
      if (result) {
        this.authenticatedClients.add(ws);
        logger.verbose('WebSocket', 'Client paired with code, issued token');
        logger.status('\u25CF Device paired successfully');
        this.sendTo(ws, {
          type: 'auth_success',
          payload: { token: result.token },
        });
        return;
      }
      logger.verbose('WebSocket', 'Pairing code auth failed \u2014 wrong code');
      this.sendTo(ws, {
        type: 'auth_failed',
        payload: { reason: 'Invalid pairing code' },
      });
      return;
    }

    this.sendTo(ws, {
      type: 'auth_failed',
      payload: { reason: 'Provide pairingCode or token' },
    });
  }

  private sendTo(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(event: PixelEvent): void {
    if (this.authenticatedClients.size === 0) return;

    const message = JSON.stringify({
      type: 'event',
      payload: event,
    });

    let sentCount = 0;
    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        sentCount++;
      }
    }

    if (sentCount > 0 && event.type !== 'activity') {
      const detail = ('tool' in event ? event.tool : '') || ('action' in event ? event.action : '') || '';
      logger.verbose('WebSocket', `\u2192 ${event.type}${detail ? `: ${detail}` : ''}`);
    }
  }

  sendState(ws: WebSocket, state: BridgeState): void {
    this.sendTo(ws, {
      type: 'state',
      payload: state,
    });
  }

  broadcastState(state: BridgeState): void {
    const message = JSON.stringify({
      type: 'state',
      payload: state,
    });

    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClientCount(): number {
    return this.authenticatedClients.size;
  }

  setStateRequestHandler(callback: () => BridgeState): void {
    this.onStateRequest = callback;
  }
}
