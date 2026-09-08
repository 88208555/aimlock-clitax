import { stdin, stdout } from 'node:process'
import { executeCoordinatorOperation } from 'cli-swarm/coordinator'
import { errorRecord } from './aimlock-chain-model.mjs'
import { fail } from './aimlock-local-fs.mjs'

const TASK_INPUT_MAX_BYTES = 1_048_576
const MAX_TASK_DELIVERY_TIMEOUT_MS = 2_147_483_647
export const TASK_DELIVERY_TIMEOUT_MS = 30_000
export const TASK_OPERATIONS = Object.freeze([
  'task-describe', 'task-checkpoint', 'task-resume', 'message-route', 'message-status',
  'message-accept', 'message-complete', 'message-delivery-start', 'message-delivery-report',
  'message-resolve', 'handoff-release', 'handoff-resume',
])
export const TASKS_USAGE = [
  '  cli-aimlock tasks <operation> <repositoryRoot> < task-message.json',
  '  cli-aimlock tasks capabilities <repositoryRoot>',
  `      Operations: ${TASK_OPERATIONS.join(', ')}.`,
  '      Message routing preserves the original plan. A resume package does not execute work.',
].join('\n')

function taskCapabilities(capabilities) {
  if (!capabilities || !Array.isArray(capabilities.operations)
    || !capabilities.operationSchemas || typeof capabilities.operationSchemas !== 'object') {
    fail('AIMLOCK_TASKS_CAPABILITIES_INVALID', 'coordinator task capabilities are invalid')
  }
  for (const operation of TASK_OPERATIONS) {
    if (!capabilities.operations.includes(operation) || !Object.hasOwn(capabilities.operationSchemas, operation)) {
      fail('AIMLOCK_TASKS_OPERATION_UNAVAILABLE', `coordinator task operation is unavailable: ${operation}`)
    }
  }
  return { operations: [...TASK_OPERATIONS], operationSchemas: Object.fromEntries(
    TASK_OPERATIONS.map((operation) => [operation, capabilities.operationSchemas[operation]]),
  ) }
}

async function readTaskInput(input) {
  const chunks = []
  let byteLength = 0
  for await (const chunk of input) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      fail('AIMLOCK_TASKS_INPUT_INVALID', 'task input must be UTF-8 JSON')
    }
    const bytes = Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > TASK_INPUT_MAX_BYTES) fail('AIMLOCK_TASKS_INPUT_TOO_LARGE', 'task input exceeds 1 MiB')
    chunks.push(bytes)
  }
  if (byteLength === 0) fail('AIMLOCK_TASKS_INPUT_REQUIRED', 'task input is required on stdin')
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { fail('AIMLOCK_TASKS_INPUT_INVALID', 'task input must be valid UTF-8 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AIMLOCK_TASKS_INPUT_INVALID', 'task input must be a JSON object')
  }
  return value
}

export async function dispatchTasks(args, dependencies = {}) {
  const [operation, repositoryRoot] = args
  if (args.length !== 2 || (operation !== 'capabilities' && !TASK_OPERATIONS.includes(operation))) {
    fail('AIMLOCK_TASKS_USAGE_INVALID', TASKS_USAGE)
  }
  const execute = dependencies.executeCoordinatorOperation ?? executeCoordinatorOperation
  const input = dependencies.input ?? stdin
  if (operation === 'capabilities') return taskCapabilities(await execute(operation, repositoryRoot, {}))
  return execute(operation, repositoryRoot, await readTaskInput(input))
}

export async function runTasksCli(args) {
  try {
    const result = await dispatchTasks(args)
    stdout.write(JSON.stringify(result) + '\n')
    if (result.status === 'blocked' || result.status === 'waiting') process.exitCode = 2
    else if (result.status === 'failed' || result.status === 'uncertain') process.exitCode = 1
  } catch (error) {
    stdout.write(JSON.stringify({ status: 'failed', error: errorRecord(error) }) + '\n')
    process.exitCode = 1
  }
}

function sourceIdentity(input) {
  const identity = {}
  for (const field of ['taskId', 'agentId', 'chainId']) {
    if (typeof input?.[field] !== 'string' || !input[field].trim()) {
      fail('AIMLOCK_TASKS_IDENTITY_REQUIRED', `task identity requires ${field}`)
    }
    identity[field] = input[field]
  }
  return identity
}

function receiptMatches(receipt, delivery) {
  return receipt && typeof receipt === 'object'
    && receipt.requestId === delivery.requestId && receipt.targetTaskId === delivery.targetTaskId
    && typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0
}

async function deliveryStatus(execute, root, source, delivery) {
  const status = await execute('message-status', root, { ...source, requestId: delivery.requestId })
  if (!status || !Object.hasOwn(status, 'receipt')) {
    fail('AIMLOCK_TASKS_RECEIPT_INVALID', 'coordinator message status has no receipt field')
  }
  if (status.receipt !== null && !receiptMatches(status.receipt, delivery)) {
    fail('AIMLOCK_TASKS_RECEIPT_INVALID', 'coordinator receipt does not match the target delivery')
  }
  return status.receipt
}

