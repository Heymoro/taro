const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { workflowFixture, task } = require('../fixtures/creation.cjs')
const tick = () => new Promise(setImmediate)
const source = (extra = {}) =>
  task(
    {},
    {
      status: 'succeeded',
      sourceTaskId: 3,
      artifactIds: [88],
      inputAvailability: [
        { mediaId: 15, position: 1, status: 'active' },
        { mediaId: 16, position: 2, status: 'unavailable' }
      ],
      ...extra
    }
  )
function fixture(options = {}) {
  const calls = { put: [], quote: [], task: [], choose: [], preview: [] }
  const f = workflowFixture({
    ...options,
    api: {
      task: async (args) => {
        calls.task.push(args)
        return source()
      },
      putDraft: async (args) => {
        calls.put.push(args)
        return {}
      },
      quote: async (args) => {
        calls.quote.push(args)
        return {
          costCredits: 3,
          templateId: 1,
          quoteToken: 'quote',
          validUntil: '2099-01-01'
        }
      },
      ...options.api
    },
    files: {
      preview: async (id) => {
        calls.preview.push(id)
        return `/preview-${id}`
      },
      choose: async (count) => {
        calls.choose.push(count)
        return [{ path: '/new.png', mimeType: 'image/png', size: 12 }]
      },
      ...options.files
    }
  })
  return { ...f, calls }
}
async function prepare(f) {
  return f.workflow.prepareCarryBackInput({ taskId: 9 })
}
async function apply(f) {
  const candidate = await prepare(f)
  assert.ok(candidate)
  return f.workflow.confirmCarryBackInput({ candidate })
}

test('preparation and cancellation perform fresh Task read with zero draft/local/remote mutations', async () => {
  const f = fixture()
  await f.workflow.restore()
  f.workflow.setDescription('my draft')
  await tick()
  const before = JSON.stringify(f.workflow.getSnapshot())
  const writes = f.writes.length,
    put = f.calls.put.length,
    quote = f.calls.quote.length
  const candidate = await (f.workflow.prepareCarryBackInput || f.workflow.carryBackInput)({
    taskId: 9
  })
  assert.equal(JSON.stringify(f.workflow.getSnapshot()), before)
  assert.ok(candidate)
  assert.equal(JSON.stringify(f.calls.task), JSON.stringify([{ taskId: 9 }]))
  assert.equal(JSON.stringify(f.workflow.getSnapshot()), before)
  assert.equal(f.workflow.cancelCarryBackInput({ candidate }), true)
  assert.equal(JSON.stringify(f.workflow.getSnapshot()), before)
  assert.equal(f.writes.length, writes)
  assert.equal(f.calls.put.length, put)
  assert.equal(f.calls.quote.length, quote)
  assert.equal(f.calls.preview.length, 0)
  assert.equal(await f.workflow.confirmCarryBackInput({ candidate }), false)
})

test('confirmed unavailable slots preserve order, identity and selected Task id locally; all remote writes blocked', async () => {
  const f = fixture()
  assert.equal(await apply(f), true)
  await tick()
  const state = f.workflow.getSnapshot()
  assert.equal(state.carryBackSourceTaskId, 9)
  assert.deepEqual(
    Array.from(state.photos, (p) => [p.mediaId, p.status]),
    [
      [15, 'ready'],
      [16, 'unavailable']
    ]
  )
  assert.equal(f.saved.get('session:4').carryBackSourceTaskId, 9)
  assert.equal(f.saved.get('session:4').photos[1].mediaId, 16)
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  await f.workflow.resumeDraftSave()
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.calls.preview, [15])
})

for (const extra of [
  { sessionId: 5 },
  { id: 10 },
  { inputAvailability: undefined },
  { inputAvailability: [] },
  { inputAvailability: [{ mediaId: 15, position: 1, status: 'active' }] },
  {
    inputAvailability: [
      { mediaId: 16, position: 1, status: 'active' },
      { mediaId: 15, position: 2, status: 'unavailable' }
    ]
  },
  {
    inputAvailability: [
      { mediaId: 15, position: 2, status: 'active' },
      { mediaId: 16, position: 1, status: 'unavailable' }
    ]
  },
  {
    inputAvailability: [
      { mediaId: 15, position: 1, status: 'unknown' },
      { mediaId: 16, position: 2, status: 'unavailable' }
    ]
  }
])
  test(`malformed or foreign source is rejected: ${JSON.stringify(extra)}`, async () => {
    const f = fixture({ api: { task: async () => source(extra) } })
    assert.equal(await prepare(f), null)
    assert.equal(f.writes.length, 0)
    assert.equal(f.calls.put.length, 0)
    assert.equal(f.calls.quote.length, 0)
  })

