import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { healthMonitor } from '@/lib/health-monitor'
import { eventBus } from '@/lib/event-bus'
import { stopAgent } from '@/lib/agent-lifecycle'

/**
 * POST /api/agents/[id]/stop
 *
 * Stop an agent by sending SIGTERM to its process group.
 * Requires operator+ role. Uses lifecycle lock to prevent concurrent ops.
 * Starts background verification (10s polling for port release).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const { id } = await params
  const snapshot = healthMonitor.getAgentSnapshot(id)
  if (!snapshot) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Acquire lifecycle lock
  const lock = healthMonitor.acquireLock(id, 'stop', auth.user.username)
  if (!lock.acquired) {
    return NextResponse.json(
      { error: lock.error },
      { status: 409 }
    )
  }

  // Broadcast operation started
  eventBus.broadcast('agent.lifecycle', {
    workspace_id: 1,
    id,
    action: 'stop',
    status: 'pending',
    username: auth.user.username,
    timestamp: Date.now(),
  })

  // Send SIGTERM to process group
  const { gatewayPort } = snapshot.agent
  const result = stopAgent(gatewayPort, 'SIGTERM')

  if (!result.killed) {
    eventBus.broadcast('agent.lifecycle', {
      workspace_id: 1,
      id,
      action: 'stop',
      status: 'error',
      error: result.error,
      username: auth.user.username,
      timestamp: Date.now(),
    })
    healthMonitor.releaseLock(id)
    return NextResponse.json(
      {
        success: false,
        agentId: id,
        pid: result.pid,
        error: result.error,
      },
      { status: 500 }
    )
  }

  // Background verification: poll until process exits (10s timeout)
  const agentId = id
  const stoppedPid = result.pid!
  const username = auth.user.username

  setTimeout(async () => {
    const POLL_INTERVAL_MS = 1000
    const MAX_WAIT_MS = 10_000
    const start = Date.now()

    while (Date.now() - start < MAX_WAIT_MS) {
      try {
        process.kill(stoppedPid, 0) // Throws if process is gone
      } catch {
        // Process exited -- stop successful
        eventBus.broadcast('agent.lifecycle', {
          workspace_id: 1,
          id: agentId,
          action: 'stop',
          status: 'success',
          username,
          timestamp: Date.now(),
        })
        healthMonitor.releaseLock(agentId)
        return
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }

    // Still alive after 10s -- suggest force kill
    eventBus.broadcast('agent.lifecycle', {
      workspace_id: 1,
      id: agentId,
      action: 'stop',
      status: 'pending',
      error: 'Process did not stop within 10 seconds -- force kill may be needed',
      username,
      timestamp: Date.now(),
    })
    // Keep the lock active (lock auto-expires at 30s) so force-stop can use it
  }, 0)

  return NextResponse.json({
    success: true,
    agentId: id,
    pid: result.pid,
    status: 'stopping',
  })
}
