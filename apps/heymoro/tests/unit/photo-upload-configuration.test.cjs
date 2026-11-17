const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { template } = require('../fixtures/creation.cjs')
const { fixture, ordinary, frozen, frozenMap, clone, gate } = require('../fixtures/session-unavailable.cjs')

const settle = () => new Promise(setImmediate)
const pick = (id = 'new') => ({ path: `/${id}.png`, name: id, size: 12, mimeType: 'image/png' })
const slot = (status, id = 'local') => ({ ...pick(id), id, status })
const seed = (photos = [], extra = {}) => new Map([['session:4', ordinary({ photos, ...extra })]])
const facts = (f) => ({
  raw: clone([...f.storage.saved]),
  writes: f.storage.writes.length,
  photos: clone(f.workflow.getSnapshot().photos),
  description: f.workflow.getSnapshot().description,
  calls: f.calls.length,
})
const noInputIO = (f, before) => {
  assert.deepEqual(clone([...f.storage.saved]), before.raw)
  assert.equal(f.storage.writes.length, before.writes)
  assert.deepEqual(clone(f.workflow.getSnapshot().photos), before.photos)
  assert.equal(f.workflow.getSnapshot().description, before.description)
}
// The transport is in memory; configuration still crosses the production API decoder.
function configPort(kind) {
  const value = template()
  if (kind === 'zero') value.inputSchema.maxImages = 0
  if (kind === 'missing-decoded') delete value.inputSchema.maxImages
  if (kind === 'defensive-fractional') value.inputSchema.maxImages = 1.5
  if (kind === 'defensive-unsafe') value.inputSchema.maxImages = Number.MAX_SAFE_INTEGER + 1
  if (kind.startsWith('defensive-')) return async () => value
  return load('src/creation-api.js', {
    '@tarojs/taro': {
      request: async () => ({ statusCode: 200, data: { data: value, requestId: 'photo-config' } }),
    },
    './auth': {
      getStoredSession: () => ({ userId: 1, token: 'memory', expiresAt: '2099-01-01' }),
      getStoredToken: () => 'memory',
      clearToken() {},
    },
  }).creationApi.freePreset
}
async function configure(f, kind) {
  f.api.freePreset = configPort(kind)
  await f.workflow.refresh()
  const config = f.workflow.getSnapshot().template
  if (kind === 'missing-decoded') assert.equal(config, null, 'malformed response is not a zero-image config')
  else
    assert.equal(
      config.inputSchema.maxImages,
      kind === 'zero' ? 0 : kind === 'valid' ? 8 : kind === 'defensive-fractional' ? 1.5 : Number.MAX_SAFE_INTEGER + 1
    )
}
const invoke = (w, command) =>
  command === 'add'
    ? w.addPhotos()
    : command === 'replace'
    ? w.replacePhoto({ id: 'media:7' })
    : w[command === 'retry' ? 'retryPhoto' : 'resumePhoto']('local')
const commandPhotos = (command) =>
  command === 'replace'
    ? [{ id: 'media:7', path: '', status: 'unavailable', mediaId: 7 }]
    : [command === 'add' ? { ...slot('ready'), mediaId: 7 } : slot(command === 'retry' ? 'failed' : 'pending')]

for (const kind of ['zero', 'missing-decoded', 'defensive-fractional', 'defensive-unsafe']) {
  for (const command of ['retry', 'resume', 'add', 'replace']) {
    test(`${command} current ${kind} performs zero choose/upload/write; explicit restored-valid action works`, async (t) => {
      let choices = 0,
        uploads = 0
      const f = fixture({
        saved: seed(commandPhotos(command), { carryBackSourceTaskId: command === 'replace' ? 9 : null }),
        files: {
          choose: async () => {
            choices++
            return [pick()]
          },
          upload: async () => {
            uploads++
            return { id: 88 }
          },
        },
      })
      t.after(() => f.workflow.dispose())
      await f.workflow.restore()
      const staleCommand = () => invoke(f.workflow, command)
      await configure(f, kind)
      const before = facts(f)
      await staleCommand()
      assert.equal(choices, 0, 'invalid current configuration must not open a new chooser')
      assert.equal(uploads, 0, 'invalid current configuration must not send a new upload')
      noInputIO(f, before)
      assert.equal(f.calls.length, before.calls)
      assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, false)
      await configure(f, 'valid')
      assert.equal(uploads, 0, 'configuration recovery alone never retries')
      await staleCommand()
      assert.equal(uploads, 1)
      assert.equal(choices, ['add', 'replace'].includes(command) ? 1 : 0)
      assert.equal(f.workflow.getSnapshot().photos.at(-1).mediaId, 88)
    })
  }
}