for (const reason of ['edit', 'hide-show', 'new-read', 'dispose', 'account', 'pending']) {
  test(`old confirmation is inert after ${reason}`, async () => {
    let current = true
    const f = fixture({
      isCurrent: () => current,
      submit: async () => {
        throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
      }
    })
    f.workflow.setDescription('ready')
    await f.workflow.prepareQuote()
    await tick()
    const candidate = await prepare(f)
    if (reason === 'edit') f.workflow.setDescription('new edit')
    if (reason === 'hide-show') {
      f.workflow.setPageVisible({ visible: false })
      f.workflow.setPageVisible({ visible: true })
    }
    if (reason === 'new-read') await prepare(f)
    if (reason === 'dispose') f.workflow.dispose()
    if (reason === 'account') current = false
    if (reason === 'pending') await f.workflow.generate()
    await tick()
    const before = JSON.stringify(f.workflow.getSnapshot()),
      writes = f.writes.length
    assert.equal(await f.workflow.confirmCarryBackInput({ candidate }), false)
    assert.equal(JSON.stringify(f.workflow.getSnapshot()), before)
    assert.equal(f.writes.length, writes)
  })
}

test('newer carry read invalidates even an older in-flight read', async () => {
  let finish
  const f = fixture({
    api: {
      task: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    }
  })
  const first = prepare(f)
  const finishFirst = finish
  const second = prepare(f)
  finish(source())
  const candidate = await second
  finishFirst(source())
  assert.equal(await first, null)
  assert.equal(await f.workflow.confirmCarryBackInput({ candidate }), true)
})

test('supplement uses native choose(1), replaces original slot with fresh identity, then syncs full input and requotes only', async () => {
  const f = fixture()
  await apply(f)
  const old = f.workflow.getSnapshot().photos[1].id
  await f.workflow.replacePhoto({ id: old })
  await tick()
  const state = f.workflow.getSnapshot()
  assert.deepEqual(f.calls.choose, [1])
  assert.equal(state.photos[0].mediaId, 15)
  assert.equal(state.photos[1].mediaId, 7)
  assert.notEqual(state.photos[1].id, old)
  assert.equal(f.calls.put.length, 1)
  assert.deepEqual(Array.from(f.calls.put[0].input.inputMediaIds), [15, 7])
  assert.equal(f.calls.quote.length, 1)
  assert.equal(f.sent.length, 0)
})

test('multiple missing photos stay local until the final slot is explicitly removed', async () => {
  const f = fixture({
    api: {
      task: async () =>
        source({
          inputAvailability: [
            { mediaId: 15, position: 1, status: 'unavailable' },
            { mediaId: 16, position: 2, status: 'unavailable' }
          ]
        })
    }
  })
  await apply(f)
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[0].id })
  await tick()
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
  f.workflow.removePhoto(f.workflow.getSnapshot().photos[1].id)
  await tick()
  assert.equal(f.calls.put.length, 1)
  assert.equal(f.calls.quote.length, 1)
  assert.equal(f.sent.length, 0)
})

for (const picked of [
  [],
  [{ path: '/bad', mimeType: 'application/pdf', size: 12 }],
  [{ path: '/bad', mimeType: 'image/png', size: 0 }]
]) {
  test(`supplement cancellation or invalid metadata preserves original slot: ${JSON.stringify(
    picked
  )}`, async () => {
    const f = fixture({
      files: { choose: async () => picked, upload: async () => assert.fail('upload') }
    })
    await apply(f)
    const before = JSON.stringify(f.workflow.getSnapshot().photos),
      writes = f.writes.length
    await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
    await tick()
    assert.equal(JSON.stringify(f.workflow.getSnapshot().photos), before)
    assert.equal(f.writes.length, writes)
    assert.equal(f.calls.put.length, 0)
    assert.equal(f.calls.quote.length, 0)
  })
}

