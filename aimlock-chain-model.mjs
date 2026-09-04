import { fail, identifier, sha256 } from './aimlock-local-fs.mjs'

export const PLAN_SCHEMA = 'aimlock.execution-plan/1.0'
export const STATE_SCHEMA = 'aimlock.execution-state/1.0'
export const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'uncertain'])
const STEP_KINDS = new Set(['skill', 'coordinator', 'command'])
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const EVIDENCE_KINDS = new Set(['test', 'build', 'lint', 'security', 'benchmark'])
const MAX_STEPS = 256
const MAX_TIMEOUT_MS = 3_600_000
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_ENVIRONMENT = /(?:TOKEN|SECRET|PRIVATE.?KEY|SIGNING|BROKER|CREDENTIAL|AUTHORIZATION|PASSWORD)|^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|NODE_OPTIONS|LD_PRELOAD|DYLD_.*)$/i

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('AIMLOCK_CHAIN_INPUT_INVALID', label + ' must be an object')
  return value
}

function exact(value, keys, label) {
  object(value, label)
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('AIMLOCK_CHAIN_INPUT_INVALID', label + ' contains missing or unknown fields')
  }
}

export function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('AIMLOCK_CHAIN_INPUT_INVALID', label + ' must be a non-empty string')
  return value
}

function pointerParts(pointer) {
  if (pointer === '') return []
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) {
    fail('AIMLOCK_CHAIN_POINTER_INVALID', 'JSON Pointer must use RFC 6901 escaping')
  }
  const parts = pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (parts.some((part) => FORBIDDEN_KEYS.has(part))) fail('AIMLOCK_CHAIN_POINTER_INVALID', 'unsafe property in JSON Pointer')
  return parts
}

export function readPointer(value, pointer) {
  let cursor = value
  for (const part of pointerParts(pointer)) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
      fail('AIMLOCK_CHAIN_BINDING_MISSING', 'JSON Pointer has no recorded value: ' + pointer)
    }
    cursor = cursor[part]
  }
  return structuredClone(cursor)
}

function writePointer(value, pointer, replacement) {
  const parts = pointerParts(pointer)
  if (!parts.length) return object(structuredClone(replacement), 'bound input')
  let cursor = value
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
      fail('AIMLOCK_CHAIN_BINDING_MISSING', 'binding target parent does not exist: ' + pointer)
    }
    cursor = cursor[part]
  }
  const last = parts.at(-1)
  if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, last)) {
    fail('AIMLOCK_CHAIN_BINDING_MISSING', 'binding target must be declared in input: ' + pointer)
  }
  cursor[last] = structuredClone(replacement)
  return value
}

function validateCommand(input) {
  exact(input, ['executable', 'args', 'workingDirectory', 'timeoutMs', 'evidenceKind', 'environment'], 'command input')
  nonempty(input.executable, 'executable')
  nonempty(input.workingDirectory, 'workingDirectory')
  object(input.environment, 'command environment')
  for (const [key, value] of Object.entries(input.environment)) {
    if (!ENVIRONMENT_KEY.test(key) || RESERVED_ENVIRONMENT.test(key) || typeof value !== 'string' || value.includes('\u0000')) {
      fail('AIMLOCK_CHAIN_ENVIRONMENT_INVALID', 'command environment contains an invalid or reserved credential variable')
    }
  }
  if (!input.executable.includes('/') && !input.executable.includes('\\')) {
    nonempty(input.environment.PATH, 'environment.PATH for executable lookup')
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string')) {
    fail('AIMLOCK_CHAIN_INPUT_INVALID', 'command args must be strings')
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS
    || !EVIDENCE_KINDS.has(input.evidenceKind)) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'command limits or evidence kind are invalid')
}

