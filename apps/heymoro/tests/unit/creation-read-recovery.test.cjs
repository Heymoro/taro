const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture, task } = require('../fixtures/creation.cjs')
const offline = () =>
  Object.assign(Error('REQUEST_OUTCOME_UNKNOWN'), {
    name: 'ApiResponseError',
    code: 'REQUEST_OUTCOME_UNKNOWN',
    status: null,
    isOutcomeUnknown: true
  })
const gate = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const clone = (v) => JSON.parse(JSON.stringify(v))
async function fixture(options = {}) {
  const f = workflowFixture({
    ...options,
    api: {
      tasks: async () => ({
        items: [task({}, { artifactIds: [66, 67] })],
        hasMore: false,
        nextCursor: null
      })
    }
  })
  await f.workflow.restore()
  return f
}
function trace(f, failing, error = offline()) {
  const calls = []
  for (const method of ['account', 'getSession', 'freePreset', 'tasks', 'task', 'artifact']) {
    const original = f.api[method]
    f.api[method] = async (...args) => {
      calls.push(method)
      if (method === failing) throw error
      return original(...args)
    }
  }
  return calls
}
test('first account transport stops fanout and preserves known facts and frozen journal', async () => {
  const f = await fixture()
  f.workflow.setDescription('preserved')
  f.api.generate = async () => {
    throw offline()
  }
  await f.workflow.prepareQuote()
  // Active tasks already protect the generation path; use last-known state as the invariant.
  const before = f.workflow.getSnapshot(),
    saved = clone([...f.saved]),
    writes = f.writes.length
  const calls = trace(f, 'account')
  assert.equal((await f.workflow.refresh()).status, 'offline')
  assert.deepEqual(calls, ['account'])
  const after = f.workflow.getSnapshot()
  for (const name of [
    'account',
    'session',
    'template',
    'mode',
    'rounds',
    'artifacts',
    'submission',
    'sessionRequest'
  ])
    assert.deepEqual(after[name], before[name])
  assert.deepEqual(clone([...f.saved]), saved)
  assert.equal(f.writes.length, writes)
  assert.equal(f.workflow.shouldPoll(), true)
  assert.equal(after.readRecovery.failureCount, 1)
})
for (const method of ['getSession', 'freePreset', 'tasks', 'task', 'artifact'])
  test(`first ${method} transport stops that read chain`, async () => {
    const f = await fixture(),
      calls = trace(f, method)
    const before = f.workflow.getSnapshot()
    assert.equal((await f.workflow.refresh()).status, 'offline')
    assert.equal(calls.at(-1), method)
    assert.equal(calls.filter((c) => c === method).length, 1)
    assert.deepEqual(f.workflow.getSnapshot().template, before.template)
  })
for (const error of [
  Object.assign(Error('NOT_FOUND'), { code: 'NOT_FOUND', status: 404 }),
  Object.assign(Error('INVALID_RESPONSE'), { code: 'INVALID_RESPONSE', isOutcomeUnknown: true }),
  Error('NETWORK')
])
  test(`nontransport ${error.message} remains degraded with independent history`, async () => {
    const f = await fixture(),
      calls = trace(f, 'freePreset', error)
    assert.equal((await f.workflow.refresh()).status, 'degraded')
    assert.ok(calls.includes('tasks'))
    assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, 0)
  })
for (const method of ['account', 'getSession', 'freePreset', 'tasks', 'task', 'artifact'])
  for (const action of ['hide', 'hide-show', 'dispose', 'obsolete'])
    test(`${method} await boundary cancels ${action} without later IO or adoption`, async () => {
      let current = true
      const f = await fixture({ isCurrent: () => current }),
        g = gate(),
        entered = gate(),
        original = f.api[method],
        calls = []
      for (const name of ['account', 'getSession', 'freePreset', 'tasks', 'task', 'artifact']) {
        const fn = f.api[name]
        f.api[name] = async (...args) => {
          calls.push(name)
          if (name === method) {
            entered.resolve()
            await g.promise
            return original(...args)
          }
          return fn(...args)
        }
      }
      const flight = f.workflow.refresh()
      await entered.promise
      assert.equal(calls.at(-1), method)
      const before = f.workflow.getSnapshot()
      if (action === 'dispose' || action === 'obsolete') {
        current = false
        if (action === 'dispose') f.workflow.dispose()
      } else {
        f.workflow.setPageVisible({ visible: false })
        if (action === 'hide-show') f.workflow.setPageVisible({ visible: true })
      }
      const count = calls.length
      g.resolve()
      assert.equal((await flight).status, 'cancelled')
      assert.equal(calls.length, count)
      for (const name of ['account', 'session', 'template', 'rounds', 'artifacts'])
        assert.deepEqual(f.workflow.getSnapshot()[name], before[name])
      assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, 0)
      assert.equal(current, !['dispose', 'obsolete'].includes(action))
    })
