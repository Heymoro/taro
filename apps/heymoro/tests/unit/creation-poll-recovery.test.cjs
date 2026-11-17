const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { withPages } = require('../fixtures/creation-pages.cjs')
const { task } = require('../fixtures/creation.cjs')
const offline = () =>
  Object.assign(Error('REQUEST_OUTCOME_UNKNOWN'), {
    code: 'REQUEST_OUTCOME_UNKNOWN',
    status: null,
    isOutcomeUnknown: true
  })
const gate = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
test('poll policy exact bases, jitter limits, and strict transport classifier', () => {
  const { readPollDelay, isReadTransportError } = load('src/features/creation/read-poll-policy.js')
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((failureCount) => readPollDelay({ failureCount, random: () => 0.5 })),
    [2000, 2000, 4000, 8000, 16000, 30000, 30000]
  )
  for (let failureCount = 1; failureCount <= 6; failureCount++) {
    const base = [2000, 4000, 8000, 16000, 30000][Math.min(failureCount - 1, 4)]
    assert.equal(readPollDelay({ failureCount, random: () => -1 }), base * 0.8)
    assert.equal(readPollDelay({ failureCount, random: () => 2 }), base * 1.2)
  }
  assert.equal(isReadTransportError(offline()), true)
  for (const e of [
    Error('NETWORK'),
    { code: 'INVALID_RESPONSE', isOutcomeUnknown: true },
    { code: 'REQUEST_OUTCOME_UNKNOWN', status: 404, isOutcomeUnknown: true },
    { code: 'OPERATION_OUTCOME_UNKNOWN', status: null, isOutcomeUnknown: true }
  ])
    assert.equal(isReadTransportError(e), false)
})
async function tick(t, h, ms) {
  await h.act(async () => t.mock.timers.tick(ms))
  await h.flush()
}
function setupPorts({ ports }, control) {
  const api = { ...ports }
  for (const name of ['account', 'getSession', 'freePreset', 'tasks', 'task', 'artifact']) {
    const fn = ports[name]
    api[name] = async (...args) => {
      control.calls.push(name)
      if (name === 'account') {
        if (control.gate) await control.gate.promise
        if (control.fail) throw offline()
      }
      if (name === 'task') return task({}, { artifactIds: [] })
      if (name === 'tasks')
        return { items: [task({}, { artifactIds: [] })], hasMore: false, nextCursor: null }
      if (name === 'freePreset' && control.degraded)
        throw Object.assign(Error('TEMPLATE_UNAVAILABLE'), { code: 'TEMPLATE_UNAVAILABLE' })
      return fn(...args)
    }
  }
  for (const name of ['generate', 'regenerate', 'createSession'])
    api[name] = async () => {
      control.posts++
      throw Error('unexpected automatic write')
    }
  return { creationApi: api }
}
test('actual hook retries once at each fixed jittered deadline, emits do not drift it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  const c = { calls: [], fail: false, posts: 0 }
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      c.fail = true
      c.calls = []
      await tick(t, h, 2000)
      for (let count = 1; count <= 6; count++) {
        const s = w.getSnapshot()
        assert.equal(s.readRecovery.failureCount, count)
        assert.equal(c.calls.filter((n) => n === 'account').length, count)
        const due = s.readRecovery.nextAttemptAt,
          delay = due - Date.now(),
          base = [2000, 4000, 8000, 16000, 30000][Math.min(count - 1, 4)]
        assert.ok(delay >= base * 0.8 && delay <= base * 1.2)
        await h.act(async () => w.setPageVisible({ visible: true }))
        assert.equal(w.getSnapshot().readRecovery.nextAttemptAt, due)
        await tick(t, h, delay - 1)
        assert.equal(c.calls.filter((n) => n === 'account').length, count)
        if (count < 6) await tick(t, h, 1)
      }
      assert.equal(w.shouldPoll(), true)
      assert.equal(c.posts, 0)
    },
    { createApi: (args) => setupPorts(args, c) }
  )
})
test('actual hook hide/show merges demand and respects old deadline and in-flight cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  const c = { calls: [], fail: false, posts: 0 }
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      c.fail = true
      c.calls = []
      await tick(t, h, 2000)
      const due = w.getSnapshot().readRecovery.nextAttemptAt
      await h.act(async () => {
        h.fire(h.createPage, 'hide')
        h.fire(h.createPage, 'show')
        h.fire(h.createPage, 'show')
      })
      assert.equal(c.calls.filter((n) => n === 'account').length, 1)
      await tick(t, h, due - Date.now() - 1)
      assert.equal(c.calls.filter((n) => n === 'account').length, 1)
      c.gate = gate()
      await tick(t, h, 1)
      assert.equal(c.calls.filter((n) => n === 'account').length, 2)
      await h.act(async () => {
        h.fire(h.createPage, 'hide')
        h.fire(h.createPage, 'show')
        h.fire(h.createPage, 'show')
      })
      assert.equal(c.calls.filter((n) => n === 'account').length, 2)
      const g = c.gate
      c.gate = null
      await h.act(async () => g.resolve())
      assert.equal(c.calls.filter((n) => n === 'account').length, 3)
      assert.equal(w.getSnapshot().readRecovery.failureCount, 2)
      assert.equal(c.calls.at(-1), 'account')
      assert.equal(c.posts, 0)
    },
    { createApi: (args) => setupPorts(args, c) }
  )
})
test('actual hook manual joins once, keeps failure count, degraded retains it, only complete success resets', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  const c = { calls: [], fail: false, posts: 0 }
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      c.fail = true
      c.calls = []
      await tick(t, h, 2000)
      c.gate = gate()
      let one, two
      await h.act(async () => {
        one = w.retryError()
        two = w.retryError()
      })
      assert.equal(c.calls.filter((n) => n === 'account').length, 2)
      const g = c.gate
      c.gate = null
      await h.act(async () => g.resolve())
      await Promise.all([one, two])
      assert.equal(w.getSnapshot().readRecovery.failureCount, 2)
      assert.ok(w.getSnapshot().readRecovery.nextAttemptAt - Date.now() >= 3200)
      c.fail = false
      c.degraded = true
      await h.act(async () => w.refresh())
      assert.equal(w.getSnapshot().readRecovery.failureCount, 2)
      assert.equal(w.getSnapshot().readRecovery.phase, 'degraded')
      c.degraded = false
      await h.act(async () => w.refresh())
      assert.equal(w.getSnapshot().readRecovery.failureCount, 0)
      assert.equal(w.getSnapshot().readRecovery.nextAttemptAt - Date.now(), 2000)
      const reads = c.calls.length
      await tick(t, h, 1999)
      assert.equal(c.calls.length, reads)
      await tick(t, h, 1)
      assert.ok(c.calls.length > reads)
      assert.equal(c.posts, 0)
    },
    { createApi: (args) => setupPorts(args, c) }
  )
})
test('actual hook StrictMode/account owner and unmount dispose all old retry IO', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  const c = { calls: [], fail: false, posts: 0 }
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      c.fail = true
      c.calls = []
      await tick(t, h, 2000)
      assert.equal(c.calls.filter((n) => n === 'account').length, 1)
      await h.act(async () => {
        h.setKey('new-key')
        h.render('create')
      })
      const w = h.controllers.at(-1)
      assert.equal(w.getSnapshot().readRecovery.failureCount, 1)
      const reads = c.calls.length
      await h.act(async () => h.fire(h.createPage, 'hide'))
      await tick(t, h, 60000)
      assert.equal(c.calls.length, reads)
      await h.act(async () => h.unmountCreate())
      await tick(t, h, 60000)
      assert.equal(c.calls.length, reads)
      assert.equal(c.posts, 0)
    },
    { strict: true, createApi: (args) => setupPorts(args, c) }
  )
})
for (const hidden of [false, true])
  test(`actual quote expiry ${
    hidden ? 'hidden' : 'offline'
  } never automatically posts a new quote`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    let disconnected = false,
      quotes = 0
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0]
        await h.act(async () => {
          w.setDescription('draft')
          await w.prepareQuote()
        })
        const before = quotes
        assert.ok(w.getSnapshot().quote)
        if (hidden) await h.act(async () => h.fire(h.createPage, 'hide'))
        else {
          disconnected = true
          await h.act(async () => w.refresh())
          assert.equal(w.getSnapshot().readRecovery.phase, 'offline')
        }
        await tick(t, h, 60000)
        assert.equal(quotes, before)
        assert.equal(w.getSnapshot().quote, null)
      },
      {
        createApi: ({ ports }) => ({
          creationApi: {
            ...ports,
            tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
            account: async () => {
              if (disconnected) throw offline()
              return ports.account()
            },
            quote: async (args) => {
              quotes++
              return ports.quote(args)
            }
          }
        })
      }
    )
  })
