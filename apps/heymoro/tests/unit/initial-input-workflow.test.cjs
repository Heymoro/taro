const test = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture, template } = require('../fixtures/creation.cjs')
const clone = (v) => JSON.parse(JSON.stringify(v))
const ordinary = (extra = {}) => ({
  protocol: 2,
  mode: 'free',
  templateId: 1,
  templateVersionId: 2,
  sessionId: null,
  description: 'old',
  userNotes: 'untouched',
  photos: [
    { id: 'a', status: 'ready', mediaId: 7, path: '' },
    { id: 'b', status: 'ready', mediaId: 8, path: '' }
  ],
  sessionRequest: null,
  submission: null,
  draftPaused: false,
  recoveryKey: 'unsettled:template:free',
  ...extra
})
const gate = () => {
  let release, reject
  return {
    promise: new Promise((r, j) => {
      release = r
      reject = j
    }),
    release: (v) => release(v),
    reject: (error) => reject(error)
  }
}
test('E2-01 full generic source is projected before first early setter', () => {
  const raw = ordinary()
  const saved = new Map([['owner:1:free', clone(raw)]])
  const h = workflowFixture({ saved, sessionId: null, template: null })
  h.workflow.setDescription('new')
  assert.equal(h.workflow.getSnapshot().photos.length, 2)
  assert.equal(h.workflow.getSnapshot().userNotes, 'untouched')
  assert.equal(saved.get('owner:1:free').photos.length, 2)
  assert.equal(Object.hasOwn(saved.get('owner:1:free'), 'carryBackSourceTaskId'), false)
})
test('E2-03 hidden bound source is resolved before editable template subscriber', async () => {
  const g = gate()
  const bound = 'owner:1:free:entry:free:1:2'
  const saved = new Map([[bound, ordinary()]])
  const h = workflowFixture({
    saved,
    sessionId: null,
    template: null,
    api: { freePreset: () => g.promise }
  })
  let seen = false
  h.workflow.subscribe(() => {
    const s = h.workflow.getSnapshot()
    if (s.template && !seen) {
      seen = true
      assert.equal(s.photos.length, 2)
      h.workflow.setDescription('subscriber')
    }
  })
  const p = h.workflow.restore()
  g.release(template())
  await p
  assert.equal(seen, true)
  assert.equal(h.workflow.getSnapshot().photos.length, 2)
})
test('E2-04 explicit session server source overlays only actual early text', async () => {
  const g = gate()
  const saved = new Map()
  const h = workflowFixture({ saved, template: null, api: { getSession: () => g.promise } })
  const p = h.workflow.restore()
  h.workflow.setDescription('early')
  await Promise.resolve()
  g.release({
    ...h.session,
    draft: {
      input: { description: 'server', userNotes: 'untouched', inputMediaIds: [7, 8] },
      updatedAt: '2026-11-13T00:00:00Z'
    }
  })
  await p
  assert.equal(h.workflow.getSnapshot().description, 'early')
  assert.equal(h.workflow.getSnapshot().photos.length, 2)
  assert.ok(saved.has('initial-input:session:4'))
  assert.equal(saved.has('session:4'), false)
})
test('E2-11 canonical alias overrides a stale template mirror', async () => {
  const generic = ordinary({
    sessionId: 4,
    photos: [{ id: 'old', status: 'ready', mediaId: 15, path: '' }]
  })
  const canonical = ordinary({
    sessionId: 4,
    description: 'canonical',
    photos: [{ id: 'new', status: 'ready', mediaId: 16, path: '' }],
    recoveryKey: 'unsettled:session:4'
  })
  const saved = new Map([
    ['owner:1:free', generic],
    ['session:4', canonical]
  ])
  const h = workflowFixture({ saved, template: null, sessionId: null })
  await h.workflow.restore()
  assert.equal(h.workflow.getSnapshot().description, 'canonical')
  assert.equal(h.workflow.getSnapshot().photos[0].mediaId, 16)
})

for (const mode of ['free', 'effect'])
  test(`E2-02 ${mode} actual empty edit retains untouched source fields`, async () => {
    const config = template(mode)
    const raw = ordinary({
      mode,
      description: 'inactive-or-active',
      userNotes: 'untouched',
      recoveryKey: mode === 'free' ? 'unsettled:template:free' : 'unsettled:template:1'
    })
    const g = gate()
    const saved = new Map([['owner:1:free', clone(raw)]])
    const h = workflowFixture({
      saved,
      mode,
      template: null,
      sessionId: null,
      api: { freePreset: () => g.promise, template: () => g.promise }
    })
    // The effect route pins its independent ID, not a guessed default config.
    if (mode === 'effect') {
      h.workflow.dispose()
      h.workflow = require('../source.cjs')
        .load('src/creation-workflow.js')
        .createWorkflow({
          api: h.api,
          files: {},
          storage: { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) },
          key: 'owner:1:free',
          templateId: 1,
          makeId: () => 'never'
        })
    }
    const p = h.workflow.restore()
    mode === 'free' ? h.workflow.setDescription('') : h.workflow.setUserNotes('')
    g.release(config)
    await p
    assert.equal(h.workflow.getSnapshot().photos.length, 2)
    assert.equal(h.workflow.getSnapshot()[mode === 'free' ? 'description' : 'userNotes'], '')
    assert.equal(
      h.workflow.getSnapshot()[mode === 'free' ? 'userNotes' : 'description'],
      mode === 'free' ? 'untouched' : 'inactive-or-active'
    )
    h.workflow.dispose()
  })
test('E2-01 old effect and free drafts use current template identity without losing photos', async () => {
  for (const mode of ['effect', 'free']) {
    const calls = []
    const raw = ordinary({
      mode,
      templateVersionId: 7,
      recoveryKey: mode === 'free' ? 'unsettled:template:free' : 'unsettled:template:1'
    })
    const saved = new Map([['owner:1:free', raw]])
    const h = workflowFixture({
      saved,
      template: null,
      sessionId: null,
      api: {
        template: async (args) => {
          calls.push(args)
          return template('effect')
        },
        freePreset: async (...args) => {
          calls.push(args)
          return template()
        }
      }
    })
    if (mode === 'effect') {
      h.workflow.dispose()
      h.workflow = require('../source.cjs')
        .load('src/creation-workflow.js')
        .createWorkflow({
          api: h.api,
          files: {},
          storage: { get: (k) => saved.get(k), set: () => assert.fail('read wrote') },
          key: 'owner:1:free',
          templateId: 1,
          makeId: () => 'never'
        })
    }
    await h.workflow.restore()
    if (mode === 'effect') assert.deepEqual(clone(calls), [{ templateId: 1 }])
    else {
      assert.deepEqual(calls, [[]])
      assert.equal(h.workflow.getSnapshot().template.templateId, 1)
    }
    assert.equal(Object.hasOwn(h.workflow.getSnapshot(), 'templateVersionId'), false)
    assert.equal(h.workflow.getSnapshot().photos.length, 2)
    assert.equal(saved.get('owner:1:free'), raw)
    h.workflow.dispose()
  }
})
for (const raw of [null, false, 0, '', { protocol: 2, description: 'partial' }])
  test(`E2-06 occupied session ${JSON.stringify(raw)} is not an empty source`, async () => {
    const saved = new Map([['session:4', raw]])
    const h = workflowFixture({ saved, template: null })
    await h.workflow.restore()
    const writes = h.writes.length
    h.workflow.setDescription('visible')
    await h.workflow.prepareQuote()
    await h.workflow.addPhotos()
    assert.equal(h.writes.length, writes)
    assert.deepEqual(saved.get('session:4'), raw)
    assert.equal(h.workflow.getSnapshot().controls.canSelectPhotos, false)
    h.workflow.dispose()
  })
test('E2-10 unknown photo operations are strict snapshot and storage no-ops', async () => {
  const h = workflowFixture()
  await h.workflow.restore()
  const before = h.workflow.getSnapshot()
  const writes = h.writes.length
  assert.equal(h.workflow.removePhoto('missing'), false)
  assert.equal(h.workflow.movePhoto({ slotId: 'missing', targetIndex: 0, expectedIds: [] }), false)
  assert.equal(h.workflow.getSnapshot(), before)
  assert.equal(h.writes.length, writes)
  h.workflow.dispose()
})
test('E3-12/E3-21 normal canonical session ignores changed template pointer', async () => {
  const mirror = ordinary({ sessionId: 4 })
  const canonical = ordinary({
    sessionId: 4,
    description: 'canonical',
    recoveryKey: 'unsettled:session:4'
  })
  const saved = new Map([
    ['owner:1:free', mirror],
    ['session:4', canonical]
  ])
  const h = workflowFixture({ saved, template: null, sessionId: null })
  await h.workflow.restore()
  saved.set('owner:1:free', ordinary({ sessionId: 5, description: 'other' }))
  const before = h.writes.length
  h.workflow.setDescription('session four edit')
  assert.equal(saved.get('session:4').description, 'session four edit')
  assert.equal(saved.get('owner:1:free').sessionId, 5)
  assert.ok(h.writes.slice(before).every((w) => w.key === 'session:4'))
  assert.equal(saved.has('initial-input:owner:1:free'), false)
  h.workflow.dispose()
})
test('fixture-owned defaults and caller-owned cold Map remain distinct', () => {
  const normal = workflowFixture()
  assert.ok(normal.saved.has('session:4'))
  assert.equal(normal.writes.length, 0)
  const supplied = new Map()
  const cold = workflowFixture({ saved: supplied })
  assert.equal(supplied.size, 0)
  cold.workflow.setDescription('early')
  assert.equal(supplied.has('session:4'), false)
  assert.ok(supplied.has('initial-input:session:4'))
  const noConfig = workflowFixture({ template: null })
  assert.equal(noConfig.saved.size, 0)
  for (const h of [normal, cold, noConfig]) h.workflow.dispose()
})

