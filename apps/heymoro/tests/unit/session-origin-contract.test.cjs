const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

const { readSession } = load('src/creation-contract.js')
const detail = {
  id: 4,
  templateId: 1,
  mode: 'free',
  title: 'name',
  titleSource: 'template',
  lastActivityAt: '2026-11-13T00:00:00Z',
  cover: null,
  runningTask: null,
  draft: {
    input: { description: ' raw ', userNotes: '', inputMediaIds: [] },
    updatedAt: '2026-11-13T00:00:00Z',
  },
}

for (const creationClientRequestId of ['  创建🦊原值  ', 'x'.repeat(128)]) {
  test(`should preserve exact detail creation identity ${JSON.stringify(creationClientRequestId)}`, () => {
    const result = readSession({ value: { ...detail, creationClientRequestId }, options: { detail: true } })

    assert.equal(result.creationClientRequestId, creationClientRequestId)
    assert.equal(Object.hasOwn(result, 'clientRequestId'), false)
  })
}

test('should omit absent legacy proof and ignore inherited proof without deriving another identity', () => {
  for (const value of [detail, Object.assign(Object.create({ creationClientRequestId: 'inherited' }), detail)]) {
    const result = readSession({ value: { ...value, clientRequestId: 'not-proof' }, options: { detail: true } })

    assert.equal(Object.hasOwn(result, 'creationClientRequestId'), false)
  }
  const inherited = Object.assign(Object.create({ creationClientRequestId: 'inherited' }), detail)
  assert.equal(
    Object.hasOwn(readSession({ value: inherited, options: { detail: true } }), 'creationClientRequestId'),
    false
  )
})

for (const creationClientRequestId of [undefined, null, '', ' \n\t ', 1, {}, 'x'.repeat(129)]) {
  test(`should reject present malformed detail proof ${JSON.stringify(creationClientRequestId)}`, () => {
    assert.throws(
      () => readSession({ value: { ...detail, creationClientRequestId }, options: { detail: true } }),
      /INVALID_RESPONSE/
    )
  })
}

test('should not recognize creation proof on summary or POST projections', () => {
  for (const options of [{ summary: true }, undefined]) {
    for (const creationClientRequestId of ['proof', null]) {
      const result = readSession({ value: { ...detail, creationClientRequestId }, options })

      assert.equal(Object.hasOwn(result, 'creationClientRequestId'), false)
    }
  }
})

function apiFixture({ data = detail, statusCode = 200, onRequest } = {}) {
  const sent = []
  let session = { userId: 1, token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }
  let clears = 0
  const api = load('src/creation-api.js', {
    '@tarojs/taro': {
      request: async (args) => {
        sent.push(args)
        onRequest?.({
          changeOwner: () => {
            session = { ...session, userId: 2, token: 'new-token' }
          },
        })
        return { statusCode, data: { data, requestId: 'r' } }
      },
    },
    './auth': {
      getStoredToken: () => session.token,
      getStoredSession: () => session,
      clearToken: () => {
        clears++
      },
    },
  }).creationApi
  return { api, sent, clears: () => clears }
}

test('should pass owned GET detail proof through the actual API decoder without writes', async () => {
  const f = apiFixture({ data: { ...detail, creationClientRequestId: '  创建🦊原值  ' } })
  const result = await f.api.getSession({ sessionId: 4 })

  assert.equal(result.creationClientRequestId, '  创建🦊原值  ')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].method, 'GET')
  assert.match(f.sent[0].url, /\/creation-sessions\/4$/)
  assert.equal(f.sent[0].header.Authorization, 'Bearer token')
  assert.equal(f.sent[0].data, undefined)
})

test('should keep legacy API detail proof absent', async () => {
  const result = await apiFixture().api.getSession({ sessionId: 4 })

  assert.equal(Object.hasOwn(result, 'creationClientRequestId'), false)
})

for (const data of [
  { ...detail, creationClientRequestId: null },
  { ...detail, id: 5, creationClientRequestId: 'proof' },
]) {
  test(`should reject malformed or wrong-session API proof ${JSON.stringify(data)}`, async () => {
    await assert.rejects(() => apiFixture({ data }).api.getSession({ sessionId: 4 }), /INVALID_RESPONSE/)
  })
}

test('should preserve the owner epoch guard before exposing proof', async () => {
  const f = apiFixture({
    data: { ...detail, creationClientRequestId: 'proof' },
    onRequest: ({ changeOwner }) => changeOwner(),
  })

  await assert.rejects(() => f.api.getSession({ sessionId: 4 }), /AUTH_REQUIRED/)
  assert.equal(f.clears(), 0)
})

test('should not let stale 401 clear a new owner while carrying creation proof', async () => {
  const f = apiFixture({ statusCode: 401, onRequest: ({ changeOwner }) => changeOwner() })

  await assert.rejects(() => f.api.getSession({ sessionId: 4 }), /AUTH_REQUIRED/)
  assert.equal(f.clears(), 0)
})

test('should strip unknown creation proof from actual list and POST responses', async () => {
  const list = apiFixture({
    data: { items: [{ ...detail, creationClientRequestId: null }], nextCursor: null, hasMore: false },
  })
  const page = await list.api.sessions()
  const post = apiFixture({ data: { ...detail, creationClientRequestId: null }, statusCode: 201 })
  const created = await post.api.createSession({ templateId: 1, clientRequestId: 'request' })

  assert.equal(Object.hasOwn(page.items[0], 'creationClientRequestId'), false)
  assert.equal(Object.hasOwn(created, 'creationClientRequestId'), false)
  assert.equal(Object.keys(created).length, 6)
})
