const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withCredits, ledger } = require('../fixtures/credits-pages.cjs')
test('actual ledger preserves numeric top and measured anchor across fresh GET without fixed row heights', async () =>
  withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '明细'))
      await f.act(async () => f.click('credits', '继续读取'))
      await f.flush()
      await f.act(async () => f.scroll(83))
      await f.act(async () => f.click('credits', '余额'))
      await f.flush()
      await f.act(async () => f.click('credits', '明细'))
      await f.flush()
      assert.equal(f.handler().scrollTop, 83)
      await f.act(async () => f.fire('credits', 'hide'))
      f.setRows([ledger(2), ledger(3)])
      await f.act(async () => f.fire('credits', 'show'))
      await f.flush()
      assert.ok(Number.isFinite(f.handler().scrollTop))
      assert.equal(document.querySelectorAll('.credits-ledger-row').length, 2)
    },
    { ledger: [ledger(1), ledger(2), ledger(3), ledger(4)] }
  ))

for (const cancel of ['touch', 'stack', 'hide', 'unmount', 'account'])
  test(`late native pre-navigation query is inert after ${cancel}`, async () => {
    const { gate } = require('../fixtures/credits-pages.cjs')
    const pending = gate()
    await withCredits(
      async (f) => {
        await f.mount('credit-reservations')
        await f.act(async () => document.querySelector('.credits-reservation').click())
        await f.act(async () => {
          if (cancel === 'touch') f.handler('credit-reservations').onTouchStart()
          if (cancel === 'stack') f.setForeground('credits')
          if (cancel === 'hide') f.fire('credit-reservations', 'hide')
          if (cancel === 'unmount') f.unmount('credit-reservations')
          if (cancel === 'account') {
            f.setCredential({ ...f.getCredential(), token: 'B'.repeat(42) + 'A' })
            f.render('credit-reservations')
          }
          pending.resolve()
        })
        await f.flush()
        assert.equal(f.navigation.length, 0)
        assert.equal(f.toasts.length, 0)
      },
      { initial: 'credit-reservations', geometryGate: pending }
    )
  })
test('native geometry missing callback falls back to numeric capture and still opens the clicked task', async () =>
  withCredits(
    async (f) => {
      await f.mount('credit-reservations')
      await f.act(async () => {
        document.querySelector('.credits-reservation').click()
        await new Promise((r) => setTimeout(r, 150))
      })
      assert.equal(f.navigation.length, 1)
      assert.equal(f.navigation[0].url, '/pages/create/index?session=4&focusTask=9')
    },
    { initial: 'credit-reservations', queryNever: true }
  ))
test('late previous-view onScroll never overwrites the newly selected tab top', async () =>
  withCredits(async (f) => {
    await f.mount()
    await f.act(async () => f.click('credits', '明细'))
    const old = f.handler()
    await f.act(async () => f.scroll(33))
    await f.act(async () => f.click('credits', '余额'))
    await f.flush()
    await f.act(async () => old.onScroll({ detail: { scrollTop: 999 } }))
    assert.equal(f.handler().scrollTop, 0)
  }))

