const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
function fixture() {
  const listeners = new Map()
  const channel = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn)
    },
    emit(name, data) {
      for (const fn of [...(listeners.get(name) || [])]) fn(data)
    }
  }
  const openerPage = { route: 'pages/create/index' }
  const detailPage = {
    route: 'pages/artifact/index',
    options: { id: '66' },
    getOpenerEventChannel() {
      assert.equal(this, detailPage)
      return channel
    }
  }
  let pages = [openerPage]
  let owner = { accountKey: '1:token:expiry', controller: {}, sessionId: 4 }
  const accepted = [],
    errors = [],
    navigations = [],
    backs = []
  const native = {
    getCurrentPages: () => pages,
    navigateTo(options) {
      navigations.push(options)
      channel.on('creation:return:request', options.events['creation:return:request'])
      pages = [openerPage, detailPage]
      options.success({ eventChannel: channel })
      return Promise.resolve({ eventChannel: channel })
    },
    navigateBack(options) {
      backs.push(options)
      pages = [openerPage]
      options.success({})
      return Promise.resolve({})
    }
  }
  const { createArtifactOpener, createArtifactReturn } = load(
    'src/features/creation/artifact-return.js'
  )
  const opener = createArtifactOpener({
    native,
    page: openerPage,
    readOwner: () => owner,
    acceptFocus: (intent) => {
      accepted.push(intent)
      return true
    },
    onError: (error) => errors.push(error)
  })
  const detail = () =>
    createArtifactReturn({
      native,
      page: detailPage,
      readOwner: () =>
        owner && { accountKey: owner.accountKey, sessionId: 4, taskId: 9, artifactId: 66 },
      onError: (error) => errors.push(error)
    })
  return {
    opener,
    detail,
    channel,
    native,
    accepted,
    errors,
    navigations,
    backs,
    listeners,
    openerPage,
    detailPage,
    setPages: (value) => {
      pages = value
    },
    setOwner: (value) => {
      owner = value
    }
  }
}

test('native request is accepted while hidden, ack precedes back, original show consumes once', async () => {
  const f = fixture()
  await f.opener.open({ taskId: 9, artifactId: 66 })
  const d = f.detail()
  await d.returnToCreation({ opener: true })
  assert.equal(f.accepted.length, 1)
  assert.equal(f.accepted[0].mode, 'preserve')
  assert.equal(f.backs.length, 1)
  f.opener.show()
  assert.equal(f.accepted.length, 1)
  assert.equal(f.listeners.get('creation:return:request').size, 0)
  d.dispose()
  f.opener.dispose()
})

test('ordinary back refreshes original binding, not a new creation page', async () => {
  const f = fixture()
  await f.opener.open({ taskId: 9, artifactId: 66 })
  f.setPages([f.openerPage])
  f.opener.show()
  f.opener.show()
  assert.equal(f.accepted.length, 1)
  assert.equal(f.navigations.length, 1)
  f.opener.dispose()
})

for (const invalid of ['owner', 'stack', 'binding'])
  test(`return rejects changed ${invalid} without fallback navigation`, async () => {
    const f = fixture()
    await f.opener.open({ taskId: 9, artifactId: 66 })
    const d = f.detail()
    if (invalid === 'owner') f.setOwner({ accountKey: 'changed', controller: {}, sessionId: 4 })
    if (invalid === 'stack') f.setPages([{}, f.detailPage])
    if (invalid === 'binding') f.detailPage.options.id = '67'
    await d.returnToCreation({ opener: true })
    assert.equal(f.backs.length, 0)
    assert.equal(f.navigations.length, 1)
    if (invalid !== 'owner') assert.ok(f.errors.length)
    d.dispose()
    f.opener.dispose()
  })

test('cabinet entry opens source session and task; opener entry with missing channel stays', async () => {
  const f = fixture()
  f.setPages([f.detailPage])
  const d = f.detail()
  f.native.navigateTo = ({ url, success }) => {
    f.navigations.push(url)
    success({})
    return Promise.resolve({})
  }
  await d.returnToCreation({ opener: false })
  assert.equal(f.navigations[0], '/pages/create/index?session=4&focusTask=9')
  d.dispose()
  f.detailPage.getOpenerEventChannel = () => null
  const missing = f.detail()
  await missing.returnToCreation({ opener: true })
  assert.equal(f.navigations.length, 1)
  assert.ok(f.errors.length)
  missing.dispose()
  f.opener.dispose()
})

