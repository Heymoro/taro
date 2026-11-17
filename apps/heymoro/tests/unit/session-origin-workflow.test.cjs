const test = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture } = require('../fixtures/creation.cjs')
const clone = (v) => JSON.parse(JSON.stringify(v))
function fixture(stage = 'missing', extra = {}) {
  const mode = extra.mode || 'free'
  const source = extra.sourceKey || `template:${mode === 'free' ? 'free' : 1}`
  const recoveryKey = `unsettled:template:${mode === 'free' ? 'free' : 1}`
  const record = {
    protocol: 2,
    mode,
    templateId: 1,
    templateVersionId: 2,
    sessionId: null,
    description: 'local original',
    userNotes: '',
    photos: [],
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: ' F1 ' },
    submission: null,
    draftPaused: false,
    recoveryKey,
  }
  const desired = { ...record, sessionId: 4, sessionRequest: null }
  delete desired.templateVersionId
  const saved =
    extra.saved ||
    new Map([
      [source, clone(desired)],
      [recoveryKey, { protocol: 2, draftKey: source, record: clone(record) }],
    ])
  if (!extra.saved && stage !== 'missing') saved.set('session:4', clone(stage === 'alias-F' ? record : desired))
  const calls = [],
    remote = {
      id: 4,
      mode,
      templateId: 1,
      creationClientRequestId: ' F1 ',
      runningTask: null,
      draft: { input: { description: '', userNotes: '', inputMediaIds: [] }, updatedAt: '2026-11-13T00:00:00Z' },
    }
  const h = workflowFixture({
    saved,
    key: source,
    template: null,
    ...extra,
    api: {
      getSession: async () => clone(remote),
      createSession: async (body) => {
        calls.push(['create', body])
        return clone(remote)
      },
      quote: async () => {
        calls.push(['quote'])
        throw Error('unexpected quote')
      },
      putDraft: async () => calls.push(['put']),
      generate: async () => calls.push(['generate']),
      ...extra.api,
    },
  })
  h.workflow.dispose()
  h.control.get = () => {}
  h.workflow = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      api: h.api,
      files: { exists: async () => true, preview: async () => '/private.png' },
      key: source,
      sessionId: extra.canonical === false ? null : 4,
      templateId: extra.canonical === false && mode === 'effect' ? 1 : null,
      storage: {
        get: (k) => {
          h.control.get(k)
          return saved.has(k) ? clone(saved.get(k)) : undefined
        },
        set: (k, v) => {
          h.writes.push({ key: k, draft: clone(v) })
          h.control.beforeSet(k, v)
          if (h.control.fail(k, v)) throw Error('storage')
          saved.set(k, clone(v))
        },
      },
      makeId: () => assert.fail('recovery minted ID'),
      isCurrent: extra.isCurrent,
    })
  return { ...h, calls, remote, record, desired, source, recoveryKey }
}
for (const stage of ['missing', 'both', 'alias-F'])
  test(`actual workflow ${stage} read-only restore then explicit original confirmation`, async () => {
    const h = fixture(stage)
    await h.workflow.restore()
    assert.equal(h.workflow.getSnapshot().sessionId, 4)
    assert.equal(h.workflow.getSnapshot().description, 'local original')
    assert.deepEqual(clone(h.workflow.getSnapshot().sessionRequest), h.record.sessionRequest)
    assert.equal(h.workflow.getSnapshot().controls.generateLabel, '确认会话结果')
    await h.workflow.prepareQuote()
    await h.workflow.refresh()
    assert.deepEqual(h.calls, [])
    assert.equal(h.writes.length, 0)
    await h.workflow.generate()
    assert.deepEqual(clone(h.calls), [['create', h.record.sessionRequest]])
    assert.equal(h.workflow.getSnapshot().sessionId, 4)
    assert.equal(h.workflow.getSnapshot().sessionRequest, null)
    assert.equal(h.saved.get('unsettled:template:free'), null)
    assert.deepEqual(
      h.writes.map((v) => v.key),
      stage === 'both' ? ['unsettled:template:free'] : ['session:4', 'unsettled:template:free']
    )
    h.workflow.dispose()
  })
