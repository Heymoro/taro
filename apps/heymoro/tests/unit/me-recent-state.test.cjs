const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')

const EMPTY = '暂无记录'
const ERROR = '暂时连接不上，请重试'
const page = (items = [], nextCursor = null) => ({ items, nextCursor, hasMore: !!nextCursor })
const recent = (id = 4) => ({ id, title: `创作 ${id}` })

// Real MePage, primitives and cursor hook/controller; synthetic account/API/native boundaries.
// The captured hook delegates to the original implementation, never inventing list snapshots.
async function withMe(run, initialAccount = {}) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT,
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const reads = [],
    unexpectedApis = [],
    actions = [],
    callbacks = { show: new Set(), hide: new Set() }
  let sessions
  let account = {
    accountKey: 'account-a',
    user: { id: 1, displayName: '原昵称' },
    loading: false,
    error: '',
    refresh: async () => actions.push(['account-refresh']),
    ...initialAccount,
  }
  const lifecycle = (name) => (callback) => {
    const latest = React.useRef(callback)
    latest.current = callback
    React.useLayoutEffect(() => {
      const call = () => latest.current()
      callbacks[name].add(call)
      return () => callbacks[name].delete(call)
    }, [])
  }
  const native = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    navigateTo: ({ url }) => actions.push(['navigate', url]),
    switchTab: ({ url }) => actions.push(['tab', url]),
    showModal: async (options) => {
      actions.push(['modal', { ...options }])
      return { confirm: false }
    },
  }
  const creationApi = new Proxy(
    {
      sessions(args) {
        let resolve, reject
        const promise = new Promise((yes, no) => {
          resolve = yes
          reject = no
        })
        reads.push({ kind: 'sessions', args, resolve, reject })
        return promise
      },
      account: async () => {
        reads.push({ kind: 'account' })
        return { available: 23, reserved: 7 }
      },
    },
    {
      get(target, key) {
        if (!Object.hasOwn(target, key)) unexpectedApis.push(String(key))
        assert.ok(Object.hasOwn(target, key), `unexpected business API ${String(key)}`)
        return target[key]
      },
    }
  )
  const { useCursorList } = load('src/use-cursor-list.js', { '@tarojs/taro': native })
  const component =
    (tag) =>
    ({ children, className, onClick, style, src, disabled }) =>
      React.createElement(tag, { className, onClick, style, src, disabled }, children)
  const MePage = load('src/pages/me/index.jsx', {
    '@tarojs/taro': native,
    '@tarojs/components': {
      View: component('div'),
      ScrollView: component('div'),
      Text: component('span'),
      Button: component('button'),
      Image: component('img'),
    },
    '../../use-account': { useAccount: () => account, creationAccountKey: () => account.accountKey },
    '../../creation-api': { creationApi, invalidateCreationUser: () => actions.push(['invalidate']) },
    '../../auth': { updateCurrentUser: () => assert.fail('unexpected nickname write') },
    '../../use-cursor-list': {
      useCursorList(args) {
        sessions = useCursorList(args)
        return sessions
      },
    },
  }).default
  const root = createRoot(document.getElementById('root'))
  const act = React.act
  const h = {
    act,
    reads,
    actions,
    text: () => document.getElementById('root').textContent,
    loading: () => document.querySelectorAll('.settings-group .brand--animated').length,
    notices: () => [...document.querySelectorAll('.settings-group .notice')],
    sessionReads: () => reads.filter(({ kind }) => kind === 'sessions'),
    get sessions() {
      return sessions
    },
    click(label) {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label)
      assert.ok(button, `missing button ${label}`)
      button.click()
    },
    setAccount(value) {
      account = { ...account, ...value }
      root.render(React.createElement(MePage))
    },
    show() {
      for (const callback of [...callbacks.show]) callback()
    },
  }
  try {
    await act(async () => root.render(React.createElement(MePage)))
    await run(h)
    assert.deepEqual(unexpectedApis, [], 'no generation, favorite, input or other business write API')
    assert.ok(reads.every(({ kind }) => kind === 'sessions' || kind === 'account'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    global.window = previous.window
    global.document = previous.document
    global.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
}

function noEmpty(h) {
  assert.ok(!h.text().includes(EMPTY), 'unconfirmed recent list must not be presented as empty')
  assert.ok(!h.text().includes('去创作 ›'))
}

test('Me pending initial real cursor read shows loading, never unconfirmed empty', async () => {
  await withMe(async (h) => {
    assert.equal(h.sessionReads().length, 1)
    noEmpty(h)
    assert.equal(h.loading(), 1)
    assert.equal(h.notices().length, 0)
  })
})

test('Me failed initial real cursor read shows one read-only retry, never empty', async () => {
  await withMe(async (h) => {
    await h.act(async () => h.sessionReads()[0].reject(Error('NETWORK')))
    noEmpty(h)
    assert.equal(h.loading(), 0)
    assert.equal(h.notices().length, 1)
    assert.match(h.notices()[0].textContent, new RegExp(ERROR))
    assert.equal(h.sessionReads().length, 1, 'no automatic retry')
  })
})

for (const items of [[], [recent()]])
  test(`Me explicit error retry remains loading then resolves ${
    items.length ? 'recent' : 'confirmed empty'
  }`, async () => {
    await withMe(async (h) => {
      await h.act(async () => h.sessionReads()[0].reject(Error('NETWORK')))
      await h.act(async () => h.click('重试'))
      noEmpty(h)
      assert.equal(h.loading(), 1)
      assert.equal(h.notices().length, 0)
      assert.equal(h.sessionReads().length, 2)
      assert.equal(h.sessionReads()[1].args.cursor, undefined)
      await h.act(async () => h.sessionReads()[1].resolve(page(items)))
      assert.equal(h.loading(), 0)
      assert.equal(h.notices().length, 0)
      assert.equal(h.text().includes(EMPTY), !items.length)
      assert.equal(h.text().includes('去创作 ›'), !items.length)
      assert.equal(h.text().includes('创作 4'), !!items.length)
      assert.deepEqual(h.actions, [])
    })
  })

test('Me confirmed empty appears only after successful exhausted read, with original creation navigation', async () => {
  await withMe(async (h) => {
    await h.act(async () => h.sessionReads()[0].resolve(page()))
    assert.ok(h.text().includes(EMPTY))
    assert.equal(h.loading(), 0)
    assert.equal(h.notices().length, 0)
    assert.equal(h.sessionReads().length, 1)
    await h.act(async () => h.click('去创作 ›'))
    assert.deepEqual(h.actions, [['tab', '/pages/effects/index']])
  })
})

for (const items of [[], [recent(5)]])
  test(`Me empty nonterminal page explicitly continues once to ${items.length ? 'recent' : 'EOF'}`, async () => {
    await withMe(async (h) => {
      await h.act(async () => h.sessionReads()[0].resolve(page([], 'cursor-next')))
      noEmpty(h)
      assert.equal(h.loading(), 0)
      assert.equal(h.sessionReads().length, 1, 'empty pages do not auto-loop')
      await h.act(async () => h.click('继续读取'))
      assert.equal(h.sessionReads().length, 2)
      assert.equal(h.sessionReads()[1].args.cursor, 'cursor-next')
      noEmpty(h)
      assert.equal(h.loading(), 1)
      await h.act(async () => h.sessionReads()[1].resolve(page(items)))
      assert.equal(h.text().includes(EMPTY), !items.length)
      assert.equal(h.text().includes('创作 5'), !!items.length)
      assert.ok(!h.text().includes('继续读取'))
      assert.equal(h.sessionReads().length, 2)
      assert.deepEqual(h.actions, [])
    })
  })

test('Me same-controller recent remains during continuation loading and failure, with original navigation and wallet', async () => {
  await withMe(async (h) => {
    await h.act(async () => h.sessionReads()[0].resolve(page([recent()], 'cursor-next')))
    assert.match(h.text(), /原昵称/)
    assert.match(h.text(), /23 点/)
    assert.match(h.text(), /7 点/)
    await h.act(async () => {
      h.sessions.load()
    })
    assert.match(h.text(), /创作 4/)
    noEmpty(h)
    assert.equal(h.loading(), 0, 'an existing recent card is not replaced by loading')
    await h.act(async () => h.sessionReads()[1].reject(Error('NETWORK')))
    assert.match(h.text(), /创作 4/)
    assert.equal(h.notices().length, 1)
    noEmpty(h)
    await h.act(async () => h.click('重试'))
    assert.equal(h.sessionReads()[2].args.cursor, 'cursor-next', 'error retry uses original load')
    assert.match(h.text(), /创作 4/)
    await h.act(async () => h.sessionReads()[2].resolve(page()))
    assert.match(h.text(), /创作 4/)
    await h.act(async () => {
      document.querySelector('.recent-session').click()
      document.querySelector('.settings-row--tall').click()
      h.click('查看全部 ›')
      document.querySelector('.profile-row').click()
    })
    assert.deepEqual(h.actions.slice(0, 3), [
      ['navigate', '/pages/create/index?session=4'],
      ['navigate', '/pages/cabinet/index'],
      ['navigate', '/pages/sessions/index'],
    ])
    assert.deepEqual(h.actions[3], [
      'modal',
      {
        title: '编辑昵称',
        editable: true,
        placeholderText: '原昵称',
        confirmText: '保存',
      },
    ])
  })
})

for (const items of [[], [recent()]])
  test(`Me ${
    items.length ? 'recent' : 'empty'
  } warning is visible and retries through original read-only refresh`, async () => {
    await withMe(async (h) => {
      await h.act(async () => {
        h.sessionReads()[0].args.onWarning('作品状态正在更新，请重试读取')
        h.sessionReads()[0].resolve(page(items))
      })
      noEmpty(h)
      assert.equal(h.notices().length, 1)
      assert.match(h.notices()[0].textContent, /作品状态正在更新，请重试读取/)
      assert.equal(h.text().includes('创作 4'), !!items.length)
      assert.equal(h.sessionReads().length, 1)
      await h.act(async () => h.click('重试'))
      assert.equal(h.sessionReads().length, 2)
      assert.equal(h.sessionReads()[1].args.cursor, undefined, 'warning retries original refresh from first page')
      noEmpty(h)
      assert.equal(h.loading(), 1)
      await h.act(async () => h.sessionReads()[1].resolve(page()))
      assert.ok(h.text().includes(EMPTY))
      assert.equal(h.notices().length, 0)
      assert.deepEqual(h.actions, [])
    })
  })

test('Me error takes priority over retained warning with exactly one Notice and load retry', async () => {
  await withMe(async (h) => {
    await h.act(async () => {
      h.sessionReads()[0].args.onWarning('前次读取尚待核对')
      h.sessionReads()[0].resolve(page([recent()], 'warn-cursor'))
    })
    await h.act(async () => {
      h.sessions.load()
    })
    await h.act(async () => h.sessionReads()[1].reject(Error('NETWORK')))
    assert.equal(h.sessions.warning, '前次读取尚待核对')
    assert.equal(h.notices().length, 1)
    assert.match(h.notices()[0].textContent, new RegExp(ERROR))
    assert.ok(!h.notices()[0].textContent.includes('前次读取尚待核对'))
    assert.match(h.text(), /创作 4/)
    noEmpty(h)
    await h.act(async () => h.click('重试'))
    assert.equal(h.sessionReads()[2].args.cursor, 'warn-cursor')
    await h.act(async () => h.sessionReads()[2].resolve(page()))
    assert.equal(h.notices().length, 0)
  })
})

for (const initialAccount of [
  { user: null, loading: true },
  { user: null, error: '账号读取失败' },
  { loading: true },
  { error: '账号复核失败' },
])
  test(`Me unready account never confirms empty: ${JSON.stringify(initialAccount)}`, async () => {
    await withMe(async (h) => {
      noEmpty(h)
      if (h.sessionReads().length) {
        await h.act(async () => h.sessionReads()[0].resolve(page()))
        assert.equal(h.sessions.loaded, true)
        noEmpty(h)
      } else assert.equal(h.reads.length, 0)
      await h.act(async () => h.setAccount({ user: { id: 1, displayName: '原昵称' }, loading: false, error: '' }))
      if (!h.sessions.loaded) await h.act(async () => h.sessionReads()[0].resolve(page()))
      assert.ok(h.text().includes(EMPTY))
    }, initialAccount)
  })

test('Me account revalidation hides previously confirmed empty until account is ready again', async () => {
  await withMe(async (h) => {
    await h.act(async () => h.sessionReads()[0].resolve(page()))
    assert.ok(h.text().includes(EMPTY))
    await h.act(async () => h.setAccount({ loading: true }))
    noEmpty(h)
    await h.act(async () => h.setAccount({ loading: false, error: '账号复核失败' }))
    noEmpty(h)
    await h.act(async () => h.setAccount({ error: '' }))
    assert.ok(h.text().includes(EMPTY))
    assert.equal(h.sessionReads().length, 1)
  })
})

for (const resolvedBeforeSwitch of [false, true])
  test(`Me account switch rejects old-account ${resolvedBeforeSwitch ? 'loaded card' : 'late response'}`, async () => {
    await withMe(async (h) => {
      if (resolvedBeforeSwitch) await h.act(async () => h.sessionReads()[0].resolve(page([recent(99)])))
      await h.act(async () => h.setAccount({ accountKey: 'account-b', user: { id: 2, displayName: '新账号' } }))
      noEmpty(h)
      assert.ok(!h.text().includes('创作 99'))
      assert.equal(h.loading(), 1)
      assert.equal(h.sessionReads().length, 2)
      assert.equal(h.sessionReads()[0].args.isInterested(), false)
      if (!resolvedBeforeSwitch) await h.act(async () => h.sessionReads()[0].resolve(page([recent(99)])))
      noEmpty(h)
      assert.ok(!h.text().includes('创作 99'))
      assert.equal(h.loading(), 1)
      await h.act(async () => h.sessionReads()[1].resolve(page()))
      assert.ok(h.text().includes(EMPTY))
      assert.ok(!h.text().includes('创作 99'))
    })
  })

test('Me native show retains original reset semantics, not a second recent snapshot', async () => {
  await withMe(async (h) => {
    await h.act(async () => h.sessionReads()[0].resolve(page([recent()])))
    await h.act(async () => h.show())
    assert.equal(h.sessionReads().length, 2)
    assert.equal(h.sessions.items.length, 0)
    assert.ok(!h.text().includes('创作 4'))
    noEmpty(h)
    assert.equal(h.loading(), 1)
    await h.act(async () => h.sessionReads()[1].resolve(page()))
    assert.ok(h.text().includes(EMPTY))
  })
})
