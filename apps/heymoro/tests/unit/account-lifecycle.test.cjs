const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')

const TOKEN_KEY = 'heymoro.user.token'
const NOW = Date.parse('2026-01-01T00:00:00.000Z')
const ERROR = '暂时连接不上，请检查网络后重试'
const user = (id = 1) => ({ id, displayName: '微信用户', avatarUrl: null, status: 'active' })
const credential = (id = 1, expiry = NOW + 60000, tokenId = id) => ({
  userId: id,
  token: Buffer.alloc(32, tokenId).toString('base64url'),
  expiresAt: new Date(expiry).toISOString()
})
const success = (data, statusCode = 200) => ({
  statusCode,
  data: { data, requestId: 'account-test-trace' }
})
const loggedIn = (session = credential(), value = user(session.userId)) =>
  success({ token: session.token, expiresAt: session.expiresAt, user: value }, 201)
const unauthorized = () => ({
  statusCode: 401,
  data: {
    error: { code: 'AUTH_UNAUTHENTICATED', message: 'private-server-message', retryable: false },
    requestId: 'account-test-trace'
  }
})
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// One load call shares the real hook/auth/creation-api module graph and auth generation.
async function withAccount(run, { initial = credential(), boundary = null, strict = false } = {}) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT,
    now: Date.now
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  let now = NOW
  Date.now = () => now
  const storage = new Map([
    [TOKEN_KEY, initial],
    ['draft', 'preserved']
  ])
  const requests = []
  const writes = []
  const shows = new Set()
  let logins = 0
  let readCallback = null
  let current
  let unmounted = false
  const host = {
    getStorageSync(key) {
      if (key === TOKEN_KEY && readCallback) readCallback()
      return storage.get(key)
    },
    setStorageSync(key, value) {
      writes.push({ key, value })
      storage.set(key, value)
    },
    removeStorageSync: (key) => storage.delete(key),
    login: async () => ({ code: `test-code-${++logins}` }),
    request(options) {
      const job = deferred()
      requests.push({ ...job, ...options })
      return job.promise
    },
    // Match Taro's layout-effect registration, not a callback on every layout.
    useDidShow(callback) {
      const latest = React.useRef(callback)
      latest.current = callback
      React.useLayoutEffect(() => {
        const call = () => latest.current()
        shows.add(call)
        return () => shows.delete(call)
      }, [])
    }
  }
  const mocks = { '@tarojs/taro': host }
  if (boundary) {
    mocks['./creation-api'] = { ensureCreationUser: boundary.ensure }
    mocks['./auth'] = {
      getStoredSession() {
        const value = host.getStorageSync(TOKEN_KEY)
        return value && Date.parse(value.expiresAt) > now ? value : null
      },
      getCurrentUser: boundary.read
    }
  }
  const { useAccount, creationAccountKey } = load('src/use-account.js', mocks)
  function Probe() {
    current = useAccount()
    return null
  }
  const root = createRoot(document.getElementById('root'))
  const act = React.act
  const harness = {
    act,
    requests,
    writes,
    storage,
    key: creationAccountKey,
    get current() {
      return current
    },
    get logins() {
      return logins
    },
    setStored: (value) => storage.set(TOKEN_KEY, value),
    setNow: (value) => {
      now = value
    },
    onRead: (callback) => {
      readCallback = callback
    },
    show() {
      for (const callback of [...shows]) callback()
    },
    unmount() {
      root.unmount()
      unmounted = true
    }
  }
  try {
    await act(async () =>
      root.render(
        strict
          ? React.createElement(React.StrictMode, null, React.createElement(Probe))
          : React.createElement(Probe)
      )
    )
    await run(harness)
    assert.equal(storage.get('draft'), 'preserved')
  } finally {
    try {
      if (!unmounted) await act(async () => root.unmount())
    } finally {
      Date.now = previous.now
      dom.window.close()
      global.window = previous.window
      global.document = previous.document
      global.IS_REACT_ACT_ENVIRONMENT = previous.act
    }
  }
}

function settledError(h) {
  assert.equal(h.current.loading, false)
  assert.equal(h.current.user, null)
  assert.equal(h.current.error, ERROR)
}
function paths(h) {
  return h.requests.map(({ url, method }) => `${method} ${new URL(url).pathname}`)
}

