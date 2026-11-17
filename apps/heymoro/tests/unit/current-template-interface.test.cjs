const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('../source.cjs')
const { template: oldTemplate } = require('../fixtures/creation.cjs')
const plain = (value) => JSON.parse(JSON.stringify(value))
const current = (value) => { const copy = plain(value); delete copy.templateVersionId; return copy }
const template = () => current(oldTemplate())
const session = () => ({ id: 4, templateId: 1, mode: 'free', title: '自由创作', titleSource: 'template', lastActivityAt: '2026-11-17T03:00:00.000Z' })
const task = () => ({ id: 9, templateId: 1, sessionId: 4, clientRequestId: 'original', input: { description: '保留', userNotes: '', inputMediaIds: [] }, costCredits: 3, errorCode: null, roundNo: 1, sourceTaskId: null, status: 'queued' })

test('current network DTOs have stable template identity and reject legacy business-version fields', () => {
  const api = load('src/creation-contract.js')
  const quote = { templateId: 1, costCredits: 3, quoteToken: 'quote', validUntil: '2099-01-01T00:00:00.000Z' }
  for (const [read, value] of [[api.readTemplate, template()], [api.readSession, session()], [api.readTask, task()], [api.readQuote, quote]]) {
    assert.equal(read({ value }).templateId, 1)
    assert.equal(Object.hasOwn(read({ value }), 'templateVersionId'), false)
    for (const field of ['templateVersionId', 'publishedVersionId', 'versionNo']) assert.throws(() => read({ value: { ...value, [field]: 2 } }), /INVALID_RESPONSE/)
  }
})

test('API only sends templateId and the original session nonce, never the legacy version query or body', async () => {
  const sent = []
  const api = load('src/creation-api.js', {
    '@tarojs/taro': { request: async (options) => { sent.push(plain(options)); return { statusCode: options.method === 'POST' ? 201 : 200, data: { requestId: 'request', data: options.method === 'POST' ? session() : { ...template(), mode: 'effect', inputSchema: { ...template().inputSchema, minImages: 1, maxDescriptionLength: 0 } } } } } },
    './auth': { getStoredSession: () => ({ userId: 1, token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), clearToken() {} }
  }).creationApi
  await api.template({ templateId: 1, templateVersionId: 2 })
  await api.createSession({ templateId: 1, templateVersionId: 2, clientRequestId: ' original ' })
  assert.equal(sent[0].url.endsWith('/templates/1'), true)
  assert.deepEqual(sent[1].data, { templateId: 1, clientRequestId: ' original ' })
})

test('old ordinary record remains exact fingerprint evidence but is readable under current stable binding', () => {
  const api = load('src/features/creation/initial-input-intent.js')
  const entry = { key: 'template:free', kind: 'template', mode: 'free', templateId: null, sessionId: null }
  const record = { protocol: 2, mode: 'free', templateId: 1, templateVersionId: 2, sessionId: 4, description: '原文字', userNotes: '', photos: [{ id: 'photo', path: '/own.jpg', mediaId: 7, status: 'ready' }], carryBackSourceTaskId: null, sessionRequest: null, submission: null, draftPaused: false, recoveryKey: 'unsettled:session:4' }
  const fingerprint = api.fingerprintInitialInputValue({ value: record }).value
  const read = api.readCompleteOrdinaryRecord({ context: { entry, binding: { mode: 'free', templateId: 1, sessionId: 4 } }, record })
  assert.equal(read.ok, true, JSON.stringify(read))
  assert.equal(read.value.record.photos[0].mediaId, 7)
  assert.equal(api.fingerprintInitialInputValue({ value: read.value.record }).value.json, fingerprint.json)
})

test('old frozen session creation settles with a current receipt without losing photos, text or original nonce', () => {
  const { sessionReceiptDesired } = load('src/features/creation/entry-load.js')
  const record = { protocol: 2, mode: 'free', templateId: 1, templateVersionId: 2, sessionId: null, description: '保留文字', userNotes: '', photos: [{ id: 'photo', mediaId: 7, status: 'ready' }], sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'original' }, submission: null, draftPaused: false, recoveryKey: 'unsettled:template:free' }
  const result = sessionReceiptDesired({ frozenRecord: record, receipt: session() })
  assert.ok(result)
  assert.equal(result.sessionId, 4)
  assert.equal(result.description, record.description)
  assert.equal(result.photos[0].mediaId, 7)
  assert.equal(Object.hasOwn(result, 'templateVersionId'), false)
  assert.equal(record.sessionRequest.clientRequestId, 'original')
  assert.equal(record.templateVersionId, 2)
})