test('E4-01/E4-03 real local Notice double click and retained callback stay local after cleanup', async () => {
  const { withPages } = require('../fixtures/creation-pages.cjs')
  let down = true
  let creates = 0
  let retained
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.act(async () =>
        h.handlers.get('composer__input').onInput({ detail: { value: 'early page input' } })
      )
      down = false
      await h.act(async () => h.click('create', '刷新'))
      const button = [...document.querySelectorAll('#create button')].find(
        (b) => b.textContent === '保存本机输入'
      )
      assert.ok(button)
      const prop = Object.keys(button).find((k) => k.startsWith('__reactProps$'))
      retained = button[prop].onClick
      const before = h.businessWrites.length
      await h.act(async () => {
        button.click()
        button.click()
      })
      await h.act(async () => retained())
      assert.equal(h.businessWrites.length, before)
      assert.equal(creates, 0)
      assert.equal(h.controllers[0].getSnapshot().description, 'early page input')
      assert.equal(h.controllers[0].getSnapshot().localInputRecovery.canRetryLocalSave, false)
    },
    {
      route: {},
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          freePreset: async () => {
            if (down)
              throw Object.assign(Error('REQUEST_OUTCOME_UNKNOWN'), {
                isOutcomeUnknown: true,
                code: 'REQUEST_OUTCOME_UNKNOWN',
                status: null
              })
            return template()
          },
          createSession: async () => {
            creates++
            return { id: 4, templateId: 1, templateVersionId: 2 }
          }
        }
      })
    }
  )
})

test('E4-02 photo selection permission preserves real count and independent removal', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { load } = require('../source.cjs')
  const component =
    (tag) =>
    ({ children, scrollX, showScrollbar, ...props }) =>
      React.createElement(tag, props, children)
  const PhotoInput = load('src/features/creation/PhotoInput/index.jsx', {
    '@tarojs/components': {
      Button: component('button'),
      Image: component('img'),
      ScrollView: component('div'),
      Text: component('span'),
      View: component('div')
    },
    '../../../components/primitives': { Action: component('button') }
  }).default
  const photos = [
    { id: 'a', status: 'failed', path: '/a' },
    { id: 'b', status: 'unavailable', mediaId: 8, path: '' }
  ]
  const html = renderToStaticMarkup(
    React.createElement(PhotoInput, {
      photos,
      schema: { maxImages: 8 },
      mode: 'free',
      canSelectPhotos: false,
      onRemove: () => {},
      onPreview: () => {}
    })
  )
  assert.match(html, /2 \/ 8 张/)
  assert.match(html, /disabled=""/)
  assert.match(html, /aria-label="移除照片"/)
  const normal = renderToStaticMarkup(
    React.createElement(PhotoInput, { photos: [], schema: { maxImages: 8 }, mode: 'free' })
  )
  assert.doesNotMatch(normal, /disabled=""/)
})

for (const kind of ['session', 'generation', 'regeneration'])
  for (const phase of ['pending', 'prepared', 'malformed'])
    test(`E3-14 ${kind} F plus ${phase} confirms only original body with zero local writes`, async () => {
      const { load } = require('../source.cjs')
      const core = load('src/features/creation/initial-input-intent.js')
      const entry = {
        key: 'owner:1:free',
        kind: 'template',
        mode: 'free',
        templateId: null,
        templateVersionId: null,
        sessionId: null
      }
      const body = {
        sessionId: 4,
        input: { description: 'immutable', userNotes: '', inputMediaIds: [7, 8] },
        clientRequestId: 'original',
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
      if (kind === 'regeneration') {
        submission.path = '/artifacts/9/regenerations'
        submission.sourceArtifactId = 9
        submission.body = { clientRequestId: 'original', quoteToken: 'q' }
      }
      const raw = ordinary({
        sessionId: kind === 'session' ? null : 4,
        sessionRequest:
          kind === 'session'
            ? { templateId: 1, templateVersionId: 2, clientRequestId: 'original' }
            : null,
        submission: kind === 'session' ? null : submission
      })
      const original = ordinary({ sessionId: raw.sessionId })
      const fingerprint = core.fingerprintInitialInputValue({ value: original }).value
      let intent = {
        protocol: 1,
        kind: 'ordinary-initial-input',
        entry,
        fields: ['description'],
        patch: { description: 'new early text' },
        observed: [{ key: entry.key, fingerprint }],
        prepared: null
      }
      if (phase === 'prepared') {
        const binding = {
          mode: 'free',
          templateId: 1,
          templateVersionId: 2,
          sessionId: raw.sessionId
        }
        const keys = [entry.key, ...(raw.sessionId ? ['session:4'] : [])].sort()
        const current = keys.map((key) => ({
          key,
          fingerprint: key === entry.key ? fingerprint : { kind: 'absent' }
        }))
        const desired = { ...original, description: 'new early text' }
        const out = core.prepareInitialInputIntent({
          context: { entry, binding },
          pending: intent,
          currentJournal: core.fingerprintInitialInputValue({ value: intent }).value,
          current,
          proposal: {
            binding,
            primaryKey: entry.key,
            source: { kind: 'local', key: entry.key, fingerprint },
            targets: current.map((o) => ({ key: o.key, expected: o.fingerprint, desired }))
          }
        })
        assert.equal(out.ok, true)
        intent = out.value.intent
      }
      if (phase === 'malformed') intent = { private: 'preserve byte exact' }
      const saved = new Map([
        [entry.key, clone(raw)],
        ['initial-input:owner:1:free', clone(intent)],
        ['unsettled:template:free', { protocol: 2, draftKey: entry.key, record: clone(raw) }]
      ])
      if (raw.sessionId) saved.set('session:4', clone(raw))
      const before = JSON.stringify([...saved])
      const calls = []
      const h = workflowFixture({
        saved,
        template: null,
        sessionId: null,
        api: {
          createSession: async (v) => {
            calls.push(clone(v))
            return { id: 4, templateId: 1, templateVersionId: 2 }
          },
          generate: async (v) => {
            calls.push(clone(v))
            return {}
          },
          regenerate: async (v) => {
            calls.push(clone(v))
            return {}
          },
          quote: async () => assert.fail('coexist quote'),
          putDraft: async () => assert.fail('coexist PUT')
        }
      })
      await h.workflow.restore()
      const writes = h.writes.length
      await h.workflow.prepareQuote()
      await h.workflow.generate()
      assert.equal(calls.length, 1)
      assert.equal(h.writes.length, writes)
      assert.equal(JSON.stringify([...saved]), before)
      assert.equal(h.workflow.getSnapshot().locallyBlocked, true)
      const expectedBody =
        kind === 'session'
          ? raw.sessionRequest
          : kind === 'regeneration'
          ? { sourceArtifactId: 9, sessionId: 4, ...raw.submission.body }
          : raw.submission.body
      assert.deepEqual(calls[0], expectedBody)
      if (raw.submission) {
        assert.equal(saved.get(entry.key).submission.templateVersionId, 2)
        assert.equal(saved.get(entry.key).submission.costCredits, 3)
      }
      h.workflow.dispose()
      const reopened = workflowFixture({ saved, template: null, sessionId: null, api: h.api })
      await reopened.workflow.restore()
      await reopened.workflow.generate()
      assert.deepEqual(calls, [expectedBody, expectedBody])
      assert.equal(reopened.writes.length, 0)
      assert.equal(JSON.stringify([...saved]), before)
      reopened.workflow.dispose()
      h.workflow.dispose()
    })

test('quote attempt signal is readonly, reentrant publication is bounded and stale owners are silent', async () => {
  let current = true
  let calls = 0
  const g = gate()
  const h = workflowFixture({
    isCurrent: () => current,
    api: {
      quote: async () => {
        calls++
        return g.promise
      }
    }
  })
  let entered = false
  let notifications = 0
  h.workflow.subscribe(() => {
    notifications++
    if (!entered) {
      entered = true
      h.workflow.prepareQuote()
    }
  })
  const writes = h.writes.length
  await h.workflow.prepareQuote()
  assert.equal(h.workflow.getSnapshot().quoteAttemptRevision, 2)
  assert.ok(notifications <= 2)
  assert.equal(calls, 0)
  assert.equal(h.writes.length, writes)
  current = false
  const before = notifications
  await h.workflow.prepareQuote()
  assert.equal(notifications, before)
  assert.equal(h.workflow.getSnapshot().quoteAttemptRevision, 2)
  h.workflow.dispose()
})
for (const invalidation of ['hide', 'hide-show', 'dispose', 'account'])
  test(`quote attempt subscriber ${invalidation} prevents all subsequent IO`, async () => {
    let current = true
    const saved = new Map([
      ['session:4', ordinary({ sessionId: 4, recoveryKey: 'unsettled:session:4' })]
    ])
    let gets = 0
    let posts = 0
    const { createWorkflow } = require('../source.cjs').load('src/creation-workflow.js')
    const w = createWorkflow({
      api: {
        quote: async () => {
          posts++
          return {}
        }
      },
      files: {},
      storage: {
        get: (k) => {
          gets++
          return saved.get(k)
        },
        set: () => assert.fail('stale write')
      },
      key: 'session:4',
      sessionId: 4,
      template: template(),
      makeId: () => assert.fail('stale ID'),
      isCurrent: () => current
    })
    let done = false
    w.subscribe(() => {
      if (done) return
      done = true
      if (invalidation === 'account') current = false
      else if (invalidation === 'dispose') w.dispose()
      else {
        w.setPageVisible({ visible: false })
        if (invalidation === 'hide-show') w.setPageVisible({ visible: true })
      }
    })
    await w.prepareQuote()
    assert.equal(gets, 0)
    assert.equal(posts, 0)
    w.dispose()
  })

test('E3-14 overlapping and storage-reentrant original confirmations share one volatile flight', async () => {
  const { load } = require('../source.cjs')
  const entry = {
    key: 'template:free',
    kind: 'template',
    mode: 'free',
    templateId: null,
    templateVersionId: null,
    sessionId: null
  }
  const raw = ordinary({
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'original' }
  })
  const journal = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'early' },
    observed: [],
    prepared: null
  }
  const saved = new Map([
    [entry.key, raw],
    ['initial-input:template:free', journal],
    ['unsettled:template:free', { protocol: 2, draftKey: entry.key, record: raw }]
  ])
  const g = gate()
  let calls = 0
  let armed = false
  let w
  const writes = []
  w = load('src/creation-workflow.js').createWorkflow({
    api: {
      account: async () => ({}),
      freePreset: async () => template(),
      createSession: async () => {
        calls++
        return g.promise
      }
    },
    files: {},
    storage: {
      get: (key) => {
        if (armed) {
          armed = false
          void w.generate()
        }
        return saved.get(key)
      },
      set: (key, value) => {
        writes.push(key)
        saved.set(key, value)
      }
    },
    key: entry.key,
    makeId: () => assert.fail('original confirmation minted ID')
  })
  await w.restore()
  armed = true
  const first = w.generate()
  const second = w.generate()
  assert.equal(calls, 1)
  g.release({ id: 4, templateId: 1, templateVersionId: 2 })
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(writes.length, 0)
  w.dispose()
})

