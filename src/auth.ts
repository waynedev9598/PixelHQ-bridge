import { randomBytes, randomInt } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from './config.js';
import { logger } from './logger.js';
import type { TokenEntry } from './types.js';

/**
 * Manages device pairing and authentication for bridge connections.
 *
 * On startup a 6-digit numeric pairing code is generated and displayed in the
 * terminal. iOS clients exchange the code for a persistent auth token (UUID)
 * which is saved to disk so it survives bridge restarts.
 */
export class AuthManager {
  pairingCode: string;
  tokenFilePath: string;
  tokens: Map<string, TokenEntry>;

  constructor(tokenFilePath?: string) {
    this.pairingCode = AuthManager.generatePairingCode();
    this.tokenFilePath = tokenFilePath ?? config.authTokenFile;
    this.tokens = new Map();
    this.loadTokens();
  }

  static generatePairingCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  validatePairingCode(code: string, deviceName: string = 'Unknown device'): { token: string } | null {
    if (code !== this.pairingCode) {
      return null;
    }

    const token = randomBytes(16).toString('hex');
    const entry: TokenEntry = {
      token,
      deviceName,
      pairedAt: new Date().toISOString(),
    };

    this.tokens.set(token, entry);
    this.saveTokens();

    return { token };
  }

  validateToken(token: string): boolean {
    return this.tokens.has(token);
  }

  revokeToken(token: string): boolean {
    const existed = this.tokens.delete(token);
    if (existed) {
      this.saveTokens();
    }
    return existed;
  }

  loadTokens(): void {
    try {
      if (existsSync(this.tokenFilePath)) {
        const data = JSON.parse(readFileSync(this.tokenFilePath, 'utf-8')) as unknown;
        if (Array.isArray(data)) {
          for (const entry of data as TokenEntry[]) {
            if (entry.token) {
              this.tokens.set(entry.token, entry);
            }
          }
        }
        logger.verbose('Auth', `Loaded ${this.tokens.size} paired device(s)`);
      }
    } catch (err) {
      logger.error('Auth', `Failed to load tokens: ${(err as Error).message}`);
    }
  }

  saveTokens(): void {
    try {
      const data = Array.from(this.tokens.values());
      writeFileSync(this.tokenFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Auth', `Failed to save tokens: ${(err as Error).message}`);
    }
  }
}
