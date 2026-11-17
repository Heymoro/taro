const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

// Pure factory tests: no native transport, auth implementation, page, or server.
const first = { userId: 1, token: 'token', expiresAt: 'expiry' }
function gate() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function fixture() {
  let owner = { ...first },
    now = 0
  let ownerFailure = false
  const timers = new Map()
  const { createFavoriteSettlement } = load('src/features/artifact/favorite-settlement.js')
  const registry = createFavoriteSettlement({
    getOwner: () => {
      if (ownerFailure) throw Error('storage unavailable')
      return owner
    },
    now: () => now,
    setTimer: ({ callback, delay }) => {
      const timer = { callback, at: now + delay }
      timers.set(timer, timer)
      return timer
    },
    clearTimer: ({ timer }) => timers.delete(timer)
  })
  const write = (execute, artifactId = 66, key = owner) =>
    registry.write({ owner: key, artifactId, execute })
  const read = (execute, options = {}) =>
    registry.read({ owner, artifactId: 66, execute, ...options })
  return {
    registry,
    read,
    write,
    timers,
    failOwner: (value) => {
      ownerFailure = value
    },
    setOwner: (v) => {
      owner = v
    },
    advance: (ms) => {
      now += ms
      for (const timer of [...timers.values()])
        if (timer.at <= now) {
          timers.delete(timer)
          timer.callback()
        }
    }
  }
}

test('new factory capability: pending write survives caller lifetime and entity/list reads wait', async () => {
  const f = fixture(),
    pending = gate(),
    calls = []
  const write = f.write(() => pending.promise)
  const entity = f.read(() => {
    calls.push('entity')
    return true
  })
  const list = f.read(
    () => {
      calls.push('list')
      return []
    },
    { artifactId: undefined }
  )
  await flush()
  assert.deepEqual(calls, [])
  pending.resolve(false)
  assert.equal(await write, false)
  assert.equal(await entity, true)
  assert.deepEqual(await list, [])
  assert.deepEqual(calls.sort(), ['entity', 'list'])
  assert.equal(f.timers.size, 0)
})
for (const artifactId of [67, undefined])
  test(`unrelated ${artifactId ? 'entity' : 'owner'} does not wait`, async () => {
    const f = fixture(),
      pending = gate(),
      write = f.write(() => pending.promise)
    if (!artifactId) f.setOwner({ ...first, userId: 2 })
    assert.equal(await f.read(() => 'ready', { artifactId }), 'ready')
    pending.resolve()
    await write.catch(() => {})
  })
for (const reverse of [false, true])
  test(`all overlapping opposite writes are tracked without order/coalescing; reverse=${reverse}`, async () => {
    const f = fixture(),
      a = gate(),
      b = gate(),
      calls = []
    const w1 = f.write(() => {
      calls.push('PUT')
      return a.promise
    })
    const w2 = f.write(() => {
      calls.push('DELETE')
      return b.promise
    })
    const read = f.read(() => {
      calls.push('GET')
      return 'observed'
    })
    ;(reverse ? b : a).resolve()
    await flush()
    assert.deepEqual(calls, ['PUT', 'DELETE'])
    ;(reverse ? a : b).resolve()
    await Promise.all([w1, w2])
    assert.equal(await read, 'observed')
    assert.deepEqual(calls, ['PUT', 'DELETE', 'GET'])
  })
test('GET first then write drops stale candidate and reads once after completion', async () => {
  const f = fixture(),
    stale = gate(),
    writeGate = gate()
  let reads = 0
  const result = f.read(() => (++reads === 1 ? stale.promise : 'new'))
  await flush()
  const write = f.write(() => writeGate.promise)
  stale.resolve('old')
  await flush()
  assert.equal(reads, 1)
  writeGate.resolve()
  await write
  assert.equal(await result, 'new')
  assert.equal(reads, 2)
})
test('active read prevents ABA when a complete write settles during its GET', async () => {
  const f = fixture(),
    stale = gate()
  let reads = 0
  const result = f.read(() => (++reads === 1 ? stale.promise : 'new'))
  await flush()
  await f.write(() => true)
  stale.resolve('old')
  assert.equal(await result, 'new')
  assert.equal(reads, 2)
})
test('a second write collision yields controlled pending after exactly two GETs', async () => {
  const f = fixture(),
    a = gate(),
    b = gate()
  let reads = 0
  const result = f.read(() => (++reads === 1 ? a.promise : b.promise))
  const rejected = assert.rejects(result, /FAVORITE_PENDING/)
  await flush()
  await f.write(() => true)
  a.resolve('a')
  await flush()
  await f.write(() => false)
  b.resolve('b')
  await rejected
  assert.equal(reads, 2)
  assert.equal(f.timers.size, 0)
})
for (const field of ['userId', 'token', 'expiresAt'])
  test(`full ${field} change discards read outcome and clears its timer`, async () => {
    const f = fixture(),
      pending = gate(),
      result = f.read(() => pending.promise)
    const rejected = assert.rejects(result, /AUTH_REQUIRED/)
    await flush()
    f.setOwner({ ...first, [field]: field === 'userId' ? 2 : 'new' })
    pending.resolve('private')
    await rejected
    assert.equal(f.timers.size, 0)
  })