test('real auth: crossing expiry between before and ensure login settles after one identity GET', async () => {
  await withAccount(
    async (h) => {
      let reads = 0
      h.onRead(() => {
        if (++reads === 2) h.setNow(NOW + 2)
      })
      await h.act(async () => h.show())
      h.onRead(null)
      assert.equal(h.logins, 1)
      assert.deepEqual(paths(h), ['POST /api/v1/auth/wechat'])
      await h.act(async () => h.requests[0].resolve(loggedIn(credential(2))))
      if (h.requests.length === 1) {
        console.log(
          'cross-expiry settled state',
          JSON.stringify({
            user: h.current.user,
            loading: h.current.loading,
            error: h.current.error
          })
        )
        assert.equal(
          h.current.loading,
          false,
          'login settled but old hook remains permanently loading'
        )
      }
      assert.equal(h.requests.length, 2, 'new credential must receive one bounded GET /me')
      assert.equal(h.current.user, null)
      await h.act(async () => h.requests[1].resolve(success(user(2))))
      assert.equal(h.current.loading, false, 'latest refresh must not remain permanently loading')
      assert.equal(h.current.user.id, 2)
      assert.equal(h.current.accountKey, h.key())
      assert.equal(h.current.error, '')
      assert.deepEqual(paths(h), ['POST /api/v1/auth/wechat', 'GET /api/v1/me'])
    },
    { initial: credential(1, NOW + 1) }
  )
})

for (const strict of [false, true]) {
  test(`real auth: stable credential has only ensure GET, registered show lifecycle strict=${strict}`, async () => {
    await withAccount(
      async (h) => {
        assert.equal(h.requests.length, 0)
        await h.act(async () => h.show())
        await h.act(async () => h.requests[0].resolve(success(user())))
        assert.equal(h.current.user.id, 1)
        assert.equal(h.current.loading, false)
        assert.equal(h.current.error, '')
        assert.deepEqual(paths(h), ['GET /api/v1/me'])
        assert.equal(h.logins, 0)
        assert.equal(h.writes.length, 0)
      },
      { strict }
    )
  })
}

for (const initial of [null, credential(1, NOW - 1)]) {
  test(`real auth: ${
    initial ? 'expired' : 'empty'
  } entry login requires exactly one current identity GET`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        await h.act(async () => h.requests[0].resolve(loggedIn()))
        assert.equal(h.current.user, null)
        assert.equal(h.current.loading, true)
        assert.equal(h.requests.length, 2)
        await h.act(async () => h.requests[1].resolve(success(user())))
        assert.equal(h.current.user.id, 1)
        assert.equal(h.current.loading, false)
        assert.deepEqual(paths(h), ['POST /api/v1/auth/wechat', 'GET /api/v1/me'])
        assert.equal(h.logins, 1)
        assert.equal(h.writes.length, 1)
      },
      { initial }
    )
  })
}

for (const stage of ['ensure', 'login', 'recheck']) {
  test(`real auth: ${stage} 401 ends refresh without automatically logging in or replaying`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        if (stage === 'recheck') await h.act(async () => h.requests[0].resolve(loggedIn()))
        await h.act(async () => h.requests.at(-1).resolve(unauthorized()))
        settledError(h)
        assert.equal(h.logins, stage === 'ensure' ? 0 : 1)
        assert.equal(h.requests.length, stage === 'recheck' ? 2 : 1)
        assert.equal(h.writes.length, stage === 'recheck' ? 1 : 0)
        assert.doesNotMatch(h.current.error, /private-server-message/)
      },
      { initial: stage === 'ensure' ? credential() : null }
    )
  })
}

for (const fault of ['null', 'failure', 'wrong-user']) {
  test(`real auth: bounded identity GET ${fault} terminates with controlled error`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        await h.act(async () => h.requests[0].resolve(loggedIn()))
        assert.equal(h.requests.length, 2)
        await h.act(async () => {
          if (fault === 'failure') h.requests[1].reject(Error('private-network-message'))
          else h.requests[1].resolve(success(fault === 'null' ? null : user(2)))
        })
        settledError(h)
        assert.equal(h.requests.length, 2)
        assert.equal(h.logins, 1)
        assert.equal(h.writes.length, 1)
      },
      { initial: null }
    )
  })
}

