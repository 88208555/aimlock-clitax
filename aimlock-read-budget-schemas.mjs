import { RENEWAL_LIMITS } from './aimlock-read-budget-renewal.mjs'

const stringSchema = { type: 'string', minLength: 1 }
const objectSchema = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties })
const scopeSchema = objectSchema(['goal', 'allowedPaths'], { goal: stringSchema,
  allowedPaths: { type: 'array', minItems: 1, items: stringSchema } })
const policySchema = objectSchema(['intervalMs', 'maxRenewals'], {
  intervalMs: { type: 'integer', minimum: RENEWAL_LIMITS.minIntervalMs, maximum: RENEWAL_LIMITS.maxIntervalMs },
  maxRenewals: { type: 'integer', minimum: 1, maximum: RENEWAL_LIMITS.maxRenewals },
})
const confirmationSchema = objectSchema(['schemaVersion', 'requestId', 'status', 'callbackRequest', 'auditEntry', 'nextStep'], {
  schemaVersion: { const: 'confirm-protocol.skill.response/1.0' }, requestId: stringSchema,
  status: { const: 'succeeded' },
  callbackRequest: objectSchema(['operation', 'payload'], { operation: { const: 'budget-auto-renew' },
    payload: objectSchema(['chainId', 'scopeDigest', 'policy', 'requestId', 'answer'], {
      chainId: stringSchema, scopeDigest: stringSchema, policy: policySchema, requestId: stringSchema, answer: { const: 'approve' },
    }) }),
  auditEntry: objectSchema(['schemaVersion', 'auditId', 'requestId', 'actorId', 'question', 'answer', 'remembered', 'risk', 'answeredAt'], {
    schemaVersion: { const: 'confirm.audit-entry/1.0' }, auditId: stringSchema, requestId: stringSchema,
    actorId: stringSchema, question: stringSchema, answer: { const: 'approve' }, remembered: { const: false },
    risk: { const: 'low' }, answeredAt: { type: 'string', format: 'date-time' },
  }), nextStep: { type: 'object' },
})
const terms = { chainId: stringSchema, scope: scopeSchema, policy: policySchema }
const AUTO_RENEW_OPERATION_SCHEMAS = Object.freeze({
  'budget-auto-renew-request': objectSchema(['chainId', 'scope', 'policy', 'requestId'], { ...terms, requestId: stringSchema }),
  'budget-auto-renew': objectSchema(['chainId', 'scope', 'policy', 'confirmation'], { ...terms, confirmation: confirmationSchema }),
  'budget-auto-renew-stop': objectSchema(['chainId', 'reason'], { chainId: stringSchema, reason: { enum: ['revoked', 'completed'] } }),
})

export { AUTO_RENEW_OPERATION_SCHEMAS }
