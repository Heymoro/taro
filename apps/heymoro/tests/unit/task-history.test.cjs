const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture, task } = require('../fixtures/creation.cjs')
const tick = () => new Promise(setImmediate)
const row = (id, extra = {}) =>
  task({}, { id, roundNo: id, status: 'succeeded', artifactIds: [], ...extra })
const page = (items, nextCursor = null) => ({ items, nextCursor, hasMore: nextCursor !== null })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

test('history EOF is not reopened by latest refresh', async () => {
  const { workflow: w } = workflowFixture({
    api: { tasks: async ({ cursor }) => (cursor ? page([row(1)]) : page([row(3)], 'older')) }
  })
  await w.refresh()
  await w.loadOlder()
  assert.equal(w.getSnapshot().hasOlder, false)
  await w.refresh()
  assert.equal(w.getSnapshot().hasOlder, false)
  assert.equal(w.getSnapshot().olderCursor, null)
})

test('history duplicate older caller waits for actual shared page completion', async () => {
  const gate = deferred()
  let calls = 0
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        if (!cursor) return page([row(3)], 'older')
        calls++
        return gate.promise
      }
    }
  })
  await w.refresh()
  const first = w.loadOlder()
  let finished = false
  const second = w.loadOlder().then((r) => {
    finished = true
    return r
  })
  await tick()
  assert.equal(finished, false)
  assert.equal(w.getSnapshot().loadingOlder, true)
  gate.resolve(page([row(1)]))
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(a.status, 'read')
  assert.equal(b.status, 'read')
  assert.equal(w.getSnapshot().loadingOlder, false)
})

test('focus is a new read-only workflow capability', async () => {
  const f = workflowFixture({
    api: { task: async () => row(9), tasks: async () => page([row(9)]) }
  })
  assert.equal(typeof f.workflow.focusTask, 'function')
  const before = f.writes.length
  const result = await f.workflow.focusTask({ taskId: 9 })
  assert.equal(result.status, 'focused')
  assert.equal(result.artifacts, 'fresh')
  assert.equal(f.writes.length, before)
  assert.equal(f.sent.length, 0)
})

test('older queued behind first latest actually reads older rather than borrowing latest result', async () => {
  const latest = deferred()
  const cursors = []
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        cursors.push(cursor)
        return cursor ? page([row(1)]) : latest.promise
      }
    }
  })
  const refresh = w.refresh()
  await tick()
  const older = w.loadOlder()
  latest.resolve(page([row(3)], 'older'))
  await Promise.all([refresh, older])
  assert.deepEqual(cursors, [undefined, 'older'])
  assert.equal(w.getSnapshot().rounds.length, 2)
})

for (const input of [0, -1, 1.5, '9', NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`focus rejects invalid task identifier ${input} before GET`, async () => {
    let gets = 0
    const { workflow: w } = workflowFixture({
      api: {
        task: async () => {
          gets++
          return row(9)
        }
      }
    })
    assert.equal((await w.focusTask({ taskId: input })).reason, 'invalid-task-id')
    assert.equal(gets, 0)
  })
}
for (const extra of [
  { id: 8 },
  { sessionId: 5 },
  { roundNo: 0 },
  { roundNo: 1.2 },
  { roundNo: Number.MAX_SAFE_INTEGER + 1 }
]) {
  test(`focus rejects unbound task response ${JSON.stringify(extra)}`, async () => {
    let pages = 0
    const { workflow: w } = workflowFixture({
      api: {
        task: async () => row(9, extra),
        tasks: async () => {
          pages++
          return page([])
        }
      }
    })
    assert.equal((await w.focusTask({ taskId: 9 })).reason, 'invalid-task')
    assert.equal(w.getSnapshot().rounds.length, 0)
    assert.equal(pages, 0)
  })
}

