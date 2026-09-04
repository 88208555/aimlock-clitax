import { execFile as execFileCallback } from 'node:child_process'
import {
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  LOCAL_SCHEMA,
  appendAudit,
  atomicJson,
  ensureManagedDirectory,
  fail,
  identifier,
  managedPath,
  repositoryRoot,
  resolvedProjectPath,
  safeRelativePath,
  withFileLock,
} from './aimlock-local-fs.mjs'
import {
  PASS_SCHEMA,
  guardedWriteFile,
  issueMutationPass,
  verifyMutationPassFile,
} from './aimlock-local-gate.mjs'
import { resolveContextMapTargets } from './aimlock-context-map.mjs'
import { assertChainNotSuspended } from './aimlock-coordination.mjs'

const execFile = promisify(execFileCallback)
const BUDGET_SCHEMA = 'aimlock.read-budget/1.0'
const CONFIRMATION_SCHEMA = 'confirm-protocol.skill.response/1.0'
const MAX_DISCOVERED_FILES = 1_000
const MAX_SOURCE_BYTES = 1_048_576
const TOKEN_ESTIMATE_ALGORITHM = 'utf8-bytes-div-4-ceil'
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.aimlock', '.git', '.runtime', 'coverage', 'dist', 'node_modules',
])
const MODE_ORDER = Object.freeze(['lock', 'probe', 'swarm'])
const READ_BUDGETS = Object.freeze({
  lock: Object.freeze({ maxFiles: 3, maxTokenEstimate: null, maxDurationMs: 120_000 }),
  probe: Object.freeze({ maxFiles: 10, maxTokenEstimate: 30_000, maxDurationMs: 480_000 }),
  swarm: Object.freeze({ maxFiles: 30, maxTokenEstimate: 100_000, maxDurationMs: 900_000 }),
})
const HIGH_RISK_PATTERN = /生产数据|支付|用户隐私|密码|密钥|凭证|线上环境|production/i
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g
const schema = (required, properties) => ({ type: 'object', additionalProperties: false,
  required, properties })
const stringSchema = { type: 'string', minLength: 1 }
const stringArraySchema = { type: 'array', items: stringSchema }
const objectValueSchema = { type: 'object' }
const BUDGET_ADDITIONS_SCHEMA = schema(['files', 'tokenEstimate', 'durationMs'], {
  files: { type: 'integer', minimum: 0 }, tokenEstimate: { type: 'integer', minimum: 0 }, durationMs: { type: 'integer', minimum: 0 },
})
const BUDGET_CONFIRMATION_SCHEMA = schema(['schemaVersion', 'requestId', 'status', 'callbackRequest', 'auditEntry', 'nextStep'], {
  schemaVersion: { const: 'confirm-protocol.skill.response/1.0' }, requestId: stringSchema, status: { const: 'succeeded' },
  callbackRequest: schema(['operation', 'payload'], { operation: { const: 'budget-extend' },
    payload: schema(['chainId', 'additions', 'requestId', 'answer'], { chainId: stringSchema,
      additions: BUDGET_ADDITIONS_SCHEMA, requestId: stringSchema, answer: { const: 'approve' } }) }),
  auditEntry: schema(['schemaVersion', 'auditId', 'requestId', 'actorId', 'question', 'answer', 'remembered', 'risk', 'answeredAt'], {
    schemaVersion: { const: 'confirm.audit-entry/1.0' }, auditId: stringSchema, requestId: stringSchema, actorId: stringSchema,
    question: stringSchema, answer: { const: 'approve' }, remembered: { type: 'boolean' }, risk: { const: 'low' },
    answeredAt: { type: 'string', format: 'date-time' },
  }), nextStep: objectValueSchema,
})
const LOCAL_OPERATION_SCHEMAS = Object.freeze({
  capabilities: schema([], {}),
  probe: schema(['goal', 'targetHints'], { goal: stringSchema, targetHints: stringArraySchema,
    targetSymbols: { type: 'array', items: objectValueSchema } }),
  reassess: schema(['currentMode', 'actualFileCount', 'actualChangedLines', 'crossModule', 'needParallel', 'inherited'], {
    currentMode: { enum: ['lock', 'probe', 'swarm'] }, actualFileCount: { type: 'integer', minimum: 1 },
    actualChangedLines: { type: 'integer', minimum: 0 }, crossModule: { type: 'boolean' },
    needParallel: { type: 'boolean' }, inherited: objectValueSchema }),
  'budget-init': schema(['chainId', 'mode'], { chainId: stringSchema, mode: { enum: ['lock', 'probe', 'swarm'] } }),
  'budget-read': schema(['chainId', 'path'], { chainId: stringSchema, path: stringSchema }),
  'budget-status': schema(['chainId'], { chainId: stringSchema }),
  'budget-extend': schema(['chainId', 'confirmation', 'additions'], {
    chainId: stringSchema, confirmation: BUDGET_CONFIRMATION_SCHEMA, additions: BUDGET_ADDITIONS_SCHEMA }),
  'gate-issue': schema(['chainId', 'snapshotRoot', 'receipt', 'contract', 'nodes', 'coordinationRequired'], {
    chainId: stringSchema, snapshotRoot: stringSchema, receipt: objectValueSchema,
    contract: objectValueSchema, nodes: { type: 'array', items: objectValueSchema },
    coordinationRequired: { type: 'boolean' }, coordinationLeasePath: stringSchema,
    ttlSeconds: { type: 'integer', minimum: 1, maximum: 300 } }),
  'gate-verify': schema(['chainId', 'gatePassPath', 'targetPath'], {
    chainId: stringSchema, gatePassPath: stringSchema, targetPath: stringSchema }),
  'guarded-write': schema(['targetPath', 'content'], { chainId: stringSchema,
    gatePassPath: stringSchema, targetPath: stringSchema, content: { type: ['string', 'object'] } }),
})

