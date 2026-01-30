import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthManager } from '../src/auth.js';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TokenEntry } from '../src/types.js';

describe('AuthManager', () => {
  const testTokenFile = join(tmpdir(), `pixel-office-auth-test-${Date.now()}.json`);
  let auth: AuthManager;

  beforeEach(() => {
    auth = new AuthManager(testTokenFile);
  });

  afterEach(() => {
    try {
      if (existsSync(testTokenFile)) unlinkSync(testTokenFile);
    } catch { /* ignore */ }
  });

  describe('pairing code generation', () => {
    it('generates a 6-digit numeric code', () => {
      expect(auth.pairingCode).toMatch(/^\d{6}$/);
    });

    it('static method returns a 6-digit numeric code', () => {
      for (let i = 0; i < 50; i++) {
        const code = AuthManager.generatePairingCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(code).toHaveLength(6);
      }
    });
  });

  describe('validatePairingCode', () => {
    it('returns a token for the correct code', () => {
      const result = auth.validatePairingCode(auth.pairingCode);
      expect(result).not.toBeNull();
      expect(result!.token).toBeDefined();
      expect(typeof result!.token).toBe('string');
      expect(result!.token.length).toBeGreaterThan(0);
    });

    it('returns null for an incorrect code', () => {
      const result = auth.validatePairingCode('000000');
      if (auth.pairingCode !== '000000') {
        expect(result).toBeNull();
      }
    });

    it('stores device name with the token', () => {
      const result = auth.validatePairingCode(auth.pairingCode, 'My iPhone');
      expect(result).not.toBeNull();
      expect(auth.tokens.get(result!.token)!.deviceName).toBe('My iPhone');
    });

    it('stores pairedAt timestamp', () => {
      const result = auth.validatePairingCode(auth.pairingCode);
      const entry = auth.tokens.get(result!.token)!;
      expect(entry.pairedAt).toBeDefined();
      expect(new Date(entry.pairedAt).getTime()).not.toBeNaN();
    });
  });

  describe('validateToken', () => {
    it('returns true for a valid token', () => {
      const { token } = auth.validatePairingCode(auth.pairingCode)!;
      expect(auth.validateToken(token)).toBe(true);
    });

    it('returns false for an unknown token', () => {
      expect(auth.validateToken('nonexistent-token')).toBe(false);
    });
  });

  describe('revokeToken', () => {
    it('removes the token', () => {
      const { token } = auth.validatePairingCode(auth.pairingCode)!;
      expect(auth.revokeToken(token)).toBe(true);
      expect(auth.validateToken(token)).toBe(false);
    });

    it('returns false for a non-existent token', () => {
      expect(auth.revokeToken('no-such-token')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('saves tokens to disk', () => {
      auth.validatePairingCode(auth.pairingCode);
      expect(existsSync(testTokenFile)).toBe(true);

      const data = JSON.parse(readFileSync(testTokenFile, 'utf-8')) as TokenEntry[];
      expect(data).toHaveLength(1);
      expect(data[0]!.token).toBeDefined();
    });

    it('loads tokens from disk on startup', () => {
      const { token } = auth.validatePairingCode(auth.pairingCode)!;

      const auth2 = new AuthManager(testTokenFile);
      expect(auth2.validateToken(token)).toBe(true);
    });

    it('persists across revocation', () => {
      const { token } = auth.validatePairingCode(auth.pairingCode)!;
      auth.revokeToken(token);

      const auth2 = new AuthManager(testTokenFile);
      expect(auth2.validateToken(token)).toBe(false);
    });
  });
});
