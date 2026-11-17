const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fixture, ordinary, clone } = require('../fixtures/session-unavailable.cjs')

test('formal decoded session 404 ends restore without history, previews or storage writes', async () => {
  const record = ordinary()
  const saved = new Map([['session:4', record]])
  const f = fixture({ saved, control: { missing: true } })
  assert.equal((await f.workflow.restore()).status, 'unavailable')
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['account', 'getSession']
  )
  assert.deepEqual(clone([...saved]), [['session:4', record]])
  assert.equal(f.storage.writes.length, 0)
})

test('ordinary entry points stay closed after absence, including cached quote and remote resume', async () => {
  const f = fixture({ saved: new Map([['session:4', ordinary()]]), control: { missing: true } })
  await f.workflow.restore()
  const before = f.calls.length
  await f.workflow.refresh({ reason: 'manual' })
  await f.workflow.restore()
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  await f.workflow.rename('rename')
  await f.workflow.prepareRegeneration(66)
  await f.workflow.prepareCarryBackInput({ taskId: 9 })
  await f.workflow.focusTask({ taskId: 9 })
  await f.workflow.loadOlder()
  await f.workflow.addPhotos()
  await f.workflow.resumeDraftSave({ target: 'remote-draft' })
  assert.equal(f.calls.length, before)
  assert.equal(f.storage.writes.length, 0)
})

