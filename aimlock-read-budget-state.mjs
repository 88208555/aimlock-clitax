import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appendAudit, atomicJson, ensureManagedDirectory, fail, identifier, managedPath,
  repositoryRoot, withFileLock } from './aimlock-local-fs.mjs'

const BUDGET_SCHEMA = 'aimlock.read-budget/1.0'
const TOKEN_ESTIMATE_ALGORITHM = 'utf8-bytes-div-4-ceil'
const READ_BUDGETS = Object.freeze({
  lock: Object.freeze({ maxFiles: 3, maxTokenEstimate: null, maxDurationMs: 120_000 }),
  probe: Object.freeze({ maxFiles: 10, maxTokenEstimate: 30_000, maxDurationMs: 480_000 }),
  swarm: Object.freeze({ maxFiles: 30, maxTokenEstimate: 100_000, maxDurationMs: 3_600_000 }),
})

function readBudgetEnforced(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('AIMLOCK_EXECUTION_CONTEXT_REQUIRED', 'bind the actual executionContext with budget-context; do not request a budget extension')
  }
  if (context.executionIsolation === 'local' && Object.keys(context).length === 1) return false
  if (Object.keys(context).length !== 2 || typeof context.cloudSandboxEnabled !== 'boolean'
    || !['sandbox', 'direct'].includes(context.executionIsolation)
    || (context.executionIsolation === 'sandbox' && !context.cloudSandboxEnabled)) {
    fail('AIMLOCK_EXECUTION_CONTEXT_INVALID', 'executionContext must describe local execution or the actual cloud sandbox preference and execution isolation')
  }
  return context.cloudSandboxEnabled && context.executionIsolation === 'sandbox'
}

function assertCloudReadBudget(state) {
  if (!readBudgetEnforced(state.executionContext)) {
    fail('AIMLOCK_BUDGET_NOT_APPLICABLE', 'this task continues automatically; cloud read-budget approval does not apply')
  }
}

async function readBudget(root, chainId) {
  const id = identifier(chainId, 'chainId')
  const path = managedPath(root, 'runs', id, 'read-budget.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (state.schemaVersion !== BUDGET_SCHEMA || state.chainId !== id) {
    fail('AIMLOCK_BUDGET_INVALID', 'read budget authority is invalid')
  }
  return { path, state }
}

function budgetView(state, now = Date.now()) {
  if (state.completedAt) {
    return { ...state, enforcement: 'completed', elapsedMs: null, maxFiles: null, maxTokenEstimate: null,
      maxDurationMs: null, remainingFiles: null, remainingTokenEstimate: null, remainingDurationMs: null,
      autoRenewEligible: false, decisionRequired: true, nextActions: [] }
  }
  const elapsedMs = readBudgetElapsed(state, now)
  if (!readBudgetEnforced(state.executionContext)) {
    return { ...state, enforcement: 'continuous', elapsedMs, maxFiles: null, maxTokenEstimate: null,
      maxDurationMs: null, remainingFiles: null, remainingTokenEstimate: null, remainingDurationMs: null,
      autoRenewEligible: false, decisionRequired: false, nextActions: ['budget-read'] }
  }
  const remainingFiles = Math.max(0, state.maxFiles - state.meteredFiles.length)
  const remainingTokenEstimate = state.maxTokenEstimate === null ? null
    : Math.max(0, state.maxTokenEstimate - state.meteredTokenEstimate)
  const remainingDurationMs = Math.max(0, state.maxDurationMs - elapsedMs)
  const autoRenewEligible = !state.completedAt && remainingDurationMs === 0
    && remainingFiles > 0 && remainingTokenEstimate !== 0 && state.autoRenew?.status === 'active'
    && requiredRenewalIntervals(state, now) <= state.autoRenew.policy.maxRenewals - state.autoRenew.renewalCount
  const decisionRequired = Boolean(state.completedAt) || remainingFiles === 0 || (remainingDurationMs === 0 && !autoRenewEligible)
    || remainingTokenEstimate === 0
  return { ...state, enforcement: 'cloud-sandbox', elapsedMs, remainingFiles, remainingTokenEstimate, remainingDurationMs,
    autoRenewEligible, decisionRequired,
    nextActions: decisionRequired ? ['execute', 'plan', 'blocked'] : autoRenewEligible ? ['budget-read'] : [] }
}

function requiredRenewalIntervals(state, now = Date.now()) {
  if (!state.autoRenew) return null
  return Math.max(0, Math.floor((readBudgetElapsed(state, now) - state.maxDurationMs)
    / state.autoRenew.policy.intervalMs) + 1)
}

function readBudgetElapsed(state, now) {
  const enforced = readBudgetEnforced(state.executionContext)
  return state.meteredElapsedMs + (enforced ? now - Date.parse(state.meteredStartedAt) : 0)
}

async function initializeReadBudget(input) {
  const enforced = readBudgetEnforced(input.executionContext)
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  const limits = READ_BUDGETS[input.mode]
  if (!limits) fail('AIMLOCK_MODE_INVALID', 'mode must be lock, probe, or swarm')
  const directory = await ensureManagedDirectory(root, 'runs', chainId)
  const startedAt = new Date().toISOString()
  const state = {
    schemaVersion: BUDGET_SCHEMA,
    chainId,
    mode: input.mode,
    executionContext: input.executionContext,
    startedAt,
    meteredStartedAt: enforced ? startedAt : null,
    meteredElapsedMs: 0,
    ...limits,
    uniqueFiles: [],
    readCalls: 0,
    tokenEstimate: 0,
    meteredFiles: [],
    meteredTokenEstimate: 0,
    tokenEstimateAlgorithm: TOKEN_ESTIMATE_ALGORITHM,
    extensions: [],
  }
  await writeFile(resolve(directory, 'read-budget.json'), `${JSON.stringify(state)}\n`, {
    flag: 'wx', mode: 0o600,
  })
  await appendAudit(root, { event: 'read-budget-initialized', chainId, mode: input.mode,
    executionContext: input.executionContext })
  return budgetView(state)
}

async function configureReadBudgetContext(input) {
  const enforced = readBudgetEnforced(input.executionContext)
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  return withFileLock(managedPath(root, 'runs', chainId, 'read-budget.json'), async () => {
    const { path, state } = await readBudget(root, chainId)
    const legacy = !Object.hasOwn(state, 'executionContext')
    const now = Date.now()
    const updated = { ...state, executionContext: input.executionContext,
      meteredStartedAt: enforced ? new Date(now).toISOString() : null,
      meteredElapsedMs: legacy ? now - Date.parse(state.startedAt) : readBudgetElapsed(state, now),
      meteredFiles: legacy ? state.uniqueFiles : state.meteredFiles,
      meteredTokenEstimate: legacy ? state.tokenEstimate : state.meteredTokenEstimate }
    await atomicJson(path, updated)
    await appendAudit(root, { event: 'read-budget-context-bound', chainId,
      executionContext: input.executionContext, legacy })
    return budgetView(updated)
  })
}

export { BUDGET_SCHEMA, TOKEN_ESTIMATE_ALGORITHM, READ_BUDGETS, readBudget, budgetView,
  requiredRenewalIntervals, initializeReadBudget, configureReadBudgetContext, readBudgetEnforced, assertCloudReadBudget }
