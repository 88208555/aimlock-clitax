#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { cwd, stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { defaultUsage, dispatchOfficialSkillCli, runIntakeHandshake } from './installer.mjs'
import {
  LOCAL_CAPABILITIES,
  extendReadBudget,
  guardedWriteFile,
  initializeReadBudget,
  issueMutationPass,
  probeRepositoryDemand,
  readBudgetStatus,
  readFileWithinBudget,
  reassessMode,
  verifyMutationPassFile,
} from './aimlock-local-runner.mjs'

const BYPASS_LINE_BUDGET = 500
const DIFFICULTIES = new Set(['low', 'medium', 'high'])
const RISKS = new Set(['low', 'medium', 'high'])
const TRUE_ANSWERS = new Set(['yes', 'y', 'true', '是', '需要', 'да'])
const FALSE_ANSWERS = new Set(['no', 'n', 'false', '否', '不需要', 'нет'])
const BYPASS_NOTICE = [
  '需求较小且低风险，不建议使用 Aimlock；请直接处理，或只调用一个匹配的专项技能。',
  'This request is small and low risk; Aimlock is not recommended. Handle it directly or use one matched specialist skill.',
  'Запрос небольшой и низкорисковый; Aimlock не рекомендуется. Выполните его напрямую или используйте один профильный навык.',
].join('\n')
const COMMON_RUN_USAGE = "      Run this skill's applicability or onboarding flow; only a real HTTP invocation can trigger automatic evaluation."
const AIMLOCK_RUN_USAGE = '      Collect six applicability facts locally; bypass makes no skill HTTP call, automatic evaluation, or requirements file, while active work runs authenticated intake.'

const APPLICABILITY_QUESTIONS = [
  { id: 'goal', prompt: '目标 / Goal / Цель', parse: parseText },
  { id: 'targetHints', prompt: '目标路径（逗号分隔） / Target paths / Целевые пути', parse: parseTargetHints },
  { id: 'explicitAimlockRequested', prompt: '是否明确要求启用 Aimlock / Explicitly require Aimlock / Явно включить Aimlock (yes|no)', parse: parseBoolean },
]

const INTAKE_QUESTIONS = [
  { id: 'goal', required: true, prompt: '完成标准与禁止改动 / Goal and forbidden changes / Цель и запрещённые изменения', example: '只改税率常量一行，不改其它计税逻辑' },
  { id: 'difficulty', required: true, prompt: '需求难度 / Difficulty / Сложность: low, medium, or high?', example: 'medium' },
  { id: 'risk', required: true, prompt: '风险等级 / Risk / Риск: low, medium, or high?', example: 'low' },
  { id: 'targetFiles', required: true, prompt: '目标文件 / Target files / Целевые файлы (unknown if not located)', example: 'apps/web/src/tax.ts' },
  { id: 'estimatedChangedLines', required: true, prompt: '预计改动行数 / Estimated changed lines / Оценка строк', example: '1' },
  { id: 'crossModule', required: true, prompt: '是否跨模块 / Cross-module / Межмодульно: yes or no?', example: 'no' },
  { id: 'needParallel', required: true, prompt: '是否必须并行 / Parallel required / Нужна параллельность: yes or no?', example: 'no' },
  { id: 'explicitAimlockRequested', required: true, prompt: '是否明确要求启用 Aimlock / Explicitly require Aimlock / Явно включить Aimlock: yes or no?', example: 'no' },
  { id: 'goalKind', required: true, prompt: '需求类型 / Goal kind / Тип цели: code, calculator, mixed, or docs?', example: 'code' },
  { id: 'deliveryDoc', required: true, prompt: '是否生成交付文档 / Delivery document / Нужен отчёт: yes or no?', example: 'no' },
]

function parseBoolean(source) {
  const value = source.trim().toLowerCase()
  if (TRUE_ANSWERS.has(value)) return true
  if (FALSE_ANSWERS.has(value)) return false
  throw new Error('expected yes or no')
}

function parseText(source) {
  const value = source.trim()
  if (!value) throw new Error('a non-empty value is required')
  return value
}

function parseTargetHints(source) {
  const values = source.split(',').map((value) => value.trim()).filter(Boolean)
  if (!values.length) throw new Error('at least one target path is required')
  return values
}