const mutations = {
  account: (h) => h.setStored(credential(2)),
  token: (h) => h.setStored(credential(1, NOW + 60000, 9)),
  expiry: (h) => h.setStored(credential(1, NOW + 90000)),
  disappeared: (h) => h.setStored(null),
  expired: (h) => h.setNow(NOW + 60001)
}
for (const [name, mutate] of Object.entries(mutations)) {
  test(`real auth: ${name} change during bounded GET discards result and ends loading`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        await h.act(async () => h.requests[0].resolve(loggedIn()))
        assert.equal(h.requests.length, 2)
        mutate(h)
        await h.act(async () => h.requests[1].resolve(success(user())))
        settledError(h)
        assert.equal(h.logins, 1)
        assert.equal(h.requests.length, 2)
        assert.equal(h.writes.length, 1)
      },
      { initial: null }
    )
  })
}

for (const oldFirst of [true, false]) {
  test(`real auth: newer refresh owns state, old ${
    oldFirst ? 'success while new pending' : 'failure after new success'
  } is ignored`, async () => {
    await withAccount(async (h) => {
      await h.act(async () => h.show())
      h.setStored(credential(2))
      await h.act(async () => {
        void h.current.refresh()
      })
      assert.equal(h.requests.length, 2)
      if (oldFirst) {
        await h.act(async () => h.requests[0].resolve(success(user())))
        assert.equal(h.current.loading, true)
        assert.equal(h.current.user, null)
        assert.equal(h.current.error, '')
      }
      await h.act(async () => h.requests[1].resolve(success(user(2))))
      const winner = h.current
      assert.equal(winner.user.id, 2)
      assert.equal(winner.loading, false)
      if (!oldFirst) {
        await h.act(async () => h.requests[0].reject(Error('old-failure')))
        assert.equal(h.current, winner)
      }
      assert.equal(h.logins, 0)
      assert.equal(h.writes.length, 0)
    })
  })
}

for (const phase of ['ensure', 'recheck']) {
  test(`real auth: unmount during ${phase} ignores late result and retained refresh sends nothing`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        if (phase === 'recheck') await h.act(async () => h.requests[0].resolve(loggedIn()))
        const retained = h.current.refresh
        const state = h.current
        const calls = h.requests.length
        await h.act(async () => h.unmount())
        await h.act(async () => h.requests.at(-1).resolve(success(user())))
        assert.equal(h.current, state)
        let retainedResult
        await h.act(async () => {
          retainedResult = retained()
        })
        assert.equal(h.requests.length, calls)
        assert.equal(await retainedResult, null)
        assert.equal(h.logins, phase === 'recheck' ? 1 : 0)
      },
      { initial: phase === 'recheck' ? null : credential() }
    )
  })
}

test('real auth: explicit retry after reconciliation 401 succeeds without automatic loop', async () => {
  await withAccount(
    async (h) => {
      await h.act(async () => h.show())
      await h.act(async () => h.requests[0].resolve(loggedIn()))
      assert.equal(h.requests.length, 2)
      await h.act(async () => h.requests[1].resolve(unauthorized()))
      settledError(h)
      assert.equal(h.requests.length, 2)
      await h.act(async () => {
        void h.current.refresh()
      })
      assert.equal(h.requests.length, 3)
      await h.act(async () => h.requests[2].resolve(loggedIn(credential(2))))
      assert.equal(h.requests.length, 4)
      await h.act(async () => h.requests[3].resolve(success(user(2))))
      assert.equal(h.current.user.id, 2)
      assert.equal(h.current.loading, false)
      assert.equal(h.current.error, '')
      assert.equal(h.logins, 2)
      assert.deepEqual(paths(h), [
        'POST /api/v1/auth/wechat',
        'GET /api/v1/me',
        'POST /api/v1/auth/wechat',
        'GET /api/v1/me'
      ])
    },
    { initial: null }
  )
})

// Precise post-ensure boundaries are supplemental; the main path above uses real auth.
for (const value of [null, user(2), { id: '1' }, { id: 0 }]) {
  test(`post-ensure boundary: stable key rejects unbound candidate ${JSON.stringify(
    value
  )}`, async () => {
    let reads = 0
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        settledError(h)
        assert.equal(reads, 0, 'stable key must not trigger an extra GET')
      },
      {
        boundary: {
          ensure: async () => value,
          read: async () => {
            reads++
            return user()
          }
        }
      }
    )
  })
}