test('upload failure is retryable and cannot sync partial input', async () => {
  let attempts = 0
  const f = fixture({
    files: {
      upload: async () => {
        if (!attempts++) throw Error('NETWORK')
        return { id: 77 }
      }
    }
  })
  await apply(f)
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  await tick()
  assert.equal(f.workflow.getSnapshot().photos[1].status, 'failed')
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
  await f.workflow.retryPhoto(f.workflow.getSnapshot().photos[1].id)
  await tick()
  assert.deepEqual(Array.from(f.calls.put[0].input.inputMediaIds), [15, 77])
})

test('storage failure on confirm or replacement blocks remote operations', async () => {
  const f = fixture()
  const candidate = await prepare(f)
  f.control.fail = () => true
  assert.equal(await f.workflow.confirmCarryBackInput({ candidate }), false)
  await tick()
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
  f.control.fail = () => false
  await apply(f)
  f.control.fail = () => true
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  await tick()
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
})

test('missing input re-entry preserves source and unavailable slots without preview or partial sync', async () => {
  const f = fixture()
  await apply(f)
  const g = fixture({ saved: f.saved })
  await g.workflow.restore()
  await tick()
  assert.equal(g.workflow.getSnapshot().carryBackSourceTaskId, 9)
  assert.equal(g.workflow.getSnapshot().photos[1].status, 'unavailable')
  assert.equal(g.calls.put.length, 0)
  assert.equal(g.calls.quote.length, 0)
  assert.ok(!g.calls.preview.includes(16))
})

for (const mutate of [
  (r) => {
    delete r.carryBackSourceTaskId
  },
  (r) => {
    r.carryBackSourceTaskId = -1
  },
  (r) => {
    r.photos[1].mediaId = 0
  },
  (r) => {
    r.photos[1].id = r.photos[0].id
  },
  (r) => {
    r.photos[1].mimeType = 'image/png'
  }
])
  test('malformed local missing-source contract stays blocked and leaves original record intact', async () => {
    const f = fixture()
    await apply(f)
    const record = f.saved.get('session:4')
    mutate(record)
    f.saved.set('session:4', record)
    const original = JSON.stringify(record)
    const g = fixture({ saved: f.saved })
    await g.workflow.restore()
    g.workflow.setDescription('attempt edit')
    await g.workflow.prepareQuote()
    await g.workflow.generate()
    await tick()
    assert.equal(JSON.stringify(g.saved.get('session:4')), original)
    assert.equal(g.calls.put.length, 0)
    assert.equal(g.calls.quote.length, 0)
    assert.equal(g.sent.length, 0)
  })

test('active preview failure is retryable, not permanent unavailable, and late preview cannot overwrite edited slots', async () => {
  let finish
  const f = fixture({
    files: {
      preview: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    }
  })
  const candidate = await prepare(f)
  const applying = f.workflow.confirmCarryBackInput({ candidate })
  await tick()
  f.workflow.removePhoto(f.workflow.getSnapshot().photos[0].id)
  finish('/late.png')
  await applying
  assert.equal(f.workflow.getSnapshot().photos.length, 1)
  assert.equal(f.workflow.getSnapshot().photos[0].path, '')
  const g = fixture({
    files: {
      preview: async () => {
        throw Error('NETWORK')
      }
    }
  })
  await apply(g)
  assert.equal(g.workflow.getSnapshot().photos[0].status, 'ready')
  assert.equal(g.workflow.getSnapshot().errorAction, 'carry-preview')
  g.workflow.dispose()
})

test('pure coordinator invokes explicit confirmation and never applies cancel', async () => {
  const { coordinateCarryBackInput } = load('src/features/creation/carry-back-input.js')
  const f = fixture()
  const choices = []
  await coordinateCarryBackInput({
    intent: { artifactId: 88 },
    prepare: f.workflow.prepareCarryBackInput,
    confirm: f.workflow.confirmCarryBackInput,
    cancel: f.workflow.cancelCarryBackInput,
    showConfirmation: async (args) => {
      choices.push(args)
      return { confirm: false }
    }
  })
  assert.equal(choices.length, 1)
  assert.equal(f.writes.length, 0)
  assert.match(choices[0].content, /替换|覆盖/)
  assert.match(choices[0].content, /补/)
  await coordinateCarryBackInput({
    intent: { taskId: 9 },
    prepare: f.workflow.prepareCarryBackInput,
    confirm: f.workflow.confirmCarryBackInput,
    cancel: f.workflow.cancelCarryBackInput,
    showConfirmation: async () => ({ confirm: true })
  })
  assert.equal(f.workflow.getSnapshot().carryBackSourceTaskId, 9)
})

