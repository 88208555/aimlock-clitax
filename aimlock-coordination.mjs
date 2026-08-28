import { verify } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  LEASE_SCHEMA,
  leasePayload,
  withCoordinationReadLock,
} from 'cli-swarm/coordinator-fs'
import {
  fail,
  identifier,
  repositoryRoot,
  resolvedProjectPath,
  safeRelativePath,
  sha256,
} from './aimlock-local-fs.mjs'

function targetCovered(target, lockedPath) {
  return target === lockedPath || target.startsWith(`${lockedPath}/`)
}

async function regularFile(path, code, message) {
  const status = await lstat(path)
  if (!status.isFile() || status.isSymbolicLink()) fail(code, message)
  return path
}

async function verifyLeaseAgainstState(state, root, input) {
  const leasePath = safeRelativePath(input.coordinationLeasePath, 'coordinationLeasePath')
  if (!leasePath.startsWith('.coord/leases/')) {
    fail('AIMLOCK_COORDINATION_LEASE_PATH_INVALID', 'coordination lease must be inside .coord/leases')
  }
  const leaseFile = await resolvedProjectPath(root, leasePath)
  await regularFile(leaseFile.target, 'AIMLOCK_COORDINATION_LEASE_INVALID', 'coordination lease must be a regular file')
  const lease = JSON.parse(await readFile(leaseFile.target, 'utf8'))
  const publicPath = resolve(root, '.coord', 'authority', 'public.pem')
  await regularFile(publicPath, 'AIMLOCK_COORDINATION_AUTHORITY_INVALID', 'coordination public key must be a regular file')
  const publicKey = await readFile(publicPath, 'utf8')
  const chainId = identifier(input.chainId, 'chainId')
  const targetPaths = input.targetPaths.map((path) => safeRelativePath(path, 'targetPath'))
  const signatureValid = typeof lease.signature === 'string'
    && verify(null, Buffer.from(JSON.stringify(leasePayload(lease))), publicKey,
      Buffer.from(lease.signature, 'base64url'))
  const lock = state.locks.find((item) => item.lockId === lease.lockId)
  const issuedAt = Date.parse(lease.issuedAt)
  const expiresAt = Date.parse(lease.expiresAt)
  const valid = lease.schemaVersion === LEASE_SCHEMA
    && basename(leasePath) === `${lease.leaseId}.json`
    && lease.authorityKeyId === sha256(publicKey)
    && lease.chainId === chainId
    && lease.lockType === 'file'
    && Array.isArray(lease.paths) && lease.paths.length > 0
    && targetPaths.every((target) => lease.paths.some((path) => targetCovered(target, path)))
    && Number.isFinite(issuedAt) && Number.isFinite(expiresAt)
    && issuedAt <= Date.now() && expiresAt > Date.now()
    && signatureValid
    && lock?.status === 'active' && lock.leaseId === lease.leaseId
    && lock.chainId === lease.chainId && lock.agentId === lease.agentId
    && lock.expiresAt === lease.expiresAt
  if (!valid) {
    fail('AIMLOCK_COORDINATION_LEASE_INVALID', 'coordination lease is forged, expired, released, or outside its lock scope')
  }
  return { lease, lock, leaseDigest: sha256(JSON.stringify(lease)), targetPaths }
}

async function withCoordinationLease(input, action) {
  if (!Array.isArray(input.targetPaths) || input.targetPaths.length === 0) {
    fail('AIMLOCK_COORDINATION_TARGETS_REQUIRED', 'targetPaths must be a non-empty array')
  }
  return withCoordinationReadLock(input.repositoryRoot, async (state, root) => (
    action(await verifyLeaseAgainstState(state, root, input))
  ))
}

async function verifyCoordinationLease(input) {
  return withCoordinationLease(input, async (verified) => verified)
}

async function assertChainNotSuspended(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const statePath = await resolvedProjectPath(root, '.coord/state.json', { allowMissing: true })
  if (!statePath.exists) return { suspended: false }
  const chainId = identifier(input.chainId, 'chainId')
  return withCoordinationReadLock(root, async (state) => {
    const wait = state.waits.find((item) => item.chainId === chainId && item.status === 'active')
    if (wait) {
      fail('AIMLOCK_COORDINATION_WAITING', `chain ${chainId} is suspended until ${wait.event} or ${wait.deadlineAt}`)
    }
    return { suspended: false }
  })
}

export {
  assertChainNotSuspended,
  verifyCoordinationLease,
  withCoordinationLease,
}