test('actual workflow completes a current-protocol session, ordered own-photo input and accepted generation without persisting version pins', async () => {
  const { workflowFixture } = require('../fixtures/creation.cjs')
  const requests = []
  const f = workflowFixture({ template: null, sessionId: null, key: 'template:free', saved: new Map(), files: { choose: async () => [{ path: '/own.jpg', mimeType: 'image/jpeg', size: 10 }], upload: async () => ({ id: 7 }) }, api: {
    freePreset: async () => template(),
    createSession: async (body) => { requests.push(plain(body)); return session() },
    getSession: async () => ({ ...session(), runningTask: null, cover: null, draft: { updatedAt: '2026-11-17T03:00:00.000Z', input: { description: '', userNotes: '', inputMediaIds: [] } } }),
    quote: async () => ({ templateId: 1, costCredits: 3, quoteToken: 'quote', validUntil: '2099-01-01T00:00:00.000Z' }),
    generate: async (body) => { requests.push(plain(body)); return { ...task(), clientRequestId: body.clientRequestId, input: body.input } }
  } })
  await f.workflow.restore()
  f.workflow.setDescription('自己的画面')
  await f.workflow.addPhotos()
  await f.workflow.prepareQuote()
  assert.ok(f.workflow.getSnapshot().quote, JSON.stringify(f.workflow.getSnapshot()))
  await f.workflow.generate()
  assert.equal(f.workflow.getSnapshot().rounds[0].id, 9)
  assert.deepEqual(Object.keys(requests[0]).sort(), ['clientRequestId', 'templateId'])
  assert.deepEqual(requests[1].input.inputMediaIds, [7])
  for (const value of f.saved.values()) assert.equal(JSON.stringify(value).includes('templateVersionId'), false)
  f.workflow.dispose()
})

test('legacy frozen generation confirms its original body before retiring local metadata', async (t) => {
  const { workflowFixture } = require('../fixtures/creation.cjs')
  const { frozen, frozenMap } = require('../fixtures/session-unavailable.cjs')
  const record = frozen('generate')
  const original = plain(record)
  const sent = []
  const f = workflowFixture({ template: null, saved: frozenMap(record), api: {
    freePreset: async () => template(),
    getSession: async () => ({ ...session(), runningTask: null, cover: null, draft: { updatedAt: '2026-11-17T03:00:00.000Z', input: { description: '', userNotes: '', inputMediaIds: [] } } }),
    generate: async (body) => { sent.push(plain(body)); return { ...task(), clientRequestId: body.clientRequestId, input: body.input } }
  } })
  t.after(() => f.workflow.dispose())
  await f.workflow.restore()
  await f.workflow.generate()
  assert.deepEqual(sent, [original.submission.body])
  assert.deepEqual(record, original, 'original frozen evidence is never normalized in place')
  assert.equal(f.workflow.getSnapshot().submission, null)
  assert.equal(f.workflow.getSnapshot().rounds[0].id, 9)
})

test('legacy session receipt already written to its alias can finish without another session', async (t) => {
  const { workflowFixture } = require('../fixtures/creation.cjs')
  const { frozen, frozenMap } = require('../fixtures/session-unavailable.cjs')
  const record = frozen('session')
  const saved = frozenMap(record)
  saved.set('session:4', { ...plain(record), sessionId: 4, sessionRequest: null })
  const creates = []
  const f = workflowFixture({ template: null, sessionId: null, key: 'template:free', saved, api: {
    freePreset: async () => template(),
    createSession: async (body) => { creates.push(plain(body)); return session() },
    quote: async () => { throw Error('explicit later quote required') }
  } })
  t.after(() => f.workflow.dispose())
  await f.workflow.restore()
  await f.workflow.generate()
  assert.deepEqual(creates, [{ templateId: 1, clientRequestId: 'original-session' }])
  assert.equal(f.workflow.getSnapshot().sessionId, 4)
  assert.equal(f.workflow.getSnapshot().sessionRequest, null)
})

