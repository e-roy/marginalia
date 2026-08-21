#!/usr/bin/env node
/**
 * Deploys to the real Firebase project, with the same function-discovery timeout the
 * emulator launcher needs.
 *
 * `firebase deploy` loads `functions/lib` in a child process and gives it 10 seconds to
 * answer with its backend specification. That is the same 10s budget documented in
 * `scripts/emu.mjs`, and it fails here for the same reason: this project's module graph
 * resolves through deep `node_modules/.pnpm/...` paths inside a OneDrive-synced folder,
 * and firebase-admin's barrel gets loaded whole.
 *
 * When it overruns, the deploy dies with:
 *
 *   Error: User code failed to load. Cannot determine backend specification.
 *   Timeout after 10000.
 *
 * which names neither the real cause nor the fix, and looks like broken code rather
 * than a slow disk. Confirmed 2026-08-21: a bare `firebase deploy --dry-run` fails on
 * this machine, and the identical command with this variable set gets through.
 *
 * Every argument is forwarded, so `node scripts/deploy.mjs --only hosting` works.
 */
import { spawn } from 'node:child_process'

const TIMEOUT_SECONDS = '120'

const child = spawn('firebase', ['deploy', ...process.argv.slice(2)], {
  stdio: 'inherit',
  // `firebase` is a global install resolved through a shell shim on Windows.
  shell: true,
  env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: TIMEOUT_SECONDS },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