for (const accepted of [false, true])
  test(`actual ${
    accepted ? 'accepted queued' : 'frozen pending'
  } journal never auto-resubmits during long disconnection, manual reads or recovery`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    let disconnected = false,
      active = false,
      posts = []
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0]
        await h.act(async () => {
          w.setDescription('  immutable request  ')
          await w.prepareQuote()
          await w.generate()
        })
        assert.equal(posts.length, 1)
        const pending = JSON.stringify(w.getSnapshot().submission),
          journal = JSON.stringify(h.storageWrites)
        const account = JSON.stringify(w.getSnapshot().account)
        active = true
        disconnected = true
        await h.act(async () => w.refresh())
        for (let i = 0; i < 6; i++) {
          const due = w.getSnapshot().readRecovery.nextAttemptAt
          // Pending without known active history has no background poll; explicit reads are still singleflight.
          await tick(t, h, Math.max(1, due - Date.now()))
          await h.act(async () => w.refresh())
        }
        assert.equal(posts.length, 1)
        assert.equal(JSON.stringify(w.getSnapshot().submission), pending)
        assert.equal(JSON.stringify(h.storageWrites), journal)
        assert.equal(JSON.stringify(w.getSnapshot().account), account)
        disconnected = false
        await h.act(async () => w.refresh())
        assert.equal(w.shouldPoll(), true)
        assert.ok(w.getSnapshot().rounds.every((r) => r.status === 'queued'))
        assert.equal(posts.length, 1)
        assert.equal(JSON.stringify(w.getSnapshot().submission), pending)
        assert.equal(JSON.stringify(h.storageWrites), journal)
        await tick(t, h, 2000)
        assert.equal(posts.length, 1)
      },
      {
        createApi: ({ ports }) => ({
          creationApi: {
            ...ports,
            account: async () => {
              if (disconnected) throw offline()
              return ports.account()
            },
            tasks: async () => ({
              items: active ? [task({}, { artifactIds: [] })] : [],
              hasMore: false,
              nextCursor: null
            }),
            task: async () => task({}, { artifactIds: [] }),
            generate: async (body) => {
              posts.push(['generate', JSON.parse(JSON.stringify(body))])
              if (!accepted) throw offline()
              active = true
              return task(body, { artifactIds: [] })
            },
            regenerate: async (body) => {
              posts.push(['regenerate', body])
              throw Error('unexpected')
            },
            createSession: async (body) => {
              posts.push(['createSession', body])
              throw Error('unexpected')
            }
          }
        })
      }
    )
  })

