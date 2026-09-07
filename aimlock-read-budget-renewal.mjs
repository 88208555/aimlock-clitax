import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { appendAudit, atomicJson, fail, identifier, managedPath, repositoryRoot,
  resolvedProjectPath, safeRelativePath, sha256, withFileLock } from './aimlock-local-fs.mjs'
import { readBudget, budgetView, requiredRenewalIntervals } from './aimlock-read-budget-state.mjs'

const RENEWAL_SCHEMA = 'aimlock.read-budget-auto-renew/1.0'
const MIN_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 86_400_000
const MAX_RENEWALS = 1_000
const RENEWAL_LIMITS = Object.freeze({ minIntervalMs: MIN_INTERVAL_MS,
  maxIntervalMs: MAX_INTERVAL_MS, maxRenewals: MAX_RENEWALS })
const RENEW_OPERATION = 'budget-auto-renew'
const RENEWAL_REASON = 'authorized-read-deadline-expired'

function renewalTerms(input) {
  const chainId = identifier(input.chainId, 'chainId')
  const scope = input.scope
  const policy = input.policy
  if (!scope || typeof scope.goal !== 'string' || !scope.goal.trim()
    || !Array.isArray(scope.allowedPaths) || scope.allowedPaths.length === 0) {
    fail('AIMLOCK_RENEWAL_SCOPE_INVALID', 'a goal and explicit repository-relative allowedPaths are required')
  }
  const paths = scope.allowedPaths.map((path) => {
    const value = safeRelativePath(path)
    if (/[*?\[\]{}]/.test(value)) fail('AIMLOCK_RENEWAL_SCOPE_INVALID', 'scope paths must be literal files or directories')
    return value
  })
  if (!policy || !Number.isSafeInteger(policy.intervalMs) || policy.intervalMs < MIN_INTERVAL_MS
    || policy.intervalMs > MAX_INTERVAL_MS || !Number.isSafeInteger(policy.maxRenewals)
    || policy.maxRenewals < 1 || policy.maxRenewals > MAX_RENEWALS) {
    fail('AIMLOCK_RENEWAL_POLICY_INVALID', 'intervalMs must be 60000..86400000; maxRenewals must be 1..1000')
  }
  const normalizedScope = { goal: scope.goal.trim(), allowedPaths: [...new Set(paths)].sort() }
  return { chainId, scope: normalizedScope, scopeDigest: sha256(JSON.stringify(normalizedScope)),
    policy: { intervalMs: policy.intervalMs, maxRenewals: policy.maxRenewals } }
}

function renewalQuestion(terms) {
  return `Allow automatic read-time renewal for chain ${terms.chainId}? Goal: ${terms.scope.goal}. `
    + `Read scope: ${terms.scope.allowedPaths.join(', ')}. Each renewal: ${terms.policy.intervalMs} ms; `
    + `maximum: ${terms.policy.maxRenewals}; total additional time: ${terms.policy.intervalMs * terms.policy.maxRenewals} ms. `
    + 'File, token and write limits remain unchanged. Revocation or task completion stops automatic renewal.'
}

async function requestReadBudgetRenewal(input) {
  const terms = renewalTerms(input)
  const root = await repositoryRoot(input.repositoryRoot)
  const { state } = await readBudget(root, terms.chainId)
  await assertReadBudgetActive(root, state)
  const requestId = identifier(input.requestId, 'requestId')
  return { schemaVersion: 'confirm.interaction/1.0', requestId, type: 'confirm',
    question: renewalQuestion(terms), options: [{ id: 'approve', label: 'Approve' }, { id: 'decline', label: 'Decline' }],
    default: null, timeout: null, timeoutAction: 'wait', risk: 'low', riskDescription: '',
    rememberable: false, memoryKey: '', callback: { operation: RENEW_OPERATION,
      payload: { chainId: terms.chainId, scopeDigest: terms.scopeDigest, policy: terms.policy } } }
}

