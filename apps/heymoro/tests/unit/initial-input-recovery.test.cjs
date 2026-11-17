const test = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const entry = {
  key: 'template:free',
  kind: 'template',
  mode: 'free',
  templateId: null,
  templateVersionId: null,
  sessionId: null
}
const record = {
  protocol: 2,
  mode: 'free',
  templateId: 1,
  templateVersionId: 2,
  sessionId: null,
  description: 'old',
  userNotes: 'untouched',
  photos: [{ id: 'a', status: 'ready', mediaId: 7, path: '' }],
  sessionRequest: null,
  submission: null,
  draftPaused: false,
  recoveryKey: 'unsettled:template:free'
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
function harness(seed = []) {
  const saved = new Map(seed)
  const writes = []
  const control = { get: () => {}, set: () => {}, interested: true, epoch: 0 }
  const { createInitialInputRecovery } = load('src/features/creation/initial-input-recovery.js')
  const r = createInitialInputRecovery({
    entry,
    storage: {
      listKeys: ({ prefix }) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
      get: (k) => {
        control.get(k)
        return clone(saved.get(k))
      },
      set: (k, v) => {
        control.set(k, v)
        writes.push(k)
        saved.set(k, clone(v))
      }
    },
    isInterested: ({ epoch }) => control.interested && epoch === control.epoch
  })
  return { r, saved, writes, control }
}
test('source helper canonical role and explicit empty overlay', () => {
  const { resolveEntrySource, overlayInitialFields } = load('src/features/creation/entry-load.js')
  const a = { ...record, sessionId: 4 }
  const b = { ...a, description: 'canonical' }
  const out = resolveEntrySource({
    entry,
    binding: null,
    candidates: [
      { key: entry.key, value: a },
      { key: 'session:4', value: b }
    ]
  })
  assert.equal(out.base.description, 'canonical')
  assert.equal(out.primaryKey, 'session:4')
  const merged = overlayInitialFields({ base: record, patch: { description: '' } })
  assert.equal(merged.description, '')
  assert.equal(merged.photos[0].mediaId, 7)
  assert.equal(Object.hasOwn(merged, 'carryBackSourceTaskId'), false)
})
test('adapter callback cancellation and opaque thrown values', () => {
  const { createDraftStorage } = load('src/features/creation/draft-storage.js')
  let interested = true
  let sets = 0
  const s = createDraftStorage({
    isInterested: () => interested,
    storage: {
      get: () => {
        interested = false
        return undefined
      },
      set: () => sets++
    }
  })
  assert.equal(
    s.compareAndSet({ epoch: 0, key: 'a', expected: { kind: 'absent' }, desired: null }).status,
    'cancelled'
  )
  assert.equal(sets, 0)
  const thrown = new Proxy(
    {},
    {
      get: () => {
        throw Error('read unknown error')
      }
    }
  )
  const t = createDraftStorage({
    isInterested: () => true,
    storage: {
      get: () => {
        throw thrown
      }
    }
  })
  assert.equal(t.read({ epoch: 0, key: 'a' }).status, 'failed')
})
test('pending actual mask, GET is read only, explicit replay retains full source', () => {
  const h = harness()
  h.r.inspect({ epoch: 0 })
  h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
  assert.deepEqual(Object.keys(h.saved.get('initial-input:template:free').patch), ['description'])
  h.saved.set('template:free:entry:free:1:2', clone(record))
  const n = h.writes.length
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  assert.equal(h.writes.length, n)
  assert.equal(h.r.project({}).photos.length, 1)
  assert.equal(h.r.getFacts().activeIntent, true)
  const out = h.r.resumeLocal({ epoch: 0 })
  assert.equal(out.status, 'saved')
  assert.equal(h.saved.get('template:free:entry:free:1:2').description, 'new')
  assert.equal(h.saved.get('initial-input:template:free'), null)
})
test('foreign first setter never writes unknown primary', () => {
  const raw = { foreign: true }
  const h = harness([[entry.key, raw]])
  h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.saved.get(entry.key), raw)
})
for (const extra of [{ templateVersionId: 3 }, { templateId: 9 }])
  test(`alias full binding mismatch ${JSON.stringify(extra)}`, () => {
    const { resolveEntrySource } = load('src/features/creation/entry-load.js')
    const reference = { ...record, sessionId: 4 }
    const out = resolveEntrySource({
      entry,
      binding: null,
      candidates: [
        { key: entry.key, value: reference },
        { key: 'session:4', value: { ...reference, ...extra } }
      ]
    })
    assert.equal(out.status, 'conflict')
  })