async function discoverDirectory(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue
    const target = resolve(directory, entry.name)
    if (entry.isDirectory()) await discoverDirectory(root, target, files)
    else if (entry.isFile()) files.add(relative(root, target).split('\\').join('/'))
    if (files.size > MAX_DISCOVERED_FILES) {
      fail('AIMLOCK_DISCOVERY_LIMIT', `target discovery exceeds ${MAX_DISCOVERED_FILES} files`)
    }
  }
}

async function discoverTargets(root, hints) {
  if (!Array.isArray(hints) || hints.length === 0) {
    fail('AIMLOCK_TARGETS_REQUIRED', 'targetHints must be a non-empty array')
  }
  const files = new Set()
  for (const hint of hints) {
    const resolved = await resolvedProjectPath(root, hint, { allowMissing: true })
    if (!resolved.exists || resolved.status.isFile()) files.add(resolved.path)
    else if (resolved.status.isDirectory()) await discoverDirectory(root, resolved.target, files)
    else fail('AIMLOCK_TARGET_INVALID', `${resolved.path} is not a file or directory`)
  }
  if (files.size === 0) fail('AIMLOCK_TARGETS_EMPTY', 'target discovery found no files')
  return [...files].sort()
}

async function nearestPackageRoot(root, file) {
  let current = dirname(resolve(root, file))
  for (;;) {
    try {
      const packageFile = await lstat(resolve(current, 'package.json'))
      if (packageFile.isFile()) return relative(root, current).split('\\').join('/') || '.'
    } catch (error) {
      if (!(error instanceof Error && error.code === 'ENOENT')) throw error
    }
    if (current === root) return '.'
    current = dirname(current)
  }
}

function importSpecifiers(source) {
  const values = []
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const value = match[1] ?? match[2]
    if (value?.startsWith('.')) values.push(value)
  }
  return values
}

async function dependencyGraph(root, files) {
  const targetSet = new Set(files)
  const graph = new Map(files.map((file) => [file, new Set()]))
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(extname(file))) continue
    const resolved = await resolvedProjectPath(root, file, { allowMissing: true })
    if (!resolved.exists || resolved.status.size > MAX_SOURCE_BYTES) continue
    const source = await readFile(resolved.target, 'utf8')
    for (const specifier of importSpecifiers(source)) {
      const base = resolve(dirname(resolved.target), specifier)
      const candidates = [base, ...[...SOURCE_EXTENSIONS].map((suffix) => `${base}${suffix}`)]
      for (const candidate of candidates) {
        const projectPath = relative(root, candidate).split('\\').join('/')
        if (targetSet.has(projectPath)) {
          graph.get(file).add(projectPath)
          graph.get(projectPath).add(file)
          break
        }
      }
    }
  }
  return graph
}