function renewalReceipt(input, terms) {
  const response = input.confirmation
  const audit = response?.auditEntry
  const callback = response?.callbackRequest
  const payload = callback?.payload
  if (response?.schemaVersion !== 'confirm-protocol.skill.response/1.0' || response.status !== 'succeeded'
    || audit?.schemaVersion !== 'confirm.audit-entry/1.0' || audit.risk !== 'low'
    || audit.answer !== 'approve' || audit.remembered !== false || !Number.isFinite(Date.parse(audit.answeredAt))
    || audit.question !== renewalQuestion(terms) || callback?.operation !== RENEW_OPERATION
    || payload?.answer !== 'approve' || payload.chainId !== terms.chainId || payload.requestId !== audit.requestId
    || payload.scopeDigest !== terms.scopeDigest || payload.policy?.intervalMs !== terms.policy.intervalMs
    || payload.policy?.maxRenewals !== terms.policy.maxRenewals) {
    fail('AIMLOCK_CONFIRMATION_REQUIRED', 'a one-time Confirm Protocol approval bound to the chain, goal, scope and exact renewal policy is required')
  }
  identifier(response.requestId, 'confirmation.requestId')
  return { confirmationId: identifier(audit.auditId, 'auditId'), actorId: identifier(audit.actorId, 'actorId'),
    requestId: identifier(audit.requestId, 'requestId'), authorizedAt: audit.answeredAt }
}

async function authorizeReadBudgetRenewal(input) {
  const terms = renewalTerms(input)
  const receipt = renewalReceipt(input, terms)
  const root = await repositoryRoot(input.repositoryRoot)
  const budgetPath = managedPath(root, 'runs', terms.chainId, 'read-budget.json')
  return withFileLock(budgetPath, async () => {
    const { state } = await readBudget(root, terms.chainId)
    await assertReadBudgetActive(root, state)
    if (state.autoRenew) {
      const replayed = state.autoRenew.confirmationId === receipt.confirmationId
      fail(replayed ? 'AIMLOCK_CONFIRMATION_REPLAYED' : 'AIMLOCK_RENEWAL_ALREADY_AUTHORIZED',
        'this chain already has an immutable renewal authorization; use the existing policy or an explicit budget extension')
    }
    for (const path of terms.scope.allowedPaths) {
      const target = await resolvedProjectPath(root, path, { allowMissing: true })
      if (relative(root, target.target).split('\\').join('/') !== path) {
        fail('AIMLOCK_RENEWAL_SCOPE_INVALID', 'authorized paths must use their canonical repository location')
      }
    }
    const updated = { ...state, autoRenew: { schemaVersion: RENEWAL_SCHEMA,
      ...terms, ...receipt, status: 'active', renewalCount: 0, totalRenewedMs: 0, renewals: [] } }
    await atomicJson(budgetPath, updated)
    await appendAudit(root, { event: 'read-budget-auto-renew-authorized', ...terms, ...receipt })
    return budgetView(updated)
  })
}

