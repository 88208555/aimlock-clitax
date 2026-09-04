import { randomUUID } from 'node:crypto'
import { assertChainNotSuspended } from './aimlock-coordination.mjs'
import { fail } from './aimlock-local-fs.mjs'
import { bindInput, errorRecord, validatePlan } from './aimlock-chain-model.mjs'
import { assertNewExecution, executionStatus, initialState, loadExecution, recoverInterrupted,
  saveExecution, withExecutionLock } from './aimlock-chain-store.mjs'
import { callCommand, callCoordinator, callSkill, resolveContexts, verifyContexts } from './aimlock-chain-calls.mjs'
import { answerPending, prepareHuman } from './aimlock-chain-human.mjs'
import { skillOutcome } from './aimlock-chain-outcomes.mjs'

const COORDINATION_CODES = new Set(['AIMLOCK_COORDINATION_WAITING', 'AIMLOCK_COORDINATION_BLOCKED'])
const BLOCKED_LOCAL_STATUSES = new Set(['blocked', 'queued', 'denied'])
const FAILED_LOCAL_STATUSES = new Set(['failed', 'reclaimed'])
const QUEUE_BLOCK_CODES = new Set(['SWARM_COORD_QUEUE_GRANT_INVALID', 'SWARM_COORD_QUEUE_GRANT_EXPIRED',
  'SWARM_COORD_QUEUE_NOT_FOUND', 'SWARM_COORD_QUEUE_STATE_INVALID', 'SWARM_COORD_TASK_BLOCKED',
  'SWARM_COORD_BASELINE_HANDSHAKE_REQUIRED'])

export async function initializeExecution(repositoryRoot, planInput) {
  const plan = validatePlan(planInput)
  return withExecutionLock(repositoryRoot, plan.chainId, async (root, file) => {
    await assertNewExecution(file)
    const state = initialState(plan, resolveContexts(root, plan))
    await saveExecution(file, state)
    return state
  })
}

async function failedStep(session, error) {
  const { record, state, file } = session
  record.error = errorRecord(error)
  record.status = record.calls.at(-1)?.status === 'uncertain' ? 'uncertain' : 'failed'
  record.completedAt = new Date().toISOString()
  await saveExecution(file, state)
}

async function readyForWork(session, step) {
  if (step.kind === 'coordinator' || step.skillId === 'confirm-protocol') return true
  try {
    await assertChainNotSuspended({ repositoryRoot: session.root, chainId: session.state.chainId })
    return true
  } catch (error) {
    if (!COORDINATION_CODES.has(error.code)) throw error
    session.record.status = 'blocked'
    session.record.error = errorRecord(error)
    session.record.pending = { kind: 'coordination-guard' }
    await saveExecution(session.file, session.state)
    return false
  }
}

function finish(record, output, status) {
  record.output = output
  record.status = status
  record.pending = null
  record.completedAt = new Date().toISOString()
}

async function stillWaiting(session, output, pending) {
  if (output.status === 'waiting') return true
  const releasedByHuman = pending.decision?.status === 'resolved'
    && pending.decision.answer === 'resume:' + pending.input.agentId
  if (output.status !== 'blocked' || (output.wakePackage?.reason !== 'event-received' && !releasedByHuman)) return false
  const current = (await callCoordinator(session, 'status', {})).state
  const task = current.tasks.find((item) => item.taskId === pending.input.taskId)
  if (!task || ['completed', 'failed', 'reclaimed'].includes(task.status)) return false
  return current.waits.some((wait) => wait.taskId === task.taskId && wait.status === 'active')
    || current.decisions.some((decision) => decision.status === 'pending' && decision.agents.includes(task.agentId))
}

async function driveWait(session) {
  const pending = session.record.pending
  const output = await callCoordinator(session, 'wait-for-event', pending.input)
  session.record.output = output
  if (await stillWaiting(session, output, pending)) {
    session.record.status = 'waiting'
    await saveExecution(session.file, session.state)
    return
  }
  if (output.confirmProtocolRequests.length) {
    await prepareHuman(session, output.confirmProtocolRequests[0].input.interaction, pending.input)
    return
  }
  const releasedByHuman = pending.decision?.status === 'resolved'
    && pending.decision.answer === 'resume:' + pending.input.agentId
    && output.status === 'resolved'
  if (releasedByHuman) {
    finish(session.record, { ...output, status: 'resolved-by-human',
      humanDecision: pending.decision, confirmation: pending.confirmation }, 'succeeded')
  } else if (output.status === 'resolved' && output.wakePackage.reason === 'event-received') {
    finish(session.record, output, 'succeeded')
  } else {
    finish(session.record, output, 'blocked')
    session.record.error = { code: 'AIMLOCK_CHAIN_DEPENDENCY_UNFULFILLED',
      message: 'Dependency ended without its event or a human decision releasing this task' }
  }
  await saveExecution(session.file, session.state)
}

function saveQueuePending(record, output, input) {
  record.pending = { kind: 'coordinator-lock-queue', input: { queueId: output.queued.queueId,
    taskId: input.taskId, agentId: input.agentId, chainId: input.chainId } }
  record.status = 'waiting'
  record.completedAt = null
}

async function driveQueue(session) {
  await callCoordinator(session, 'tick', { now: new Date().toISOString() })
  try {
    const output = await callCoordinator(session, 'lock-queue-status', session.record.pending.input)
    session.record.output = output
    if (output.status === 'queued') session.record.status = 'waiting'
    else finish(session.record, output, output.status === 'granted' ? 'succeeded' : 'blocked')
  } catch (error) {
    if (!QUEUE_BLOCK_CODES.has(error.code)) throw error
    session.record.error = errorRecord(error)
    finish(session.record, { status: 'blocked', queueId: session.record.pending.input.queueId,
      error: session.record.error }, 'blocked')
  }
  await saveExecution(session.file, session.state)
}