const {
  gate,
  frozen,
  frozenMap,
  response,
  notFound
} = require('../fixtures/session-unavailable.cjs')
const { load } = require('../source.cjs')
const { task } = require('../fixtures/creation.cjs')
const settle = () => new Promise(setImmediate)
async function readyFixture(options = {}) {
  const f = fixture({ saved: new Map([['session:4', ordinary()]]), ...options })
  await f.workflow.restore()
  await settle()
  return f
}
async function absentThenReadable(f) {
  f.control.missing = true
  assert.equal((await f.workflow.refresh()).status, 'unavailable')
  f.control.missing = false
  await f.workflow.recheckSession()
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'available')
}
for (const invalid of [
  { statusCode: 404, data: '<html>not found</html>' },
  { statusCode: 404, data: { error: { code: 'NOT_FOUND', message: 'NOT_FOUND' }, requestId: 'r' } },
  {
    statusCode: 404,
    data: { error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false }, requestId: '' }
  },
  {
    statusCode: 404,
    data: { error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: 'false' }, requestId: 'r' }
  },
  {
    statusCode: 404,
    data: {
      error: { code: 'OPERATION_OUTCOME_UNKNOWN', message: 'unknown', retryable: true },
      requestId: 'r'
    }
  },
  {
    statusCode: 409,
    data: {
      error: { code: 'SESSION_UNAVAILABLE', message: 'unavailable', retryable: false },
      requestId: 'r'
    }
  },
  {
    statusCode: 401,
    data: { error: { code: 'UNAUTHENTICATED', message: 'auth', retryable: false }, requestId: 'r' }
  },
  {
    statusCode: 503,
    data: {
      error: { code: 'DATA_INTEGRITY_CONFLICT', message: 'later', retryable: true },
      requestId: 'r'
    }
  }
]) {
  test(`actual adapter negative evidence does not terminalize ${JSON.stringify(
    invalid
  )}`, async () => {
    const f = fixture({ control: { sessionResponse: invalid } })
    await f.workflow.restore()
    assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unchecked')
    assert.ok(f.calls.some((c) => c.name === 'tasks'))
    assert.equal(f.storage.writes.length, 0)
    if (invalid.statusCode === 401) assert.equal(f.clears(), 1)
  })
}
for (const port of ['tasks', 'task', 'artifact']) {
  test(`child ${port} formal404 is not session evidence`, async () => {
    const f = fixture({ saved: new Map([['session:4', ordinary()]]) })
    const error = (() => {
      try {
        load('src/api.js').parseJsonResponse(notFound())
      } catch (e) {
        return e
      }
    })()
    f.base.api.tasks = async () => ({
      items: [task({}, { artifactIds: [66] })],
      nextCursor: null,
      hasMore: false
    })
    f.base.api[port] = async () => {
      throw error
    }
    await f.workflow.refresh()
    assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'available')
    assert.equal(f.storage.writes.length, 0)
  })
}
test('media404 remains independent MEDIA_DOWNLOAD_FAILED and is not a session proof', async () => {
  const f = fixture()
  await assert.rejects(f.native.privateImage(90), /MEDIA_DOWNLOAD_FAILED/)
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unchecked')
  assert.equal(f.storage.writes.length, 0)
})
test('synchronous unavailable subscriber double recheck does not join its own sentinel', async () => {
  const f = fixture({ control: { missing: true } })
  let first, second
  const unsubscribe = f.workflow.subscribe(() => {
    if (!first && f.workflow.getSnapshot().sessionAvailability.status === 'unavailable') {
      f.control.missing = false
      first = f.workflow.recheckSession()
      second = f.workflow.recheckSession()
    }
  })
  await f.workflow.restore()
  assert.equal(first, second)
  await first
  unsubscribe()
  assert.equal(f.calls.filter((c) => c.name === 'getSession').length, 2)
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'available')
  assert.equal(f.storage.writes.length, 0)
})
test('successful recheck with failed configuration keeps readable session and no fresh-quote admission', async () => {
  const f = fixture({ saved: new Map([['session:4', ordinary()]]), control: { missing: true } })
  await f.workflow.restore()
  f.control.missing = false
  f.base.api.freePreset = async () => {
    throw Error('configuration unavailable')
  }
  await f.workflow.recheckSession()
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'available')
  assert.equal(f.workflow.getSnapshot().template, null)
  assert.equal(f.workflow.getSnapshot().controls.sessionNotice, null)
  assert.equal(f.calls.filter((c) => ['quote', 'putDraft'].includes(c.name)).length, 0)
  assert.equal(f.storage.writes.length, 0)
})
for (const lane of [
  'quote',
  'rename',
  'carry',
  'source',
  'focus',
  'older',
  'putDraft',
  'upload',
  'choose',
  'replace'
]) {
  for (const outcome of ['success', 'failure']) {
    test(`old ${lane} ${outcome} cannot revive after 404 then recheck200`, async () => {
      const photo =
        lane === 'replace'
          ? { id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }
          : { id: 'photo', status: 'failed', path: '/photo.png', name: 'photo', mediaId: 7 }
      const held = gate()
      const waitForOld = async () => {
        held.started = (held.started || 0) + 1
        return held.promise
      }
      const files =
        lane === 'upload'
          ? { upload: waitForOld }
          : ['choose', 'replace'].includes(lane)
          ? { choose: waitForOld }
          : {}
      const f = await readyFixture({
        saved: new Map([
          [
            'session:4',
            ordinary({
              photos: ['upload', 'replace'].includes(lane) ? [photo] : [],
              carryBackSourceTaskId: lane === 'replace' ? 9 : null
            })
          ]
        ]),
        files,
        ...(lane === 'older'
          ? {
              api: {
                tasks: async () => ({ items: [], nextCursor: 'next', hasMore: true })
              }
            }
          : {})
      })
      const w = f.workflow
      let pending
      if (lane === 'quote') {
        w.expireQuote()
        f.api.quote = waitForOld
        pending = w.prepareQuote()
      } else if (lane === 'rename') {
        f.api.rename = waitForOld
        pending = w.rename('new title')
      } else if (lane === 'carry') {
        f.api.task = waitForOld
        pending = w.prepareCarryBackInput({ taskId: 9 })
      } else if (lane === 'source') {
        f.api.artifact = waitForOld
        pending = w.prepareRegeneration(66)
      } else if (lane === 'focus') {
        f.api.task = waitForOld
        pending = w.focusTask({ taskId: 9 })
      } else if (lane === 'older') {
        f.api.tasks = waitForOld
        pending = w.loadOlder()
      } else if (lane === 'putDraft') {
        f.api.putDraft = waitForOld
        w.setDescription('first draft already sent')
      } else if (lane === 'upload') pending = w.retryPhoto(photo.id)
      else if (lane === 'choose') pending = w.addPhotos()
      else pending = w.replacePhoto({ id: photo.id })
      await settle()
      assert.equal(held.started, 1, 'the old operation really reached its await')
      if (lane === 'putDraft') {
        w.setDescription('second draft queued behind the first')
        await settle()
        assert.equal(held.started, 1)
      }
      if (lane === 'older') f.api.tasks = f.base.api.tasks
      await absentThenReadable(f)
      const before = clone(w.getSnapshot())
      const expected = clone(before)
      if (lane === 'upload') {
        assert.deepEqual(before.controls.activeUploadIds, [photo.id])
        expected.controls.activeUploadIds = []
      }
      if (['choose', 'replace'].includes(lane)) {
        assert.equal(before.controls.photoBatchBusy, true)
        expected.controls.photoBatchBusy = false
      }
      const raw = clone([...f.storage.saved])
      const writes = f.storage.writes.length
      const calls = f.calls.length
      const replies = {
        quote: {
          quoteToken: 'old',
          costCredits: 3,
          templateVersionId: 2,
          validUntil: '2099-01-01'
        },
        rename: { title: 'old late title', titleSource: 'user' },
        older: {
          items: [task({}, { id: 55, artifactIds: [66] })],
          hasMore: false,
          nextCursor: null
        },
        source: { id: 66, sessionId: 4, taskId: 9 },
        carry: task(
          {},
          {
            inputAvailability: [
              { mediaId: 15, position: 1, status: 'active' },
              { mediaId: 16, position: 2, status: 'active' }
            ]
          }
        ),
        upload: { id: 88 },
        choose: [{ path: '/new.png', size: 1, mimeType: 'image/png' }],
        replace: [{ path: '/new.png', size: 1, mimeType: 'image/png' }]
      }
      if (outcome === 'failure') held.reject(Error('old failure'))
      else held.resolve(replies[lane] || task())
      const result = pending ? await pending : null
      if (lane === 'carry') assert.equal(result, null, 'no obsolete candidate may be offered')
      await settle()
      assert.deepEqual(clone(w.getSnapshot()), expected)
      assert.deepEqual(clone([...f.storage.saved]), raw)
      assert.equal(f.storage.writes.length, writes)
      assert.equal(f.calls.length, calls)
      assert.equal(held.started, 1, 'old success cannot recursively flush a queued draft')
    })
  }
}

test('explicit fresh quote after recheck does not join an old pre-terminal quote flight', async () => {
  const f = await readyFixture()
  const held = gate()
  f.workflow.expireQuote()
  let quotes = 0
  f.api.quote = async () => {
    quotes++
    return quotes === 1
      ? held.promise
      : { costCredits: 3, templateId: 1, quoteToken: 'fresh', validUntil: '2099-01-01' }
  }
  const old = f.workflow.prepareQuote()
  await settle()
  assert.equal(quotes, 1)
  await absentThenReadable(f)
  const fresh = f.workflow.prepareQuote()
  await settle()
  assert.equal(quotes, 2)
  await fresh
  const quote = clone(f.workflow.getSnapshot().quote)
  held.resolve({
    costCredits: 3,
    templateVersionId: 2,
    quoteToken: 'old',
    validUntil: '2099-01-01'
  })
  await old
  assert.deepEqual(clone(f.workflow.getSnapshot().quote), quote)
})

