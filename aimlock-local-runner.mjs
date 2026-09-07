import { execFile as execFileCallback } from 'node:child_process'
import {
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  LOCAL_SCHEMA,
  appendAudit,
  fail,
  repositoryRoot,
  resolvedProjectPath,
} from './aimlock-local-fs.mjs'
import {
  PASS_SCHEMA,
  guardedWriteFile,
  issueMutationPass,
  verifyMutationPassFile,
} from './aimlock-local-gate.mjs'
import { resolveContextMapTargets } from './aimlock-context-map.mjs'
import { BUDGET_SCHEMA, TOKEN_ESTIMATE_ALGORITHM, READ_BUDGETS, initializeReadBudget } from './aimlock-read-budget-state.mjs'
import { checkCachedReadAccess, extendReadBudget, readBudgetStatus, readFileWithinBudget } from './aimlock-read-budget.mjs'
import { authorizeReadBudgetRenewal, requestReadBudgetRenewal, stopReadBudgetRenewal } from './aimlock-read-budget-renewal.mjs'
import { AUTO_RENEW_OPERATION_SCHEMAS } from './aimlock-read-budget-schemas.mjs'

const execFile = promisify(execFileCallback)
const MAX_DISCOVERED_FILES = 1_000
const MAX_SOURCE_BYTES = 1_048_576
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.aimlock', '.git', '.runtime', 'coverage', 'dist', 'node_modules',
])
const MODE_ORDER = Object.freeze(['lock', 'probe', 'swarm'])
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
  ...AUTO_RENEW_OPERATION_SCHEMAS,
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

const LOCAL_CAPABILITIES = Object.freeze({
  schemaVersion: LOCAL_SCHEMA,
  operations: Object.freeze([
    'capabilities', 'probe', 'reassess', 'budget-init', 'budget-read', 'budget-status',
    'budget-extend', 'budget-auto-renew-request', 'budget-auto-renew', 'budget-auto-renew-stop', 'gate-issue', 'gate-verify', 'guarded-write',
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
  authorizeReadBudgetRenewal,
  requestReadBudgetRenewal,
  stopReadBudgetRenewal,
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
