const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withCredits } = require('../fixtures/credits-pages.cjs')
const { workflowFixture, ready } = require('../fixtures/creation.cjs')
test('actual Me wallet card opens credits without altering existing wallet reads', async () =>
  withCredits(
    async (f) => {
      await f.mount('me')
      await f.act(async () => document.querySelector('.wallet-card').click())
      assert.equal(f.navigation[0]?.url, '/pages/credits/index')
      assert.match(f.text('me'), /可用积分.*2 点.*处理中占用.*3 点/)
    },
    { initial: 'me' }
  ))
test('known quote insufficiency is projected as a nonpersistent code and clears with error', async () => {
  const f = workflowFixture({
    api: {
      quote: async () => {
        throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT' })
      },
    },
  })
  await ready(f.workflow)
  assert.equal(f.workflow.getSnapshot().errorCode, 'CREDITS_INSUFFICIENT')
  f.workflow.setDescription('changed')
  assert.equal(f.workflow.getSnapshot().errorCode, null)
  for (const value of f.saved.values()) assert.equal(Object.hasOwn(value, 'errorCode'), false)
  f.workflow.dispose()
})
test('actual Create known insufficiency adds a second action without replacing retry or mutating input on visit', async () =>
  withCredits(
    async (f) => {
      await f.mount('create')
      assert.match(f.text('create'), /可用积分不足/)
      const input = document.querySelector('#create textarea').value
      const writes = f.calls.filter((c) => c.method !== 'GET').length
      await f.act(async () => f.click('create', '查看积分'))
      assert.equal(f.navigation[0]?.url, '/pages/credits/index')
      assert.equal(document.querySelector('#create textarea').value, input)
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes)
      assert.match(f.text('create'), /重试报价/)
    },
    { initial: 'create', quoteError: 'CREDITS_INSUFFICIENT' }
  ))

for (const isOutcomeUnknown of [false, true])
  test(`generation insufficiency projection is known-only: unknown=${isOutcomeUnknown}`, async () => {
    const f = workflowFixture({
      submit: async () => {
        throw Object.assign(Error('CREDITS_INSUFFICIENT'), { code: 'CREDITS_INSUFFICIENT', isOutcomeUnknown })
      },
    })
    await ready(f.workflow)
    const input = f.workflow.getSnapshot().description
    await f.workflow.generate()
    const state = f.workflow.getSnapshot()
    assert.equal(state.errorCode, isOutcomeUnknown ? null : 'CREDITS_INSUFFICIENT')
    assert.equal(state.description, input)
    assert.equal(Boolean(state.submission), isOutcomeUnknown)
    f.workflow.dispose()
  })
test('actual Create generic quote failure has no credits action', async () =>
  withCredits(
    async (f) => {
      await f.mount('create')
      assert.doesNotMatch(f.text('create'), /查看积分/)
      assert.equal(f.navigation.length, 0)
    },
    { initial: 'create', quoteError: 'INPUT_INVALID' }
  ))

test('actual insufficiency Notice groups its two existing actions without nesting buttons in text', async () =>
  withCredits(
    async (f) => {
      await f.mount('create')
      const actions = document.querySelector('.credits-notice-actions')
      assert.ok(actions)
      assert.equal(actions.querySelectorAll('button').length, 2)
      assert.equal(actions.parentElement.className, 'notice')
      assert.equal(actions.querySelectorAll('span button').length, 0)
    },
    { initial: 'create', quoteError: 'CREDITS_INSUFFICIENT' }
  ))

for (const name of ['me', 'create']) {
  test(`actual ${name} credits entry shows only its current owned pending intent without extra business IO`, async () => {
    await withCredits(
      async (f) => {
        await f.mount(name)
        const open = () =>
          name === 'me' ? document.querySelector('.wallet-card').click() : f.click('create', '查看积分')
        const writes = f.calls.filter((call) => call.method !== 'GET').length
        const input = name === 'create' ? document.querySelector('#create textarea').value : null
        await f.act(async () => open())
        assert.equal(f.navigation.length, 1)
        assert.match(f.text(name), /正在打开/)
        const reads = f.calls.length
        await f.act(async () => open())
        assert.equal(f.navigation.length, 1)
        assert.equal(f.calls.length, reads)
        await f.act(async () => f.fire(name, 'hide'))
        assert.doesNotMatch(f.text(name), /正在打开/)
        await f.act(async () => f.fire(name, 'show'))
        assert.doesNotMatch(f.text(name), /正在打开/)
        await f.act(async () => open())
        assert.equal(f.navigation.length, 1, 'hide/show does not release an unresolved native operation')
        await f.act(async () => f.navigation[0].fail())
        assert.doesNotMatch(f.text(name), /正在打开/)
        await f.act(async () => open())
        assert.equal(f.navigation.length, 2)
        assert.match(f.text(name), /正在打开/)
        await f.act(async () => f.navigation[1].success())
        await f.act(async () => {
          f.fire(name, 'hide')
          f.fire(name, 'show')
        })
        assert.doesNotMatch(f.text(name), /正在打开/)
        assert.equal(f.calls.filter((call) => call.method !== 'GET').length, writes)
        if (name === 'create') {
          assert.equal(document.querySelector('#create textarea').value, input)
          assert.match(f.text(name), /重试报价/)
        } else assert.match(f.text(name), /可用积分.*2 点.*处理中占用.*3 点/)
      },
      { initial: name, quoteError: 'CREDITS_INSUFFICIENT', navigate: () => undefined }
    )
  })
}

for (const name of ['me', 'create']) {
  for (const replacement of ['stack', 'token', 'expiresAt', 'userId'])
    test(`actual ${name} pending entry rejects stale ${replacement} ownership`, async () => {
      await withCredits(
        async (f) => {
          await f.mount(name)
          const open = () =>
            name === 'me' ? document.querySelector('.wallet-card').click() : f.click('create', '查看积分')
          await f.act(async () => open())
          assert.match(f.text(name), /正在打开/)
          await f.act(async () => {
            if (replacement === 'stack') f.setForeground('credits')
            else
              f.setCredential({
                ...f.getCredential(),
                [replacement]:
                  replacement === 'token'
                    ? 'B'.repeat(42) + 'A'
                    : replacement === 'expiresAt'
                    ? '2098-01-01T00:00:00.000Z'
                    : 2,
              })
            f.render(name)
          })
          assert.doesNotMatch(f.text(name), /正在打开/)
          await f.act(async () => f.navigation[0].fail())
          assert.equal(f.toasts.length, 0)
          assert.equal(f.navigation.length, 1)
          assert.doesNotMatch(f.text(name), /正在打开/)
        },
        { initial: name, quoteError: 'CREDITS_INSUFFICIENT', navigate: () => undefined }
      )
    })
  test(`actual ${name} known native failure clears only its entry feedback and permits explicit retry`, async () => {
    await withCredits(
      async (f) => {
        await f.mount(name)
        const open = () =>
          name === 'me' ? document.querySelector('.wallet-card').click() : f.click('create', '查看积分')
        await f.act(async () => open())
        assert.match(f.text(name), /正在打开/)
        await f.act(async () => f.navigation[0].fail())
        assert.doesNotMatch(f.text(name), /正在打开/)
        assert.equal(f.toasts.length, 1)
        await f.act(async () => open())
        assert.match(f.text(name), /正在打开/)
        assert.equal(f.navigation.length, 2)
        await f.act(async () => {
          f.navigation[0].fail()
          open()
        })
        assert.equal(f.navigation.length, 2)
      },
      { initial: name, quoteError: 'CREDITS_INSUFFICIENT', navigate: () => undefined }
    )
  })
}