test('restore transport retains local snapshot and skips preview and quote tail', async () => {
  let previews = 0,
    quotes = 0
  const saved = new Map([
    [
      'session:4',
      {
        protocol: 2,
        mode: 'free',
        sessionId: 4,
        templateId: 1,
        templateVersionId: 2,
        description: 'local',
        draftPaused: false, recoveryKey: 'unsettled:session:4',
        userNotes: '',
        photos: [{ id: 'p', mediaId: 15, status: 'ready', path: '' }],
        sessionRequest: null,
        submission: null
      }
    ]
  ])
  const f = workflowFixture({
    saved,
    api: {
      account: async () => {
        throw offline()
      },
      quote: async () => {
        quotes++
        throw Error('unexpected')
      }
    },
    files: {
      preview: async () => {
        previews++
        return '/private.png'
      }
    }
  })
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().description, 'local')
  assert.equal(f.workflow.getSnapshot().readRecovery.phase, 'offline')
  assert.equal(previews, 0)
  assert.equal(quotes, 0)
})
test('refresh publishes singleflight before emit and joins concurrent manual/poll without reset', async () => {
  const f = await fixture(),
    g = gate()
  let reads = 0,
    joined
  f.api.account = async () => {
    reads++
    await g.promise
    throw offline()
  }
  const unsub = f.workflow.subscribe(() => {
    if (f.workflow.getSnapshot().readRecovery?.phase === 'reading')
      joined = f.workflow.refresh({ reason: 'poll' })
  })
  const one = f.workflow.refresh(),
    two = f.workflow.refresh()
  assert.equal(one, two)
  await Promise.resolve()
  assert.equal(joined, one)
  assert.equal(reads, 1)
  g.resolve()
  assert.equal((await one).status, 'offline')
  unsub()
  assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, 1)
})
test('degraded does not reset transport streak and complete success clears only its own read error', async () => {
  const f = workflowFixture()
  await f.workflow.restore()
  const account = f.api.account,
    config = f.api.freePreset
  f.api.account = async () => {
    throw offline()
  }
  await f.workflow.refresh()
  const first = f.workflow.getSnapshot().readRecovery
  f.api.account = account
  f.api.freePreset = async () => {
    throw Error('TEMPLATE_UNAVAILABLE')
  }
  assert.equal((await f.workflow.refresh()).status, 'degraded')
  assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, first.failureCount)
  const businessError = f.workflow.getSnapshot().error
  f.api.freePreset = config
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, 0)
  assert.equal(f.workflow.getSnapshot().error, businessError)
  f.api.account = async () => {
    throw offline()
  }
  await f.workflow.refresh()
  f.api.account = account
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().error, '')
})
test('shared history flight retains an independent caller interest and transport tag is local only', async () => {
  const { load } = require('../source.cjs')
  const { createTaskHistory } = load('src/features/creation/task-history.js')
  const g = gate()
  let interested = true,
    merged = 0,
    artifactReads = 0
  const h = createTaskHistory({
    api: {
      tasks: async () => {
        await g.promise
        return { items: [task()], hasMore: false, nextCursor: null }
      }
    },
    readHistory: () => ({ sessionId: 4, rounds: [] }),
    mergePage: () => {
      merged++
    },
    mergeTarget: () => {},
    setLoadingOlder: () => {},
    readArtifacts: async () => {
      artifactReads++
      return 'fresh'
    },
    isCurrent: () => true,
    canFocus: () => true
  })
  const refresh = h.readLatest({ isInterested: () => interested }),
    other = h.readLatest()
  interested = false
  g.resolve()
  assert.equal((await refresh).status, 'cancelled')
  assert.equal((await other).status, 'read')
  assert.equal(merged, 1)
  assert.equal(artifactReads, 1)
})
test('early entry preset transport restores local snapshot, settles once, and stops all tail IO', async () => {
  const calls = []
  const saved = new Map([
    [
      'owner:1:free',
      {
        protocol: 2,
        mode: 'free',
        sessionId: null,
        templateId: 1,
        templateVersionId: 2,
        description: 'local entry',
        draftPaused: false, recoveryKey: 'unsettled:template:free',
        userNotes: '',
        photos: [],
        submission: null,
        sessionRequest: null
      }
    ]
  ])
  const before = JSON.stringify([...saved])
  const f = workflowFixture({
    saved,
    template: null,
    sessionId: null,
    api: {
      freePreset: async () => {
        calls.push('preset')
        throw offline()
      },
      account: async () => {
        calls.push('account')
        return {}
      },
      quote: async () => {
        calls.push('quote')
        throw Error('unexpected')
      }
    }
  })
  const result = await f.workflow.restore()
  assert.deepEqual(calls, ['preset'])
  assert.equal(result.status, 'offline')
  assert.equal(f.workflow.getSnapshot().description, 'local entry')
  assert.equal(f.workflow.getSnapshot().readRecovery.failureCount, 1)
  assert.equal(JSON.stringify([...saved]), before)
})
test('synchronous hide during history merge stops cursor adoption and artifact IO', async () => {
  const f = workflowFixture()
  let artifacts = 0
  f.api.tasks = async () => ({
    items: [task({}, { artifactIds: [66] })],
    hasMore: true,
    nextCursor: 'frontier'
  })
  f.api.artifact = async () => {
    artifacts++
    throw Error('unexpected')
  }
  let hidden = false
  f.workflow.subscribe(() => {
    if (!hidden && f.workflow.getSnapshot().rounds.length) {
      hidden = true
      f.workflow.setPageVisible({ visible: false })
    }
  })
  assert.equal((await f.workflow.refresh()).status, 'cancelled')
  assert.equal(artifacts, 0)
  assert.equal(f.workflow.getSnapshot().olderCursor, null)
})

