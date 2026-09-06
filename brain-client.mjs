import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { inspectBrainTarget, brainStateDirectory, saveBrainRequest } from './brain-client-files.mjs'
export { inspectBrainTarget } from './brain-client-files.mjs'
import { resolve } from 'node:path'
import { brainClientAuthorization, transportFailureCode } from './broker.mjs'
import { executeCommand } from './aimlock-chain-process.mjs'

export const BRAIN_ENDPOINT = 'https://cli.tax/api/v1/brain'
const REQUEST_SCHEMA = 'brain.planning-request/1.0'
const RESPONSE_SCHEMA = 'brain.planning-response/1.0'
const PLAN_SCHEMA = 'brain.execution-plan/1.0'
const MAX_INPUT_BYTES = 256_000
const TIMEOUT_MS = 120_000
const HASH_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPERATIONS = new Set(['plan', 'status', 'report', 'validate'])

export function canonicalBrainJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalBrainJson).join(',') + ']'
  if (!value || typeof value !== 'object') throw new Error('Brain protocol value must be JSON')
  return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalBrainJson(item)).join(',') + '}'
}

export function brainClientDigest(value) {
  return createHash('sha256').update(canonicalBrainJson(value)).digest('hex')
}

function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(label + ' has invalid fields')
}

export async function invokeBrain(operation, input, dependencies = {}) {
  if (!OPERATIONS.has(operation)) throw new Error('Unknown Brain operation')
  const endpoint = dependencies.endpoint ?? BRAIN_ENDPOINT
  const context = { endpoint, displayName: 'Brain planning' }
  const environment = dependencies.environment ?? process.env
  const authorization = await brainClientAuthorization(context, environment, dependencies.credentialAccess)
  const body = JSON.stringify({ operation, input })
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error('Brain request exceeds the size limit')
  let response
  try {
    response = await (dependencies.request ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error('Brain transport failed (' + transportFailureCode(error) + '); query status before submitting another plan')
  }
  const payload = await readBrainResponse(response)
  if (!response.ok) {
    const code = typeof payload?.code === 'string' ? payload.code : 'BRAIN_HTTP_ERROR'
    throw new Error('Brain request failed: HTTP ' + response.status + ' (' + code + ')')
  }
  if (payload?.schemaVersion !== RESPONSE_SCHEMA || !UUID_PATTERN.test(payload.planId)
    || !UUID_PATTERN.test(payload.requestId)
    || !['planning', 'ready', 'reported', 'verified', 'failed', 'expired'].includes(payload.status)) {
    throw new Error('Brain response envelope is invalid')
  }
  if ((operation === 'plan' && payload.requestId !== input.requestId)
    || (operation !== 'plan' && (input.planId ? payload.planId !== input.planId : payload.requestId !== input.requestId))) throw new Error('Brain response identity does not match')
  if (payload.plan !== null && (payload.plan?.schemaVersion !== PLAN_SCHEMA
    || payload.plan.planId !== payload.planId || !HASH_PATTERN.test(payload.planDigest)
    || brainClientDigest(payload.plan) !== payload.planDigest)) throw new Error('Brain response plan digest is invalid')
  return payload
}

export async function prepareBrainRequest(root, specification) {
  exact(specification, ['requestId', 'goal', 'maxChangedLines', 'targets', 'checks'], 'Brain specification')
  if (!UUID_PATTERN.test(specification.requestId) || typeof specification.goal !== 'string' || !specification.goal.trim()
    || !Number.isSafeInteger(specification.maxChangedLines) || specification.maxChangedLines < 1
    || !Array.isArray(specification.targets) || !specification.targets.length || specification.targets.length > 64
    || new Set(specification.targets).size !== specification.targets.length) throw new Error('Brain specification is invalid')
  const targets = []
  for (const path of specification.targets) targets.push(await inspectBrainTarget(root, path))
  return { schemaVersion: REQUEST_SCHEMA, ...specification, targets }
}

export function validateBrainHandoff(request, response) {
  const plan = response.plan
  if (response.status !== 'ready' || plan?.schemaVersion !== PLAN_SCHEMA || response.requestId !== request.requestId
    || response.planId !== plan.planId || brainClientDigest(plan) !== response.planDigest) throw new Error('Brain plan is not ready')
  const targets = request.targets.map(({ path, sha256 }) => ({ path, sha256 }))
  if (brainClientDigest(plan.targets) !== brainClientDigest(targets)
    || brainClientDigest(plan.checks) !== brainClientDigest(request.checks)
    || brainClientDigest(plan.contract.allowedPaths) !== brainClientDigest(targets.map((target) => target.path))
    || plan.contract.maxChangedLines !== request.maxChangedLines || plan.contract.allowDeleteFiles !== false) {
    throw new Error('Brain plan changed the local authorization')
  }
  if (!Array.isArray(plan.nodes) || !plan.nodes.length
    || plan.nodes.some((node) => !targets.some((target) => target.path === node.path))) throw new Error('Brain plan targets are invalid')
  return plan
}

export async function collectBrainReport(root, handoff, environment = process.env) {
  exact(handoff, ['request', 'response'], 'Brain handoff')
  const plan = validateBrainHandoff(handoff.request, handoff.response)
  if (typeof environment.PATH !== 'string' || !environment.PATH) throw new Error('Execution PATH is required')
  const reportId = randomUUID()
  const directory = await brainStateDirectory(root, ['brain-reports', reportId])
  const evidence = []
  for (const check of plan.checks) {
    exact(check, ['id', 'executable', 'args', 'timeoutMs'], 'Brain check')
    if (typeof check.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(check.id)
      || typeof check.executable !== 'string' || !check.executable
      || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string')
      || !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1_000 || check.timeoutMs > 3_600_000) {
      throw new Error('Brain check command is invalid')
    }
    const result = await executeCommand(root, {
      executable: check.executable, args: check.args, timeoutMs: check.timeoutMs,
      environment: { PATH: environment.PATH }, workingDirectory: '.', evidenceKind: 'test',
    }, reportId + ':' + check.id, async () => {})
    const digest = (value) => createHash('sha256').update(value).digest('hex')
    evidence.push({ checkId: check.id, exitCode: result.status !== 'succeeded' && result.exitCode === 0 ? null : result.exitCode, durationMs: result.durationMs,
      stdoutSha256: digest(result.stdout), stderrSha256: digest(result.stderr) })
    await writeFile(resolve(directory, check.id + '.json'), JSON.stringify(result), { mode: 0o600 })
    if (result.status === 'uncertain') throw new Error('Check process cleanup is unconfirmed; execution stopped')
  }
  const files = []
  for (const node of plan.nodes) {
    const actual = await inspectBrainTarget(root, node.path)
    if (actual.sha256 === null) throw new Error('Planned file is missing: ' + node.path)
    files.push({ path: node.path, sha256: actual.sha256 })
  }
  return { planId: plan.planId, planDigest: handoff.response.planDigest, reportId, files, evidence }
}

export async function runBrainCli(args) {
  const [operation, root, file] = args
  if (!['plan', 'check', 'status', 'validate'].includes(operation) || !root || !file || args.length !== 3) {
    throw new Error('Usage: cli-aimlock brain <plan|check|status|validate> <repositoryRoot> <jsonFile>')
  }
  const source = await readFile(resolve(file), 'utf8')
  if (Buffer.byteLength(source) > MAX_INPUT_BYTES) throw new Error('Brain input file exceeds the size limit')
  const input = JSON.parse(source)
  if (operation === 'plan') {
    const request = await prepareBrainRequest(root, input)
    await saveBrainRequest(root, request, brainClientDigest)
    const response = await invokeBrain('plan', request)
    if (response.status === 'ready') validateBrainHandoff(request, response)
    process.stdout.write(JSON.stringify({ request, response }) + '\n')
    return
  }
  const payload = operation === 'check' ? await collectBrainReport(root, input) : input
  const response = await invokeBrain(operation === 'check' ? 'report' : operation, payload)
  process.stdout.write(JSON.stringify(response) + '\n')
}

async function readBrainResponse(response) {
  if (!response.body) throw new Error('Brain response body is missing')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_INPUT_BYTES) { await reader.cancel(); throw new Error('Brain response exceeds the size limit') }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
