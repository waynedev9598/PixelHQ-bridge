/**
 * Centralized logger with normal and verbose modes.
 *
 * Normal mode (default): clean, minimal output for end users.
 * Verbose mode (--verbose): shows all [Module] prefixed debug logs.
 */

let _verbose = false;

export const logger = {
  /** Always shown — important milestones */
  info(message: string): void {
    console.log(`  ${message}`);
  },

  /** Only in verbose mode — debug details */
  verbose(tag: string, message: string): void {
    if (_verbose) {
      console.log(`[${tag}] ${message}`);
    }
  },

  /** Always shown — errors */
  error(tag: string, message: string): void {
    console.error(`[${tag}] ${message}`);
  },

  /** User-facing status updates (e.g., "● Device connected") */
  status(message: string): void {
    console.log(`  ${message}`);
  },

  /** Blank line */
  blank(): void {
    console.log('');
  },

  /** Set verbose mode */
  setVerbose(enabled: boolean): void {
    _verbose = enabled;
  },

  /** Check if verbose mode is enabled */
  isVerbose(): boolean {
    return _verbose;
  },
};
