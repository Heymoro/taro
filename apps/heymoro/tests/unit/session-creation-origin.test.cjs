const test = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
function data(mode = 'free', sourceKey) {
  const templateKey = `template:${mode === 'free' ? 'free' : 1}`
  const record = {
    protocol: 2,
    mode,
    templateId: 1,
    templateVersionId: 2,
    sessionId: null,
    description: 'local',
    userNotes: 'notes',
    photos: [],
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: ' nonce 🐱 ' },
    submission: null,
    draftPaused: false,
    recoveryKey: `unsettled:${templateKey}`,
  }
  const session = {
    id: 4,
    mode,
    templateId: 1,
    templateVersionId: 2,
    creationClientRequestId: record.sessionRequest.clientRequestId,
  }
  return {
    record,
    session,
    entry: { key: 'session:4', kind: 'session', sessionId: 4 },
    recoveryKey: record.recoveryKey,
    value: { protocol: 2, draftKey: sourceKey || templateKey, record },
    desired: { ...record, sessionId: 4, sessionRequest: null },
  }
}
test('origin helper is a pure contract, not GET ownership authentication', () => {
  const { readSessionCreationCandidate, proveSessionCreationOrigin } = load(
    'src/features/creation/session-creation-origin.js'
  )
  const d = data(),
    candidate = readSessionCreationCandidate(d)
  assert.equal(candidate.status, 'candidate')
  const proof = proveSessionCreationOrigin({ ...d, candidate, source: d.record, alias: undefined })
  assert.equal(proof.status, 'ready')
  assert.equal(proof.knownSessionId, 4)
  assert.equal(Object.isFrozen(proof), true)
  assert.deepEqual(clone(proof.record), d.record)
})
for (const mode of ['free', 'effect'])
  for (const shape of ['generic', 'bound', 'opaque', 'opaque-bound'])
    test(`pure ${mode} ${shape} accepts only caller-nominated source family`, () => {
      const m = load('src/features/creation/session-creation-origin.js')
      const base = shape.startsWith('opaque') ? 'owner:1:free' : `template:${mode === 'free' ? 'free' : 1}`
      const source = base + (shape.endsWith('bound') ? `:entry:${mode}:1:2` : '')
      const d = data(mode, source),
        before = clone(d)
      const candidate = m.readSessionCreationCandidate({ ...d, originStorageKey: 'owner:1:free' })
      assert.equal(candidate.status, 'candidate')
      for (const source of [
        undefined,
        d.record,
        d.desired,
        { ...d.record, sessionRequest: null },
        { ...d.record, sessionRequest: null, carryBackSourceTaskId: null },
      ])
        for (const alias of [undefined, d.record, d.desired]) {
          const proof = m.proveSessionCreationOrigin({ ...d, candidate, source, alias })
          assert.equal(proof.status, 'ready')
          assert.equal(Object.isFrozen(proof.record.sessionRequest), true)
        }
      assert.deepEqual(d, before)
      if (shape.startsWith('opaque')) assert.equal(m.readSessionCreationCandidate(d).status, 'conflict')
    })
for (const sourceKey of [
  'session:4',
  'unsettled:template:free',
  'initial-input:x',
  'fork:session:4',
  'template:01',
  'template:free:entry:free:01:2',
  'template:free:entry:free:1:02',
  ' template:free ',
  'owner:other',
])
  test(`source key ${sourceKey} cannot self-authorize through envelope`, () => {
    const m = load('src/features/creation/session-creation-origin.js'),
      d = data('free', sourceKey)
    assert.equal(
      m.readSessionCreationCandidate({
        ...d,
        originStorageKey: sourceKey.startsWith('owner:') ? 'owner:1:free' : sourceKey,
      }).status,
      'conflict'
    )
  })
