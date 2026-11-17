const test = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { createInitialInputRecovery } = load('src/features/creation/initial-input-recovery.js')
const { sessionReceiptDesired } = load('src/features/creation/entry-load.js')
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const original = (mode = 'free') => ({
  protocol: 2,
  mode,
  templateId: 1,
  templateVersionId: 2,
  sessionId: null,
  description: 'local original',
  userNotes: 'notes',
  photos: [],
  sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: ' F1 ' },
  submission: null,
  draftPaused: false,
  recoveryKey: `unsettled:template:${mode === 'free' ? 'free' : 1}`,
})
const session = (mode = 'free') => ({
  id: 4,
  mode,
  templateId: 1,
  creationClientRequestId: ' F1 ',
  draft: { input: { description: '', userNotes: '', inputMediaIds: [] }, updatedAt: '2026-11-13T00:00:00Z' },
})
function harness({ mode = 'free', stage = 'both', canonical = true, sourceKey, saved } = {}) {
  const record = original(mode),
    remote = session(mode)
  const source = sourceKey || `template:${mode === 'free' ? 'free' : 1}`
  const desired = sessionReceiptDesired({ frozenRecord: record, receipt: remote })
  const map =
    saved ||
    new Map([
      [record.recoveryKey, { protocol: 2, draftKey: source, record }],
      [source, stage === 'source-F' ? clone(record) : clone(desired)],
    ])
  if (!saved && stage !== 'missing') map.set('session:4', clone(stage === 'alias-F' ? record : desired))
  const writes = [],
    control = { get: () => {}, set: () => {}, epoch: 0, current: true }
  const entry = canonical
    ? { key: 'session:4', kind: 'session', mode: null, templateId: null, templateVersionId: null, sessionId: 4 }
    : {
        key: source,
        kind: 'template',
        mode,
        templateId: mode === 'free' ? null : 1,
        templateVersionId: null,
        sessionId: null,
      }
  const r = createInitialInputRecovery({
    entry,
    ...(sourceKey ? { originStorageKey: sourceKey } : {}),
    storage: {
      get: (k) => {
        control.get(k)
        return clone(map.get(k))
      },
      set: (k, v) => {
        writes.push(k)
        control.set(k, v)
        map.set(k, clone(v))
      },
    },
    isInterested: ({ epoch }) => control.current && epoch === control.epoch,
  })
  return { r, map, writes, control, record, remote, desired, source, entry }
}
for (const stage of ['missing', 'both', 'alias-F'])
  test(`canonical ${stage} proves original before empty server fallback`, () => {
    const h = harness({ stage })
    const before = h.r.inspect({ epoch: 0 })
    assert.equal(before.projection.sessionId, 4)
    assert.notEqual(before.facts.frozen, 'conflict')
    const after = h.r.resolveSession({ epoch: 0, session: h.remote })
    assert.equal(after.projection.sessionId, 4)
    assert.equal(after.projection.description, 'local original')
    assert.equal(after.facts.knownCreationSessionId, 4)
    assert.equal(after.facts.frozen, 'valid')
    assert.deepEqual(clone(h.r.readFrozen({ epoch: 0 }).record), h.record)
    assert.equal(h.writes.length, 0)
  })
for (const mode of ['free', 'effect'])
  for (const suffix of ['', ':entry'])
    for (const canonical of [true, false])
      for (const stage of ['source-F', 'missing', 'alias-F', 'both'])
        test(`${mode} ${suffix || 'generic'} ${
          canonical ? 'canonical' : 'template'
        } ${stage} exact source recovery`, () => {
          const base = `template:${mode === 'free' ? 'free' : 1}`
          const sourceKey = suffix ? `${base}:entry:${mode}:1:2` : base
          const h = harness({ mode, canonical, stage, sourceKey })
          h.r.inspect({ epoch: 0 })
          const result = canonical ? h.r.resolveSession({ epoch: 0, session: h.remote }) : h.r.inspect({ epoch: 0 })
          assert.equal(result.facts.frozen, 'valid')
          assert.equal(result.projection.sessionId, canonical ? 4 : null)
          assert.deepEqual(clone(h.r.readFrozen({ epoch: 0 }).record), h.record)
          assert.equal(h.writes.length, 0)
        })
for (const key of ['unsettled:template:free', 'template:free', 'session:4'])
  test(`required ${key} read failure retries in same epoch without write`, () => {
    const h = harness({ stage: 'missing' })
    let failing = true
    h.control.get = (k) => {
      if (failing && k === key) throw Error('transient')
    }
    h.r.inspect({ epoch: 0 })
    assert.equal(h.r.resolveSession({ epoch: 0, session: h.remote }).facts.sourceReady, false)
    failing = false
    assert.equal(h.r.resolveSession({ epoch: 0, session: h.remote }).facts.frozen, 'valid')
    assert.equal(h.writes.length, 0)
  })
