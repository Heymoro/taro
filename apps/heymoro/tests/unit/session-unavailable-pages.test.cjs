const { test } = require('node:test')
const assert = require('node:assert/strict')
const { task } = require('../fixtures/creation.cjs')
const {
  pages,
  tick,
  gate,
  ordinary,
  frozen,
  frozenMap,
  clone
} = require('../fixtures/session-unavailable.cjs')

const timers = (t) =>
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
test('actual hook active poll stops at authoritative session GET, preserving cached rounds', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const workflow = h.controllers[0]
      assert.equal(workflow.shouldPoll(), true)
      const rounds = clone(workflow.getSnapshot().rounds)
      const start = h.calls.length
      h.control.missing = true
      await tick(t, h, 2000)
      assert.deepEqual(
        h.calls.slice(start).map((call) => call.name),
        ['account', 'getSession']
      )
      assert.deepEqual(clone(workflow.getSnapshot().rounds), rounds)
      assert.equal(workflow.shouldPoll(), false)
      await tick(t, h, 60000)
      assert.equal(h.calls.length, start + 2)
    },
    {
      api: {
        tasks: async () => ({
          items: [task({}, { artifactIds: [] })],
          hasMore: false,
          nextCursor: null
        }),
        task: async () => task({}, { artifactIds: [] })
      }
    }
  )
})
for (const route of [
  { session: '4' },
  { session: '4', source: '66' },
  { session: '4', carry: '66' },
  { session: '4', focusTask: '9' }
]) {
  test(`initial missing session consumes show demand and route tails ${JSON.stringify(
    route
  )}`, async (t) => {
    timers(t)
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await tick(t, h, 60000)
        for (let n = 0; n < 3; n++) {
          await h.act(async () => h.fire(h.createPage, 'hide'))
          await tick(t, h, 60000)
          await h.act(async () => h.fire(h.createPage, 'show'))
          await h.flush()
        }
        assert.deepEqual(
          h.calls.map((call) => call.name),
          ['account', 'getSession']
        )
        assert.equal(h.storage.writes.length, 0)
        assert.match(document.querySelector('#create').textContent, /原创作当前不可读取/)
        assert.doesNotMatch(
          document.querySelector('#create').textContent,
          /已有本机记录未改动|原请求结果待核对|另开草稿|新建会话/
        )
      },
      { route, control: { missing: true } }
    )
  })
}
test('DOM explicit recheck is same ID GET-only and double clicks join one flight', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const held = gate()
      h.control.missing = false
      h.control.gate = held
      const start = h.calls.length
      await h.act(async () => {
        h.click('create', '重新检查')
        h.click('create', '重新检查')
      })
      assert.equal(h.calls.slice(start).filter((c) => c.name === 'getSession').length, 1)
      await h.act(async () => held.resolve())
      assert.equal(h.controllers[0].getSnapshot().sessionAvailability.status, 'available')
      assert.deepEqual(
        h.wire.map((r) => [r.method, r.data]),
        [
          ['GET', undefined],
          ['GET', undefined]
        ]
      )
      assert.equal(h.storage.writes.length, 0)
    },
    { control: { missing: true } }
  )
})
for (const operation of ['generate', 'regenerate']) {
  test(`actual page ${operation} frozen request survives terminal polling without implicit writes`, async (t) => {
    timers(t)
    const record = frozen(operation)
    const saved = frozenMap(record)
    const before = clone([...saved])
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await tick(t, h, 60000)
        await h.act(async () => h.fire(h.createPage, 'show'))
        assert.deepEqual(
          h.calls.map((c) => c.name),
          ['account', 'getSession']
        )
        assert.deepEqual(clone([...saved]), before)
        assert.equal(h.storage.writes.length, 0)
        assert.match(document.querySelector('#create').textContent, /原请求结果待核对/)
      },
      { saved, control: { missing: true } }
    )
  })
}