test('E3 third value at captured absent target is never adopted as write permission', () => {
  const { fingerprintInitialInputValue } = load('src/features/creation/initial-input-intent.js')
  const mirror = { ...record, sessionId: 4, description: 'mirror' }
  const canonical = { ...mirror, description: 'canonical' }
  const pending = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'new' },
    observed: [
      { key: entry.key, fingerprint: fingerprintInitialInputValue({ value: mirror }).value }
    ],
    prepared: null
  }
  const h = harness([
    [entry.key, mirror],
    ['session:4', canonical],
    ['initial-input:template:free', pending]
  ])
  h.r.inspect({ epoch: 0 })
  const bound = `${entry.key}:entry:free:1:2`
  const third = { third: true }
  h.saved.set(bound, third)
  h.r.resumeLocal({ epoch: 0 })
  assert.deepEqual(h.saved.get(bound), third)
  assert.equal(h.saved.get('session:4').description, 'canonical')
})
test('E3 newly occupied recovery envelope blocks new frozen write', () => {
  const h = harness([[entry.key, record]])
  h.r.inspect({ epoch: 0 })
  const foreign = { third: true }
  h.saved.set('unsettled:template:free', foreign)
  const out = h.r.saveNormal({
    epoch: 0,
    record: {
      ...record,
      sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'new' }
    }
  })
  assert.notEqual(out.status, 'saved')
  assert.deepEqual(h.saved.get('unsettled:template:free'), foreign)
})

test('E3 accepted pending then throw is adopted only through explicit retry', () => {
  const h = harness()
  h.control.set = (key, value) => {
    h.saved.set(key, clone(value))
    throw Error('accepted')
  }
  h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
  h.control.set = () => {}
  h.saved.set('template:free:entry:free:1:2', clone(record))
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  const out = h.r.resumeLocal({ epoch: 0 })
  assert.equal(out.status, 'saved')
  assert.equal(h.saved.get('template:free:entry:free:1:2').description, 'new')
  assert.equal(h.saved.get('initial-input:template:free'), null)
})
test('E3 reentrant newest overlay is not acknowledged as old desired', () => {
  const h = harness()
  h.r.noteEdit({ epoch: 0, patch: { description: 'first' } })
  h.saved.set('template:free:entry:free:1:2', clone(record))
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  let changed = false
  h.control.set = (key) => {
    if (!changed && key === 'template:free:entry:free:1:2') {
      changed = true
      h.r.noteEdit({ epoch: 0, patch: { description: 'newest' } })
    }
  }
  h.r.resumeLocal({ epoch: 0 })
  assert.equal(h.r.project({}).description, 'newest')
  assert.ok(
    h.r.getFacts().hasUnsavedOverlay ||
      h.saved.get('template:free:entry:free:1:2').description === 'newest'
  )
})

test('E3-14 malformed initial journal does not conceal independently valid frozen authority', () => {
  const frozenRecord = {
    ...record,
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'original' }
  }
  const h = harness([
    [entry.key, frozenRecord],
    ['initial-input:template:free', { private: 'unknown' }],
    ['unsettled:template:free', { protocol: 2, draftKey: entry.key, record: frozenRecord }]
  ])
  h.r.inspect({ epoch: 0 })
  assert.equal(h.r.getFacts().activeIntent, true)
  assert.equal(h.r.getFacts().frozen, 'valid')
  assert.equal(h.r.readFrozen({ epoch: 0 }).record.sessionRequest.clientRequestId, 'original')
  assert.equal(h.writes.length, 0)
})
for (const stage of ['pending', 'prepared', 'target', 'cleanup'])
  for (const fault of ['reject', 'accepted-throw', 'readback-throw'])
    test(`E3-03/04/06/07 ${stage} ${fault} explicitly retries exact journal`, () => {
      const h = harness()
      if (stage !== 'pending') h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
      h.saved.set('template:free:entry:free:1:2', clone(record))
      if (stage !== 'pending')
        h.r.resolveConfiguration({
          epoch: 0,
          config: { mode: 'free', templateId: 1, templateVersionId: 2 }
        })
      let fired = false
      let readback = null
      const match = (key, value) =>
        stage === 'pending'
          ? key.startsWith('initial-input:') && value?.prepared === null
          : stage === 'prepared'
          ? key.startsWith('initial-input:') && !!value?.prepared
          : stage === 'cleanup'
          ? key.startsWith('initial-input:') && value === null
          : key === 'template:free:entry:free:1:2'
      h.control.set = (key, value) => {
        if (fired || !match(key, value)) return
        fired = true
        if (fault === 'reject') throw Error('reject')
        if (fault === 'accepted-throw') {
          h.saved.set(key, clone(value))
          throw Error('accepted')
        }
        readback = key
      }
      h.control.get = (key) => {
        if (readback === key) {
          readback = null
          throw Error('readback')
        }
      }
      const first =
        stage === 'pending'
          ? h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
          : h.r.resumeLocal({ epoch: 0 })
      assert.equal(fired, true)
      assert.notEqual(first.status, 'saved')
      if (stage !== 'cleanup') assert.notEqual(h.saved.get('initial-input:template:free'), null)
      h.control.get = () => {}
      h.control.set = () => {}
      if (stage === 'pending')
        h.r.resolveConfiguration({
          epoch: 0,
          config: { mode: 'free', templateId: 1, templateVersionId: 2 }
        })
      const out = h.r.resumeLocal({ epoch: 0 })
      assert.equal(out.status, 'saved')
      assert.equal(h.saved.get('template:free:entry:free:1:2').description, 'new')
      assert.equal(h.saved.get('initial-input:template:free'), null)
    })
