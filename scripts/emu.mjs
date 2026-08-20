#!/usr/bin/env node
/**
 * Starts the Firebase emulator suite with a function-load timeout that this machine
 * can actually meet.
 *
 * firebase-tools gives the functions runtime 10s to answer discovery and 30s to open
 * its socket, and both limits come from the same place:
 *
 *   discovery:        getFunctionDiscoveryTimeout() || 10000
 *   worker readiness: getFunctionDiscoveryTimeout() || 30000
 *
 * with `getFunctionDiscoveryTimeout()` reading FUNCTIONS_DISCOVERY_TIMEOUT (seconds)
 * and returning 0 when unset. Cold, this project's module graph resolves through deep
 * `node_modules/.pnpm/...` paths inside a OneDrive-synced folder, and firebase-admin's
 * barrel gets loaded whole so the emulator can stub it. On a machine that has just
 * woken up, that has taken over 30 seconds.
 *
 * When it overruns, the emulator logs `Failed to load function.` and **drops the
 * event**. For a Storage trigger that means an uploaded note is never transcribed and
 * never retried — it just sits in `pending` forever, looking exactly like a note that
 * is still working. Diagnosed 2026-08-20 after a real recording was stranded.
 *
 * This only affects local development. Deployed functions have their own cold-start
 * behaviour and never read this variable.
 */
import { spawn } from 'node:child_process'

const TIMEOUT_SECONDS = '120'

const child = spawn('firebase', ['emulators:start', '--project', 'demo-marginalia'], {
  stdio: 'inherit',
  // `firebase` is a global install resolved through a shell shim on Windows.
  shell: true,
  env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: TIMEOUT_SECONDS },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