for (const command of ['add', 'replace']) {
  for (const kind of ['zero', 'missing-decoded']) {
    for (const outcome of ['return', 'reject']) {
      test(`held ${command} chooser ${outcome} at current ${kind} preserves input, raw and current error`, async (t) => {
        const held = gate()
        let uploads = 0
        const f = fixture({
          saved: seed(commandPhotos(command), { carryBackSourceTaskId: command === 'replace' ? 9 : null }),
          files: {
            choose: () => held.promise,
            upload: async () => {
              uploads++
              return { id: 88 }
            },
          },
        })
        t.after(() => f.workflow.dispose())
        await f.workflow.restore()
        const pending = invoke(f.workflow, command)
        await configure(f, kind)
        const before = facts(f),
          error = f.workflow.getSnapshot().error
        if (outcome === 'return') held.resolve([pick()])
        else held.reject(Error('old picker failure'))
        await pending
        assert.equal(uploads, 0)
        noInputIO(f, before)
        assert.equal(
          f.workflow.getSnapshot().error,
          error,
          'old chooser error must not replace current config feedback'
        )
        assert.equal(f.workflow.getSnapshot().controls.photoBatchBusy, false)
      })
    }
    test(`held ${command} ${kind} then valid before native hide/show return remains live`, async (t) => {
      const held = gate()
      let uploads = 0
      const f = fixture({
        saved: seed(commandPhotos(command), { carryBackSourceTaskId: command === 'replace' ? 9 : null }),
        files: {
          choose: () => held.promise,
          upload: async () => {
            uploads++
            return { id: 88 }
          },
        },
      })
      t.after(() => f.workflow.dispose())
      await f.workflow.restore()
      const pending = invoke(f.workflow, command)
      await configure(f, kind)
      await configure(f, 'valid')
      f.workflow.setPageVisible({ visible: false })
      f.workflow.setPageVisible({ visible: true })
      held.resolve([pick()])
      await pending
      assert.equal(uploads, 1)
      assert.equal(f.workflow.getSnapshot().photos.at(-1).mediaId, 88)
    })
  }
}

for (const kind of ['zero', 'missing-decoded']) {
  for (const outcome of ['success', 'failure']) {
    for (const command of ['retry', 'batch']) {
      test(`already-sent ${command} ${outcome} receipt survives current ${kind}, with no tail PUT/quote/next upload`, async (t) => {
        const held = gate(),
          paths = []
        let sequence = 0
        const f = fixture({
          saved: seed(command === 'retry' ? [slot('failed')] : []),
          makeId: () => `config-slot-${++sequence}`,
          files: {
            choose: async () => [pick('a'), pick('b')],
            upload: async (path) => {
              paths.push(path)
              return paths.length === 1 ? held.promise : { id: 99 }
            },
          },
        })
        t.after(() => f.workflow.dispose())
        await f.workflow.restore()
        const pending = command === 'retry' ? f.workflow.retryPhoto('local') : f.workflow.addPhotos()
        await settle()
        assert.equal(paths.length, 1)
        await configure(f, kind)
        const before = facts(f),
          ids = before.photos.map((p) => p.id)
        if (outcome === 'success') held.resolve({ id: 88 })
        else held.reject(Error('upload failed'))
        await pending
        await settle()
        const photos = clone(f.workflow.getSnapshot().photos)
        assert.equal(photos[0].status, outcome === 'success' ? 'ready' : 'failed')
        if (outcome === 'success') assert.equal(photos[0].mediaId, 88)
        assert.deepEqual(
          photos.map((p) => p.id),
          ids
        )
        assert.equal(f.workflow.getSnapshot().description, before.description)
        assert.deepEqual(paths, [command === 'retry' ? '/local.png' : '/a.png'])
        assert.deepEqual(
          f.calls.slice(before.calls).map((c) => c.name),
          []
        )
        assert.deepEqual(clone(f.storage.saved.get('session:4').photos), photos)
        if (command === 'batch') {
          assert.deepEqual(photos[1], before.photos[1])
          assert.equal(photos[1].status, 'pending')
          await configure(f, 'valid')
          assert.equal(paths.length, 1, 'old batch does not restart when configuration returns')
          await f.workflow.resumePhoto(photos[1].id)
          assert.deepEqual(paths, ['/a.png', '/b.png'])
          assert.equal(f.workflow.getSnapshot().photos[1].mediaId, 99)
        }
      })
    }
  }
}