for (const invalidation of ['hide', 'hide-show', 'dispose', 'account'])
  for (let stop = 1; stop <= 18; stop++)
    test(`E3-11 ${invalidation} at local drain callback ${stop} stops next callback`, () => {
      const h = harness()
      h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
      h.saved.set('template:free:entry:free:1:2', clone(record))
      h.r.resolveConfiguration({
        epoch: 0,
        config: { mode: 'free', templateId: 1, templateVersionId: 2 }
      })
      let calls = 0
      const boundary = () => {
        if (++calls === stop) {
          if (invalidation === 'hide-show') h.control.epoch++
          else h.control.interested = false
        }
      }
      h.control.get = boundary
      h.control.set = boundary
      const out = h.r.resumeLocal({ epoch: 0 })
      assert.equal(calls, stop, 'the named invalidation callback must actually execute')
      assert.notEqual(out.status, 'saved')
    })
test('E3-05 immutable third observation after target write prevents cleanup', () => {
  const h = harness()
  h.r.noteEdit({ epoch: 0, patch: { description: 'new' } })
  h.saved.set('template:free:entry:free:1:2', clone(record))
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  const third = { foreign: true }
  h.control.set = (key) => {
    if (key === 'template:free:entry:free:1:2') h.saved.set(entry.key, third)
  }
  const out = h.r.resumeLocal({ epoch: 0 })
  assert.notEqual(out.status, 'saved')
  assert.deepEqual(h.saved.get(entry.key), third)
  assert.ok(h.saved.get('initial-input:template:free').prepared)
})

for (const left of ['expected', 'desired'])
  for (const right of ['expected', 'desired'])
    test(`E3-05/E3-06 two-target reopened ${left}/${right} replay keeps exact old desired`, () => {
      const core = load('src/features/creation/initial-input-intent.js')
      const base = { ...record, sessionId: 4 }
      const binding = { mode: 'free', templateId: 1, templateVersionId: 2, sessionId: 4 }
      const desired = { ...base, description: 'new' }
      const fingerprint = core.fingerprintInitialInputValue({ value: base }).value
      const pending = {
        protocol: 1,
        kind: 'ordinary-initial-input',
        entry,
        fields: ['description'],
        patch: { description: 'new' },
        observed: [{ key: entry.key, fingerprint }],
        prepared: null
      }
      const current = [
        { key: 'session:4', fingerprint },
        { key: entry.key, fingerprint }
      ].sort((a, b) => a.key.localeCompare(b.key))
      const proposal = {
        binding,
        primaryKey: entry.key,
        source: { kind: 'local', key: entry.key, fingerprint },
        targets: current.map((o) => ({ key: o.key, expected: fingerprint, desired }))
      }
      const prepared = core.prepareInitialInputIntent({
        context: { entry, binding },
        pending,
        proposal,
        currentJournal: core.fingerprintInitialInputValue({ value: pending }).value,
        current
      })
      assert.equal(prepared.ok, true)
      const seed = [
        [entry.key, clone(left === 'expected' ? base : desired)],
        ['session:4', clone(right === 'expected' ? base : desired)],
        ['initial-input:template:free', clone(prepared.value.intent)]
      ]
      const h = harness(seed)
      h.r.inspect({ epoch: 0 })
      assert.equal(h.r.resumeLocal({ epoch: 0 }).status, 'saved')
      assert.equal(h.saved.get(entry.key).description, 'new')
      assert.equal(h.saved.get('session:4').description, 'new')
      assert.equal(h.saved.get('initial-input:template:free'), null)
    })
test('E3-10 raw journal cannot nominate an arbitrary storage key or leak its data', () => {
  const raw = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'private' },
    observed: [],
    prepared: {
      primaryKey: 'arbitrary',
      binding: { mode: 'free', templateId: 1, templateVersionId: 2, sessionId: null }
    }
  }
  const h = harness([
    [entry.key, record],
    ['initial-input:template:free', raw]
  ])
  h.r.inspect({ epoch: 0 })
  h.r.noteEdit({ epoch: 0, patch: { description: 'visible' } })
  h.r.resumeLocal({ epoch: 0 })
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.saved.get('initial-input:template:free'), raw)
  assert.doesNotMatch(h.r.getFacts().message, /private|arbitrary/)
  assert.equal(h.r.admit({ epoch: 0, operation: 'new-submission' }).status, 'blocked')
})

