const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture: fixture, ready, task } = require('./tests/fixtures/creation.cjs')

const photo = { path: '/a.png', size: 10, mimeType: 'image/png' }
test('photo picker cancellation preserves the draft', async () => {
  const { workflow: w } = fixture()
  w.setDescription('保留我的描述')
  await w.addPhotos()
  assert.equal(w.getSnapshot().description, '保留我的描述')
  assert.equal(w.getSnapshot().photos.length, 0)
})
test('native photo upload supports multiple images and rejects PDF without uploading', async () => {
  let calls = 0
  const { workflow: w } = fixture({
    files: {
      choose: async () => [photo, { ...photo, path: '/b.jpg', mimeType: 'image/jpeg' }],
      upload: async () => ({ id: ++calls })
    }
  })
  await w.addPhotos()
  assert.equal(calls, 2)
  assert.ok(w.getSnapshot().photos.every((p) => p.status === 'ready'))
  const { workflow: bad } = fixture({
    files: {
      choose: async () => [{ ...photo, mimeType: 'application/pdf' }],
      upload: () => assert.fail('PDF uploaded')
    }
  })
  await bad.addPhotos()
  assert.ok(bad.getSnapshot().error)
})
test('upload errors preserve photos and description and retry does not re-upload successful photos', async () => {
  let attempt = 0
  const { workflow: w } = fixture({
    files: {
      choose: async () => [photo],
      upload: async () => {
        if (!attempt++) throw Error('NETWORK')
        return { id: 5 }
      }
    }
  })
  w.setDescription('背景干净')
  await w.addPhotos()
  assert.equal(w.getSnapshot().photos[0].status, 'failed')
  assert.equal(w.getSnapshot().description, '背景干净')
  await w.retryPhoto(w.getSnapshot().photos[0].id)
  assert.equal(w.getSnapshot().photos[0].mediaId, 5)
  await w.retryPhoto(w.getSnapshot().photos[0].id)
  assert.equal(attempt, 2)
})
test('free generation needs description while effect accepts empty notes with own photos', async () => {
  const { workflow: w, sent } = fixture()
  await w.prepareQuote()
  await w.generate()
  assert.equal(sent.length, 0)
  const { workflow: t, sent: s } = fixture({ mode: 'effect', files: { choose: async () => [photo] } })
  await t.addPhotos()
  await t.prepareQuote()
  await t.generate()
  assert.equal(s.length, 1)
  assert.equal(s[0].input.userNotes, '')
  assert.equal(s[0].input.description, '')
})
test('duplicate generation taps submit only one durable request', async () => {
  let finish
  let calls = 0
  const { workflow: w } = fixture({
    submit: async (body) => {
      calls++
      return new Promise((resolve) => {
        finish = () => resolve(task(body))
      })
    }
  })
  await ready(w)
  const first = w.generate()
  await new Promise(setImmediate)
  await w.generate()
  assert.equal(calls, 1)
  finish()
  await first
})
test('ambiguous submission retry reuses key and raw frozen input', async () => {
  let count = 0
  const { workflow: w, sent } = fixture({
    submit: async (body) => {
      if (!count++) throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
      return task(body)
    }
  })
  await ready(w, '  原来的描述  ')
  await w.generate()
  w.setDescription('新的描述')
  await w.generate()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], sent[0])
  assert.equal(sent[1].input.description, '  原来的描述  ')
})
test('failed generations retain draft and succeeded outputs load independent Artifacts on re-entry', async () => {
  const rounds = [
    task({}, { id: 1, roundNo: 1, status: 'failed', artifactIds: [] }),
    task({}, { id: 2, roundNo: 2, status: 'succeeded', artifactIds: [88] })
  ]
  const { workflow: w } = fixture({
    api: {
      tasks: async () => ({ items: rounds, nextCursor: null, hasMore: false }),
      artifact: async ({ artifactId }) => ({ id: artifactId, taskId: 2, sessionId: 4 })
    }
  })
  w.setDescription('不丢输入')
  await w.restore()
  assert.equal(w.getSnapshot().description, '不丢输入')
  assert.equal(w.getSnapshot().rounds.length, 2)
  assert.equal(w.getSnapshot().artifacts[88].id, 88)
  assert.notEqual(w.getSnapshot().artifacts[88].id, 2)
})
test('unknown task blocks another paid attempt', async () => {
  const { workflow: w, sent } = fixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'unknown', artifactIds: [] })],
        nextCursor: null,
        hasMore: false
      })
    }
  })
  await w.restore()
  await ready(w)
  await w.generate()
  assert.equal(sent.length, 0)
})
test('stale upload response does not mutate another account', async () => {
  let current = true
  let finish
  const { workflow: w } = fixture({
    isCurrent: () => current,
    files: {
      choose: async () => [photo],
      upload: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    }
  })
  const action = w.addPhotos()
  await new Promise(setImmediate)
  current = false
  finish({ id: 10 })
  await action
  assert.notEqual(w.getSnapshot().photos[0].status, 'ready')
})
test('Artifact favorites confirmed by server and not falsely toggled on failure', async () => {
  const { workflow: w } = fixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [88] })],
        nextCursor: null,
        hasMore: false
      }),
      favorite: async () => {
        throw Error('NETWORK')
      }
    }
  })
  await w.restore()
  await w.toggleFavorite(88)
  assert.equal(w.getSnapshot().artifacts[88].isFavorite, false)
  assert.ok(w.getSnapshot().error)
})
test('retry taps never duplicate an in-flight photo upload', async () => {
  let calls = 0
  let finish
  const { workflow: w } = fixture({
    files: {
      choose: async () => [photo],
      upload: async () => {
        if (++calls === 1) throw Error('OFFLINE')
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    }
  })
  await w.addPhotos()
  const id = w.getSnapshot().photos[0].id
  const first = w.retryPhoto(id)
  await w.retryPhoto(id)
  assert.equal(calls, 2)
  finish({ id: 8 })
  await first
})
test('another variation quotes source Artifact snapshot, not edited draft; carry back is explicit', async () => {
  const quotes = []
  const { workflow: w, sent } = fixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [88] })],
        nextCursor: null,
        hasMore: false
      }),
      quote: async (body) => {
        quotes.push(body)
        return { costCredits: 3, templateId: 1, quoteToken: 'q', validUntil: '2099-01-01T00:00:00Z' }
      }
    }
  })
  await w.restore()
  w.setDescription('未提交新要求')
  await w.prepareRegeneration(88)
  await w.generate()
  assert.deepEqual(JSON.parse(JSON.stringify(quotes.at(-1))), { sourceArtifactId: 88 })
  assert.equal(sent[0].sourceArtifactId, 88)
  assert.equal(sent[0].input, undefined)
  assert.equal(w.getSnapshot().description, '未提交新要求')
})
test('quote expires or price changes: redisplay and require another user click, no automatic charge', async () => {
  const { workflow: w, sent } = fixture()
  await ready(w)
  w.expireQuote()
  await w.generate()
  assert.equal(sent.length, 0)
  await w.prepareQuote()
  assert.equal(sent.length, 0)
  await w.generate()
  assert.equal(sent.length, 1)
})
test('remote draft unknown pauses serial PUT, GET is not a barrier and only explicit resume sends edits', async () => {
  let finish
  let calls = 0
  const { workflow: w } = fixture({
    api: {
      putDraft: () => {
        calls++
        return calls === 1
          ? new Promise((_resolve, reject) => {
            finish = reject
          })
          : Promise.resolve({})
      }
    }
  })
  w.setDescription('one')
  await new Promise(setImmediate)
  w.setDescription('two')
  assert.equal(calls, 1)
  finish(Object.assign(Error('TIMEOUT'), { isOutcomeUnknown: true }))
  await new Promise(setImmediate)
  w.setDescription('three')
  await w.refresh()
  assert.equal(calls, 1)
  assert.equal(w.getSnapshot().draftPaused, true)
  await w.resumeDraftSave()
  assert.equal(calls, 2)
})
test('round merge stays ascending, old page prepends, terminal history beats late queued receipt', async () => {
  let n = 0
  const { workflow: w } = fixture({
    api: {
      tasks: async () =>
        n++
          ? {
            items: [task({}, { id: 1, roundNo: 1, status: 'closed', artifactIds: [] })],
            nextCursor: null,
            hasMore: false
          }
          : {
            items: [task({}, { id: 9, roundNo: 3, status: 'succeeded', artifactIds: [88] })],
            nextCursor: 'older',
            hasMore: true
          }
    }
  })
  await w.restore()
  await w.loadOlder()
  assert.deepEqual(
    Array.from(w.getSnapshot().rounds, (r) => r.roundNo),
    [1, 3]
  )
  assert.equal(w.shouldPoll(), false)
})
test('late quote for prior input is discarded and cannot replace current cost', async () => {
  const pending = []
  const { workflow: w } = fixture({
    api: { quote: (body) => new Promise((resolve) => pending.push({ body, resolve })) }
  })
  w.setDescription('first')
  const first = w.prepareQuote()
  await new Promise(setImmediate)
  w.setDescription('second')
  const second = w.prepareQuote()
  await new Promise(setImmediate)
  pending[1].resolve({
    costCredits: 5,
    templateId: 1,
    quoteToken: 'new',
    validUntil: '2099-01-01T00:00:00Z'
  })
  await second
  pending[0].resolve({
    costCredits: 1,
    templateId: 1,
    quoteToken: 'old',
    validUntil: '2099-01-01T00:00:00Z'
  })
  await first
  assert.equal(w.getSnapshot().quote.quoteToken, 'new')
  assert.equal(w.getSnapshot().controls.costCredits, 5)
})
test('known succeeded history is not downgraded by late idempotent queued receipt', async () => {
  let finish
  const { workflow: w } = fixture({
    submit: (body) =>
      new Promise((resolve) => {
        finish = () => resolve(task(body))
      }),
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [88] })],
        nextCursor: null,
        hasMore: false
      })
    }
  })
  await ready(w)
  const sending = w.generate()
  await new Promise(setImmediate)
  await w.refresh()
  finish()
  await sending
  assert.equal(w.getSnapshot().rounds[0].status, 'succeeded')
  assert.equal(w.getSnapshot().artifacts[88].id, 88)
})
test('restored free session uses free preset, never effect-only template endpoint', async () => {
  let effectCalls = 0
  let freeCalls = 0
  const f = fixture({
    api: {
      template: async () => {
        effectCalls++
        throw Error('TEMPLATE_UNAVAILABLE')
      },
      freePreset: async () => {
        freeCalls++
        return require('./tests/fixtures/creation.cjs').template()
      }
    }
  })
  await f.workflow.restore()
  assert.equal(effectCalls, 0)
  assert.equal(freeCalls, 1)
  assert.equal(f.workflow.getSnapshot().template.mode, 'free')
})
test('session detail failure does not block independently readable task history or local input', async () => {
  const { workflow: w } = fixture({
    api: {
      getSession: async () => {
        throw Error('DATA_INTEGRITY_CONFLICT')
      },
      tasks: async () => ({
        items: [task({}, { id: 8, status: 'closed', artifactIds: [] })],
        nextCursor: null,
        hasMore: false
      })
    }
  })
  w.setDescription('local')
  await w.restore()
  assert.equal(w.getSnapshot().rounds.length, 1)
  assert.equal(w.getSnapshot().rounds[0].status, 'closed')
  assert.equal(w.getSnapshot().description, 'local')
})