const gate = () => {
  let release, reject
  const promise = new Promise((a, b) => {
    release = a
    reject = b
  })
  return { promise, release, reject }
}
for (const wrong of [{ id: 8 }, { mode: 'effect' }, { templateId: 8 }, { templateId: 0 }])
  test(`known receipt ${JSON.stringify(wrong)} writes nothing, keeps ID and exact original body`, async () => {
    const requests = [],
      h = fixture('both')
    h.api.createSession = async (body) => {
      requests.push(clone(body))
      return { ...h.remote, ...wrong }
    }
    await h.workflow.restore()
    const before = JSON.stringify([...h.saved])
    await h.workflow.generate()
    assert.deepEqual(requests, [h.record.sessionRequest])
    assert.equal(h.workflow.getSnapshot().sessionId, 4)
    assert.deepEqual(clone(h.workflow.getSnapshot().sessionRequest), h.record.sessionRequest)
    assert.equal(h.writes.length, 0)
    assert.equal(JSON.stringify([...h.saved]), before)
    h.workflow.dispose()
  })
test('known original double click is singleflight and unknown outcome replays the same body', async () => {
  const pending = gate(),
    h = fixture(),
    bodies = []
  h.api.createSession = (body) => {
    bodies.push(clone(body))
    return pending.promise
  }
  await h.workflow.restore()
  const a = h.workflow.generate(),
    b = h.workflow.generate()
  assert.equal(bodies.length, 1)
  pending.reject({ isOutcomeUnknown: true })
  await Promise.all([a, b])
  assert.equal(h.workflow.getSnapshot().sessionId, 4)
  assert.equal(h.writes.length, 0)
  h.api.createSession = async (body) => {
    bodies.push(clone(body))
    return h.remote
  }
  await h.workflow.generate()
  assert.deepEqual(bodies, [h.record.sessionRequest, h.record.sessionRequest])
  assert.equal(h.saved.get('unsettled:template:free'), null)
  h.workflow.dispose()
})
for (const boundary of ['hide', 'hide-show', 'account', 'dispose'])
  test(`known receipt after ${boundary} keeps known ID and writes nothing`, async () => {
    const pending = gate()
    let current = true
    const h = fixture('both', { isCurrent: () => current })
    h.api.createSession = () => pending.promise
    await h.workflow.restore()
    const flight = h.workflow.generate()
    if (boundary === 'account') current = false
    else if (boundary === 'dispose') h.workflow.dispose()
    else {
      h.workflow.setPageVisible({ visible: false })
      if (boundary === 'hide-show') h.workflow.setPageVisible({ visible: true })
    }
    pending.release(h.remote)
    await flight
    assert.equal(h.workflow.getSnapshot().sessionId, 4)
    assert.equal(h.writes.length, 0)
    if (boundary === 'hide-show') {
      h.api.createSession = async () => h.remote
      await h.workflow.generate()
      assert.equal(h.saved.get('unsettled:template:free'), null)
    }
    h.workflow.dispose()
  })
for (const phase of ['early', 'proven', 'inflight'])
  test(`${phase} overlay only confirms result and keeps original F and all current input`, async () => {
    const get = gate(),
      create = gate(),
      h = fixture('both')
    h.api.getSession = () => get.promise
    h.api.createSession = () => create.promise
    const restoring = h.workflow.restore()
    if (phase === 'early') h.workflow.setDescription('visible edit')
    get.release(h.remote)
    await restoring
    if (phase === 'proven') h.workflow.setDescription('visible edit')
    const before = JSON.stringify([...h.saved]),
      writes = h.writes.length
    const confirming = h.workflow.generate()
    if (phase === 'inflight') h.workflow.setDescription('visible edit')
    create.release(h.remote)
    await confirming
    const state = h.workflow.getSnapshot()
    assert.equal(state.sessionId, 4)
    assert.equal(state.description, 'visible edit')
    assert.deepEqual(clone(state.sessionRequest), h.record.sessionRequest)
    assert.equal(state.originalResult.id, 4)
    assert.match(state.error, /仍待保存/)
    assert.equal(h.writes.length, writes)
    assert.equal(JSON.stringify([...h.saved]), before)
    h.workflow.dispose()
  })
