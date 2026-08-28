import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { mutateGate, snapshotVerify } from './aimlock-runtime.mjs'
import { verifyCoordinationLease, withCoordinationLease } from './aimlock-coordination.mjs'
import {
  LOCAL_SCHEMA,
  MANAGED_ROOT,
  appendAudit,
  ensureManagedDirectory,
  fail,
  identifier,
  repositoryRoot,
  resolvedProjectPath,
  safeRelativePath,
  sha256,
} from './aimlock-local-fs.mjs'

const PASS_SCHEMA = 'aimlock.mutate-pass/1.0'
const MAX_GATE_TTL_SECONDS = 300
const MISSING_SHA256 = sha256('aimlock.missing-file/1.0')

function passPayload(pass) {
  return {
    schemaVersion: pass.schemaVersion,
    passId: pass.passId,
    chainId: pass.chainId,
    authorityKeyId: pass.authorityKeyId,
    issuedAt: pass.issuedAt,
    expiresAt: pass.expiresAt,
    contractDigest: pass.contractDigest,
    snapshotReceiptDigest: pass.snapshotReceiptDigest,
    pathDigest: pass.pathDigest,
    paths: pass.paths,
    coordinationRequired: pass.coordinationRequired,
    coordinationLeasePath: pass.coordinationLeasePath,
    coordinationLeaseId: pass.coordinationLeaseId,
    coordinationLockId: pass.coordinationLockId,
    coordinationLeaseDigest: pass.coordinationLeaseDigest,
    nonce: pass.nonce,
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return false
    throw error
  }
}

async function authorityKeys(root) {
  const directory = await ensureManagedDirectory(root, 'authority')
  const privatePath = resolve(directory, 'private.pem')
  const publicPath = resolve(directory, 'public.pem')
  const privateExists = await pathExists(privatePath)
  const publicExists = await pathExists(publicPath)
  if (privateExists !== publicExists) fail('AIMLOCK_AUTHORITY_INVALID', 'authority key pair is incomplete')
  if (privateExists) {
    const [privateStatus, publicStatus] = await Promise.all([lstat(privatePath), lstat(publicPath)])
    if (privateStatus.isSymbolicLink() || publicStatus.isSymbolicLink()
      || !privateStatus.isFile() || !publicStatus.isFile()) {
      fail('AIMLOCK_AUTHORITY_INVALID', 'authority keys must be regular files')
    }
  }
  if (!privateExists) {
    const pair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    await writeFile(privatePath, pair.privateKey, { flag: 'wx', mode: 0o600 })
    await writeFile(publicPath, pair.publicKey, { flag: 'wx', mode: 0o600 })
  }
  const privateKey = await readFile(privatePath, 'utf8')
  const publicKey = await readFile(publicPath, 'utf8')
  return { privateKey, publicKey, keyId: sha256(publicKey) }
}

async function fileHash(path) {
  return sha256(await readFile(path))
}

async function realSnapshotReceipt(root, input) {
  if (!input.receipt || !Array.isArray(input.receipt.paths) || !Array.isArray(input.nodes)) {
    fail('AIMLOCK_SNAPSHOT_AUTHORITY_INVALID', 'receipt paths and nodes are required')
  }
  const snapshotRoot = safeRelativePath(input.snapshotRoot, 'snapshotRoot')
  if (!snapshotRoot.startsWith(`${MANAGED_ROOT}/snapshots/`)) {
    fail('AIMLOCK_SNAPSHOT_ROOT_INVALID', 'snapshotRoot must be inside .aimlock/snapshots')
  }
  const nodes = new Map(input.nodes.map((node) => [node.path, node]))
  const files = []
  for (const path of input.receipt.paths) {
    const source = await resolvedProjectPath(root, path, { allowMissing: true })
    const newNode = nodes.get(path)?.isNewFile === true
    const snapshotPath = `${snapshotRoot}/${path}`
    if (!source.exists && newNode && !(await pathExists(resolve(root, snapshotPath)))) {
      files.push({ path, sourceHash: MISSING_SHA256, snapshotHash: MISSING_SHA256 })
      continue
    }
    const snapshot = await resolvedProjectPath(root, snapshotPath, { allowMissing: true })
    if (!source.exists || !snapshot.exists || !source.status.isFile() || !snapshot.status.isFile()) {
      fail('AIMLOCK_SNAPSHOT_AUTHORITY_INVALID', `${path} does not match its snapshot existence`)
    }
    files.push({ path, sourceHash: await fileHash(source.target),
      snapshotHash: await fileHash(snapshot.target) })
  }
  const verified = snapshotVerify({ snapshotId: input.receipt.snapshotId,
    contract: input.contract, nodes: input.nodes, files })
  if (verified.findings || verified.receipt?.receiptDigest !== input.receipt.receiptDigest) {
    fail('AIMLOCK_SNAPSHOT_AUTHORITY_INVALID', 'snapshot files do not match the supplied receipt')
  }
  return verified.receipt
}