for (const key of ['unsettled:template:free', 'template:free', 'session:4'])
  test(`proof rechecks exact ${key}, preserving externally changed full record`, () => {
    const h = harness()
    h.r.resolveSession({ epoch: 0, session: h.remote })
    const value = key.startsWith('unsettled:')
      ? { ...clone(h.map.get(key)), record: { ...h.record, description: 'foreign same identity' } }
      : { ...h.map.get(key), userNotes: 'foreign' }
    h.map.set(key, value)
    assert.equal(h.r.readFrozen({ epoch: 0 }).status, 'blocked')
    assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'blocked')
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.map.get(key), value)
  })
test('template source equal identity but changed fields is not original F authority', () => {
  const h = harness({ canonical: false, stage: 'source-F' })
  h.map.set(h.source, { ...h.record, description: 'third same identity' })
  assert.notEqual(h.r.inspect({ epoch: 0 }).facts.frozen, 'valid')
  assert.equal(h.writes.length, 0)
})
test('known hybrid projection never admits ordinary save or upload; overlay stays unsaved', () => {
  const h = harness()
  const resolved = h.r.resolveSession({ epoch: 0, session: h.remote })
  for (const operation of ['normal-save', 'upload', 'quote', 'new-submission'])
    assert.equal(h.r.admit({ epoch: 0, operation }).status, 'blocked')
  h.r.noteEdit({ epoch: 0, patch: { description: 'visible overlay' } })
  assert.equal(
    h.r.saveNormal({ epoch: 0, record: { ...resolved.projection, description: 'visible overlay' } }).status,
    'blocked'
  )
  assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'blocked')
  assert.equal(h.r.project({}).description, 'visible overlay')
  assert.equal(h.r.getFacts().hasUnsavedOverlay, true)
  assert.equal(h.writes.length, 0)
})
for (const bad of [
  { creationClientRequestId: undefined },
  { creationClientRequestId: 'F1' },
  { creationClientRequestId: ' F2 ' },
  { id: 8 },
  { templateId: 9 },
  { mode: 'effect' },
])
  test(`server proof ${JSON.stringify(bad)} cannot select empty server draft`, () => {
    const h = harness({ stage: 'alias-F' })
    const out = h.r.resolveSession({ epoch: 0, session: { ...h.remote, ...bad } })
    assert.equal(out.facts.sourceReady, false)
    assert.notEqual(out.projection.description, '')
    assert.equal(h.writes.length, 0)
  })
test('epoch invalidation during proof stops later storage reads and all writes', () => {
  const h = harness({ stage: 'missing' })
  h.r.inspect({ epoch: 0 })
  const reads = []
  h.control.get = (k) => {
    reads.push(k)
    if (k === 'unsettled:template:free') h.control.epoch++
  }
  const out = h.r.resolveSession({ epoch: 0, session: h.remote })
  assert.equal(out.facts.sourceReady, false)
  assert.equal(reads.at(-1), 'unsettled:template:free')
  assert.equal(h.writes.length, 0)
})
for (const mode of ['free', 'effect'])
  for (const canonical of [true, false])
    for (const window of [
      'source-set',
      'source-ack',
      'source-readback',
      'alias-set',
      'alias-ack',
      'alias-readback',
      'clear-set',
      'clear-ack',
      'clear-readback',
    ])
      test(`${mode} ${
        canonical ? 'canonical' : 'template'
      } ${window} cold reopen preserves original ID and clear-last`, () => {
        const h = harness({ mode, canonical, stage: 'source-F' })
        h.map.delete('session:4')
        h.r.inspect({ epoch: 0 })
        if (canonical) h.r.resolveSession({ epoch: 0, session: h.remote })
        const key = window.startsWith('source')
          ? h.source
          : window.startsWith('alias')
          ? 'session:4'
          : h.record.recoveryKey
        let interrupted = false,
          afterSet = false
        h.control.set = (k, v) => {
          if (k !== key || interrupted) return
          afterSet = true
          if (window.endsWith('set')) {
            interrupted = true
            throw Error('before write')
          }
          if (window.endsWith('ack')) {
            interrupted = true
            h.map.set(k, clone(v))
            throw Error('lost ACK')
          }
        }
        h.control.get = (k) => {
          if (k === key && afterSet && !interrupted && window.endsWith('readback')) {
            interrupted = true
            throw Error('readback')
          }
        }
        const outcome = h.r.settleSession({ epoch: 0, receipt: h.remote })
        assert.equal(interrupted, true)
        assert.notEqual(outcome.status, 'saved')
        if (canonical) assert.equal(outcome.projection.sessionId, 4)
        const second = harness({ mode, canonical, saved: h.map })
        second.r.inspect({ epoch: 0 })
        if (canonical) second.r.resolveSession({ epoch: 0, session: h.remote })
        if (h.map.get(h.record.recoveryKey) !== null) {
          assert.deepEqual(clone(second.r.readFrozen({ epoch: 0 }).record?.sessionRequest), h.record.sessionRequest)
          assert.equal(second.writes.length, 0)
          assert.equal(second.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'saved')
          assert.equal(second.writes.at(-1), h.record.recoveryKey)
        } else assert.equal(second.r.getFacts().frozen, 'none')
        assert.deepEqual(h.map.get(h.source), clone(h.desired))
        assert.deepEqual(h.map.get('session:4'), clone(h.desired))
        assert.equal(h.map.get(h.record.recoveryKey), null)
      })