test('known restore refresh visibility quote and upload never mint ID or start business mutations', async () => {
  const h = fixture('alias-F')
  h.workflow.dispose()
  const { createWorkflow } = require('../source.cjs').load('src/creation-workflow.js')
  const calls = []
  const w = createWorkflow({
    key: 'template:free',
    sessionId: 4,
    api: h.api,
    files: {
      preview: async () => '',
      exists: async () => true,
      choose: async () => calls.push('choose'),
      upload: async () => calls.push('upload'),
    },
    storage: { get: (k) => h.saved.get(k), set: () => calls.push('set') },
    makeId: () => calls.push('id'),
  })
  await w.restore()
  await w.refresh()
  w.setPageVisible({ visible: false })
  w.setPageVisible({ visible: true })
  await w.prepareQuote()
  await w.addPhotos()
  await w.retryPhoto('anything')
  assert.deepEqual(calls, [])
  assert.deepEqual(h.calls, [])
  assert.equal(w.getSnapshot().controls.canSelectPhotos, false)
  w.dispose()
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
      test(`real ${mode} ${
        canonical ? 'canonical' : 'template'
      } ${window} interrupted settlement cold replay`, async () => {
        const shape = window.startsWith('source') ? 'generic' : window.startsWith('alias') ? 'bound' : 'opaque'
        const base = `template:${mode === 'free' ? 'free' : 1}`
        const sourceKey = shape === 'generic' ? base : shape === 'bound' ? `${base}:entry:${mode}:1:2` : 'owner:1:free'
        const h = fixture('missing', { mode, canonical, sourceKey })
        h.saved.set(h.source, clone(h.record))
        await h.workflow.restore()
        assert.equal(h.calls.length, 0)
        assert.equal(h.writes.length, 0)
        const target = window.startsWith('source') ? h.source : window.startsWith('alias') ? 'session:4' : h.recoveryKey
        let interrupted = false,
          afterSet = false
        h.control.beforeSet = (k, v) => {
          if (k !== target || interrupted) return
          afterSet = true
          if (window.endsWith('set')) {
            interrupted = true
            throw Error('reject')
          }
          if (window.endsWith('ack')) {
            interrupted = true
            h.saved.set(k, clone(v))
            throw Error('lost ACK')
          }
        }
        h.control.get = (k) => {
          if (k === target && afterSet && !interrupted && window.endsWith('readback')) {
            interrupted = true
            throw Error('readback')
          }
        }
        await h.workflow.generate()
        assert.equal(interrupted, true)
        const originalRequest = canonical ? h.record.sessionRequest : { templateId: h.record.sessionRequest.templateId, clientRequestId: h.record.sessionRequest.clientRequestId }
        assert.deepEqual(clone(h.calls), [['create', originalRequest]])
        if (canonical) assert.equal(h.workflow.getSnapshot().sessionId, 4)
        h.workflow.dispose()
        const second = fixture('missing', { mode, canonical, sourceKey, saved: h.saved })
        await second.workflow.restore()
        if (h.saved.get(h.recoveryKey) !== null) {
          assert.deepEqual(clone(second.workflow.getSnapshot().sessionRequest), h.record.sessionRequest)
          assert.equal(second.calls.length, 0)
          assert.equal(second.writes.length, 0)
          if (!canonical)
            second.api.quote = async () => ({
              templateId: 1,
              quoteToken: 'q',
              costCredits: 3,
              validUntil: '2099-01-01T00:00:00Z',
            })
          await second.workflow.generate()
          assert.deepEqual(clone(second.calls), [['create', originalRequest]])
          assert.equal(second.writes.at(-1).key, h.recoveryKey)
          assert.ok(
            second.writes.every((w) => w.draft === null || w.draft.sessionRequest === null),
            'never rewrite desired as F'
          )
        }
        assert.equal(second.workflow.getSnapshot().sessionId, 4)
        assert.equal(h.saved.get(h.recoveryKey), null)
        assert.deepEqual(h.saved.get(h.source), h.desired)
        assert.deepEqual(h.saved.get('session:4'), h.desired)
        second.workflow.dispose()
      })
test('normal canonical lane remains eligible for an explicit quote', async () => {
  const h = fixture('both')
  h.saved.set(h.recoveryKey, null)
  let quoted = 0
  h.api.quote = async () => {
    quoted++
    return { templateId: 1, quoteToken: 'q', costCredits: 3, validUntil: '2099-01-01T00:00:00Z' }
  }
  await h.workflow.restore()
  await h.workflow.prepareQuote()
  assert.ok(quoted > 0)
  assert.equal(h.workflow.getSnapshot().quote.quoteToken, 'q')
  assert.equal(
    h.calls.some(([kind]) => kind === 'create'),
    false
  )
  h.workflow.dispose()
})
test('confirmed canonical result offers an explicit quote action without fetching one', async () => {
  const h = fixture('both')
  await h.workflow.restore()
  await h.workflow.generate()
  assert.equal(h.workflow.getSnapshot().errorAction, 'quote')
  assert.deepEqual(clone(h.calls), [['create', h.record.sessionRequest]])
  h.api.quote = async () => {
    h.calls.push(['quote'])
    return { templateId: 1, quoteToken: 'q', costCredits: 3, validUntil: '2099-01-01T00:00:00Z' }
  }
  await h.workflow.retryError()
  assert.deepEqual(clone(h.calls), [['create', h.record.sessionRequest], ['quote']])
  h.workflow.dispose()
})
for (const mutation of ['source', 'alias', 'envelope'])
  test(`external ${mutation} mutation during POST stops settlement and preserves all third values`, async () => {
    const h = fixture('both'),
      g = gate()
    h.api.createSession = () => g.promise
    await h.workflow.restore()
    const flight = h.workflow.generate()
    const key = mutation === 'source' ? h.source : mutation === 'alias' ? 'session:4' : h.recoveryKey
    const third =
      mutation === 'envelope'
        ? { ...h.saved.get(key), record: { ...h.record, description: 'foreign same identity' } }
        : { ...h.desired, description: 'foreign' }
    h.saved.set(key, clone(third))
    g.release(h.remote)
    await flight
    assert.equal(h.writes.length, 0)
    assert.equal(h.workflow.getSnapshot().sessionId, 4)
    assert.deepEqual(h.saved.get(key), third)
    h.workflow.dispose()
  })
for (const valid of [true, false])
  test(`${
    valid ? 'valid' : 'malformed'
  } durable initial journal coexists with origin proof without cleanup`, async () => {
    const h = fixture('both')
    const { fingerprintInitialInputValue } = require('../source.cjs').load(
      'src/features/creation/initial-input-intent.js'
    )
    const journal = valid
      ? {
          protocol: 1,
          kind: 'ordinary-initial-input',
          entry: {
            key: 'session:4',
            kind: 'session',
            mode: null,
            templateId: null,
            templateVersionId: null,
            sessionId: 4,
          },
          fields: ['description'],
          patch: { description: 'journal input' },
          observed: [
            {
              key: 'session:4',
              fingerprint: clone(fingerprintInitialInputValue({ value: h.saved.get('session:4') }).value),
            },
          ],
          prepared: null,
        }
      : { invalid: true }
    h.saved.set('initial-input:session:4', clone(journal))
    const before = JSON.stringify([...h.saved])
    await h.workflow.restore()
    await h.workflow.generate()
    assert.equal(h.workflow.getSnapshot().originalResult.id, 4)
    if (valid) assert.equal(h.workflow.getSnapshot().description, 'journal input')
    assert.equal(JSON.stringify([...h.saved]), before)
    assert.equal(h.writes.length, 0)
    assert.deepEqual(clone(h.calls), [['create', h.record.sessionRequest]])
    h.workflow.dispose()
  })
test('original template source-only F establishes crash envelope before replay without rewinding settled targets', async () => {
  const h = fixture('missing', { canonical: false })
  h.saved.set(h.source, clone(h.record))
  h.saved.delete(h.recoveryKey)
  let witnessed = false
  h.api.createSession = async (body) => {
    witnessed = !!h.saved.get(h.recoveryKey)?.record?.sessionRequest
    assert.deepEqual(clone(body), { templateId: 1, clientRequestId: h.record.sessionRequest.clientRequestId })
    return h.remote
  }
  h.api.quote = async () => ({
    templateId: 1,
    quoteToken: 'q',
    costCredits: 3,
    validUntil: '2099-01-01T00:00:00Z',
  })
  await h.workflow.restore()
  assert.equal(h.writes.length, 0)
  await h.workflow.generate()
  assert.equal(witnessed, true)
  assert.equal(h.saved.get(h.recoveryKey), null)
  h.workflow.dispose()
})
for (const mode of ['free', 'effect'])
  for (const replacement of ['null', 'absent', 'generation'])
    test(`P1 actual ${mode} workflow GET-window envelope ${replacement} never authorizes input or upload writes`, async () => {
      const h = fixture('both', { mode }),
        get = gate()
      h.api.getSession = () => get.promise
      const restoring = h.workflow.restore()
      if (replacement === 'absent') h.saved.delete(h.recoveryKey)
      else if (replacement === 'null') h.saved.set(h.recoveryKey, null)
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
        h.saved.set(h.recoveryKey, { protocol: 2, draftKey: h.source, record })
      }
      const saved = JSON.stringify([...h.saved])
      get.release(h.remote)
      await restoring
      assert.equal(h.workflow.getSnapshot().controls.canSelectPhotos, false)
      assert.equal(h.workflow.setDescription('visible unsaved'), false)
      await h.workflow.prepareQuote()
      await h.workflow.generate()
      assert.equal(h.workflow.getSnapshot().description, 'visible unsaved')
      assert.equal(h.workflow.getSnapshot().sessionId, 4)
      assert.equal(h.writes.length, 0)
      assert.deepEqual(h.calls, [])
      assert.equal(JSON.stringify([...h.saved]), saved)
      h.workflow.dispose()
    })
for (const mode of ['free', 'effect'])
  test(`P2 actual ${mode} independent canonical keeps ordinary editing and quotes beside unrelated shared creation`, async () => {
    const h = fixture('both', { mode })
    const inputField = mode === 'free' ? 'description' : 'userNotes'
    const own = {
      ...h.desired,
      description: '',
      [inputField]: 'independent ordinary',
      recoveryKey: 'unsettled:session:4',
    }
    if (mode === 'effect') own.photos = [{ id: 'p', status: 'ready', mediaId: 7, path: '' }]
    h.saved.set('session:4', clone(own))
    h.saved.set('unsettled:session:4', null)
    const other = {
      ...clone(h.record),
      description: 'unrelated creation',
      sessionRequest: { ...h.record.sessionRequest, clientRequestId: 'different-create' },
    }
    h.saved.set(h.recoveryKey, { protocol: 2, draftKey: h.source, record: other })
    h.saved.set(h.source, clone(other))
    const protectedValues = JSON.stringify([h.saved.get(h.recoveryKey), h.saved.get(h.source)])
    let quotes = 0
    h.api.quote = async () => {
      quotes++
      return { templateId: 1, quoteToken: `q${quotes}`, costCredits: 3, validUntil: '2099-01-01T00:00:00Z' }
    }
    await h.workflow.restore()
    assert.equal(h.workflow.getSnapshot()[inputField], own[inputField])
    await h.workflow.prepareQuote()
    assert.ok(quotes > 0)
    assert.equal(h.writes.length, 0)
    assert.equal(
      mode === 'free' ? h.workflow.setDescription('ordinary edit') : h.workflow.setUserNotes('ordinary edit'),
      true
    )
    assert.equal(h.saved.get('session:4')[inputField], 'ordinary edit')
    assert.equal(JSON.stringify([h.saved.get(h.recoveryKey), h.saved.get(h.source)]), protectedValues)
    assert.equal(
      h.calls.some(([kind]) => kind === 'create' || kind === 'generate'),
      false
    )
    h.workflow.dispose()
  })
