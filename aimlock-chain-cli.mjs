import { stdin, stdout } from 'node:process'
import { answerExecution, executionStatus, initializeExecution, resumeExecution } from './aimlock-chain-executor.mjs'
import { errorRecord } from './aimlock-chain-model.mjs'
import { fail } from './aimlock-local-fs.mjs'

const PLAN_MAX_BYTES = 1_048_576
export const CHAIN_USAGE = [
  '  cli-aimlock chain init <repositoryRoot> < execution-plan.json',
  '  cli-aimlock chain resume <repositoryRoot> <chainId>',
  '  cli-aimlock chain status <repositoryRoot> <chainId>',
  '  cli-aimlock chain answer <repositoryRoot> <chainId> <actorId>',
  '      Persist explicit steps; resume invokes real broker/coordinator/process operations.',
  '      answer requires a live terminal. Recorded results and nextStep never imply execution.',
].join('\n')

async function readPlan(input) {
  let source = ''
  for await (const chunk of input) {
    source += chunk
    if (Buffer.byteLength(source) > PLAN_MAX_BYTES) fail('AIMLOCK_CHAIN_INPUT_TOO_LARGE', 'execution plan exceeds 1 MiB')
  }
  if (!source.trim()) fail('AIMLOCK_CHAIN_INPUT_REQUIRED', 'execution plan is required on stdin')
  return JSON.parse(source)
}

export async function dispatchChain(args) {
  const [operation, repositoryRoot, chainId, actorId] = args
  const expected = { init: 2, status: 3, resume: 3, answer: 4 }
  if (!Object.hasOwn(expected, operation) || args.length !== expected[operation]) {
    fail('AIMLOCK_CHAIN_USAGE_INVALID', CHAIN_USAGE)
  }
  const dependencies = { environment: process.env, request: fetch }
  if (operation === 'init') return initializeExecution(repositoryRoot, await readPlan(stdin))
  if (operation === 'status') return executionStatus(repositoryRoot, chainId)
  if (operation === 'resume') return resumeExecution(repositoryRoot, chainId, dependencies)
  return answerExecution(repositoryRoot, chainId, { input: stdin, output: stdout, actorId }, dependencies)
}

export async function runChainCli(args) {
  try {
    const state = await dispatchChain(args)
    stdout.write(JSON.stringify(state) + '\n')
    if (state.status === 'blocked') process.exitCode = 2
    else if (state.status === 'failed' || state.status === 'uncertain') process.exitCode = 1
  } catch (error) {
    stdout.write(JSON.stringify({ status: 'failed', error: errorRecord(error) }) + '\n')
    process.exitCode = 1
  }
}
