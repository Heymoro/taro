import { sameDraftFingerprint } from './draft-storage'
import { sessionReceiptDesired } from './entry-load'
import { fingerprintInitialInputValue } from './initial-input-intent'
import { readRecoveryEntry, readUnsettledRecord } from './recovery-contract'

const id = (value) => Number.isSafeInteger(value) && value > 0
const copy = (value) => JSON.parse(JSON.stringify(value))
const fp = (value) => fingerprintInitialInputValue({ value })
const equal = (a, b) => sameDraftFingerprint(fp(a).value, fp(b).value)
const pinFields = ['mode', 'templateId']
function immutable(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable)
    Object.freeze(value)
  }
  return value
}
export function sessionCreationRecoveryKey({ session }) {
  const invalid =
    !session || !['free', 'effect'].includes(session.mode) || !id(session.templateId)
  if (invalid) return null
  return `unsettled:template:${session.mode === 'free' ? 'free' : session.templateId}`
}
/** Only the caller may nominate an opaque source. The envelope never grants key authority. */
export function readSessionCreationCandidate({ value, recoveryKey, originStorageKey }) {
  if (value == null) return { status: 'absent' }
  const fingerprint = fp(value)
  if (!fingerprint.ok) return { status: 'conflict' }
  value = JSON.parse(fingerprint.value.json)
  const pending = readUnsettledRecord({ record: value.record })
  if (pending && value.record.sessionRequest == null) return { status: 'other' }
  const opaque =
    typeof originStorageKey === 'string' &&
    originStorageKey.trim() === originStorageKey &&
    !!originStorageKey &&
    !/^(session|unsettled|initial-input|template|fork):/.test(originStorageKey)
      ? originStorageKey
      : undefined
  const checked = readRecoveryEntry({ value, recoveryKey, storageKey: opaque })
  if (
    !checked ||
    checked.record.sessionId !== null ||
    checked.record.sessionRequest == null ||
    checked.record.submission !== null ||
    sessionCreationRecoveryKey({ session: checked.record }) !== recoveryKey
  ) {
    return { status: 'conflict' }
  }
  const suffix = `:entry:${checked.record.mode}:${checked.record.templateId}${checked.record.templateVersionId === undefined ? '' : `:${checked.record.templateVersionId}`}`
  if (
    ![checked.templateKey, checked.templateKey + suffix, ...(opaque ? [opaque, opaque + suffix] : [])].includes(
      checked.draftKey
    )
  ) {
    return { status: 'conflict' }
  }
  return immutable({ status: 'candidate', ...copy(checked), envelopeFingerprint: fingerprint.value })
}
/** Exact full values classify crash phases, never merely a pin or request identity. */
export function classifyCreationTargets({ record, receipt, source, alias }) {
  const desired = sessionReceiptDesired({ frozenRecord: record, receipt })
  if (!desired || (receipt.mode !== undefined && receipt.mode !== record.mode)) return { status: 'conflict' }
  const legacyDesired = Object.prototype.hasOwnProperty.call(record, 'templateVersionId') ? { ...desired, templateVersionId: record.templateVersionId } : desired
  const base = { ...copy(record), sessionRequest: null }
  const omitted = { ...base }
  if (omitted.carryBackSourceTaskId === null) delete omitted.carryBackSourceTaskId
  const withNull = { ...base, carryBackSourceTaskId: null }
  const sourcePhase =
    source === undefined ? 'absent' : equal(source, record) ? 'frozen' : (equal(source, desired) || equal(source, legacyDesired)) ? 'desired' : null
  const sourceStage =
    sourcePhase || (equal(source, base) || equal(source, omitted) || equal(source, withNull) ? 'base' : null)
  const aliasStage =
    alias === undefined ? 'absent' : equal(alias, record) ? 'frozen' : (equal(alias, desired) || equal(alias, legacyDesired)) ? 'desired' : null
  return sourceStage && aliasStage
    ? immutable({ status: 'ready', desired, sourceStage, aliasStage })
    : { status: 'conflict' }
}
/** Consumes metadata from an owned GET; this pure correlation does not authenticate a user. */
export function proveSessionCreationOrigin({ entry, session, candidate, source, alias }) {
  if (candidate.status !== 'candidate') return { status: candidate.status }
  const record = candidate.record
  const mismatched =
    !entry ||
    entry.kind !== 'session' ||
    !id(entry.sessionId) ||
    session?.id !== entry.sessionId ||
    pinFields.some((key) => session[key] !== record[key]) ||
    pinFields.some((key) => entry[key] != null && entry[key] !== record[key])
  if (mismatched) return { status: 'conflict' }
  if (session.creationClientRequestId == null) return { status: 'unproven' }
  const nonce = session.creationClientRequestId
  const invalidNonce =
    typeof nonce !== 'string' || !nonce.trim() || nonce.length > 128 || nonce !== record.sessionRequest.clientRequestId
  if (invalidNonce) return { status: 'conflict' }
  const targets = classifyCreationTargets({ record, receipt: session, source, alias })
  if (targets.status !== 'ready') return targets
  return immutable({
    ...targets,
    record: copy(record),
    knownSessionId: entry.sessionId,
    identity: candidate.identity,
    envelopeFingerprint: copy(candidate.envelopeFingerprint),
    sourceFingerprint: fp(source).value,
    aliasFingerprint: fp(alias).value,
  })
}