test('focus empty continuation pages remain traversable and filtered target merges after crossing', async () => {
  const cursors = []
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(5),
      tasks: async ({ cursor }) => {
        cursors.push(cursor)
        return cursor === undefined
          ? page([row(9)], 'empty')
          : cursor === 'empty'
          ? page([], 'cross')
          : page([row(3)], 'remaining')
      }
    }
  })
  assert.equal((await w.focusTask({ taskId: 5 })).status, 'focused')
  assert.deepEqual(cursors, [undefined, 'empty', 'cross'])
  assert.equal(w.getSnapshot().olderCursor, 'remaining')
  assert.equal(w.getSnapshot().hasOlder, true)
  assert.deepEqual(
    Array.from(w.getSnapshot().rounds, (r) => r.id),
    [3, 5, 9]
  )
})

test('focus pauses at twenty pages and explicit continuation retains frontier', async () => {
  let calls = 0
  let tasks = 0
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => {
        tasks++
        return row(1)
      },
      tasks: async () => {
        calls++
        return calls < 23 ? page([row(100 - calls)], `cursor-${calls}`) : page([])
      }
    }
  })
  assert.equal((await w.focusTask({ taskId: 1 })).status, 'paused')
  assert.equal(calls, 20)
  assert.equal(w.getSnapshot().hasOlder, true)
  assert.equal(w.getSnapshot().olderCursor, 'cursor-20')
  await tick()
  assert.equal(calls, 20)
  assert.equal((await w.focusTask({ taskId: 1 })).status, 'focused')
  assert.equal(calls, 23)
  assert.equal(tasks, 2)
})

test('same cursor and consumed cursor fail explicitly without consumption or EOF', async () => {
  let mode = 'same'
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        if (!cursor) return page([row(10)], 'a')
        if (mode === 'same') return page([], cursor)
        if (cursor === 'a') return page([], 'b')
        return page([], 'a')
      }
    }
  })
  await w.refresh()
  assert.equal((await w.loadOlder()).reason, 'cursor-loop')
  assert.equal(w.getSnapshot().olderCursor, 'a')
  mode = 'advance'
  assert.equal((await w.loadOlder()).status, 'read')
  assert.equal((await w.loadOlder()).reason, 'cursor-loop')
  assert.equal(w.getSnapshot().olderCursor, 'b')
  assert.equal(w.getSnapshot().hasOlder, true)
})

test('failed older read is explicit and retry uses unconsumed cursor', async () => {
  let fail = true
  const cursors = []
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        cursors.push(cursor)
        if (!cursor) return page([row(9)], 'a')
        if (fail) throw Error('NETWORK')
        return page([row(1)])
      }
    }
  })
  await w.refresh()
  assert.equal((await w.loadOlder()).status, 'failed')
  assert.equal(w.getSnapshot().loadingOlder, false)
  assert.equal(w.getSnapshot().olderCursor, 'a')
  fail = false
  assert.equal((await w.loadOlder()).status, 'read')
  assert.deepEqual(cursors, [undefined, 'a', 'a'])
})

test('loaded old target always GETs task and refreshes server favorite without latest-only claims', async () => {
  let favorite = false
  const reads = []
  const f = workflowFixture({
    api: {
      tasks: async () => page([row(9, { artifactIds: [88] })]),
      task: async () => {
        reads.push('task')
        return row(9, { artifactIds: [88] })
      },
      artifact: async () => {
        reads.push('artifact')
        return { id: 88, taskId: 9, sessionId: 4, isFavorite: favorite }
      }
    }
  })
  await f.workflow.refresh()
  favorite = true
  reads.length = 0
  const result = await f.workflow.focusTask({ taskId: 9 })
  assert.equal(result.artifacts, 'fresh')
  assert.deepEqual(reads, ['task', 'artifact'])
  assert.equal(f.workflow.getSnapshot().artifacts[88].isFavorite, true)
  assert.equal('anchor' in result, false)
})
for (const extra of [{ id: 77 }, { taskId: 8 }, { sessionId: 3 }]) {
  test(`target metadata rejects mismatched binding ${JSON.stringify(extra)}`, async () => {
    const { workflow: w } = workflowFixture({
      api: {
        task: async () => row(9, { artifactIds: [88] }),
        tasks: async () => page([]),
        artifact: async () => ({ id: 88, taskId: 9, sessionId: 4, ...extra })
      }
    })
    assert.equal((await w.focusTask({ taskId: 9 })).artifacts, 'failed')
    assert.equal(w.getSnapshot().artifacts[88], undefined)
  })
}

