import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { healthMonitor } from '@/lib/health-monitor'
import { eventBus } from '@/lib/event-bus'
import { stopAgent } from '@/lib/agent-lifecycle'

/**
 * POST /api/agents/[id]/force-stop
 *
 * Force kill an agent by sending SIGKILL to its process group.
 * Requires operator+ role. This is the escalation path after
 * a graceful stop (SIGTERM) did not terminate the process.
 *
 * Does not require a new lock if one already exists from a prior stop.
 * If no lock exists, acquires one (direct force kill is also valid).
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

  // Check existing lock -- force-stop is an escalation of stop/restart
  const existingLock = healthMonitor.getLock(id)
  if (existingLock) {
    // Allow escalation from stop or restart; block if another action is in progress
    if (existingLock.action !== 'stop' && existingLock.action !== 'restart') {
      return NextResponse.json(
        { error: `${existingLock.action} in progress -- please wait` },
        { status: 409 }
      )
    }
    // Existing stop/restart lock -- okay to escalate, no new lock needed
  } else {
    // No existing lock -- acquire one for force_stop
    const lock = healthMonitor.acquireLock(id, 'force_stop', auth.user.username)
    if (!lock.acquired) {
      return NextResponse.json(
        { error: lock.error },
        { status: 409 }
      )
    }
  }

  // Broadcast operation
  eventBus.broadcast('agent.lifecycle', {
    workspace_id: 1,
    id,
    action: 'force_stop',
    status: 'pending',
    username: auth.user.username,
    timestamp: Date.now(),
  })

  // Send SIGKILL to process group
  const { gatewayPort } = snapshot.agent
  const result = stopAgent(gatewayPort, 'SIGKILL')

  const status = result.killed ? 'success' : 'error'

  eventBus.broadcast('agent.lifecycle', {
    workspace_id: 1,
    id,
    action: 'force_stop',
    status,
    error: result.error,
    username: auth.user.username,
    timestamp: Date.now(),
  })

  // Always release lock after force kill
  healthMonitor.releaseLock(id)

  if (!result.killed) {
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

  return NextResponse.json({
    success: true,
    agentId: id,
    pid: result.pid,
    status: 'killed',
  })
}