function validateStep(step, seen, skills) {
  const keys = ['stepId', 'kind', 'skillId', 'operation', 'input', 'dependsOn', 'bindings']
  exact(step, Object.hasOwn(step, 'continueWhen') ? [...keys, 'continueWhen'] : keys, 'step')
  if (Object.hasOwn(step, 'continueWhen')) {
    exact(step.continueWhen, ['answer'], 'continueWhen')
    const answer = step.continueWhen.answer
    if ((typeof answer !== 'string' || !answer.trim())
      && (!Array.isArray(answer) || !answer.length || answer.some((item) => typeof item !== 'string' || !item.trim()))) {
      fail('AIMLOCK_CHAIN_INPUT_INVALID', 'continueWhen.answer must be a non-empty structured answer')
    }
    if (step.kind !== 'skill' || step.skillId !== 'confirm-protocol' || step.operation !== 'interaction-request') {
      fail('AIMLOCK_CHAIN_INPUT_INVALID', 'continueWhen applies only to an explicit Confirm interaction-request step')
    }
  }
  identifier(step.stepId, 'stepId')
  if (seen.has(step.stepId) || !STEP_KINDS.has(step.kind)) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'duplicate stepId or invalid kind')
  object(step.input, 'step input')
  if (!Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length
    || step.dependsOn.some((id) => !seen.has(id))) {
    fail('AIMLOCK_CHAIN_DEPENDENCY_INVALID', 'steps must be topologically ordered with existing unique dependencies')
  }
  if (!Array.isArray(step.bindings)) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'bindings must be an array')
  for (const binding of step.bindings) {
    exact(binding, ['stepId', 'source', 'target'], 'binding')
    if (!step.dependsOn.includes(binding.stepId)) fail('AIMLOCK_CHAIN_DEPENDENCY_INVALID', 'binding source must be a dependency')
    pointerParts(binding.source)
    pointerParts(binding.target)
  }
  if (new Set(step.bindings.map((binding) => binding.target)).size !== step.bindings.length) {
    fail('AIMLOCK_CHAIN_INPUT_INVALID', 'binding targets must be unique')
  }
  if (step.kind === 'skill') {
    if (!skills.has(step.skillId)) fail('AIMLOCK_CHAIN_SKILL_MISSING', 'step skill must be declared')
    nonempty(step.operation, 'operation')
    if (step.skillId === 'confirm-protocol' && step.operation === 'interaction-answer') {
      fail('AIMLOCK_CHAIN_HUMAN_REQUIRED', 'interaction-answer is supplied only by the interactive answer command')
    }
  } else if (step.skillId !== null) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'non-skill steps require skillId=null')
  if (step.kind === 'coordinator') {
    nonempty(step.operation, 'operation')
    if (step.operation === 'resolve-human') fail('AIMLOCK_CHAIN_HUMAN_REQUIRED', 'resolve-human cannot be supplied in the plan')
  }
  if (step.kind === 'command') {
    if (step.operation !== 'exec' || step.bindings.length) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'commands use exec and cannot bind executable input')
    validateCommand(step.input)
  }
}

export function validatePlan(plan) {
  exact(plan, ['schemaVersion', 'chainId', 'skills', 'steps'], 'plan')
  if (plan.schemaVersion !== PLAN_SCHEMA) fail('AIMLOCK_CHAIN_SCHEMA_INVALID', 'unsupported execution plan')
  identifier(plan.chainId, 'chainId')
  if (!Array.isArray(plan.skills) || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > MAX_STEPS) {
    fail('AIMLOCK_CHAIN_INPUT_INVALID', 'skills must be an array and steps must contain 1..256 entries')
  }
  const skills = new Set()
  for (const skill of plan.skills) {
    exact(skill, ['skillId', 'packageRoot'], 'skill')
    identifier(skill.skillId, 'skillId')
    nonempty(skill.packageRoot, 'packageRoot')
    if (skills.has(skill.skillId)) fail('AIMLOCK_CHAIN_INPUT_INVALID', 'duplicate skillId')
    skills.add(skill.skillId)
  }
  const seen = new Set()
  for (const step of plan.steps) { validateStep(step, seen, skills); seen.add(step.stepId) }
  return structuredClone(plan)
}

export function planDigest(plan) { return sha256(JSON.stringify(plan)) }

export function bindInput(step, state) {
  let input = structuredClone(step.input)
  for (const binding of step.bindings) {
    const recorded = state.steps.find((item) => item.stepId === binding.stepId)
    if (!recorded || recorded.status !== 'succeeded') fail('AIMLOCK_CHAIN_DEPENDENCY_INVALID', 'binding source has not succeeded')
    input = writePointer(input, binding.target, readPointer(recorded.output, binding.source))
  }
  return input
}

export function chainStatus(state) {
  if (state.steps.every((step) => step.status === 'succeeded')) return 'succeeded'
  if (state.steps.some((step) => step.status === 'uncertain')) return 'uncertain'
  if (state.steps.some((step) => step.status === 'failed')) return 'failed'
  if (state.steps.some((step) => step.status === 'running')) return 'running'
  if (state.steps.some((step) => ['blocked', 'waiting'].includes(step.status))) return 'blocked'
  return 'ready'
}

export function errorRecord(error) {
  if (!(error instanceof Error)) return { name: 'ThrownValue', message: String(error) }
  const value = { name: error.name, message: error.message }
  for (const key of ['code', 'transportCode', 'operation', 'retryable']) {
    if (Object.hasOwn(error, key)) value[key] = error[key]
  }
  if (error.cause instanceof Error) value.cause = errorRecord(error.cause)
  return value
}