function addInitial(saved, sessionId = 4) {
  const entry = {
    key: sessionId ? `session:${sessionId}` : 'template:free',
    kind: sessionId ? 'session' : 'template',
    mode: sessionId ? null : 'free',
    templateId: null,
    templateVersionId: null,
    sessionId
  }
  const journal = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'early local text' },
    observed: [],
    prepared: null
  }
  saved.set(`initial-input:${entry.key}`, journal)
  return journal
}
for (const operation of ['generate', 'regenerate']) {
  for (const initial of [false, true]) {
    for (const timing of ['unavailable-start', 'available-start-cross-terminal']) {
      test(`legal ${operation} F initial=${initial} ${timing} preserves receipt but never upgrades ordinary tails`, async () => {
        const record = frozen(operation)
        const saved = frozenMap(record)
        if (initial) addInitial(saved)
        const f = fixture({
          saved,
          template: null,
          control: { missing: timing === 'unavailable-start' }
        })
        await f.workflow.restore()
        await settle()
        const w = f.workflow
        assert.ok(w.getSnapshot().submission, 'real validated F was projected, not corrupt-blocked')
        assert.equal(w.getSnapshot().corruptPending, false)
        const held = gate(),
          bodies = []
        f.api[operation] = async (body) => {
          bodies.push(clone(body))
          return held.promise
        }
        const pending = w.generate()
        await settle()
        assert.equal(bodies.length, 1)
        assert.equal(w.getSnapshot().submitting, true)
        if (timing === 'available-start-cross-terminal') {
          f.control.missing = true
          await w.refresh()
        }
        const frozenBefore = clone(w.getSnapshot().submission)
        const raw = clone([...saved]),
          writes = f.storage.writes.length
        f.control.missing = false
        await w.recheckSession()
        const tailStart = f.calls.length
        held.resolve(task(record.submission.body, { status: 'succeeded', artifactIds: [66] }))
        await pending
        await settle()
        const expectedBody =
          operation === 'generate'
            ? record.submission.body
            : { sourceArtifactId: 66, sessionId: 4, ...record.submission.body }
        assert.deepEqual(bodies, [expectedBody])
        assert.equal(
          f.calls.length,
          tailStart,
          'receipt cannot acquire task/artifact/quote/draft tail'
        )
        if (initial) {
          assert.ok(w.getSnapshot().originalResult)
          assert.deepEqual(clone([...saved]), raw)
          assert.equal(f.storage.writes.length, writes)
          assert.deepEqual(clone(w.getSnapshot().submission), frozenBefore)
        } else {
          assert.equal(w.getSnapshot().submission, null)
          assert.equal(w.getSnapshot().rounds[0].status, 'succeeded')
          assert.ok(
            f.storage.writes.length > writes,
            'the real receipt was durably settled by the original guard'
          )
        }
      })
    }
  }
}
for (const initial of [false, true]) {
  test(`legal sessionless F uses original create body, 409 is nonterminal, initial=${initial}`, async () => {
    const record = frozen('session')
    const saved = frozenMap(record)
    if (initial) addInitial(saved, null)
    const f = fixture({ saved, sessionId: null, template: null })
    await f.workflow.restore()
    const bodies = []
    f.api.createSession = async (body) => {
      bodies.push(clone(body))
      return load('src/api.js').parseJsonResponse({
        statusCode: 409,
        data: {
          error: { code: 'SESSION_UNAVAILABLE', message: 'unavailable', retryable: false },
          requestId: 'create-409'
        }
      })
    }
    const raw = clone([...saved]),
      writes = f.storage.writes.length
    await f.workflow.generate()
    assert.deepEqual(bodies, [initial ? record.sessionRequest : { templateId: record.sessionRequest.templateId, clientRequestId: record.sessionRequest.clientRequestId }])
    assert.equal(f.calls.filter((c) => c.name === 'getSession').length, 0)
    assert.equal(f.workflow.getSnapshot().sessionId, null)
    assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unchecked')
    assert.deepEqual(clone([...saved]), raw)
    if (initial) assert.equal(f.storage.writes.length, writes)
  })
}

test('ordinary new POST frozen before terminal still accepts its real receipt without resuming an old tail', async () => {
  const f = await readyFixture()
  const held = gate(),
    bodies = []
  f.api.generate = async (body) => {
    bodies.push(clone(body))
    return held.promise
  }
  const pending = f.workflow.generate()
  await settle()
  assert.equal(bodies.length, 1)
  const submission = clone(f.workflow.getSnapshot().submission)
  assert.ok(
    load('src/features/creation/recovery-contract.js').readUnsettledRecord({
      record: f.storage.saved.get('session:4')
    })
  )
  await absentThenReadable(f)
  const start = f.calls.length
  held.resolve(task(submission.body, { status: 'succeeded', artifactIds: [66] }))
  await pending
  assert.equal(f.workflow.getSnapshot().submission, null)
  assert.equal(f.calls.length, start)
  assert.deepEqual(bodies, [submission.body])
})

