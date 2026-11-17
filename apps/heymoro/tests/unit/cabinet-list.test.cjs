const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { gate } = require('../fixtures/cabinet-pages.cjs')
const make = (args) => load('src/features/cabinet/cabinet-list.js').createCabinetList(args)
const page = (id, nextCursor = null, hasMore = false) => ({ items: id ? [{ id }] : [], nextCursor, hasMore })
const ids = (list) => Array.from(list.getSnapshot().items, (row) => row.id)
const snapshot = (list) => list.getSnapshot()

test('mount/show gate, initialized empty EOF, and repeated show issue one GET', async () => {
  let count = 0
  const list = make({
    read: async () => {
      count++
      return page()
    },
  })
  await Promise.all([list.start(), list.show()])
  await list.show()
  await list.start()
  assert.equal(count, 1)
  assert.equal(snapshot(list).loaded, true)
  assert.equal(snapshot(list).hasMore, false)
  list.dispose()
})
test('independent all/saved committed prefixes, page counts, positions and original frontier', async () => {
  const reads = []
  const list = make({
    read: async ({ cursor, saved }) => {
      reads.push([saved, cursor])
      const n = cursor ? Number(cursor) : 1
      return page((saved ? 100 : 0) + n, String(n + 1), true)
    },
  })
  await list.start()
  await list.load()
  list.setPosition({ position: { scrollTop: 80 } })
  await list.select({ saved: true })
  await list.load()
  list.setPosition({ position: { scrollTop: 120 } })
  const count = reads.length
  await list.select({ saved: false })
  assert.deepEqual(ids(list), [1, 2])
  assert.equal(snapshot(list).position.scrollTop, 80)
  await list.select({ saved: true })
  assert.deepEqual(ids(list), [101, 102])
  assert.equal(snapshot(list).position.scrollTop, 120)
  assert.equal(reads.length, count)
  await list.load()
  assert.deepEqual(reads.at(-1), [true, '3'])
  assert.equal(snapshot(list).pages, 3)
  list.dispose()
})
test('dirty N-page candidate publishes atomically with new cursors and accumulates warning across empty scan pages', async () => {
  let version = 0
  const reads = []
  const blocked = gate()
  const list = make({
    read: async ({ cursor, onWarning }) => {
      reads.push(cursor)
      const n = cursor ? Number(cursor.split(':')[1]) : 1
      if (version && n === 2) await blocked.promise
      if (version && n === 1) onWarning('unknown observation')
      return page(n === 2 ? null : version * 10 + n, `v${version}:${n + 1}`, true)
    },
  })
  await list.start()
  await list.load()
  await list.load()
  list.setPosition({ position: { scrollTop: 200 } })
  list.hide()
  version = 1
  const updating = list.show()
  await Promise.resolve()
  assert.deepEqual(ids(list), [1, 3])
  assert.equal(snapshot(list).dirty, true)
  assert.equal(snapshot(list).position.scrollTop, 200)
  const before = reads.length
  await list.load()
  assert.equal(reads.length, before, 'cannot use stale committed cursor')
  blocked.resolve()
  await updating
  assert.deepEqual(ids(list), [11, 13])
  assert.equal(snapshot(list).pages, 3)
  assert.deepEqual(reads.slice(3), [undefined, 'v1:2', 'v1:3'])
  assert.equal(snapshot(list).warning, 'unknown observation')
  assert.equal(snapshot(list).dirty, false)
  await list.load()
  assert.equal(reads.at(-1), 'v1:4')
  list.dispose()
})
test('candidate failure keeps prefix and position, same-intent retry resumes failed fresh page; new hide restarts null', async () => {
  let version = 0,
    fail = false
  const reads = []
  const list = make({
    read: async ({ cursor }) => {
      reads.push(cursor)
      const n = cursor ? Number(cursor.split(':')[1]) : 1
      if (version && n === 2 && fail) throw Error('NETWORK')
      return page(version * 10 + n, `v${version}:${n + 1}`, true)
    },
  })
  await list.start()
  await list.load()
  await list.load()
  list.setPosition({ position: { scrollTop: 40 } })
  version = 1
  fail = true
  list.hide()
  await list.show()
  assert.deepEqual(ids(list), [1, 2, 3])
  assert.ok(snapshot(list).error)
  assert.equal(snapshot(list).position.scrollTop, 40)
  fail = false
  await list.load()
  assert.deepEqual(reads.slice(3), [undefined, 'v1:2', 'v1:2', 'v1:3'])
  fail = true
  list.hide()
  await list.show()
  list.hide()
  fail = false
  const before = reads.length
  await list.show()
  assert.equal(reads[before], undefined)
  list.dispose()
})
test('EOF ends validation early, including legal empty scanning pages', async () => {
  let fresh = false,
    count = 0
  const list = make({
    read: async ({ cursor }) => {
      count++
      if (fresh) return cursor ? page() : page(null, 'empty-scan', true)
      const n = cursor ? Number(cursor) : 1
      return page(n, String(n + 1), true)
    },
  })
  await list.start()
  await list.load()
  await list.load()
  await list.load()
  list.hide()
  fresh = true
  await list.show()
  assert.equal(count, 6)
  assert.equal(snapshot(list).pages, 2)
  assert.equal(snapshot(list).loaded, true)
  assert.equal(snapshot(list).hasMore, false)
  assert.deepEqual(ids(list), [])
  list.dispose()
})
test('repeated or regressive cursors fail without losing committed prefix or spinning', async () => {
  let corrupt = false,
    count = 0
  const list = make({
    read: async ({ cursor }) => {
      count++
      if (corrupt) return page(10, 'loop', true)
      return cursor ? page(2, 'last', true) : page(1, 'next', true)
    },
  })
  await list.start()
  await list.load()
  corrupt = true
  list.hide()
  await list.show()
  assert.deepEqual(ids(list), [1, 2])
  assert.equal(snapshot(list).dirty, true)
  assert.ok(snapshot(list).error)
  assert.equal(count, 4)
  list.dispose()
})
test('automatic validation pauses at 20 fresh pages and explicit continuation preserves frontier for >20 history', async () => {
  let version = 0
  const reads = []
  const list = make({
    read: async ({ cursor }) => {
      const n = cursor ? Number(cursor.split(':')[1]) : 1
      reads.push(cursor)
      return page(version * 100 + n, `v${version}:${n + 1}`, true)
    },
  })
  await list.start()
  for (let i = 1; i < 45; i++) await list.load()
  assert.equal(snapshot(list).pages, 45)
  version = 1
  list.hide()
  await list.show()
  assert.equal(reads.length, 65)
  assert.equal(snapshot(list).paused, true)
  assert.equal(snapshot(list).dirty, true)
  assert.equal(snapshot(list).items[0].id, 1)
  await list.load()
  assert.equal(reads.length, 65, 'late lower-threshold event must not resume paused validation')
  await list.continueUpdating()
  assert.equal(reads[65], 'v1:21')
  assert.equal(reads.length, 85)
  assert.equal(snapshot(list).paused, true)
  await list.continueUpdating()
  assert.equal(snapshot(list).pages, 45)
  assert.equal(snapshot(list).dirty, false)
  assert.equal(snapshot(list).items[0].id, 101)
  list.dispose()
})
test('hide/new-view/new-owner rejects late rows, warning and old finally without unlocking new flight', async () => {
  const requests = []
  let owner = true
  const list = make({
    isCurrent: () => owner,
    read: (args) => {
      const pending = gate()
      requests.push({ ...args, ...pending })
      return pending.promise
    },
  })
  const initial = list.start()
  list.hide()
  const next = list.show()
  assert.equal(requests[0].isInterested(), false)
  requests[0].onWarning('late warning')
  requests[0].resolve(page(1))
  await initial
  assert.equal(snapshot(list).loading, true)
  await list.load()
  assert.equal(requests.length, 2)
  requests[1].resolve(page(2))
  await next
  assert.deepEqual(ids(list), [2])
  assert.equal(snapshot(list).warning, '')
  const old = list.refresh()
  const switched = list.select({ saved: true })
  requests[2].resolve(page(3))
  await old
  assert.equal(snapshot(list).loading, true)
  owner = false
  requests[3].onWarning('wrong owner')
  requests[3].resolve(page(4))
  await switched
  assert.deepEqual(ids(list), [])
  assert.equal(snapshot(list).warning, '')
  list.dispose()
  assert.equal(requests[3].isInterested(), false)
})
test('hide dirties both views but show validates only selected; fresh continuation failure retains pages', async () => {
  const reads = []
  let fail = false
  const list = make({
    read: async ({ saved, cursor }) => {
      reads.push([saved, cursor])
      if (fail) throw Error('FAVORITE_PENDING')
      return page(saved ? 2 : 1, 'next', true)
    },
  })
  await list.start()
  await list.select({ saved: true })
  list.hide()
  await list.show()
  assert.deepEqual(
    reads.map(([saved]) => saved),
    [false, true, true]
  )
  await list.select({ saved: false })
  assert.equal(reads.length, 4)
  fail = true
  await list.load()
  assert.deepEqual(ids(list), [1])
  assert.equal(snapshot(list).pages, 1)
  assert.match(snapshot(list).error, /仍待核对/)
  list.dispose()
})