test('actual quote expiry during recovery reading keeps known-disconnected quote POST suppressed', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  let disconnected = false
  let accountGate = null
  let quotes = 0
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const workflow = h.controllers[0]
      await h.act(async () => {
        workflow.setDescription('preserved quote')
        await workflow.prepareQuote()
      })
      const originalQuotePosts = quotes
      disconnected = true
      await h.act(async () => workflow.refresh())
      assert.equal(workflow.getSnapshot().readRecovery.failureCount, 1)
      disconnected = false
      accountGate = gate()
      let recovery
      await h.act(async () => {
        recovery = workflow.refresh()
      })
      assert.equal(workflow.getSnapshot().readRecovery.phase, 'reading')
      assert.equal(workflow.getSnapshot().readRecovery.failureCount, 1)
      await tick(t, h, 60000)
      assert.equal(quotes, originalQuotePosts)
      assert.equal(workflow.getSnapshot().quote, null)
      const waiting = accountGate
      accountGate = null
      await h.act(async () => waiting.resolve())
      await recovery
      assert.equal(workflow.getSnapshot().readRecovery.failureCount, 0)
      assert.equal(quotes, originalQuotePosts + 1)
      assert.equal(workflow.getSnapshot().controls.canGenerate, true)
    },
    {
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
          account: async () => {
            if (accountGate) await accountGate.promise
            if (disconnected) throw offline()
            return ports.account()
          },
          quote: async (args) => {
            quotes++
            return ports.quote(args)
          }
        }
      })
    }
  )
})