test('healthy sessionless create receipt still continues into quote with exact wire fields', async () => {
  const record = ordinary({
    sessionId: null,
    recoveryKey: 'unsettled:template:free',
    description: ''
  })
  const f = fixture({
    saved: new Map([['template:free', record]]),
    sessionId: null,
    template: null
  })
  await f.workflow.restore()
  f.workflow.setDescription('fresh healthy input')
  await f.workflow.prepareQuote()
  await settle()
  assert.equal(f.calls.filter((c) => c.name === 'createSession').length, 1)
  const quotes = f.calls.filter((c) => c.name === 'quote')
  assert.equal(quotes.length, 1)
  assert.deepEqual(Object.keys(quotes[0].args[0]).sort(), ['input', 'sessionId'])
  assert.equal(f.workflow.getSnapshot().quote.terminalEpoch, 0)
})
test('healthy succeeded generation still reads delivered task and artifacts', async () => {
  const f = await readyFixture()
  f.api.generate = async (body) => task(body, { status: 'succeeded' })
  f.base.api.task = async () => task({}, { status: 'succeeded', artifactIds: [66] })
  const start = f.calls.length
  await f.workflow.generate()
  assert.deepEqual(
    f.calls.slice(start).map((c) => c.name),
    ['task', 'artifact']
  )
  assert.equal(f.workflow.getSnapshot().artifacts[66].id, 66)
})
test('unchecked to available does not invalidate an in-flight upload', async () => {
  const held = gate()
  const photo = { id: 'photo', status: 'failed', path: '/photo.png', name: 'photo' }
  const f = fixture({
    saved: new Map([['session:4', ordinary({ photos: [photo] })]]),
    files: { upload: async () => held.promise }
  })
  const pending = f.workflow.retryPhoto('photo')
  await settle()
  assert.equal(f.workflow.getSnapshot().photos[0].status, 'uploading')
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().sessionAvailability.terminalEpoch, 0)
  held.resolve({ id: 88 })
  await pending
  assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 88)
  assert.equal(f.storage.saved.get('session:4').photos[0].mediaId, 88)
})
test('ordinary unavailable input editing/reorder/remove is local-only and preserves complete provenance', async () => {
  const photos = [7, 8].map((id) => ({
    id: `p${id}`,
    status: 'ready',
    mediaId: id,
    path: `/p${id}.png`
  }))
  const f = fixture({
    saved: new Map([['session:4', ordinary({ photos })]]),
    control: { missing: true }
  })
  await f.workflow.restore()
  const calls = f.calls.length
  assert.equal(f.workflow.setDescription('local edit'), true)
  assert.equal(f.workflow.setUserNotes('local notes'), true)
  assert.equal(
    f.workflow.movePhoto({ slotId: 'p8', targetIndex: 0, expectedIds: ['p7', 'p8'] }),
    true
  )
  assert.equal(f.workflow.removePhoto('p7'), true)
  await settle()
  const raw = f.storage.saved.get('session:4')
  assert.equal(raw.description, 'local edit')
  assert.equal(raw.userNotes, 'local notes')
  assert.deepEqual(raw.photos, [photos[1]])
  assert.equal(f.calls.length, calls)
  assert.ok(f.storage.writes.length > 0)
  assert.doesNotMatch(JSON.stringify([...f.storage.saved]), /terminalEpoch|sessionAvailability/)
})
for (const raw of [
  { protocol: 2, description: 'partial' },
  ordinary({ sessionId: 8 }),
  { protocol: 1, description: 'legacy' },
  { unknown: true }
]) {
  test(`unconfirmed ordinary source is not promoted by terminal status ${JSON.stringify(
    raw
  )}`, async () => {
    const saved = new Map([['session:4', raw]])
    const f = fixture({ saved, template: null, control: { missing: true } })
    await f.workflow.restore()
    const writes = f.storage.writes.length
    await f.workflow.prepareQuote()
    await f.workflow.addPhotos()
    assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, false)
    assert.deepEqual(clone(saved.get('session:4')), raw)
    assert.equal(f.storage.writes.length, writes)
  })
}
test('independent cached artifact favorite survives unavailable parent while new generation stays closed', async () => {
  const f = await readyFixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [66] })],
        hasMore: false,
        nextCursor: null
      })
    }
  })
  assert.equal(f.workflow.getSnapshot().artifacts[66].id, 66)
  f.control.missing = true
  await f.workflow.refresh()
  const start = f.calls.length
  await f.workflow.toggleFavorite(66)
  await f.workflow.prepareRegeneration(66)
  await f.workflow.generate()
  assert.deepEqual(
    f.calls.slice(start).map((c) => c.name),
    ['favorite']
  )
  assert.equal(f.workflow.getSnapshot().artifacts[66].isFavorite, true)
})