for (const origin of ['generic', 'bound'])
  test(`E2-11 canonical absent alias is safely created from ${origin} once then promoted`, async () => {
    const generic = 'owner:1:free'
    const primary = origin === 'generic' ? generic : `${generic}:entry:free:1:2`
    const raw = ordinary({ sessionId: 4 })
    const saved = new Map([[primary, raw]])
    const h = workflowFixture({ saved, sessionId: null })
    h.workflow.setDescription('first canonical')
    assert.equal(saved.get('session:4')?.description, 'first canonical')
    assert.equal(saved.get(primary).description, 'first canonical')
    const firstMirror = JSON.stringify(saved.get(primary))
    const before = h.writes.length
    h.workflow.setDescription('second canonical')
    assert.equal(saved.get('session:4').description, 'second canonical')
    assert.equal(JSON.stringify(saved.get(primary)), firstMirror)
    assert.ok(h.writes.slice(before).every((write) => write.key === 'session:4'))
    h.workflow.dispose()
    const reopened = workflowFixture({ saved, sessionId: null })
    await reopened.workflow.restore()
    assert.equal(reopened.workflow.getSnapshot().description, 'second canonical')
    reopened.workflow.dispose()
  })

test('E4-02 real blocked add, replace and retry buttons never choose/upload; preview and remove stay usable', async () => {
  const { withPages } = require('../fixtures/creation-pages.cjs')
  const core = require('../source.cjs').load('src/features/creation/initial-input-intent.js')
  const entry = {
    key: 'session:4',
    kind: 'session',
    mode: null,
    templateId: null,
    templateVersionId: null,
    sessionId: 4
  }
  const raw = ordinary({
    sessionId: 4,
    description: '',
    userNotes: '',
    recoveryKey: 'unsettled:session:4',
    carryBackSourceTaskId: 9,
    photos: [
      { id: 'failed', status: 'failed', path: '/a.png' },
      { id: 'media:8', status: 'unavailable', mediaId: 8, path: '' }
    ]
  })
  const journal = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'early' },
    observed: [
      { key: entry.key, fingerprint: core.fingerprintInitialInputValue({ value: raw }).value }
    ],
    prepared: null
  }
  const saved = new Map([
    [entry.key, raw],
    ['initial-input:session:4', journal]
  ])
  let choices = 0,
    uploads = 0,
    previews = 0
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const buttons = [...document.querySelectorAll('#create button')]
      const add = document.querySelector('#create .photo-add')
      assert.ok(add, 'configured capacity keeps disabled add visible')
      assert.equal(add.disabled, true)
      await h.act(async () => add.click())
      for (const label of ['补选照片', '重试上传']) {
        const button = buttons.find((b) => b.textContent === label)
        assert.ok(button, label)
        assert.equal(button.disabled, true, label)
        await h.act(async () => button.click())
      }
      assert.match(document.querySelector('#create .references__count').textContent, /2 \/ 8 张/)
      await h.act(async () => {
        await h.controllers[0].addPhotos()
        await h.controllers[0].replacePhoto({ id: 'media:8' })
        await h.controllers[0].retryPhoto('failed')
      })
      assert.equal(choices, 0)
      assert.equal(uploads, 0)
      const image = document.querySelector('#create .photo-tile__image')
      assert.ok(image)
      await h.act(async () => image.click())
      assert.equal(previews, 1)
      const remove = document.querySelector('#create .photo-tile__remove')
      assert.equal(remove.disabled, false)
      await h.act(async () => remove.click())
      assert.equal(h.controllers[0].getSnapshot().photos.length, 1)
      assert.equal(choices + uploads, 0)
    },
    {
      creationStorage: {
        get: (k) => (saved.has(k) ? clone(saved.get(k)) : undefined),
        set: (k, v) => saved.set(k, clone(v))
      },
      photoPorts: {
        choose: async () => {
          choices++
          return []
        },
        upload: async () => {
          uploads++
          return { id: 7 }
        }
      },
      createApi: ({ native, ports }) => {
        native.previewImage = () => previews++
        return { creationApi: ports }
      }
    }
  )
})

for (const occupancy of ['null', 'false', 'zero', 'string', 'foreign', 'same-binding-divergent'])
  test(`E3-17 returned new session alias ${occupancy} is not response-settlement ownership`, async () => {
    const saved = new Map()
    const calls = []
    let responseWriteStart = 0
    let h
    h = workflowFixture({
      saved,
      sessionId: null,
      api: {
        createSession: async (body) => {
          calls.push(clone(body))
          const frozen = saved.get('unsettled:template:free').record
          const desired = { ...clone(frozen), sessionId: 4, sessionRequest: null }
          const value =
            occupancy === 'null'
              ? null
              : occupancy === 'false'
              ? false
              : occupancy === 'zero'
              ? 0
              : occupancy === 'string'
              ? 'occupied'
              : occupancy === 'foreign'
              ? { foreign: true }
              : { ...desired, description: 'not the outer snapshot' }
          saved.set('session:4', value)
          responseWriteStart = h.writes.length
          return { id: 4, templateId: 1, templateVersionId: 2 }
        },
        quote: async () => assert.fail('occupied alias quoted'),
        putDraft: async () => assert.fail('occupied alias PUT')
      }
    })
    h.workflow.setDescription('original')
    await h.workflow.prepareQuote()
    assert.equal(calls.length, 1)
    assert.equal(h.writes.length, responseWriteStart)
    assert.ok(saved.get('unsettled:template:free').record.sessionRequest)
    assert.equal(h.workflow.getSnapshot().sessionId, null)
    const request = clone(calls[0])
    await h.workflow.generate()
    assert.deepEqual(calls, [request, request])
    assert.equal(h.writes.length, responseWriteStart)
    h.workflow.dispose()
  })

for (const origin of ['generic', 'bound'])
  for (const outcome of ['success', 'definitive-rejection'])
    for (const stage of ['primary', 'alias', 'clear'])
      for (const fault of ['reject', 'accepted-throw'])
        test(`E3-22 ${origin} F ${outcome} ${stage} ${fault} is recoverable from both routes`, async () => {
          const primary = origin === 'generic' ? 'template:free' : 'template:free:entry:free:1:2'
          const body = {
            sessionId: 4,
            input: { description: 'immutable body', userNotes: '', inputMediaIds: [7, 8] },
            clientRequestId: 'frozen-id',
            quoteToken: 'frozen-q'
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
          const raw = ordinary({ sessionId: 4, description: 'outer input', submission })
          const seed = new Map([
            [primary, clone(raw)],
            ['session:4', clone(raw)],
            ['unsettled:template:free', { protocol: 2, draftKey: primary, record: clone(raw) }]
          ])
          let settling = false
          let fired = false
          const sent = []
          const response = async (v) => {
            sent.push(clone(v))
            settling = true
            if (outcome === 'definitive-rejection')
              throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT' })
            return require('../fixtures/creation.cjs').task(v)
          }
          const first = workflowFixture({
            saved: seed,
            template: null,
            sessionId: null,
            key: 'template:free',
            api: { generate: response }
          })
          await first.workflow.restore()
          first.control.beforeSet = (key, value) => {
            const target =
              stage === 'primary'
                ? primary
                : stage === 'alias'
                ? 'session:4'
                : 'unsettled:template:free'
            if (
              !settling ||
              fired ||
              key !== target ||
              (stage !== 'clear' && value?.submission !== null) ||
              (stage === 'clear' && value !== null)
            )
              return
            fired = true
            if (fault === 'accepted-throw') seed.set(key, clone(value))
            throw Error('settlement interrupted')
          }
          await first.workflow.generate()
          assert.equal(fired, true)
          assert.deepEqual(sent, [body])
          first.workflow.dispose()
          for (const route of ['template', 'session']) {
            const saved = new Map([...seed].map(([key, value]) => [key, clone(value)]))
            const checked = []
            const reopened = workflowFixture({
              saved,
              key: route === 'template' ? 'template:free' : 'session:4',
              sessionId: route === 'template' ? null : 4,
              template: null,
              api: {
                generate: async (v) => {
                  checked.push(clone(v))
                  if (outcome === 'definitive-rejection')
                    throw Object.assign(Error('CREDITS_INSUFFICIENT'), {
                      code: 'CREDITS_INSUFFICIENT'
                    })
                  return require('../fixtures/creation.cjs').task(v)
                }
              }
            })
            await reopened.workflow.restore()
            if (saved.get('unsettled:template:free') !== null) {
              assert.deepEqual(clone(reopened.workflow.getSnapshot().submission), submission)
              await reopened.workflow.generate()
              assert.deepEqual(checked, [body])
            }
            assert.equal(saved.get('unsettled:template:free'), null)
            assert.equal(saved.get(primary).submission, null)
            assert.equal(saved.get('session:4').submission, null)
            reopened.workflow.dispose()
            const clean = workflowFixture({
              saved,
              key: route === 'template' ? 'template:free' : 'session:4',
              sessionId: route === 'template' ? null : 4,
              template: null
            })
            await clean.workflow.restore()
            assert.equal(clean.workflow.getSnapshot().submission, null)
            assert.equal(clean.sent.length, 0)
            clean.workflow.dispose()
          }
        })

test('quote signal cancellation does not suppress a later fresh expiry demand', async (t) => {
  const { withPages } = require('../fixtures/creation-pages.cjs')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  let quotes = 0
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      await h.act(async () => {
        w.setDescription('current input')
        await w.prepareQuote()
      })
      assert.equal(quotes, 1)
      await h.act(async () => h.fire(h.createPage, 'hide'))
      await h.act(async () => t.mock.timers.tick(60000))
      await h.act(async () => w.prepareQuote())
      assert.equal(quotes, 1)
      await h.act(async () => h.fire(h.createPage, 'show'))
      await h.flush()
      assert.equal(quotes, 1)
      await h.act(async () => w.prepareQuote())
      assert.equal(quotes, 2)
      await h.act(async () => h.fire(h.createPage, 'hide'))
      await h.act(async () => t.mock.timers.tick(60000))
      await h.act(async () => h.fire(h.createPage, 'show'))
      await h.flush()
      assert.equal(quotes, 3)
    },
    {
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
          quote: async (args) => {
            quotes++
            return ports.quote(args)
          }
        }
      })
    }
  )
})

