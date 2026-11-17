const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('../source.cjs')

const KEY = 'heymoro.user.token'
const token = (id = 1) => Buffer.alloc(32, id).toString('base64url')
const user = (id = 1) => ({ id, displayName: '微信用户', avatarUrl: null, status: 'active' })
const credential = (id = 1, expiresAt = new Date(Date.now() + 60000).toISOString()) => ({ token: token(id), expiresAt, userId: id })
const success = (data, statusCode = 200) => ({ statusCode, data: { data, requestId: 'owned-trace' } })
const loggedIn = (id = 1) => { const { token: value, expiresAt } = credential(id); return success({ token: value, expiresAt, user: user(id) }, 201) }
const failure = (code = 'AUTH_UNAUTHENTICATED', statusCode = 401) => ({ statusCode, data: { error: { code, message: 'Controlled failure', retryable: true }, requestId: 'owned-trace' } })
const plain = (value) => JSON.parse(JSON.stringify(value))
const deferred = () => { let finish; const promise = new Promise((resolve) => { finish = resolve }); return { promise, resolve: finish } }
const turn = () => new Promise(setImmediate)
function fixture({ initial = '', request = async () => loggedIn(), login, storeError = false, creation = false } = {}) {
  const storage = new Map([[KEY, initial], ['draft', 'preserved']])
  const calls = []; const writes = []; const removals = []; let codes = 0
  const host = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => { if (storeError) throw Error('disk full'); writes.push([key, plain(value)]); storage.set(key, value) },
    removeStorageSync: (key) => { removals.push(key); storage.delete(key) },
    login: login || (async () => ({ code: `fresh-code-${++codes}` })),
    request: (options) => { calls.push(options); return request(options) },
  }
  const api = load(creation ? 'src/creation-api.js' : 'src/auth.js', { '@tarojs/taro': host })
  return { api, storage, calls, writes, removals }
}
function invalid(error) {
  assert.equal(error.name, 'ApiResponseError'); assert.equal(error.code, 'INVALID_RESPONSE')
  assert.equal(error.isOutcomeUnknown, true); assert.equal(error.requestId, 'owned-trace'); return true
}
test('formal login atomically stores credential only after 201 and delivers active user', async () => {
  const f = fixture({ initial: 'legacy' })
  assert.equal((await f.api.loginWithWechat()).id, 1)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0], KEY)
  assert.deepEqual(Object.keys(f.writes[0][1]).sort(), ['expiresAt', 'token', 'userId'])
  assert.equal(f.api.getStoredToken(), token()); assert.equal(f.api.getStoredSession().userId, 1)
  assert.equal(f.storage.get('draft'), 'preserved')
  assert.deepEqual(plain(f.calls[0].data), { code: 'fresh-code-1' }); assert.equal(f.calls[0].timeout, 15000)
})
for (const initial of ['legacy', credential(1, '2000-01-01T00:00:00.000Z'), { ...credential(), token: 'A'.repeat(42) + 'B' }, { ...credential(), userId: '1' }]) {
  test(`invalid or expired credential ignored without deletion: ${JSON.stringify(initial)}`, async () => {
    const f = fixture({ initial })
    assert.equal(f.api.getStoredToken(), ''); assert.equal(f.api.getStoredSession(), null)
    assert.equal(await f.api.getCurrentUser(), null); assert.equal(f.calls.length, 0)
    assert.equal(f.removals.length, 0); assert.equal(f.storage.get(KEY), initial)
  })
}
test('getStoredSession is a frozen copy', () => {
  const f = fixture({ initial: credential() }); const snapshot = f.api.getStoredSession()
  assert.ok(Object.isFrozen(snapshot)); assert.notEqual(snapshot, f.storage.get(KEY))
})
for (const change of [
  (data) => ({ ...data, token: 'bad' }), (data) => ({ ...data, token: 'A'.repeat(42) + 'B' }),
  (data) => ({ ...data, expiresAt: '2000-01-01T00:00:00.000Z' }), (data) => ({ ...data, expiresAt: 'not-a-date' }),
  (data) => ({ ...data, user: user('1') }), (data) => ({ ...data, user: { ...user(), status: 'disabled' } }),
  (data) => ({ ...data, user: { ...user(), avatarUrl: 8 } }), (data) => ({ ...data, user: { id: 1 } }),
]) {
  test('invalid login DTO preserves prior storage and reports unconfirmed trace', async () => {
    const initial = credential(2); const f = fixture({ initial, request: async () => success(change(loggedIn().data.data), 201) })
    await assert.rejects(f.api.loginWithWechat(), invalid); assert.equal(f.storage.get(KEY), initial); assert.equal(f.writes.length, 0)
  })
}
for (const status of [200, 202, 204]) {
  test(`login rejects status ${status}`, async () => {
    const f = fixture({ request: async () => success(loggedIn().data.data, status) })
    await assert.rejects(f.api.loginWithWechat(), invalid); assert.equal(f.writes.length, 0)
  })
}
test('storage failure withholds user without touching draft or old token', async () => {
  const f = fixture({ initial: 'legacy', storeError: true })
  await assert.rejects(f.api.loginWithWechat(), /disk full/)
  assert.equal(f.storage.get(KEY), 'legacy'); assert.equal(f.storage.get('draft'), 'preserved')
})
test('single-flight incomplete login retries only on next invocation with fresh wx code', async () => {
  const gate = deferred(); let count = 0
  const f = fixture({ request: () => ++count === 1 ? gate.promise : Promise.resolve(loggedIn()) })
  const first = f.api.loginWithWechat(); const duplicate = f.api.loginWithWechat()
  await turn(); assert.equal(f.calls.length, 1); gate.resolve(failure('AUTH_LOGIN_INCOMPLETE', 503))
  for (const promise of [first, duplicate]) await assert.rejects(promise, (error) => error.code === 'AUTH_LOGIN_INCOMPLETE' && error.retryable)
  assert.equal(f.calls.length, 1); await f.api.loginWithWechat()
  assert.deepEqual(f.calls.map(({ data }) => plain(data)), [{ code: 'fresh-code-1' }, { code: 'fresh-code-2' }])
  assert.equal(f.storage.get('draft'), 'preserved')
})
for (const method of ['loginWithWechat', 'getCurrentUser', 'updateCurrentUser', 'logout']) {
  test(`${method} sanitizes transport failure without replay`, async () => {
    const f = fixture({ initial: credential(), request: async () => { throw Error('private-secret') } })
    await assert.rejects(f.api[method]({ displayName: 'name' }), (error) => {
      assert.equal(error.code, 'REQUEST_OUTCOME_UNKNOWN'); assert.equal(error.isOutcomeUnknown, true)
      assert.doesNotMatch(JSON.stringify(error), /private-secret/); return true
    }); assert.equal(f.calls.length, 1)
  })
}
for (const method of ['getCurrentUser', 'updateCurrentUser']) {
  test(`${method} validates active UserDTO binding and exact 200`, async () => {
    for (const response of [success(user(2)), success({ ...user(), status: 'disabled' }), success(user(), 201), success({})]) {
      const f = fixture({ initial: credential(), request: async () => response })
      await assert.rejects(f.api[method]({ displayName: 'new' }), invalid)
    }
  })
  for (const status of [200, 401]) {
    test(`${method} rejects late ${status} after account replacement`, async () => {
      const gate = deferred(); const f = fixture({ initial: credential(), request: () => gate.promise })
      const pending = f.api[method]({ displayName: 'new' }); const next = credential(2); f.storage.set(KEY, next)
      gate.resolve(status === 200 ? success(user()) : failure()); await assert.rejects(pending, /AUTH_REQUIRED/)
      assert.equal(f.storage.get(KEY), next)
    })
  }
  test(`${method} clears current 401 while preserving structured error`, async () => {
    const f = fixture({ initial: credential(), request: async () => failure() })
    await assert.rejects(f.api[method]({ displayName: 'new' }), (error) => error.code === 'AUTH_UNAUTHENTICATED' && error.requestId === 'owned-trace')
    assert.equal(f.api.getStoredToken(), '')
  })
}
test('PATCH sends only displayName', async () => {
  const f = fixture({ initial: credential(), request: async () => success(user()) })
  await f.api.updateCurrentUser({ displayName: 'new', avatarUrl: 'ignored' })
  assert.deepEqual(plain(f.calls[0].data), { displayName: 'new' }); assert.equal(f.writes.length, 0)
})
for (const status of [200, 500, 204]) {
  test(`expired credential logout requires 204, receives ${status}`, async () => {
    const initial = credential(1, '2000-01-01T00:00:00.000Z')
    const f = fixture({ initial, request: async () => status === 500 ? failure('SERVER_ERROR', status) : success({}, status) })
    if (status === 204) { await f.api.logout(); assert.equal(f.storage.has(KEY), false) } else { await assert.rejects(f.api.logout()); assert.equal(f.storage.get(KEY), initial) }
    assert.equal(f.calls[0].header.Authorization, `Bearer ${token()}`); assert.equal(f.calls[0].data, undefined)
    assert.equal(f.storage.get('draft'), 'preserved')
  })
}
test('late logout success retains replacement account', async () => {
  const gate = deferred(); const f = fixture({ initial: credential(), request: () => gate.promise })
  const pending = f.api.logout(); const next = credential(2); f.storage.set(KEY, next)
  gate.resolve({ statusCode: 204 }); await pending; assert.equal(f.storage.get(KEY), next)
})
for (const cancel of ['logout', 'clearToken']) {
  test(`${cancel} cancels credential-less login; stale finally does not erase new flight`, async () => {
    const old = deferred(); const next = deferred(); let requests = 0
    const f = fixture({ request: () => ++requests === 1 ? old.promise : next.promise })
    const stale = f.api.loginWithWechat(); await turn(); await f.api[cancel]()
    const fresh = f.api.loginWithWechat(); await turn()
    old.resolve(loggedIn()); await assert.rejects(stale, /AUTH_REQUIRED/)
    const duplicate = f.api.loginWithWechat(); await turn(); assert.equal(requests, 2)
    next.resolve(loggedIn(2)); assert.equal((await fresh).id, 2); assert.equal((await duplicate).id, 2)
    assert.equal(f.storage.get(KEY).userId, 2)
  })
}
test('login pending wx.login does not overwrite replacement account', async () => {
  const gate = deferred(); const f = fixture({ login: () => gate.promise })
  const pending = f.api.loginWithWechat(); f.storage.set(KEY, credential(2)); gate.resolve({ code: 'old-code' })
  await assert.rejects(pending, /AUTH_REQUIRED/); assert.equal(f.calls.length, 0)
})
test('creation deduplicates in-flight GET only, later reads perform GET again', async () => {
  const gate = deferred(); let count = 0
  const f = fixture({ creation: true, initial: credential(), request: () => ++count === 1 ? gate.promise : Promise.resolve(success(user())) })
  const first = f.api.ensureCreationUser(); const duplicate = f.api.ensureCreationUser(); assert.equal(f.calls.length, 1)
  gate.resolve(success(user())); await first; await duplicate; await f.api.ensureCreationUser(); assert.equal(count, 2)
})
test('creation invalidation rejects old callers without erasing the new flight', async () => {
  const old = deferred(); const next = deferred(); let count = 0
  const f = fixture({ creation: true, initial: credential(), request: () => ++count === 1 ? old.promise : next.promise })
  const prior = f.api.ensureCreationUser(); f.api.invalidateCreationUser()
  const current = f.api.ensureCreationUser(); assert.equal(count, 2)
  old.resolve(success(user())); await assert.rejects(prior, /AUTH_REQUIRED/)
  const duplicate = f.api.ensureCreationUser(); assert.equal(count, 2)
  next.resolve(success(user())); await current; await duplicate
})
for (const status of [200, 401]) {
  test(`creation late ${status} neither supplies old user nor logs over new account`, async () => {
    const gate = deferred(); let count = 0
    const f = fixture({ creation: true, initial: credential(), request: () => ++count === 1 ? gate.promise : Promise.resolve(success(user(2))) })
    const old = f.api.ensureCreationUser(); f.storage.set(KEY, credential(2)); assert.equal((await f.api.ensureCreationUser()).id, 2)
    gate.resolve(status === 200 ? success(user()) : failure()); await assert.rejects(old, /AUTH_REQUIRED/)
    assert.equal(f.calls.filter(({ url }) => url.endsWith('/auth/wechat')).length, 0); assert.equal(f.storage.get(KEY).userId, 2)
  })
}
for (const initial of ['', credential(1, '2000-01-01T00:00:00.000Z')]) {
  test('creation logs in only for initially empty or expired credentials', async () => {
    const f = fixture({ creation: true, initial }); assert.equal((await f.api.ensureCreationUser()).id, 1)
    assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /auth\/wechat$/)
  })
}

for (const data of [{ requestId: 'owned-trace' }, JSON.stringify({ requestId: 'owned-trace' })]) {
  test('malformed success envelope keeps an available controlled trace', async () => {
    const f = fixture({ request: async () => ({ statusCode: 201, data }) })
    await assert.rejects(f.api.loginWithWechat(), invalid)
    assert.equal(f.writes.length, 0)
  })
}

for (const requestId of [7, {}, [], '']) {
  test(`invalid identity response discards uncontrolled trace type ${JSON.stringify(requestId)}`, async () => {
    const f = fixture({ request: async () => ({ statusCode: 201, data: { data: {}, requestId } }) })
    await assert.rejects(f.api.loginWithWechat(), (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(error.requestId, null); return true
    })
  })
}