test('page metadata reads non-target rounds; non-target errors do not block target', async () => {
  const reads = []
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(5, { artifactIds: [50] }),
      tasks: async ({ cursor }) =>
        cursor
          ? page([row(3, { artifactIds: [30] })])
          : page([row(9, { artifactIds: [90] })], 'old'),
      artifact: async ({ artifactId }) => {
        reads.push(artifactId)
        if (artifactId === 90) throw Error('NETWORK')
        return { id: artifactId, taskId: artifactId / 10, sessionId: 4 }
      }
    }
  })
  assert.equal((await w.focusTask({ taskId: 5 })).artifacts, 'fresh')
  assert.deepEqual(reads, [90, 30, 50])
  assert.equal(w.getSnapshot().artifacts[30].id, 30)
})

for (const phase of ['task', 'page', 'artifact']) {
  for (const invalidation of ['hide-show', 'dispose', 'identity', 'new-intent']) {
    test(`focus ${invalidation} during ${phase} does not continue or report late errors`, async () => {
      const gate = deferred()
      const calls = []
      let current = true
      const target = row(9, { artifactIds: [88, 89] })
      const { workflow: w } = workflowFixture({
        isCurrent: () => current,
        api: {
          task: async () => {
            calls.push('task')
            return phase === 'task' ? gate.promise : target
          },
          tasks: async () => {
            calls.push('page')
            return phase === 'page' ? gate.promise : page([])
          },
          artifact: async ({ artifactId }) => {
            calls.push(artifactId)
            return gate.promise
          }
        }
      })
      const focus = w.focusTask({ taskId: 9 })
      await tick()
      if (invalidation === 'hide-show') {
        w.setPageVisible({ visible: false })
        w.setPageVisible({ visible: true })
      }
      if (invalidation === 'dispose') w.dispose()
      if (invalidation === 'identity') current = false
      if (invalidation === 'new-intent')
        assert.equal((await w.focusTask({ taskId: 0 })).status, 'failed')
      const beforeCalls = calls.length
      const beforeError = w.getSnapshot().error
      gate.resolve(
        phase === 'task'
          ? target
          : phase === 'page'
          ? page([row(12, { artifactIds: [120] })], 'older')
          : { id: 88, taskId: 9, sessionId: 4 }
      )
      assert.equal((await focus).status, 'cancelled')
      await tick()
      assert.equal(calls.length, beforeCalls)
      assert.equal(w.getSnapshot().error, beforeError)
    })
  }
}

test('cancelled queued focus does not issue next page while shared manual facts can finish', async () => {
  const gate = deferred()
  const cursors = []
  const artifacts = []
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(1),
      tasks: async ({ cursor }) => {
        cursors.push(cursor)
        return cursor ? gate.promise : page([row(9)], 'older')
      },
      artifact: async ({ artifactId }) => {
        artifacts.push(artifactId)
        return { id: artifactId, taskId: 7, sessionId: 4 }
      }
    }
  })
  await w.refresh()
  const older = w.loadOlder()
  const focus = w.focusTask({ taskId: 1 })
  await tick()
  w.setPageVisible({ visible: false })
  gate.resolve(page([row(7, { artifactIds: [70] })], 'remaining'))
  assert.equal((await older).status, 'read')
  assert.equal((await focus).status, 'cancelled')
  assert.deepEqual(cursors, [undefined, 'older'])
  // The shared page facts may finish, but hidden readers must not start new artifact IO.
  assert.deepEqual(artifacts, [])
  assert.equal(w.getSnapshot().artifacts[70], undefined)
})

test('target favorite saving is pending without another GET or mutation', async () => {
  const gate = deferred()
  let reads = 0
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async () => page([row(9, { artifactIds: [88] })]),
      task: async () => row(9, { artifactIds: [88] }),
      artifact: async () => {
        reads++
        return { id: 88, taskId: 9, sessionId: 4, isFavorite: false }
      },
      favorite: async () => gate.promise
    }
  })
  await w.refresh()
  const writing = w.toggleFavorite(88)
  assert.equal((await w.focusTask({ taskId: 9 })).artifacts, 'pending')
  assert.equal(reads, 1)
  assert.equal(w.getSnapshot().artifacts[88].saving, true)
  gate.resolve({ isFavorite: true })
  await writing
})