for (const invalidation of ['hide-show', 'hidden', 'edit', 'account'])
  test(`E3-13 picker ${invalidation} result uses current gesture admission`, async () => {
    const g = gate()
    let current = true
    let choices = 0,
      uploads = 0
    const h = workflowFixture({
      isCurrent: () => current,
      files: {
        choose: async () => {
          choices++
          return g.promise
        },
        upload: async () => {
          uploads++
          return { id: 7 }
        }
      }
    })
    const choosing = h.workflow.addPhotos()
    assert.equal(choices, 1)
    if (invalidation === 'edit') h.workflow.setDescription('new intent')
    else if (invalidation === 'account') current = false
    else {
      h.workflow.setPageVisible({ visible: false })
      if (invalidation === 'hide-show') h.workflow.setPageVisible({ visible: true })
    }
    const writes = h.writes.length
    g.release([{ path: '/native.png', mimeType: 'image/png', size: 10 }])
    await choosing
    if (invalidation === 'hide-show') {
      assert.equal(uploads, 1)
      assert.equal(h.workflow.getSnapshot().photos[0].mediaId, 7)
    } else {
      assert.equal(uploads, 0)
      assert.equal(h.writes.length, writes)
    }
    h.workflow.dispose()
  })

for (const operation of ['new-session', 'submission'])
  test(`E3-11 ${operation} hide-show response never settles old epoch locally`, async () => {
    const g = gate()
    let reached = false
    const h = workflowFixture({
      sessionId: operation === 'new-session' ? null : 4,
      api:
        operation === 'new-session'
          ? {
              createSession: async () => {
                reached = true
                return g.promise
              }
            }
          : {
              generate: async () => {
                reached = true
                return g.promise
              }
            }
    })
    h.workflow.setDescription('current')
    if (operation === 'submission') await h.workflow.prepareQuote()
    const flight = operation === 'new-session' ? h.workflow.prepareQuote() : h.workflow.generate()
    await Promise.resolve()
    assert.equal(reached, true)
    h.workflow.setPageVisible({ visible: false })
    h.workflow.setPageVisible({ visible: true })
    const writes = h.writes.length
    const before = JSON.stringify([...h.saved])
    g.release(
      operation === 'new-session'
        ? { id: 4, templateId: 1, templateVersionId: 2 }
        : require('../fixtures/creation.cjs').task()
    )
    await flight
    assert.equal(h.writes.length, writes)
    assert.equal(JSON.stringify([...h.saved]), before)
    h.workflow.dispose()
  })

for (const aliasState of ['absent', 'exact-frozen', 'exact-desired'])
  for (const window of ['primary', 'alias', 'clear-reject', 'clear-accepted-throw'])
    test(`E3-18 session receipt ${aliasState} alias ${window} reopens original deterministic request`, async () => {
      const saved = new Map()
      const requests = []
      let settling = false
      let interrupted = false
      let primary
      let first
      first = workflowFixture({
        saved,
        template: null,
        sessionId: null,
        key: 'template:free',
        api: {
          createSession: async (body) => {
            requests.push(clone(body))
            const envelope = saved.get('unsettled:template:free')
            primary = envelope.draftKey
            if (aliasState === 'exact-frozen') saved.set('session:4', clone(envelope.record))
            if (aliasState === 'exact-desired')
              saved.set('session:4', {
                ...clone(envelope.record),
                sessionId: 4,
                sessionRequest: null
              })
            settling = true
            return { id: 4, templateId: 1, templateVersionId: 2 }
          }
        }
      })
      await first.workflow.restore()
      first.control.beforeSet = (key, value) => {
        const target =
          window === 'primary'
            ? primary
            : window === 'alias'
            ? 'session:4'
            : 'unsettled:template:free'
        if (
          !settling ||
          interrupted ||
          key !== target ||
          (window.startsWith('clear') ? value !== null : value?.sessionRequest !== null)
        )
          return
        interrupted = true
        if (window === 'clear-accepted-throw') saved.set(key, null)
        throw Error('receipt settlement interrupted')
      }
      first.workflow.setDescription('original')
      await first.workflow.prepareQuote()
      assert.equal(interrupted, true)
      assert.equal(requests.length, 1)
      const original = clone(requests[0])
      first.workflow.dispose()
      const reopened = workflowFixture({
        saved,
        template: null,
        sessionId: null,
        key: 'template:free',
        api: {
          createSession: async (body) => {
            requests.push(clone(body))
            return { id: 4, templateId: 1, templateVersionId: 2 }
          }
        }
      })
      await reopened.workflow.restore()
      if (saved.get('unsettled:template:free') !== null) {
        assert.deepEqual(clone(reopened.workflow.getSnapshot().sessionRequest), original)
        await reopened.workflow.generate()
        assert.deepEqual(requests, [original, original])
      }
      assert.equal(saved.get('unsettled:template:free'), null)
      assert.equal(saved.get(primary).sessionId, 4)
      assert.equal(saved.get(primary).sessionRequest, null)
      assert.equal(saved.get('session:4').sessionId, 4)
      assert.equal(saved.get('session:4').sessionRequest, null)
      reopened.workflow.dispose()
    })

for (const phase of ['unconfirmed', 'conflict'])
  test(`E3-14 newly observed original F remains independently confirmable over ${phase} initial intent`, async () => {
    const saved = new Map()
    const g = gate()
    const calls = []
    const h = workflowFixture({
      saved,
      key: 'template:free',
      template: null,
      sessionId: null,
      api: {
        freePreset: () => g.promise,
        createSession: async (body) => {
          calls.push(clone(body))
          return { id: 4, templateId: 1, templateVersionId: 2 }
        }
      }
    })
    if (phase === 'unconfirmed')
      h.control.beforeSet = (key, value) => {
        if (key === 'initial-input:template:free') {
          saved.set(key, clone(value))
          throw Error('accepted pending')
        }
      }
    h.workflow.setDescription('early')
    h.control.beforeSet = () => {}
    if (phase === 'conflict') {
      saved.set('initial-input:template:free', { foreign: true })
      h.workflow.setDescription('latest volatile')
    }
    const raw = ordinary({
      sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'old-body' }
    })
    saved.set('template:free', clone(raw))
    saved.set('unsettled:template:free', {
      protocol: 2,
      draftKey: 'template:free',
      record: clone(raw)
    })
    const restoring = h.workflow.restore()
    g.release(template())
    await restoring
    const writes = h.writes.length
    const before = JSON.stringify([...saved])
    await h.workflow.generate()
    assert.deepEqual(calls, [raw.sessionRequest])
    assert.equal(h.writes.length, writes)
    assert.equal(JSON.stringify([...saved]), before)
    h.workflow.dispose()
  })

for (const changed of [false, true])
  test(`fresh server drain requires its own GET; changed pending base=${changed}`, async () => {
    let reads = 0,
      puts = 0,
      quotes = 0
    let session
    const h = workflowFixture({
      saved: new Map(),
      template: null,
      api: {
        getSession: async () => {
          reads++
          return clone(session)
        },
        putDraft: async () => {
          puts++
        },
        quote: async () => {
          quotes++
          return {}
        }
      }
    })
    session = {
      ...h.session,
      draft: {
        input: { description: 'old', userNotes: '', inputMediaIds: [7, 8] },
        updatedAt: '2026-11-13T00:00:00Z'
      }
    }
    const restoring = h.workflow.restore()
    h.workflow.setDescription('early')
    await restoring
    assert.equal(reads, 1)
    h.workflow.setDescription('')
    assert.equal(h.saved.has('session:4'), false, 'sync setter cannot use a cached server anchor')
    if (changed)
      session = {
        ...session,
        draft: {
          input: { description: 'new remote base', userNotes: '', inputMediaIds: [8, 9] },
          updatedAt: '2026-11-14T00:00:00Z'
        }
      }
    const journal = JSON.stringify(h.saved.get('initial-input:session:4'))
    await h.workflow.resumeDraftSave({ target: 'local-input' })
    assert.equal(reads, 2)
    if (changed) {
      assert.equal(h.saved.has('session:4'), false)
      assert.equal(JSON.stringify(h.saved.get('initial-input:session:4')), journal)
      assert.deepEqual(clone(h.workflow.getSnapshot().photos.map((photo) => photo.mediaId)), [8, 9])
      await h.workflow.resumeDraftSave({ target: 'local-input' })
      assert.equal(reads, 3)
    }
    assert.equal(h.saved.get('session:4').description, '')
    assert.deepEqual(
      h.saved.get('session:4').photos.map((photo) => photo.mediaId),
      changed ? [8, 9] : [7, 8]
    )
    assert.equal(puts + quotes, 0)
    await h.workflow.resumeDraftSave({ target: 'local-input' })
    assert.equal(reads, changed ? 3 : 2, 'settled stale local callback performs no GET')
    h.workflow.dispose()
  })

