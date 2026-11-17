const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { load } = require('../source.cjs')
const { withCredits, ledger, reservation } = require('../fixtures/credits-pages.cjs')
test('registered routes add both actual credit pages while preserving the original eight and three tabs', () => {
  const config = load('src/app.config.js').default
  assert.equal(config.pages.length, 10)
  assert.equal(config.tabBar.list.length, 3)
  assert.ok(config.pages.includes('pages/credits/index'))
  assert.ok(config.pages.includes('pages/credit-reservations/index'))
})
test('actual wallet and ledger DOM are lazy read-only and sources/reserved reflect real decoded account', async () =>
  withCredits(async (f) => {
    await f.mount()
    assert.match(f.text(), /可用积分.*2.*处理中占用3 点/)
    assert.equal(f.calls.filter((c) => c.path.startsWith('/credits/ledger')).length, 0)
    await f.act(async () => f.click('credits', '明细'))
    assert.match(f.text(), /占用3点.*0 点/)
    assert.equal(f.calls.filter((c) => c.path.startsWith('/generations')).length, 0)
    await f.act(async () => f.click('credits', '余额'))
    await f.act(async () => f.click('credits', '明细'))
    assert.equal(f.calls.filter((c) => c.path.startsWith('/credits/ledger')).length, 1)
    assert.equal(f.navigation.length, 0)
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    const scroll = document.querySelector('.credits-scroll')
    assert.ok(scroll)
    assert.doesNotMatch(f.text(), /积分包|查看套餐|下次发放/)
  }))
test('actual reservation cards retain zero-cost records, prioritize review and bind fresh terminal task on click', async () =>
  withCredits(
    async (f) => {
      await f.mount('credit-reservations')
      assert.match(f.text('credit-reservations'), /第1轮创作.*待核对.*0 点/)
      assert.equal(f.calls.filter((c) => c.path === '/generations/9').length, 0)
      f.setTask({ status: 'failed' })
      await f.act(async () => document.querySelector('.credits-reservation').click())
      assert.equal(f.navigation[0].url, '/pages/create/index?session=4&focusTask=9')
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    },
    {
      initial: 'credit-reservations',
      reservations: [reservation(1, { reservedCredits: 0, reviewHint: 'PENDING_REVIEW' })],
    }
  ))