async function coordinatorStep(session, step, input) {
  const output = await callCoordinator(session, step.operation, input)
  session.record.output = output
  if (step.operation === 'lock-acquire' && output.status === 'queued') {
    saveQueuePending(session.record, output, input)
  } else if (step.operation === 'dependency-wait') {
    const waitInput = { taskId: input.taskId, agentId: input.waiter, chainId: input.chainId, waitId: output.wait.waitId }
    session.record.pending = { kind: 'coordinator-wait', input: waitInput }
    session.record.status = 'waiting'
    await saveExecution(session.file, session.state)
    await driveWait(session)
  } else if (step.operation === 'wait-for-event') {
    session.record.pending = { kind: 'coordinator-wait', input }
    session.record.status = 'waiting'
    await saveExecution(session.file, session.state)
    if (await stillWaiting(session, output, session.record.pending)) {
      session.record.status = 'waiting'
    } else if (output.confirmProtocolRequests.length) {
      await prepareHuman(session, output.confirmProtocolRequests[0].input.interaction, input)
    } else if (output.status === 'resolved' && output.wakePackage.reason === 'event-received') {
      finish(session.record, output, 'succeeded')
    } else finish(session.record, output, 'blocked')
  } else {
    const status = BLOCKED_LOCAL_STATUSES.has(output.status) || output.allowed === false
      || output.undeclaredWait === true || output.decisions?.some((item) => item.confirmationRequired)
      ? 'blocked' : FAILED_LOCAL_STATUSES.has(output.status) ? 'failed' : 'succeeded'
    finish(session.record, output, status)
  }
}

async function executeStep(session, step) {
  if (!await readyForWork(session, step)) return
  const input = bindInput(step, session.state)
  session.record.input = input
  session.record.status = 'running'
  session.record.error = null
  session.record.startedAt = new Date().toISOString()
  session.record.attemptId = 'attempt-' + randomUUID()
  await saveExecution(session.file, session.state)
  if (step.kind === 'command') {
    const output = await callCommand(session, input)
    finish(session.record, output, output.status)
  } else if (step.kind === 'coordinator') await coordinatorStep(session, step, input)
  else {
    const output = await callSkill(session, step.skillId, step.operation, input)
    if (step.skillId === 'confirm-protocol' && step.operation === 'interaction-request' && output.status === 'succeeded') {
      session.record.status = 'waiting'
      session.record.output = output
      session.record.pending = { kind: 'human', interaction: output.interaction, waitInput: null,
        presentation: output.chatFallback, response: output,
        continueWhen: Object.hasOwn(step, 'continueWhen') ? step.continueWhen : null }
    } else {
      const outcome = skillOutcome(step, output)
      finish(session.record, output, outcome.status)
      session.record.error = outcome.error
    }
  }
  await saveExecution(session.file, session.state)
}

async function advance(root, file, state, dependencies) {
  for (const step of state.plan.steps) {
    const record = state.steps.find((item) => item.stepId === step.stepId)
    if (record.status === 'succeeded') continue
    if (record.status === 'blocked' && step.kind === 'coordinator' && step.operation === 'lock-acquire'
      && record.output?.status === 'queued' && record.input) saveQueuePending(record, record.output, record.input)
    const session = { root, file, state, record, dependencies }
    if (['failed', 'uncertain'].includes(record.status)) return state
    if (record.status === 'waiting' && record.pending?.kind === 'human') return state
    if (record.status === 'blocked' && record.pending?.kind !== 'coordination-guard') return state
    if (step.dependsOn.some((id) => state.steps.find((item) => item.stepId === id).status !== 'succeeded')) {
      fail('AIMLOCK_CHAIN_DEPENDENCY_INVALID', 'previous dependency has not succeeded')
    }
    try {
      if (record.status === 'waiting' && record.pending?.kind === 'coordinator-lock-queue') await driveQueue(session)
      else if (record.status === 'waiting' && record.pending?.kind === 'coordinator-wait') await driveWait(session)
      else await executeStep(session, step)
    } catch (error) { await failedStep(session, error) }
    if (record.status !== 'succeeded') return state
  }
  return state
}

export async function resumeExecution(repositoryRoot, chainId, dependencies) {
  return withExecutionLock(repositoryRoot, chainId, async (root, file) => {
    const state = await loadExecution(file)
    verifyContexts(root, state)
    recoverInterrupted(state)
    await saveExecution(file, state)
    return advance(root, file, state, dependencies)
  })
}

export async function answerExecution(repositoryRoot, chainId, terminal, dependencies) {
  return withExecutionLock(repositoryRoot, chainId, async (root, file) => {
    const state = await loadExecution(file)
    verifyContexts(root, state)
    recoverInterrupted(state)
    await saveExecution(file, state)
    const record = state.steps.find((item) => item.status !== 'succeeded')
    if (!record) fail('AIMLOCK_CHAIN_NOT_WAITING_FOR_HUMAN', 'execution is complete')
    const session = { root, file, state, record, dependencies }
    try { await answerPending(session, terminal) } catch (error) {
      if (record.status !== 'running') throw error
      await failedStep(session, error)
      return state
    }
    return advance(root, file, state, dependencies)
  })
}

export { executionStatus }
