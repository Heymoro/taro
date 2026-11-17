const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

for (const method of ['creditLedger', 'creditReservations']) {
  test(`actual creationApi exposes read-only ${method}`, () => {
    const { creationApi } = load('src/creation-api.js', {
      '@tarojs/taro': { getStorageSync: () => null },
    })
    assert.equal(typeof creationApi[method], 'function')
  })
}

const stamp = '2026-11-14T00:00:00.000Z'
const ledger = (extra = {}) => ({
  id: 5,
  operation: 'reserve',
  ledgerDelta: 0,
  statusCredits: 0,
  sourceType: 'compensation',
  createdAt: stamp,
  reservationId: 7,
  taskId: 8,
  availableDelta: 0,
  reservedDelta: 0,
  expiredDelta: 0,
  ...extra,
})
const reservation = (extra = {}) => ({
  reservationId: 7,
  taskId: 8,
  sessionId: 9,
  roundNo: 1,
  reservedCredits: 0,
  taskStatus: 'running',
  reviewHint: 'PENDING_REVIEW',
  ...extra,
})
const page = (items = [], extra = {}) => ({ items, nextCursor: null, hasMore: false, ...extra })
const envelope = (data, statusCode = 200) => ({
  statusCode,
  data: { data, requestId: 'credit-read' },
})
const errorResponse = ({ statusCode, code, retryable, requestId = 'credit-error' }) => ({
  statusCode,
  data: { error: { code, retryable, message: 'secret raw server error' }, requestId },
})
const plain = (value) => JSON.parse(JSON.stringify(value))
const owner = () => ({ userId: 1, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' })
function fixture({ route = () => envelope(page()), session = owner() } = {}) {
  let stored = session
  const sent = []
  const calls = { clear: 0, login: 0, storageWrite: 0, download: 0 }
  const { creationApi } = load('src/creation-api.js', {
    '@tarojs/taro': {
      getStorageSync: () => stored,
      removeStorageSync: () => {
        stored = null
        calls.clear++
      },
      setStorageSync: () => {
        calls.storageWrite++
        throw Error('unexpected storage write')
      },
      login: () => {
        calls.login++
        throw Error('unexpected login')
      },
      downloadFile: () => {
        calls.download++
        throw Error('unexpected download')
      },
      request: (options) => {
        sent.push(options)
        return route(options)
      },
    },
  })
  return {
    creationApi,
    sent,
    calls,
    session: () => stored,
    setSession: (value) => {
      stored = value
    },
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const endpoints = [
  { method: 'creditLedger', path: '/credits/ledger', row: ledger },
  { method: 'creditReservations', path: '/credits/reservations', row: reservation },
]
for (const endpoint of endpoints) {
  const { method, path, row } = endpoint
  for (const cursor of [undefined, null, '', 'opaque+/=%2F中文?&']) {
    test(`${method} real graph exact private GET cursor ${String(cursor)}`, async () => {
      const input = row({ privateUrl: 'hidden', eventKey: 'secret', title: 'hidden' })
      const f = fixture({ route: () => envelope(page([input], { ignored: 'secret' })) })
      const got = await f.creationApi[method]({
        cursor,
        page: 2,
        limit: 50,
        userId: 99,
        sourceType: 'topup',
        status: 'unknown',
        date: stamp,
        data: 'write',
      })
      assert.deepEqual(plain(got), page([row()]))
      assert.equal(f.sent.length, 1)
      const sent = f.sent[0]
      assert.equal(new URL(sent.url).pathname, '/api/v1' + path)
      assert.equal(new URL(sent.url).search, cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
      assert.equal(sent.url.endsWith('?'), false)
      assert.equal(sent.method, 'GET')
      assert.equal(sent.data, undefined)
      assert.equal(sent.timeout, 15000)
      assert.deepEqual(plain(sent.header), { Authorization: 'Bearer ' + owner().token })
      assert.deepEqual(f.calls, { clear: 0, login: 0, storageWrite: 0, download: 0 })
    })
  }
  test(`${method} optional argument and empty nonterminal page remain readable`, async () => {
    const f = fixture({
      route: () => envelope(page([], { hasMore: true, nextCursor: 'continue-not-eof' })),
    })
    assert.deepEqual(plain(await f.creationApi[method]()), page([], { hasMore: true, nextCursor: 'continue-not-eof' }))
    assert.equal(f.sent.length, 1)
  })
  test(`${method} preserves original row order and duplicates; no balance reconstruction`, async () => {
    const rows = [row(), row(), row(method === 'creditLedger' ? { id: 1 } : { reservationId: 1 })]
    const f = fixture({ route: () => envelope(page(rows)) })
    assert.deepEqual(plain((await f.creationApi[method]()).items), rows)
    assert.equal(f.sent.length, 1)
  })
  for (const session of [
    null,
    { ...owner(), expiresAt: '2000-01-01T00:00:00.000Z' },
    { ...owner(), token: 'invalid' },
    { ...owner(), userId: 0 },
  ]) {
    test(`${method} missing/invalid/expired actual auth never logs in or reads`, async () => {
      const f = fixture({ session })
      await assert.rejects(f.creationApi[method](), /AUTH_REQUIRED/)
      assert.equal(f.sent.length, 0)
      assert.deepEqual(f.calls, { clear: 0, login: 0, storageWrite: 0, download: 0 })
    })
  }
  for (const field of ['userId', 'token', 'expiresAt']) {
    for (const result of ['200', '401', 'network']) {
      test(`${method} ignores late ${result} after full owner ${field} replacement`, async () => {
        const gate = deferred()
        const f = fixture({ route: () => gate.promise })
        const pending = f.creationApi[method]()
        const rejected = assert.rejects(pending, /AUTH_REQUIRED/)
        const current = {
          ...owner(),
          [field]: field === 'userId' ? 2 : field === 'token' ? 'B'.repeat(42) + 'A' : '2099-02-01T00:00:00.000Z',
        }
        f.setSession(current)
        if (result === 'network') gate.reject(Error('secret native failure'))
        else
          gate.resolve(
            result === '200'
              ? envelope(page([row()]))
              : errorResponse({ statusCode: 401, code: 'UNAUTHENTICATED', retryable: false })
          )
        await rejected
        assert.equal(f.session(), current)
        assert.equal(f.sent.length, 1)
        assert.deepEqual(f.calls, { clear: 0, login: 0, storageWrite: 0, download: 0 })
      })
    }
  }
  test(`${method} logout while waiting rejects stale facts`, async () => {
    const gate = deferred(),
      f = fixture({ route: () => gate.promise })
    const pending = f.creationApi[method]()
    const rejected = assert.rejects(pending, /AUTH_REQUIRED/)
    f.setSession(null)
    gate.resolve(envelope(page([row()])))
    await rejected
    assert.equal(f.calls.clear, 0)
    assert.equal(f.sent.length, 1)
  })
  for (const [statusCode, code, retryable] of [
    [400, 'INPUT_INVALID', false],
    [401, 'UNAUTHENTICATED', false],
    [503, 'DATA_INTEGRITY_CONFLICT', true],
    [503, 'DATA_INTEGRITY_CONFLICT', false],
  ]) {
    test(`${method} retains structured ${statusCode}/${code}/${retryable} without replay`, async () => {
      const f = fixture({ route: () => errorResponse({ statusCode, code, retryable }) })
      await assert.rejects(f.creationApi[method]({ cursor: 'bad-opaque' }), (error) => {
        assert.equal(error.name, 'ApiResponseError')
        assert.equal(error.message, code)
        assert.equal(error.code, code)
        assert.equal(error.status, statusCode)
        assert.equal(error.requestId, 'credit-error')
        assert.equal(error.retryable, retryable)
        assert.equal(error.isOutcomeUnknown, false)
        assert.doesNotMatch(error.message, /secret/)
        return true
      })
      assert.equal(f.sent.length, 1)
      assert.equal(f.calls.clear, statusCode === 401 ? 1 : 0)
      assert.equal(f.session() === null, statusCode === 401)
      assert.equal(f.calls.login, 0)
      assert.equal(f.calls.storageWrite, 0)
    })
  }
  test(`${method} network error is controlled and never automatically retried`, async () => {
    const f = fixture({
      route: () => {
        throw Error('private low-level error')
      },
    })
    await assert.rejects(
      f.creationApi[method](),
      (error) =>
        error.code === 'REQUEST_OUTCOME_UNKNOWN' &&
        error.message === error.code &&
        error.isOutcomeUnknown === true &&
        error.retryable === false &&
        error.status === null &&
        error.requestId === null
    )
    assert.equal(f.sent.length, 1)
    assert.equal(f.calls.login, 0)
  })
  const brokenPages = [
    undefined,
    null,
    {},
    { items: [] },
    page([], { hasMore: 'false' }),
    page([], { hasMore: true, nextCursor: null }),
    page([], { hasMore: true, nextCursor: '' }),
    page([], { hasMore: false, nextCursor: 'not-null' }),
    page([], { nextCursor: 3 }),
    page(null),
    page([row(), {}]),
    page([{}]),
    page([null]),
    page([row(method === 'creditLedger' ? { ledgerDelta: 99 } : { reservedCredits: null })]),
  ]
  for (const [index, data] of brokenPages.entries()) {
    test(`${method} rejects whole malformed page/DTO ${index} with its trace`, async () => {
      const f = fixture({ route: () => envelope(data) })
      await assert.rejects(
        f.creationApi[method](),
        (error) =>
          error.code === 'INVALID_RESPONSE' &&
          error.status === 200 &&
          error.requestId === 'credit-read' &&
          error.retryable === false &&
          error.isOutcomeUnknown === true
      )
      assert.equal(f.sent.length, 1)
    })
  }
  for (const statusCode of [201, 202, 204, 206]) {
    test(`${method} accepts only HTTP 200 not ${statusCode}`, async () => {
      const f = fixture({ route: () => envelope(page([row()]), statusCode) })
      await assert.rejects(
        f.creationApi[method](),
        (error) => error.code === 'INVALID_RESPONSE' && error.status === statusCode && error.isOutcomeUnknown === true
      )
      assert.equal(f.sent.length, 1)
    })
  }
  for (const data of ['{not-json-secret', {}, { requestId: 'missing-data' }]) {
    test(`${method} malformed JSON/envelope is controlled ${JSON.stringify(data)}`, async () => {
      const f = fixture({ route: () => ({ statusCode: 200, data }) })
      await assert.rejects(
        f.creationApi[method](),
        (error) =>
          error.name === 'ApiResponseError' &&
          error.code === 'INVALID_RESPONSE' &&
          error.message === 'INVALID_RESPONSE' &&
          error.status === 200 &&
          error.isOutcomeUnknown === true
      )
      assert.equal(f.sent.length, 1)
    })
  }
  test(`${method} valid JSON string follows actual shared parser`, async () => {
    const f = fixture({
      route: () => ({ statusCode: 200, data: JSON.stringify(envelope(page([row()])).data) }),
    })
    assert.deepEqual(plain(await f.creationApi[method]()), page([row()]))
  })
}
test('ledger and reservation cursors are passed independently and never parsed or cached', async () => {
  const f = fixture({
    route: () => envelope(page([], { hasMore: true, nextCursor: 'server-opaque' })),
  })
  await f.creationApi.creditLedger({ cursor: 'ledger-only+/=' })
  await f.creationApi.creditReservations({ cursor: 'reservation-only+/=' })
  await f.creationApi.creditLedger()
  await f.creationApi.creditReservations()
  assert.deepEqual(
    f.sent.map(({ url }) => new URL(url).pathname + new URL(url).search),
    [
      '/api/v1/credits/ledger?cursor=ledger-only%2B%2F%3D',
      '/api/v1/credits/reservations?cursor=reservation-only%2B%2F%3D',
      '/api/v1/credits/ledger',
      '/api/v1/credits/reservations',
    ]
  )
  assert.equal(
    f.sent.every(({ method, data }) => method === 'GET' && data === undefined),
    true
  )
  assert.deepEqual(f.calls, { clear: 0, login: 0, storageWrite: 0, download: 0 })
})
