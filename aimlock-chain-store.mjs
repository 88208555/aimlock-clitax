import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { atomicJson, ensureManagedDirectory, fail, identifier, repositoryRoot, resolvedProjectPath } from './aimlock-local-fs.mjs'
import { STATE_SCHEMA, chainStatus, planDigest, validatePlan } from './aimlock-chain-model.mjs'

const LOCK_WAIT_MS = 2_000
const LOCK_POLL_MS = 20
const RECORD_STATUSES = new Set(['pending', 'running', 'waiting', 'blocked', 'failed', 'uncertain', 'succeeded'])

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('AIMLOCK_CHAIN_LOCK_INVALID', 'execution lock has no valid process owner')
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function ownerOf(directory) {
  try {
    const file = resolve(directory, 'owner.json')
    const status = await lstat(file)
    if (status.isSymbolicLink() || !status.isFile()) fail('AIMLOCK_CHAIN_LOCK_INVALID', 'execution lock owner is not a regular file')
    const owner = JSON.parse(await readFile(file, 'utf8'))
    identifier(owner.lockId, 'execution lockId')
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('AIMLOCK_CHAIN_LOCK_INVALID', 'execution lock owner pid is invalid')
    return owner
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function retireLock(directory, retiredDirectory, owner) {
  const retired = resolve(retiredDirectory, identifier(owner.lockId, 'execution lockId'))
  try { await rename(directory, retired) } catch (error) {
    if (error.code === 'ENOENT') return
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    const previous = await ownerOf(retired)
    if (!previous || previous.lockId !== owner.lockId || previous.pid !== owner.pid) {
      fail('AIMLOCK_CHAIN_LOCK_INVALID', 'retired lock identity does not match')
    }
  }
  // Keep this non-empty retirement record: a stale contender cannot move a newer active lock over it.
}

async function inspectLock(directory) {
  try {
    const status = await lstat(directory)
    if (status.isSymbolicLink() || !status.isDirectory()) fail('AIMLOCK_CHAIN_LOCK_INVALID', 'execution lock is not a real directory')
    return ownerOf(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function acquire(directory, retiredDirectory) {
  const owner = { lockId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }
  const candidate = resolve(dirname(directory), 'candidate-' + owner.lockId)
  await mkdir(candidate, { mode: 0o700 })
  await atomicJson(resolve(candidate, 'owner.json'), owner)
  const deadline = Date.now() + LOCK_WAIT_MS
  let published = false
  try {
    while (true) {
      try {
        // Publishing the populated directory is atomic; an interrupted preparation never occupies lock.
        await rename(candidate, directory)
        published = true
        return owner
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      }
      const current = await inspectLock(directory)
      if (current && !alive(current.pid)) { await retireLock(directory, retiredDirectory, current); continue }
      if (Date.now() >= deadline) fail('AIMLOCK_CHAIN_BUSY', 'another process owns this execution or its lock is invalid')
      await delay(LOCK_POLL_MS)
    }
  } finally {
    if (!published) {
      await unlink(resolve(candidate, 'owner.json'))
      await rmdir(candidate)
    }
  }
}

export async function withExecutionLock(rootValue, chainId, action) {
  const root = await repositoryRoot(rootValue)
  identifier(chainId, 'chainId')
  const directory = await ensureManagedDirectory(root, 'executions', chainId)
  const retiredDirectory = await ensureManagedDirectory(root, 'executions', chainId, 'retired')
  const lockDirectory = resolve(directory, 'lock')
  const owner = await acquire(lockDirectory, retiredDirectory)
  try { return await action(root, resolve(directory, 'state.json')) } finally {
    const current = await ownerOf(lockDirectory)
    if (!current || current.lockId !== owner.lockId) fail('AIMLOCK_CHAIN_LOCK_INVALID', 'execution lock ownership changed')
    await retireLock(lockDirectory, retiredDirectory, owner)
  }
}

export function initialState(plan, contexts) {
  const validated = validatePlan(plan)
  const now = new Date().toISOString()
  return { schemaVersion: STATE_SCHEMA, chainId: plan.chainId, plan: validated, planDigest: planDigest(validated),
    contexts, createdAt: now, updatedAt: now, status: 'ready',
    steps: plan.steps.map(({ stepId }) => ({ stepId, status: 'pending', input: null, output: null,
      pending: null, calls: [], error: null, startedAt: null, completedAt: null, attemptId: null })) }
}

export async function saveExecution(file, state) {
  state.updatedAt = new Date().toISOString()
  state.status = chainStatus(state)
  await atomicJson(file, state)
}

export async function loadExecution(file) {
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink()) fail('AIMLOCK_CHAIN_STATE_INVALID', 'execution state must be a regular file')
  const state = JSON.parse(await readFile(file, 'utf8'))
  const plan = validatePlan(state.plan)
  if (state.schemaVersion !== STATE_SCHEMA || state.chainId !== plan.chainId || state.planDigest !== planDigest(plan)
    || !Array.isArray(state.steps) || state.steps.length !== plan.steps.length
    || state.steps.some((step, index) => step.stepId !== plan.steps[index].stepId || !RECORD_STATUSES.has(step.status)
      || !Array.isArray(step.calls))) fail('AIMLOCK_CHAIN_STATE_INVALID', 'execution state does not match its immutable plan')
  state.status = chainStatus(state)
  return state
}

export async function executionStatus(rootValue, chainId) {
  const root = await repositoryRoot(rootValue)
  identifier(chainId, 'chainId')
  const file = await resolvedProjectPath(root, '.aimlock/executions/' + chainId + '/state.json')
  return loadExecution(file.target)
}

export async function assertNewExecution(file) {
  try { await lstat(file) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  fail('AIMLOCK_CHAIN_EXISTS', 'execution already exists; use resume or a new chainId')
}

export function recoverInterrupted(state) {
  for (const step of state.steps) {
    const lastCall = step.calls.at(-1)
    if (step.status === 'waiting' && step.pending?.kind === 'coordinator-wait'
      && lastCall?.kind === 'coordinator' && lastCall.operation === 'wait-for-event'
      && lastCall.status === 'started') {
      lastCall.status = 'interrupted-read'
      lastCall.completedAt = new Date().toISOString()
    }
    if (step.status !== 'running') continue
    if (step.pending?.kind === 'coordinator-wait'
      && step.calls.at(-1)?.kind === 'coordinator' && step.calls.at(-1)?.operation === 'wait-for-event') {
      step.calls.at(-1).status = 'interrupted-read'
      step.status = 'waiting'
      continue
    }
    step.status = 'uncertain'
    step.error = { code: 'AIMLOCK_CHAIN_INTERRUPTED', message: 'The previous process stopped during an operation. Effects are uncertain; automatic replay is forbidden.' }
    step.completedAt = new Date().toISOString()
  }
}