for (const command of ['retry', 'resume', 'add', 'replace']) {
  test(`complete canonical source admits ${command} before restore despite initial controls false`, async (t) => {
    let uploads = 0
    const f = fixture({
      saved: seed(commandPhotos(command), { carryBackSourceTaskId: command === 'replace' ? 9 : null }),
      files: {
        choose: async () => [pick()],
        upload: async () => {
          uploads++
          return { id: 88 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, false)
    await invoke(f.workflow, command)
    assert.equal(uploads, 1)
    assert.equal(f.workflow.getSnapshot().photos.at(-1).mediaId, 88)
  })
}

for (const command of ['retry', 'replace']) {
  test(`full 8/8 remains configured and permits explicit ${command}`, async (t) => {
    let uploads = 0
    const photos = [
      ...commandPhotos(command),
      ...Array.from({ length: 7 }, (_, i) => ({ ...slot('ready', `other-${i}`), mediaId: i + 20 })),
    ]
    const f = fixture({
      saved: seed(photos, { carryBackSourceTaskId: command === 'replace' ? 9 : null }),
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
    assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, true)
    await invoke(f.workflow, command)
    assert.equal(uploads, 1)
    assert.equal(f.workflow.getSnapshot().photos.length, 8)
    assert.deepEqual(clone(f.workflow.getSnapshot().photos.slice(1)), clone(photos.slice(1)))
  })
}

for (const kind of ['zero', 'missing-decoded']) {
  test(`F ${kind} stops only new photo effects, preserving exact frozen request and explicit confirmation`, async (t) => {
    const record = frozen('generate')
    record.photos = [slot('failed')]
    let uploads = 0
    const f = fixture({
      saved: frozenMap(record),
      files: {
        upload: async () => {
          uploads++
          return { id: 88 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    const original = clone(f.workflow.getSnapshot().submission)
    await f.workflow.retryPhoto('local')
    assert.equal(uploads, 1, 'healthy F still allows current draft photo upload')
    for (const value of [
      f.workflow.getSnapshot(),
      f.storage.saved.get('session:4'),
      f.storage.saved.get('unsettled:session:4').record,
    ])
      assert.deepEqual(clone(value.submission), original)
    await configure(f, kind)
    const before = facts(f)
    await f.workflow.addPhotos()
    assert.equal(uploads, 1)
    noInputIO(f, before)
    assert.deepEqual(clone(f.storage.saved.get('unsettled:session:4').record.submission), original)
    await f.workflow.generate()
    const sent = f.calls.filter((c) => c.name === 'generate')
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].args, [original.body])
  })
}

test('decoded free max0 without photos still permits text-only quote and generation', async (t) => {
  const f = fixture({ saved: seed() })
  t.after(() => f.workflow.dispose())
  await f.workflow.restore()
  await configure(f, 'zero')
  assert.equal(f.workflow.getSnapshot().controls.canSelectPhotos, false)
  await f.workflow.prepareQuote()
  assert.equal(f.workflow.getSnapshot().controls.canGenerate, true)
  await f.workflow.generate()
  const sent = f.calls.filter((c) => c.name === 'generate')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].args[0].input.description, '  original idea  ')
  assert.deepEqual(sent[0].args[0].input.inputMediaIds, [])
})

for (const guard of ['unreadable', 'foreign', 'active-intent', 'save-ACK']) {
  test(`valid configuration retains original ${guard} source protection`, async (t) => {
    const saved = seed([slot('failed')])
    if (guard === 'foreign') saved.get('session:4').templateId = 99
    if (guard === 'active-intent') saved.set('initial-input:session:4', { malformed: 'preserve me' })
    let uploads = 0
    const f = fixture({
      saved,
      files: {
        upload: async () => {
          uploads++
          return { id: 88 }
        },
      },
    })
    t.after(() => f.workflow.dispose())
    if (guard === 'unreadable')
      f.storage.get = () => {
        throw Error('unreadable')
      }
    if (guard === 'save-ACK')
      f.storage.set = () => {
        throw Error('save failed')
      }
    const raw = clone([...saved])
    await f.workflow.retryPhoto('local')
    assert.equal(uploads, 0)
    assert.deepEqual(clone([...saved]), raw)
  })
}

test('healthy max8 refresh keeps the actual native-order uploading object, its receipt and the natural next file', async (t) => {
  const held = gate(),
    paths = []
  let sequence = 0
  const f = fixture({
    saved: seed(),
    makeId: () => `healthy-slot-${++sequence}`,
    files: {
      choose: async () => [pick('a'), pick('b')],
      upload: async (path) => {
        paths.push(path)
        return paths.length === 1 ? held.promise : { id: 99 }
      },
    },
  })
  t.after(() => f.workflow.dispose())
  await f.workflow.restore()
  const pending = f.workflow.addPhotos()
  await settle()
  const original = f.workflow.getSnapshot().photos[0]
  assert.deepEqual(Object.keys(original), ['path', 'name', 'size', 'mimeType', 'id', 'status'])
  await configure(f, 'valid')
  assert.equal(f.workflow.getSnapshot().photos[0], original, 'top-level JSON property order is not a new slot')
  held.resolve({ id: 88 })
  await pending
  assert.deepEqual(paths, ['/a.png', '/b.png'])
  assert.deepEqual(clone(f.workflow.getSnapshot().photos.map((p) => [p.id, p.status, p.mediaId])), [
    ['healthy-slot-1', 'ready', 88],
    ['healthy-slot-2', 'ready', 99],
  ])
})

for (const boundary of ['owner', 'hide', 'remove', 'source-path', 'terminal']) {
  test(`new native-order batch still rejects its old receipt after genuine ${boundary} invalidation`, async (t) => {
    const held = gate()
    let current = true,
      uploads = 0,
      sequence = 0
    const f = fixture({
      saved: seed(),
      isCurrent: () => current,
      makeId: () => `boundary-slot-${++sequence}`,
      files: {
        choose: async () => [pick('a'), pick('b')],
        upload: async () => {
          uploads++
          return held.promise
        },
      },
    })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    const pending = f.workflow.addPhotos()
    await settle()
    const id = f.workflow.getSnapshot().photos[0].id
    await configure(f, 'zero')
    if (boundary === 'owner') current = false
    if (boundary === 'hide') f.workflow.setPageVisible({ visible: false })
    if (boundary === 'remove') f.workflow.removePhoto(id)
    if (boundary === 'source-path') f.storage.saved.get('session:4').photos[0].path = '/foreign-source.png'
    if (boundary === 'terminal') {
      f.control.missing = true
      await f.workflow.refresh()
      f.control.missing = false
      await f.workflow.recheckSession()
    }
    const before = facts(f)
    held.resolve({ id: 88 })
    await pending
    assert.equal(uploads, 1)
    assert.notEqual(f.workflow.getSnapshot().photos.find((p) => p.id === id)?.mediaId, 88)
    noInputIO(f, before)
  })
}

for (const change of ['path', 'size', 'status', 'mediaId', 'error', 'missing-name']) {
  test(`projection does not reuse a genuinely changed live photo value: ${change}`, async (t) => {
    const held = gate()
    const f = fixture({ saved: seed([slot('failed')]), files: { upload: () => held.promise } })
    t.after(() => f.workflow.dispose())
    await f.workflow.restore()
    const pending = f.workflow.retryPhoto('local')
    await settle()
    const live = f.workflow.getSnapshot().photos[0]
    // Defensive public-snapshot consumer mutation: the durable canonical photo is unchanged.
    // Only top-level representation order, not these actual value differences, may reuse a live object.
    if (change === 'missing-name') delete live.name
    else live[change] = { path: '/changed.png', size: 13, status: 'pending', mediaId: 55, error: 'changed' }[change]
    await configure(f, 'zero')
    assert.notEqual(f.workflow.getSnapshot().photos[0], live)
    const before = facts(f)
    held.resolve({ id: 88 })
    await pending
    noInputIO(f, before)
    assert.notEqual(f.workflow.getSnapshot().photos[0].mediaId, 88)
  })
}

test('cold persisted uploading has no live object to reuse: failed fallback, raw preserved, no automatic send', async (t) => {
  let uploads = 0
  const f = fixture({
    saved: seed([slot('uploading')]),
    files: {
      upload: async () => {
        uploads++
        return { id: 88 }
      },
    },
  })
  t.after(() => f.workflow.dispose())
  const raw = clone([...f.storage.saved])
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().photos[0].status, 'failed')
  assert.match(f.workflow.getSnapshot().photos[0].error, /上传未完成/)
  assert.deepEqual(clone([...f.storage.saved]), raw)
  assert.equal(f.storage.writes.length, 0)
  assert.equal(uploads, 0)
})
