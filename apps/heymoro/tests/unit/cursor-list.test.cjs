const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

test('cursor follows empty pages and deduplicates stable identities', async () => {
  const { createCursorList } = load('src/cursor-list.js')
  const sent = []
  const list = createCursorList({
    read: async (args) => {
      sent.push(args)
      return args.cursor
        ? { items: [{ id: 1 }], nextCursor: null, hasMore: false }
        : { items: [], nextCursor: 'next', hasMore: true }
    }
  })
  await list.load()
  assert.equal(list.getSnapshot().hasMore, true)
  await list.load()
  assert.equal(sent[1].cursor, 'next')
  assert.equal(list.getSnapshot().items.length, 1)
})
test('reset rejects late rows and old finally does not release new flight', async () => {
  const { createCursorList } = load('src/cursor-list.js')
  const pending = []
  const list = createCursorList({ read: (args) => new Promise((resolve) => pending.push({ args, resolve })) })
  const old = list.load()
  list.reset({ saved: true })
  const next = list.load()
  pending[0].resolve({ items: [{ id: 1 }], nextCursor: null, hasMore: false })
  await old
  assert.equal(list.getSnapshot().loading, true)
  assert.equal(list.getSnapshot().items.length, 0)
  await list.load()
  assert.equal(pending.length, 2)
  pending[1].resolve({ items: [{ id: 2 }], nextCursor: null, hasMore: false })
  await next
  assert.equal(list.getSnapshot().items[0].id, 2)
})

test('cursor read publishes local warning only with its current controller generation', async () => {
  const { createCursorList } = load('src/cursor-list.js')
  const pending = []
  const list = createCursorList({ read: (args) => new Promise((resolve) => pending.push({ args, resolve })) })
  const old = list.load()
  assert.equal(pending[0].args.isInterested(), true)
  pending[0].args.onWarning('controlled warning')
  list.reset({ saved: true })
  assert.equal(pending[0].args.isInterested(), false)
  const next = list.load()
  pending[0].resolve({ items: [{ id: 1 }], nextCursor: null, hasMore: false }); await old
  assert.equal(list.getSnapshot().warning, '')
  pending[1].args.onWarning('current warning')
  pending[1].resolve({ items: [], nextCursor: null, hasMore: false }); await next
  assert.equal(list.getSnapshot().warning, 'current warning')
  assert.equal(list.getSnapshot().loaded, true)
  assert.equal(list.getSnapshot().items.length, 0)
  list.dispose(); assert.equal(pending[1].args.isInterested(), false)
})
test('cursor external visibility/owner interest stops late warning and rows', async () => {
  const { createCursorList } = load('src/cursor-list.js')
  let interested = true, finish, context
  const list = createCursorList({ isInterested: () => interested, read: (args) => {
    context = args; return new Promise((resolve) => { finish = resolve })
  } })
  const result = list.load(); interested = false
  assert.equal(context.isInterested(), false)
  context.onWarning('late warning'); finish({ items: [{ id: 1 }], nextCursor: null, hasMore: false })
  await result; assert.equal(list.getSnapshot().warning, ''); assert.deepEqual(Array.from(list.getSnapshot().items), [])
  assert.equal(list.getSnapshot().loading, false)
})