test('fresh prefix restores surviving anchor measured offset, then neighbor and bounded numeric fallback', async () =>
  withCredits(
    async (f) => {
      await f.mount()
      await f.act(async () => f.click('credits', '明细'))
      await f.act(async () => f.click('credits', '继续读取'))
      await f.flush()
      await f.act(async () => f.scroll(166))
      await f.act(async () => f.click('credits', '余额'))
      await f.act(async () => f.click('credits', '明细'))
      await f.flush()
      assert.equal(f.handler().scrollTop, 166)
      // Capture the current anchor before visiting its task. Removing earlier rows
      // shifts its real native coordinate, not an assumed row-height multiple.
      await f.act(async () => document.querySelectorAll('.credits-ledger-row')[2].click())
      await f.act(async () => f.fire('credits', 'hide'))
      f.setRows([ledger(2), ledger(3), ledger(4)])
      await f.act(async () => f.fire('credits', 'show'))
      await f.flush()
      assert.equal(f.handler().scrollTop, 83)
      await f.act(async () => document.querySelectorAll('.credits-ledger-row')[1].click())
      await f.act(async () => f.fire('credits', 'hide'))
      f.setRows([ledger(2), ledger(4)])
      await f.act(async () => f.fire('credits', 'show'))
      await f.flush()
      assert.equal(f.handler().scrollTop, 16)
      await f.act(async () => document.querySelector('.credits-ledger-row').click())
      await f.act(async () => f.fire('credits', 'hide'))
      f.setRows([])
      await f.act(async () => f.fire('credits', 'show'))
      await f.flush()
      assert.equal(f.handler().scrollTop, 0)
    },
    { ledger: [ledger(1), ledger(2), ledger(3), ledger(4)] }
  ))

test('late same-view previous-revision scroll cannot overwrite a freshly restored credit prefix', async () =>
  withCredits(async (f) => {
    await f.mount()
    await f.act(async () => f.click('credits', '明细'))
    await f.flush()
    const old = f.handler()
    await f.act(async () => f.fire('credits', 'hide'))
    f.setRows([ledger(2)])
    await f.act(async () => f.fire('credits', 'show'))
    await f.flush()
    const top = f.handler().scrollTop
    await f.act(async () => old.onScroll({ detail: { scrollTop: 999 } }))
    assert.equal(f.handler().scrollTop, top)
    await f.act(async () => f.handler().onScroll({ detail: { scrollTop: 23 } }))
    assert.equal(f.handler().scrollTop, 23, 'the current revision still accepts a real manual scroll')
  }))

for (const event of ['onTouchStart', 'onTouchMove'])
  test(`late previous-revision ${event} cannot cancel current credit restoration`, async () =>
    withCredits(
      async (f) => {
        await f.mount()
        await f.act(async () => f.click('credits', '明细'))
        await f.act(async () => f.click('credits', '继续读取'))
        await f.flush()
        await f.act(async () => f.scroll(166))
        await f.act(async () => document.querySelectorAll('.credits-ledger-row')[2].click())
        const old = f.handler()
        await f.act(async () => f.fire('credits', 'hide'))
        f.setRows([ledger(2), ledger(3), ledger(4)])
        await f.act(async () => f.fire('credits', 'show'))
        await f.act(async () => old[event]())
        await f.flush()
        assert.equal(f.handler().scrollTop, 83, 'old touch is not a new user intent against the new prefix')
        await f.act(async () => f.handler().onScroll({ detail: { scrollTop: 44 } }))
        assert.equal(f.handler().scrollTop, 44)
      },
      { ledger: [ledger(1), ledger(2), ledger(3), ledger(4)] }
    ))

for (const intent of ['programmatic', 'manual', 'onTouchStart', 'onTouchMove'])
  test(`current credit revision ${intent} keeps the correct restoration priority`, async () =>
    withCredits(
      async (f) => {
        await f.mount()
        await f.act(async () => f.click('credits', '明细'))
        await f.act(async () => f.click('credits', '继续读取'))
        await f.flush()
        await f.act(async () => f.scroll(166))
        await f.act(async () => document.querySelectorAll('.credits-ledger-row')[2].click())
        await f.act(async () => f.fire('credits', 'hide'))
        f.setRows([ledger(2), ledger(3), ledger(4)])
        await f.act(async () => f.fire('credits', 'show'))
        await f.act(async () => {
          if (intent.startsWith('onTouch')) f.handler()[intent]()
          else f.handler().onScroll({ detail: { scrollTop: intent === 'programmatic' ? 166 : 44 } })
        })
        await f.flush()
        assert.equal(f.handler().scrollTop, intent === 'programmatic' ? 83 : intent === 'manual' ? 44 : 166)
      },
      { ledger: [ledger(1), ledger(2), ledger(3), ledger(4)] }
    ))