function deferredQuoteApi({ ports }, control) {
  return {
    creationApi: {
      ...ports,
      tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
      account: async () => {
        const waiting = control.accountGate
        if (waiting) await waiting.promise
        if (control.disconnected) throw offline()
        return ports.account()
      },
      quote: async (args) => {
        control.quotes.push(JSON.parse(JSON.stringify(args)))
        if (control.failQuote && control.quotes.length === 2) {
          throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT' })
        }
        return ports.quote(args)
      },
      generate: async () => {
        control.taskWrites++
        throw Error('unexpected automatic generation')
      },
      regenerate: async () => {
        control.taskWrites++
        throw Error('unexpected automatic regeneration')
      },
      createSession: async () => {
        control.taskWrites++
        throw Error('unexpected automatic session creation')
      }
    }
  }
}

for (const expiryState of ['hidden', 'offline', 'recovering']) {
  for (const failQuote of [false, true]) {
    test(`actual ${expiryState} deferred quote resumes once after fresh read; quote ${
      failQuote ? 'failure stays explicit' : 'success restores generate'
    }`, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
      const control = {
        disconnected: false,
        accountGate: null,
        quotes: [],
        taskWrites: 0,
        failQuote
      }
      await withPages(
        async (h) => {
          await h.act(async () => h.render('create'))
          const workflow = h.controllers[0]
          await h.act(async () => {
            workflow.setDescription('same preserved input')
            await workflow.prepareQuote()
          })
          assert.equal(control.quotes.length, 1)
          assert.equal(workflow.getSnapshot().controls.canGenerate, true)
          const journal = JSON.stringify(h.storageWrites)
          let recovery
          if (expiryState === 'hidden') {
            await h.act(async () => h.fire(h.createPage, 'hide'))
          } else {
            control.disconnected = true
            await h.act(async () => workflow.refresh())
            if (expiryState === 'recovering') {
              control.accountGate = gate()
              await h.act(async () => {
                recovery = workflow.refresh()
              })
            }
          }
          await tick(t, h, 60000)
          assert.equal(control.quotes.length, 1)
          assert.equal(workflow.getSnapshot().quote, null)
          assert.equal(workflow.getSnapshot().controls.canGenerate, false)
          control.disconnected = false
          if (expiryState !== 'recovering') {
            control.accountGate = gate()
            await h.act(async () => {
              if (expiryState === 'hidden') h.fire(h.createPage, 'show')
              else recovery = workflow.refresh()
            })
          }
          // The hidden page still had cached ready/failureCount0 before this show GET.
          // Neither that cache nor an in-flight recovery proves current-epoch connectivity.
          assert.equal(workflow.getSnapshot().readRecovery.phase, 'reading')
          assert.equal(control.quotes.length, 1)
          const waiting = control.accountGate
          control.accountGate = null
          await h.act(async () => waiting.resolve())
          if (recovery) await recovery
          await h.flush()
          assert.equal(workflow.getSnapshot().readRecovery.phase, 'ready')
          assert.equal(control.quotes.length, 2)
          assert.deepEqual(control.quotes[1], control.quotes[0])
          assert.equal(control.taskWrites, 0)
          assert.equal(JSON.stringify(h.storageWrites), journal)
          if (failQuote) {
            assert.equal(workflow.getSnapshot().errorAction, 'quote')
            assert.equal(workflow.getSnapshot().controls.canGenerate, false)
            await h.act(async () => {
              workflow.setPageVisible({ visible: true })
              workflow.setPageVisible({ visible: true })
              await workflow.refresh()
            })
            await tick(t, h, 100000)
            assert.equal(control.quotes.length, 2)
            await h.act(async () => workflow.retryError())
            assert.equal(control.quotes.length, 3)
            assert.equal(workflow.getSnapshot().controls.canGenerate, true)
          } else {
            assert.equal(workflow.getSnapshot().controls.canGenerate, true)
            const newQuote = workflow.getSnapshot().quote
            await h.act(async () => workflow.refresh())
            assert.equal(control.quotes.length, 2)
            assert.equal(workflow.getSnapshot().quote, newQuote)
          }
        },
        { createApi: (args) => deferredQuoteApi(args, control) }
      )
    })
  }
}