test('favorite epoch change during target GET yields pending and retains confirmed value', async () => {
  const gate = deferred()
  let reads = 0
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async () => page([row(9, { artifactIds: [88] })]),
      task: async () => row(9, { artifactIds: [88] }),
      artifact: async () => {
        if (++reads > 1) return gate.promise
        return { id: 88, taskId: 9, sessionId: 4, isFavorite: false }
      }
    }
  })
  await w.refresh()
  const focus = w.focusTask({ taskId: 9 })
  await tick()
  await w.toggleFavorite(88)
  gate.resolve({ id: 88, taskId: 9, sessionId: 4, isFavorite: false })
  assert.equal((await focus).artifacts, 'pending')
  assert.equal(w.getSnapshot().artifacts[88].isFavorite, true)
})

test('history focus leaves all input quote source submission and write lanes unchanged', async () => {
  const forbidden = () => assert.fail('history sent a write')
  const f = workflowFixture({
    api: {
      task: async () => row(1),
      tasks: async () => page([]),
      putDraft: forbidden,
      generate: forbidden,
      regenerate: forbidden,
      favorite: forbidden,
      quote: forbidden
    }
  })
  const fields = [
    'description',
    'userNotes',
    'photos',
    'quote',
    'sourceArtifactId',
    'carryBackSourceTaskId',
    'sessionRequest',
    'submission'
  ]
  const before = fields.map((key) => f.workflow.getSnapshot()[key])
  const writes = f.writes.length
  assert.equal((await f.workflow.focusTask({ taskId: 1 })).status, 'focused')
  assert.deepEqual(
    fields.map((key) => f.workflow.getSnapshot()[key]),
    before
  )
  assert.equal(f.writes.length, writes)
  assert.equal(f.sent.length, 0)
})

test('latest waits for older lane then merges only latest facts without resetting frontier', async () => {
  const gate = deferred()
  const calls = []
  let latestCount = 0
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        calls.push(cursor)
        if (cursor) return gate.promise
        return page([row(++latestCount === 1 ? 9 : 11)], 'a')
      }
    }
  })
  await w.refresh()
  const older = w.loadOlder()
  const refresh = w.refresh()
  await tick()
  assert.deepEqual(calls, [undefined, 'a'])
  gate.resolve(page([row(7)], 'b'))
  await Promise.all([older, refresh])
  assert.deepEqual(calls, [undefined, 'a', undefined])
  assert.equal(w.getSnapshot().olderCursor, 'b')
  assert.deepEqual(
    Array.from(w.getSnapshot().rounds, (r) => r.id),
    [7, 9, 11]
  )
})

test('focus task errors and target metadata errors are distinguishable failures', async () => {
  let failTask = true
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => {
        if (failTask) throw Error('NETWORK')
        return row(9, { artifactIds: [88] })
      },
      tasks: async () => page([row(9, { artifactIds: [88] })]),
      artifact: async () => {
        throw Error('NETWORK')
      }
    }
  })
  assert.equal((await w.focusTask({ taskId: 9 })).reason, 'task-read')
  failTask = false
  const result = await w.focusTask({ taskId: 9 })
  assert.equal(result.status, 'focused')
  assert.equal(result.artifacts, 'failed')
  assert.equal(w.getSnapshot().error, '')
  await w.refresh()
  assert.ok(w.getSnapshot().error, 'ordinary refresh still reports metadata errors')
})

for (const badPage of [
  null,
  { items: {}, hasMore: false },
  page([row(9, { sessionId: 5 })]),
  page([row(9, { roundNo: 0 })])
]) {
  test(`invalid history page is rejected before merging ${JSON.stringify(badPage)}`, async () => {
    const { workflow: w } = workflowFixture({
      api: { task: async () => row(1), tasks: async () => badPage }
    })
    assert.equal((await w.focusTask({ taskId: 1 })).reason, 'invalid-page')
    assert.equal(w.getSnapshot().rounds.length, 0)
    assert.equal(w.getSnapshot().hasOlder, false)
  })
}

