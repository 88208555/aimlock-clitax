import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const LOCAL_SCHEMA = 'aimlock.local-runner/1.0'
const MANAGED_ROOT = '.aimlock'
const LOCK_POLL_MS = 10
const LOCK_TIMEOUT_MS = 2_000

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('AIMLOCK_IDENTIFIER_INVALID', `${field} must be a safe identifier`)
  }
  return value
}

function safeRelativePath(value, field = 'path') {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC')
    || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('AIMLOCK_PATH_UNSAFE', `${field} is unsafe`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('AIMLOCK_PATH_UNSAFE', `${field} is unsafe`)
  }
  return parts.join('/')
}

function assertInside(root, target, field) {
  const path = relative(root, target)
  if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))) return
  fail('AIMLOCK_PATH_ESCAPE', `${field} escapes the repository`)
}

async function canonicalMissingTarget(root, target) {
  const suffix = [basename(target)]
  let current = dirname(target)
  for (;;) {
    try {
      const parent = await realpath(current)
      assertInside(root, parent, 'missing path parent')
      return resolve(parent, ...suffix)
    } catch (error) {
      if (!(error instanceof Error && error.code === 'ENOENT') || current === root) throw error
      suffix.unshift(basename(current))
      current = dirname(current)
    }
  }
}

async function repositoryRoot(value) {
  const explicit = resolve(value)
  const status = await lstat(explicit)
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail('AIMLOCK_ROOT_INVALID', 'repositoryRoot must be a real directory')
  }
  return realpath(explicit)
}

async function resolvedProjectPath(root, value, options = {}) {
  const path = safeRelativePath(value)
  const target = resolve(root, ...path.split('/'))
  assertInside(root, target, 'path')
  try {
    const status = await lstat(target)
    if (status.isSymbolicLink()) fail('AIMLOCK_PATH_SYMLINK', `${path} cannot be a symlink`)
    const canonical = await realpath(target)
    assertInside(root, canonical, 'path target')
    return { path, target: canonical, status, exists: true }
  } catch (error) {
    if (!(error instanceof Error && error.code === 'ENOENT' && options.allowMissing)) throw error
    return { path, target: await canonicalMissingTarget(root, target), status: null, exists: false }
  }
}

function managedPath(root, ...parts) {
  return resolve(root, MANAGED_ROOT, ...parts)
}

async function ensureManagedDirectory(root, ...parts) {
  let current = root
  for (const [index, part] of [MANAGED_ROOT, ...parts].entries()) {
    if (index > 0) identifier(part, 'managed path segment')
    current = resolve(current, part)
    assertInside(root, current, 'managed directory')
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && error.code === 'EEXIST')) throw error
    }
    const status = await lstat(current)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fail('AIMLOCK_MANAGED_PATH_INVALID', 'managed directories must be real directories')
    }
  }
  return current
}

async function appendAudit(root, record) {
  const directory = await ensureManagedDirectory(root, 'audit')
  await appendFile(resolve(directory, 'guard.jsonl'), `${JSON.stringify({
    schemaVersion: LOCAL_SCHEMA,
    at: new Date().toISOString(),
    ...record,
  })}\n`, { mode: 0o600 })
}

async function withFileLock(path, operation) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!(error instanceof Error && error.code === 'EEXIST')) throw error
      if (Date.now() >= deadline) fail('AIMLOCK_LOCK_TIMEOUT', 'authority file is busy')
      await delay(LOCK_POLL_MS)
    }
  }
  try {
    return await operation()
  } finally {
    await handle.close()
    await unlink(lockPath)
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

export {
  LOCAL_SCHEMA,
  MANAGED_ROOT,
  appendAudit,
  assertInside,
  atomicJson,
  ensureManagedDirectory,
  fail,
  identifier,
  managedPath,
  repositoryRoot,
  resolvedProjectPath,
  safeRelativePath,
  sha256,
  withFileLock,
}