for (const expiryState of ['hidden', 'offline']) {
  test(`actual explicit new quote cancels old ${expiryState} deferred intent before recovery`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    const control = { disconnected: false, accountGate: null, quotes: [], taskWrites: 0 }
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const workflow = h.controllers[0]
        await h.act(async () => {
          workflow.setDescription('explicit replacement quote')
          await workflow.prepareQuote()
        })
        if (expiryState === 'hidden') await h.act(async () => h.fire(h.createPage, 'hide'))
        else {
          control.disconnected = true
          await h.act(async () => workflow.refresh())
        }
        await tick(t, h, 60000)
        await h.act(async () => workflow.prepareQuote())
        assert.equal(control.quotes.length, expiryState === 'hidden' ? 1 : 2)
        let replacement = workflow.getSnapshot().quote
        if (expiryState === 'hidden') {
          assert.equal(replacement, null)
          assert.equal(workflow.getSnapshot().quoting, false)
        }
        control.disconnected = false
        if (expiryState === 'hidden') await h.act(async () => h.fire(h.createPage, 'show'))
        else await h.act(async () => workflow.refresh())
        await h.flush()
        assert.equal(control.quotes.length, expiryState === 'hidden' ? 1 : 2)
        assert.equal(workflow.getSnapshot().quote, replacement)
        if (expiryState === 'hidden') {
          await h.act(async () => workflow.prepareQuote())
          assert.equal(control.quotes.length, 2)
          replacement = workflow.getSnapshot().quote
          assert.ok(replacement)
        }
        assert.equal(control.taskWrites, 0)
      },
      { createApi: (args) => deferredQuoteApi(args, control) }
    )
  })
}

for (const change of ['unmount', 'account']) {
  test(`actual ${change} discards old owner deferred quote before late recovery settles`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    const control = { disconnected: false, accountGate: null, quotes: [], taskWrites: 0 }
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const workflow = h.controllers[0]
        await h.act(async () => {
          workflow.setDescription('old owner input')
          await workflow.prepareQuote()
        })
        control.disconnected = true
        await h.act(async () => workflow.refresh())
        control.accountGate = gate()
        let recovery
        await h.act(async () => {
          recovery = workflow.refresh()
        })
        await tick(t, h, 60000)
        assert.equal(control.quotes.length, 1)
        const oldGate = control.accountGate
        control.accountGate = null
        control.disconnected = false
        await h.act(async () => {
          if (change === 'unmount') h.unmountCreate()
          else {
            h.createPage.options = {}
            h.setKey('replacement-account-key')
            h.render('create')
          }
        })
        await h.act(async () => oldGate.resolve())
        await recovery
        await h.flush()
        assert.equal(control.quotes.length, 1)
        assert.equal(control.taskWrites, 0)
      },
      { createApi: (args) => deferredQuoteApi(args, control) }
    )
  })
}

