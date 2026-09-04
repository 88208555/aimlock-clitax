import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fail, resolvedProjectPath, sha256 } from './aimlock-local-fs.mjs'
import { errorRecord } from './aimlock-chain-model.mjs'

const OUTPUT_LIMIT_BYTES = 1_048_576
const CLOSE_DEADLINE_MS = 1_000

function terminate(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') child.kill('SIGKILL')
  else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

function commandCompletion(child, input, startedAt) {
  let stdout = '', stderr = '', outputBytes = 0, failure = null, terminationError = null
  let settled = false, reapTimer = null, timeout = null, resolveCompletion
  const completed = new Promise((accept) => { resolveCompletion = accept })
  const finish = (exitCode, signal, unreaped) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    clearTimeout(reapTimer)
    resolveCompletion({ stdout, stderr, exitCode, signal, error: failure, terminationError,
      unreaped, durationMs: Date.now() - startedAt })
  }
  const requestTermination = () => {
    try { terminate(child) } catch (error) { terminationError = errorRecord(error) }
  }
  const stop = (error) => {
    if (settled) return
    if (failure === null) failure = error
    if (reapTimer === null) {
      reapTimer = setTimeout(() => {
        requestTermination()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        failure = { code: 'AIMLOCK_CHAIN_COMMAND_UNREAPED',
          message: 'Command cleanup could not be confirmed within the bounded close deadline',
          cause: failure }
        finish(null, null, true)
      }, CLOSE_DEADLINE_MS)
    }
    requestTermination()
  }
  const capture = (stream, value) => {
    if (settled) return
    outputBytes += Buffer.byteLength(value)
    if (outputBytes > OUTPUT_LIMIT_BYTES) {
      stop({ code: 'AIMLOCK_CHAIN_OUTPUT_LIMIT', message: 'Command output exceeded the capture limit' })
    } else if (stream === 'stdout') stdout += value
    else stderr += value
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (value) => capture('stdout', value))
  child.stderr.on('data', (value) => capture('stderr', value))
  child.once('error', (error) => stop(errorRecord(error)))
  child.once('close', (exitCode, signal) => finish(exitCode, signal, false))
  timeout = setTimeout(() => {
    stop({ code: 'AIMLOCK_CHAIN_COMMAND_TIMEOUT', message: 'Command exceeded its declared timeout' })
  }, input.timeoutMs)
  return { completed, stop }
}

export async function executeCommand(root, input, callId, onSpawn) {
  const workingDirectory = input.workingDirectory === '.' ? root
    : (await resolvedProjectPath(root, input.workingDirectory)).target
  if (workingDirectory !== root) {
    const checked = await resolvedProjectPath(root, input.workingDirectory)
    if (!checked.status.isDirectory()) fail('AIMLOCK_CHAIN_CWD_INVALID', 'command workingDirectory must be a directory')
  }
  const startedAt = Date.now()
  const child = spawn(input.executable, input.args, { cwd: resolve(workingDirectory),
    shell: false, env: input.environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const completion = commandCompletion(child, input, startedAt)
  if (child.pid !== undefined) {
    try { await onSpawn(child.pid) } catch (error) {
      completion.stop(errorRecord(error))
      await completion.completed
      throw error
    }
  }
  const output = await completion.completed
  const command = [input.executable, ...input.args].map((part) => JSON.stringify(part)).join(' ')
  const summary = output.error ? output.error.message
    : output.signal ? 'Process terminated by ' + output.signal : 'Process exited with code ' + output.exitCode
  const evidence = { schemaVersion: 'cli.tax.test-evidence/1.0', evidenceId: callId,
    kind: input.evidenceKind, runner: 'local', producer: 'local-cli-process', command,
    exitCode: output.exitCode, durationMs: output.durationMs, summary,
    stdoutSha256: sha256(output.stdout), stderrSha256: sha256(output.stderr),
    sandboxed: false, independentRunnerVerified: false }
  if (output.exitCode === null) {
    return { status: output.unreaped ? 'uncertain' : 'failed', ...output, evidence: [], termination: summary }
  }
  return { status: !output.error && output.exitCode === 0 ? 'succeeded' : 'failed',
    ...output, evidence: [evidence] }
}