function initialState(phase) {
  const raw = ordinary()
  const saved = new Map([['session:4', raw]])
  const journal = addInitial(saved)
  const core = load('src/features/creation/initial-input-intent.js')
  const fingerprint = core.fingerprintInitialInputValue({ value: raw }).value
  journal.observed = [{ key: 'session:4', fingerprint }]
  if (phase === 'R' || phase === 'U') {
    const binding = { mode: 'free', templateId: 1, templateVersionId: 2, sessionId: 4 }
    const out = core.prepareInitialInputIntent({
      context: { entry: journal.entry, binding },
      pending: journal,
      currentJournal: core.fingerprintInitialInputValue({ value: journal }).value,
      current: journal.observed,
      proposal: {
        binding,
        primaryKey: 'session:4',
        source: { kind: 'local', key: 'session:4', fingerprint },
        targets: [
          {
            key: 'session:4',
            expected: fingerprint,
            desired: { ...raw, description: journal.patch.description }
          }
        ]
      }
    })
    assert.equal(out.ok, true, 'prepared fixture is produced by the existing intent core')
    saved.set('initial-input:session:4', clone(out.value.intent))
  }
  if (phase === 'C') saved.set('session:4', ordinary({ description: 'foreign change' }))
  if (phase === 'M') saved.set('initial-input:session:4', { private: 'malformed intent unchanged' })
  return saved
}
for (const phase of ['P', 'R', 'U', 'C', 'M']) {
  test(`initial ${phase} raw survives terminal/read/show/recheck without consuming journal or attempt`, async () => {
    const saved = initialState(phase)
    const f = fixture({ saved, template: null, control: { missing: phase !== 'U' } })
    if (phase === 'U') {
      await f.workflow.restore()
      const set = f.storage.set
      f.storage.set = (key, value) => {
        if (key === 'session:4') throw Error('unconfirmed local target')
        return set(key, value)
      }
      await f.workflow.resumeDraftSave({ target: 'local-input' })
      assert.equal(f.workflow.getSnapshot().localInputRecovery.phase, 'unconfirmed')
      f.storage.set = set
      f.control.missing = true
      await f.workflow.refresh()
    } else await f.workflow.restore()
    const before = clone([...saved]),
      writes = f.storage.writes.length
    for (const reason of ['poll', 'show', 'manual']) await f.workflow.refresh({ reason })
    f.workflow.setPageVisible({ visible: false })
    f.workflow.setPageVisible({ visible: true })
    f.control.missing = false
    await f.workflow.recheckSession()
    assert.deepEqual(clone([...saved]), before)
    assert.equal(f.storage.writes.length, writes)
    assert.ok(saved.has('initial-input:session:4'))
    assert.equal(
      f.calls.filter((c) => ['quote', 'putDraft', 'createSession', 'generate'].includes(c.name))
        .length,
      0
    )
  })
}
test('pure local exact prepared replay remains possible while session is unavailable', async () => {
  const saved = initialState('R')
  const f = fixture({ saved, template: null, control: { missing: true } })
  await f.workflow.restore()
  const calls = f.calls.length
  const outcome = await f.workflow.resumeDraftSave({ target: 'local-input' })
  assert.equal(outcome.status, 'saved')
  assert.equal(saved.get('session:4').description, 'early local text')
  assert.equal(saved.get('initial-input:session:4'), null)
  assert.equal(f.calls.length, calls)
})
test('known unavailable source-fresh local resume consumes only the memory ticket, not raw or GET', async () => {
  const f = fixture({ template: null })
  const restore = f.workflow.restore()
  f.workflow.setDescription('early source-fresh input')
  await restore
  assert.equal(f.storage.saved.has('session:4'), false)
  f.control.missing = true
  await f.workflow.refresh()
  const before = clone([...f.storage.saved]),
    writes = f.storage.writes.length,
    calls = f.calls.length
  const result = await f.workflow.resumeDraftSave({ target: 'local-input' })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(clone([...f.storage.saved]), before)
  assert.equal(f.storage.writes.length, writes)
  assert.equal(f.calls.length, calls)
  assert.equal(f.storage.saved.has('session:4'), false)
})
for (const outcome of ['success', 'failure']) {
  test(`old source-fresh resume ${outcome} cannot project after 404 and recheck200`, async () => {
    const f = fixture({ template: null })
    const restore = f.workflow.restore()
    f.workflow.setDescription('early source-fresh input')
    await restore
    const held = gate(),
      originalGet = f.api.getSession
    let heldOnce = false
    f.api.getSession = async (args) => {
      if (!heldOnce) {
        heldOnce = true
        return held.promise
      }
      return originalGet(args)
    }
    const pending = f.workflow.resumeDraftSave({ target: 'local-input' })
    await settle()
    assert.equal(heldOnce, true)
    await absentThenReadable(f)
    const raw = clone([...f.storage.saved]),
      before = clone(f.workflow.getSnapshot()),
      writes = f.storage.writes.length,
      calls = f.calls.length
    if (outcome === 'failure') held.reject(Error('old source error'))
    else held.resolve(await f.base.api.getSession({ sessionId: 4 }))
    await pending
    assert.deepEqual(clone([...f.storage.saved]), raw)
    assert.deepEqual(clone(f.workflow.getSnapshot()), before)
    assert.equal(f.storage.writes.length, writes)
    assert.equal(f.calls.length, calls)
  })
}

for (const kind of ['404', 'html', 'wrong-id', '401', '503', 'transport']) {
  test(`explicit failed recheck ${kind} remains latched without involuntary writes or automatic retry`, async () => {
    const f = fixture({ saved: new Map([['session:4', ordinary()]]), control: { missing: true } })
    await f.workflow.restore()
    const epoch = f.workflow.getSnapshot().sessionAvailability.terminalEpoch
    const before = clone([...f.storage.saved])
    f.control.missing = kind === '404'
    if (kind === 'html') f.control.sessionResponse = { statusCode: 404, data: '<html>404</html>' }
    if (kind === 'wrong-id')
      f.control.sessionResponse = response({
        ...(await f.base.api.getSession({ sessionId: 4 })),
        id: 8
      })
    if (kind === '401' || kind === '503')
      f.control.sessionResponse = {
        statusCode: Number(kind),
        data: {
          error: {
            code: kind === '401' ? 'UNAUTHENTICATED' : 'DATA_INTEGRITY_CONFLICT',
            message: 'failure',
            retryable: false
          },
          requestId: 'r'
        }
      }
    if (kind === 'transport') f.control.transport = true
    await f.workflow.recheckSession()
    assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unavailable')
    assert.equal(f.workflow.getSnapshot().sessionAvailability.terminalEpoch, epoch)
    assert.equal(f.workflow.getSnapshot().readRecovery.nextAttemptAt, null)
    const calls = f.calls.length
    await f.workflow.refresh({ reason: 'show' })
    await f.workflow.refresh({ reason: 'poll' })
    await f.workflow.restore()
    assert.equal(f.calls.length, calls)
    assert.deepEqual(clone([...f.storage.saved]), before)
    assert.equal(f.storage.writes.length, 0)
  })
}
test('typed404 from source-fresh resume itself publishes the same unique terminal fact', async () => {
  const f = fixture({ template: null })
  const restore = f.workflow.restore()
  f.workflow.setDescription('early input')
  await restore
  f.control.missing = true
  const raw = clone([...f.storage.saved]),
    writes = f.storage.writes.length
  await f.workflow.resumeDraftSave({ target: 'local-input' })
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unavailable')
  assert.equal(f.workflow.getSnapshot().sessionAvailability.terminalEpoch, 1)
  assert.deepEqual(clone([...f.storage.saved]), raw)
  assert.equal(f.storage.writes.length, writes)
})
test('independent quote and favorite errors keep their owner across authoritative404', async () => {
  const f = await readyFixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [66] })],
        hasMore: false,
        nextCursor: null
      })
    }
  })
  f.workflow.expireQuote()
  f.api.quote = async () => {
    throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT' })
  }
  await f.workflow.prepareQuote()
  const quoteError = f.workflow.getSnapshot().error
  f.control.missing = true
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().error, quoteError)
  assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
  f.api.favorite = async () => {
    throw Error('favorite failure')
  }
  await f.workflow.toggleFavorite(66)
  const favoriteError = f.workflow.getSnapshot().error
  await f.workflow.recheckSession()
  assert.equal(f.workflow.getSnapshot().error, favoriteError)
})

