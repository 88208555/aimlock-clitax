import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { fail, identifier } from './aimlock-local-fs.mjs'
import { callCoordinator, callSkill } from './aimlock-chain-calls.mjs'
import { saveExecution } from './aimlock-chain-store.mjs'
import { answerMatchesContinuation } from './aimlock-chain-outcomes.mjs'

const ANSWER_PROMPT = '答案 / Answer / Ответ > '

export async function prepareHuman(session, interaction, waitInput) {
  const output = await callSkill(session, 'confirm-protocol', 'interaction-request', { interaction })
  if (output.status !== 'succeeded' || JSON.stringify(output.interaction) !== JSON.stringify(interaction)) {
    fail('AIMLOCK_CHAIN_CONFIRM_REJECTED', 'Confirm Protocol did not accept the bound interaction')
  }
  session.record.status = 'waiting'
  session.record.pending = { kind: 'human', interaction: output.interaction, waitInput,
    presentation: output.chatFallback, response: output }
  await saveExecution(session.file, session.state)
}

function normalizeSelection(interaction, source) {
  const text = source.trim()
  if (!text) fail('AIMLOCK_CHAIN_ANSWER_REQUIRED', 'an explicit answer is required')
  if (interaction.type === 'input') return text
  const selected = interaction.type === 'multi' ? text.split(',').map((part) => part.trim()) : [text]
  const ids = interaction.options.map((option) => option.id)
  if (new Set(selected).size !== selected.length || selected.some((item) => !ids.includes(item))) {
    fail('AIMLOCK_CHAIN_ANSWER_INVALID', 'answer must use the displayed option IDs')
  }
  return interaction.type === 'multi' ? selected : selected[0]
}

async function readHumanAnswer(pending, input, output) {
  if (input.isTTY !== true || output.isTTY !== true) {
    fail('AIMLOCK_CHAIN_TTY_REQUIRED', 'the answer command requires an interactive terminal; redirected answers are not accepted')
  }
  output.write(pending.interaction.question + '\n')
  if (pending.interaction.riskDescription) output.write(pending.interaction.riskDescription + '\n')
  for (const option of pending.interaction.options) output.write(option.id + ': ' + option.label + '\n')
  const terminal = createInterface({ input, output })
  try {
    return normalizeSelection(pending.interaction, await terminal.question(ANSWER_PROMPT))
  } finally { terminal.close() }
}

function verifyAnswer(output, pending, submitted) {
  const audit = output.auditEntry
  const callback = output.callbackRequest
  if (output.status !== 'succeeded' || !audit || !callback
    || audit.requestId !== pending.interaction.requestId || audit.actorId !== submitted.actorId
    || JSON.stringify(audit.answer) !== JSON.stringify(submitted.answer) || audit.remembered !== false
    || audit.question !== pending.interaction.question
    || audit.risk !== pending.interaction.risk || audit.answeredAt !== submitted.answeredAt
    || audit.auditId !== submitted.auditId || callback.operation !== pending.interaction.callback.operation
    || callback.payload.requestId !== pending.interaction.requestId
    || JSON.stringify(callback.payload.answer) !== JSON.stringify(submitted.answer)) {
    fail('AIMLOCK_CHAIN_CONFIRM_BINDING_INVALID', 'confirmed response is not bound to the displayed question and actual answer')
  }
  for (const [key, value] of Object.entries(pending.interaction.callback.payload)) {
    if (JSON.stringify(callback.payload[key]) !== JSON.stringify(value)) {
      fail('AIMLOCK_CHAIN_CONFIRM_BINDING_INVALID', 'callback payload changed')
    }
  }
}

export async function answerPending(session, terminal) {
  const pending = session.record.pending
  if (session.record.status !== 'waiting' || pending?.kind !== 'human') {
    fail('AIMLOCK_CHAIN_NOT_WAITING_FOR_HUMAN', 'this step has no pending human question')
  }
  const actorId = identifier(terminal.actorId, 'actorId')
  const answer = await readHumanAnswer(pending, terminal.input, terminal.output)
  const submitted = { interaction: pending.interaction, answer, actorId, remembered: false,
    answeredAt: new Date().toISOString(), auditId: 'audit-' + randomUUID() }
  session.record.status = 'running'
  await saveExecution(session.file, session.state)
  const output = await callSkill(session, 'confirm-protocol', 'interaction-answer', submitted)
  verifyAnswer(output, pending, submitted)
  if (pending.waitInput !== null) {
    const decisionId = pending.interaction.callback.payload.decisionId
    if (pending.interaction.callback.operation !== 'resolve-human' || decisionId !== pending.interaction.requestId) {
      fail('AIMLOCK_CHAIN_CONFIRM_BINDING_INVALID', 'coordinator decision callback does not match')
    }
    const resolution = await callCoordinator(session, 'resolve-human', { decisionId, answer, actorId })
    session.record.output = { ...session.record.output, humanResolution: resolution, confirmation: output }
    session.record.pending = { kind: 'coordinator-wait', input: pending.waitInput,
      decision: resolution.decision, confirmation: output }
    session.record.status = 'waiting'
  } else {
    session.record.output = { interaction: pending.interaction, ...output }
    session.record.pending = null
    const authorized = answerMatchesContinuation(pending.continueWhen, output.auditEntry.answer)
    session.record.status = authorized ? 'succeeded' : 'blocked'
    session.record.error = authorized ? null : { code: 'AIMLOCK_CHAIN_CONTINUATION_NOT_AUTHORIZED',
      message: 'The actual answer did not satisfy an explicit continuation condition' }
    session.record.completedAt = new Date().toISOString()
  }
  await saveExecution(session.file, session.state)
}
