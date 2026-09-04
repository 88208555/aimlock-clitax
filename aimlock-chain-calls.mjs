import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { executeCoordinatorOperation } from 'cli-swarm/coordinator'
import { loadOfficialSkillContext } from './installer.mjs'
import { invokeOfficialSkill } from './broker.mjs'
import { fail, sha256 } from './aimlock-local-fs.mjs'
import { errorRecord } from './aimlock-chain-model.mjs'
import { saveExecution } from './aimlock-chain-store.mjs'
import { executeCommand } from './aimlock-chain-process.mjs'

export function resolveContexts(root, plan) {
  return plan.skills.map((skill) => {
    const context = loadOfficialSkillContext(resolve(root, skill.packageRoot))
    if (context.skillName !== skill.skillId) fail('AIMLOCK_CHAIN_SKILL_INVALID', 'installed skill does not match plan skillId')
    return { skillId: skill.skillId, context }
  })
}

export function verifyContexts(root, state) {
  if (JSON.stringify(resolveContexts(root, state.plan)) !== JSON.stringify(state.contexts)) {
    fail('AIMLOCK_CHAIN_SKILL_CHANGED', 'installed package metadata changed after execution initialization')
  }
}

function skillContext(state, skillId) {
  const found = state.contexts.find((entry) => entry.skillId === skillId)
  if (!found) fail('AIMLOCK_CHAIN_SKILL_MISSING', 'execution needs an explicitly declared ' + skillId + ' package')
  return found.context
}

async function startCall(session, kind, operation, input) {
  const call = { callId: 'call-' + randomUUID(), kind, operation, inputDigest: sha256(JSON.stringify(input)),
    requestId: null, status: 'started', pid: null, receipt: null, error: null,
    startedAt: new Date().toISOString(), completedAt: null }
  session.record.calls.push(call)
  await saveExecution(session.file, session.state)
  return call
}

async function failCall(session, call, error) {
  call.status = call.requestId || call.pid !== null ? 'uncertain' : 'failed'
  call.error = errorRecord(error)
  call.completedAt = new Date().toISOString()
  await saveExecution(session.file, session.state)
}

export async function callSkill(session, skillId, operation, input) {
  const context = skillContext(session.state, skillId)
  const call = await startCall(session, 'skill', operation, input)
  try {
    const dependencies = session.dependencies
    const invocation = await invokeOfficialSkill(context, operation, input, {
      environment: dependencies.environment, credentialAccess: dependencies.credentialAccess,
      request: async (url, options) => {
        const request = JSON.parse(options.body).input
        call.requestId = request.requestId
        call.status = 'dispatched'
        await saveExecution(session.file, session.state)
        return dependencies.request(url, options)
      },
    })
    call.receipt = invocation
    call.status = 'recorded'
    call.completedAt = new Date().toISOString()
    await saveExecution(session.file, session.state)
    return invocation.response.output
  } catch (error) {
    await failCall(session, call, error)
    throw error
  }
}

export async function callCoordinator(session, operation, input) {
  const call = await startCall(session, 'coordinator', operation, input)
  try {
    const output = await executeCoordinatorOperation(operation, session.root, input)
    call.status = 'recorded'
    call.receipt = output
    call.completedAt = new Date().toISOString()
    await saveExecution(session.file, session.state)
    return output
  } catch (error) {
    await failCall(session, call, error)
    throw error
  }
}

export async function callCommand(session, input) {
  const call = await startCall(session, 'command', 'exec', input)
  try {
    const output = await executeCommand(session.root, input, call.callId, async (pid) => {
      call.pid = pid
      call.status = 'dispatched'
      await saveExecution(session.file, session.state)
    })
    call.status = output.status === 'uncertain' ? 'uncertain' : 'recorded'
    call.receipt = output
    call.completedAt = new Date().toISOString()
    await saveExecution(session.file, session.state)
    return output
  } catch (error) {
    await failCall(session, call, error)
    throw error
  }
}
