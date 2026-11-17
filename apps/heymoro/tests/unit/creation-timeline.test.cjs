const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')
const { workflowFixture, task } = require('../fixtures/creation.cjs')
const row = (id, extra = {}) =>
  task({}, { id, roundNo: id, status: 'succeeded', artifactIds: [], ...extra })
const page = (items, cursor = null) => ({ items, nextCursor: cursor, hasMore: cursor !== null })
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function withTimeline(run, options = {}) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const events = { show: new Set(), hide: new Set() }
  const lifecycle = (name) => (fn) => {
    const ref = React.useRef(fn)
    ref.current = fn
    React.useEffect(() => {
      const cb = () => ref.current()
      events[name].add(cb)
      return () => events[name].delete(cb)
    }, [])
  }
  const nativePage = { route: 'pages/create/index' }
  let pages = [nativePage]
  let key = 'owner',
    ready = options.ready !== false,
    focusTaskId = options.focusTaskId
  const ticks = [],
    measures = []
  const native = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    getCurrentInstance: () => ({ page: nativePage }),
    getCurrentPages: () => pages,
    nextTick: (cb) => ticks.push(cb),
    createSelectorQuery: () => ({
      select() {
        return this
      },
      boundingClientRect(cb) {
        measures.push(cb)
        return this
      },
      exec() {}
    })
  }
  const f = workflowFixture({
    api: {
      tasks: async () => page([row(9)]),
      task: async ({ taskId }) => row(taskId),
      ...options.api
    }
  })
  const { useCreationTimeline } = load('src/features/creation/use-creation-timeline.js', {
    '@tarojs/taro': native,
    '../../use-account': { creationAccountKey: () => key }
  })
  let timeline
  function Probe() {
    const state = React.useSyncExternalStore(f.workflow.subscribe, f.workflow.getSnapshot)
    timeline = useCreationTimeline({
      account: { accountKey: key },
      workflow: f.workflow,
      state,
      restored: ready,
      focusTaskId
    })
    return React.createElement('div', { 'data-anchor': timeline.anchor }, timeline.notice?.message)
  }
  const render = () => root.render(React.createElement(Probe))
  const act = React.act
  try {
    await run({
      f,
      act,
      render,
      events,
      ticks,
      measures,
      nativePage,
      native,
      setPages: (value) => {
        pages = value
      },
      get timeline() {
        return timeline
      },
      setReady: (value) => {
        ready = value
      },
      setKey: (value) => {
        key = value
      },
      setFocus: (value) => {
        focusTaskId = value
      },
      fire: (name) => {
        for (const cb of events[name]) cb()
      },
      flush: async () => {
        await act(async () => {
          while (ticks.length) ticks.shift()()
        })
      }
    })
  } finally {
    await act(async () => root.unmount())
    f.workflow.dispose()
    dom.window.close()
    Object.assign(global, {
      window: previous.window,
      document: previous.document,
      IS_REACT_ACT_ENVIRONMENT: previous.act
    })
  }
}

test('route focus suppresses first-frame auto-follow and waits restored plus visible', async () => {
  let reads = 0
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      assert.equal(h.timeline.anchor, '')
      assert.equal(reads, 0)
      await h.act(async () => h.fire('hide'))
      h.setReady(true)
      await h.act(async () => h.render())
      assert.equal(reads, 0)
      await h.act(async () => h.fire('show'))
      await h.flush()
      assert.equal(reads, 1)
      assert.equal(h.timeline.anchor, 'round-9')
    },
    {
      ready: false,
      focusTaskId: 9,
      api: {
        task: async () => {
          reads++
          return row(9)
        }
      }
    }
  )
})

test('preserve reads an old task but never sends a scrollIntoView command', async () => {
  await withTimeline(async (h) => {
    await h.act(async () => h.render())
    await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'preserve' }))
    await h.flush()
    assert.equal(h.timeline.anchor, '')
    assert.equal(h.f.workflow.getSnapshot().rounds[0].id, 9)
    assert.equal(h.f.writes.length, 0)
  })
})

test('touch intent wins over late focus and programmatic scroll is not a cancellation', async () => {
  const gate = deferred()
  await withTimeline(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
      await h.act(async () =>
        h.timeline.onScroll({ detail: { scrollHeight: 1000, scrollTop: 500 } })
      )
      assert.equal(h.measures.length, 1)
      await h.act(async () => h.timeline.onUserIntent())
      await h.act(async () => gate.resolve(row(9)))
      await h.flush()
      assert.equal(h.timeline.anchor, '')
      assert.equal(h.timeline.notice, null)
    },
    { api: { task: () => gate.promise } }
  )
})

