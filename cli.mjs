#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchOfficialSkillCli, runIntakeHandshake } from './installer.mjs'

const INTAKE_QUESTIONS = [
  { id: 'goal', required: true, prompt: 'What must be true when this finishes, and what must never change?', example: '只改税率常量一行，不改其它计税逻辑' },
  { id: 'targetFiles', required: true, prompt: 'Which file paths are in scope? Use unknown if not located yet.', example: 'apps/web/src/tax.ts' },
  { id: 'estimatedChangedLines', required: true, prompt: 'How many lines should change?', example: '1' },
  { id: 'crossModule', required: true, prompt: 'Does this cross modules? yes or no.', example: 'no' },
  { id: 'needParallel', required: true, prompt: 'Must independent modules run in parallel? yes or no.', example: 'no' },
  { id: 'goalKind', required: true, prompt: 'Goal kind: code, calculator, mixed, or docs.', example: 'code' },
  { id: 'deliveryDoc', required: true, prompt: 'After success, summarize a local delivery document? yes or no.', example: 'no' },
]

await dispatchOfficialSkillCli({
  packageRoot: dirname(fileURLToPath(import.meta.url)),
  runCommand: (context) => runIntakeHandshake(context, {
    questions: INTAKE_QUESTIONS,
    outputFile: 'AIMLOCK-REQUIREMENTS.json',
    afterCapabilities(output) {
      const notice = output.firstUseNotice?.zh
      if (typeof notice === 'string' && notice.trim()) console.log(notice)
    },
  }),
})
