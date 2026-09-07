import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appendAudit, ensureManagedDirectory, fail, identifier, managedPath, repositoryRoot } from './aimlock-local-fs.mjs'

const BUDGET_SCHEMA = 'aimlock.read-budget/1.0'
const TOKEN_ESTIMATE_ALGORITHM = 'utf8-bytes-div-4-ceil'
const READ_BUDGETS = Object.freeze({
  lock: Object.freeze({ maxFiles: 3, maxTokenEstimate: null, maxDurationMs: 120_000 }),
  probe: Object.freeze({ maxFiles: 10, maxTokenEstimate: 30_000, maxDurationMs: 480_000 }),
  swarm: Object.freeze({ maxFiles: 30, maxTokenEstimate: 100_000, maxDurationMs: 3_600_000 }),
})

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
  const elapsedMs = now - Date.parse(state.startedAt)
  const remainingFiles = Math.max(0, state.maxFiles - state.uniqueFiles.length)
  const remainingTokenEstimate = state.maxTokenEstimate === null ? null
    : Math.max(0, state.maxTokenEstimate - state.tokenEstimate)
  const remainingDurationMs = Math.max(0, state.maxDurationMs - elapsedMs)
  const autoRenewEligible = !state.completedAt && remainingDurationMs === 0
    && remainingFiles > 0 && remainingTokenEstimate !== 0 && state.autoRenew?.status === 'active'
    && requiredRenewalIntervals(state, now) <= state.autoRenew.policy.maxRenewals - state.autoRenew.renewalCount
  const decisionRequired = Boolean(state.completedAt) || remainingFiles === 0 || (remainingDurationMs === 0 && !autoRenewEligible)
    || remainingTokenEstimate === 0
  return { ...state, elapsedMs, remainingFiles, remainingTokenEstimate, remainingDurationMs,
    autoRenewEligible, decisionRequired,
    nextActions: decisionRequired ? ['execute', 'plan', 'blocked'] : autoRenewEligible ? ['budget-read'] : [] }
}

function requiredRenewalIntervals(state, now = Date.now()) {
  if (!state.autoRenew) return null
  return Math.max(0, Math.floor((now - Date.parse(state.startedAt) - state.maxDurationMs)
    / state.autoRenew.policy.intervalMs) + 1)
}

async function initializeReadBudget(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  const limits = READ_BUDGETS[input.mode]
  if (!limits) fail('AIMLOCK_MODE_INVALID', 'mode must be lock, probe, or swarm')
  const directory = await ensureManagedDirectory(root, 'runs', chainId)
  const state = {
    schemaVersion: BUDGET_SCHEMA,
    chainId,
    mode: input.mode,
    startedAt: new Date().toISOString(),
    ...limits,
    uniqueFiles: [],
    readCalls: 0,
    tokenEstimate: 0,
    tokenEstimateAlgorithm: TOKEN_ESTIMATE_ALGORITHM,
    extensions: [],
  }
  await writeFile(resolve(directory, 'read-budget.json'), `${JSON.stringify(state)}\n`, {
    flag: 'wx', mode: 0o600,
  })
  await appendAudit(root, { event: 'read-budget-initialized', chainId, mode: input.mode })
  return budgetView(state)
}

export { BUDGET_SCHEMA, TOKEN_ESTIMATE_ALGORITHM, READ_BUDGETS, readBudget, budgetView,
  requiredRenewalIntervals, initializeReadBudget }