test('hide during terminal emit cancels queued recheck without losing terminal phase or scheduling another GET', async () => {
  const f = fixture({ control: { missing: true } })
  let recheck
  f.workflow.subscribe(() => {
    if (!recheck && f.workflow.getSnapshot().sessionAvailability.status === 'unavailable') {
      recheck = f.workflow.recheckSession()
      f.workflow.setPageVisible({ visible: false })
    }
  })
  await f.workflow.restore()
  assert.equal((await recheck).status, 'cancelled')
  assert.equal(f.workflow.getSnapshot().readRecovery.phase, 'unavailable')
  assert.equal(f.workflow.getSnapshot().readRecovery.nextAttemptAt, null)
  assert.equal(f.calls.filter((c) => c.name === 'getSession').length, 1)
  assert.equal(f.storage.writes.length, 0)
})

test('independent owner private download remains usable after parent session404', async () => {
  const f = fixture({ control: { missing: true } })
  await f.workflow.restore()
  f.control.downloadResponse = { statusCode: 200, tempFilePath: '/owner-private.png' }
  assert.equal(await f.native.privateImage(90), '/owner-private.png')
  assert.equal(f.workflow.getSnapshot().sessionAvailability.status, 'unavailable')
  assert.equal(f.storage.writes.length, 0)
})

test('a fresh same-cursor caller after recheck never lends interest to an entirely obsolete page GET', async () => {
  const held = gate()
  let taskPages = 0
  const f = await readyFixture({
    api: {
      tasks: async () => {
        taskPages++
        if (taskPages === 1) return { items: [], hasMore: true, nextCursor: 'c1' }
        if (taskPages === 2) return held.promise
        return { items: [task({}, { id: 100, artifactIds: [] })], hasMore: false, nextCursor: null }
      }
    }
  })
  const rawBefore = clone([...f.storage.saved])
  const writesBefore = f.storage.writes.length
  const old = f.workflow.loadOlder()
  await settle()
  assert.equal(taskPages, 2, 'the old page is really waiting on its second API request')
  await absentThenReadable(f)
  const freshStart = f.calls.length
  const fresh = f.workflow.loadOlder()
  await settle()
  held.resolve({
    items: [task({}, { id: 99, artifactIds: [990] })],
    hasMore: false,
    nextCursor: null
  })
  assert.equal((await old).status, 'cancelled')
  assert.equal((await fresh).status, 'read')
  assert.equal(
    taskPages,
    3,
    'the fresh caller must issue its own fresh GET after the obsolete one settles'
  )
  assert.deepEqual(clone(f.workflow.getSnapshot().rounds.map((round) => round.id)), [100])
  assert.deepEqual(
    f.calls.slice(freshStart).map((call) => call.name),
    ['tasks']
  )
  assert.deepEqual(clone([...f.storage.saved]), rawBefore)
  assert.equal(f.storage.writes.length, writesBefore)
  assert.equal(f.workflow.getSnapshot().error, '')
})