test('actual healthy quote expiry retains the existing automatic renewal behavior', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
  const control = { disconnected: false, accountGate: null, quotes: [], taskWrites: 0 }
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const workflow = h.controllers[0]
      await h.act(async () => {
        workflow.setDescription('healthy quote input')
        await workflow.prepareQuote()
      })
      assert.equal(control.quotes.length, 1)
      await tick(t, h, 60000)
      assert.equal(control.quotes.length, 2)
      assert.equal(workflow.getSnapshot().controls.canGenerate, true)
      assert.equal(control.taskWrites, 0)
    },
    { createApi: (args) => deferredQuoteApi(args, control) }
  )
})

for (const expiryState of ['hidden', 'offline']) {
  test(`actual failed explicit quote cancels old ${expiryState} deferred intent and retains explicit retry`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    const control = {
      disconnected: false,
      accountGate: null,
      quotes: [],
      taskWrites: 0,
      failQuote: true
    }
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const workflow = h.controllers[0]
        await h.act(async () => {
          workflow.setDescription('preserved explicit quote input')
          await workflow.prepareQuote()
        })
        assert.equal(control.quotes.length, 1)
        if (expiryState === 'hidden') await h.act(async () => h.fire(h.createPage, 'hide'))
        else {
          control.disconnected = true
          await h.act(async () => workflow.refresh())
        }
        await tick(t, h, 60000)
        assert.equal(control.quotes.length, 1)
        assert.equal(workflow.getSnapshot().quote, null)
        const journal = JSON.stringify(h.storageWrites)
        await h.act(async () => workflow.prepareQuote())
        if (expiryState === 'hidden') {
          assert.equal(control.quotes.length, 1)
          assert.equal(workflow.getSnapshot().quoting, false)
          assert.equal(workflow.getSnapshot().errorCode, null)
          await h.act(async () => h.fire(h.createPage, 'show'))
          await h.flush()
          assert.equal(control.quotes.length, 1)
          await h.act(async () => workflow.prepareQuote())
        }
        assert.equal(control.quotes.length, 2)
        const quoteError = workflow.getSnapshot().error
        assert.equal(workflow.getSnapshot().errorAction, 'quote')
        assert.equal(workflow.getSnapshot().errorCode, 'CREDITS_INSUFFICIENT')
        control.disconnected = false
        if (expiryState === 'hidden') await h.act(async () => h.fire(h.createPage, 'show'))
        else await h.act(async () => workflow.refresh())
        await h.flush()
        assert.equal(workflow.getSnapshot().readRecovery.phase, 'ready')
        assert.equal(control.quotes.length, 2)
        assert.equal(workflow.getSnapshot().error, quoteError)
        assert.equal(workflow.getSnapshot().errorAction, 'quote')
        assert.equal(workflow.getSnapshot().errorCode, 'CREDITS_INSUFFICIENT')
        await h.act(async () => workflow.refresh())
        await tick(t, h, 100000)
        assert.equal(control.quotes.length, 2)
        assert.equal(workflow.getSnapshot().error, quoteError)
        await h.act(async () => workflow.retryError())
        assert.equal(control.quotes.length, 3)
        assert.equal(workflow.getSnapshot().controls.canGenerate, true)
        assert.equal(control.taskWrites, 0)
        assert.equal(JSON.stringify(h.storageWrites), journal)
      },
      { createApi: (args) => deferredQuoteApi(args, control) }
    )
  })
}