test('late old navigation success never releases a newer visit', () => {
  const f = fixture(),
    jobs = []
  f.native.navigateTo = (options) => {
    jobs.push(options)
    f.channel.on('creation:return:request', options.events['creation:return:request'])
  }
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.setOwner(null)
  f.opener.invalidate()
  f.setOwner({ accountKey: 'new-owner', controller: {}, sessionId: 4 })
  f.opener.open({ taskId: 9, artifactId: 66 })
  jobs[0].success({ eventChannel: f.channel })
  assert.equal(f.opener.open({ taskId: 9, artifactId: 66 }), false)
  jobs[1].success({ eventChannel: f.channel })
  f.opener.dispose()
  assert.equal(f.listeners.get('creation:return:request').size, 0)
})

test('invalid request does not bind or poison a later valid detail retry', async () => {
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.setPages([f.openerPage, {}])
  f.channel.emit('creation:return:request', {
    intentId: 'wrong',
    sessionId: 4,
    taskId: 9,
    artifactId: 67
  })
  f.setPages([f.openerPage, f.detailPage])
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  d.dispose()
  f.opener.dispose()
})

test('missing captured native page is a controlled failure, never an unguarded navigation', () => {
  const f = fixture()
  const { createArtifactReturn } = load('src/features/creation/artifact-return.js')
  const d = createArtifactReturn({
    native: f.native,
    page: null,
    readOwner: () => ({ accountKey: 'owner', sessionId: 4, taskId: 9, artifactId: 66 }),
    onError: (v) => f.errors.push(v)
  })
  d.returnToCreation({ opener: false })
  assert.equal(f.navigations.length, 0)
  assert.ok(f.errors.length)
  d.dispose()
  f.opener.dispose()
})

test('ack timeout treats void emit as no confirmation and releases its exact listener', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPages([f.openerPage, f.detailPage])
  const d = f.detail()
  d.returnToCreation({ opener: true })
  d.returnToCreation({ opener: true })
  assert.equal(f.listeners.get('creation:return:ack').size, 1)
  t.mock.timers.tick(5000)
  assert.equal(f.backs.length, 0)
  assert.equal(f.listeners.get('creation:return:ack').size, 0)
  assert.ok(f.errors.length)
  d.dispose()
  f.opener.dispose()
  t.mock.timers.reset()
})

test('back failure keeps opener channel but explicit retry makes a fresh handshake', () => {
  const f = fixture()
  let requests = 0
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.channel.on('creation:return:request', () => {
    requests++
  })
  f.native.navigateBack = ({ fail }) => {
    f.backs.push('failed')
    fail()
  }
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  assert.equal(f.listeners.get('creation:return:ack').size, 0)
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 2)
  assert.equal(requests, 2)
  assert.equal(f.accepted.length, 1)
  d.dispose()
  f.opener.dispose()
})

test('unknown native back is single flight even after deadline, and dispose releases all listeners', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.native.navigateBack = () => {
    f.backs.push('unknown')
  }
  const d = f.detail()
  d.returnToCreation({ opener: true })
  t.mock.timers.tick(5000)
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  assert.ok(f.errors.length)
  d.dispose()
  f.opener.dispose()
  assert.equal(f.listeners.get('creation:return:ack').size, 0)
  assert.equal(f.listeners.get('creation:return:request').size, 0)
  t.mock.timers.tick(10000)
  t.mock.timers.reset()
})

test('a replacement detail page with the same IDs is not the captured visit', () => {
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.setPages([f.openerPage, { ...f.detailPage }])
  f.channel.emit('creation:return:request', {
    intentId: 'replacement',
    sessionId: 4,
    taskId: 9,
    artifactId: 66
  })
  assert.equal(f.accepted.length, 0)
  f.opener.dispose()
})