test('credits CSS uses append-only namespace, measured rows, scalable amount columns and prototype tokens', () => {
  const css = fs.readFileSync('src/app.scss', 'utf8')
  assert.match(css, /\.credits-screen/)
  assert.match(css, /#E5EDFC/i)
  assert.match(css, /min-height:\s*149px/)
  assert.match(css, /max-width:\s*50%/)
  assert.match(css, /#1D6C58/i)
})

for (const reserved of [0, 7])
  test(`actual decoded compensation source and reserved=${reserved} use account truth only`, async () =>
    withCredits(
      async (f) => {
        await f.mount()
        assert.match(f.text(), /补偿积分.*9 点/)
        assert.match(f.text(), /体验积分.*0 点.*月度积分.*0 点.*加购积分.*0 点/)
        assert.equal(/处理中占用/.test(f.text()), reserved > 0)
        assert.equal(f.calls.filter((c) => c.path.startsWith('/credits')).length, 0)
      },
      {
        account: { available: 9, reserved, sources: [{ sourceType: 'compensation', available: 9 }], configured: false },
      }
    ))
test('initial account failure displays unavailable rather than successful zero sources and retry stays GET', async () =>
  withCredits(
    async (f) => {
      await f.mount()
      assert.match(f.text(), /积分暂时无法读取/)
      assert.doesNotMatch(f.text(), /体验积分|月度积分|加购积分/)
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    },
    {
      request: ({ path }) =>
        path === '/creation-account'
          ? {
              statusCode: 503,
              data: { error: { code: 'TEMPORARY', message: 'private', retryable: true }, requestId: 'failed' },
            }
          : null,
    }
  ))
test('actual ledger continuation failure retains rows and lower scroll never retries a known failure', async () => {
  let failed = true
  await withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '明细'))
      await f.act(async () => f.click('credits', '继续读取'))
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 2)
      assert.match(f.text(), /暂时连接不上/)
      const count = f.calls.length
      assert.equal(f.handler().onScrollToLower, undefined)
      await f.act(async () => f.click('credits', '余额'))
      await f.act(async () => f.click('credits', '明细'))
      assert.equal(f.calls.length, count)
      failed = false
      await f.act(async () => f.click('credits', '重试'))
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 3)
    },
    {
      ledger: [ledger(1), ledger(2), ledger(3)],
      request: ({ path }) =>
        failed && path === '/credits/ledger?cursor=2'
          ? {
              statusCode: 503,
              data: { error: { code: 'TEMPORARY', retryable: true, message: 'private' }, requestId: 'failed' },
            }
          : null,
    }
  )
})
test('actual reservations fresh GET, not task status, removes settled rows; hidden wallet ledger remains lazy', async () =>
  withCredits(
    async (f) => {
      await f.mount('credit-reservations')
      await f.act(async () => document.querySelector('.credits-reservation').click())
      assert.equal(document.querySelectorAll('.credits-reservation').length, 1)
      await f.act(async () => f.fire('credit-reservations', 'hide'))
      f.setReservations([])
      await f.act(async () => f.fire('credit-reservations', 'show'))
      assert.match(f.text('credit-reservations'), /暂无记录/)
      assert.equal(f.calls.filter((c) => c.path === '/credits/reservations').length, 2)
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    },
    { initial: 'credit-reservations' }
  ))
test('actual native pending never redispatches on tap, touch, rerender or 61 seconds plus hide/show', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  await withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '处理中占用3 点 ›'))
      assert.equal(f.navigation.length, 1)
      await f.act(async () => {
        f.handler().onTouchStart()
        f.render()
      })
      t.mock.timers.tick(61000)
      await f.act(async () => {
        f.fire('credits', 'hide')
        f.fire('credits', 'show')
      })
      await f.act(async () => f.click('credits', '处理中占用3 点 ›'))
      assert.equal(f.navigation.length, 1)
      await f.act(async () => f.navigation[0].success())
      await f.act(async () => f.click('credits', '处理中占用3 点 ›'))
      assert.equal(f.navigation.length, 2)
    },
    { navigate: () => undefined }
  )
})
for (const kind of ['callback', 'Promise', 'throw'])
  test(`actual native ${kind} failure is controlled, consumed and explicit retry only`, async () =>
    withCredits(
      async (f) => {
        await f.mount()
        await f.act(async () => f.click('credits', '处理中占用3 点 ›'))
        assert.equal(f.navigation.length, 1)
        assert.equal(f.toasts.length, 1)
        await f.act(async () => f.click('credits', '处理中占用3 点 ›'))
        assert.equal(f.navigation.length, 2)
        assert.equal(f.toasts.length, 2)
      },
      {
        navigate: (o) => {
          if (kind === 'callback') o.fail()
          else if (kind === 'Promise') return Promise.reject(Error('native'))
          else throw Error('native')
        },
        toast: () => Promise.reject(Error('toast')),
      }
    ))

test('actual touch→row click exposes owned opening feedback; touch cancels read intent and new click is allowed', async () => {
  const { gate } = require('../fixtures/credits-pages.cjs')
  const pending = gate()
  let reads = 0
  await withCredits(
    async (f) => {
      await f.mount('credit-reservations')
      await f.act(async () => {
        f.handler('credit-reservations').onTouchStart()
        document.querySelector('.credits-reservation').click()
      })
      assert.match(f.text('credit-reservations'), /正在打开/)
      await f.act(async () => f.handler('credit-reservations').onTouchStart())
      assert.doesNotMatch(f.text('credit-reservations'), /正在打开/)
      await f.act(async () => document.querySelector('.credits-reservation').click())
      assert.equal(reads, 2)
      await f.act(async () => pending.resolve())
      assert.equal(f.navigation.length, 1)
      await f.act(async () => {
        f.handler('credit-reservations').onTouchStart()
        document.querySelector('.credits-reservation').click()
      })
      assert.equal(f.navigation.length, 1)
    },
    {
      initial: 'credit-reservations',
      request: async ({ path }) => {
        if (path === '/generations/9') {
          reads++
          await pending.promise
        }
        return null
      },
      navigate: () => undefined,
    }
  )
})