test('same-user credential rotation waits old transport but GET uses only new owner', async () => {
  const f = fixture(),
    pending = gate(),
    old = f.write(() => pending.promise)
  const oldRejected = assert.rejects(old, /AUTH_REQUIRED/)
  f.setOwner({ ...first, token: 'new' })
  let calls = 0,
    warning
  const result = f.read(
    () => {
      calls++
      return false
    },
    {
      onWarning: (v) => {
        warning = v
      }
    }
  )
  await flush()
  assert.equal(calls, 0)
  pending.resolve(true)
  await oldRejected
  assert.equal(await result, false)
  assert.equal(typeof warning, 'string')
})
for (const known of [false, true])
  test(`${known ? 'known rejection' : 'unknown failure'} retains actual observation ${
    known ? 'without' : 'with persistent'
  } warning; zero replay`, async () => {
    const f = fixture(),
      failure = Object.assign(Error('private secret'), { isOutcomeUnknown: !known })
    let writes = 0
    await assert.rejects(
      f.write(() => {
        writes++
        throw failure
      }),
      (e) => e === failure
    )
    for (let i = 0; i < 2; i++) {
      let warning
      assert.equal(
        await f.read(() => false, {
          onWarning: (v) => {
            warning = v
          }
        }),
        false
      )
      assert.equal(Boolean(warning), !known)
      if (warning) assert.doesNotMatch(warning, /private|secret|token/)
    }
    assert.equal(writes, 1)
  })