for (const invalidation of [
  'third-target',
  'overlay',
  'source-change',
  'hide-show',
  'dispose',
  'account',
  'invalid-GET',
  'missing-GET',
  'failed-GET'
])
  test(`fresh server action ${invalidation} cannot use stale evidence to write`, async () => {
    let reads = 0,
      current = true
    const g = gate()
    let session
    const h = workflowFixture({
      saved: new Map(),
      template: null,
      isCurrent: () => current,
      api: {
        getSession: async () => {
          reads++
          return reads === 2 ? g.promise : clone(session)
        }
      }
    })
    session = {
      ...h.session,
      draft: {
        input: { description: 'old', userNotes: '', inputMediaIds: [7, 8] },
        updatedAt: '2026-11-13T00:00:00Z'
      }
    }
    const restoring = h.workflow.restore()
    h.workflow.setDescription('early')
    await restoring
    const action = h.workflow.resumeDraftSave({ target: 'local-input' })
    await new Promise(setImmediate)
    assert.equal(reads, 2)
    if (invalidation === 'third-target') h.saved.set('session:4', { foreign: true })
    if (invalidation === 'overlay') h.workflow.setDescription('newest')
    if (invalidation === 'source-change') {
      session = {
        ...session,
        draft: {
          input: { description: 'changed source', userNotes: '', inputMediaIds: [9] },
          updatedAt: '2026-11-14T00:00:00Z'
        }
      }
      await h.workflow.refresh()
    }
    if (invalidation === 'hide-show') {
      h.workflow.setPageVisible({ visible: false })
      h.workflow.setPageVisible({ visible: true })
    }
    if (invalidation === 'dispose') h.workflow.dispose()
    if (invalidation === 'account') current = false
    const before = JSON.stringify([...h.saved]),
      writes = h.writes.length
    if (invalidation === 'failed-GET')
      g.reject(
        new Proxy(
          {},
          {
            get: () => {
              throw Error('unknown error getter')
            }
          }
        )
      )
    else
      g.release(
        invalidation === 'missing-GET'
          ? { ...session, draft: undefined }
          : invalidation === 'invalid-GET'
          ? { ...session, draft: { ...session.draft, updatedAt: 'invalid' } }
          : session
      )
    await action
    assert.equal(h.writes.length, writes)
    assert.equal(JSON.stringify([...h.saved]), before)
    if (invalidation === 'overlay') assert.equal(h.workflow.getSnapshot().description, 'newest')
    if (
      invalidation === 'invalid-GET' ||
      invalidation === 'missing-GET' ||
      invalidation === 'failed-GET'
    ) {
      assert.ok(h.workflow.getSnapshot().storageError)
      await h.workflow.refresh()
      assert.ok(
        h.workflow.getSnapshot().storageError,
        'successful readonly GET does not clear owned local-save feedback'
      )
    }
    h.workflow.dispose()
  })
test('fresh server local flight is installed before getter callback reentry and shares one GET', async () => {
  const saved = new Map()
  const g = gate()
  let reads = 0
  let armed = false
  let nested
  let w
  const apiFixture = workflowFixture()
  apiFixture.workflow.dispose()
  const session = {
    ...apiFixture.session,
    draft: {
      input: { description: 'old', userNotes: '', inputMediaIds: [7, 8] },
      updatedAt: '2026-11-13T00:00:00Z'
    }
  }
  w = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      api: {
        ...apiFixture.api,
        getSession: async () => {
          reads++
          return reads === 2 ? g.promise : clone(session)
        }
      },
      files: { exists: async () => true, preview: async () => '/private' },
      storage: {
        get: (key) => {
          if (armed) {
            armed = false
            nested = w.resumeDraftSave({ target: 'local-input' })
          }
          return saved.has(key) ? clone(saved.get(key)) : undefined
        },
        set: (key, value) => saved.set(key, clone(value))
      },
      key: 'session:4',
      sessionId: 4,
      makeId: () => assert.fail('local action minted ID')
    })
  const restoring = w.restore()
  w.setDescription('early')
  await restoring
  armed = true
  const action = w.resumeDraftSave({ target: 'local-input' })
  await new Promise(setImmediate)
  assert.equal(reads, 2)
  assert.ok(nested)
  g.release(session)
  await Promise.all([action, nested])
  assert.equal(saved.get('session:4').description, 'early')
  assert.equal(reads, 2)
  await w.resumeDraftSave({ target: 'local-input' })
  assert.equal(reads, 2)
  w.dispose()
})

test('fresh changed server anchor is checked before retrying a rejected target write', async () => {
  let reads = 0
  let session
  const h = workflowFixture({
    saved: new Map(),
    template: null,
    api: {
      getSession: async () => {
        reads++
        return clone(session)
      }
    }
  })
  session = {
    ...h.session,
    draft: {
      input: { description: 'old', userNotes: '', inputMediaIds: [7, 8] },
      updatedAt: '2026-11-13T00:00:00Z'
    }
  }
  const restoring = h.workflow.restore()
  h.workflow.setDescription('early')
  await restoring
  h.control.fail = (key) => key === 'session:4'
  await h.workflow.resumeDraftSave({ target: 'local-input' })
  assert.ok(h.saved.get('initial-input:session:4').prepared)
  h.control.fail = () => false
  session = {
    ...session,
    draft: {
      input: { description: 'changed', userNotes: '', inputMediaIds: [8, 9] },
      updatedAt: '2026-11-14T00:00:00Z'
    }
  }
  const count = h.writes.length
  await h.workflow.resumeDraftSave({ target: 'local-input' })
  assert.equal(reads, 3)
  assert.equal(h.saved.has('session:4'), false)
  assert.equal(
    h.writes.length,
    count,
    'fresh changed anchor must be checked before reconciliation writes the old target'
  )
  h.workflow.dispose()
})
for (const kind of ['session', 'submission'])
  test(`original ${kind} freeze envelope accepted-then-throw retries owned body without new ID`, async () => {
    let calls = 0
    const h = workflowFixture({
      sessionId: kind === 'session' ? null : 4,
      api: {
        createSession: async () => {
          calls++
          return { id: 4, templateId: 1, templateVersionId: 2 }
        },
        generate: async (body) => {
          calls++
          return require('../fixtures/creation.cjs').task(body)
        }
      }
    })
    h.workflow.setDescription('original')
    if (kind === 'submission') await h.workflow.prepareQuote()
    let failed = false
    h.control.beforeSet = (key, value) => {
      if (
        !failed &&
        key.startsWith('unsettled:') &&
        value?.record &&
        (kind === 'session' ? value.record.sessionRequest : value.record.submission)
      ) {
        failed = true
        h.saved.set(key, clone(value))
        throw Error('accepted envelope')
      }
    }
    await (kind === 'session' ? h.workflow.prepareQuote() : h.workflow.generate())
    assert.equal(failed, true)
    assert.equal(calls, 0)
    h.control.beforeSet = () => {}
    await h.workflow.generate()
    assert.equal(calls, 1)
    assert.equal(h.workflow.getSnapshot().sessionRequest, null)
    assert.equal(h.workflow.getSnapshot().submission, null)
    h.workflow.dispose()
  })

test('E4-03 simultaneous remote/local Notices keep target intent across cleanup and retained callback', async () => {
  const { withPages } = require('../fixtures/creation-pages.cjs')
  const core = require('../source.cjs').load('src/features/creation/initial-input-intent.js')
  const entry = {
    key: 'session:4',
    kind: 'session',
    mode: null,
    templateId: null,
    templateVersionId: null,
    sessionId: 4
  }
  const raw = ordinary({
    sessionId: 4,
    userNotes: '',
    draftPaused: true,
    recoveryKey: 'unsettled:session:4'
  })
  const journal = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'local text' },
    observed: [
      { key: entry.key, fingerprint: core.fingerprintInitialInputValue({ value: raw }).value }
    ],
    prepared: null
  }
  const saved = new Map([
    [entry.key, raw],
    ['initial-input:session:4', journal]
  ])
  let writes = 0,
    puts = 0
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const local = [...document.querySelectorAll('#create button')].find(
        (b) => b.textContent === '保存本机输入'
      )
      assert.ok(local)
      const prop = Object.keys(local).find((k) => k.startsWith('__reactProps$'))
      const retained = local[prop].onClick
      const before = JSON.stringify([...saved])
      await h.act(async () => h.click('create', '恢复保存'))
      assert.equal(JSON.stringify([...saved]), before)
      assert.equal(writes, 0)
      assert.equal(puts, 0)
      await h.act(async () => {
        local.click()
        local.click()
      })
      assert.equal(saved.get('initial-input:session:4'), null)
      assert.equal(h.controllers[0].getSnapshot().draftPaused, true)
      await h.act(async () => retained())
      assert.equal(puts, 0)
      assert.equal(h.controllers[0].getSnapshot().draftPaused, true)
      await h.act(async () => h.click('create', '恢复保存'))
      assert.equal(puts, 1)
      assert.equal(h.controllers[0].getSnapshot().draftPaused, false)
    },
    {
      creationStorage: {
        get: (key) => (saved.has(key) ? clone(saved.get(key)) : undefined),
        set: (key, value) => {
          writes++
          saved.set(key, clone(value))
        }
      },
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          putDraft: async (args) => {
            puts++
            return ports.putDraft(args)
          }
        }
      })
    }
  )
})

test('E2-05 explicit session preserves complete local source while reading current template', async () => {
  const { load } = require('../source.cjs')
  const config = { ...template('effect'), templateId: 9 }
  const raw = ordinary({
    mode: 'effect',
    templateId: 9,
    templateVersionId: 7,
    sessionId: 4,
    description: 'preserved inactive text',
    userNotes: 'local notes',
    recoveryKey: 'unsettled:session:4'
  })
  const saved = new Map([['session:4', raw]])
  const calls = []
  const w = load('src/creation-workflow.js').createWorkflow({
    api: {
      account: async () => ({}),
      getSession: async () => ({
        id: 4,
        mode: 'effect',
        templateId: 9,
        templateVersionId: 7,
        draft: {
          input: { description: '', userNotes: 'remote notes', inputMediaIds: [99] },
          updatedAt: '2026-11-13T00:00:00Z'
        }
      }),
      template: async (args) => {
        calls.push(clone(args))
        return config
      },
      freePreset: async () => assert.fail('free fallback'),
      tasks: async () => ({ items: [], hasMore: false, nextCursor: null })
    },
    files: { exists: async () => true, preview: async () => '/private' },
    storage: { get: (key) => saved.get(key), set: () => assert.fail('readonly source load wrote') },
    key: 'session:4',
    sessionId: 4,
    templateVersionId: 7,
    makeId: () => assert.fail('readonly load minted ID')
  })
  await w.restore()
  assert.deepEqual(calls, [{ templateId: 9 }])
  assert.equal(Object.hasOwn(w.getSnapshot(), 'templateVersionId'), false)
  assert.equal(w.getSnapshot().userNotes, 'local notes')
  assert.equal(w.getSnapshot().description, 'preserved inactive text')
  assert.deepEqual(clone(w.getSnapshot().photos.map((photo) => photo.mediaId)), [7, 8])
  assert.equal(saved.get('session:4'), raw)
  w.dispose()
})
test('E2-07 failed first storage getter retains visible edit without default record or unknown error property access', () => {
  const opaque = new Proxy(
    {},
    {
      get: () => {
        throw Error('unknown error getter')
      }
    }
  )
  let sets = 0
  const w = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      api: {},
      files: {},
      storage: {
        get: () => {
          throw opaque
        },
        set: () => sets++
      },
      key: 'session:4',
      sessionId: 4,
      template: template(),
      makeId: () => assert.fail('unknown source minted ID')
    })
  assert.equal(w.setDescription('visible unsaved'), false)
  assert.equal(w.getSnapshot().description, 'visible unsaved')
  assert.ok(w.getSnapshot().storageError)
  assert.equal(sets, 0)
  w.dispose()
})