test('late pagination anchor and old measurement cannot beat a newer source focus', async () => {
  const older = deferred()
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      await h.act(async () => h.timeline.onScroll({ detail: { scrollHeight: 1000, scrollTop: 0 } }))
      let loading
      await h.act(async () => {
        loading = h.timeline.loadOlder()
      })
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
      await h.act(async () => {
        older.resolve(page([row(1)]))
        await loading
      })
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-9')
    },
    { api: { tasks: async ({ cursor }) => (cursor ? older.promise : page([row(9)], 'older')) } }
  )
})

for (const artifacts of ['failed'])
  test(`target ${artifacts} feedback retries read-only`, async () => {
    let reads = 0
    await withTimeline(
      async (h) => {
        await h.act(async () => h.render())
        await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'preserve' }))
        if (artifacts === 'failed') {
          assert.ok(h.timeline.notice?.onRetry)
          assert.equal(h.f.workflow.getSnapshot().error, '')
          const before = reads
          await h.act(async () => h.timeline.notice.onRetry())
          assert.ok(reads > before)
        }
      },
      {
        api: {
          task: async () => row(9, { artifactIds: [88] }),
          artifact: async () => {
            reads++
            throw Error('NETWORK')
          }
        }
      }
    )
  })

test('paused real history scan exposes explicit continue and keeps the frontier', async () => {
  let pages = 0
  await withTimeline(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => h.timeline.focusRound({ taskId: 1, mode: 'reveal' }))
      assert.equal(pages, 20)
      assert.equal(h.timeline.notice.label, '继续定位')
      assert.equal(h.f.workflow.getSnapshot().hasOlder, true)
      await h.act(async () => h.timeline.notice.onRetry())
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-1')
      assert.equal(h.timeline.notice, null)
      assert.equal(pages, 30)
      assert.equal(h.f.writes.length, 0)
    },
    {
      api: {
        task: async () => row(1),
        tasks: async ({ cursor }) => {
          pages++
          const id = cursor ? Number(cursor) : 30
          return page([row(id)], id > 1 ? String(id - 1) : null)
        }
      }
    }
  )
})

test('favorite-protected target is pending, then read-only retry becomes fresh', async () => {
  const favorite = deferred()
  let writes = 0
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      let mutation
      await h.act(async () => {
        mutation = h.f.workflow.toggleFavorite(88)
      })
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'preserve' }))
      assert.match(h.timeline.notice.message, /正在更新/)
      const retry = h.timeline.notice.onRetry
      await h.act(async () => {
        favorite.resolve({ isFavorite: true, savedAt: 'now' })
        await mutation
      })
      await h.act(async () => retry())
      assert.equal(h.timeline.notice, null)
      assert.equal(writes, 1)
      assert.equal(h.f.writes.length, 0)
    },
    {
      api: {
        task: async () => row(9, { artifactIds: [88] }),
        tasks: async () => page([row(9, { artifactIds: [88] })]),
        artifact: async () => ({ id: 88, sessionId: 4, taskId: 9 }),
        favorite: () => {
          writes++
          return favorite.promise
        }
      }
    }
  )
})

test('programmatic upper event after reveal starts no pagination and repeated target reveals again', async () => {
  let older = 0
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
      await h.flush()
      await h.act(async () => h.timeline.loadOlder({ manual: false }))
      assert.equal(older, 0)
      assert.equal(h.timeline.anchor, 'round-9')
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
      assert.equal(h.timeline.anchor, '')
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-9')
      await h.act(async () => h.timeline.loadOlder({ manual: true }))
      await h.flush()
      assert.equal(older, 1)
      assert.equal(h.timeline.anchor, 'round-9')
    },
    {
      api: {
        tasks: async ({ cursor }) => {
          if (cursor) older++
          return cursor ? page([row(1)]) : page([row(9)], 'older')
        }
      }
    }
  )
})

test('a new route focus on the same controller is a new intention, never controller recreation', async () => {
  await withTimeline(
    async (h) => {
      await h.act(async () => h.render())
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-9')
      h.setFocus(8)
      await h.act(async () => h.render())
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-8')
    },
    { focusTaskId: 9 }
  )
})

test('touch immediately suppresses auto-follow before a late near-bottom measurement arrives', async () => {
  let latest = 9
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      await h.act(async () =>
        h.timeline.onScroll({ detail: { scrollHeight: 1000, scrollTop: 900 } })
      )
      await h.act(async () => h.timeline.onUserIntent())
      await h.act(async () => h.measures[0]({ height: 500 }))
      latest = 10
      await h.act(async () => h.f.workflow.refresh())
      await h.flush()
      assert.equal(h.timeline.anchor, '')
    },
    { api: { tasks: async () => page([row(latest)]) } }
  )
})