function connectedComponents(graph) {
  const pending = new Set(graph.keys())
  let count = 0
  while (pending.size) {
    count += 1
    const queue = [pending.values().next().value]
    while (queue.length) {
      const file = queue.pop()
      if (!pending.delete(file)) continue
      queue.push(...graph.get(file))
    }
  }
  return count
}

async function historicalEstimate(root, files) {
  const { stdout } = await execFile('git', [
    '-C', root, 'log', '--format=commit:%H', '--numstat', '-n', '20', '--', ...files,
  ], { maxBuffer: 1_048_576 })
  const totals = []
  let current = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('commit:')) {
      if (current !== null) totals.push(current)
      current = 0
      continue
    }
    const match = /^(\d+)\s+(\d+)\s+/.exec(line)
    if (match && current !== null) current += Number(match[1]) + Number(match[2])
  }
  if (current !== null) totals.push(current)
  const samples = totals.filter((value) => value > 0)
  if (!samples.length) return { lines: Math.max(1, files.length), samples: 0, source: 'minimum-policy' }
  const average = Math.floor(samples.reduce((sum, value) => sum + value, 0) / samples.length)
  return {
    lines: Math.max(files.length, files.length === 1 ? Math.min(500, average) : average),
    samples: samples.length,
    source: 'git-history-average',
  }
}

function modeForFacts(facts) {
  if (facts.fileCount === 1 && facts.estimatedChangedLines <= 500
    && !facts.crossModule && !facts.needParallel) return 'lock'
  if (facts.fileCount <= 3 && facts.estimatedChangedLines <= 500
    && !facts.crossModule && !facts.needParallel) return 'probe'
  return 'swarm'
}

async function probeRepositoryDemand(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const contextMap = await resolveContextMapTargets(root, input.targetSymbols)
  const files = await discoverTargets(root, [...(input.targetHints ?? []), ...contextMap.targets])
  const graph = await dependencyGraph(root, files)
  const moduleRoots = [...new Set(await Promise.all(files.map((file) => nearestPackageRoot(root, file))))]
  const estimate = await historicalEstimate(root, files)
  const components = connectedComponents(graph)
  const crossModule = moduleRoots.length > 1
  const needParallel = components > 1 && files.length > 3 && estimate.lines > 500
  const risk = HIGH_RISK_PATTERN.test(`${input.goal ?? ''}\n${files.join('\n')}`) ? 'high'
    : crossModule ? 'medium' : 'low'
  const facts = {
    targetFiles: files,
    fileCount: files.length,
    estimatedChangedLines: estimate.lines,
    estimateSource: estimate.source,
    historySamples: estimate.samples,
    crossModule,
    needParallel,
    independentComponents: components,
    moduleRoots,
    risk,
    difficulty: files.length <= 1 && estimate.lines <= 50 ? 'low'
      : files.length <= 3 && estimate.lines <= 500 ? 'medium' : 'high',
  }
  return { schemaVersion: LOCAL_SCHEMA, facts, mode: modeForFacts(facts),
    contextMap: { used: contextMap.used, mapPath: contextMap.mapPath ?? null } }
}