for (const kind of ['malformed', 'conflict'])
  test(`E4-01 real ${kind} Notice is explanatory without local retry/reset or business writes`, async () => {
    const { withPages } = require('../fixtures/creation-pages.cjs')
    const key = 'template:free'
    const base = ordinary()
    const saved = new Map([[key, base]])
    if (kind === 'malformed') saved.set('initial-input:template:free', { private: 'keep raw' })
    else saved.set('template:free:entry:free:1:2', { ...base, description: 'different source' })
    const before = JSON.stringify([...saved])
    let writes = 0
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await h.act(async () =>
          h.handlers.get('composer__input').onInput({ detail: { value: 'visible unsaved' } })
        )
        const text = document.querySelector('#create').textContent
        assert.match(text, kind === 'malformed' ? /未通过校验/ : /来源发生冲突/)
        assert.equal(
          [...document.querySelectorAll('#create button')].some((button) =>
            /保存本机输入|重试本机保存|重置|清空/.test(button.textContent)
          ),
          false
        )
        assert.equal(h.controllers[0].getSnapshot().description, 'visible unsaved')
        assert.equal(writes, 0)
        assert.equal(h.businessWrites.length, 0)
        assert.equal(JSON.stringify([...saved]), before)
      },
      {
        route: {},
        creationStorage: {
          get: (key) => (saved.has(key) ? clone(saved.get(key)) : undefined),
          set: () => writes++
        }
      }
    )
  })
test('E4-01 real failed local journal Notice deduplicates only its owned feedback and retries locally', async () => {
  const { withPages } = require('../fixtures/creation-pages.cjs')
  const saved = new Map()
  let down = true,
    fail = true
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.act(async () =>
        h.handlers.get('composer__input').onInput({ detail: { value: 'early failed input' } })
      )
      down = false
      await h.act(async () => h.click('create', '刷新'))
      const w = h.controllers[0]
      assert.equal(w.getSnapshot().localInputRecovery.canRetryLocalSave, true)
      assert.equal(w.getSnapshot().localInputRecovery.ownsStorageError, true)
      const message = w.getSnapshot().localInputRecovery.message
      assert.equal(
        [...document.querySelectorAll('#create aside')].filter((aside) =>
          aside.textContent.includes(message)
        ).length,
        1
      )
      assert.equal(h.businessWrites.length, 0)
      fail = false
      await h.act(async () => h.click('create', '重试本机保存'))
      assert.equal(saved.get('initial-input:template:free'), null)
      assert.equal(saved.get('template:free:entry:free:1').description, 'early failed input')
      assert.equal(h.businessWrites.length, 0)
    },
    {
      route: {},
      creationStorage: {
        get: (key) => (saved.has(key) ? clone(saved.get(key)) : undefined),
        set: (key, value) => {
          if (fail && key.startsWith('initial-input:')) throw Error('opaque')
          saved.set(key, clone(value))
        }
      },
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          freePreset: async () => {
            if (down)
              throw Object.assign(Error('REQUEST_OUTCOME_UNKNOWN'), {
                isOutcomeUnknown: true,
                code: 'REQUEST_OUTCOME_UNKNOWN',
                status: null
              })
            return template()
          },
          createSession: async () => assert.fail('local retry started session')
        }
      })
    }
  )
})

for (const reentrant of [false, true])
  test(`SPEC-01 recovered first getter projects untouched source before setter; reentry=${reentrant}`, () => {
    const raw = ordinary({ sessionId: 4, recoveryKey: 'unsettled:session:4' })
    const saved = new Map([['session:4', clone(raw)]])
    let failing = true
    let armed = false
    let fired = false
    const writes = []
    let workflow
    workflow = require('../source.cjs')
      .load('src/creation-workflow.js')
      .createWorkflow({
        api: {},
        files: {},
        template: template(),
        key: 'session:4',
        sessionId: 4,
        storage: {
          get: (key) => {
            if (failing) throw Error('transient getter')
            if (armed && !fired) {
              fired = true
              workflow.setDescription('getter newest description')
            }
            return saved.get(key)
          },
          set: (key, value) => {
            writes.push(key)
            saved.set(key, clone(value))
          }
        },
        makeId: () => assert.fail('source recovery minted an ID')
      })
    assert.equal(workflow.setDescription('first unsaved'), false)
    assert.equal(writes.length, 0)
    assert.deepEqual(saved.get('session:4'), raw)
    failing = false
    armed = reentrant
    const accepted = reentrant
      ? workflow.setUserNotes('explicit notes')
      : workflow.setDescription('second')
    assert.equal(accepted, true)
    const record = saved.get('session:4')
    assert.deepEqual(record.photos, raw.photos)
    assert.equal(record.userNotes, reentrant ? 'explicit notes' : 'untouched')
    assert.equal(record.description, reentrant ? 'getter newest description' : 'second')
    if (reentrant) assert.equal(fired, true)
    const before = workflow.getSnapshot()
    const slots = before.photos
    const count = writes.length
    assert.equal(workflow.removePhoto('missing'), false)
    assert.equal(workflow.getSnapshot(), before)
    assert.equal(workflow.getSnapshot().photos, slots)
    assert.equal(writes.length, count)
    workflow.dispose()
  })

test('SPEC-02 trusted complete mirror discovers alias F before config failure and confirms only its body', async () => {
  const key = 'template:free'
  const mirror = ordinary({ sessionId: 4, userNotes: '', recoveryKey: 'unsettled:session:4' })
  const body = {
    sessionId: 4,
    input: { description: 'frozen body', userNotes: '', inputMediaIds: [7, 8] },
    clientRequestId: 'original-alias-F',
    quoteToken: 'old-q'
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
  const frozen = { ...mirror, description: 'frozen outer', submission }
  const saved = new Map([
    [key, clone(mirror)],
    ['session:4', clone(frozen)],
    ['unsettled:session:4', { protocol: 2, draftKey: 'session:4', record: clone(frozen) }]
  ])
  const calls = []
  let configs = 0
  const h = workflowFixture({
    saved,
    key,
    template: null,
    sessionId: null,
    api: {
      freePreset: async () => {
        configs++
        throw Error('TEMPLATE_UNAVAILABLE')
      },
      generate: async (value) => {
        calls.push(clone(value))
        return require('../fixtures/creation.cjs').task(value)
      },
      quote: async () => assert.fail('original F confirmation quoted'),
      putDraft: async () => assert.fail('original F confirmation saved remote draft')
    }
  })
  h.workflow.dispose()
  h.workflow = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      api: h.api,
      files: { exists: async () => true, preview: async () => '/private.png' },
      key,
      storage: {
        get: (key) => (saved.has(key) ? clone(saved.get(key)) : undefined),
        set: (key, value) => {
          h.writes.push({ key, draft: clone(value) })
          saved.set(key, clone(value))
        }
      },
      makeId: () => assert.fail('original alias F confirmation minted a new ID')
    })
  const restoring = h.workflow.restore()
  assert.deepEqual(
    clone(h.workflow.getSnapshot().submission),
    submission,
    'first shared inspection publishes F synchronously'
  )
  assert.equal(h.workflow.getSnapshot().controls.generateLabel, '确认提交结果')
  await restoring
  assert.ok(configs > 0)
  await h.workflow.generate()
  assert.deepEqual(calls, [body])
  assert.ok(h.writes.length > 0, 'original F may perform its guarded owned persistence')
  assert.ok(h.writes.every((write) => ['session:4', 'unsettled:session:4'].includes(write.key)))
  assert.deepEqual(saved.get(key), mirror)
  assert.equal(saved.get('session:4').submission, null)
  assert.equal(saved.get('unsettled:session:4'), null)
  assert.equal(
    [...saved.keys()].some((key) => key.startsWith('initial-input:')),
    false
  )
  h.workflow.dispose()
})

