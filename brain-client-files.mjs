import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, mkdir, writeFile, readFile } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'

const MAX_FILE_BYTES = 2_000_000
const MAX_CONTEXT_CHARACTERS = 6_000
export function validateBrainPath(path) {
  if (typeof path !== 'string' || !path || path.length > 500 || isAbsolute(path)
    || /[\\:\u0000-\u001f\u007f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')
    || /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|node_modules|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|p12|key)$/i.test(path)) {
    throw new Error('Brain target must be a safe relative project file')
  }
}

async function checkedAncestors(root, path) {
  const canonicalRoot = await realpath(root)
  let current = canonicalRoot
  for (const part of path.split('/').slice(0, -1)) {
    current = resolve(current, part)
    let status
    try { status = await lstat(current) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Brain target has an unsafe parent')
  }
  return canonicalRoot
}

export async function inspectBrainTarget(root, path) {
  validateBrainPath(path)
  const canonicalRoot = await checkedAncestors(root, path)
  const target = resolve(canonicalRoot, path)
  let status
  try { status = await lstat(target) }
  catch (error) { if (error.code === 'ENOENT') return { path, sha256: null, context: '' }; throw error }
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES) throw new Error('Brain target is not a bounded regular file')
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.dev !== status.dev || opened.ino !== status.ino || !opened.isFile()) throw new Error('Brain target changed during inspection')
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    if (length > MAX_FILE_BYTES) throw new Error('Brain target exceeds the file limit')
    const final = await lstat(target)
    const inside = relative(canonicalRoot, await realpath(target))
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)
      || final.dev !== opened.dev || final.ino !== opened.ino || final.mtimeMs !== opened.mtimeMs) {
      throw new Error('Brain target changed during inspection')
    }
    const contents = bytes.subarray(0, length)
    if (contents.includes(0)) throw new Error('Brain context must be a text file')
    return { path, sha256: createHash('sha256').update(contents).digest('hex'),
      context: contents.toString('utf8').slice(0, MAX_CONTEXT_CHARACTERS) }
  } finally { await file.close() }
}

export async function brainStateDirectory(root, parts) {
  const canonicalRoot = await realpath(root)
  let directory = canonicalRoot
  for (const part of ['.aimlock', ...parts]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.aimlock') throw new Error('Brain state path is invalid')
    directory = resolve(directory, part)
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const status = await lstat(directory)
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Brain state directory is unsafe')
  }
  return directory
}

export async function saveBrainRequest(root, request, digest) {
  const directory = await brainStateDirectory(root, ['brain-requests'])
  const path = resolve(directory, request.requestId + '.json')
  try { await writeFile(path, JSON.stringify(request), { mode: 0o600, flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const status = await lstat(path)
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES) throw new Error('Saved Brain request is unsafe')
    if (digest(JSON.parse(await readFile(path, 'utf8'))) !== digest(request)) {
      throw new Error('Brain request ID is already bound to different local input')
    }
  }
}
