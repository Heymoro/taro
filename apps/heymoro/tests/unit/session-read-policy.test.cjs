const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const formal = {
  status: 404,
  code: 'NOT_FOUND',
  isOutcomeUnknown: false,
  requestId: 'request',
  retryable: false
}
const policy = () => load('src/features/creation/session-read-policy.js')
test('only the complete typed session absence is authoritative', () => {
  const p = policy()
  assert.equal(p.isFormalSessionNotFound(formal), true)
  assert.equal(p.isFormalSessionNotFound({ ...formal, retryable: true }), true)
  for (const field of Object.keys(formal)) {
    const value = { ...formal }
    delete value[field]
    assert.equal(p.isFormalSessionNotFound(value), false, `missing ${field}`)
  }
  for (const patch of [
    { status: '404' },
    { status: 409, code: 'SESSION_UNAVAILABLE' },
    { code: 'SESSION_UNAVAILABLE' },
    { retryable: 0 },
    { requestId: ' ' },
    { isOutcomeUnknown: true }
  ]) {
    assert.equal(p.isFormalSessionNotFound({ ...formal, ...patch }), false)
  }
  assert.equal(p.isFormalSessionNotFound(Error('NOT_FOUND')), false)
})
test('immutable terminal epoch never revives captured ordinary interest or migrates binding', () => {
  const p = policy()
  const initial = p.initialSessionAvailability()
  const available = p.sessionAvailable({ availability: initial, sessionId: 4 })
  assert.equal(available.terminalEpoch, 0)
  const missing = p.sessionUnavailable({ availability: available, sessionId: 4, error: formal })
  assert.equal(missing.terminalEpoch, 1)
  assert.equal(
    p.sessionUnavailable({ availability: missing, sessionId: 4, error: formal }),
    missing
  )
  assert.equal(p.isUnavailableSession({ availability: missing, sessionId: 8 }), false)
  const restored = p.sessionAvailable({ availability: missing, sessionId: 4 })
  assert.equal(restored.terminalEpoch, 1)
  assert.equal(p.sameTerminalInterest({ capturedEpoch: 0, availability: restored }), false)
  for (const value of [initial, available, missing, missing.evidence, restored])
    assert.ok(Object.isFrozen(value))
})