for (const phase of ['waiting', 'accepted']) {
  test(`detail does not return to a replacement parent while ${phase}`, () => {
    const f = fixture()
    f.opener.open({ taskId: 9, artifactId: 66 })
    let request
    f.channel.on('creation:return:request', (value) => {
      request = value
    })
    if (phase === 'waiting')
      f.channel.off('creation:return:request', f.navigations[0].events['creation:return:request'])
    f.native.navigateBack = ({ fail }) => {
      f.backs.push('back')
      fail()
    }
    const d = f.detail()
    d.returnToCreation({ opener: true })
    f.setPages([{ route: 'pages/create/index' }, f.detailPage])
    if (phase === 'waiting') f.channel.emit('creation:return:ack', { ...request, accepted: true })
    else d.returnToCreation({ opener: true })
    assert.equal(f.backs.length, phase === 'waiting' ? 0 : 1)
    assert.ok(f.errors.length)
    d.dispose()
    f.opener.dispose()
  })
}

test('wrong, duplicate and late ack cannot bypass a single matching accepted handshake', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const f = fixture(),
    requests = []
  f.setPages([f.openerPage, f.detailPage])
  f.channel.on('creation:return:request', (value) => requests.push(value))
  const first = f.detail()
  first.returnToCreation({ opener: true })
  first.dispose()
  const second = f.detail()
  second.returnToCreation({ opener: true })
  second.returnToCreation({ opener: true })
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].intentId, requests[1].intentId)
  f.channel.emit('creation:return:ack', { ...requests[0], accepted: true })
  f.channel.emit('creation:return:ack', { ...requests[1], taskId: 8, accepted: true })
  f.channel.emit('creation:return:ack', { ...requests[1], accepted: 'true' })
  assert.equal(f.backs.length, 0)
  // A rejected ack is terminal for that request. Retry is explicit with a fresh intent.
  second.returnToCreation({ opener: true })
  const request = requests.at(-1)
  f.channel.emit('creation:return:ack', { ...request, accepted: true })
  f.channel.emit('creation:return:ack', { ...request, accepted: true })
  assert.equal(f.backs.length, 1)
  second.dispose()
  f.opener.dispose()
  t.mock.timers.tick(10000)
  t.mock.timers.reset()
})

test('early request waits for native success channel before synchronously acknowledging', () => {
  const f = fixture()
  let success
  f.native.navigateTo = (options) => {
    f.channel.on('creation:return:request', options.events['creation:return:request'])
    f.setPages([f.openerPage, f.detailPage])
    success = options.success
  }
  f.opener.open({ taskId: 9, artifactId: 66 })
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(f.accepted.length, 1)
  assert.equal(f.backs.length, 0)
  success({ eventChannel: f.channel })
  assert.equal(f.backs.length, 1)
  f.opener.show()
  assert.equal(f.accepted.length, 1)
  d.dispose()
  f.opener.dispose()
})

test('unknown outbound navigation remains locked through timeout and early return, then late settle consumes once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  let options,
    calls = 0
  f.native.navigateTo = (value) => {
    calls++
    options = value
  }
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.opener.show()
  t.mock.timers.tick(5000)
  assert.equal(f.opener.open({ taskId: 9, artifactId: 66 }), false)
  assert.equal(f.accepted.length, 0)
  assert.equal(calls, 1)
  assert.ok(f.errors.length)
  options.success({ eventChannel: f.channel })
  assert.equal(f.accepted.length, 1)
  f.opener.show()
  assert.equal(f.accepted.length, 1)
  f.opener.dispose()
  t.mock.timers.reset()
})

test('dispose while waiting releases exact listeners and timers without touching unrelated callbacks', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPages([f.openerPage, f.detailPage])
  const unrelated = () => {}
  f.channel.on('creation:return:ack', unrelated)
  const d = f.detail()
  d.returnToCreation({ opener: true })
  d.dispose()
  f.opener.dispose()
  assert.equal(f.listeners.get('creation:return:ack').size, 1)
  assert.ok(f.listeners.get('creation:return:ack').has(unrelated))
  t.mock.timers.tick(10000)
  assert.equal(f.errors.length, 0)
  assert.equal(f.backs.length, 0)
  t.mock.timers.reset()
})