for (const wrong of [undefined, null, '', ' ', 'nonce 🐱', ' nonce 🐱', 'x'.repeat(129), 'x'.repeat(128), 123])
  test(`nonce ${JSON.stringify(wrong)} is literal, bounded, and never desired-based proof`, () => {
    const m = load('src/features/creation/session-creation-origin.js'),
      d = data()
    const candidate = m.readSessionCreationCandidate(d)
    const proof = m.proveSessionCreationOrigin({
      ...d,
      candidate,
      session: { ...d.session, creationClientRequestId: wrong },
      source: d.desired,
      alias: d.desired,
    })
    assert.equal(proof.status, wrong == null ? 'unproven' : 'conflict')
  })
test('UTF16 nonce limit is 128 code units with no whitespace normalization', () => {
  const m = load('src/features/creation/session-creation-origin.js'),
    d = data()
  d.record.sessionRequest.clientRequestId = '🐱'.repeat(64)
  d.session.creationClientRequestId = d.record.sessionRequest.clientRequestId
  const candidate = m.readSessionCreationCandidate(d)
  assert.equal(m.proveSessionCreationOrigin({ ...d, candidate, source: d.record }).status, 'ready')
  d.record.sessionRequest.clientRequestId += ' '
  assert.equal(m.readSessionCreationCandidate(d).status, 'conflict')
})
for (const place of ['source', 'alias'])
  for (const mutation of ['description', 'nonce', 'sessionId', 'extra', 'null'])
    test(`${place} third ${mutation} never becomes coverage permission`, () => {
      const m = load('src/features/creation/session-creation-origin.js'),
        d = data()
      let value = clone(d.record)
      if (mutation === 'nonce') value.sessionRequest.clientRequestId = 'other'
      else if (mutation === 'extra') value.extra = true
      else if (mutation === 'null') value = null
      else value[mutation] = mutation === 'sessionId' ? 8 : 'third'
      const proof = m.proveSessionCreationOrigin({
        ...d,
        candidate: m.readSessionCreationCandidate(d),
        source: d.record,
        alias: d.desired,
        [place]: value,
      })
      assert.equal(proof.status, 'conflict')
    })
test('same desired for two creation IDs proves neither wrong nonce nor changed full original', () => {
  const m = load('src/features/creation/session-creation-origin.js'),
    d = data()
  d.record.sessionRequest.clientRequestId = 'another request'
  const candidate = m.readSessionCreationCandidate(d)
  assert.equal(
    m.proveSessionCreationOrigin({ ...d, candidate, source: d.desired, alias: d.desired }).status,
    'conflict'
  )
})
for (const change of ['envelope-extra', 'truncated', 'wrong-pin-body', 'blank-nonce', 'bad-slots', 'hybrid'])
  test(`candidate ${change} is blocked without mutating caller input`, () => {
    const m = load('src/features/creation/session-creation-origin.js'),
      d = data()
    if (change === 'envelope-extra') d.value.extra = true
    if (change === 'truncated') delete d.value.record.photos
    if (change === 'wrong-pin-body') d.record.sessionRequest.templateId = 8
    if (change === 'blank-nonce') d.record.sessionRequest.clientRequestId = ' '
    if (change === 'bad-slots') d.record.photos = [{ id: 'p', status: 'ready', mediaId: -1 }]
    if (change === 'hybrid') d.record.sessionId = 4
    const before = clone(d)
    assert.equal(m.readSessionCreationCandidate(d).status, 'conflict')
    assert.deepEqual(d, before)
  })
for (const field of ['description', 'userNotes', 'photos', 'draftPaused', 'recoveryKey', 'extra'])
  test(`same-pin ordinary base changed ${field} is not original source permission`, () => {
    const m = load('src/features/creation/session-creation-origin.js'),
      d = data()
    const source = { ...d.record, sessionRequest: null }
    source[field] =
      field === 'photos'
        ? [{ id: 'third', status: 'ready', mediaId: 8, path: '' }]
        : field === 'draftPaused'
        ? true
        : 'third'
    assert.equal(
      m.proveSessionCreationOrigin({ ...d, candidate: m.readSessionCreationCandidate(d), source, alias: d.desired })
        .status,
      'conflict'
    )
  })
