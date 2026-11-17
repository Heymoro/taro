const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

const input = { description: ' raw ', userNotes: '', inputMediaIds: [] }
const task = {
  id: 7,
  clientRequestId: 'request',
  costCredits: 3,
  errorCode: null,
  input,
  roundNo: 1,
  sessionId: 4,
  sourceTaskId: null,
  status: 'queued',
  templateId: 1
}
function fixture(data = task, statusCode = 201) {
  const sent = []
  const api = load('src/creation-api.js', {
    '@tarojs/taro': {
      request: async (o) => {
        sent.push(o)
        return { statusCode, data: { data, requestId: 'r' } }
      }
    },
    './auth': {
      getStoredToken: () => 'token',
      getStoredSession: () => ({ userId: 1, token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }),
      clearToken() {}
    }
  }).creationApi
  return { api, sent }
}
test('formal generate sends precisely four fields and projects ten-field Task', async () => {
  const { api, sent } = fixture({ ...task, prompt: 'hidden', artifactIds: [9] })
  const got = await api.generate({ sessionId: 4, input, clientRequestId: 'request', quoteToken: 'q' })
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].data)), {
    sessionId: 4,
    input,
    clientRequestId: 'request',
    quoteToken: 'q'
  })
  assert.equal(Object.keys(got).length, 10)
  assert.equal(got.prompt, undefined)
  assert.equal(got.artifactIds, undefined)
})
test('draft, quotes, regeneration and favorites use exact endpoint bodies', async () => {
  const { api, sent } = fixture({ ...task, sourceTaskId: 6 })
  await assert.rejects(api.putDraft({ sessionId: 4, input }))
  await assert.rejects(api.quote({ sessionId: 4, input }))
  await api.regenerate({ sourceArtifactId: 8, sessionId: 4, clientRequestId: 'request', quoteToken: 'q' })
  await assert.rejects(api.favorite({ artifactId: 8, isFavorite: true }))
  await assert.rejects(api.favorite({ artifactId: 8, isFavorite: false }))
  assert.deepEqual(
    sent.map((o) => [o.url.split('/api/v1')[1], o.method, JSON.parse(JSON.stringify(o.data ?? null))]),
    [
      ['/creation-sessions/4/draft', 'PUT', input],
      ['/generation-quotes', 'POST', { sessionId: 4, input }],
      ['/artifacts/8/regenerations', 'POST', { clientRequestId: 'request', quoteToken: 'q' }],
      ['/artifacts/8/favorite', 'PUT', null],
      ['/artifacts/8/favorite', 'DELETE', null]
    ]
  )
})
test('cursor query is encoded without page/limit; public catalog omits authorization', async () => {
  const { api, sent } = fixture({ items: [], nextCursor: 'continue', hasMore: true })
  const result = await api.templates({ cursor: 'a+/=', categoryId: 3, keyword: 'cat' })
  assert.equal(result.hasMore, true)
  assert.match(sent[0].url, /cursor=a%2B%2F%3D/)
  assert.doesNotMatch(sent[0].url, /page=|limit=/)
  assert.equal(sent[0].header.Authorization, undefined)
})
for (const broken of [
  { ...task, costCredits: -1 },
  { ...task, input: { prompt: 'old' } },
  { ...task, templateId: null },
  { ...task, roundNo: 0 },
  { ...task, clientRequestId: 'other' }
]) {
  test('invalid acceptance retains unknown outcome ' + JSON.stringify(broken), async () => {
    const { api } = fixture(broken)
    await assert.rejects(
      api.generate({ sessionId: 4, input, clientRequestId: 'request', quoteToken: 'q' }),
      (e) => e.isOutcomeUnknown === true
    )
  })
}

test('accepted generation must be HTTP 200/201, not an arbitrary successful HTTP status', async () => {
  const { api } = fixture(task, 202)
  await assert.rejects(
    api.generate({ sessionId: 4, input, clientRequestId: 'request', quoteToken: 'q' }),
    (error) => error.isOutcomeUnknown === true
  )
})
test('regeneration acceptance must identify an original source Task', async () => {
  const { api } = fixture(task)
  await assert.rejects(
    api.regenerate({ sourceArtifactId: 8, sessionId: 4, clientRequestId: 'request', quoteToken: 'q' }),
    (error) => error.isOutcomeUnknown === true
  )
})
test('actual owner account shape is available/reserved/sources plus configured', async () => {
  const { api } = fixture({
    available: 9,
    reserved: 3,
    configured: true,
    sources: [{ available: 9, sourceType: 'trial' }],
    privateField: 'hidden'
  })
  const account = await api.account()
  assert.deepEqual(JSON.parse(JSON.stringify(account)), {
    available: 9,
    reserved: 3,
    configured: true,
    sources: [{ available: 9, sourceType: 'trial' }]
  })
})
test('actual taxonomy separates categories from labels and has no tag alias fallback', async () => {
  const { api } = fixture({ categories: [{ id: 2, name: '合照' }], labels: [{ id: 7, name: '宠物' }] })
  const taxonomy = await api.taxonomy()
  assert.equal(taxonomy.categories[0].id, 2)
  assert.equal(taxonomy.labels[0].id, 7)
  assert.equal(taxonomy.tags, undefined)
})
test('session detail is summary plus draft, and rename remains a separate partial response', async () => {
  const summary = {
    id: 4,
    templateId: 1,
    mode: 'free',
    title: 'name',
    titleSource: 'template',
    lastActivityAt: '2026-11-13T00:00:00Z',
    cover: null,
    runningTask: null,
    draft: { input, updatedAt: '2026-11-13T00:00:00Z' }
  }
  const { api } = fixture(summary)
  const detail = await api.getSession({ sessionId: 4 })
  assert.equal(detail.title, 'name')
  assert.equal(detail.session, undefined)
  assert.equal(detail.generations, undefined)
  assert.equal(detail.draft.input.description, ' raw ')
  const rename = fixture({ sessionId: 4, title: 'new', titleSource: 'user', unrelated: 'hidden' })
  assert.deepEqual(JSON.parse(JSON.stringify(await rename.api.rename({ sessionId: 4, title: 'new' }))), {
    sessionId: 4,
    title: 'new',
    titleSource: 'user'
  })
})