test('offline and restored reads preserve a frozen pending confirmation error and journal', async () => {
  const f = workflowFixture({
    submit: async () => {
      throw offline()
    }
  })
  await f.workflow.restore()
  f.workflow.setDescription('frozen submission')
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  const before = f.workflow.getSnapshot()
  const journal = clone([...f.saved])
  assert.ok(before.submission)
  assert.match(before.error, /提交结果待确认/)
  const account = f.api.account
  f.api.account = async () => {
    throw offline()
  }
  assert.equal((await f.workflow.refresh()).status, 'offline')
  assert.equal(f.workflow.getSnapshot().error, before.error)
  f.api.account = account
  assert.equal((await f.workflow.refresh()).status, 'ok')
  const restored = f.workflow.getSnapshot()
  assert.equal(restored.error, before.error)
  assert.deepEqual(restored.submission, before.submission)
  assert.deepEqual(clone([...f.saved]), journal)
  assert.equal(f.sent.length, 1)
})

test('synchronous late business error during read feedback is not owned or cleared by recovery', async () => {
  const f = workflowFixture()
  await f.workflow.restore()
  const account = f.api.account
  let injected = false
  const unsubscribe = f.workflow.subscribe(() => {
    const state = f.workflow.getSnapshot()
    if (!injected && state.readRecovery.phase === 'reading' && state.error) {
      injected = true
      // Empty input fails synchronously in the generate lane; this is not a read error.
      f.workflow.generate()
    }
  })
  f.api.account = async () => {
    throw offline()
  }
  await f.workflow.refresh()
  assert.equal(injected, true)
  const businessError = f.workflow.getSnapshot().error
  assert.notEqual(businessError, '暂时连接不上，输入已保留，请重试')
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().error, businessError)
  f.api.account = account
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().error, businessError)
  assert.equal(f.sent.length, 0)
  unsubscribe()
})

test('unconfigured WeChat is configuration feedback with preserved input, not transport backoff', async () => {
  const f = await fixture()
  f.workflow.setDescription('保留现有输入')
  const saved = clone([...f.saved])
  const writes = f.writes.length
  trace(f, 'account', Object.assign(Error('AUTH_UNCONFIGURED'), {
    code: 'AUTH_UNCONFIGURED', status: 503, retryable: false, isOutcomeUnknown: false
  }))
  assert.equal((await f.workflow.refresh()).status, 'degraded')
  const after = f.workflow.getSnapshot()
  assert.equal(after.error, '微信登录尚未配置，输入已保留')
  assert.doesNotMatch(after.error, /网络|重试/)
  assert.equal(after.description, '保留现有输入')
  assert.equal(after.readRecovery.failureCount, 0)
  assert.equal(after.readRecovery.phase, 'degraded')
  assert.deepEqual(clone([...f.saved]), saved)
  assert.equal(f.writes.length, writes)
  assert.equal(f.sent.length, 0)
})