function genericHistory() {
  const held = gate()
  const cursors = [],
    merged = [],
    artifactReads = []
  const history = { sessionId: 4, rounds: [], olderCursor: null, hasOlder: false }
  const controller = load('src/features/creation/task-history.js').createTaskHistory({
    api: {
      tasks: async ({ cursor }) => {
        cursors.push(cursor)
        if (cursors.length === 1) return { items: [], hasMore: true, nextCursor: 'c1' }
        if (cursors.length === 2) return held.promise
        return {
          items: [task({}, { id: 100, artifactIds: [1000] })],
          hasMore: false,
          nextCursor: null
        }
      },
      task: async () => task()
    },
    readHistory: () => history,
    mergePage: ({ page, advance, isInterested }) => {
      assert.equal(isInterested(), true)
      merged.push(...page.items.map((item) => item.id))
      history.rounds.push(...page.items)
      if (advance) {
        history.olderCursor = page.nextCursor
        history.hasOlder = page.hasMore
      }
    },
    mergeTarget: () => assert.fail('these tests must not execute target focus'),
    setLoadingOlder: () => {},
    readArtifacts: async ({ rounds }) => {
      artifactReads.push(...rounds.flatMap((round) => round.artifactIds || []))
      return 'fresh'
    },
    isCurrent: () => true,
    canFocus: () => true
  })
  return { controller, held, cursors, merged, artifactReads, history }
}
for (const staleOutcome of ['success', 'reject', 'malformed']) {
  test(`all-dead generic flight ${staleOutcome} serializes two new callers onto one fresh same-cursor GET`, async () => {
    const f = genericHistory()
    await f.controller.readLatest()
    let oldLive = true
    const old = f.controller.readOlder({ isInterested: () => oldLive })
    await settle()
    assert.deepEqual(f.cursors, [undefined, 'c1'])
    oldLive = false
    const freshA = f.controller.readOlder()
    const freshB = f.controller.readOlder()
    await settle()
    assert.equal(f.cursors.length, 2, 'no concurrent replacement request before old settlement')
    if (staleOutcome === 'reject') f.held.reject(Error('obsolete request failure'))
    else
      f.held.resolve(
        staleOutcome === 'malformed'
          ? { malformed: true }
          : {
              items: [task({}, { id: 99, artifactIds: [990] })],
              hasMore: true,
              nextCursor: 'stale-cursor'
            }
      )
    assert.equal((await old).status, 'cancelled')
    assert.equal((await freshA).status, 'read')
    assert.equal((await freshB).status, 'read')
    assert.deepEqual(f.cursors, [undefined, 'c1', 'c1'])
    assert.deepEqual(f.merged, [100])
    assert.deepEqual(f.artifactReads, [1000])
    assert.equal(f.history.hasOlder, false)
    assert.equal(f.history.olderCursor, null)
  })
}
test('generic surviving old caller permits new coalescing while the cancelled caller stays cancelled', async () => {
  const f = genericHistory()
  await f.controller.readLatest()
  let oldLive = true
  const old = f.controller.readOlder({ isInterested: () => oldLive })
  await settle()
  const survivor = f.controller.readOlder()
  oldLive = false
  const newcomer = f.controller.readOlder()
  f.held.resolve({
    items: [task({}, { id: 99, artifactIds: [990] })],
    hasMore: false,
    nextCursor: null
  })
  assert.equal((await old).status, 'cancelled')
  assert.equal((await survivor).status, 'read')
  assert.equal((await newcomer).status, 'read')
  assert.deepEqual(f.cursors, [undefined, 'c1'])
  assert.deepEqual(f.merged, [99])
  assert.deepEqual(f.artifactReads, [990])
})
test('new generic caller losing interest while waiting neither borrows stale facts nor sends a fresh GET', async () => {
  const f = genericHistory()
  await f.controller.readLatest()
  let oldLive = true,
    newLive = true
  const old = f.controller.readOlder({ isInterested: () => oldLive })
  await settle()
  oldLive = false
  const fresh = f.controller.readOlder({ isInterested: () => newLive })
  await settle()
  newLive = false
  f.held.resolve({
    items: [task({}, { id: 99, artifactIds: [990] })],
    hasMore: false,
    nextCursor: null
  })
  assert.equal((await old).status, 'cancelled')
  assert.equal((await fresh).status, 'cancelled')
  assert.deepEqual(f.cursors, [undefined, 'c1'])
  assert.deepEqual(f.merged, [])
  assert.deepEqual(f.artifactReads, [])
  assert.equal(f.history.olderCursor, 'c1')
  assert.equal(f.history.hasOlder, true)
})

for (const outcome of ['success', 'failure']) {
  test(`old remote carry-preview retry ${outcome} never revives across 404 and recheck200`, async () => {
    const held = gate()
    let previews = 0
    const record = ordinary({
      photos: [{ id: 'preview-photo', path: '', mediaId: 7, status: 'ready' }]
    })
    const f = fixture({
      saved: new Map([['session:4', record]]),
      files: {
        exists: async () => false,
        preview: async () => {
          previews++
          if (previews === 1) throw Error('initial private preview failure')
          return held.promise
        }
      }
    })
    await f.workflow.restore()
    assert.equal(f.workflow.getSnapshot().errorAction, 'carry-preview')
    const pending = f.workflow.retryError()
    await settle()
    assert.equal(previews, 2, 'the old remote preview really reached its held await')
    await absentThenReadable(f)
    f.api.quote = async () => {
      throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT' })
    }
    await f.workflow.prepareQuote()
    assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
    const before = clone(f.workflow.getSnapshot()),
      raw = clone([...f.storage.saved])
    const writes = f.storage.writes.length,
      calls = f.calls.length
    if (outcome === 'failure') held.reject(Error('obsolete private preview failure'))
    else held.resolve('/late-private.png')
    await pending
    assert.deepEqual(clone(f.workflow.getSnapshot()), before)
    assert.deepEqual(clone([...f.storage.saved]), raw)
    assert.equal(f.storage.writes.length, writes)
    assert.equal(f.calls.length, calls)
    assert.equal(previews, 2)
    assert.equal(f.workflow.getSnapshot().photos[0].path, '')
  })
}
test('current healthy private preview retry still projects its path without changing raw storage', async () => {
  let previews = 0
  const record = ordinary({
    photos: [{ id: 'preview-photo', path: '', mediaId: 7, status: 'ready' }]
  })
  const f = fixture({
    saved: new Map([['session:4', record]]),
    files: {
      exists: async () => false,
      preview: async () => {
        previews++
        if (previews === 1) throw Error('initial private preview failure')
        return '/current-private.png'
      }
    }
  })
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().errorAction, 'carry-preview')
  const raw = clone([...f.storage.saved]),
    writes = f.storage.writes.length
  await f.workflow.retryError()
  assert.equal(previews, 2)
  assert.equal(f.workflow.getSnapshot().photos[0].path, '/current-private.png')
  assert.notEqual(f.workflow.getSnapshot().errorAction, 'carry-preview')
  assert.deepEqual(clone([...f.storage.saved]), raw)
  assert.equal(f.storage.writes.length, writes)
})