async function executionCompleted(root, chainId) {
  let source
  try {
    source = await readFile(managedPath(root, 'executions', chainId, 'state.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const execution = JSON.parse(source)
  if (execution.chainId !== chainId || typeof execution.status !== 'string') {
    fail('AIMLOCK_CHAIN_STATE_INVALID', 'execution lifecycle does not match the read-budget chain')
  }
  return execution.status === 'succeeded'
}

async function assertReadBudgetActive(root, state) {
  if (state.completedAt || await executionCompleted(root, state.chainId)) {
    fail('AIMLOCK_BUDGET_COMPLETED', 'this task is complete; read access and automatic renewal have stopped')
  }
}

function assertRenewalScope(state, path, canonicalPath) {
  if (!state.autoRenew) return
  const paths = state.autoRenew.scope.allowedPaths
  const covered = (target) => paths.some((allowed) => target === allowed || target.startsWith(`${allowed}/`))
  if (!covered(path) || !covered(canonicalPath)) {
    fail('AIMLOCK_RENEWAL_SCOPE_MISMATCH', 'source path is outside this task\'s approved read scope')
  }
}

async function renewReadBudgetTime(root, authority, path) {
  const state = authority.state
  const now = Date.now()
  const budget = budgetView(state, now)
  if (budget.remainingDurationMs > 0) return state
  const renewal = state.autoRenew
  if (!renewal || renewal.status !== 'active') {
    fail('AIMLOCK_DECISION_REQUIRED', `read deadline exhausted; automatic renewal ${renewal ? 'was stopped' : 'requires explicit approval via budget-auto-renew-request'}`)
  }
  if (budget.remainingFiles === 0 || budget.remainingTokenEstimate === 0) {
    fail('AIMLOCK_DECISION_REQUIRED', 'file or token budget exhausted; time renewal cannot expand these limits')
  }
  const count = requiredRenewalIntervals(state, now)
  if (count > renewal.policy.maxRenewals - renewal.renewalCount) {
    fail('AIMLOCK_DECISION_REQUIRED', `automatic renewal limit exhausted: ${renewal.renewalCount}/${renewal.policy.maxRenewals} used; ${count} additional intervals required`)
  }
  const at = new Date(now).toISOString()
  const records = Array.from({ length: count }, (_, index) => ({
    count: renewal.renewalCount + index + 1, reason: RENEWAL_REASON, at, path,
    durationMs: renewal.policy.intervalMs,
    maxDurationMs: state.maxDurationMs + (index + 1) * renewal.policy.intervalMs,
  }))
  const addedMs = count * renewal.policy.intervalMs
  const updated = { ...state, maxDurationMs: state.maxDurationMs + addedMs,
    autoRenew: { ...renewal, renewalCount: renewal.renewalCount + count,
      totalRenewedMs: renewal.totalRenewedMs + addedMs, renewals: [...renewal.renewals, ...records] } }
  await atomicJson(authority.path, updated)
  for (const record of records) await appendAudit(root, { event: 'read-budget-auto-renewed',
    chainId: state.chainId, confirmationId: renewal.confirmationId, scopeDigest: renewal.scopeDigest, ...record })
  return updated
}

async function stopReadBudgetRenewal(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  if (!['revoked', 'completed'].includes(input.reason)) {
    fail('AIMLOCK_RENEWAL_STOP_INVALID', 'reason must be revoked or completed')
  }
  return withFileLock(managedPath(root, 'runs', chainId, 'read-budget.json'), async () => {
    const { state, path } = await readBudget(root, chainId)
    if (state.completedAt || (input.reason === 'revoked' && state.autoRenew?.status === 'revoked')) return budgetView(state)
    if (input.reason === 'revoked' && !state.autoRenew) {
      fail('AIMLOCK_RENEWAL_NOT_AUTHORIZED', 'this task has no automatic renewal authorization to revoke')
    }
    const at = new Date().toISOString()
    const updated = { ...state }
    if (input.reason === 'completed') updated.completedAt = at
    if (state.autoRenew) updated.autoRenew = { ...state.autoRenew, status: input.reason, stoppedAt: at }
    await atomicJson(path, updated)
    await appendAudit(root, { event: 'read-budget-auto-renew-stopped', chainId, reason: input.reason, at })
    return budgetView(updated)
  })
}

async function completeReadBudgetIfExists(root, chainId) {
  try { await readBudget(root, chainId) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  await stopReadBudgetRenewal({ repositoryRoot: root, chainId, reason: 'completed' })
}

export { RENEWAL_LIMITS, authorizeReadBudgetRenewal, requestReadBudgetRenewal, stopReadBudgetRenewal,
  assertReadBudgetActive, assertRenewalScope, renewReadBudgetTime, completeReadBudgetIfExists }