test('new recovery journal cannot nominate an arbitrary legacy numeric alias', () => {
  const api = load('src/features/creation/initial-input-intent.js')
  const entry = { key: 'template:free', kind: 'template', mode: 'free', templateId: null, sessionId: null }
  const binding = { mode: 'free', templateId: 1, sessionId: null }
  const key = 'template:free:entry:free:1:999'
  const desired = { protocol: 2, ...binding, description: 'new', userNotes: '', photos: [], carryBackSourceTaskId: null, sessionRequest: null, submission: null, draftPaused: false, recoveryKey: 'unsettled:template:free' }
  const result = api.encodeInitialInputIntent({ context: { entry, binding }, intent: {
    protocol: 1, kind: 'ordinary-initial-input', entry, fields: ['description'], patch: { description: 'new' },
    observed: [{ key, fingerprint: { kind: 'absent' } }],
    prepared: { binding, primaryKey: key, source: { kind: 'new' }, targets: [{ key, expected: { kind: 'absent' }, desired }] }
  } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'KEY_NOT_ALLOWED')
})

test('retained alias with a current ordinary record grants only its exact observed source address', () => {
  const api = load('src/features/creation/initial-input-intent.js')
  const entry = { key: 'template:free', kind: 'template', mode: 'free', templateId: null, sessionId: null }
  const binding = { mode: 'free', templateId: 1, sessionId: null }
  const key = 'template:free:entry:free:1:2'
  const record = { protocol: 2, ...binding, description: 'old', userNotes: '', photos: [], carryBackSourceTaskId: null, sessionRequest: null, submission: null, draftPaused: false, recoveryKey: 'unsettled:template:free' }
  const fingerprint = api.fingerprintInitialInputValue({ value: record }).value
  const intent = {
    protocol: 1, kind: 'ordinary-initial-input', entry, fields: ['description'], patch: { description: 'new' },
    observed: [{ key, fingerprint }], prepared: { binding, primaryKey: key,
      source: { kind: 'local', key, fingerprint }, targets: [{ key, expected: fingerprint, desired: { ...record, description: 'new' } }] }
  }
  assert.equal(api.encodeInitialInputIntent({ context: { entry, binding }, intent }).ok, true)
  const foreign = plain(intent)
  foreign.prepared.primaryKey = 'template:free:entry:free:1:999'
  foreign.prepared.targets[0].key = foreign.prepared.primaryKey
  assert.equal(api.encodeInitialInputIntent({ context: { entry, binding }, intent: foreign }).ok, false)
  assert.equal(record.description, 'old')
})

test('effect example navigation never publishes legacy version metadata', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '../../src/pages/create/index.jsx'), 'utf8')
  assert.doesNotMatch(source, /version=\$\{state\.templateVersionId\}/)
})

for (const mode of ['free', 'effect']) {
  test(`first ${mode} multi-photo batch continues after a delayed session receipt promotes its draft key`, async (t) => {
    const { workflowFixture } = require('../fixtures/creation.cjs')
    let resolveSession
    let creates = 0
    const gate = new Promise((resolve) => { resolveSession = resolve })
    const uploads = []
    const photos = ['/first.jpg', '/second.jpg'].map((path) => ({ path, mimeType: 'image/jpeg', size: 10 }))
    const f = workflowFixture({ mode, sessionId: null, saved: new Map(),
      key: mode === 'free' ? 'template:free' : 'template:1',
      files: { choose: async () => photos, upload: async (path) => { uploads.push(path); return { id: uploads.length + 10 } } },
      api: { createSession: async () => { creates++; return gate } } })
    t.after(() => f.workflow.dispose())
    if (mode === 'free') f.workflow.setDescription('First creation')
    else f.workflow.setUserNotes('Preserve both subjects')
    const selecting = f.workflow.addPhotos()
    await new Promise(setImmediate)
    assert.equal(creates, 1)
    assert.equal(f.workflow.getSnapshot().photos.length, 2)
    assert.deepEqual(uploads, [])
    resolveSession(f.session)
    await selecting
    assert.deepEqual(uploads, ['/first.jpg', '/second.jpg'])
    assert.equal(f.workflow.getSnapshot().photos.every((photo) => photo.status === 'ready'), true)
    assert.deepEqual(plain(f.saved.get('session:4').photos.map((photo) => photo.mediaId)), [11, 12])
    assert.equal(creates, 1)
  })
}