test('cached round admission input is never trusted over fresh Task availability', async () => {
  const f = fixture({
    api: {
      tasks: async () => ({
        items: [source({ inputAvailability: [] })],
        nextCursor: null,
        hasMore: false
      })
    }
  })
  await f.workflow.restore()
  await apply(f)
  assert.equal(f.calls.task.length, 1)
  assert.equal(f.workflow.getSnapshot().photos[1].status, 'unavailable')
})

test('sparse source availability is rejected before a candidate is offered', async () => {
  const availability = new Array(2)
  availability[0] = { mediaId: 15, position: 1, status: 'active' }
  const f = fixture({ api: { task: async () => source({ inputAvailability: availability }) } })
  assert.equal(await prepare(f), null)
  assert.equal(f.writes.length, 0)
})

test('missing local photos also block regeneration quote bypass until repaired', async () => {
  const f = fixture()
  await apply(f)
  await f.workflow.prepareRegeneration(88)
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  assert.equal(f.calls.quote.length, 0)
  assert.equal(f.sent.length, 0)
})

test('all-active confirmation syncs only after durable local persistence; failures never reach quote or generation', async () => {
  const f = fixture({
    api: {
      task: async () =>
        source({
          inputAvailability: [
            { mediaId: 15, position: 1, status: 'active' },
            { mediaId: 16, position: 2, status: 'active' }
          ]
        })
    }
  })
  f.control.fail = () => true
  const candidate = await prepare(f)
  assert.equal(await f.workflow.confirmCarryBackInput({ candidate }), false)
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  await tick()
  assert.equal(f.calls.put.length, 0)
  assert.equal(f.calls.quote.length, 0)
  assert.equal(f.sent.length, 0)
})

test('remote missing-slot metadata exemption still counts the full array and strictly validates real new files', () => {
  const { validatePhotos } = load('src/creation-input.js')
  const { template } = require('../fixtures/creation.cjs')
  const schema = template().inputSchema
  const photos = [
    { status: 'ready', mediaId: 15 },
    { status: 'unavailable', mediaId: 16 }
  ]
  assert.equal(validatePhotos({ photos, schema }), '')
  assert.ok(validatePhotos({ photos, schema: { ...schema, maxImages: 1 } }))
  for (const bad of [
    { mediaId: 0 },
    { size: 0, mimeType: 'image/png' },
    { size: 1, mimeType: 'bad' }
  ]) {
    assert.ok(validatePhotos({ photos: [photos[0], { ...photos[1], ...bad }], schema }))
  }
})

test('native picker rejection cancellation and stale picker results leave source slot unchanged', async () => {
  let finish
  const f = fixture({
    files: {
      choose: async () => {
        throw { errMsg: 'chooseMedia:fail cancel' }
      }
    }
  })
  await apply(f)
  const before = JSON.stringify(f.workflow.getSnapshot()),
    writes = f.writes.length
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  assert.equal(JSON.stringify(f.workflow.getSnapshot()), before)
  assert.equal(f.writes.length, writes)
  const g = fixture({
    files: {
      choose: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    }
  })
  await apply(g)
  const replacing = g.workflow.replacePhoto({ id: g.workflow.getSnapshot().photos[1].id })
  g.workflow.setDescription('edited while picker open')
  finish([{ path: '/new.png', mimeType: 'image/png', size: 3 }])
  await replacing
  assert.equal(g.workflow.getSnapshot().photos[1].status, 'unavailable')
})

test('late supplement upload cannot recreate a removed slot', async () => {
  let finish
  const f = fixture({
    files: {
      upload: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    }
  })
  await apply(f)
  const replacing = f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  await tick()
  f.workflow.removePhoto(f.workflow.getSnapshot().photos[1].id)
  finish({ id: 77 })
  await replacing
  await tick()
  assert.deepEqual(
    Array.from(f.workflow.getSnapshot().photos, (p) => p.mediaId),
    [15]
  )
  assert.ok(f.calls.put.every((call) => !call.input.inputMediaIds.includes(77)))
})