for (const binding of [{ id: 10 }, { sessionId: 5 }, { roundNo: 2 }])
  test(`actual reservation binding mismatch ${JSON.stringify(binding)} never navigates or writes`, async () =>
    withCredits(
      async (f) => {
        await f.mount('credit-reservations')
        f.setTask(binding)
        await f.act(async () => document.querySelector('.credits-reservation').click())
        assert.equal(f.navigation.length, 0)
        assert.equal(f.toasts.length, 1)
        assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
      },
      { initial: 'credit-reservations' }
    ))
test('actual same-key /me failure preserves committed prefix and unknown native pending', async () => {
  let failMe = false
  await withCredits(
    async (f) => {
      await f.mount('credit-reservations')
      await f.act(async () => document.querySelector('.credits-reservation').click())
      assert.equal(f.navigation.length, 1)
      failMe = true
      await f.act(async () => {
        f.fire('credit-reservations', 'hide')
        f.fire('credit-reservations', 'show')
      })
      assert.equal(document.querySelectorAll('.credits-reservation').length, 1)
      assert.match(f.text('credit-reservations'), /暂时连接不上/)
      await f.act(async () => document.querySelector('.credits-reservation').click())
      assert.equal(f.navigation.length, 1)
    },
    {
      initial: 'credit-reservations',
      navigate: () => undefined,
      request: ({ path }) =>
        failMe && path === '/me'
          ? {
              statusCode: 503,
              data: { error: { code: 'TEMPORARY', message: 'private', retryable: true }, requestId: 'failed' },
            }
          : null,
    }
  )
})
for (const keyPart of ['token', 'expiresAt', 'userId'])
  test(`actual ${keyPart} rotation suppresses old prefix and late ledger response`, async () => {
    const { gate, envelope } = require('../fixtures/credits-pages.cjs')
    const pending = gate()
    let hold = true
    await withCredits(
      async (f) => {
        await f.mount()
        await f.act(async () => f.click('credits', '明细'))
        const old = f.getCredential()
        f.setCredential({
          ...old,
          [keyPart]:
            keyPart === 'token' ? 'B'.repeat(42) + 'A' : keyPart === 'expiresAt' ? '2098-01-01T00:00:00.000Z' : 2,
        })
        await f.act(async () => f.render())
        assert.equal(document.querySelectorAll('.credits-ledger-row').length, 0)
        hold = false
        await f.act(async () => pending.resolve())
        assert.equal(document.querySelectorAll('.credits-ledger-row').length, 0)
        await f.act(async () => f.fire('credits', 'show'))
        await f.act(async () => f.click('credits', '明细'))
        assert.equal(document.querySelectorAll('.credits-ledger-row').length, 1)
      },
      {
        request: async ({ path }) => {
          if (hold && path === '/credits/ledger') {
            await pending.promise
            return envelope({ items: [ledger(99)], nextCursor: null, hasMore: false })
          }
          return null
        },
      }
    )
  })