test('switch during committed continuation freezes old prefix and late finally cannot release replacement view flight', async () => {
  const requests = []
  const list = make({
    read: (args) => {
      const pending = gate()
      requests.push({ ...args, ...pending })
      return pending.promise
    },
  })
  const first = list.start()
  requests[0].resolve(page(1, 'old:2', true))
  await first
  const older = list.load()
  const saved = list.select({ saved: true })
  assert.equal(requests[1].isInterested(), false)
  requests[1].onWarning('late older')
  requests[1].resolve(page(2, 'old:3', true))
  await older
  assert.equal(snapshot(list).loading, true)
  await list.load()
  assert.equal(requests.length, 3)
  requests[2].resolve(page(100))
  await saved
  const all = list.select({ saved: false })
  assert.deepEqual(ids(list), [1])
  assert.equal(requests[3].cursor, undefined)
  requests[3].resolve(page(11, 'fresh:2', true))
  await all
  assert.deepEqual(ids(list), [11])
  assert.equal(snapshot(list).warning, '')
  list.dispose()
})
test('regressive cursor back to earlier frontier fails after three distinct fresh pages without losing prefix', async () => {
  let fresh = false
  const reads = []
  const list = make({
    read: async ({ cursor }) => {
      reads.push(cursor)
      const n = cursor ? Number(cursor.slice(1)) : 1
      return page(n, fresh && n === 3 ? 'c2' : `c${n + 1}`, true)
    },
  })
  await list.start()
  await list.load()
  await list.load()
  list.hide()
  fresh = true
  await list.show()
  assert.deepEqual(ids(list), [1, 2, 3])
  assert.equal(snapshot(list).dirty, true)
  assert.match(snapshot(list).error, /分页位置异常/)
  assert.equal(reads.length, 6)
  list.dispose()
})