for (const pickerLifecycle of ['foreground', 'native-hide-show']) {
  test(`healthy replacement ${pickerLifecycle} genuinely saves and uploads one selected photo`, async () => {
    const held = gate()
    let choices = 0,
      uploads = 0
    const photo = { id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }
    const f = fixture({
      saved: new Map([['session:4', ordinary({ photos: [photo], carryBackSourceTaskId: 9 })]]),
      files: {
        choose: async () => {
          choices++
          return held.promise
        },
        upload: async () => {
          uploads++
          return { id: 88 }
        }
      }
    })
    await f.workflow.restore()
    const writes = f.storage.writes.length
    const pending = f.workflow.replacePhoto({ id: photo.id })
    assert.equal(choices, 1)
    if (pickerLifecycle === 'native-hide-show') {
      f.workflow.setPageVisible({ visible: false })
      f.workflow.setPageVisible({ visible: true })
    }
    held.resolve([{ path: '/picked.png', size: 12, mimeType: 'image/png' }])
    await pending
    await settle()
    assert.equal(uploads, 1, 'the accepted native return must actually enter upload')
    assert.ok(f.storage.writes.length > writes)
    assert.equal(f.workflow.getSnapshot().sessionAvailability.terminalEpoch, 0)
    const replacement = f.workflow.getSnapshot().photos[0]
    assert.notEqual(replacement.id, photo.id)
    assert.equal(replacement.status, 'ready')
    assert.equal(replacement.mediaId, 88)
    assert.equal(f.storage.saved.get('session:4').photos[0].mediaId, 88)
    assert.equal(f.storage.saved.get('session:4').photos[0].status, 'ready')
  })
}

for (const invalidation of [
  'hidden',
  'owner',
  'edit',
  'slot-removed',
  'source',
  'terminal-crossing'
]) {
  test(`native replacement return rejects changed ${invalidation} context without save or upload`, async () => {
    const held = gate()
    let uploads = 0,
      current = true
    const photo = { id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }
    const saved = new Map([
      ['session:4', ordinary({ photos: [photo], carryBackSourceTaskId: 9, draftPaused: true })]
    ])
    const f = fixture({
      saved,
      isCurrent: () => current,
      files: {
        choose: async () => held.promise,
        upload: async () => {
          uploads++
          return { id: 88 }
        }
      }
    })
    await f.workflow.restore()
    const pending = f.workflow.replacePhoto({ id: photo.id })
    f.workflow.setPageVisible({ visible: false })
    if (invalidation !== 'hidden') f.workflow.setPageVisible({ visible: true })
    if (invalidation === 'owner') current = false
    if (invalidation === 'edit') f.workflow.setDescription('new user intent')
    if (invalidation === 'slot-removed') f.workflow.removePhoto(photo.id)
    if (invalidation === 'source')
      saved.set(
        'session:4',
        ordinary({
          description: 'changed external source',
          photos: [photo],
          carryBackSourceTaskId: 9,
          draftPaused: true
        })
      )
    if (invalidation === 'terminal-crossing') await absentThenReadable(f)
    await settle()
    const before = clone([...saved]),
      writes = f.storage.writes.length
    held.resolve([{ path: '/obsolete-picked.png', size: 12, mimeType: 'image/png' }])
    await pending
    await settle()
    assert.equal(uploads, 0)
    assert.equal(f.storage.writes.length, writes)
    assert.deepEqual(clone([...saved]), before)
    assert.equal(
      f.workflow.getSnapshot().photos.some((slot) => slot.path === '/obsolete-picked.png'),
      false
    )
    if (invalidation === 'terminal-crossing')
      assert.equal(f.workflow.getSnapshot().sessionAvailability.terminalEpoch, 1)
  })
}
for (const callback of [
  'admission-hide-show',
  'makeId-hide-show',
  'makeId-edit',
  'makeId-source'
]) {
  test(`replacement fresh return frame rejects ${callback} callback reentry before publication`, async () => {
    const held = gate()
    let uploads = 0,
      choices = 0,
      armed = false,
      invalidated = false
    let f
    const photo = { id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }
    const raw = ordinary({ photos: [photo], carryBackSourceTaskId: 9, draftPaused: true })
    const saved = new Map([['session:4', raw]])
    let checkpoint
    const invalidate = () => {
      if (invalidated) return
      invalidated = true
      if (callback.includes('hide-show')) {
        f.workflow.setPageVisible({ visible: false })
        f.workflow.setPageVisible({ visible: true })
      } else if (callback === 'makeId-edit') f.workflow.setDescription('newer callback edit')
      else saved.set('session:4', ordinary({ ...raw, description: 'newer external source' }))
      checkpoint = { raw: clone([...saved]), writes: f.storage.writes.length }
    }
    f = fixture({
      saved,
      makeId: () => {
        if (armed && callback.startsWith('makeId')) invalidate()
        return 'replacement-id'
      },
      files: {
        choose: async () => {
          choices++
          return held.promise
        },
        upload: async () => {
          uploads++
          return { id: 88 }
        }
      }
    })
    await f.workflow.restore()
    const pending = f.workflow.replacePhoto({ id: photo.id })
    assert.equal(choices, 1)
    f.workflow.setPageVisible({ visible: false })
    f.workflow.setPageVisible({ visible: true })
    const get = f.storage.get
    f.storage.get = (key) => {
      const value = get(key)
      if (armed && callback === 'admission-hide-show' && key === 'session:4') invalidate()
      return value
    }
    armed = true
    held.resolve([{ path: '/callback-picked.png', size: 12, mimeType: 'image/png' }])
    await pending
    await settle()
    assert.equal(invalidated, true, 'the named callback actually ran after chooser return')
    assert.equal(uploads, 0)
    assert.equal(f.storage.writes.length, checkpoint.writes)
    assert.deepEqual(clone([...saved]), checkpoint.raw)
    assert.equal(
      f.workflow.getSnapshot().photos.some((slot) => slot.path === '/callback-picked.png'),
      false
    )
  })
}