test('same input recheck200 requires explicit fresh quote, then restores generation without wire metadata', async (t) => {
  timers(t)
  const record = ordinary()
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      const input = w.getSnapshot().description
      h.control.missing = false
      await h.act(async () => h.click('create', '重新检查'))
      assert.equal(w.getSnapshot().sessionAvailability.status, 'available')
      assert.equal(w.getSnapshot().description, input)
      assert.equal(
        h.calls.filter((c) => ['quote', 'putDraft', 'generate'].includes(c.name)).length,
        0
      )
      assert.equal(h.storage.writes.length, 0)
      assert.match(document.querySelector('#create').textContent, /重新获取报价/)
      assert.equal(w.getSnapshot().controls.canGenerate, false)
      await h.act(async () => h.click('create', '重新获取报价'))
      assert.equal(h.calls.filter((c) => c.name === 'quote').length, 1)
      const quoteCall = h.calls.find((c) => c.name === 'quote')
      assert.deepEqual(Object.keys(quoteCall.args[0]).sort(), ['input', 'sessionId'])
      assert.equal(w.getSnapshot().quote.terminalEpoch, 1)
      assert.equal(w.getSnapshot().controls.canGenerate, true)
      assert.doesNotMatch(
        document.querySelector('#create').textContent,
        /原会话已可读取|重新获取报价/
      )
      assert.equal(h.storage.writes.length, 0)
    },
    {
      saved: new Map([['session:4', record]]),
      control: { missing: true },
      api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) }
    }
  )
})
for (const seed of ['empty', 'unknown', 'throw', 'ordinary']) {
  test(`unavailable DOM makes no unverified durable claim for ${seed}`, async (t) => {
    timers(t)
    const saved =
      seed === 'empty' || seed === 'throw'
        ? new Map()
        : new Map([['session:4', seed === 'unknown' ? { unknown: true } : ordinary()]])
    await pages(
      async (h) => {
        if (seed === 'throw')
          h.storage.get = () => {
            throw Error('read unavailable')
          }
        await h.act(async () => h.render('create'))
        const text = document.querySelector('#create').textContent
        assert.match(text, /此次结果不代表原请求未受理或未扣费/)
        assert.doesNotMatch(text, /已保存成功|原请求结果待核对/)
        assert.doesNotMatch(text, /已有本机记录未改动/)
        assert.equal(h.storage.writes.length, 0)
      },
      { saved, control: { missing: true } }
    )
  })
}

test('fresh quote failure keeps original retry and credits action in one Notice', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      h.control.missing = false
      await h.act(async () => h.click('create', '重新检查'))
      await h.act(async () => h.click('create', '重新获取报价'))
      assert.equal(document.querySelectorAll('#create aside').length, 1)
      const buttons = [...document.querySelectorAll('#create button')].map((b) => b.textContent)
      assert.ok(buttons.includes('重试报价'))
      assert.ok(buttons.includes('查看积分'))
      assert.equal(h.controllers[0].getSnapshot().errorAction, 'quote')
      assert.equal(h.controllers[0].getSnapshot().controls.canGenerate, false)
    },
    {
      saved: new Map([['session:4', ordinary()]]),
      control: { missing: true },
      api: {
        tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
        quote: async () => {
          throw Object.assign(Error('CREDITS_INSUFFICIENT'), {
            code: 'CREDITS_INSUFFICIENT',
            isOutcomeUnknown: false
          })
        }
      }
    }
  )
})

