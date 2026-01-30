#!/usr/bin/env node

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageJson(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find package.json');
    dir = parent;
  }
}

const pkg = JSON.parse(readFileSync(findPackageJson(__dirname), 'utf-8')) as {
  name: string;
  version: string;
};

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  ${pkg.name} v${pkg.version}

  Watches Claude Code session files and broadcasts events
  via WebSocket for the Pixel Office iOS app.

  Usage
    $ pixelhq [options]

  Options
    --port <number>       WebSocket server port (default: 8765)
    --claude-dir <path>   Path to Claude config directory
    --yes, -y             Skip interactive prompts (non-interactive mode)
    --verbose             Show detailed debug logging
    --help, -h            Show this help message
    --version, -v         Show version number

  Environment variables
    PIXEL_OFFICE_PORT     WebSocket server port
    CLAUDE_CONFIG_DIR     Path to Claude config directory

  Examples
    $ npx pixelhq
    $ npx pixelhq --yes
    $ npx pixelhq --port 9999
    $ npx pixelhq --verbose
    $ pixelhq --claude-dir ~/.config/claude
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isNonInteractive = args.includes('--yes') || args.includes('-y');
const isVerbose = args.includes('--verbose');

async function main(): Promise<void> {
  const { logger } = await import('../src/logger.js');
  logger.setVerbose(isVerbose);

  const { PixelOfficeBridge } = await import('../src/index.js');

  if (isNonInteractive) {
    await startBridge(PixelOfficeBridge, logger);
    return;
  }

  await showInteractiveMenu(PixelOfficeBridge, logger);
}

async function showInteractiveMenu(
  PixelOfficeBridge: typeof import('../src/index.js').PixelOfficeBridge,
  logger: typeof import('../src/logger.js').logger,
): Promise<void> {
  const { select, input } = await import('@inquirer/prompts');

  console.log('');
  console.log(`  ${pkg.name} v${pkg.version}`);
  console.log('');
  console.log('  Pixel Office Bridge watches your Claude Code sessions');
  console.log('  and streams activity to the Pixel Office iOS app as');
  console.log('  real-time pixel art animations.');
  console.log('');
  console.log('  How it works:');
  console.log('  \u2022 Watches ~/.claude/projects/ for session activity');
  console.log('  \u2022 Broadcasts events on your local network via WebSocket');
  console.log('  \u2022 iOS app discovers this bridge automatically via Bonjour');
  console.log('');
  console.log('  Security:');
  console.log('  \u2022 Only devices you pair with a one-time code can connect');
  console.log('  \u2022 No code content, file paths, or commands are transmitted');
  console.log('  \u2022 Only activity types are sent (e.g. "thinking", "reading file")');
  console.log('  \u2022 All communication stays on your local network');
  console.log('  \u2022 Open source \u2014 github.com/waynedev9598/PixelHQ-bridge');
  console.log('  \u2022 Every release is provenance-verified on npm');
  console.log('');

  let customPort: number | undefined;
  let customClaudeDir: string | undefined;

  while (true) {
    const choice = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Start bridge', value: 'start' },
        { name: 'Configure options', value: 'configure' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    if (choice === 'exit') {
      process.exit(0);
    }

    if (choice === 'configure') {
      const portInput = await input({
        message: 'WebSocket port:',
        default: String(customPort ?? 8765),
      });
      const parsedPort = parseInt(portInput, 10);
      if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
        customPort = parsedPort;
      }

      const claudeDirInput = await input({
        message: 'Claude config directory:',
        default: customClaudeDir ?? '~/.claude',
      });
      if (claudeDirInput && claudeDirInput !== '~/.claude') {
        customClaudeDir = claudeDirInput;
      }

      // Apply custom options by modifying argv before config re-reads
      if (customPort) {
        const portIdx = process.argv.indexOf('--port');
        if (portIdx !== -1) {
          process.argv[portIdx + 1] = String(customPort);
        } else {
          process.argv.push('--port', String(customPort));
        }
      }
      if (customClaudeDir) {
        const dirIdx = process.argv.indexOf('--claude-dir');
        if (dirIdx !== -1) {
          process.argv[dirIdx + 1] = customClaudeDir;
        } else {
          process.argv.push('--claude-dir', customClaudeDir);
        }
      }

      console.log('');
      console.log(`  Options updated. Port: ${customPort ?? 8765}, Claude dir: ${customClaudeDir ?? '~/.claude'}`);
      console.log('');
      continue;
    }

    if (choice === 'start') {
      await startBridge(PixelOfficeBridge, logger);
      return;
    }
  }
}

async function startBridge(
  PixelOfficeBridge: typeof import('../src/index.js').PixelOfficeBridge,
  logger: typeof import('../src/logger.js').logger,
): Promise<void> {
  const bridge = new PixelOfficeBridge();

  // Pre-flight checks
  try {
    const info = bridge.preflight();
    logger.info('\u2713 Claude Code detected at ' + info.claudeDir);
  } catch (err) {
    console.log('');
    console.log('  \u2717 Claude Code not found');
    console.log('');
    console.log('  Could not find ~/.claude/projects directory.');
    console.log('  Make sure Claude Code is installed and has been used at least once.');
    console.log('');
    console.log('  Specify a custom path:  npx pixelhq --claude-dir /path/to/claude');
    console.log('');
    process.exit(1);
  }

  // Start the bridge
  try {
    await bridge.start();
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('EADDRINUSE') || message.includes('address already in use')) {
      const { config } = await import('../src/config.js');
      console.log('');
      console.log(`  \u2717 Port ${config.wsPort} is already in use`);
      console.log('');
      console.log(`  Try a different port:  npx pixelhq --port 9999`);
      console.log('');
    } else {
      console.log('');
      console.log(`  \u2717 Failed to start: ${message}`);
      console.log('');
    }
    process.exit(1);
  }

  // Show pairing code
  const code = bridge.pairingCode;
  logger.blank();
  console.log('  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log(`  \u2551         Pairing Code: ${code}          \u2551`);
  console.log('  \u2551                                       \u2551');
  console.log('  \u2551  Enter this code in the iOS app to    \u2551');
  console.log('  \u2551  connect. Code regenerates on restart. \u2551');
  console.log('  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');
  logger.blank();
  logger.info('Waiting for Claude Code activity...');
  logger.info('Press Ctrl+C to stop');
  logger.blank();
}

main().catch((err) => {
  console.error(`  \u2717 ${(err as Error).message}`);
  process.exit(1);
});
