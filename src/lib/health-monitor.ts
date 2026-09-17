/**
 * Health monitor singleton.
 *
 * Runs periodic health checks on discovered agents and broadcasts
 * status changes via eventBus for SSE consumption.
 *
 * Stored on globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs'
import path from 'node:path'
import { eventBus } from '@/lib/event-bus'
import { discoverAgents } from '@/lib/agent-discovery'
import { checkAgentHealth, computeCompositeHealth } from '@/lib/agent-health'
import type { AgentHealthSnapshot, LifecycleLock, LifecycleAction } from '@/types/agent-health'

class HealthMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private lastSnapshot: Map<string, AgentHealthSnapshot> = new Map()
  private intervalMs = 30_000
  private ticking = false
  private lifecycleLocks: Map<string, LifecycleLock> = new Map()
  private static LOCK_TIMEOUT_MS = 30_000 // auto-expire after 30s

  /**
   * Start the health check loop. Idempotent -- no-op if already running.
   * Runs an immediate check, then repeats on the configured interval.
   */
  start(): void {
    if (this.intervalId) return
    this.tick()
    this.intervalId = setInterval(() => this.tick(), this.intervalMs)
  }

  /**
   * Stop the health check loop.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Change the polling interval. Restarts the loop if currently running.
   */
  setInterval(ms: number): void {
    this.intervalMs = ms
    if (this.intervalId) {
      this.stop()
      this.start()
    }
  }

  /**
   * Run a single health check tick.
   * Discovers agents, checks health, detects changes, broadcasts events.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true

    try {
      const agents = discoverAgents()
      const snapshots: AgentHealthSnapshot[] = []

      for (const agent of agents) {
        const snapshot = await checkAgentHealth(agent)
        snapshots.push(snapshot)
      }

      // Detect new agents
      const currentIds = new Set(snapshots.map(s => s.id))
      const previousIds = new Set(this.lastSnapshot.keys())

      for (const snapshot of snapshots) {
        if (!previousIds.has(snapshot.id)) {
          // New agent discovered
          eventBus.broadcast('agent.created', {
            workspace_id: 1,
            id: snapshot.id,
            name: snapshot.name,
            status: snapshot.health.overall,
            health: snapshot.health,
          })
        } else {
          // Check for status changes
          const prev = this.lastSnapshot.get(snapshot.id)
          if (prev && prev.health.overall !== snapshot.health.overall) {
            eventBus.broadcast('agent.status_changed', {
              workspace_id: 1,
              id: snapshot.id,
              name: snapshot.name,
              status: snapshot.health.overall,
              previousStatus: prev.health.overall,
              health: snapshot.health,
            })
          }
        }
      }

      // Detect removed agents
      for (const id of previousIds) {
        if (!currentIds.has(id)) {
          eventBus.broadcast('agent.deleted', { workspace_id: 1, id })
        }
      }

      // Preserve dismissed state from previous snapshot and filter pre-dismiss errors
      for (const snapshot of snapshots) {
        const prev = this.lastSnapshot.get(snapshot.id)
        if (prev?.errorsDismissed && prev.errorsDismissedAt) {
          const dismissedAt = new Date(prev.errorsDismissedAt).getTime()
          const originalCount = snapshot.errors.length
          // Keep only errors that occurred after the dismiss
          snapshot.errors = snapshot.errors.filter(
            e => new Date(e.timestamp).getTime() > dismissedAt
          )
          // If new errors appeared, clear dismissed flag; otherwise preserve it
          if (snapshot.errors.length === 0) {
            snapshot.errorsDismissed = true
            snapshot.errorsDismissedAt = prev.errorsDismissedAt
          }
          // else: new errors → don't carry over dismissed flag

          // Recompute health if errors were filtered out
          if (snapshot.errors.length !== originalCount) {
            const criticalErrors = snapshot.errors.some(e => e.type === 'crash')
            const channelsDown = snapshot.channels
              .filter(c => c.enabled && !c.connected)
              .map(c => c.name)
            snapshot.health = computeCompositeHealth({
              processAlive: snapshot.health.dimensions.process.level !== 'red',
              lastActivityMs: snapshot.lastActivity
                ? new Date(snapshot.lastActivity.timestamp).getTime()
                : null,
              errorCount24h: snapshot.errors.length,
              criticalErrors,
              channelsDown,
              totalChannels: snapshot.channels.length,
            })
          }
        }
      }

      // Update cache
      this.lastSnapshot.clear()
      for (const s of snapshots) {
        this.lastSnapshot.set(s.id, s)
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Get all cached agent health snapshots.
   */
  getSnapshot(): AgentHealthSnapshot[] {
    return Array.from(this.lastSnapshot.values())
  }

  /**
   * Get a single agent's health snapshot by ID.
   */
  getAgentSnapshot(id: string): AgentHealthSnapshot | undefined {
    return this.lastSnapshot.get(id)
  }

  /**
   * Dismiss errors for an agent. Clears the error badge in the cached snapshot.
   * Broadcasts agent.status_changed so UI updates.
   */
  dismissErrors(id: string): boolean {
    const snapshot = this.lastSnapshot.get(id)
    if (!snapshot) return false

    snapshot.errorsDismissed = true
    snapshot.errorsDismissedAt = new Date().toISOString()
    snapshot.errors = []

    // Truncate the error log file on disk so errors don't reappear after restart
    const errorLogPath = path.join(snapshot.agent.workspacePath, 'logs', `${snapshot.agent.id}-error.log`)
    try {
      if (fs.existsSync(errorLogPath)) {
        fs.writeFileSync(errorLogPath, '')
      }
    } catch {
      // Non-critical -- log truncation failed, errors may reappear
    }

    eventBus.broadcast('agent.status_changed', {
      workspace_id: 1,
      id: snapshot.id,
      name: snapshot.name,
      status: snapshot.health.overall,
      health: snapshot.health,
      errorsDismissed: true,
    })

    return true
  }

  // -------------------------------------------------------------------------
  // Lifecycle Locks
  // -------------------------------------------------------------------------

  /**
   * Acquire a lifecycle lock for an agent.
   * Prevents concurrent operations on the same agent.
   * Returns { acquired: true } on success, or { acquired: false, error } if locked.
   */
  acquireLock(
    agentId: string,
    action: LifecycleAction,
    username: string
  ): { acquired: boolean; error?: string } {
    this.cleanExpiredLocks()
    const existing = this.lifecycleLocks.get(agentId)
    if (existing) {
      return {
        acquired: false,
        error: `${existing.action} in progress -- please wait`,
      }
    }
    this.lifecycleLocks.set(agentId, {
      agentId,
      action,
      lockedBy: username,
      lockedAt: Date.now(),
      expiresAt: Date.now() + HealthMonitor.LOCK_TIMEOUT_MS,
    })
    return { acquired: true }
  }

  /**
   * Release a lifecycle lock for an agent.
   */
  releaseLock(agentId: string): void {
    this.lifecycleLocks.delete(agentId)
  }

  /**
   * Get the current lifecycle lock for an agent, if any.
   */
  getLock(agentId: string): LifecycleLock | null {
    this.cleanExpiredLocks()
    return this.lifecycleLocks.get(agentId) ?? null
  }

  /**
   * Remove all expired lifecycle locks.
   */
  private cleanExpiredLocks(): void {
    const now = Date.now()
    for (const [id, lock] of this.lifecycleLocks) {
      if (lock.expiresAt <= now) this.lifecycleLocks.delete(id)
    }
  }
}

// Survive HMR in development via globalThis
const g = globalThis as typeof globalThis & { __healthMonitor?: HealthMonitor }
export const healthMonitor = g.__healthMonitor ?? new HealthMonitor()
g.__healthMonitor = healthMonitor