function reassessMode(input) {
  const currentIndex = MODE_ORDER.indexOf(input.currentMode)
  if (currentIndex < 0) fail('AIMLOCK_MODE_INVALID', 'currentMode must be lock, probe, or swarm')
  const requiredMode = modeForFacts({
    fileCount: input.actualFileCount,
    estimatedChangedLines: input.actualChangedLines,
    crossModule: input.crossModule === true,
    needParallel: input.needParallel === true,
  })
  const requiredIndex = MODE_ORDER.indexOf(requiredMode)
  const nextMode = requiredIndex > currentIndex ? MODE_ORDER[currentIndex + 1] : input.currentMode
  return {
    schemaVersion: LOCAL_SCHEMA,
    mode: nextMode,
    requiredMode,
    escalated: nextMode !== input.currentMode,
    inherited: input.inherited,
    notice: nextMode !== input.currentMode
      ? `任务比预估复杂，已升级为 ${nextMode} 模式并继承现有快照与修改。` : null,
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
  const elapsedMs = now - Date.parse(state.startedAt)
  const remainingFiles = Math.max(0, state.maxFiles - state.uniqueFiles.length)
  const remainingTokenEstimate = state.maxTokenEstimate === null ? null
    : Math.max(0, state.maxTokenEstimate - state.tokenEstimate)
  const remainingDurationMs = Math.max(0, state.maxDurationMs - elapsedMs)
  const decisionRequired = remainingFiles === 0 || remainingDurationMs === 0
    || remainingTokenEstimate === 0
  return { ...state, elapsedMs, remainingFiles, remainingTokenEstimate, remainingDurationMs,
    decisionRequired, nextActions: decisionRequired ? ['execute', 'plan', 'blocked'] : [] }
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

async function readFileWithinBudget(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  await assertChainNotSuspended({ repositoryRoot: root, chainId })
  const budgetPath = managedPath(root, 'runs', chainId, 'read-budget.json')
  return withFileLock(budgetPath, async () => {
    const authority = await readBudget(root, chainId)
    const path = safeRelativePath(input.path)
    const state = authority.state
    const before = budgetView(state)
    if (before.remainingDurationMs === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read deadline exhausted')
    const isNew = !state.uniqueFiles.includes(path)
    if (isNew && before.remainingFiles === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read file budget exhausted')
    const projectFile = await resolvedProjectPath(root, path)
    if (!projectFile.status.isFile()) fail('AIMLOCK_READ_NOT_FILE', `${path} is not a file`)
    const tokenEstimate = Math.ceil(projectFile.status.size / 4)
    if (before.remainingTokenEstimate !== null && tokenEstimate > before.remainingTokenEstimate) {
      fail('AIMLOCK_DECISION_REQUIRED', 'read token estimate budget exhausted')
    }
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
    const { state } = await readBudget(root, chainId)
    const path = safeRelativePath(input.path)
    const budget = budgetView(state)
    if (budget.remainingDurationMs === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read deadline exhausted')
    if (budget.remainingTokenEstimate === 0) fail('AIMLOCK_DECISION_REQUIRED', 'read token estimate budget exhausted')
    if (!state.uniqueFiles.includes(path)) fail('AIMLOCK_CACHE_UNCHARGED', 'cached source was not read by this chain')
    return { schemaVersion: LOCAL_SCHEMA, path, budget }
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

const LOCAL_CAPABILITIES = Object.freeze({
  schemaVersion: LOCAL_SCHEMA,
  operations: Object.freeze([
    'capabilities', 'probe', 'reassess', 'budget-init', 'budget-read', 'budget-status',
    'budget-extend', 'gate-issue', 'gate-verify', 'guarded-write',
  ]),
  operationSchemas: LOCAL_OPERATION_SCHEMAS,
  writeBoundary: 'Only writes routed through guarded-write are physically intercepted. The IDE host must route batch writes through this runner.',
  coordinationBoundary: 'Active dependency waits block budgeted reads; coordinated gate passes bind signed .coord file leases.',
  tokenEstimateAlgorithm: TOKEN_ESTIMATE_ALGORITHM,
  budgets: READ_BUDGETS,
})

export {
  BUDGET_SCHEMA,
  LOCAL_CAPABILITIES,
  LOCAL_OPERATION_SCHEMAS,
  LOCAL_SCHEMA,
  PASS_SCHEMA,
  READ_BUDGETS,
  checkCachedReadAccess,
  extendReadBudget,
  guardedWriteFile,
  initializeReadBudget,
  issueMutationPass,
  probeRepositoryDemand,
  readBudgetStatus,
  readFileWithinBudget,
  reassessMode,
  verifyMutationPassFile,
}