test('remote draft with no local file metadata can append native photos without losing ordered IDs', async () => {
  const { workflow: w, sent } = fixture({
    saved: new Map(),
    files: { choose: async () => [photo] },
    api: {
      getSession: async () => ({
        id: 4,
        mode: 'free',
        templateId: 1,
        title: 'restored',
        runningTask: null,
        draft: { input: { description: 'remote', userNotes: '', inputMediaIds: [15] }, updatedAt: '2026-11-13T00:00:00Z' }
      })
    }
  })
  await w.restore()
  assert.equal(w.getSnapshot().photos[0].mediaId, 15)
  await w.addPhotos()
  assert.equal(w.getSnapshot().photos.length, 2)
  await w.prepareQuote()
  await w.generate()
  assert.deepEqual(sent[0].input.inputMediaIds, [15, 7])
})

test('late old Artifact read never erases a confirmed favorite write', async () => {
  let reads = 0
  let finish
  const { workflow: w } = fixture({
    api: {
      tasks: async () => ({
        items: [task({}, { status: 'succeeded', artifactIds: [88] })],
        nextCursor: null,
        hasMore: false
      }),
      artifact: async () => {
        const artifact = { id: 88, mediaId: 90, taskId: 9, sessionId: 4, isFavorite: false }
        if (++reads === 1) return artifact
        return new Promise((resolve) => {
          finish = () => resolve(artifact)
        })
      },
      favorite: async () => ({ isFavorite: true, savedAt: '2026-11-13T00:00:00Z' })
    }
  })
  await w.restore()
  const refreshing = w.refresh()
  await new Promise(setImmediate)
  await w.toggleFavorite(88)
  assert.equal(w.getSnapshot().artifacts[88].isFavorite, true)
  finish()
  await refreshing
  assert.equal(w.getSnapshot().artifacts[88].isFavorite, true)
})