test('SPEC-03 real eligible inflight and cached quote calls grow attempt revision without duplicate HTTP', async () => {
  let calls = 0
  const pending = gate()
  const saved = new Map([
    ['session:4', ordinary({ sessionId: 4, userNotes: '', recoveryKey: 'unsettled:session:4' })]
  ])
  const transport = require('../source.cjs').load('src/creation-api.js', {
    '@tarojs/taro': {
      request: async (request) => {
        assert.equal(request.method, 'POST')
        assert.match(request.url, /\/generation-quotes$/)
        assert.deepEqual(clone(request.data.input.inputMediaIds), [7, 8])
        calls++
        return pending.promise
      }
    },
    './auth': {
      clearToken() {},
      getStoredToken: () => 'fixture-token',
      getStoredSession: () => ({
        userId: 1,
        token: 'fixture-token',
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    }
  }).creationApi
  const h = workflowFixture({ saved, api: { quote: transport.quote } })
  const beforeWrites = h.writes.length
  const first = h.workflow.prepareQuote()
  await new Promise(setImmediate)
  assert.equal(calls, 1)
  assert.equal(h.workflow.getSnapshot().quoting, true)
  const firstRevision = h.workflow.getSnapshot().quoteAttemptRevision
  const second = h.workflow.prepareQuote()
  assert.equal(h.workflow.getSnapshot().quoteAttemptRevision, firstRevision + 1)
  assert.equal(calls, 1)
  assert.equal(h.workflow.getSnapshot().quoting, true)
  assert.equal(h.writes.length, beforeWrites, 'real inflight attempt publications are readonly')
  pending.release({
    statusCode: 200,
    data: {
      data: {
        costCredits: 3,
        templateId: 1,
        quoteToken: 'real-q',
        validUntil: '2099-01-01T00:00:00Z'
      }
    }
  })
  await Promise.all([first, second])
  const cached = h.workflow.getSnapshot().quote
  assert.ok(cached)
  assert.equal(h.workflow.getSnapshot().quoting, false)
  const revision = h.workflow.getSnapshot().quoteAttemptRevision
  const writes = h.writes.length
  const cachedPublications = []
  const unsubscribe = h.workflow.subscribe(() =>
    cachedPublications.push(h.workflow.getSnapshot().quoting)
  )
  await h.workflow.prepareQuote()
  unsubscribe()
  assert.ok(cachedPublications.length > 0)
  assert.ok(
    cachedPublications.every((quoting) => quoting === false),
    'cached attempt must not invent request state'
  )
  assert.equal(h.workflow.getSnapshot().quoteAttemptRevision, revision + 1)
  assert.equal(h.workflow.getSnapshot().quote, cached)
  assert.equal(h.workflow.getSnapshot().quoting, false)
  assert.equal(calls, 1)
  assert.equal(h.writes.length, writes)
  assert.ok(
    [...saved.values()].every(
      (value) => value == null || !Object.hasOwn(value, 'quoteAttemptRevision')
    )
  )
  assert.equal(writes, beforeWrites)
  assert.equal(h.workflow.setDescription('explicit edit after cached quote'), true)
  assert.ok(
    h.writes.length > beforeWrites,
    'metadata assertion must inspect a newly serialized draft'
  )
  assert.ok(
    [...saved.values()].every(
      (value) => value == null || !Object.hasOwn(value, 'quoteAttemptRevision')
    )
  )
  assert.equal(calls, 1)
  h.workflow.dispose()
})

test('SPEC-04 real create-session then session edit then template edit and both-route reopen share canonical input', async () => {
  const saved = new Map()
  let creates = 0
  const first = workflowFixture({
    saved,
    key: 'template:free',
    template: null,
    sessionId: null,
    api: {
      createSession: async (body) => {
        creates++
        return { id: 4, templateId: body.templateId }
      }
    }
  })
  await first.workflow.restore()
  first.workflow.setDescription('created on template')
  await first.workflow.prepareQuote()
  assert.equal(creates, 1)
  const primary = 'template:free:entry:free:1'
  assert.ok(saved.has(primary))
  assert.equal(saved.get('session:4').sessionId, 4)
  const retainedMirror = clone(saved.get(primary))
  first.workflow.dispose()
  let nextMedia = 14
  const session = workflowFixture({
    saved,
    key: 'session:4',
    sessionId: 4,
    template: null,
    files: {
      choose: async () => [
        { path: '/one.png', mimeType: 'image/png', size: 10 },
        { path: '/two.png', mimeType: 'image/png', size: 10 }
      ],
      upload: async () => ({ id: ++nextMedia })
    }
  })
  await session.workflow.restore()
  await session.workflow.addPhotos()
  session.workflow.setDescription('edited on session')
  const ids = saved.get('session:4').photos.map((photo) => photo.id)
  assert.equal(ids.length, 2)
  assert.deepEqual(
    saved.get('session:4').photos.map((photo) => photo.mediaId),
    [15, 16]
  )
  session.workflow.dispose()
  const templateRoute = workflowFixture({
    saved,
    key: 'template:free',
    sessionId: null,
    template: null
  })
  await templateRoute.workflow.restore()
  assert.equal(templateRoute.workflow.getSnapshot().description, 'edited on session')
  assert.deepEqual(clone(templateRoute.workflow.getSnapshot().photos.map((photo) => photo.id)), ids)
  assert.equal(
    templateRoute.workflow.movePhoto({ slotId: ids[1], targetIndex: 0, expectedIds: ids }),
    true
  )
  templateRoute.workflow.setDescription('edited on template again')
  templateRoute.workflow.dispose()
  const reopenedSession = workflowFixture({ saved, key: 'session:4', sessionId: 4, template: null })
  await reopenedSession.workflow.restore()
  assert.equal(reopenedSession.workflow.getSnapshot().description, 'edited on template again')
  assert.deepEqual(
    clone(reopenedSession.workflow.getSnapshot().photos.map((photo) => photo.id)),
    [...ids].reverse()
  )
  assert.deepEqual(
    clone(reopenedSession.workflow.getSnapshot().photos.map((photo) => photo.mediaId)),
    [16, 15]
  )
  assert.deepEqual(saved.get(primary), retainedMirror)
  assert.equal(
    [...saved.keys()].some((key) => key.startsWith('initial-input:')),
    false
  )
  assert.equal(creates, 1)
  reopenedSession.workflow.dispose()
})

for (const mismatch of [{ templateVersionId: 3 }, { templateId: 9 }])
  test(`SPEC-02 independently valid alias F mismatching trusted reference ${JSON.stringify(
    mismatch
  )} stays protected`, async () => {
    const key = 'template:free'
    const mirror = ordinary({ sessionId: 4, userNotes: '', recoveryKey: 'unsettled:session:4' })
    const version = mismatch.templateVersionId || 2
    const body = {
      sessionId: 4,
      input: { description: 'foreign F', userNotes: '', inputMediaIds: [7, 8] },
      clientRequestId: 'foreign-F',
      quoteToken: 'foreign-q'
    }
    const frozen = {
      ...mirror,
      ...mismatch,
      submission: {
        protocol: 2,
        path: '/generations',
        sessionId: 4,
        sourceArtifactId: null,
        templateVersionId: version,
        costCredits: 3,
        body
      }
    }
    const envelope = { protocol: 2, draftKey: 'session:4', record: frozen }
    const { readRecoveryEntry } = require('../source.cjs').load(
      'src/features/creation/recovery-contract.js'
    )
    assert.ok(
      readRecoveryEntry({ value: envelope, recoveryKey: 'unsettled:session:4', storageKey: key }),
      'negative control must be independently valid F'
    )
    const saved = new Map([
      [key, clone(mirror)],
      ['session:4', clone(frozen)],
      ['unsettled:session:4', clone(envelope)]
    ])
    const before = JSON.stringify([...saved])
    let calls = 0
    const h = workflowFixture({
      saved,
      key,
      template: null,
      sessionId: null,
      api: {
        generate: async () => {
          calls++
        },
        createSession: async () => {
          calls++
        },
        quote: async () => {
          calls++
        }
      }
    })
    await h.workflow.restore()
    await h.workflow.generate()
    assert.equal(calls, 0)
    assert.equal(h.writes.length, 0)
    assert.equal(JSON.stringify([...saved]), before)
    h.workflow.dispose()
  })

test('SPEC-01 getter recovery does not depend on configuration retry succeeding first', async () => {
  const key = 'template:free'
  const raw = ordinary()
  const saved = new Map([[key, clone(raw)]])
  let failing = true
  let configs = 0
  let writes = 0
  const w = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      key,
      files: {},
      makeId: () => assert.fail('config retry minted ID'),
      storage: {
        get: (key) => {
          if (failing) throw Error('transient')
          return saved.get(key)
        },
        set: (key, value) => {
          writes++
          saved.set(key, clone(value))
        }
      },
      api: {
        account: async () => ({}),
        freePreset: async () => {
          configs++
          if (configs === 1) throw Error('TEMPLATE_UNAVAILABLE')
          return template()
        }
      }
    })
  assert.equal(w.setDescription('first'), false)
  await w.restore()
  assert.equal(configs, 1)
  assert.equal(w.getSnapshot().template, null)
  failing = false
  assert.equal(w.setDescription('second'), true)
  assert.deepEqual(saved.get(key).photos, raw.photos)
  assert.equal(saved.get(key).userNotes, 'untouched')
  const count = writes
  const photos = w.getSnapshot().photos
  const slots = [...photos]
  await w.refresh()
  assert.equal(configs, 2)
  assert.equal(writes, count)
  assert.equal(w.getSnapshot().photos[0], slots[0])
  assert.equal(w.getSnapshot().photos[1], slots[1])
  assert.equal(w.getSnapshot().description, 'second')
  w.dispose()
})