async function awaitHostDelivery(adapter, delivery, timeoutMs) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(
      `host delivery timed out after ${timeoutMs} ms; the actual delivery was not canceled`,
    ), { code: 'AIMLOCK_TASKS_DELIVERY_TIMEOUT' })), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => adapter.deliver(delivery)), deadline])
  } finally { clearTimeout(timer) }
}

async function deliverTaskMessage(root, source, delivery, adapter, execute, timeoutMs) {
  const recorded = await deliveryStatus(execute, root, source, delivery)
  if (recorded) return { requestId: delivery.requestId, status: 'accepted', receipt: recorded, recovered: true }
  const claim = await execute('message-delivery-start', root, { ...source, requestId: delivery.requestId })
  if (!claim || typeof claim.claimed !== 'boolean'
    || (claim.claimed && (typeof claim.attemptId !== 'string' || !claim.attemptId))) {
    fail('AIMLOCK_TASKS_DELIVERY_CLAIM_INVALID', 'coordinator delivery claim is invalid')
  }
  if (!claim.claimed) {
    const receipt = await deliveryStatus(execute, root, source, delivery)
    if (receipt) return { requestId: delivery.requestId, status: 'accepted', receipt, recovered: true }
    fail('AIMLOCK_TASKS_DELIVERY_UNCERTAIN', 'delivery was already attempted; query its receipt before any further action')
  }
  let delivered
  let deliveryError
  try { delivered = await awaitHostDelivery(adapter, { ...delivery, attemptId: claim.attemptId }, timeoutMs) }
  catch (error) { deliveryError = errorRecord(error) }
  const receipt = await deliveryStatus(execute, root, source, delivery)
  if (!receipt) {
    const detail = deliveryError ? `: ${deliveryError.message}` : ''
    fail('AIMLOCK_TASKS_DELIVERY_UNCERTAIN', `target acceptance has not been recorded${detail}`)
  }
  if (!deliveryError && (!receiptMatches(delivered, delivery) || delivered.status !== 'accepted'
    || delivered.receiptId !== receipt.receiptId)) {
    fail('AIMLOCK_TASKS_RECEIPT_INVALID', 'adapter receipt does not match the recorded target acceptance')
  }
  return { requestId: delivery.requestId, status: 'accepted', receipt, recovered: Boolean(deliveryError),
    ...(deliveryError ? { deliveryError } : {}) }
}

async function reportDeliveryFailure(root, source, delivery, error, execute, failures) {
  const failure = errorRecord(error)
  failures.push({ requestId: delivery.requestId, stage: 'delivery', error: failure })
  try {
    await execute('message-delivery-report', root, { ...source, requestId: delivery.requestId,
      errorCode: typeof failure.code === 'string' ? failure.code : 'AIMLOCK_TASKS_DELIVERY_FAILED',
      errorMessage: failure.message })
  } catch (reportError) {
    failures.push({ requestId: delivery.requestId, stage: 'delivery-report', error: errorRecord(reportError) })
  }
}

/** A host adapter delivers messages; only the coordinator may issue durable acceptance receipts. */
export async function handleTaskMessage(root, input, adapter, { deliveryTimeoutMs = TASK_DELIVERY_TIMEOUT_MS } = {}) {
  if (!adapter || typeof adapter.deliver !== 'function' || typeof adapter.continueTask !== 'function') {
    fail('AIMLOCK_TASKS_ADAPTER_REQUIRED', 'host adapter requires deliver and continueTask functions')
  }
  if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs <= 0
    || deliveryTimeoutMs > MAX_TASK_DELIVERY_TIMEOUT_MS) {
    fail('AIMLOCK_TASKS_TIMEOUT_INVALID', 'deliveryTimeoutMs must be a positive integer within the timer limit')
  }
  const source = sourceIdentity(input)
  const execute = executeCoordinatorOperation
  const routed = await execute('message-route', root, input)
  if (!routed || !Array.isArray(routed.deliveries)
    || Object.keys(source).some((field) => routed.source?.[field] !== source[field])) {
    fail('AIMLOCK_TASKS_ROUTE_INVALID', 'coordinator message route does not match the source task')
  }
  const deliveries = []
  const failures = []
  for (const delivery of routed.deliveries) {
    if (delivery.status !== 'pending-delivery') continue
    try { deliveries.push(await deliverTaskMessage(root, source, delivery, adapter, execute, deliveryTimeoutMs)) }
    catch (error) { await reportDeliveryFailure(root, source, delivery, error, execute, failures) }
  }
  let continuation = null
  let continuationDispatched = false
  try {
    continuation = await execute('task-resume', root, source)
    if (!continuation || typeof continuation.canContinue !== 'boolean'
      || Object.keys(source).some((field) => continuation[field] !== source[field])) {
      fail('AIMLOCK_TASKS_RESUME_INVALID', 'coordinator resume package does not match the original task')
    }
    if (continuation.canContinue) {
      await adapter.continueTask(continuation)
      continuationDispatched = true
    }
  } catch (error) { failures.push({ requestId: null, stage: 'continuation', error: errorRecord(error) }) }
  return { status: failures.length ? 'failed' : continuationDispatched ? 'continued' : 'waiting',
    messageId: routed.messageId, requests: routed.requests, deliveries, continuation,
    continuationDispatched, failures }
}