for (const mutation of ['timestamp', 'input', 'missing'])
  test(`E3-09 prepared server anchor ${mutation} blocks every target`, () => {
    const core = load('src/features/creation/initial-input-intent.js')
    const sessionEntry = {
      key: 'session:4',
      kind: 'session',
      mode: null,
      templateId: null,
      templateVersionId: null,
      sessionId: 4
    }
    const saved = new Map()
    const { createInitialInputRecovery } = load('src/features/creation/initial-input-recovery.js')
    let stopPrepared = true
    const writes = []
    const storage = {
      get: (key) => clone(saved.get(key)),
      set: (key, value) => {
        writes.push(key)
        saved.set(key, clone(value))
        if (stopPrepared && value?.prepared) {
          stopPrepared = false
          throw Error('accepted prepared')
        }
      }
    }
    const r = createInitialInputRecovery({ entry: sessionEntry, storage, isInterested: () => true })
    r.noteEdit({ epoch: 0, patch: { description: 'new' } })
    const session = {
      id: 4,
      mode: 'free',
      templateId: 1,
      templateVersionId: 2,
      draft: {
        input: { description: 'old', userNotes: 'untouched', inputMediaIds: [7, 8] },
        updatedAt: '2026-11-13T00:00:00Z'
      }
    }
    r.resolveSession({ epoch: 0, session })
    const firstAction = r.beginLocalResume({ epoch: 0 })
    r.resumeLocal({ epoch: 0, ticket: firstAction.ticket, session })
    assert.ok(saved.get('initial-input:session:4').prepared)
    const changed = clone(session)
    if (mutation === 'timestamp') changed.draft.updatedAt = '2026-11-14T00:00:00Z'
    if (mutation === 'input') changed.draft.input.inputMediaIds = [9]
    if (mutation === 'missing') delete changed.draft.updatedAt
    r.resolveSession({ epoch: 0, session: changed })
    const count = writes.length
    const nextAction = r.beginLocalResume({ epoch: 0 })
    const out = r.resumeLocal({ epoch: 0, ticket: nextAction.ticket, session: changed })
    assert.notEqual(out.status, 'saved')
    assert.equal(saved.has('session:4'), false)
    assert.equal(writes.length, count)
    assert.equal(
      core.fingerprintInitialInputValue({ value: saved.get('initial-input:session:4') }).ok,
      true
    )
  })

for (const patch of [{ description: '' }, { photos: [], carryBackSourceTaskId: null }])
  test(`E3-08 edit after prepared failure retains newest explicit ${Object.keys(patch).join(
    '/'
  )}`, () => {
    const h = harness()
    h.r.noteEdit({ epoch: 0, patch: { description: 'first' } })
    h.saved.set('template:free:entry:free:1:2', clone(record))
    h.r.resolveConfiguration({
      epoch: 0,
      config: { mode: 'free', templateId: 1, templateVersionId: 2 }
    })
    h.control.set = (key) => {
      if (key === 'template:free:entry:free:1:2') throw Error('target failure')
    }
    h.r.resumeLocal({ epoch: 0 })
    assert.ok(h.saved.get('initial-input:template:free').prepared)
    h.control.set = () => {}
    h.r.noteEdit({ epoch: 0, patch })
    const visible = h.r.project({})
    for (const key of Object.keys(patch)) assert.deepEqual(clone(visible[key]), patch[key])
    assert.ok(
      h.r.getFacts().hasUnsavedOverlay ||
        Object.keys(patch).every(
          (key) =>
            JSON.stringify(h.saved.get('template:free:entry:free:1:2')[key]) ===
            JSON.stringify(patch[key])
        )
    )
    h.r.resumeLocal({ epoch: 0 })
    for (const key of Object.keys(patch))
      assert.deepEqual(h.saved.get('template:free:entry:free:1:2')[key], patch[key])
  })