test('actual ledger pauses fresh 24-page history at 20 GETs and only explicit Continue advances', async () =>
  withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '明细'))
      for (let i = 1; i < 24; i++) await f.act(async () => f.click('credits', '继续读取'))
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 24)
      const before = f.calls.filter((c) => c.path.startsWith('/credits/ledger')).length
      await f.act(async () => {
        f.fire('credits', 'hide')
        f.fire('credits', 'show')
      })
      assert.equal(f.calls.filter((c) => c.path.startsWith('/credits/ledger')).length - before, 20)
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 24)
      assert.equal(f.handler().onScrollToLower, undefined)
      assert.match(f.text(), /暂停更新/)
      await f.act(async () => f.click('credits', '继续更新'))
      assert.equal(f.calls.filter((c) => c.path.startsWith('/credits/ledger')).length - before, 24)
      assert.doesNotMatch(f.text(), /暂停更新/)
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0)
    },
    { pageSize: 1, ledger: Array.from({ length: 24 }, (_, n) => ledger(n + 1)) }
  ))
test('actual legal empty scan is not EOF and successful scan page counts in return fresh prefix', async () => {
  const { envelope } = require('../fixtures/credits-pages.cjs')
  await withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '明细'))
      assert.match(f.text(), /当前扫描未读到记录/)
      assert.doesNotMatch(f.text(), /暂无记录/)
      await f.act(async () => f.click('credits', '当前扫描未读到记录，继续读取'))
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 1)
      const before = f.calls.length
      await f.act(async () => {
        f.fire('credits', 'hide')
        f.fire('credits', 'show')
      })
      assert.equal(f.calls.slice(before).filter((c) => c.path.startsWith('/credits/ledger')).length, 2)
    },
    {
      request: ({ path }) =>
        path === '/credits/ledger'
          ? envelope({ items: [], hasMore: true, nextCursor: 'scan' })
          : path === '/credits/ledger?cursor=scan'
          ? envelope({ items: [ledger()], nextCursor: null, hasMore: false })
          : null,
    }
  )
})

test('reserved entry is a separate white row, not part of the fixed blue balance card', async () =>
  withCredits(async (f) => {
    await f.mount()
    const card = document.querySelector('.credits-balance-card'),
      entry = document.querySelector('.credits-reserved-entry')
    assert.equal(card.contains(entry), false)
    assert.equal(card.parentElement, entry.parentElement)
    assert.equal(entry.children.length, 2)
    assert.equal(entry.children[0].textContent, '处理中占用')
    assert.equal(entry.children[1].textContent, '3 点 ›')
  }))
test('actual initial account identity pending has one explicit wait; failure has only controlled error and no fake facts', async () => {
  const { gate } = require('../fixtures/credits-pages.cjs')
  const pending = gate()
  await withCredits(
    async (f) => {
      await f.mount()
      assert.match(f.text(), /正在读取账号/)
      assert.equal(document.querySelectorAll('.brand--animated').length, 1)
      await f.act(async () => pending.resolve())
      assert.match(f.text(), /暂时连接不上/)
      assert.equal(document.querySelectorAll('.brand--animated').length, 0)
      assert.doesNotMatch(f.text(), /0 点|暂无记录|体验积分/)
    },
    {
      request: async ({ path }) => {
        if (path === '/me') {
          await pending.promise
          return {
            statusCode: 503,
            data: { error: { code: 'TEMPORARY', retryable: true, message: 'private' }, requestId: 'failed' },
          }
        }
        return null
      },
    }
  )
})

test('known wallet refresh keeps loading feedback inside the existing card heading without shifting sources', async () => {
  const { gate } = require('../fixtures/credits-pages.cjs')
  const pending = gate()
  let delay = false
  await withCredits(
    async (f) => {
      await f.mount()
      delay = true
      await f.act(async () => {
        f.fire('credits', 'hide')
        f.fire('credits', 'show')
      })
      assert.equal(document.querySelectorAll('#credits .inline-loading').length, 0)
      assert.equal(document.querySelectorAll('.credits-balance-heading .brand--animated').length, 1)
      assert.match(f.text(), /体验积分.*2 点/)
      await f.act(async () => pending.resolve())
    },
    {
      request: async ({ path }) => {
        if (delay && path === '/creation-account') await pending.promise
        return null
      },
    }
  )
})