export function localAimlockApplicability(facts) {
  const valid = DIFFICULTIES.has(facts.difficulty)
    && RISKS.has(facts.risk)
    && Number.isSafeInteger(facts.estimatedChangedLines)
    && facts.estimatedChangedLines >= 0
    && typeof facts.crossModule === 'boolean'
    && typeof facts.needParallel === 'boolean'
    && typeof facts.explicitAimlockRequested === 'boolean'
  if (!valid) throw new Error('Aimlock applicability facts are incomplete or invalid')
  const bypass = facts.difficulty === 'low'
    && facts.estimatedChangedLines <= BYPASS_LINE_BUDGET
    && facts.crossModule === false
    && facts.risk !== 'high'
    && facts.needParallel === false
    && facts.explicitAimlockRequested === false
  return { mode: bypass ? 'bypass' : 'active', useAimlock: !bypass }
}

export function aimlockUsage(context) {
  const usage = defaultUsage(context)
  if (!usage.includes(COMMON_RUN_USAGE)) throw new Error('Shared CLI run usage contract changed')
  return usage.replace(COMMON_RUN_USAGE, AIMLOCK_RUN_USAGE)
}

async function collectApplicability(input, output) {
  const readline = createInterface({ input, output })
  const answers = {}
  try {
    for (const question of APPLICABILITY_QUESTIONS) {
      for (;;) {
        const source = await readline.question(`${question.prompt}\n> `)
        try {
          answers[question.id] = question.parse(source)
          break
        } catch (error) {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
  } finally {
    readline.close()
  }
  return answers
}

export async function runAimlockWith(context, dependencies) {
  const facts = await dependencies.collectApplicability()
  const decision = localAimlockApplicability(facts)
  if (!decision.useAimlock) {
    dependencies.writeNotice(BYPASS_NOTICE)
    return decision
  }
  await dependencies.runHandshake(context, {
    questions: INTAKE_QUESTIONS,
    outputFile: 'AIMLOCK-REQUIREMENTS.json',
    afterCapabilities(output) {
      const notice = output.firstUseNotice?.zh
      if (typeof notice === 'string' && notice.trim()) console.log(notice)
    },
  })
  return decision
}

async function runAimlock(context) {
  return runAimlockWith(context, {
    collectApplicability: async () => {
      const answers = await collectApplicability(stdin, stdout)
      const probe = await probeRepositoryDemand({
        repositoryRoot: cwd(), goal: answers.goal, targetHints: answers.targetHints,
      })
      console.log(JSON.stringify({ mode: probe.mode, facts: probe.facts }))
      return { ...probe.facts, explicitAimlockRequested: answers.explicitAimlockRequested }
    },
    writeNotice: (message) => console.log(message),
    runHandshake: runIntakeHandshake,
  })
}

async function readJsonInput(input) {
  let source = ''
  for await (const chunk of input) source += chunk
  if (!source.trim()) return {}
  const value = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local operation input must be a JSON object')
  }
  return value
}

async function runLocalOperation(operation, repositoryRoot, input) {
  const scoped = { ...input, repositoryRoot }
  if (operation === 'capabilities') return LOCAL_CAPABILITIES
  if (operation === 'probe') return probeRepositoryDemand(scoped)
  if (operation === 'reassess') return reassessMode(input)
  if (operation === 'budget-init') return initializeReadBudget(scoped)
  if (operation === 'budget-read') return readFileWithinBudget(scoped)
  if (operation === 'budget-status') return readBudgetStatus(scoped)
  if (operation === 'budget-extend') return extendReadBudget(scoped)
  if (operation === 'gate-issue') return issueMutationPass(scoped)
  if (operation === 'gate-verify') return verifyMutationPassFile(scoped)
  if (operation === 'guarded-write') return guardedWriteFile(scoped)
  throw new Error(`unsupported local operation: ${operation}`)
}

async function dispatchLocal(args) {
  const operation = args[0]?.trim()
  const repositoryRoot = args[1]?.trim()
  if (!operation || !repositoryRoot) {
    throw new Error('usage: cli-aimlock local <operation> <repositoryRoot>')
  }
  return runLocalOperation(operation, repositoryRoot, await readJsonInput(stdin))
}

const cliPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === cliPath) {
  if (process.argv[2] === 'local') {
    try {
      console.log(JSON.stringify(await dispatchLocal(process.argv.slice(3))))
    } catch (error) {
      console.error(JSON.stringify({ status: 'failed', code: error?.code ?? 'AIMLOCK_LOCAL_FAILED',
        message: error instanceof Error ? error.message : String(error) }))
      process.exitCode = error?.code === 'AIMLOCK_DECISION_REQUIRED' ? 2 : 1
    }
  } else {
    await dispatchOfficialSkillCli({
      packageRoot: dirname(cliPath),
      runCommand: runAimlock,
      usage: aimlockUsage,
    })
  }
}

export { runLocalOperation }