// API-level integration: ONE real module graph, actual auth credential parsing and
// decoder, with only native storage/request in memory. No Runtime/server is claimed.
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const stamp = '2026-11-14T00:00:00.000Z'
const fullArtifact = (extra = {}) => ({ id: 66, taskId: 9, sessionId: 4, mediaId: 90,
  outputIndex: 1, width: 512, height: 512, mimeType: 'image/png', createdAt: stamp,
  savedAt: null, isFavorite: false, ...extra })
const envelope = (data) => ({ statusCode: 200, data: { data, requestId: 'actual-api' } })
function actualApi({ route }) {
  let stored = { userId: 1, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }, clears = 0
  const sent = []
  const exports = load('src/creation-api.js', { '@tarojs/taro': {
    getStorageSync: () => stored,
    removeStorageSync: () => { stored = null; clears++ },
    request: (options) => { sent.push(options); return route(options) }
  } })
  return { ...exports, sent, session: () => stored, clears: () => clears, setSession: (value) => { stored = value } }
}
for (const mutation of [true, false])
  test(`actual API ${mutation ? 'add' : 'remove'} fence covers entity, all/saved list, empty result and exact wire`, async () => {
    const gate = deferred(); let favorite = !mutation
    const f = actualApi({ route: async ({ url, method }) => {
      if (url.endsWith('/favorite')) { await gate.promise; favorite = method === 'PUT'; return envelope({ isFavorite: favorite, savedAt: favorite ? stamp : null }) }
      if (url.includes('/artifacts?')) return envelope({ items: favorite ? [fullArtifact({ isFavorite: favorite })] : [], nextCursor: null, hasMore: false })
      return envelope(fullArtifact({ isFavorite: favorite }))
    } })
    const write = f.creationApi.favorite({ artifactId: 66, isFavorite: mutation })
    const warnings = []
    const entity = f.creationApi.artifact({ artifactId: 66, isInterested: () => true, onWarning: (v) => warnings.push(v) })
    const all = f.creationApi.artifacts({ saved: false, isInterested: () => true, onWarning: (v) => warnings.push(v) })
    const saved = f.creationApi.artifacts({ saved: true, cursor: 'a+/=', isInterested: () => true, onWarning: (v) => warnings.push(v) })
    await microtasks(); assert.equal(f.sent.length, 1)
    gate.resolve(); await write
    assert.equal((await entity).isFavorite, mutation)
    assert.equal((await all).items.length, mutation ? 1 : 0)
    assert.equal((await saved).items.length, mutation ? 1 : 0)
    assert.deepEqual(warnings, [])
    assert.equal(f.sent.filter((o) => o.method !== 'GET').length, 1)
    for (const sent of f.sent) {
      assert.equal(sent.header.Authorization, 'Bearer ' + 'A'.repeat(43))
      assert.equal(sent.data, undefined)
      assert.doesNotMatch(sent.url, /isInterested|onWarning|token|expiresAt|userId/)
    }
    assert.ok(f.sent.some((o) => /cursor=a%2B%2F%3D&saved=true$/.test(o.url)))
  })
for (const field of ['expiresAt', 'userId', 'token'])
  for (const responseKind of ['401', 'success', 'transport'])
    test(`actual private request ignores old ${responseKind} after full ${field} replacement`, async () => {
      const gate = deferred(), f = actualApi({ route: () => gate.promise })
      const result = f.creationApi.account()
      const rejected = assert.rejects(result, /AUTH_REQUIRED/)
      const replacement = { ...f.session(), [field]: field === 'userId' ? 2 : field === 'token' ? ('B'.repeat(42) + 'A') : '2099-02-01T00:00:00.000Z' }
      f.setSession(replacement)
      if (responseKind === 'transport') gate.reject(Error('secret'))
      else gate.resolve(responseKind === 'success' ? envelope({ available: 1, reserved: 0, configured: true, sources: [] }) : { statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'server private', retryable: false }, requestId: 'old' } })
      await rejected; assert.equal(f.session(), replacement); assert.equal(f.clears(), 0)
    })
