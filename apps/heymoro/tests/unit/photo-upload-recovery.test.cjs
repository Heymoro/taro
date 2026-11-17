const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { fixture, ordinary, frozen, frozenMap, clone, gate } = require('../fixtures/session-unavailable.cjs')

const settle = () => new Promise(setImmediate)
const pick = (id = 'a') => ({ path: `/${id}.png`, name: id, size: 12, mimeType: 'image/png' })
const slot = (status, id = 'local') => ({ ...pick(id), id, status })
const seed = (photos = []) => new Map([['session:4', ordinary({ photos })]])
const facts = (f) => ({
  snapshot: clone(f.workflow.getSnapshot()),
  raw: clone([...f.storage.saved]),
  writes: f.storage.writes.length,
  calls: f.calls.length,
})
const unchangedIO = (f, before) => {
  assert.deepEqual(clone([...f.storage.saved]), before.raw)
  assert.equal(f.storage.writes.length, before.writes)
  assert.equal(f.calls.length, before.calls)
}

for (const publication of ['pending', 'uploading']) {
  test(`${publication} publication interrupted by hide/show explicitly resumes after batch release`, async (t) => {
    let uploads = 0,
      stopped = false
    const f = fixture({
      saved: seed(),
      files: {
        choose: async () => [pick()],
        upload: async () => {
          uploads++
          return { id: 88 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    const text = f.workflow.getSnapshot().description
    f.workflow.subscribe(() => {
      if (!stopped && f.workflow.getSnapshot().photos.some((p) => p.status === publication)) {
        stopped = true
        f.workflow.setPageVisible({ visible: false })
        f.workflow.setPageVisible({ visible: true })
      }
    })
    await f.workflow.addPhotos()
    assert.equal(stopped, true)
    assert.equal(uploads, 0)
    const before = facts(f),
      photo = before.snapshot.photos[0]
    assert.equal(photo.status, publication)
    assert.deepEqual(before.snapshot.controls.activeUploadIds, [])
    assert.equal(before.snapshot.controls.photoBatchBusy, false)
    await f.workflow.resumePhoto(photo.id)
    assert.equal(uploads, 1)
    assert.equal(f.workflow.getSnapshot().photos[0].status, 'ready')
    assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 88)
    assert.equal(f.workflow.getSnapshot().photos[0].id, photo.id)
    assert.equal(f.workflow.getSnapshot().description, text)
  })
}

for (const outcome of ['success', 'failure'])
  for (const hidden of [false, true]) {
    test(`obsolete held upload ${outcome}, settle hidden=${hidden}, releases runtime only then accepts one fresh resume`, async (t) => {
      const held = gate()
      let uploads = 0
      const f = fixture({
        saved: seed(),
        files: { choose: async () => [pick()], upload: async () => (++uploads === 1 ? held.promise : { id: 99 }) },
      })
      t.after(() => f.workflow.dispose())
      await f.workflow.restore()
      const pending = f.workflow.addPhotos()
      await settle()
      const id = f.workflow.getSnapshot().photos[0].id
      assert.deepEqual(clone(f.workflow.getSnapshot().controls.activeUploadIds), [id])
      assert.equal(f.workflow.getSnapshot().controls.photoBatchBusy, true)
      f.workflow.setPageVisible({ visible: false })
      if (!hidden) f.workflow.setPageVisible({ visible: true })
      await f.workflow.resumePhoto(id)
      await f.workflow.retryPhoto(id)
      assert.equal(uploads, 1)
      const before = facts(f)
      let emissions = 0
      const off = f.workflow.subscribe(() => emissions++)
      if (outcome === 'success') held.resolve({ id: 7 })
      else held.reject(Error('obsolete failure'))
      await pending
      off()
      assert.ok(emissions > 0, 'settlement publishes without needing a refresh')
      const expected = clone(before.snapshot)
      expected.controls.activeUploadIds = []
      expected.controls.photoBatchBusy = false
      assert.deepEqual(clone(f.workflow.getSnapshot()), expected)
      unchangedIO(f, before)
      if (hidden) f.workflow.setPageVisible({ visible: true })
      await Promise.all([f.workflow.resumePhoto(id), f.workflow.resumePhoto(id)])
      assert.equal(uploads, 2)
      assert.equal(f.workflow.getSnapshot().photos[0].status, 'ready')
      assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 99)
      assert.deepEqual(clone(f.workflow.getSnapshot().controls.activeUploadIds), [])
    })
  }

for (const firstOutcome of ['success', 'failure']) {
  test(`queued pending cannot start early; original batch first ${firstOutcome} uploads each path once`, async (t) => {
    const held = gate(),
      paths = []
    let sequence = 0
    const f = fixture({
      saved: seed(),
      makeId: () => `slot-${++sequence}`,
      files: {
        choose: async () => [pick('a'), pick('b'), pick('c')],
        upload: async (path) => {
          paths.push(path)
          return path === '/a.png' ? held.promise : { id: 20 + paths.length }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    const pending = f.workflow.addPhotos()
    await settle()
    const ids = f.workflow.getSnapshot().photos.map((p) => p.id)
    await Promise.all([f.workflow.resumePhoto(ids[1]), f.workflow.resumePhoto(ids[1])])
    assert.deepEqual(paths, ['/a.png'])
    if (firstOutcome === 'success') held.resolve({ id: 21 })
    else held.reject(Error('first failed'))
    await pending
    assert.deepEqual(paths, ['/a.png', '/b.png', '/c.png'])
    assert.deepEqual(
      Array.from(f.workflow.getSnapshot().photos, (p) => p.id),
      Array.from(ids)
    )
    assert.equal(f.workflow.getSnapshot().controls.photoBatchBusy, false)
    assert.deepEqual(clone(f.workflow.getSnapshot().controls.activeUploadIds), [])
    assert.deepEqual(
      Array.from(f.workflow.getSnapshot().photos, (p) => p.status),
      [firstOutcome === 'success' ? 'ready' : 'failed', 'ready', 'ready']
    )
    await f.workflow.resumePhoto(ids[1])
    assert.equal(paths.length, 3, 'ready slot is not uploaded again')
    if (firstOutcome === 'failure') {
      await f.workflow.retryPhoto(ids[0])
      assert.deepEqual(paths, ['/a.png', '/b.png', '/c.png', '/a.png'], 'original failed retry remains explicit')
    }
  })
}

for (const persisted of ['pending', 'uploading']) {
  test(`cold ${persisted} retains order and text, never auto uploads, fresh resume leaves other slots intact`, async (t) => {
    let uploads = 0
    const photos = [slot(persisted), { ...slot('ready', 'other'), mediaId: 7 }]
    const f = fixture({
      saved: seed(photos),
      files: {
        upload: async () => {
          uploads++
          return { id: 99 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    const raw = clone([...f.storage.saved])
    await f.workflow.restore()
    assert.equal(uploads, 0)
    assert.equal(f.storage.writes.length, 0)
    assert.deepEqual(clone([...f.storage.saved]), raw)
    const before = clone(f.workflow.getSnapshot())
    assert.equal(before.photos[0].status, persisted === 'uploading' ? 'failed' : 'pending')
    assert.deepEqual(before.controls.activeUploadIds, [])
    await f.workflow.resumePhoto('local')
    assert.equal(uploads, 1)
    assert.equal(f.workflow.getSnapshot().description, before.description)
    assert.deepEqual(clone(f.workflow.getSnapshot().photos[1]), before.photos[1])
    assert.deepEqual(
      Array.from(f.workflow.getSnapshot().photos, (p) => p.id),
      ['local', 'other']
    )
  })
}

test('real generate F admits explicit new draft upload while retaining exact frozen request and envelope', async (t) => {
  let uploads = 0,
    stopped = false
  const f = fixture({
    saved: frozenMap(frozen('generate')),
    files: {
      choose: async () => [pick()],
      upload: async () => {
        uploads++
        return { id: 99 }
      },
    },
  })
  t.after(() => f.workflow.dispose())
  await f.workflow.restore()
  const original = clone(f.workflow.getSnapshot().submission)
  f.workflow.subscribe(() => {
    if (!stopped && f.workflow.getSnapshot().photos.some((p) => p.status === 'pending')) {
      stopped = true
      f.workflow.setPageVisible({ visible: false })
      f.workflow.setPageVisible({ visible: true })
    }
  })
  await f.workflow.addPhotos()
  assert.equal(uploads, 0)
  assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, true)
  await f.workflow.resumePhoto(f.workflow.getSnapshot().photos[0].id)
  assert.equal(uploads, 1)
  for (const record of [
    f.workflow.getSnapshot(),
    f.storage.saved.get('session:4'),
    f.storage.saved.get('unsettled:session:4').record,
  ])
    assert.deepEqual(clone(record.submission), original)
  assert.ok(
    load('src/features/creation/recovery-contract.js').readUnsettledRecord({ record: f.storage.saved.get('session:4') })
  )
  assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 99)
  assert.deepEqual(original.body.input.inputMediaIds, [])
})

for (const invalidation of ['remove', 'owner', 'dispose', 'terminal']) {
  test(`held upload after ${invalidation} does not write photos or accept an old callback`, async (t) => {
    const held = gate()
    let current = true,
      uploads = 0
    const f = fixture({
      saved: seed([slot('pending')]),
      isCurrent: () => current,
      files: {
        upload: async () => {
          uploads++
          return held.promise
        },
      },
    })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    const callback = () => f.workflow.resumePhoto('local')
    const pending = callback()
    await settle()
    if (invalidation === 'remove') f.workflow.removePhoto('local')
    if (invalidation === 'owner') current = false
    if (invalidation === 'dispose') f.workflow.dispose()
    if (invalidation === 'terminal') {
      f.control.missing = true
      await f.workflow.refresh()
      await callback()
      assert.equal(uploads, 1)
      f.control.missing = false
      await f.workflow.recheckSession()
    }
    await settle()
    const before = facts(f)
    let emissions = 0
    const off = f.workflow.subscribe(() => emissions++)
    held.resolve({ id: 88 })
    await pending
    off()
    const expected = clone(before.snapshot)
    if (['remove', 'terminal'].includes(invalidation)) expected.controls.activeUploadIds = []
    assert.deepEqual(clone(f.workflow.getSnapshot()), expected)
    unchangedIO(f, before)
    if (['owner', 'dispose'].includes(invalidation)) assert.equal(emissions, 0)
    if (invalidation !== 'terminal') {
      await callback()
      assert.equal(uploads, 1)
      unchangedIO(f, before)
    }
  })
}

test('resume with unreadable initial source is zero upload and zero IO', async (t) => {
  let uploads = 0
  const f = fixture({
    saved: seed([slot('pending')]),
    files: {
      upload: async () => {
        uploads++
        return { id: 8 }
      },
    },
  })
  t.after(() => f.workflow.dispose())
  f.storage.get = () => {
    throw Error('source not readable')
  }
  const before = facts(f)
  await f.workflow.resumePhoto('local')
  assert.equal(uploads, 0)
  unchangedIO(f, before)
})

test('interrupted original batch leaves queued slots pending until individual explicit resume', async (t) => {
  const held = gate(),
    paths = []
  let sequence = 0
  const f = fixture({
    saved: seed(),
    makeId: () => `slot-${++sequence}`,
    files: {
      choose: async () => [pick('a'), pick('b'), pick('c')],
      upload: async (path) => {
        paths.push(path)
        return path === '/a.png' ? held.promise : { id: 99 }
      },
    },
  })
  t.after(() => f.workflow.dispose())
  const pending = f.workflow.addPhotos()
  await settle()
  f.workflow.setPageVisible({ visible: false })
  f.workflow.setPageVisible({ visible: true })
  held.resolve({ id: 88 })
  await pending
  assert.deepEqual(paths, ['/a.png'])
  assert.deepEqual(
    Array.from(f.workflow.getSnapshot().photos, (p) => p.status),
    ['uploading', 'pending', 'pending']
  )
  assert.equal(f.workflow.getSnapshot().controls.photoBatchBusy, false)
  const second = f.workflow.getSnapshot().photos[1].id
  await Promise.all([f.workflow.resumePhoto(second), f.workflow.resumePhoto(second)])
  assert.deepEqual(paths, ['/a.png', '/b.png'])
  assert.equal(
    f.workflow.getSnapshot().photos[2].status,
    'pending',
    'fresh continue never resumes the rest of an obsolete batch'
  )
})

for (const kind of ['zero', 'missing-decoded', 'fractional', 'unsafe']) {
  test(`new stale resume after real refresh ${kind} config is zero IO, then valid config explicitly resumes`, async (t) => {
    let uploads = 0,
      configReads = 0
    const f = fixture({
      saved: seed([slot('pending')]),
      files: {
        upload: async () => {
          uploads++
          return { id: 99 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    assert.equal(f.workflow.getSnapshot().template.inputSchema.maxImages, 8)
    const staleCallback = () => f.workflow.resumePhoto('local')
    const config = clone(f.base.template)
    if (kind === 'zero') config.inputSchema.maxImages = 0
    if (kind === 'missing-decoded') delete config.inputSchema.maxImages
    if (kind === 'fractional') config.inputSchema.maxImages = 1.5
    if (kind === 'unsafe') config.inputSchema.maxImages = Number.MAX_SAFE_INTEGER + 1
    let responseConfig = config
    const decoded = load('src/creation-api.js', {
      '@tarojs/taro': {
        request: async () => {
          configReads++
          return { statusCode: 200, data: { data: responseConfig, requestId: 'fresh-config' } }
        },
      },
      './auth': {
        getStoredSession: () => ({ userId: 1, token: 'memory', expiresAt: '2099-01-01' }),
        getStoredToken: () => 'memory',
        clearToken() {},
      },
    }).creationApi
    // The real decoder accepts max0 and rejects missing max; defensive malformed port DTOs
    // additionally exercise the wrapper's positive-safe-integer boundary after real refresh.
    f.api.freePreset = ['zero', 'missing-decoded'].includes(kind) ? decoded.freePreset : async () => config
    await f.workflow.refresh()
    if (kind === 'missing-decoded') assert.equal(f.workflow.getSnapshot().template, null)
    else assert.equal(f.workflow.getSnapshot().template.inputSchema.maxImages, config.inputSchema.maxImages)
    if (['zero', 'missing-decoded'].includes(kind)) assert.equal(configReads, 1)
    assert.equal(f.workflow.getSnapshot().photos[0].status, 'pending')
    const before = facts(f)
    await staleCallback()
    assert.equal(uploads, 0)
    assert.deepEqual(clone(f.workflow.getSnapshot()), before.snapshot)
    unchangedIO(f, before)
    responseConfig = clone(f.base.template)
    f.api.freePreset = decoded.freePreset
    await f.workflow.refresh()
    assert.equal(f.workflow.getSnapshot().template.inputSchema.maxImages, 8)
    assert.equal(f.workflow.getSnapshot().photos[0].status, 'pending')
    await staleCallback()
    assert.equal(uploads, 1)
    assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 99)
    assert.equal(f.workflow.getSnapshot().photos[0].status, 'ready')
  })
}