async function issueMutationPass(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const chainId = identifier(input.chainId, 'chainId')
  const receipt = await realSnapshotReceipt(root, input)
  const gate = mutateGate({ accepted: true, receipt: input.receipt,
    contract: input.contract, nodes: input.nodes })
  if (gate.findings || gate.allowed !== true) fail('AIMLOCK_MUTATE_GATE_BLOCKED', 'mutate-gate did not allow this scope')
  const ttlSeconds = input.ttlSeconds === undefined ? MAX_GATE_TTL_SECONDS : input.ttlSeconds
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_GATE_TTL_SECONDS) {
    fail('AIMLOCK_GATE_TTL_INVALID', `ttlSeconds must be 1..${MAX_GATE_TTL_SECONDS}`)
  }
  if (typeof input.coordinationRequired !== 'boolean') {
    fail('AIMLOCK_COORDINATION_POLICY_REQUIRED', 'coordinationRequired must be an explicit boolean')
  }
  if (!input.coordinationRequired && input.coordinationLeasePath !== undefined) {
    fail('AIMLOCK_COORDINATION_POLICY_INVALID', 'a non-coordinated pass cannot carry a coordination lease')
  }
  const coordination = input.coordinationRequired
    ? await verifyCoordinationLease({ repositoryRoot: root, chainId,
      coordinationLeasePath: input.coordinationLeasePath, targetPaths: receipt.paths })
    : null
  const authority = await authorityKeys(root)
  const issuedAt = new Date()
  const pass = {
    schemaVersion: PASS_SCHEMA,
    passId: `pass-${randomUUID()}`,
    chainId,
    authorityKeyId: authority.keyId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1_000).toISOString(),
    contractDigest: receipt.contractDigest,
    snapshotReceiptDigest: receipt.receiptDigest,
    pathDigest: receipt.pathDigest,
    paths: [...receipt.paths],
    coordinationRequired: input.coordinationRequired,
    coordinationLeasePath: coordination ? input.coordinationLeasePath : null,
    coordinationLeaseId: coordination?.lease.leaseId ?? null,
    coordinationLockId: coordination?.lock.lockId ?? null,
    coordinationLeaseDigest: coordination?.leaseDigest ?? null,
    nonce: randomUUID(),
  }
  const signature = sign(null, Buffer.from(JSON.stringify(passPayload(pass))), authority.privateKey)
    .toString('base64url')
  const signedPass = { ...pass, signature }
  const directory = await ensureManagedDirectory(root, 'gates')
  const passPath = resolve(directory, `${pass.passId}.json`)
  await writeFile(passPath, `${JSON.stringify(signedPass)}\n`, { flag: 'wx', mode: 0o600 })
  await appendAudit(root, { event: 'mutate-pass-issued', chainId, passId: pass.passId,
    expiresAt: pass.expiresAt, pathDigest: pass.pathDigest })
  return { schemaVersion: LOCAL_SCHEMA, gatePassPath: `${MANAGED_ROOT}/gates/${pass.passId}.json`,
    passPath, pass: signedPass }
}

