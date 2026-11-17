const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const make = (options) => load('src/features/credits/task-link.js').createCreditNavigation(options)
const gate = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
test('task navigation reads only on click and checks every reservation binding', async () => {
  let reads = 0,
    routes = []
  const nav = make({
    readTask: async () => {
      reads++
      return { id: 2, sessionId: 3, roundNo: 4, status: 'closed' }
    },
    navigate: (o) => {
      routes.push(o.url)
      o.success()
    },
    feedback: () => {},
  })
  assert.equal(reads, 0)
  await nav.openLedger({ entry: { taskId: null } })
  assert.equal(reads, 0)
  await nav.openReservation({ reservation: { taskId: 2, sessionId: 99, roundNo: 4 } })
  assert.equal(routes.length, 0)
  await nav.openReservation({ reservation: { taskId: 2, sessionId: 3, roundNo: 4 } })
  assert.deepEqual(routes, ['/pages/create/index?session=3&focusTask=2'])
  await nav.openCredits()
  assert.equal(routes.length, 1)
  nav.hide()
  nav.show()
  await nav.openCredits()
  assert.equal(routes[1], '/pages/credits/index')
})
test('read cancellation is allowed before dispatch; unknown native pending survives touch and hide/show', async () => {
  const read = gate()
  let calls = []
  const nav = make({ readTask: () => read.promise, navigate: (o) => calls.push(o), feedback: () => {} })
  const pending = nav.openLedger({ entry: { taskId: 2 } })
  nav.cancel()
  read.resolve({ id: 2, sessionId: 3, roundNo: 1 })
  await pending
  assert.equal(calls.length, 0)
  await nav.openCredits()
  nav.cancel()
  nav.hide()
  nav.show()
  await nav.openCredits()
  assert.equal(calls.length, 1)
  calls[0].success()
  await nav.openCredits()
  assert.equal(calls.length, 2)
})
test('first callback or Promise settlement wins; native rejection and feedback rejection are consumed', async () => {
  let calls = [],
    feedback = 0
  const nav = make({
    readTask: async () => ({ id: 2, sessionId: 3, roundNo: 1 }),
    navigate: (o) => {
      calls.push(o)
      o.fail()
      return Promise.reject(Error('late'))
    },
    feedback: () => {
      feedback++
      return Promise.reject(Error('toast'))
    },
  })
  await nav.openCredits()
  await Promise.resolve()
  assert.equal(feedback, 1)
  await nav.openCredits()
  calls[0].fail()
  assert.equal(calls.length, 2)
  assert.equal(feedback, 2)
})

for (const field of ['id', 'sessionId', 'roundNo'])
  test(`reservation ${field} mismatch prevents dispatch`, async () => {
    let routes = 0,
      feedback = 0
    const nav = make({
      readTask: async () => ({ id: 2, sessionId: 3, roundNo: 4, [field]: 99 }),
      navigate: () => routes++,
      feedback: () => feedback++,
    })
    await nav.openReservation({ reservation: { taskId: 2, sessionId: 3, roundNo: 4 } })
    assert.equal(routes, 0)
    assert.equal(feedback, 1)
  })
for (const outcome of ['throw', 'reject', 'callback'])
  test(`known ${outcome} navigation failure is consumed and only explicit retry dispatches`, async () => {
    let calls = 0,
      feedback = 0,
      old
    const nav = make({
      readTask: async () => {},
      navigate: (o) => {
        calls++
        old ||= o
        if (outcome === 'throw') throw Error('native')
        if (outcome === 'reject') return Promise.reject(Error('native'))
        o.fail()
      },
      feedback: () => feedback++,
    })
    await nav.openCredits()
    await Promise.resolve()
    assert.equal(calls, 1)
    assert.equal(feedback, 1)
    await nav.openCredits()
    old.fail()
    await Promise.resolve()
    assert.equal(calls, 2)
    assert.equal(feedback, 2)
  })
test('post-dispatch success wins late rejection and requires actual hide/return; old callback cannot unlock next request', async () => {
  const calls = []
  const nav = make({
    navigate: (o) => {
      calls.push(o)
      o.success()
      return Promise.reject(Error('late'))
    },
  })
  await nav.openCredits()
  await Promise.resolve()
  await nav.openReservations()
  assert.equal(calls.length, 1)
  nav.hide()
  nav.show()
  await nav.openReservations()
  assert.equal(calls.length, 2)
  calls[0].fail()
  await nav.openCredits()
  assert.equal(calls.length, 2)
})
test('owner/foreground revoked after task await suppresses dispatch and feedback', async () => {
  const pending = gate()
  let current = true,
    routes = 0,
    feedback = 0
  const nav = make({
    readTask: () => pending.promise,
    isCurrent: () => current,
    navigate: () => routes++,
    feedback: () => feedback++,
  })
  const open = nav.openLedger({ entry: { taskId: 2 } })
  current = false
  pending.resolve({ id: 2, sessionId: 3, roundNo: 1 })
  await open
  assert.equal(routes, 0)
  assert.equal(feedback, 0)
})

test('synchronous pending subscription may cancel before the fresh task GET', async () => {
  let reads = 0
  const nav = make({
    readTask: async () => {
      reads++
      return { id: 2, sessionId: 3, roundNo: 1 }
    },
    navigate: () => {},
  })
  nav.subscribe(() => {
    if (nav.getSnapshot().pending) nav.cancel()
  })
  await nav.openLedger({ entry: { taskId: 2, id: 5 } })
  assert.equal(reads, 0)
})
