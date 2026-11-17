const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const make = (options) => load('src/retained-cursor-list.js').createRetainedCursorList(options)
test('retained prefix accepts reservation identity and preserves old rows until fresh EOF commits', async () => {
  let version = 0
  const list = make({
    identity: (row) => row.reservationId,
    read: async ({ cursor }) => ({
      items: [{ reservationId: version * 10 + (cursor ? 2 : 1) }],
      hasMore: !cursor,
      nextCursor: cursor ? null : 'next',
    }),
  })
  await list.start()
  await list.load()
  assert.deepEqual(
    Array.from(list.getSnapshot().items, (row) => row.reservationId),
    [1, 2]
  )
  version = 1
  list.hide()
  await list.show()
  assert.deepEqual(
    Array.from(list.getSnapshot().items, (row) => row.reservationId),
    [11, 12]
  )
  assert.equal(list.getSnapshot().pages, 2)
  list.dispose()
})

const gate = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
test('retained fresh failure keeps old N pages and retries only its failed new cursor', async () => {
  let fresh = false,
    fail = true
  const reads = []
  const list = make({
    read: async ({ cursor, onWarning }) => {
      reads.push(cursor)
      const n = cursor ? Number(cursor) : 1
      if (fresh && n === 2 && fail) throw Error('offline')
      if (fresh && n === 1) onWarning('review')
      return {
        items: n === 2 ? [] : [{ id: fresh ? n + 10 : n }],
        nextCursor: n < 3 ? String(n + 1) : null,
        hasMore: n < 3,
      }
    },
  })
  await list.start()
  await list.load()
  await list.load()
  list.hide()
  fresh = true
  await list.show()
  assert.deepEqual(
    Array.from(list.getSnapshot().items, (r) => r.id),
    [1, 3]
  )
  assert.equal(list.getSnapshot().pages, 3)
  assert.ok(list.getSnapshot().error)
  fail = false
  await list.load()
  assert.deepEqual(reads.slice(-2), ['2', '3'])
  assert.deepEqual(
    Array.from(list.getSnapshot().items, (r) => r.id),
    [11, 13]
  )
  assert.equal(list.getSnapshot().warning, 'review')
  list.dispose()
})
test('retained max20 fresh pages pauses and lower-style load cannot advance until explicit continue', async () => {
  let reads = 0
  const list = make({
    read: async ({ cursor }) => {
      reads++
      const n = cursor ? Number(cursor) : 1
      return { items: [{ id: n }], nextCursor: String(n + 1), hasMore: true }
    },
  })
  await list.start()
  for (let i = 0; i < 23; i++) await list.load()
  list.hide()
  const before = reads
  await list.show()
  assert.equal(reads - before, 20)
  assert.equal(list.getSnapshot().paused, true)
  assert.equal(list.getSnapshot().pages, 24)
  await list.load()
  assert.equal(reads - before, 20)
  await list.continueUpdating()
  assert.equal(reads - before, 24)
  assert.equal(list.getSnapshot().paused, false)
  list.dispose()
})
test('retained late request/warning/finally cannot replace or unlock a newer flight', async () => {
  const requests = []
  const list = make({
    read: (args) => {
      const pending = gate()
      requests.push({ ...args, ...pending })
      return pending.promise
    },
  })
  const old = list.start()
  list.hide()
  const fresh = list.show()
  requests[0].onWarning('late')
  requests[0].resolve({ items: [{ id: 1 }], hasMore: false, nextCursor: null })
  await old
  assert.equal(list.getSnapshot().loading, true)
  await list.load()
  assert.equal(requests.length, 2)
  requests[1].resolve({ items: [{ id: 2 }], hasMore: false, nextCursor: null })
  await fresh
  assert.deepEqual(
    Array.from(list.getSnapshot().items, (r) => r.id),
    [2]
  )
  assert.equal(list.getSnapshot().warning, '')
  list.dispose()
})
test('Cabinet selected-view emit may reenter selection and hidden selection performs no read', async () => {
  const reads = []
  const list = load('src/features/cabinet/cabinet-list.js').createCabinetList({
    read: async (args) => {
      reads.push(args.saved)
      return { items: [], nextCursor: null, hasMore: false }
    },
  })
  let switched = false
  list.subscribe(() => {
    if (list.getSnapshot().loading && !switched) {
      switched = true
      list.select({ saved: true })
    }
  })
  await list.start()
  await Promise.resolve()
  assert.deepEqual(reads, [true])
  list.hide()
  await list.select({ saved: false })
  assert.equal(reads.length, 1)
  await list.show()
  assert.equal(reads.length, 2)
  list.dispose()
})

test('retained prefix exposes no geometric position owner or mutation API', () => {
  const list = make({ read: async () => ({ items: [], nextCursor: null, hasMore: false }) })
  assert.equal(Object.hasOwn(list.getSnapshot(), 'position'), false)
  assert.equal(typeof list.setPosition, 'undefined')
  list.dispose()
})