async function verifyMutationPassFile(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const gatePath = safeRelativePath(input.gatePassPath, 'gatePassPath')
  if (!gatePath.startsWith(`${MANAGED_ROOT}/gates/`)) {
    fail('AIMLOCK_GATE_PATH_INVALID', 'gate pass must be inside .aimlock/gates')
  }
  await ensureManagedDirectory(root, 'gates')
  const gateFile = await resolvedProjectPath(root, gatePath)
  const pass = JSON.parse(await readFile(gateFile.target, 'utf8'))
  const chainId = identifier(input.chainId, 'chainId')
  const targetPath = safeRelativePath(input.targetPath, 'targetPath')
  const authorityDirectory = await ensureManagedDirectory(root, 'authority')
  const publicPath = resolve(authorityDirectory, 'public.pem')
  const publicStatus = await lstat(publicPath)
  if (publicStatus.isSymbolicLink() || !publicStatus.isFile()) {
    fail('AIMLOCK_AUTHORITY_INVALID', 'authority public key must be a regular file')
  }
  const publicKey = await readFile(publicPath, 'utf8')
  const issuedAt = Date.parse(pass.issuedAt)
  const expiresAt = Date.parse(pass.expiresAt)
  const signatureValid = typeof pass.signature === 'string'
    && verify(null, Buffer.from(JSON.stringify(passPayload(pass))), publicKey,
      Buffer.from(pass.signature, 'base64url'))
  if (pass.schemaVersion !== PASS_SCHEMA || pass.chainId !== chainId
    || pass.authorityKeyId !== sha256(publicKey) || basename(gatePath) !== `${pass.passId}.json`
    || !Array.isArray(pass.paths) || !pass.paths.includes(targetPath) || !signatureValid
    || pass.pathDigest !== sha256(JSON.stringify(pass.paths))
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > Date.now() || expiresAt <= Date.now()) {
    fail('AIMLOCK_GATE_PASS_INVALID', 'gate pass is forged, expired, or outside its bound scope')
  }
  let coordination = null
  if (pass.coordinationRequired === true) {
    coordination = await verifyCoordinationLease({ repositoryRoot: root, chainId,
      coordinationLeasePath: pass.coordinationLeasePath, targetPaths: [targetPath] })
    if (coordination.lease.leaseId !== pass.coordinationLeaseId
      || coordination.lock.lockId !== pass.coordinationLockId
      || coordination.leaseDigest !== pass.coordinationLeaseDigest) {
      fail('AIMLOCK_COORDINATION_LEASE_INVALID', 'coordination lease does not match the gate pass')
    }
  } else if (pass.coordinationRequired !== false || pass.coordinationLeasePath !== null
    || pass.coordinationLeaseId !== null || pass.coordinationLockId !== null
    || pass.coordinationLeaseDigest !== null) {
    fail('AIMLOCK_GATE_PASS_INVALID', 'gate pass has an invalid coordination policy')
  }
  return { schemaVersion: LOCAL_SCHEMA, verified: true, pass, targetPath, coordination }
}

function whitelistedPath(path) {
  return path.startsWith(`${MANAGED_ROOT}/logs/`) || path.startsWith(`${MANAGED_ROOT}/tmp/`)
}

async function guardedWriteFile(input) {
  const root = await repositoryRoot(input.repositoryRoot)
  const targetPath = safeRelativePath(input.targetPath, 'targetPath')
  let passId = null
  try {
    if (whitelistedPath(targetPath)) {
      const bucket = targetPath.split('/')[1]
      await ensureManagedDirectory(root, bucket)
    }
    let verified = null
    if (!whitelistedPath(targetPath)) {
      if (!input.gatePassPath) fail('AIMLOCK_GATE_PASS_REQUIRED', 'a gate pass is required')
      verified = await verifyMutationPassFile({ ...input, targetPath })
      passId = verified.pass.passId
    }
    const performWrite = async () => {
      const target = await resolvedProjectPath(root, targetPath, { allowMissing: true })
      await mkdir(dirname(target.target), { recursive: true })
      const temporary = resolve(dirname(target.target), `.${basename(target.target)}.${randomUUID()}.tmp`)
      await writeFile(temporary, input.content, {
        flag: 'wx', mode: target.exists ? target.status.mode & 0o777 : 0o600,
      })
      await rename(temporary, target.target)
    }
    if (verified?.pass.coordinationRequired === true) {
      await withCoordinationLease({ repositoryRoot: root, chainId: input.chainId,
        coordinationLeasePath: verified.pass.coordinationLeasePath, targetPaths: [targetPath] },
      async (coordination) => {
        if (coordination.leaseDigest !== verified.pass.coordinationLeaseDigest) {
          fail('AIMLOCK_COORDINATION_LEASE_INVALID', 'coordination lease changed after pass verification')
        }
        await performWrite()
      })
    } else {
      await performWrite()
    }
    await appendAudit(root, { event: 'guarded-write-allowed', chainId: input.chainId ?? null,
      targetPath, passId, whitelisted: whitelistedPath(targetPath) })
    return { schemaVersion: LOCAL_SCHEMA, written: true, targetPath, passId }
  } catch (error) {
    await appendAudit(root, { event: 'guarded-write-denied', chainId: input.chainId ?? null,
      targetPath, passId, reason: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

export {
  PASS_SCHEMA,
  guardedWriteFile,
  issueMutationPass,
  passPayload,
  verifyMutationPassFile,
}