test('Artifact detail can select an older source outside the latest task page and quote expiry keeps that source', async () => {
  const quotes = []
  let attempt = 0
  const { workflow: w, sent } = fixture({
    submit: async (body) => {
      if (!attempt++) {
        throw Object.assign(Error('QUOTE_EXPIRED'), {
          code: 'QUOTE_EXPIRED',
          isOutcomeUnknown: false,
          retryable: false
        })
      }
      return task(body, { sourceTaskId: 9 })
    },
    api: {
      quote: async (body) => {
        quotes.push(JSON.parse(JSON.stringify(body)))
        return {
          costCredits: 4,
          templateId: 1,
          quoteToken: 'quote',
          validUntil: '2099-01-01T00:00:00Z'
        }
      }
    }
  })
  await w.restore()
  await w.prepareRegeneration(88)
  assert.equal(w.getSnapshot().sourceArtifactId, 88)
  await w.generate()
  await new Promise(setImmediate)
  assert.equal(sent.length, 1)
  assert.equal(w.getSnapshot().sourceArtifactId, 88)
  assert.deepEqual(quotes.at(-1), { sourceArtifactId: 88 })
  assert.equal(w.getSnapshot().controls.costCredits, 4)
})

test('rename write epoch protects confirmed title from a previously started GET', async () => {
  let finish
  const f = fixture()
  await f.workflow.restore()
  f.api.getSession = () =>
    new Promise((resolve) => {
      finish = () =>
        resolve({
          ...f.session,
          title: 'old',
          titleSource: 'template',
          draft: { input: { description: '', userNotes: '', inputMediaIds: [] } }
        })
    })
  f.api.rename = async () => ({ sessionId: 4, title: 'confirmed', titleSource: 'user' })
  const reading = f.workflow.refresh()
  await new Promise(setImmediate)
  await f.workflow.rename('confirmed')
  finish()
  await reading
  assert.equal(f.workflow.getSnapshot().session.title, 'confirmed')
  assert.equal(f.workflow.getSnapshot().session.titleSource, 'user')
})