for (const key of ['template:free', 'session:4', 'unsettled:template:free'])
  test(`known creation same-instance lost ACK at ${key} remains explicitly replayable`, () => {
    const h = harness({ stage: 'source-F' })
    h.map.delete('session:4')
    h.r.resolveSession({ epoch: 0, session: h.remote })
    let thrown = false
    h.control.set = (k, v) => {
      if (!thrown && key === k) {
        thrown = true
        h.map.set(k, clone(v))
        throw Error('lost ACK')
      }
    }
    assert.notEqual(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'saved')
    assert.equal(thrown, true)
    assert.deepEqual(clone(h.r.readFrozen({ epoch: 0 }).record?.sessionRequest), h.record.sessionRequest)
    assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'saved')
    assert.equal(h.map.get(h.record.recoveryKey), null)
  })
test('a malformed active journal stays active beside a proven F and is not cleaned up', () => {
  const h = harness()
  h.map.set('initial-input:session:4', { invalid: true })
  const result = h.r.resolveSession({ epoch: 0, session: h.remote })
  assert.equal(result.facts.activeIntent, true)
  assert.equal(result.facts.frozen, 'valid')
  assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'blocked')
  assert.equal(h.writes.length, 0)
})
test('GET that invalidates prior origin pin cannot leave stale readFrozen admission', () => {
  const h = harness()
  h.r.resolveSession({ epoch: 0, session: h.remote })
  h.r.resolveSession({ epoch: 0, session: { ...h.remote, templateId: 8 } })
  assert.equal(h.r.readFrozen({ epoch: 0 }).status, 'blocked')
  assert.equal(h.writes.length, 0)
})
for (const mode of ['free', 'effect'])
  for (const suffix of ['', ':entry'])
    test(`${mode} explicit opaque${suffix} exact origin is caller-nominated`, () => {
      const sourceKey = `owner:1:free${suffix ? `:entry:${mode}:1:2` : ''}`
      const h = harness({ mode, sourceKey })
      assert.equal(h.r.resolveSession({ epoch: 0, session: h.remote }).facts.frozen, 'valid')
      assert.equal(h.writes.length, 0)
    })
for (const stage of ['absent', 'base', 'base-null'])
  test(`canonical source ${stage} can settle only exact derived base`, () => {
    const h = harness()
    if (stage === 'absent') h.map.delete(h.source)
    else
      h.map.set(h.source, {
        ...h.record,
        sessionRequest: null,
        ...(stage === 'base-null' ? { carryBackSourceTaskId: null } : {}),
      })
    assert.equal(h.r.resolveSession({ epoch: 0, session: h.remote }).facts.frozen, 'valid')
    assert.equal(h.writes.length, 0)
    assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'saved')
  })
for (const key of ['template:free', 'session:4', 'unsettled:template:free'])
  test(`synchronous edit from ${key} settlement read stops writes and retains overlay`, () => {
    const h = harness()
    h.r.resolveSession({ epoch: 0, session: h.remote })
    let changed = false
    h.control.get = (k) => {
      if (k === key && !changed) {
        changed = true
        h.r.noteEdit({ epoch: 0, patch: { description: 'reentrant input' } })
      }
    }
    assert.equal(h.r.settleSession({ epoch: 0, receipt: h.remote }).status, 'blocked')
    assert.equal(h.r.project().description, 'reentrant input')
    assert.equal(h.writes.length, 0)
    assert.notEqual(h.map.get(h.record.recoveryKey), null)
  })