for (const fault of [
  'disappeared',
  'null',
  'failure',
  'wrong-user',
  'account',
  'token',
  'expiry',
  'expired'
]) {
  test(`post-ensure boundary: ${fault} at bounded reconciliation ends loading`, async () => {
    let harness
    let reads = 0
    await withAccount(
      async (h) => {
        harness = h
        await h.act(async () => h.show())
        settledError(h)
        assert.equal(reads, fault === 'disappeared' ? 0 : 1)
      },
      {
        boundary: {
          ensure: async () => {
            harness.setStored(fault === 'disappeared' ? null : credential(2))
            return user()
          },
          read: async () => {
            reads++
            if (fault === 'failure') throw Error('private-message')
            if (fault === 'null') return null
            if (fault === 'wrong-user') return user()
            if (fault === 'account') harness.setStored(credential(3))
            if (fault === 'token') harness.setStored(credential(2, NOW + 60000, 7))
            if (fault === 'expiry') harness.setStored(credential(2, NOW + 90000))
            if (fault === 'expired') harness.setNow(NOW + 60001)
            return user(2)
          }
        }
      }
    )
  })
}

test('post-ensure boundary: changed identity clears prior user while discarding ensure candidate', async () => {
  let harness
  let ensures = 0
  let reads = 0
  const check = deferred()
  await withAccount(
    async (h) => {
      harness = h
      await h.act(async () => h.show())
      assert.equal(h.current.user.id, 1)
      await h.act(async () => {
        void h.current.refresh()
      })
      assert.equal(h.current.user, null)
      assert.equal(h.current.loading, true)
      assert.equal(reads, 1)
      await h.act(async () => check.resolve(user(2)))
      assert.equal(h.current.user.id, 2)
      assert.equal(h.current.loading, false)
      assert.equal(ensures, 2)
    },
    {
      boundary: {
        ensure: async () => {
          if (++ensures === 2) harness.setStored(credential(2))
          return user(1)
        },
        read: () => {
          reads++
          return check.promise
        }
      }
    }
  )
})

for (const oldFirst of [true, false]) {
  test(`real auth: superseded bounded GET ${
    oldFirst ? 'success while pending' : 'failure after success'
  } never overwrites newer refresh`, async () => {
    await withAccount(
      async (h) => {
        await h.act(async () => h.show())
        await h.act(async () => h.requests[0].resolve(loggedIn()))
        assert.equal(h.requests.length, 2)
        await h.act(async () => {
          void h.current.refresh()
        })
        assert.equal(h.requests.length, 3)
        if (oldFirst) {
          await h.act(async () => h.requests[1].resolve(success(user())))
          assert.equal(h.current.loading, true)
          assert.equal(h.current.user, null)
          assert.equal(h.current.error, '')
        }
        await h.act(async () => h.requests[2].resolve(success(user())))
        const winner = h.current
        assert.equal(winner.user.id, 1)
        assert.equal(winner.loading, false)
        if (!oldFirst) {
          await h.act(async () => h.requests[1].reject(Error('stale-check-failure')))
          assert.equal(h.current, winner)
        }
        assert.equal(h.requests.length, 3)
        assert.equal(h.logins, 1)
        assert.equal(h.writes.length, 1)
      },
      { initial: null }
    )
  })
}

test('real auth: unconfigured WeChat is explicit configuration feedback, never a network retry or credential', async () => {
  await withAccount(async (h) => {
    await h.act(async () => h.show())
    assert.deepEqual(paths(h), ['POST /api/v1/auth/wechat'])
    await h.act(async () => h.requests[0].resolve({
      statusCode: 503,
      data: {
        error: { code: 'AUTH_UNCONFIGURED', message: 'private configuration detail', retryable: false },
        requestId: 'unconfigured-trace'
      }
    }))
    assert.equal(h.current.user, null)
    assert.equal(h.current.loading, false)
    assert.equal(h.current.error, '微信登录尚未配置')
    assert.doesNotMatch(h.current.error, /网络|重试|private/)
    assert.equal(h.requests.length, 1)
    assert.equal(h.logins, 1)
    assert.equal(h.writes.length, 0)
    assert.equal(h.key(), '')
  }, { initial: null })
})