test('rename write epoch rejects a late older rename response', async () => {
  const writes = []
  const f = fixture({ api: { rename: (args) => new Promise((resolve) => writes.push({ args, resolve })) } })
  await f.workflow.restore()
  const first = f.workflow.rename('first')
  const second = f.workflow.rename('second')
  writes[1].resolve({ sessionId: 4, title: 'second', titleSource: 'user' })
  await second
  writes[0].resolve({ sessionId: 4, title: 'first', titleSource: 'user' })
  await first
  assert.equal(f.workflow.getSnapshot().session.title, 'second')
})

for (const mismatch of ['mode', 'template', 'version']) {
  test(`new template entry preserves but does not adopt a record with mismatched ${mismatch}`, async () => {
    const record = {
      protocol: 2,
      mode: mismatch === 'mode' ? 'effect' : 'free',
      sessionId: 77,
      templateId: mismatch === 'template' ? 9 : 1,
      templateVersionId: mismatch === 'version' ? 8 : 2,
      description: 'foreign',
      userNotes: '',
      photos: [],
      submission: null
    }
    const saved = new Map([['owner:1:free', record]])
    const f = fixture({ sessionId: null, saved })
    await f.workflow.restore()
    assert.equal(f.workflow.getSnapshot().sessionId, null)
    assert.equal(f.workflow.getSnapshot().description, '')
    f.workflow.setDescription('new draft')
    assert.deepEqual(saved.get('owner:1:free'), record)
  })
}