for (const operation of ['generate', 'regenerate'])
  test(`canonical ${operation} F remains offline independently confirmable without GET`, () => {
    const h = harness()
    const submission = {
      protocol: 2,
      sessionId: 4,
      sourceArtifactId: operation === 'generate' ? null : 8,
      path: operation === 'generate' ? '/generations' : '/artifacts/8/regenerations',
      templateVersionId: 2,
      costCredits: 3,
      body:
        operation === 'generate'
          ? {
              sessionId: 4,
              input: { description: 'old body', userNotes: '', inputMediaIds: [] },
              clientRequestId: 'original-generation',
              quoteToken: 'q',
            }
          : { clientRequestId: 'original-regeneration', quoteToken: 'q' },
    }
    const record = { ...h.record, sessionId: 4, sessionRequest: null, submission, recoveryKey: 'unsettled:session:4' }
    h.map.set('session:4', clone(record))
    h.map.set('unsettled:session:4', { protocol: 2, draftKey: 'session:4', record: clone(record) })
    assert.equal(h.r.inspect({ epoch: 0 }).facts.frozen, 'valid')
    assert.deepEqual(clone(h.r.readFrozen({ epoch: 0 }).record), record)
    assert.equal(h.writes.length, 0)
  })
for (const operation of ['generate', 'regenerate'])
  test(`own ${operation} envelope with ordinary target takes priority over unrelated shared creation F offline`, () => {
    const h = harness()
    const submission = {
      protocol: 2,
      sessionId: 4,
      sourceArtifactId: operation === 'generate' ? null : 8,
      path: operation === 'generate' ? '/generations' : '/artifacts/8/regenerations',
      templateVersionId: 2,
      costCredits: 3,
      body:
        operation === 'generate'
          ? {
              sessionId: 4,
              input: { description: 'old body', userNotes: '', inputMediaIds: [] },
              clientRequestId: 'generation',
              quoteToken: 'q',
            }
          : { clientRequestId: 'regeneration', quoteToken: 'q' },
    }
    const record = {
      ...h.record,
      description: 'generation original',
      sessionId: 4,
      sessionRequest: null,
      submission,
      recoveryKey: 'unsettled:session:4',
    }
    h.map.set('session:4', { ...clone(record), submission: null })
    h.map.set('unsettled:session:4', { protocol: 2, draftKey: 'session:4', record: clone(record) })
    assert.equal(h.r.inspect({ epoch: 0 }).facts.frozen, 'valid')
    assert.deepEqual(clone(h.r.readFrozen({ epoch: 0 }).record), record)
    assert.equal(h.writes.length, 0)
  })
test('shared generation F bound to another session does not become this canonical source', () => {
  const h = harness()
  const record = {
    ...h.record,
    description: 'other session',
    sessionId: 99,
    sessionRequest: null,
    submission: {
      protocol: 2,
      path: '/generations',
      sessionId: 99,
      sourceArtifactId: null,
      templateVersionId: 2,
      costCredits: 3,
      body: {
        sessionId: 99,
        input: { description: 'other', userNotes: '', inputMediaIds: [] },
        clientRequestId: 'other',
        quoteToken: 'q',
      },
    },
  }
  h.map.set(h.source, clone(record))
  h.map.set(h.recoveryKey || h.record.recoveryKey, { protocol: 2, draftKey: h.source, record: clone(record) })
  const out = h.r.resolveSession({ epoch: 0, session: h.remote })
  assert.equal(out.projection.sessionId, 4)
  assert.equal(out.projection.description, 'local original')
  assert.equal(out.facts.frozen, 'none')
  assert.equal(h.writes.length, 0)
})
for (const mode of ['free', 'effect'])
  for (const replacement of ['null', 'absent', 'generation'])
    test(`P1 ${mode} held creation envelope becoming ${replacement} stays protected before ordinary fallback`, () => {
      const h = harness({ mode })
      const before = h.r.inspect({ epoch: 0 })
      assert.equal(before.facts.creationPending, true)
      if (replacement === 'absent') h.map.delete(h.record.recoveryKey)
      else if (replacement === 'null') h.map.set(h.record.recoveryKey, null)
      else {
        const record = {
          ...h.record,
          sessionId: 99,
          sessionRequest: null,
          submission: {
            protocol: 2,
            path: '/generations',
            sessionId: 99,
            sourceArtifactId: null,
            templateVersionId: 2,
            costCredits: 3,
            body: {
              sessionId: 99,
              input: { description: 'other', userNotes: '', inputMediaIds: [] },
              clientRequestId: 'other',
              quoteToken: 'q',
            },
          },
        }
        h.map.set(h.record.recoveryKey, { protocol: 2, draftKey: h.source, record })
      }
      const saved = JSON.stringify([...h.map])
      const after = h.r.resolveSession({ epoch: 0, session: h.remote })
      assert.equal(after.facts.sourceReady, false)
      for (const operation of ['normal-save', 'upload', 'quote'])
        assert.equal(h.r.admit({ epoch: 0, operation }).status, 'blocked')
      h.r.noteEdit({ epoch: 0, patch: { description: 'visible unsaved' } })
      assert.equal(
        h.r.saveNormal({ epoch: 0, record: { ...h.desired, description: 'visible unsaved' } }).status,
        'blocked'
      )
      assert.equal(h.r.project().description, 'visible unsaved')
      assert.equal(h.writes.length, 0)
      assert.equal(JSON.stringify([...h.map]), saved)
      const cold = harness({ mode, saved: h.map })
      const reopened = cold.r.resolveSession({ epoch: 0, session: h.remote })
      assert.equal(reopened.facts.sourceReady, true)
      assert.equal(reopened.facts.creationPending, false)
      assert.equal(cold.r.admit({ epoch: 0, operation: 'quote' }).status, 'ready')
      assert.equal(cold.writes.length, 0)
    })