for (const occupiedBound of [false, true])
  test(`E3-20 active template journal with stale mirror and ${
    occupiedBound ? 'unsafe' : 'absent'
  } bound`, () => {
    const core = load('src/features/creation/initial-input-intent.js')
    const mirror = { ...record, sessionId: 4, description: 'stale mirror' }
    const canonical = {
      ...mirror,
      description: 'canonical',
      photos: [{ id: 'b', status: 'ready', mediaId: 8, path: '' }]
    }
    const pending = {
      protocol: 1,
      kind: 'ordinary-initial-input',
      entry,
      fields: ['description'],
      patch: { description: 'latest' },
      observed: [
        { key: entry.key, fingerprint: core.fingerprintInitialInputValue({ value: mirror }).value }
      ],
      prepared: null
    }
    const bound = `${entry.key}:entry:free:1:2`
    const seed = [
      [entry.key, mirror],
      ['session:4', canonical],
      ['initial-input:template:free', pending]
    ]
    if (occupiedBound) seed.push([bound, { foreign: true }])
    const h = harness(seed)
    h.r.inspect({ epoch: 0 })
    const before = JSON.stringify([...h.saved])
    const out = h.r.resumeLocal({ epoch: 0 })
    if (occupiedBound) {
      assert.notEqual(out.status, 'saved')
      assert.equal(JSON.stringify([...h.saved]), before)
      assert.equal(h.writes.length, 0)
    } else {
      assert.equal(out.status, 'saved')
      assert.deepEqual(h.saved.get(entry.key), mirror)
      assert.equal(h.saved.get(bound).description, 'latest')
      assert.equal(h.saved.get(bound).photos[0].mediaId, 8)
      assert.equal(h.saved.get('session:4').description, 'latest')
      h.saved.set(entry.key, { ...mirror, sessionId: 5 })
      const next = { ...h.saved.get('session:4'), description: 'normal pinned' }
      assert.equal(h.r.saveNormal({ epoch: 0, record: next }).status, 'saved')
      assert.equal(h.saved.get('session:4').description, 'normal pinned')
      assert.equal(h.saved.get(entry.key).sessionId, 5)
    }
  })

for (const origin of ['generic', 'bound'])
  for (const stage of ['primary', 'alias', 'clear'])
    test(`E3-22 ${origin} frozen ${stage} readback failure reopens exact settlement`, () => {
      const primary = origin === 'generic' ? entry.key : `${entry.key}:entry:free:1:2`
      const body = {
        sessionId: 4,
        input: { description: 'immutable', userNotes: '', inputMediaIds: [7] },
        clientRequestId: 'frozen',
        quoteToken: 'q'
      }
      const submission = {
        protocol: 2,
        path: '/generations',
        sessionId: 4,
        sourceArtifactId: null,
        templateVersionId: 2,
        costCredits: 3,
        body
      }
      const raw = { ...record, sessionId: 4, submission }
      const desired = { ...raw, submission: null }
      const h = harness([
        [primary, clone(raw)],
        ['session:4', clone(raw)],
        ['unsettled:template:free', { protocol: 2, draftKey: primary, record: clone(raw) }]
      ])
      h.r.inspect({ epoch: 0 })
      let failed = false
      let readback = null
      h.control.set = (key, value) => {
        if (key === 'unsettled:template:free' && value === null) {
          assert.equal(h.saved.get(primary).submission, null)
          assert.equal(h.saved.get('session:4').submission, null)
        }
        const target =
          stage === 'primary'
            ? primary
            : stage === 'alias'
            ? 'session:4'
            : 'unsettled:template:free'
        if (!failed && key === target) {
          failed = true
          readback = key
        }
      }
      h.control.get = (key) => {
        if (readback === key) {
          readback = null
          throw Error('readback failed')
        }
      }
      assert.notEqual(h.r.settleSubmission({ epoch: 0, record: desired }).status, 'saved')
      assert.equal(failed, true)
      const reopened = harness([...h.saved])
      reopened.r.inspect({ epoch: 0 })
      reopened.r.resolveConfiguration({
        epoch: 0,
        config: { mode: 'free', templateId: 1, templateVersionId: 2 }
      })
      assert.equal(reopened.r.settleSubmission({ epoch: 0, record: desired }).status, 'saved')
      assert.equal(reopened.saved.get(primary).submission, null)
      assert.equal(reopened.saved.get('session:4').submission, null)
      assert.equal(reopened.saved.get('unsettled:template:free'), null)
    })

for (const mutation of ['envelope-after-primary', 'primary-after-alias'])
  test(`E3-22 ${mutation} protects remaining target and frozen cleanup`, () => {
    const submission = {
      protocol: 2,
      path: '/generations',
      sessionId: 4,
      sourceArtifactId: null,
      templateVersionId: 2,
      costCredits: 3,
      body: {
        sessionId: 4,
        input: { description: 'immutable', userNotes: '', inputMediaIds: [7] },
        clientRequestId: 'original',
        quoteToken: 'q'
      }
    }
    const raw = { ...record, sessionId: 4, submission }
    const envelope = { protocol: 2, draftKey: entry.key, record: raw }
    const h = harness([
      [entry.key, clone(raw)],
      ['session:4', clone(raw)],
      ['unsettled:template:free', clone(envelope)]
    ])
    h.r.inspect({ epoch: 0 })
    const third = { foreign: true }
    h.control.set = (key, value) => {
      if (
        value?.submission === null &&
        ((mutation === 'envelope-after-primary' && key === entry.key) ||
          (mutation === 'primary-after-alias' && key === 'session:4'))
      )
        h.saved.set(
          mutation === 'envelope-after-primary' ? 'unsettled:template:free' : entry.key,
          third
        )
    }
    assert.notEqual(
      h.r.settleSubmission({ epoch: 0, record: { ...raw, submission: null } }).status,
      'saved'
    )
    if (mutation === 'envelope-after-primary') {
      assert.deepEqual(h.saved.get('session:4'), raw)
      assert.deepEqual(h.saved.get('unsettled:template:free'), third)
    } else {
      assert.deepEqual(h.saved.get(entry.key), third)
      assert.deepEqual(h.saved.get('unsettled:template:free'), envelope)
    }
  })