test('new focus wins over delayed older target intent with no old continuation', async () => {
  const gate = deferred()
  let requests = 0
  const { workflow: w } = workflowFixture({
    api: {
      task: async ({ taskId }) => {
        requests++
        return taskId === 1 ? gate.promise : row(9)
      },
      tasks: async () => page([row(9)])
    }
  })
  const old = w.focusTask({ taskId: 1 })
  await tick()
  assert.equal((await w.focusTask({ taskId: 9 })).status, 'focused')
  gate.resolve(row(1))
  assert.equal((await old).status, 'cancelled')
  assert.equal(requests, 2)
  assert.deepEqual(
    Array.from(w.getSnapshot().rounds, (r) => r.id),
    [9]
  )
})

test('late rejected target metadata after hiding yields cancellation without error or next GET', async () => {
  const gate = deferred()
  let reads = 0
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(9, { artifactIds: [88, 89] }),
      tasks: async () => page([]),
      artifact: async () => {
        reads++
        return gate.promise
      }
    }
  })
  const focus = w.focusTask({ taskId: 9 })
  await tick()
  w.setPageVisible({ visible: false })
  const error = w.getSnapshot().error
  gate.reject(Error('NETWORK'))
  assert.equal((await focus).status, 'cancelled')
  assert.equal(w.getSnapshot().error, error)
  assert.equal(reads, 1)
})

test('terminal merge rule stays single-source when fresh task is a late active receipt', async () => {
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async () => page([row(9, { artifactIds: [88] })]),
      task: async () => row(9, { status: 'queued', artifactIds: [] })
    }
  })
  await w.refresh()
  assert.equal((await w.focusTask({ taskId: 9 })).artifacts, 'fresh')
  assert.equal(w.getSnapshot().rounds[0].status, 'succeeded')
  assert.deepEqual(Array.from(w.getSnapshot().rounds[0].artifactIds), [88])
})

test('hidden focus sends no task or metadata requests', async () => {
  const forbidden = () => assert.fail('hidden intent started a GET')
  const { workflow: w } = workflowFixture({
    api: { tasks: forbidden, task: forbidden, artifact: forbidden }
  })
  w.setPageVisible({ visible: false })
  assert.equal((await w.focusTask({ taskId: 9 })).status, 'cancelled')
})

for (const sessionId of [null, 0, -1, '4', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`focus invalid session ${sessionId} sends no target GET`, async () => {
    let requests = 0
    const { workflow: w } = workflowFixture({
      sessionId,
      api: {
        task: async () => {
          requests++
          return row(9)
        }
      }
    })
    assert.equal((await w.focusTask({ taskId: 9 })).status, 'failed')
    assert.equal(requests, 0)
  })
}

test('loadingOlder emission reentry can await the already-published shared flight', async () => {
  const gate = deferred()
  let joined
  let joinedDone = false
  let calls = 0
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        if (!cursor) return page([row(9)], 'a')
        calls++
        return gate.promise
      }
    }
  })
  await w.refresh()
  const off = w.subscribe(() => {
    if (!joined && w.getSnapshot().loadingOlder) {
      joined = w.loadOlder().then(
        (result) => {
          joinedDone = true
          return result
        },
        () => {
          joinedDone = true
          return { status: 'unexpected-rejection' }
        }
      )
    }
  })
  const first = w.loadOlder()
  await tick()
  assert.equal(joinedDone, false)
  gate.resolve(page([row(1)]))
  assert.equal((await first).status, 'read')
  assert.equal((await joined).status, 'read')
  assert.equal(calls, 1)
  off()
})

test('focus cancelled by loading emission never starts that queued page request', async () => {
  const calls = []
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(1),
      tasks: async ({ cursor }) => {
        calls.push(cursor)
        return page([row(9)], 'old')
      }
    }
  })
  let hidden = false
  const stop = w.subscribe(() => {
    if (!hidden && w.getSnapshot().loadingOlder) {
      hidden = true
      w.setPageVisible({ visible: false })
    }
  })
  assert.equal((await w.focusTask({ taskId: 1 })).status, 'cancelled')
  assert.deepEqual(calls, [undefined])
  stop()
})

