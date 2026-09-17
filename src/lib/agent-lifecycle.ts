/**
 * Server-side agent process lifecycle management.
 *
 * Provides functions to start, stop, and restart nanobot agent processes.
 * All process management happens server-side -- the browser never
 * spawns processes or talks to agent ports directly.
 *
 * Uses port-based PID lookup (lsof) and process group kill (PGID)
 * to cleanly manage agent process trees without zombies.
 */

import { spawn, execSync } from 'node:child_process'
import os from 'node:os'
import type { DiscoveredAgent } from '@/types/agent-health'

// ---------------------------------------------------------------------------
// PID / Port Utilities
// ---------------------------------------------------------------------------

/**
 * Find the PID of the process listening on a given port.
 * Uses `lsof -ti :{port}` which returns one PID per line.
 * Returns the first PID found, or null if no process is on that port.
 */
export function findPidByPort(port: number): number | null {
  try {
    const output = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim()
    if (!output) return null
    const pid = parseInt(output.split('\n')[0], 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null // No process on that port (lsof exits non-zero)
  }
}

/**
 * Find the PID of a nanobot gateway process by command pattern.
 * Fallback when the gateway process doesn't listen on a TCP port.
 * Matches `nanobot gateway --port {port}` first, then bare `nanobot gateway`.
 */
export function findPidByCommand(port: number): number | null {
  try {
    const output = execSync(`pgrep -f "nanobot gateway.*--port ${port}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (output) {
      const pid = parseInt(output.split('\n')[0], 10)
      if (!isNaN(pid)) return pid
    }
  } catch {
    // No exact port match
  }

  try {
    // Gateway without --port flag (uses default port from config)
    const output = execSync(
      'ps -eo pid,command | grep "[n]anobot gateway" | grep -v -- "--port"',
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim()
    if (output) {
      const pid = parseInt(output.trim().split(/\s+/)[0], 10)
      if (!isNaN(pid)) return pid
    }
  } catch {
    // No match
  }

  return null
}

/**
 * Find the PID of a nanobot gateway process, trying port-based lookup first
 * then falling back to command pattern matching.
 */
export function findAgentPid(port: number): number | null {
  return findPidByPort(port) ?? findPidByCommand(port)
}

/**
 * Get the process group ID (PGID) for a given PID.
 * Used to kill the entire process tree (agent + all child processes).
 */
export function getProcessGroupId(pid: number): number | null {
  try {
    const output = execSync(`ps -o pgid= -p ${pid}`, { encoding: 'utf-8' }).trim()
    const pgid = parseInt(output, 10)
    return isNaN(pgid) ? null : pgid
  } catch {
    return null
  }
}

/**
 * Check if a port is available (nothing listening on it).
 */
export function isPortAvailable(port: number): boolean {
  return findPidByPort(port) === null
}

/**
 * Find which discovered agent is using a given port.
 * Useful for port conflict error messages.
 */
export function findPortOwnerAgent(
  port: number,
  agents: DiscoveredAgent[]
): DiscoveredAgent | null {
  return agents.find(a => a.gatewayPort === port) ?? null
}

// ---------------------------------------------------------------------------
// launchd Integration
// ---------------------------------------------------------------------------

/**
 * Find the launchd service label managing a given PID.
 * Parses `launchctl list` output to match PID → service label.
 * Returns null if the process is not managed by launchd.
 */
export function findLaunchdService(pid: number): string | null {
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8', timeout: 5000 })
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts[0] === String(pid)) {
        return parts[2] ?? null
      }
    }
  } catch {
    // launchctl not available or failed
  }
  return null
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/** Maximum stderr bytes to capture for error diagnosis */
const MAX_STDERR_BYTES = 4096

/**
 * Start an agent. If managed by launchd, uses `launchctl start`.
 * Otherwise spawns a detached process from its launch script.
 */
export function startAgent(
  agent: DiscoveredAgent,
  launchdPlist?: string | null
): { pid: number | null; error?: string } {
  // Use launchctl load if plist path is known (re-enables the service after unload)
  if (launchdPlist) {
    try {
      execSync(`launchctl load ${launchdPlist}`, { encoding: 'utf-8', timeout: 10000 })
      // launchctl load is async -- PID not immediately known
      return { pid: null }
    } catch (err: any) {
      return { pid: null, error: `launchctl load failed: ${err.message}` }
    }
  }

  try {
    const isRootAgent = agent.launchScript === ''

    const command = isRootAgent ? 'nanobot' : 'bash'
    const args = isRootAgent
      ? ['gateway', '--port', String(agent.gatewayPort)]
      : [agent.launchScript]

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'], // capture stderr only
      env: process.env,
    })

    // Collect stderr for error diagnosis (capped)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_STDERR_BYTES) {
        stderr = stderr.slice(-MAX_STDERR_BYTES)
      }
    })

    // Allow dashboard to exit without killing agent
    child.unref()

    return { pid: child.pid ?? null }
  } catch (err: any) {
    return { pid: null, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/**
 * Stop an agent. If managed by launchd, uses `launchctl unload` to stop
 * and prevent KeepAlive respawn. Otherwise falls back to process group kill.
 *
 * @param port - The gateway port the agent is configured on
 * @param signal - SIGTERM (graceful) or SIGKILL (force)
 */
export function stopAgent(
  port: number,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): { killed: boolean; pid: number | null; error?: string; launchdLabel?: string; launchdPlist?: string } {
  const pid = findAgentPid(port)
  if (!pid) {
    return { killed: false, pid: null, error: 'No process found' }
  }

  // Check if managed by launchd
  const label = findLaunchdService(pid)
  if (label) {
    // Find the plist file path
    const home = process.env.HOME || os.homedir()
    const plistPath = `${home}/Library/LaunchAgents/${label}.plist`
    try {
      // unload stops the service AND prevents KeepAlive respawn
      execSync(`launchctl unload ${plistPath}`, { encoding: 'utf-8', timeout: 10000 })
      return { killed: true, pid, launchdLabel: label, launchdPlist: plistPath }
    } catch (err: any) {
      return { killed: false, pid, error: `launchctl unload failed: ${err.message}` }
    }
  }

  // Non-launchd: use process group kill
  const pgid = getProcessGroupId(pid)
  if (!pgid) {
    return { killed: false, pid, error: 'Could not determine process group' }
  }

  try {
    process.kill(-pgid, signal)
    return { killed: true, pid }
  } catch (err: any) {
    return { killed: false, pid, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Wait / Restart
// ---------------------------------------------------------------------------

/**
 * Poll until the port is released (no process listening).
 * Returns true if port was released before timeout, false otherwise.
 */
export async function waitForPortRelease(
  port: number,
  timeoutMs = 5000
): Promise<boolean> {
  const start = Date.now()
  const pollMs = 200

  while (Date.now() - start < timeoutMs) {
    if (isPortAvailable(port)) return true
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }

  return isPortAvailable(port)
}

/**
 * Restart an agent: stop, wait for process exit, then start.
 * For launchd-managed services, uses launchctl stop then start.
 */
export async function restartAgent(
  agent: DiscoveredAgent
): Promise<{ pid: number | null; error?: string }> {
  const stopResult = stopAgent(agent.gatewayPort)
  if (!stopResult.killed && stopResult.error !== 'No process found') {
    return { pid: null, error: `Stop failed: ${stopResult.error}` }
  }

  // Wait for process to exit
  if (stopResult.killed && stopResult.pid) {
    const exited = await waitForProcessExit(stopResult.pid)
    if (!exited) {
      return { pid: null, error: 'Process did not exit after stop -- try force kill' }
    }
  }

  // Start the agent (pass launchd plist if known)
  return startAgent(agent, stopResult.launchdPlist)
}

/**
 * Poll until a process has exited.
 */
export async function waitForProcessExit(
  pid: number,
  timeoutMs = 10000
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0)
      await new Promise(r => setTimeout(r, 500))
    } catch {
      return true // Process gone
    }
  }
  return false
}
