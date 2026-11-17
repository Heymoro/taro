const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture, task } = require('../fixtures/creation.cjs')
const tick = () => new Promise(setImmediate)
const picks = ['a', 'b', 'c'].map((id) => ({ path: `/${id}.png`, size: 10, mimeType: 'image/png' }))
async function fixture(options = {}) {
  const calls = { put: [], quote: [] }
  let mediaId = 10
  const f = workflowFixture({
    ...options,
    files: { choose: async () => picks, upload: async () => ({ id: ++mediaId }), ...options.files },
    api: {
      putDraft: async (args) => {
        calls.put.push(args)
        return {}
      },
      quote: async (args) => {
        calls.quote.push(args)
        return { templateId: 1, quoteToken: 'new', costCredits: 3, validUntil: '2099-01-01' }
      },
      ...options.api
    }
  })
  f.workflow.setDescription('  unchanged  ')
  await f.workflow.addPhotos()
  await tick()
  return { ...f, calls }
}
const ids = (w) => Array.from(w.getSnapshot().photos, (p) => p.id)
const move = (w, slotId, targetIndex, expectedIds = ids(w)) =>
  w.movePhoto({ slotId, targetIndex, expectedIds })

test('workflow moves three photos first/last and one step from current objects, persisting full ordered input', async () => {
  const { workflow: w, saved, calls } = await fixture()
  assert.equal(typeof w.movePhoto, 'function', 'workflow exposes real move entry')
  const [a, b, c] = ids(w)
  const original = w.getSnapshot().photos[0]
  assert.equal(move(w, a, 2), true)
  assert.deepEqual(ids(w), [b, c, a])
  assert.equal(w.getSnapshot().photos[2], original)
  assert.equal(move(w, a, 1), true)
  assert.equal(move(w, a, 0), true)
  assert.deepEqual(ids(w), [a, b, c])
  await tick()
  assert.equal(w.getSnapshot().description, '  unchanged  ')
  assert.deepEqual(
    saved.get('session:4').photos.map((p) => p.id),
    [a, b, c]
  )
  assert.equal(calls.put.at(-1).input.inputMediaIds.length, 3)
})

test('invalid expected IDs, sparse arrays, duplicates, absent slots, bounds and same-position are strict zero writes', async () => {
  const f = await fixture(),
    w = f.workflow
  const currentIds = ids(w)
  const sparse = [...currentIds]
  delete sparse[1]
  for (const args of [
    { slotId: currentIds[0], targetIndex: 1, expectedIds: [] },
    { slotId: currentIds[0], targetIndex: 1, expectedIds: sparse },
    {
      slotId: currentIds[0],
      targetIndex: 1,
      expectedIds: [currentIds[0], currentIds[0], currentIds[2]]
    },
    { slotId: currentIds[0], targetIndex: 1, expectedIds: [...currentIds].reverse() },
    { slotId: 'absent', targetIndex: 1, expectedIds: currentIds },
    ...[-1, 3, 1.2, NaN, '1', 0].map((targetIndex) => ({
      slotId: currentIds[0],
      targetIndex,
      expectedIds: currentIds
    }))
  ]) {
    const before = w.getSnapshot(),
      writes = f.writes.length,
      puts = f.calls.put.length,
      quotes = f.calls.quote.length
    assert.equal(w.movePhoto(args), false)
    await tick()
    assert.equal(w.getSnapshot(), before)
    assert.equal(f.writes.length, writes)
    assert.equal(f.calls.put.length, puts)
    assert.equal(f.calls.quote.length, quotes)
  }
})

for (const reason of ['hidden', 'stale-account', 'disposed']) {
  test(`workflow ordering gate ${reason} performs zero writes`, async () => {
    let current = true
    const f = await fixture({ isCurrent: () => current }),
      w = f.workflow
    const expectedIds = ids(w)
    if (reason === 'hidden') w.setPageVisible({ visible: false })
    if (reason === 'stale-account') current = false
    if (reason === 'disposed') w.dispose()
    const before = w.getSnapshot(),
      writes = f.writes.length
    assert.equal(move(w, expectedIds[0], 2, expectedIds), false)
    assert.equal(w.getSnapshot(), before)
    assert.equal(f.writes.length, writes)
  })
}

