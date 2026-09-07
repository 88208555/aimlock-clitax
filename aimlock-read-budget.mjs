import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { LOCAL_SCHEMA, appendAudit, atomicJson, fail, identifier, managedPath,
  repositoryRoot, resolvedProjectPath, safeRelativePath, withFileLock } from './aimlock-local-fs.mjs'
import { assertChainNotSuspended } from './aimlock-coordination.mjs'
import { readBudget, budgetView } from './aimlock-read-budget-state.mjs'
import { assertReadBudgetActive, assertRenewalScope, renewReadBudgetTime } from './aimlock-read-budget-renewal.mjs'

const CONFIRMATION_SCHEMA = 'confirm-protocol.skill.response/1.0'

async function readFileWithinBudget(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  await assertChainNotSuspended({ repositoryRoot: root, chainId })
  const budgetPath = managedPath(root, 'runs', chainId, 'read-budget.json')
  return withFileLock(budgetPath, async () => {
    const authority = await readBudget(root, chainId)
    const path = safeRelativePath(input.path)
    let state = authority.state
    await assertReadBudgetActive(root, state)
    const before = budgetView(state)
    const isNew = !state.uniqueFiles.includes(path)
    if (isNew && before.remainingFiles === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read file budget exhausted')
    const projectFile = await resolvedProjectPath(root, path)
    if (!projectFile.status.isFile()) fail('AIMLOCK_READ_NOT_FILE', `${path} is not a file`)
    assertRenewalScope(state, path, relative(root, projectFile.target).split('\\').join('/'))
    const tokenEstimate = Math.ceil(projectFile.status.size / 4)
    if (before.remainingTokenEstimate !== null && tokenEstimate > before.remainingTokenEstimate) {
      fail('AIMLOCK_DECISION_REQUIRED', 'read token estimate budget exhausted')
    }
    state = await renewReadBudgetTime(root, authority, path)
    const content = await readFile(projectFile.target, 'utf8')
    const updated = {
      ...state,
      uniqueFiles: isNew ? [...state.uniqueFiles, path] : state.uniqueFiles,
      readCalls: state.readCalls + 1,
      tokenEstimate: state.tokenEstimate + tokenEstimate,
    }
    await atomicJson(authority.path, updated)
    await appendAudit(root, { event: 'read-consumed', chainId, path, tokenEstimate })
    return { schemaVersion: LOCAL_SCHEMA, path, content, budget: budgetView(updated) }
  })
}

async function checkCachedReadAccess(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  await assertChainNotSuspended({ repositoryRoot: root, chainId })
  const budgetPath = managedPath(root, 'runs', chainId, 'read-budget.json')
  return withFileLock(budgetPath, async () => {
    const authority = await readBudget(root, chainId)
    const { state } = authority
    await assertReadBudgetActive(root, state)
    const path = safeRelativePath(input.path)
    const budget = budgetView(state)
    if (budget.remainingTokenEstimate === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read token estimate budget exhausted')
    if (!state.uniqueFiles.includes(path)) fail('AIMLOCK_CACHE_UNCHARGED', 'cached source was not read by this chain')
    const projectFile = await resolvedProjectPath(root, path)
    assertRenewalScope(state, path, relative(root, projectFile.target).split('\\').join('/'))
    return { schemaVersion: LOCAL_SCHEMA, path,
      budget: budgetView(await renewReadBudgetTime(root, authority, path)) }
  })
}

async function readBudgetStatus(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  return budgetView((await readBudget(root, input.chainId)).state)
}

function confirmedBudgetExtension(input) {
  const confirmation = input.confirmation
  const audit = confirmation?.auditEntry
  const callback = confirmation?.callbackRequest
  const payload = callback?.payload
  const fields = ['files', 'tokenEstimate', 'durationMs']
  if (!confirmation || confirmation.schemaVersion !== CONFIRMATION_SCHEMA || confirmation.status !== 'succeeded'
    || audit?.schemaVersion !== 'confirm.audit-entry/1.0' || audit.risk !== 'low' || audit.answer !== 'approve'
    || typeof audit.remembered !== 'boolean' || !Number.isFinite(Date.parse(audit.answeredAt))
    || callback?.operation !== 'budget-extend' || payload?.answer !== 'approve'
    || payload.chainId !== input.chainId || payload.requestId !== audit.requestId
    || !payload.additions || fields.some((key) => payload.additions[key] !== input.additions?.[key])) {
    fail('AIMLOCK_CONFIRMATION_REQUIRED', 'a low-risk Confirm Protocol interaction-answer bound to this chain and exact additions is required')
  }
  identifier(audit.actorId, 'actorId')
  identifier(audit.requestId, 'requestId')
  return identifier(audit.auditId, 'auditId')
}

async function extendReadBudget(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const confirmationId = confirmedBudgetExtension(input)
  const additions = input.additions
  if (!additions || !Number.isSafeInteger(additions.files) || additions.files < 0
    || !Number.isSafeInteger(additions.tokenEstimate) || additions.tokenEstimate < 0
    || !Number.isSafeInteger(additions.durationMs) || additions.durationMs < 0
    || additions.files + additions.tokenEstimate + additions.durationMs === 0) {
    fail('AIMLOCK_EXTENSION_INVALID', 'budget additions must contain a positive integer increase')
  }
  const chainId = identifier(input.chainId, 'chainId')
  const budgetPath = managedPath(root, 'runs', chainId, 'read-budget.json')
  return withFileLock(budgetPath, async () => {
    const authority = await readBudget(root, chainId)
    const state = authority.state
    await assertReadBudgetActive(root, state)
    if (state.extensions.some((item) => item.confirmationId === confirmationId)) {
      fail('AIMLOCK_CONFIRMATION_REPLAYED', 'this budget confirmation has already been applied')
    }
    const updated = {
      ...state,
      maxFiles: state.maxFiles + additions.files,
      maxTokenEstimate: state.maxTokenEstimate === null && additions.tokenEstimate === 0
        ? null : (state.maxTokenEstimate ?? 0) + additions.tokenEstimate,
      maxDurationMs: state.maxDurationMs + additions.durationMs,
      extensions: [...state.extensions, {
        confirmationId,
        additions,
        at: new Date().toISOString(),
      }],
    }
    await atomicJson(authority.path, updated)
    await appendAudit(root, { event: 'read-budget-extended', chainId,
      confirmationId, additions })
    return budgetView(updated)
  })
}

export { checkCachedReadAccess, extendReadBudget, readBudgetStatus, readFileWithinBudget }