test('back failure followed by opener controller replacement requires a fresh accepted ack', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.native.navigateBack = ({ fail }) => {
    f.backs.push('back')
    fail()
  }
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  f.setOwner({ accountKey: '1:token:expiry', controller: {}, sessionId: 4 })
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  t.mock.timers.tick(5000)
  assert.equal(f.listeners.get('creation:return:ack').size, 0)
  d.dispose()
  f.opener.dispose()
  t.mock.timers.reset()
})

test('an emit listener throwing after synchronous ack cannot unlock unknown back navigation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.native.navigateBack = () => {
    f.backs.push('unknown')
  }
  f.channel.on('creation:return:request', () => {
    throw Error('LATE_LISTENER')
  })
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(d.isPending(), true)
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  d.dispose()
  f.opener.dispose()
  t.mock.timers.reset()
})

for (const mode of ['throws-before', 'throws-after']) {
  test(`channel registration ${mode} ends the detail flight with controlled feedback`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture()
    f.setPages([f.openerPage, f.detailPage])
    const register = f.channel.on.bind(f.channel)
    f.channel.on = (name, callback) => {
      if (mode === 'throws-after') register(name, callback)
      throw Error('REGISTER_FAILED')
    }
    const d = f.detail()
    assert.doesNotThrow(() => d.returnToCreation({ opener: true }))
    assert.equal(d.isPending(), false)
    assert.equal(f.errors.length, 1)
    assert.equal(f.backs.length, 0)
    assert.equal(f.listeners.get('creation:return:ack')?.size || 0, 0)
    t.mock.timers.tick(10000)
    assert.equal(f.errors.length, 1)
    d.dispose()
    f.opener.dispose()
    t.mock.timers.reset()
  })
}

for (const method of ['on', 'off', 'emit']) {
  test(`non-function channel ${method} is a controlled setup failure`, () => {
    const f = fixture()
    f.setPages([f.openerPage, f.detailPage])
    f.channel[method] = {}
    const d = f.detail()
    assert.doesNotThrow(() => d.returnToCreation({ opener: true }))
    assert.equal(d.isPending(), false)
    assert.equal(f.errors.length, 1)
    assert.equal(f.backs.length, 0)
    assert.doesNotThrow(() => d.dispose())
    f.opener.dispose()
  })
}

test('throwing off cannot prevent timeout or dispose from ending detail ownership', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPages([f.openerPage, f.detailPage])
  const d = f.detail()
  d.returnToCreation({ opener: true })
  f.channel.off = () => {
    throw Error('OFF_FAILED')
  }
  assert.doesNotThrow(() => t.mock.timers.tick(5000))
  assert.equal(d.isPending(), false)
  assert.equal(f.errors.length, 1)
  assert.doesNotThrow(() => d.dispose())
  // A broken native off may retain the callback; it must be inert after terminal cleanup.
  assert.doesNotThrow(() =>
    f.channel.emit('creation:return:ack', {
      intentId: 'late',
      sessionId: 4,
      taskId: 9,
      artifactId: 66,
      accepted: true
    })
  )
  assert.equal(f.backs.length, 0)
  t.mock.timers.tick(10000)
  assert.equal(f.errors.length, 1)
  f.opener.dispose()
  t.mock.timers.reset()
})

test('throwing off cannot abort accepted unknown back or release its navigation gate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.opener.open({ taskId: 9, artifactId: 66 })
  f.channel.off = () => {
    throw Error('OFF_FAILED')
  }
  f.native.navigateBack = () => f.backs.push('unknown')
  const d = f.detail()
  assert.doesNotThrow(() => d.returnToCreation({ opener: true }))
  assert.equal(f.backs.length, 1)
  assert.equal(d.isPending(), true)
  t.mock.timers.tick(5000)
  d.returnToCreation({ opener: true })
  assert.equal(f.backs.length, 1)
  assert.doesNotThrow(() => d.dispose())
  assert.equal(d.isPending(), false)
  assert.doesNotThrow(() => f.opener.dispose())
  t.mock.timers.reset()
})