test('quote error retry obtains a quote but never automatically generates', async () => {
  let calls = 0
  const f = fixture({
    api: {
      quote: async () => {
        if (++calls === 1) throw Error('NETWORK')
        return {
          costCredits: 3,
          templateId: 1,
          quoteToken: 'retried',
          validUntil: '2099-01-01T00:00:00Z'
        }
      }
    }
  })
  await ready(f.workflow)
  assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
  await f.workflow.retryError()
  assert.equal(calls, 2)
  assert.equal(f.workflow.getSnapshot().quote.quoteToken, 'retried')
  assert.equal(f.sent.length, 0)
})

test('carry-back reads original Artifact task input explicitly without selecting regeneration or sending generation', async () => {
  const f = fixture({
    api: {
      task: async () =>
        task(
          { input: { inputMediaIds: [15, 16], description: '  source input  ', userNotes: '' } },
          {
            status: 'succeeded',
            artifactIds: [88],
            inputAvailability: [
              { mediaId: 15, position: 1, status: 'active' },
              { mediaId: 16, position: 2, status: 'active' }
            ]
          }
        )
    }
  })
  await f.workflow.restore()
  f.workflow.setDescription('current draft')
  const candidate = await f.workflow.prepareCarryBackInput({ artifactId: 88 })
  assert.equal(f.workflow.getSnapshot().description, 'current draft')
  await f.workflow.confirmCarryBackInput({ candidate })
  assert.equal(f.workflow.getSnapshot().description, '  source input  ')
  assert.deepEqual(
    Array.from(f.workflow.getSnapshot().photos, (photo) => photo.mediaId),
    [15, 16]
  )
  assert.equal(f.workflow.getSnapshot().sourceArtifactId, null)
  assert.equal(f.sent.length, 0)
})

test('GET begun during rename flight also cannot overwrite the subsequently confirmed title', async () => {
  let finishRead, finishWrite
  const f = fixture()
  await f.workflow.restore()
  f.api.rename = () =>
    new Promise((resolve) => {
      finishWrite = () => resolve({ sessionId: 4, title: 'confirmed', titleSource: 'user' })
    })
  f.api.getSession = () =>
    new Promise((resolve) => {
      finishRead = () =>
        resolve({
          ...f.session,
          title: 'old',
          titleSource: 'template',
          draft: { input: { inputMediaIds: [], description: '', userNotes: '' } }
        })
    })
  const writing = f.workflow.rename('confirmed')
  const reading = f.workflow.refresh()
  await new Promise(setImmediate)
  finishWrite()
  await writing
  finishRead()
  await reading
  assert.equal(f.workflow.getSnapshot().session.title, 'confirmed')
})

test('photo retry waits for durable uploading state and storage recovery releases its lock', async () => {
  let calls = 0
  const f = fixture({
    files: {
      choose: async () => [photo],
      upload: async () => {
        if (++calls === 1) throw Error('NETWORK')
        return { id: 7 }
      }
    }
  })
  await f.workflow.addPhotos()
  const id = f.workflow.getSnapshot().photos[0].id
  assert.equal(calls, 1)
  f.control.fail = () => true
  await f.workflow.retryPhoto(id)
  assert.equal(calls, 1)
  assert.equal(f.workflow.getSnapshot().photos[0].status, 'failed')
  assert.ok(f.workflow.getSnapshot().storageError)
  f.control.fail = () => false
  await f.workflow.retryPhoto(id)
  assert.equal(calls, 2)
  assert.equal(f.workflow.getSnapshot().photos[0].status, 'ready')
  await f.workflow.retryPhoto(id)
  assert.equal(calls, 2)
})