for (const fault of ['reject', 'accepted-throw', 'readback-third'])
  test(`E3-03 pending extension ${fault} preserves latest actual mask and exact unknown value`, () => {
    const h = harness()
    h.r.noteEdit({ epoch: 0, patch: { description: 'first' } })
    let armed = false
    const third = { foreign: 'do not overwrite' }
    h.control.set = (key, value) => {
      if (key !== 'initial-input:template:free') return
      if (fault === 'reject') throw Error('reject')
      if (fault === 'accepted-throw') {
        h.saved.set(key, clone(value))
        throw Error('accepted')
      }
      armed = true
    }
    h.control.get = (key) => {
      if (armed && key === 'initial-input:template:free') {
        armed = false
        h.saved.set(key, third)
      }
    }
    h.r.noteEdit({ epoch: 0, patch: { description: '', userNotes: 'latest notes' } })
    h.control.set = () => {}
    h.control.get = () => {}
    h.saved.set('template:free:entry:free:1:2', clone(record))
    h.r.resolveConfiguration({
      epoch: 0,
      config: { mode: 'free', templateId: 1, templateVersionId: 2 }
    })
    const writes = h.writes.length
    const out = h.r.resumeLocal({ epoch: 0 })
    if (fault === 'readback-third') {
      assert.notEqual(out.status, 'saved')
      assert.deepEqual(h.saved.get('initial-input:template:free'), third)
      assert.equal(h.writes.length, writes)
    } else {
      assert.equal(out.status, 'saved')
      assert.equal(h.saved.get('template:free:entry:free:1:2').description, '')
      assert.equal(h.saved.get('template:free:entry:free:1:2').userNotes, 'latest notes')
    }
  })
test('E3 unprepared close and reopen uses current trustworthy base without enriching journal on GET', () => {
  const h = harness()
  h.r.noteEdit({ epoch: 0, patch: { description: 'early' } })
  const bound = 'template:free:entry:free:1:2'
  h.saved.set(bound, clone(record))
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  const journal = JSON.stringify(h.saved.get('initial-input:template:free'))
  const changed = {
    ...record,
    userNotes: 'new current untouched',
    photos: [{ id: 'new', status: 'ready', mediaId: 8, path: '' }]
  }
  h.saved.set(bound, changed)
  const reopened = harness([...h.saved])
  reopened.r.inspect({ epoch: 0 })
  reopened.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  assert.equal(reopened.r.project({}).userNotes, 'new current untouched')
  assert.equal(reopened.r.project({}).photos[0].mediaId, 8)
  assert.equal(JSON.stringify(reopened.saved.get('initial-input:template:free')), journal)
  assert.equal(reopened.writes.length, 0)
  assert.equal(reopened.r.resumeLocal({ epoch: 0 }).status, 'saved')
  assert.equal(reopened.saved.get(bound).description, 'early')
  assert.equal(reopened.saved.get(bound).photos[0].mediaId, 8)
})