for (const mode of ['free', 'effect'])
  for (const ownEnvelope of [null, undefined])
    test(`P2 ${mode} complete own ordinary with own F ${String(
      ownEnvelope
    )} is independent of unrelated shared creation`, () => {
      const h = harness({ mode })
      const own = { ...clone(h.desired), description: 'independent canonical', recoveryKey: 'unsettled:session:4' }
      h.map.set('session:4', own)
      h.map.set('unsettled:session:4', ownEnvelope)
      const other = {
        ...clone(h.record),
        description: 'other creation',
        sessionRequest: { ...h.record.sessionRequest, clientRequestId: 'different-create' },
      }
      h.map.set(h.source, other)
      h.map.set(h.record.recoveryKey, { protocol: 2, draftKey: h.source, record: other })
      const saved = JSON.stringify([...h.map]),
        reads = []
      h.control.get = (key) => reads.push(key)
      const out = h.r.resolveSession({ epoch: 0, session: h.remote })
      assert.equal(out.facts.sourceReady, true)
      assert.equal(out.facts.creationPending, false)
      assert.equal(out.projection.description, own.description)
      assert.equal(out.facts.frozen, 'none')
      assert.equal(h.r.admit({ epoch: 0, operation: 'quote' }).status, 'ready')
      assert.equal(reads.includes(h.record.recoveryKey), false)
      assert.equal(reads.includes(h.source), false)
      assert.equal(JSON.stringify([...h.map]), saved)
      assert.equal(h.writes.length, 0)
    })
for (const stage of ['missing', 'both', 'alias-F'])
  test(`P2 negative ${stage}: shared-family alias never substitutes same desired for literal nonce proof`, () => {
    const h = harness({ stage })
    const out = h.r.resolveSession({ epoch: 0, session: { ...h.remote, creationClientRequestId: ' F2 ' } })
    assert.equal(out.facts.sourceReady, false)
    assert.equal(h.r.admit({ epoch: 0, operation: 'quote' }).status, 'blocked')
    assert.equal(h.writes.length, 0)
  })
test('P1 held creation F disappearance cannot be bypassed by a newly appearing own-session generation F', () => {
  const h = harness()
  assert.equal(h.r.inspect({ epoch: 0 }).facts.creationPending, true)
  h.map.set(h.record.recoveryKey, null)
  const record = {
    ...clone(h.desired),
    recoveryKey: 'unsettled:session:4',
    submission: {
      protocol: 2,
      path: '/generations',
      sessionId: 4,
      sourceArtifactId: null,
      templateVersionId: 2,
      costCredits: 3,
      body: {
        sessionId: 4,
        input: { description: 'different request', userNotes: '', inputMediaIds: [] },
        clientRequestId: 'different',
        quoteToken: 'q',
      },
    },
  }
  h.map.set('session:4', clone(record))
  h.map.set('unsettled:session:4', { protocol: 2, draftKey: 'session:4', record })
  const out = h.r.resolveSession({ epoch: 0, session: h.remote })
  assert.equal(out.facts.sourceReady, false)
  assert.equal(h.r.readFrozen({ epoch: 0 }).status, 'blocked')
  assert.equal(h.writes.length, 0)
})