for (const mode of ['throws', 'not-function']) {
  test(`opener off ${mode} cannot keep a returned visit locked`, () => {
    const f = fixture()
    f.opener.open({ taskId: 9, artifactId: 66 })
    f.channel.off =
      mode === 'throws'
        ? () => {
            throw Error('OFF_FAILED')
          }
        : {}
    f.setPages([f.openerPage])
    assert.doesNotThrow(() => f.opener.show())
    assert.equal(f.accepted.length, 1)
    assert.equal(f.opener.open({ taskId: 9, artifactId: 66 }), true)
    assert.doesNotThrow(() => f.opener.dispose())
  })
}

test('opener validates channel methods as functions before accepting the native channel', () => {
  const f = fixture()
  f.native.navigateTo = ({ success }) => success({ eventChannel: { emit: {}, off: {} } })
  assert.doesNotThrow(() => f.opener.open({ taskId: 9, artifactId: 66 }))
  assert.equal(f.errors.length, 1)
  assert.doesNotThrow(() => f.opener.dispose())
})

test('opener channel method getter failure is controlled rather than swallowed by navigation settlement', () => {
  const f = fixture()
  f.native.navigateTo = ({ success }) =>
    success({
      eventChannel: {
        emit() {},
        get off() {
          throw Error('OFF_LOOKUP_FAILED')
        }
      }
    })
  assert.doesNotThrow(() => f.opener.open({ taskId: 9, artifactId: 66 }))
  assert.equal(f.errors.length, 1)
  assert.doesNotThrow(() => f.opener.dispose())
})

test('failed registration plus broken off still ends ownership and leaves retained callback inert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.setPages([f.openerPage, f.detailPage])
  let callback
  f.channel.on = (_event, listener) => {
    callback = listener
    throw Error('REGISTER_FAILED')
  }
  f.channel.off = () => {
    throw Error('OFF_FAILED')
  }
  const d = f.detail()
  assert.doesNotThrow(() => d.returnToCreation({ opener: true }))
  assert.equal(d.isPending(), false)
  assert.equal(f.errors.length, 1)
  assert.doesNotThrow(() =>
    callback({ intentId: 'late', sessionId: 4, taskId: 9, artifactId: 66, accepted: true })
  )
  t.mock.timers.tick(10000)
  assert.equal(f.errors.length, 1)
  assert.equal(f.backs.length, 0)
  assert.doesNotThrow(() => d.dispose())
  f.opener.dispose()
  t.mock.timers.reset()
})

for (const mode of ['lookup-throws', 'getter-not-function', 'method-getter-throws']) {
  test(`detail channel ${mode} is a controlled setup failure`, () => {
    const f = fixture()
    f.setPages([f.openerPage, f.detailPage])
    if (mode === 'lookup-throws')
      f.detailPage.getOpenerEventChannel = () => {
        throw Error('LOOKUP_FAILED')
      }
    if (mode === 'getter-not-function') f.detailPage.getOpenerEventChannel = {}
    if (mode === 'method-getter-throws')
      Object.defineProperty(f.channel, 'on', {
        get() {
          throw Error('ON_LOOKUP_FAILED')
        }
      })
    const d = f.detail()
    assert.doesNotThrow(() => d.returnToCreation({ opener: true }))
    assert.equal(d.isPending(), false)
    assert.equal(f.errors.length, 1)
    assert.equal(f.backs.length, 0)
    d.dispose()
    f.opener.dispose()
  })
}

test('setup failure before owning an ack callback never performs broad native off cleanup', () => {
  const f = fixture()
  f.setPages([f.openerPage, f.detailPage])
  const unrelated = () => {}
  f.channel.on('creation:return:ack', unrelated)
  const off = f.channel.off.bind(f.channel)
  f.channel.off = (name, callback) => {
    if (callback === undefined) f.listeners.get(name)?.clear()
    else off(name, callback)
  }
  f.channel.emit = {}
  const d = f.detail()
  d.returnToCreation({ opener: true })
  assert.equal(f.listeners.get('creation:return:ack').has(unrelated), true)
  d.dispose()
  f.opener.dispose()
})