function unresolvedEnvelopeFixture() {
  const key = 'template:free'
  const prior = ordinary({ sessionId: 4, userNotes: '', recoveryKey: 'unsettled:session:4' })
  const body = {
    sessionId: 4,
    input: { description: 'original body', userNotes: '', inputMediaIds: [7, 8] },
    clientRequestId: 'original-envelope',
    quoteToken: 'old-q'
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
  const envelope = { protocol: 2, draftKey: 'session:4', record: { ...clone(prior), submission } }
  const { readRecoveryEntry } = require('../source.cjs').load(
    'src/features/creation/recovery-contract.js'
  )
  assert.ok(
    readRecoveryEntry({ value: envelope, recoveryKey: 'unsettled:session:4', storageKey: key })
  )
  const saved = new Map([
    [key, clone(prior)],
    ['session:4', clone(prior)],
    ['unsettled:session:4', clone(envelope)]
  ])
  return { key, prior, body, submission, envelope, saved }
}
test('SPEC-01 V3 partial ordinary candidate cannot admit quote/choose while required original envelope is unreadable', async () => {
  const f = unresolvedEnvelopeFixture()
  let quotes = 0,
    choices = 0,
    uploads = 0
  const writes = []
  const w = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      key: f.key,
      template: template(),
      storage: {
        get: (key) => {
          if (key === 'unsettled:session:4') throw Error('required envelope unreadable')
          return f.saved.get(key)
        },
        set: (key, value) => {
          writes.push(key)
          f.saved.set(key, clone(value))
        }
      },
      api: {
        quote: async () => {
          quotes++
          return {
            templateId: 1,
            costCredits: 3,
            quoteToken: 'q',
            validUntil: '2099-01-01T00:00:00Z'
          }
        }
      },
      files: {
        choose: async () => {
          choices++
          return []
        },
        upload: async () => {
          uploads++
          return { id: 9 }
        }
      },
      makeId: () => assert.fail('unresolved source minted ID')
    })
  const before = JSON.stringify([...f.saved])
  await w.prepareQuote()
  await w.addPhotos()
  assert.equal(quotes, 0)
  assert.equal(choices, 0)
  assert.equal(uploads, 0)
  assert.equal(writes.length, 0)
  assert.equal(JSON.stringify([...f.saved]), before)
  assert.equal(w.getSnapshot().controls.canSelectPhotos, false)
  w.dispose()
})
test('SPEC-01 V3 recovered required envelope projects original F before second ordinary serializer', async () => {
  const f = unresolvedEnvelopeFixture()
  let failing = true,
    posts = 0
  const writes = []
  const w = require('../source.cjs')
    .load('src/creation-workflow.js')
    .createWorkflow({
      key: f.key,
      template: template(),
      storage: {
        get: (key) => {
          if (failing && key === 'unsettled:session:4') throw Error('transient required envelope')
          return f.saved.get(key)
        },
        set: (key, value) => {
          writes.push(key)
          f.saved.set(key, clone(value))
        }
      },
      api: {
        generate: async (body) => {
          posts++
          assert.deepEqual(clone(body), f.body)
          return require('../fixtures/creation.cjs').task(body)
        }
      },
      files: {},
      makeId: () => assert.fail('original F recovery minted ID')
    })
  assert.equal(w.setDescription('first unsaved'), false)
  assert.equal(writes.length, 0)
  failing = false
  assert.equal(w.setDescription('second own edit'), true)
  assert.equal(posts, 0)
  assert.deepEqual(clone(w.getSnapshot().submission), f.submission)
  assert.deepEqual(clone(w.getSnapshot().photos), f.prior.photos)
  assert.deepEqual(f.saved.get('unsettled:session:4').record.submission, f.submission)
  assert.deepEqual(f.saved.get('session:4').submission, f.submission)
  assert.equal(f.saved.has('initial-input:template:free'), false)
  await w.generate()
  assert.equal(posts, 1)
  assert.equal(f.saved.get('unsettled:session:4'), null)
  w.dispose()
})

for (const invalidation of ['hide', 'hide-show'])
  test(`QUALITY-01 uploading publication ${invalidation} stops before file upload`, async () => {
    let uploads = 0
    let triggered = false
    let afterInvalidation
    const h = workflowFixture({
      files: {
        choose: async () => [{ path: '/publication.png', mimeType: 'image/png', size: 10 }],
        upload: async () => {
          uploads++
          return { id: 7 }
        }
      }
    })
    h.workflow.subscribe(() => {
      if (triggered || !h.workflow.getSnapshot().photos.some((p) => p.status === 'uploading'))
        return
      triggered = true
      h.workflow.setPageVisible({ visible: false })
      if (invalidation === 'hide-show') h.workflow.setPageVisible({ visible: true })
      afterInvalidation = { writes: h.writes.length, raw: JSON.stringify([...h.saved]) }
    })
    await h.workflow.addPhotos()
    assert.equal(triggered, true, 'the actual uploading publication must invalidate the invocation')
    assert.equal(uploads, 0)
    assert.equal(h.writes.length, afterInvalidation.writes)
    assert.equal(JSON.stringify([...h.saved]), afterInvalidation.raw)
    assert.equal(h.workflow.getSnapshot().photos[0].status, 'uploading')
    h.workflow.dispose()
  })

for (const invalidation of ['hide', 'hide-show', 'owner', 'dispose', 'remove', 'external-source'])
  for (const outcome of ['resolve', 'reject'])
    test(`QUALITY-01 inflight upload ${outcome} after ${invalidation} does not regain local write interest`, async () => {
      const flight = gate()
      let current = true
      let uploads = 0
      const h = workflowFixture({
        isCurrent: () => current,
        files: {
          choose: async () => [{ path: '/inflight.png', mimeType: 'image/png', size: 10 }],
          upload: () => {
            uploads++
            return flight.promise
          }
        }
      })
      const adding = h.workflow.addPhotos()
      await new Promise(setImmediate)
      assert.equal(uploads, 1, 'the real file upload must already be in flight')
      const slot = h.workflow.getSnapshot().photos[0]
      assert.equal(slot.status, 'uploading')
      if (invalidation === 'owner') current = false
      else if (invalidation === 'dispose') h.workflow.dispose()
      else if (invalidation === 'remove') assert.equal(h.workflow.removePhoto(slot.id), true)
      else if (invalidation === 'external-source') {
        h.saved.set('session:4', { ...h.saved.get('session:4'), description: 'foreign input' })
      } else {
        h.workflow.setPageVisible({ visible: false })
        if (invalidation === 'hide-show') h.workflow.setPageVisible({ visible: true })
      }
      const writes = h.writes.length
      const raw = JSON.stringify([...h.saved])
      const photos = h.workflow.getSnapshot().photos
      if (outcome === 'resolve') flight.release({ id: 7 })
      else flight.reject(Error('fixture upload rejection'))
      await adding
      assert.equal(h.writes.length, writes)
      assert.equal(JSON.stringify([...h.saved]), raw)
      assert.equal(
        h.workflow.getSnapshot().photos,
        photos,
        'stale result must not publish photo state'
      )
      h.workflow.dispose()
    })

test('QUALITY-01 current upload rejection persists failure and retry survives an identity-preserving reorder', async () => {
  const flight = gate()
  let choices = 0
  let uploads = 0
  const saved = new Map([
    ['session:4', ordinary({ sessionId: 4, recoveryKey: 'unsettled:session:4' })]
  ])
  const h = workflowFixture({
    saved,
    files: {
      choose: async () => {
        choices++
        return [{ path: '/live.png', mimeType: 'image/png', size: 10 }]
      },
      upload: () => {
        uploads++
        return uploads === 1 ? flight.promise : Promise.resolve({ id: 9 })
      }
    }
  })
  const adding = h.workflow.addPhotos()
  await new Promise(setImmediate)
  assert.equal(uploads, 1)
  const before = h.workflow.getSnapshot().photos
  const pending = before[2]
  assert.equal(pending.status, 'uploading')
  assert.equal(
    h.workflow.movePhoto({
      slotId: pending.id,
      targetIndex: 0,
      expectedIds: before.map((p) => p.id)
    }),
    true
  )
  const reordered = h.workflow.getSnapshot().photos
  assert.equal(reordered[0], pending)
  assert.equal(reordered[1], before[0])
  assert.equal(reordered[2], before[1])
  const writes = h.writes.length
  flight.reject(Error('current upload failed'))
  await adding
  assert.ok(h.writes.length > writes, 'a genuine current failure must persist its retryable state')
  assert.equal(h.workflow.getSnapshot().photos[0].status, 'failed')
  assert.equal(saved.get('session:4').photos[0].status, 'failed')
  await h.workflow.retryPhoto(pending.id)
  assert.equal(choices, 1)
  assert.equal(uploads, 2)
  assert.equal(h.workflow.getSnapshot().photos[0].status, 'ready')
  assert.equal(h.workflow.getSnapshot().photos[0].mediaId, 9)
  assert.deepEqual(
    saved.get('session:4').photos.map((p) => p.mediaId),
    [9, 7, 8]
  )
  h.workflow.dispose()
})

for (const boundary of ['picked-edit', 'uploading-publication', 'inflight'])
  test(`QUALITY-01 two-photo batch ${boundary} hide-show cannot start the next upload in a fresh epoch`, async () => {
    const flight = gate()
    let triggered = false
    const paths = []
    const h = workflowFixture({
      files: {
        choose: async () =>
          [1, 2].map((n) => ({ path: `/batch-${n}.png`, mimeType: 'image/png', size: 10 })),
        upload: (path) => {
          paths.push(path)
          return boundary === 'inflight' && paths.length === 1
            ? flight.promise
            : Promise.resolve({ id: 7 })
        }
      }
    })
    const invalidate = () => {
      triggered = true
      h.workflow.setPageVisible({ visible: false })
      h.workflow.setPageVisible({ visible: true })
    }
    h.workflow.subscribe(() => {
      if (triggered || boundary === 'inflight') return
      const photos = h.workflow.getSnapshot().photos
      if (
        photos.length === 2 &&
        photos[0].status === (boundary === 'picked-edit' ? 'pending' : 'uploading')
      )
        invalidate()
    })
    const adding = h.workflow.addPhotos()
    if (boundary === 'inflight') {
      await new Promise(setImmediate)
      assert.deepEqual(paths, ['/batch-1.png'])
      invalidate()
    }
    const writes = h.writes.length
    if (boundary === 'inflight') flight.release({ id: 7 })
    await adding
    assert.equal(
      triggered,
      true,
      'the selected synchronous or await boundary must actually invalidate'
    )
    assert.deepEqual(paths, boundary === 'inflight' ? ['/batch-1.png'] : [])
    if (boundary === 'inflight') assert.equal(h.writes.length, writes)
    assert.equal(h.workflow.getSnapshot().photos[1].status, 'pending')
    h.workflow.dispose()
  })

test('QUALITY-01 a current two-photo gesture uploads both files in selection order', async () => {
  const paths = []
  const h = workflowFixture({
    files: {
      choose: async () =>
        [1, 2].map((n) => ({ path: `/current-${n}.png`, mimeType: 'image/png', size: 10 })),
      upload: async (path) => {
        paths.push(path)
        return { id: paths.length + 6 }
      }
    }
  })
  await h.workflow.addPhotos()
  assert.deepEqual(paths, ['/current-1.png', '/current-2.png'])
  assert.deepEqual(clone(h.workflow.getSnapshot().photos.map((p) => [p.status, p.mediaId])), [
    ['ready', 7],
    ['ready', 8]
  ])
  assert.deepEqual(
    h.saved.get('session:4').photos.map((p) => p.mediaId),
    [7, 8]
  )
  h.workflow.dispose()
})
