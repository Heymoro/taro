import { fingerprintInitialInputValue } from './initial-input-intent'

export const sameDraftFingerprint = (a, b) =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'absent' || a.json === b.json)

/** Observational compare/set protection, not a cross-process atomic CAS. */
export function createDraftStorage({ storage, isInterested }) {
  const interested = (epoch) => {
    try {
      return !!isInterested({ epoch })
    } catch {
      return false
    }
  }
  const error = '本机保存结果尚未确认，请不要关闭页面'
  function read({ epoch, key }) {
    if (!interested(epoch)) return { status: 'cancelled', error }
    let value
    try {
      value = storage.get(key)
    } catch {
      return { status: interested(epoch) ? 'failed' : 'cancelled', error }
    }
    if (!interested(epoch)) return { status: 'cancelled', error }
    const result = fingerprintInitialInputValue({ value })
    if (!result.ok) return { status: 'failed', error }
    // Fingerprint validates hostile descriptors before the detached compatibility copy.
    try {
      return {
        status: 'read',
        value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
        fingerprint: result.value
      }
    } catch {
      return { status: 'failed', error }
    }
  }
  function compareAndSet({ epoch, key, expected, desired }) {
    const desiredResult = fingerprintInitialInputValue({ value: desired })
    if (!desiredResult.ok) return { status: 'failed', error }
    const before = read({ epoch, key })
    if (before.status !== 'read') return before
    if (!sameDraftFingerprint(before.fingerprint, expected)) return { status: 'conflict', error }
    const attempt = { key, prior: expected, desired: desiredResult.value }
    if (!interested(epoch)) return { status: 'cancelled', error }
    try {
      storage.set(key, desired)
    } catch {
      return { status: 'unconfirmed', attempt, error }
    }
    if (!interested(epoch)) return { status: 'unconfirmed', attempt, error }
    const after = read({ epoch, key })
    if (after.status !== 'read' || !sameDraftFingerprint(after.fingerprint, desiredResult.value)) {
      return { status: 'unconfirmed', attempt, error }
    }
    return { status: 'written', fingerprint: after.fingerprint }
  }
  return { read, compareAndSet }
}