for (const kind of ['runningTask-only', 'round-only']) {
  test(`real ${kind} poll stops across 60s hidden and repeated emits, resumes only after readable recheck`, async (t) => {
    timers(t)
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0]
        assert.equal(w.shouldPoll(), true)
        h.control.missing = true
        await tick(t, h, 2000)
        assert.equal(w.shouldPoll(), false)
        const calls = h.calls.length
        let emissions = 0
        const unsubscribe = w.subscribe(() => emissions++)
        await tick(t, h, 60000)
        assert.equal(emissions, 0, 'no terminal timer emits or zero-delay busy loop')
        for (let n = 0; n < 3; n++) {
          await h.act(async () => {
            h.fire(h.createPage, 'hide')
            h.fire(h.createPage, 'show')
          })
          await tick(t, h, 60000)
        }
        assert.equal(h.calls.length, calls)
        h.control.missing = false
        await h.act(async () => w.recheckSession())
        assert.equal(w.shouldPoll(), true)
        const start = h.calls.length
        await tick(t, h, 2000)
        assert.deepEqual(
          h.calls.slice(start, start + 2).map((c) => c.name),
          ['account', 'getSession']
        )
        unsubscribe()
      },
      {
        api: {
          getSession: async () => ({
            id: 4,
            title: 'old',
            titleSource: 'template',
            mode: 'free',
            templateId: 1,
            lastActivityAt: '2026-11-13T00:00:00Z',
            cover: null,
            runningTask:
              kind === 'runningTask-only' ? { id: 9, roundNo: 1, status: 'running' } : null,
            draft: {
              input: { description: '', userNotes: '', inputMediaIds: [] },
              updatedAt: '2026-11-13T00:00:00Z'
            }
          }),
          tasks: async () => ({
            items: kind === 'round-only' ? [task({}, { artifactIds: [] })] : [],
            hasMore: false,
            nextCursor: null
          }),
          task: async () => task({}, { artifactIds: [] })
        }
      }
    )
  })
}
for (const outcome of ['404', '200']) {
  for (const boundary of ['hide', 'account', 'unmount']) {
    test(`late real getSession ${outcome} after ${boundary} cannot affect old or new owner`, async (t) => {
      timers(t)
      await pages(
        async (h) => {
          await h.act(async () => h.render('create'))
          const old = h.controllers[0],
            held = gate()
          h.control.gate = held
          await h.act(async () => {
            old.refresh()
          })
          assert.equal(old.getSnapshot().readRecovery.phase, 'reading')
          h.control.gate = null
          await h.act(async () => {
            if (boundary === 'hide') h.fire(h.createPage, 'hide')
            if (boundary === 'account') {
              h.setKey('1:new-token:new-expiry')
              h.render('create')
            }
            if (boundary === 'unmount') h.unmountCreate()
          })
          const oldState = clone(old.getSnapshot()),
            latest = h.controllers.at(-1)
          const latestState = clone(latest.getSnapshot()),
            raw = clone([...h.storage.saved]),
            calls = h.calls.length
          const rawResponse =
            outcome === '404'
              ? require('../fixtures/session-unavailable.cjs').notFound()
              : require('../fixtures/session-unavailable.cjs').response(
                  await h.api.getSession({ sessionId: 4 })
                )
          const afterControlRead = h.calls.length
          // A cancelled hidden read may settle its existing runtime phase, never business facts.
          if (boundary === 'hide') {
            oldState.readRecovery.phase = 'idle'
            latestState.readRecovery.phase = 'idle'
          }
          await h.act(async () => held.resolve(rawResponse))
          await h.flush()
          assert.deepEqual(clone(old.getSnapshot()), oldState)
          assert.deepEqual(clone(latest.getSnapshot()), latestState)
          assert.deepEqual(clone([...h.storage.saved]), raw)
          assert.equal(h.calls.length, afterControlRead)
          assert.ok(afterControlRead - calls <= 1)
          assert.equal(h.storage.writes.length, 0)
        },
        { api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) } }
      )
    })
  }
}
test('StrictMode replacement and explicit remount each perform only their fresh live GET', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      assert.equal(h.controllers.length, 2)
      assert.equal(h.calls.filter((c) => c.name === 'getSession').length, 1)
      await h.act(async () => h.unmountCreate())
      h.control.missing = false
      await h.act(async () => h.render('create'))
      assert.equal(h.calls.filter((c) => c.name === 'getSession').length, 2)
      assert.equal(h.controllers.at(-1).getSnapshot().sessionAvailability.status, 'available')
      assert.equal(h.storage.writes.length, 0)
    },
    {
      strict: true,
      control: { missing: true },
      api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) }
    }
  )
})
test('unavailable configured=false context no longer promises disabled photo selection', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      assert.equal(h.controllers[0].getSnapshot().controls.canSelectPhotos, false)
      assert.doesNotMatch(document.querySelector('#create').textContent, /可以先选图和编辑/)
    },
    {
      control: { missing: true },
      api: { account: async () => ({ configured: false, available: 0, reserved: 0, sources: [] }) }
    }
  )
})