for (const reason of ['submitting', 'submission', 'sessionRequest']) {
  test(`real frozen ${reason} gates reorder and preserves exact request body`, async () => {
    let finish
    const unknown = () => {
      throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
    }
    const f = await fixture({
      sessionId: reason === 'sessionRequest' ? null : 4,
      submit:
        reason === 'submitting'
          ? () =>
              new Promise((resolve) => {
                finish = resolve
              })
          : unknown,
      api: reason === 'sessionRequest' ? { createSession: unknown } : {}
    })
    const w = f.workflow
    if (reason !== 'sessionRequest') {
      await w.prepareQuote()
      const generation = w.generate()
      await tick()
      if (reason === 'submission') await generation
      else
        finish = ((resolve) => () => {
          resolve(task())
          return generation
        })(finish)
    }
    const frozen = w.getSnapshot()[reason === 'sessionRequest' ? reason : 'submission']
    assert.ok(frozen)
    assert.ok(Object.isFrozen(frozen))
    assert.equal(w.getSnapshot().controls.canReorderPhotos, false)
    const before = w.getSnapshot(),
      writes = f.writes.length,
      sent = JSON.stringify(f.sent)
    assert.equal(move(w, ids(w)[0], 2), false)
    assert.equal(w.getSnapshot(), before)
    assert.equal(f.writes.length, writes)
    assert.equal(JSON.stringify(f.sent), sent)
    if (reason === 'submitting') await finish()
  })
}

for (const reason of ['legacy', 'corrupt']) {
  test(`restored ${reason} record gates ordering without local or remote mutation`, async () => {
    const record =
      reason === 'legacy' ? { protocol: 1, description: 'legacy' } : { protocol: 2, submission: {} }
    const saved = new Map([['session:4', record]])
    const f = workflowFixture({ saved }),
      w = f.workflow
    await w.restore()
    assert.ok(w.getSnapshot()[reason === 'legacy' ? 'legacyRecord' : 'corruptPending'])
    const before = w.getSnapshot(),
      writes = f.writes.length
    assert.equal(w.movePhoto({ slotId: 'a', targetIndex: 1, expectedIds: ['a', 'b'] }), false)
    assert.equal(w.getSnapshot(), before)
    assert.equal(f.writes.length, writes)
    assert.equal(saved.get('session:4'), record)
  })
}

test('active running task and in-flight refresh permit new draft order without modifying history or paid generation', async () => {
  let resolveAccount
  const f = await fixture({
    api: { tasks: async () => ({ items: [task()], hasMore: false, nextCursor: null }) }
  })
  const w = f.workflow
  await w.refresh()
  const rounds = w.getSnapshot().rounds,
    artifacts = w.getSnapshot().artifacts
  f.api.account = () =>
    new Promise((resolve) => {
      resolveAccount = resolve
    })
  const refresh = w.refresh()
  assert.equal(w.getSnapshot().loading, false, 'background refresh does not show initial loader')
  assert.equal(w.getSnapshot().controls.canReorderPhotos, true)
  const beforeQuotes = f.calls.quote.length
  assert.equal(move(w, ids(w)[0], 2), true)
  await tick()
  assert.equal(f.calls.quote.length, beforeQuotes)
  assert.equal(w.getSnapshot().rounds, rounds)
  assert.equal(w.getSnapshot().artifacts, artifacts)
  assert.equal(f.sent.length, 0)
  resolveAccount({ configured: true })
  await refresh
  w.setPageVisible({ visible: false })
  assert.equal(w.getSnapshot().controls.canReorderPhotos, false)
  w.setPageVisible({ visible: true })
  assert.equal(w.getSnapshot().controls.canReorderPhotos, true)
})

test('move persists pending/uploading/failed slots and upload completion updates current order, not start snapshot', async () => {
  const pending = []
  const f = workflowFixture({
    files: {
      choose: async () => picks,
      upload: () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    }
  })
  const w = f.workflow
  const uploading = w.addPhotos()
  await tick()
  const [a, b, c] = ids(w)
  assert.deepEqual(
    Array.from(w.getSnapshot().photos, (p) => p.status),
    ['uploading', 'pending', 'pending']
  )
  assert.equal(move(w, a, 2), true)
  pending[0].resolve({ id: 10 })
  await tick()
  assert.deepEqual(ids(w), [b, c, a])
  assert.equal(w.getSnapshot().photos[2].mediaId, 10)
  pending[1].reject(Error('upload failed'))
  await tick()
  assert.equal(w.getSnapshot().photos[0].status, 'failed')
  assert.equal(move(w, c, 0), true)
  pending[2].resolve({ id: 12 })
  await uploading
  assert.deepEqual(ids(w), [c, b, a])
  assert.equal(w.getSnapshot().photos[0].mediaId, 12)
  assert.equal(w.getSnapshot().photos[1].status, 'failed')
})