function serverRecoveryHarness(beforeFirstEdit = () => {}) {
  const entry = {
    key: 'session:4',
    kind: 'session',
    mode: null,
    templateId: null,
    templateVersionId: null,
    sessionId: 4
  }
  const saved = new Map(),
    writes = []
  const control = { get: () => {}, set: () => {} }
  const session = {
    id: 4,
    mode: 'free',
    templateId: 1,
    templateVersionId: 2,
    draft: {
      input: { description: 'old', userNotes: '', inputMediaIds: [7, 8] },
      updatedAt: '2026-11-13T00:00:00Z'
    }
  }
  const r = load('src/features/creation/initial-input-recovery.js').createInitialInputRecovery({
    entry,
    storage: {
      get: (key) => {
        control.get(key)
        return clone(saved.get(key))
      },
      set: (key, value) => {
        control.set(key, value)
        writes.push(key)
        saved.set(key, clone(value))
      }
    },
    isInterested: () => true
  })
  beforeFirstEdit({ saved, control })
  r.noteEdit({ epoch: 0, patch: { description: 'early' } })
  r.resolveSession({ epoch: 0, session })
  return { r, saved, writes, control, session }
}
for (const uncertainty of [
  'pending-reject',
  'prepared-reject',
  'target-accepted-throw',
  'cleanup-accepted-throw'
])
  test(`fresh server U needs-check ${uncertainty} is read-only and stage-exact`, () => {
    let fired = false
    const h = serverRecoveryHarness(
      uncertainty === 'pending-reject'
        ? ({ control }) => {
            control.set = (key) => {
              if (!fired && key === 'initial-input:session:4') {
                fired = true
                throw Error('pending reject')
              }
            }
          }
        : () => {}
    )
    if (uncertainty !== 'pending-reject') {
      h.control.set = (key, value) => {
        if (fired) return
        const match =
          uncertainty === 'prepared-reject'
            ? !!value?.prepared
            : uncertainty === 'target-accepted-throw'
            ? key === 'session:4'
            : key === 'initial-input:session:4' && value === null
        if (match) {
          fired = true
          if (uncertainty !== 'prepared-reject') h.saved.set(key, clone(value))
          throw Error('uncertain')
        }
      }
      const action = h.r.beginLocalResume({ epoch: 0 })
      assert.equal(action.needsServerSession, true)
      h.r.resumeLocal({ epoch: 0, ticket: action.ticket, session: h.session })
    }
    assert.equal(fired, true)
    h.control.set = () => {}
    const before = JSON.stringify([...h.saved]),
      writes = h.writes.length
    const action = h.r.beginLocalResume({ epoch: 0 })
    assert.equal(JSON.stringify([...h.saved]), before)
    assert.equal(h.writes.length, writes)
    assert.equal(
      action.needsServerSession,
      uncertainty === 'pending-reject' || uncertainty === 'prepared-reject'
    )
    assert.equal(
      h.r.resumeLocal({
        epoch: 0,
        ticket: action.ticket,
        session: action.needsServerSession ? h.session : undefined
      }).status,
      'saved'
    )
    assert.equal(h.saved.get('session:4').description, 'early')
    assert.equal(h.saved.get('initial-input:session:4'), null)
    let reads = 0
    h.control.get = () => reads++
    h.r.resumeLocal({ epoch: 0, ticket: action.ticket, session: h.session })
    assert.equal(reads, 0, 'reused ticket must not authorize another read/write')
  })
test('fresh server needs-check rejects getter-reentrant overlay before minting a ticket', () => {
  const h = serverRecoveryHarness()
  let fired = false
  h.control.get = () => {
    if (!fired) {
      fired = true
      h.r.noteEdit({ epoch: 0, patch: { description: 'newest' } })
    }
  }
  const before = JSON.stringify([...h.saved]),
    writes = h.writes.length
  const request = h.r.beginLocalResume({ epoch: 0 })
  assert.equal(fired, true)
  assert.equal(request.ticket, undefined)
  assert.equal(h.r.project({}).description, 'newest')
  assert.equal(JSON.stringify([...h.saved]), before)
  assert.equal(h.writes.length, writes)
})

for (const change of ['overlay', 'source', 'invalid-response', 'pending-base-change'])
  test(`fresh local ticket ${change} is single-use and cannot acknowledge an older source`, () => {
    const h = serverRecoveryHarness()
    const action = h.r.beginLocalResume({ epoch: 0 })
    const changed = {
      ...h.session,
      draft: {
        input: { description: 'changed', userNotes: '', inputMediaIds: [9] },
        updatedAt: '2026-11-14T00:00:00Z'
      }
    }
    if (change === 'overlay') h.r.noteEdit({ epoch: 0, patch: { description: 'newest' } })
    if (change === 'source') h.r.resolveSession({ epoch: 0, session: changed })
    const before = JSON.stringify([...h.saved]),
      writes = h.writes.length
    const out = h.r.resumeLocal({
      epoch: 0,
      ticket: action.ticket,
      session:
        change === 'invalid-response'
          ? null
          : change === 'pending-base-change'
          ? changed
          : h.session
    })
    assert.notEqual(out.status, 'saved')
    assert.equal(JSON.stringify([...h.saved]), before)
    assert.equal(h.writes.length, writes)
    let reads = 0
    h.control.get = () => reads++
    h.r.resumeLocal({ epoch: 0, ticket: action.ticket, session: h.session })
    assert.equal(reads, 0)
    if (change === 'overlay') assert.equal(h.r.project({}).description, 'newest')
    if (change === 'pending-base-change') assert.equal(h.r.project({}).photos[0].mediaId, 9)
  })

test('E2-07 divergent generic and bound ordinary sources without canonical role are preserved', () => {
  const bound = 'template:free:entry:free:1:2'
  const h = harness([
    [entry.key, clone(record)],
    [bound, { ...record, description: 'different bound input' }]
  ])
  h.r.inspect({ epoch: 0 })
  h.r.resolveConfiguration({
    epoch: 0,
    config: { mode: 'free', templateId: 1, templateVersionId: 2 }
  })
  const before = JSON.stringify([...h.saved])
  h.r.noteEdit({ epoch: 0, patch: { description: 'visible unsaved' } })
  h.r.resumeLocal({ epoch: 0 })
  assert.equal(h.writes.length, 0)
  assert.equal(JSON.stringify([...h.saved]), before)
  assert.equal(h.r.getFacts().sourceReady, false)
})