for (const operation of ['account', 'artifact', 'favorite'])
  test(`current owned 401 ${operation} clears own credential and retains original structured trace`, async () => {
    const f = actualApi({ route: () => ({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', message: 'not rendered', retryable: false }, requestId: 'owned-401' } }) })
    const args = { artifactId: 66, isFavorite: true }
    await assert.rejects(f.creationApi[operation](args), (e) => e.code === 'AUTH_REQUIRED' && e.requestId === 'owned-401' && e.status === 401)
    assert.equal(f.clears(), 1); assert.equal(f.session(), null); assert.equal(f.sent.length, 1)
  })
test('public request never reads identity even with throwing storage accessor', async () => {
  const exports = load('src/creation-api.js', { '@tarojs/taro': {
    getStorageSync() { throw Error('public read touched credentials') },
    request: () => envelope({ items: [], nextCursor: null, hasMore: false })
  } })
  assert.equal((await exports.creationApi.templates()).items.length, 0)
})
test('same user rotated token waits old transport then reads using new credential and warns unknown', async () => {
  const pending = deferred()
  const f = actualApi({ route: ({ url }) => url.endsWith('/favorite') ? pending.promise : envelope(fullArtifact()) })
  const write = f.creationApi.favorite({ artifactId: 66, isFavorite: true })
  const rejected = assert.rejects(write, /AUTH_REQUIRED/)
  f.setSession({ ...f.session(), token: ('B'.repeat(42) + 'A') })
  let warning
  const read = f.creationApi.artifact({ artifactId: 66, onWarning: (v) => { warning = v } })
  await microtasks(); assert.equal(f.sent.length, 1)
  pending.resolve(envelope({ isFavorite: true, savedAt: stamp })); await rejected
  assert.equal((await read).isFavorite, false); assert.ok(warning)
  assert.equal(f.sent[1].header.Authorization, 'Bearer ' + ('B'.repeat(42) + 'A'))
})
test('unrelated artifact/owner and quote/generate bypass a pending favorite fence', async () => {
  const pending = deferred()
  const f = actualApi({ route: ({ url }) => {
    if (url.endsWith('/favorite')) return pending.promise
    if (url.endsWith('/generation-quotes')) return envelope({ costCredits: 3, templateId: 1, quoteToken: 'q', validUntil: stamp })
    if (url.endsWith('/generations')) return { ...envelope(task), statusCode: 201 }
    return envelope(fullArtifact({ id: url.endsWith('/67') ? 67 : 66 }))
  } })
  const write = f.creationApi.favorite({ artifactId: 66, isFavorite: true })
  assert.equal((await f.creationApi.artifact({ artifactId: 67 })).id, 67)
  await f.creationApi.quote({ sessionId: 4, input })
  await f.creationApi.generate({ sessionId: 4, input, clientRequestId: 'request', quoteToken: 'q' })
  f.setSession({ ...f.session(), userId: 2 })
  assert.equal((await f.creationApi.artifact({ artifactId: 66 })).id, 66)
  const rejected = assert.rejects(write, /AUTH_REQUIRED/)
  pending.resolve(envelope({ isFavorite: true, savedAt: stamp })); await rejected
  assert.equal(f.sent.length, 5)
})
for (const known of [false, true])
  test(`real API ${known ? 'known business rejection' : 'malformed write response'} has zero replay and ${known ? 'no' : 'persistent'} warning`, async () => {
    const f = actualApi({ route: ({ url }) => !url.endsWith('/favorite') ? envelope(fullArtifact()) : known
      ? { statusCode: 409, data: { error: { code: 'RESOURCE_BUSY', retryable: true, message: 'server secret' }, requestId: 'reject' } }
      : envelope({ broken: true }) })
    await assert.rejects(f.creationApi.favorite({ artifactId: 66, isFavorite: true }), (e) => e.isOutcomeUnknown === !known)
    for (let attempt = 0; attempt < 2; attempt++) {
      let warning
      assert.equal((await f.creationApi.artifact({ artifactId: 66, onWarning: (v) => { warning = v } })).isFavorite, false)
      assert.equal(Boolean(warning), !known)
    }
    assert.equal(f.sent.filter((o) => o.method === 'PUT').length, 1)
  })

test('owned favorite 401 followed by same-user login has no invented uncertainty', async () => {
  let rejectWrite = true
  const f = actualApi({ route: () => rejectWrite
    ? { statusCode: 401, data: { error: { code: 'AUTH_REQUIRED', retryable: false, message: 'controlled' }, requestId: 'own-refusal' } }
    : envelope(fullArtifact()) })
  const old = f.session()
  await assert.rejects(f.creationApi.favorite({ artifactId: 66, isFavorite: true }), (error) => error.requestId === 'own-refusal')
  rejectWrite = false
  f.setSession({ ...old, token: 'C'.repeat(42) + 'A' })
  let warning
  assert.equal((await f.creationApi.artifact({ artifactId: 66, onWarning: (value) => { warning = value } })).isFavorite, false)
  assert.equal(warning, undefined)
  assert.equal(f.sent.filter((item) => item.method === 'PUT').length, 1)
})