for (const artifactId of [null, 0, -1, '88', 1.2]) {
  test(`target invalid artifact identifier ${artifactId} is failed with zero artifact GETs`, async () => {
    let gets = 0
    const { workflow: w } = workflowFixture({
      api: {
        task: async () => row(9, { artifactIds: [artifactId] }),
        tasks: async () => page([]),
        artifact: async () => {
          gets++
          return { id: artifactId, taskId: 9, sessionId: 4 }
        }
      }
    })
    assert.equal((await w.focusTask({ taskId: 9 })).artifacts, 'failed')
    assert.equal(gets, 0)
  })
}

test('latest and older failures retain controlled workflow Notice', async () => {
  let fail = true
  const { workflow: w } = workflowFixture({
    api: {
      tasks: async ({ cursor }) => {
        if (fail || cursor) throw Error('NETWORK')
        return page([row(9)], 'a')
      }
    }
  })
  await w.refresh()
  assert.ok(w.getSnapshot().error)
  fail = false
  await w.refresh()
  assert.equal((await w.loadOlder()).status, 'failed')
  assert.ok(w.getSnapshot().error)
})

test('malformed task artifact collection is controlled rather than a rejected focus promise', async () => {
  const { workflow: w } = workflowFixture({
    api: {
      task: async () => row(9, { artifactIds: {} }),
      tasks: async () => page([])
    }
  })
  assert.equal((await w.focusTask({ taskId: 9 })).reason, 'invalid-task')
})


test('focus metadata failures preserve an existing generation error verbatim', async () => {
  let includeArtifacts = false
  const f = workflowFixture({
    api: {
      task: async () => row(9, { artifactIds: [88] }),
      tasks: async () => page([row(9, { artifactIds: includeArtifacts ? [88] : [] })]),
      account: async () => {
        throw Error('CREDITS_INSUFFICIENT')
      },
      artifact: async () => {
        throw Error('NETWORK')
      }
    }
  })
  await f.workflow.refresh()
  const previous = f.workflow.getSnapshot().error
  assert.match(previous, /积分/)
  includeArtifacts = true
  assert.equal((await f.workflow.focusTask({ taskId: 9 })).artifacts, 'failed')
  assert.equal(f.workflow.getSnapshot().error, previous)
})

test('focus-first shared page is quiet for focus but metadata failure still belongs to ordinary refresh', async () => {
  const waiting = deferred()
  let pages = 0
  const f = workflowFixture({
    api: {
      task: async () => row(9, { artifactIds: [88] }),
      tasks: async () => {
        pages++
        return waiting.promise
      },
      artifact: async () => {
        throw Error('NETWORK')
      }
    }
  })
  const focus = f.workflow.focusTask({ taskId: 9 })
  await tick()
  const refresh = f.workflow.refresh()
  await tick()
  waiting.resolve(page([row(9, { artifactIds: [88] })]))
  const [result] = await Promise.all([focus, refresh])
  assert.equal(result.status, 'focused')
  assert.equal(result.artifacts, 'failed')
  assert.equal(pages, 1)
  assert.ok(f.workflow.getSnapshot().error)
})

test('focus metadata uncertain observation remains pending and does not clear generation errors', async () => {
  let context
  const { workflow: w } = workflowFixture({ api: {
    account: async () => { throw Error('CREDITS_INSUFFICIENT') },
    tasks: async () => page([row(9, { artifactIds: [66] })]),
    task: async () => row(9, { artifactIds: [66] }),
    artifact: async (args) => { context = args; args.onWarning('收藏状态仍待核对'); return { id: 66, taskId: 9, sessionId: 4, isFavorite: false } }
  } })
  await w.refresh()
  const previous = w.getSnapshot().error
  assert.match(previous, /积分/)
  const result = await w.focusTask({ taskId: 9 })
  assert.equal(typeof context.isInterested, 'function')
  assert.equal(result.artifacts, 'pending')
  assert.equal(w.getSnapshot().error, previous)
  assert.equal(w.getSnapshot().artifacts[66].isFavorite, false)
  w.dispose(); assert.equal(context.isInterested(), false)
})