test('cached pre-terminal quote is retained byte-for-byte but never auto-renewed after recheck', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      await h.act(async () => {
        w.setDescription('old quote input')
        await w.prepareQuote()
      })
      const quote = w.getSnapshot().quote,
        raw = clone([...h.storage.saved])
      const writes = h.storage.writes.length
      h.control.missing = true
      await h.act(async () => w.refresh())
      assert.equal(w.getSnapshot().quote, quote)
      assert.equal(w.getSnapshot().controls.canGenerate, false)
      const quoteCount = h.calls.filter((c) => c.name === 'quote').length
      h.control.missing = false
      await h.act(async () => w.recheckSession())
      assert.equal(w.getSnapshot().quote, quote)
      await tick(t, h, 60000)
      assert.equal(h.calls.filter((c) => c.name === 'quote').length, quoteCount)
      assert.equal(w.getSnapshot().controls.canGenerate, false)
      assert.match(document.querySelector('#create').textContent, /重新获取报价/)
      assert.deepEqual(clone([...h.storage.saved]), raw)
      assert.equal(h.storage.writes.length, writes)
    },
    { api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) } }
  )
})
test('previously readable server-only source does not imply a durable local record', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      assert.equal(h.storage.saved.size, 0)
      h.control.missing = true
      await h.act(async () => h.controllers[0].refresh())
      const text = document.querySelector('#create').textContent
      assert.match(text, /原创作当前不可读取/)
      assert.doesNotMatch(text, /已有本机记录未改动|已保存成功|原请求结果待核对/)
      assert.equal(h.storage.saved.size, 0)
      assert.equal(h.storage.writes.length, 0)
    },
    { api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) } }
  )
})
test('legal sessionRequest Notice confirms original create instead of pretending to refresh a session', async (t) => {
  timers(t)
  const record = frozen('session'),
    requests = []
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      await h.act(async () => w.generate())
      assert.equal(requests.length, 1)
      await h.act(async () => h.click('create', '确认会话结果'))
      assert.equal(requests.length, 2)
      assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ templateId: record.sessionRequest.templateId, clientRequestId: record.sessionRequest.clientRequestId })))
      assert.equal(h.calls.filter((c) => c.name === 'getSession').length, 0)
      assert.equal(w.getSnapshot().sessionId, null)
      assert.equal(w.getSnapshot().sessionAvailability.status, 'unchecked')
    },
    {
      route: {},
      saved: frozenMap(record),
      api: {
        createSession: async (body) => {
          requests.push(clone(body))
          throw Object.assign(Error('pending'), { isOutcomeUnknown: true })
        }
      }
    }
  )
})

test('terminal page suppresses only parent history read controls, keeping cached artifact open and favorite', async (t) => {
  timers(t)
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      assert.match(document.querySelector('#create').textContent, /读取更早轮次/)
      assert.match(document.querySelector('#create').textContent, /重试定位/)
      const w = h.controllers[0],
        rounds = clone(w.getSnapshot().rounds),
        cursor = w.getSnapshot().olderCursor
      h.control.missing = true
      await h.act(async () => w.refresh())
      const text = document.querySelector('#create').textContent
      assert.doesNotMatch(text, /读取更早轮次|重试定位/)
      assert.match(text, /查看作品/)
      assert.deepEqual(clone(w.getSnapshot().rounds), rounds)
      assert.equal(w.getSnapshot().olderCursor, cursor)
      const start = h.calls.length
      await h.act(async () => h.click('create', '收藏'))
      assert.equal(h.calls.slice(start).filter((c) => c.name === 'favorite').length, 1)
      await h.act(async () => h.click('create', '查看作品'))
      assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=66&returnTo=opener'])
      await h.act(async () => h.render('detail'))
      assert.match(document.querySelector('#detail').textContent, /保存到相册/)
      assert.equal(w.getSnapshot().sessionAvailability.status, 'unavailable')
    },
    {
      route: { session: '4', focusTask: '9' },
      api: {
        tasks: async () => ({
          items: [task({}, { status: 'succeeded', artifactIds: [66] })],
          hasMore: true,
          nextCursor: 'earlier'
        }),
        task: async () => {
          throw Error('focus read failure')
        }
      }
    }
  )
})