test('only the newest scroll measurement can re-enable automatic following', async () => {
  let latest = 9
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      await h.act(async () => h.timeline.onUserIntent())
      await h.act(async () =>
        h.timeline.onScroll({ detail: { scrollHeight: 2000, scrollTop: 1700 } })
      )
      await h.act(async () => h.timeline.onScroll({ detail: { scrollHeight: 2000, scrollTop: 0 } }))
      await h.act(async () => h.measures[1]({ height: 500 }))
      await h.act(async () => h.measures[0]({ height: 500 }))
      latest = 10
      await h.act(async () => h.f.workflow.refresh())
      await h.flush()
      assert.equal(h.timeline.anchor, '')
    },
    { api: { tasks: async () => page([row(latest)]) } }
  )
})

test('a queued reveal never writes an anchor beneath another native page before hide arrives', async () => {
  await withTimeline(async (h) => {
    await h.act(async () => h.render())
    await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
    h.setPages([h.nativePage, { route: 'pages/example/index' }])
    await h.flush()
    assert.equal(h.timeline.anchor, '')
    h.setPages([h.nativePage])
    await h.act(async () => h.fire('show'))
    await h.flush()
    assert.equal(h.timeline.anchor, '')
    await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
    await h.flush()
    assert.equal(h.timeline.anchor, 'round-9')
  })
})

test('focus completion beneath another page remains queued until foreground show without a stuck started flag', async () => {
  const gate = deferred()
  let reads = 0
  await withTimeline(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => h.timeline.focusRound({ taskId: 9, mode: 'reveal' }))
      h.setPages([h.nativePage, { route: 'pages/example/index' }])
      await h.act(async () => gate.resolve(row(9)))
      await h.flush()
      assert.equal(h.timeline.anchor, '')
      h.setPages([h.nativePage])
      await h.act(async () => h.fire('show'))
      await h.flush()
      assert.equal(h.timeline.anchor, 'round-9')
      assert.equal(reads, 2)
    },
    {
      api: {
        task: async () => {
          reads++
          return reads === 1 ? gate.promise : row(9)
        }
      }
    }
  )
})

test('a latest scroll measurement beneath another native page cannot change auto-follow eligibility', async () => {
  let latest = 9
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      await h.act(async () => h.timeline.onUserIntent())
      await h.act(async () =>
        h.timeline.onScroll({ detail: { scrollHeight: 2000, scrollTop: 1700 } })
      )
      h.setPages([h.nativePage, { route: 'pages/example/index' }])
      await h.act(async () => h.measures[0]({ height: 500 }))
      await h.act(async () =>
        h.timeline.onScroll({ detail: { scrollHeight: 2000, scrollTop: 1700 } })
      )
      assert.equal(h.measures.length, 1)
      h.setPages([h.nativePage])
      latest = 10
      await h.act(async () => h.f.workflow.refresh())
      await h.flush()
      assert.equal(h.timeline.anchor, '')
    },
    { api: { tasks: async () => page([row(latest)]) } }
  )
})

test('late pagination cannot position an underlying page before hide arrives or replay on show', async () => {
  const older = deferred()
  await withTimeline(
    async (h) => {
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      let loading
      await h.act(async () => {
        loading = h.timeline.loadOlder()
      })
      h.setPages([h.nativePage, { route: 'pages/example/index' }])
      await h.act(async () => {
        older.resolve(page([row(1)]))
        await loading
      })
      await h.flush()
      assert.equal(h.timeline.anchor, '')
      h.setPages([h.nativePage])
      await h.act(async () => h.fire('show'))
      await h.flush()
      assert.equal(h.timeline.anchor, '')
    },
    { api: { tasks: async ({ cursor }) => (cursor ? older.promise : page([row(9)], 'older')) } }
  )
})

test('unknown opener retap preserves feedback and navigation gate until a confirmed original return', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withTimeline(
    async (h) => {
      let calls = 0,
        opened
      h.native.navigateTo = (options) => {
        calls++
        opened = options
      }
      await h.act(async () => {
        await h.f.workflow.refresh()
        h.render()
      })
      await h.flush()
      await h.act(async () => h.timeline.openArtifact({ taskId: 9, artifactId: 88 }))
      await h.act(async () => t.mock.timers.tick(5000))
      assert.match(h.timeline.notice.message, /尚未确认/)
      const notice = h.timeline.notice
      await h.act(async () => h.timeline.openArtifact({ taskId: 9, artifactId: 88 }))
      assert.equal(h.timeline.notice, notice)
      assert.equal(calls, 1)
      await h.act(async () => h.fire('show'))
      await h.act(async () => opened.success({ eventChannel: { emit() {}, off() {} } }))
      assert.equal(h.timeline.notice, null)
      await h.act(async () => h.timeline.openArtifact({ taskId: 9, artifactId: 88 }))
      assert.equal(calls, 2)
    },
    {
      api: {
        tasks: async () => page([row(9, { artifactIds: [88] })]),
        task: async () => row(9, { artifactIds: [88] })
      }
    }
  )
  t.mock.timers.reset()
})