test('successful retry clears active preview feedback without marking it unavailable', async () => {
  let attempt = 0
  const f = fixture({
    files: {
      preview: async () => {
        if (!attempt++) throw Error('NETWORK')
        return '/retried.png'
      }
    }
  })
  await apply(f)
  assert.equal(f.workflow.getSnapshot().errorAction, 'carry-preview')
  await f.workflow.retryError()
  assert.equal(f.workflow.getSnapshot().photos[0].path, '/retried.png')
  assert.equal(f.workflow.getSnapshot().photos[0].status, 'ready')
  assert.equal(f.workflow.getSnapshot().error, '')
})

for (const phase of ['uploading', 'failed']) {
  test(`carry-back repair ${phase} blocks every new quote, regeneration and generation control`, async () => {
    let finishUpload
    const f = fixture({
      files: {
        upload: () =>
          phase === 'failed'
            ? Promise.reject(Error('NETWORK'))
            : new Promise((resolve) => {
                finishUpload = resolve
              })
      }
    })
    await apply(f)
    const replacing = f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
    await tick()
    assert.equal(f.workflow.getSnapshot().photos[1].status, phase)
    await f.workflow.prepareRegeneration(88)
    await f.workflow.prepareQuote()
    const canGenerate = f.workflow.getSnapshot().controls.canGenerate
    await f.workflow.generate()
    assert.deepEqual(
      { canGenerate, quote: f.calls.quote.length, put: f.calls.put.length, sent: f.sent.length },
      { canGenerate: false, quote: 0, put: 0, sent: 0 }
    )
    if (finishUpload) finishUpload({ id: 77 })
    await replacing
    await tick()
    if (phase === 'uploading') {
      assert.equal(f.workflow.getSnapshot().carryBackSourceTaskId, null)
      assert.equal(f.calls.put.length, 1)
      assert.equal(f.calls.quote.length, 1)
    } else {
      f.workflow.removePhoto(f.workflow.getSnapshot().photos[1].id)
      await tick()
      assert.equal(f.workflow.getSnapshot().carryBackSourceTaskId, null)
      assert.equal(f.calls.put.length, 1)
      assert.equal(f.calls.quote.length, 1)
    }
  })
}

test('completed carry-back repair does not gate a later ordinary draft upload from independent regeneration', async () => {
  let uploads = 0,
    finishUpload
  const f = fixture({
    files: {
      upload: () =>
        ++uploads === 1
          ? Promise.resolve({ id: 77 })
          : new Promise((resolve) => {
              finishUpload = resolve
            })
    }
  })
  await apply(f)
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  await tick()
  assert.equal(f.workflow.getSnapshot().carryBackSourceTaskId, null)
  const adding = f.workflow.addPhotos()
  await tick()
  assert.equal(f.workflow.getSnapshot().photos.at(-1).status, 'uploading')
  await f.workflow.prepareRegeneration(88)
  assert.equal(f.workflow.getSnapshot().sourceArtifactId, 88)
  assert.equal(f.workflow.getSnapshot().controls.canGenerate, true)
  await f.workflow.generate()
  assert.equal(f.sent.length, 1)
  finishUpload({ id: 78 })
  await adding
})

test('existing frozen submission still reconciles while local carry-back repair has failed', async () => {
  const prior = fixture({
    submit: async () => {
      throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
    }
  })
  prior.workflow.setDescription('frozen request')
  await prior.workflow.prepareQuote()
  await prior.workflow.generate()
  const frozen = prior.saved.get('session:4').submission
  const f = fixture({
    files: {
      upload: async () => {
        throw Error('NETWORK')
      }
    }
  })
  await apply(f)
  await f.workflow.replacePhoto({ id: f.workflow.getSnapshot().photos[1].id })
  const record = f.saved.get('session:4')
  record.submission = frozen
  f.saved.set('session:4', record)
  const g = fixture({ saved: f.saved })
  await g.workflow.restore()
  assert.equal(g.workflow.getSnapshot().photos[1].status, 'failed')
  assert.ok(g.workflow.getSnapshot().submission)
  await g.workflow.generate()
  assert.equal(g.sent.length, 1)
  assert.equal(JSON.stringify(g.sent[0]), JSON.stringify(frozen.body))
  assert.equal(g.workflow.getSnapshot().submission, null)
})