test('production NavBar and paused remote draft expose no executable action while unavailable, restore after recheck', async (t) => {
  timers(t)
  const { productionNavBar } = require('../fixtures/session-unavailable.cjs')
  let modals = 0
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      const rename = () => document.querySelector('#create .navbar .icon-button:not(.navbar__back)')
      const resume = () =>
        [...document.querySelectorAll('#create button')].find(
          (button) => button.textContent === '恢复保存'
        )
      assert.ok(document.querySelector('#create .navbar'), 'actual production NavBar is rendered')
      assert.equal(
        Boolean(rename()),
        false,
        'unavailable page withholds the real production rename callback'
      )
      assert.equal(resume(), undefined, 'remote resume is not an enabled no-op')
      const text = document.querySelector('#create').textContent
      assert.match(text, /远端保存已暂停/)
      assert.doesNotMatch(text, /确认恢复后将保存当前输入/)
      const calls = h.calls.length,
        writes = h.storage.writes.length
      await h.act(async () => document.querySelector('#create .navbar__title').click())
      assert.equal(modals, 0)
      assert.equal(h.calls.length, calls)
      assert.equal(h.storage.writes.length, writes)
      h.control.missing = false
      await h.act(async () => w.recheckSession())
      assert.ok(rename())
      assert.equal(rename().disabled, false)
      assert.ok(resume())
      assert.equal(resume().disabled, false)
      assert.equal(
        h.storage.writes.length,
        writes,
        'read-only recheck itself does not resume saving'
      )
      await h.act(async () => rename().click())
      assert.equal(modals, 1)
      assert.equal(h.calls.filter((call) => call.name === 'rename').length, 1)
      await h.act(async () => resume().click())
      assert.equal(h.calls.filter((call) => call.name === 'putDraft').length, 1)
      assert.equal(w.getSnapshot().draftPaused, false)
    },
    {
      navBar: productionNavBar(),
      showModal: async () => {
        modals++
        return { confirm: true, content: 'updated title' }
      },
      saved: new Map([['session:4', ordinary({ draftPaused: true })]]),
      control: { missing: true },
      api: {
        tasks: async () => ({ items: [], hasMore: false, nextCursor: null }),
        rename: async ({ title }) => ({ title, titleSource: 'user' })
      }
    }
  )
})

test('unavailable paused page retains a real pure-local replay action while remote resume stays absent', async (t) => {
  timers(t)
  const { load } = require('../source.cjs')
  const record = ordinary({ draftPaused: true })
  const entry = {
    key: 'session:4',
    kind: 'session',
    mode: null,
    templateId: null,
    templateVersionId: null,
    sessionId: 4
  }
  const fingerprint = load(
    'src/features/creation/initial-input-intent.js'
  ).fingerprintInitialInputValue({ value: record }).value
  const journal = {
    protocol: 1,
    kind: 'ordinary-initial-input',
    entry,
    fields: ['description'],
    patch: { description: 'local replay text' },
    observed: [{ key: 'session:4', fingerprint }],
    prepared: null
  }
  const saved = new Map([
    ['session:4', record],
    ['initial-input:session:4', journal]
  ])
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const local = [...document.querySelectorAll('#create button')].find(
        (button) => button.textContent === '保存本机输入'
      )
      assert.ok(local, 'source-confirmed local replay is still rendered')
      assert.equal(local.disabled, false)
      assert.equal(
        [...document.querySelectorAll('#create button')].some(
          (button) => button.textContent === '恢复保存'
        ),
        false
      )
      const calls = h.calls.length
      await h.act(async () => local.click())
      assert.equal(saved.get('session:4').description, 'local replay text')
      assert.equal(saved.get('initial-input:session:4'), null)
      assert.equal(h.calls.length, calls)
      assert.equal(h.controllers[0].getSnapshot().sessionAvailability.status, 'unavailable')
      assert.ok(h.storage.writes.length > 0, 'the explicit local replay actually saved its target')
    },
    { saved, control: { missing: true } }
  )
})