test('unknown artifact warns empty list and unrelated entity stays unblocked and unwarned', async () => {
  const f = fixture()
  await assert.rejects(f.write(() => Promise.reject(Error('NETWORK'))))
  let warning
  assert.deepEqual(
    await f.read(() => [], {
      artifactId: undefined,
      onWarning: (v) => {
        warning = v
      }
    }),
    []
  )
  assert.ok(warning)
  warning = ''
  await f.read(() => false, {
    artifactId: 67,
    onWarning: (v) => {
      warning = v
    }
  })
  assert.equal(warning, '')
})
test('registration precedes execute even for synchronous reentrant read', async () => {
  const f = fixture(),
    pending = gate()
  let result,
    reads = 0
  const write = f.write(() => {
    result = f.read(() => ++reads)
    return pending.promise
  })
  await flush()
  assert.equal(reads, 0)
  pending.resolve()
  await write
  assert.equal(await result, 1)
})
test('sync read throw and sync write throw clean readers/timers without internal unhandled rejection', async () => {
  const f = fixture(),
    seen = [],
    unhandled = (error) => seen.push(error)
  process.on('unhandledRejection', unhandled)
  try {
    await assert.rejects(
      f.read(() => {
        throw Error('read')
      }),
      /read/
    )
    await assert.rejects(
      f.write(() => {
        throw Error('write')
      }),
      /write/
    )
    await new Promise(setImmediate)
    assert.deepEqual(seen, [])
    assert.equal(f.timers.size, 0)
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})
for (const stage of ['wait', 'first GET', 'reread'])
  test(`15s total deadline includes ${stage}, sends no late GET/warning and preserves pending write`, async () => {
    const f = fixture(),
      transport = gate(),
      firstRead = gate(),
      secondRead = gate()
    let calls = 0,
      warnings = 0,
      write
    if (stage === 'wait') write = f.write(() => transport.promise)
    const read = f.read(
      () => {
        calls++
        return calls === 1 ? firstRead.promise : secondRead.promise
      },
      { onWarning: () => warnings++ }
    )
    const rejected = assert.rejects(read, /FAVORITE_PENDING/)
    await flush()
    if (stage === 'reread') {
      f.advance(10000)
      await f.write(() => true)
      firstRead.resolve('old')
      await flush()
    }
    f.advance(stage === 'reread' ? 5000 : 15000)
    await rejected
    assert.equal(f.timers.size, 0)
    const count = calls
    if (stage === 'wait') {
      let second = 0
      const late = f.read(() => ++second)
      await flush()
      assert.equal(second, 0)
      transport.resolve()
      await write
      assert.equal(await late, 1)
    }
    firstRead.resolve('late')
    secondRead.resolve('late')
    await flush()
    assert.equal(calls, count)
    assert.equal(warnings, 0)
  })
for (const stage of ['before', 'wait', 'GET'])
  test(`cancel ${stage} prevents subsequent GETs and feedback, other readers survive`, async () => {
    const f = fixture(),
      pending = gate(),
      transport = gate()
    let interested = stage !== 'before',
      calls = 0,
      warnings = 0
    let write
    if (stage === 'wait') write = f.write(() => pending.promise)
    const read = f.read(
      () => {
        calls++
        return transport.promise
      },
      { isInterested: () => interested, onWarning: () => warnings++ }
    )
    const rejected = assert.rejects(read, /READ_CANCELLED/)
    await flush()
    interested = false
    if (write) {
      pending.resolve()
      await write
    }
    if (stage === 'GET') {
      await f.write(() => true)
      transport.resolve('old')
    }
    await rejected
    assert.equal(calls, stage === 'GET' ? 1 : 0)
    assert.equal(warnings, 0)
    assert.equal(f.timers.size, 0)
    assert.equal(await f.read(() => true), true)
  })

test('list active reader preserves epoch across resource cleanup and rereads after a completed write', async () => {
  const f = fixture(),
    stale = gate()
  let reads = 0
  const result = f.read(() => (++reads === 1 ? stale.promise : []), { artifactId: undefined })
  await flush()
  await f.write(() => true)
  stale.resolve(['old'])
  assert.deepEqual(await result, [])
  assert.equal(reads, 2)
})
test('successful later writes and reads do not turn retained unknown metadata into confirmation', async () => {
  const f = fixture()
  await assert.rejects(
    f.write(() => {
      throw Error('NETWORK')
    })
  )
  await f.write(() => true)
  let warning
  assert.equal(
    await f.read(() => true, {
      onWarning: (value) => {
        warning = value
      }
    }),
    true
  )
  assert.ok(warning)
})
test('cancelled hanging reader ends at deadline with no late feedback and frees its timer', async () => {
  const f = fixture(),
    transport = gate()
  let interested = true,
    warnings = 0
  const read = f.read(() => transport.promise, {
    isInterested: () => interested,
    onWarning: () => warnings++
  })
  const rejected = assert.rejects(read, /FAVORITE_PENDING|READ_CANCELLED/)
  await flush()
  interested = false
  f.advance(15000)
  await rejected
  assert.equal(f.timers.size, 0)
  transport.resolve('late')
  await flush()
  assert.equal(warnings, 0)
})

test('interest invalidated between nested await continuations never receives a late warning', async () => {
  const f = fixture()
  await assert.rejects(
    f.write(() => {
      throw Error('NETWORK')
    })
  )
  let interested = true,
    checks = 0,
    warnings = 0
  const result = f.read(() => false, {
    isInterested: () => {
      checks++
      if (checks === 4)
        Promise.resolve().then(() => {
          interested = false
        })
      return interested
    },
    onWarning: () => warnings++
  })
  await assert.rejects(result, /READ_CANCELLED/)
  assert.equal(warnings, 0)
  assert.equal(f.timers.size, 0)
})

for (const rejects of [false, true])
  test(`settled transport releases its signal even when owner storage throws; rejection=${rejects}`, async () => {
    const f = fixture(),
      transport = gate()
    const failure = Object.assign(Error('known request refusal'), { isOutcomeUnknown: false })
    const write = f.write(() => transport.promise)
    const rejected = write.catch((error) => error)
    f.failOwner(true)
    if (rejects) transport.reject(failure)
    else transport.resolve(true)
    const observed = await rejected
    f.failOwner(false)
    let reads = 0,
      warning
    const result = f.read(() => ++reads, {
      onWarning: (value) => {
        warning = value
      }
    })
    await flush()
    assert.equal(reads, 1, 'settled write must not leave a dangling pending signal')
    assert.equal(await result, 1)
    if (rejects) assert.equal(observed, failure)
    else assert.match(observed.message, /AUTH_REQUIRED/)
    assert.equal(Boolean(warning), !rejects)
    assert.equal(f.timers.size, 0)
  })
