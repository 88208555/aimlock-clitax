const VALIDATOR_PENDING = new Set(['sandbox-run', 'fuzz-input', 'perf-benchmark', 'intrusive-test'])
const VALIDATOR_STATIC = new Set(['validate-structure', 'security-scan', 'compliance-audit'])
const ACCEPTED_VERDICTS = new Set(['pass', 'pass-with-risk'])

function blocked(code, message) { return { status: 'blocked', error: { code, message } } }

export function skillOutcome(step, output) {
  if (output.status !== 'succeeded') return { status: output.status, error: null }
  if (output.allowed === false || output.autoAccept === false || output.escalate === true
    || output.validation?.valid === false || (Object.hasOwn(output, 'trafficLight') && output.trafficLight !== 'green')) {
    return blocked('AIMLOCK_CHAIN_GATE_BLOCKED', 'The protocol call succeeded but its gate did not allow continuation')
  }
  if (step.skillId !== 'validator') return { status: 'succeeded', error: null }
  if (VALIDATOR_PENDING.has(step.operation)) {
    return blocked('AIMLOCK_CHAIN_EXECUTION_PENDING', 'Validator returned an execution descriptor; no test execution is established')
  }
  if (step.operation === 'verdict' && (!ACCEPTED_VERDICTS.has(output.report?.verdict)
    || output.report.evidenceValid !== true || output.report.evidenceCount < 1
    || output.report.riskLedgerValid !== true)) {
    return blocked('AIMLOCK_CHAIN_VERDICT_NOT_ACCEPTED', 'Validator did not issue a complete passing verdict with valid evidence')
  }
  if (step.operation === 'functional-verify' && (!Array.isArray(output.evidence) || !output.evidence.length
    || output.summary?.failed !== 0 || output.evidence.some((evidence) => evidence.exitCode !== 0))) {
    return blocked('AIMLOCK_CHAIN_FUNCTIONAL_NOT_PASSED', 'Functional verification contains missing or failed execution evidence')
  }
  if (VALIDATOR_STATIC.has(step.operation) && output.findings.some((finding) => ['P0', 'P1'].includes(finding.severity))) {
    return blocked('AIMLOCK_CHAIN_STATIC_FINDINGS', 'Static verification has unresolved P0/P1 findings')
  }
  return { status: 'succeeded', error: null }
}

export function answerMatchesContinuation(condition, answer) {
  if (!condition) return false
  const expected = condition.answer
  if (Array.isArray(expected) || Array.isArray(answer)) {
    return Array.isArray(expected) && Array.isArray(answer)
      && JSON.stringify([...expected].sort()) === JSON.stringify([...answer].sort())
  }
  return expected === answer
}