test('unavailable repair keeps carry provenance and blocks new remote writes after reorder', async () => {
  const f = workflowFixture({
    api: {
      task: async () =>
        task(
          {},
          {
            status: 'succeeded',
            inputAvailability: [
              { mediaId: 15, position: 1, status: 'active' },
              { mediaId: 16, position: 2, status: 'unavailable' }
            ]
          }
        )
    }
  })
  const w = f.workflow
  const candidate = await w.prepareCarryBackInput({ taskId: 9 })
  await w.confirmCarryBackInput({ candidate })
  let puts = 0,
    quotes = 0
  f.api.putDraft = async () => {
    puts++
  }
  f.api.quote = async () => {
    quotes++
  }
  const first = w.getSnapshot().photos[0],
    missing = w.getSnapshot().photos[1]
  assert.equal(move(w, missing.id, 0), true)
  await tick()
  await w.prepareQuote()
  await w.generate()
  await w.resumeDraftSave()
  assert.equal(w.getSnapshot().photos[0], missing)
  assert.equal(w.getSnapshot().photos[1], first)
  assert.equal(w.getSnapshot().carryBackSourceTaskId, 9)
  assert.equal(puts, 0)
  assert.equal(quotes, 0)
  assert.equal(f.sent.length, 0)
})

test('old quote and carry candidates become inert; storage failure initiates zero new remote requests', async () => {
  const f = await fixture(),
    w = f.workflow
  let finishQuote
  w.expireQuote()
  f.api.quote = () =>
    new Promise((resolve) => {
      finishQuote = resolve
    })
  const oldQuote = w.prepareQuote()
  await tick()
  const oldFinish = finishQuote
  f.api.task = async () =>
    task(
      {},
      {
        status: 'succeeded',
        inputAvailability: [
          { mediaId: 15, position: 1, status: 'active' },
          { mediaId: 16, position: 2, status: 'active' }
        ]
      }
    )
  const candidate = await w.prepareCarryBackInput({ taskId: 9 })
  assert.ok(candidate)
  f.control.fail = () => true
  const puts = f.calls.put.length,
    quotes = f.calls.quote.length
  assert.equal(move(w, ids(w)[0], 2), false, 'failed local persistence returns false')
  await tick()
  oldFinish({ templateVersionId: 2, quoteToken: 'old', validUntil: '2099-01-01', costCredits: 3 })
  await oldQuote
  assert.equal(w.getSnapshot().quote, null)
  assert.ok(w.getSnapshot().storageError)
  assert.equal(f.calls.put.length, puts)
  assert.equal(f.calls.quote.length, quotes)
  assert.equal(await w.confirmCarryBackInput({ candidate }), false)
})

test('pure slot mover rejects malformed current identity arrays and preserves actual object references', () => {
  const { load } = require('../source.cjs')
  const { movePhotoSlot, orderedPhotoIds } = load('src/features/creation/photo-order.js')
  const a = { id: 'a' },
    b = { id: 'b' },
    c = { id: 'c' }
  const sparse = [a, b, c]
  delete sparse[1]
  for (const photos of [sparse, [a, a], [{ id: '' }], [{ id: 1 }], [null]])
    assert.equal(orderedPhotoIds({ photos }), null)
  const moved = movePhotoSlot({
    photos: [a, b, c],
    slotId: 'a',
    targetIndex: 2,
    expectedIds: ['a', 'b', 'c']
  })
  assert.equal(moved[2], a)
})

test('successful move clears regeneration source and quote without changing description, notes, history or artifacts', async () => {
  const f = await fixture(),
    w = f.workflow
  w.setUserNotes('notes unchanged')
  await w.prepareRegeneration(88)
  assert.equal(w.getSnapshot().sourceArtifactId, 88)
  const { rounds, artifacts, description, userNotes } = w.getSnapshot()
  assert.equal(move(w, ids(w)[0], 2), true)
  assert.equal(w.getSnapshot().sourceArtifactId, null)
  assert.equal(w.getSnapshot().quote, null)
  assert.equal(w.getSnapshot().rounds, rounds)
  assert.equal(w.getSnapshot().artifacts, artifacts)
  assert.equal(w.getSnapshot().description, description)
  assert.equal(w.getSnapshot().userNotes, userNotes)
  await tick()
  assert.equal(f.sent.length, 0)
})

test('new ordering identity contracts accept named object parameters', () => {
  const { load } = require('../source.cjs')
  const { orderedPhotoIds, samePhotoIds } = load('src/features/creation/photo-order.js')
  assert.deepEqual(Array.from(orderedPhotoIds({ photos: [{ id: 'a' }, { id: 'b' }] }) || []), [
    'a',
    'b'
  ])
  assert.equal(samePhotoIds({ left: ['a', 'b'], right: ['a', 'b'] }), true)
  assert.equal(samePhotoIds({ left: ['a', 'b'], right: ['b', 'a'] }), false)
})