test('synchronous hide during loading subscription cancels before native read without a rejected continuation', async () => {
  let reads = 0
  const list = make({
    read: async () => {
      reads++
      return page(1)
    },
  })
  const unsubscribe = list.subscribe(() => {
    if (snapshot(list).loading) list.hide()
  })
  await assert.doesNotReject(async () => list.start())
  assert.equal(reads, 0)
  unsubscribe()
  await list.show()
  assert.deepEqual(ids(list), [1])
  list.dispose()
})

test('warning composition forwards the shared cursor callback as well as retaining prefix-wide uncertainty', async () => {
  const real = load('src/cursor-list.js')
  const forwarded = []
  const { createCabinetList } = load('src/features/cabinet/cabinet-list.js', {
    '../../cursor-list': {
      createCursorList: (options) =>
        real.createCursorList({
          ...options,
          read: (args) =>
            options.read({
              ...args,
              onWarning: (value) => {
                forwarded.push(value)
                args.onWarning(value)
              },
            }),
        }),
    },
  })
  const list = createCabinetList({
    read: async ({ onWarning }) => {
      onWarning('server observation')
      return page(1)
    },
  })
  await list.start()
  assert.deepEqual(forwarded, ['server observation'])
  assert.equal(snapshot(list).warning, 'server observation')
  list.dispose()
})