test('E3-15 live changed frozen source becomes conflict without authorizing confirmation writes', () => {
  const raw = {
    ...record,
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'original' }
  }
  const h = harness([
    [entry.key, clone(raw)],
    ['unsettled:template:free', { protocol: 2, draftKey: entry.key, record: clone(raw) }]
  ])
  h.r.inspect({ epoch: 0 })
  h.saved.set(entry.key, {
    ...raw,
    sessionRequest: { ...raw.sessionRequest, clientRequestId: 'foreign' }
  })
  assert.equal(h.r.readFrozen({ epoch: 0 }).status, 'blocked')
  assert.equal(h.r.getFacts().frozen, 'conflict')
  assert.equal(h.writes.length, 0)
})

test('E2-09 reopened source-pending journal projects its actual durable patch before any GET', () => {
  const pending = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'durable early text' },
    observed: [{ key: entry.key, fingerprint: { kind: 'absent' } }],
    prepared: null
  }
  const h = harness([['initial-input:template:free', pending]])
  h.r.inspect({ epoch: 0 })
  assert.equal(h.r.project({}).description, 'durable early text')
  assert.equal(h.r.getFacts().sourceReady, false)
  assert.equal(h.writes.length, 0)
})

for (const entryKind of ['template', 'session'])
  for (const resolver of ['configuration', 'session'])
    test(`SPEC-01 V3 ${entryKind} ${resolver} resolution failure cannot publish partial readiness and can recover`, () => {
      const route =
        entryKind === 'template'
          ? entry
          : {
              key: 'session:4',
              kind: 'session',
              mode: null,
              templateId: null,
              templateVersionId: null,
              sessionId: 4
            }
      const prior = { ...record, sessionId: 4, userNotes: '', recoveryKey: 'unsettled:session:4' }
      const body = {
        sessionId: 4,
        input: { description: 'original', userNotes: '', inputMediaIds: [7] },
        clientRequestId: 'original-F',
        quoteToken: 'q'
      }
      const submission = {
        protocol: 2,
        path: '/generations',
        sessionId: 4,
        sourceArtifactId: null,
        templateVersionId: 2,
        costCredits: 3,
        body
      }
      const saved = new Map([
        [entry.key, clone(prior)],
        ['session:4', clone(prior)],
        [
          'unsettled:session:4',
          { protocol: 2, draftKey: 'session:4', record: { ...prior, submission } }
        ]
      ])
      let failing = true
      const writes = []
      const r = load('src/features/creation/initial-input-recovery.js').createInitialInputRecovery({
        entry: route,
        storage: {
          get: (key) => {
            if (failing && key === 'unsettled:session:4') throw Error('required envelope')
            return clone(saved.get(key))
          },
          set: (key, value) => {
            writes.push(key)
            saved.set(key, clone(value))
          }
        },
        isInterested: () => true
      })
      const config = { mode: 'free', templateId: 1, templateVersionId: 2 }
      const session = {
        id: 4,
        ...config,
        draft: {
          input: { description: 'server', userNotes: '', inputMediaIds: [99] },
          updatedAt: '2026-11-13T00:00:00Z'
        }
      }
      const resolve = () =>
        resolver === 'configuration'
          ? r.resolveConfiguration({ epoch: 0, config })
          : r.resolveSession({ epoch: 0, session })
      assert.notEqual(r.inspect({ epoch: 0 }).status, 'ready')
      const pending = resolve()
      assert.notEqual(pending.status, 'ready')
      assert.equal(pending.facts.sourceReady, false)
      for (const operation of ['normal-save', 'upload', 'new-session', 'quote', 'new-submission'])
        assert.notEqual(r.admit({ epoch: 0, operation }).status, 'ready')
      r.noteEdit({ epoch: 0, patch: { description: 'newest explicit input' } })
      assert.equal(r.beginLocalResume({ epoch: 0 }).ticket, undefined)
      assert.notEqual(r.resumeLocal({ epoch: 0 }).status, 'ready')
      assert.equal(writes.length, 0)
      failing = false
      const recovered = resolve()
      assert.equal(recovered.status, 'ready')
      assert.equal(recovered.facts.sourceReady, true)
      assert.equal(recovered.facts.frozen, 'valid')
      assert.deepEqual(clone(recovered.projection.submission), submission)
      assert.equal(recovered.projection.description, 'newest explicit input')
      assert.notEqual(recovered.projection.corruptPending, true)
      assert.equal(r.readFrozen({ epoch: 0 }).status, 'ready')
      assert.equal(writes.length, 0)
    })
