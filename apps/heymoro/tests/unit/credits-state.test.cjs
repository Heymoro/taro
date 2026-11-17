const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const make = () => load('src/features/credits/credits-state.js')
const page = (items = [], nextCursor = null) => ({ items, nextCursor, hasMore: !!nextCursor })
test('wallet account is separate truth and ledger is lazy with independent positions and fresh return prefix', async () => {
  let accounts = 0,
    reads = 0
  const state = make().createCreditWallet({
    readAccount: async () => ({ available: ++accounts, reserved: 9 }),
    readLedger: async ({ cursor }) => {
      reads++
      return page([{ id: cursor ? 2 : 1 }], cursor ? null : 'next')
    },
  })
  await Promise.all([state.start(), state.show()])
  assert.equal(accounts, 1)
  assert.equal(reads, 0)
  state.setPosition({ position: { scrollTop: 40 } })
  await state.select({ tab: 'ledger' })
  await state.load()
  assert.equal(reads, 2)
  state.setPosition({ position: { scrollTop: 90 } })
  await state.select({ tab: 'balance' })
  assert.equal(state.getSnapshot().position.scrollTop, 40)
  await state.select({ tab: 'ledger' })
  assert.equal(reads, 2)
  assert.equal(state.getSnapshot().position.scrollTop, 90)
  state.hide()
  await state.show()
  assert.equal(accounts, 2)
  assert.equal(reads, 4)
  state.dispose()
})
test('hidden unread ledger remains lazy and settled reservation disappears only on new GET', async () => {
  let rows = [{ reservationId: 1 }, { reservationId: 2 }],
    reads = 0
  const state = make().createCreditReservations({
    read: async () => {
      reads++
      return page(rows)
    },
  })
  await state.start()
  rows = []
  assert.equal(state.getSnapshot().items.length, 2)
  state.hide()
  await state.show()
  assert.equal(state.getSnapshot().items.length, 0)
  assert.equal(reads, 2)
  state.dispose()
  let ledger = 0
  const wallet = make().createCreditWallet({
    readAccount: async () => ({ available: 0, reserved: 0 }),
    readLedger: async () => {
      ledger++
      return page()
    },
  })
  await wallet.start()
  wallet.hide()
  await wallet.show()
  assert.equal(ledger, 0)
  wallet.dispose()
})

test('known initial ledger failure is explicit retry only, including tab switches', async () => {
  let reads = 0
  const wallet = make().createCreditWallet({
    readAccount: async () => ({ available: 0, reserved: 0 }),
    readLedger: async () => {
      reads++
      throw Error('offline')
    },
  })
  await wallet.start()
  await wallet.select({ tab: 'ledger' })
  assert.equal(reads, 1)
  await wallet.select({ tab: 'balance' })
  await wallet.select({ tab: 'ledger' })
  assert.equal(reads, 1)
  await wallet.load()
  assert.equal(reads, 2)
  wallet.dispose()
})
