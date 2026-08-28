import { readFile } from 'node:fs/promises'
import { repositoryRoot, resolvedProjectPath } from './aimlock-local-fs.mjs'

const CONTEXT_MAP_SCHEMA = 'contextbase.project-map/1.0'

function statSignature(status) {
  return [status.dev, status.ino, status.size, status.mtimeMs, status.ctimeMs].join(':')
}

async function resolveContextMapTargets(root, targetSymbols) {
  if (targetSymbols === undefined) return { targets: [], used: false }
  if (!Array.isArray(targetSymbols) || targetSymbols.length === 0
    || targetSymbols.some((symbol) => typeof symbol !== 'string' || !symbol.trim())) {
    throw new Error('targetSymbols must be a non-empty string array')
  }
  const canonicalRoot = await repositoryRoot(root)
  const mapFile = await resolvedProjectPath(canonicalRoot, '.contextbase/project-map.json')
  const map = JSON.parse(await readFile(mapFile.target, 'utf8'))
  if (map.schemaVersion !== CONTEXT_MAP_SCHEMA || !Array.isArray(map.entries)) {
    throw new Error('ContextBase project map is invalid')
  }
  const targets = []
  for (const requested of targetSymbols) {
    const symbol = requested.trim()
    const matches = map.entries.filter((entry) => Array.isArray(entry.exports)
      && entry.exports.some((item) => item?.name === symbol))
    if (matches.length !== 1) {
      throw new Error(matches.length ? `${symbol} is ambiguous in the ContextBase map`
        : `${symbol} is absent from the ContextBase map`)
    }
    const entry = matches[0]
    const file = await resolvedProjectPath(canonicalRoot, entry.path)
    if (statSignature(file.status) !== entry.signature) {
      throw new Error(`ContextBase map entry is stale: ${entry.path}`)
    }
    targets.push(entry.path)
  }
  return { targets: [...new Set(targets)].sort(), used: true,
    mapPath: mapFile.path }
}

export { CONTEXT_MAP_SCHEMA, resolveContextMapTargets }
