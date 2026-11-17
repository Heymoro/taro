const React = require('react')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { template, task } = require('./creation.cjs')
const stamp = '2026-11-14T00:00:00.000Z'
const ledger = (id = 1, extra = {}) => ({
  id,
  operation: 'reserve',
  ledgerDelta: 0,
  statusCredits: 3,
  sourceType: 'trial',
  createdAt: stamp,
  reservationId: id,
  taskId: 9,
  availableDelta: -3,
  reservedDelta: 3,
  expiredDelta: 0,
  ...extra,
})
const reservation = (reservationId = 1, extra = {}) => ({
  reservationId,
  taskId: 9,
  sessionId: 4,
  roundNo: 1,
  reservedCredits: 3,
  taskStatus: 'running',
  reviewHint: null,
  ...extra,
})
const gate = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const envelope = (data) => ({ statusCode: 200, data: { data, requestId: 'credit-memory' } })
const failure = (code = 'CREDITS_INSUFFICIENT', retryable = false) => ({
  statusCode: 409,
  data: { error: { code, message: 'private', retryable }, requestId: 'credit-error' },
})

// Actual pages, hooks, pure owners, creationApi, auth and decoders. Only native
// rendering, transport, lifecycle/stack and geometry are memory implementations.
async function withCredits(run, options = {}) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const names = ['credits', 'credit-reservations', 'me', 'create']
  const dom = new JSDOM(names.map((name) => `<div id="${name}"></div>`).join(''))
  const before = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const roots = Object.fromEntries(names.map((name) => [name, createRoot(document.getElementById(name))]))
  const pages = Object.fromEntries(
    names.map((name) => [name, { route: `pages/${name}/index`, options: name === 'create' ? { session: '4' } : {} }])
  )
  let current = options.initial || 'credits',
    foreground = current,
    credential = { userId: 1, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }
  let ledgerRows = options.ledger || [ledger()],
    reservationRows = options.reservations || [reservation()]
  let account = options.account || {
    available: 2,
    reserved: 3,
    sources: [{ sourceType: 'trial', available: 2 }],
    configured: true,
  }
  let quoteError = options.quoteError,
    taskValue = {
      ...task(),
      artifactIds: [],
      inputAvailability: [],
      createdAt: stamp,
      startedAt: stamp,
      finishedAt: null,
      resolution: null,
    }
  const callbacks = new Map(),
    handlers = new Map(),
    calls = [],
    navigation = [],
    ticks = [],
    queries = [],
    toasts = [],
    storage = new Map(),
    tops = new Map()
  const lifecycle = (name) => (fn) => {
    const ref = React.useRef(fn)
    ref.current = fn
    const page = React.useRef(current).current
    React.useEffect(() => {
      if (!callbacks.has(page)) callbacks.set(page, { show: new Set(), hide: new Set() })
      const cb = () => ref.current()
      callbacks.get(page)[name].add(cb)
      return () => callbacks.get(page)[name].delete(cb)
    }, [])
  }
  const fire = (page, event) => {
    current = page
    if (event === 'show') foreground = page
    for (const cb of [...(callbacks.get(page)?.[event] || [])]) cb()
  }
  const component = (tag) => (props) => {
    const name = pages[current] ? current : 'credits'
    if (props.className?.includes('credits-scroll')) handlers.set(`${name}:credits-scroll`, props)
    if (props.className) handlers.set(`${name}:${props.className}`, props)
    if (typeof props.scrollTop === 'number') tops.set(name, props.scrollTop)
    const { children, className, id, onClick, disabled, style, src, value, placeholder } = props
    return React.createElement(
      tag,
      {
        className,
        id,
        onClick,
        disabled,
        style,
        src,
        value,
        placeholder,
        ...(['input', 'textarea'].includes(tag) ? { readOnly: true } : {}),
      },
      children
    )
  }
  const geometry = () => {
    const top = tops.get(foreground) || 0
    let y = 100
    const rows = [...document.querySelectorAll(`#${foreground} .credits-row`)].map((node, index) => {
      const height = options.rowHeights?.[index] || 83
      const result = { id: node.id, top: y - top, bottom: y + height - top, height }
      y += height
      return result
    })
    return [{ top: 100, height: 150, bottom: 250 }, rows, { scrollTop: top, scrollHeight: y - 100 }]
  }
  const native = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    useRouter: () => ({ params: React.useRef(pages[current].options).current }),
    getCurrentInstance: () => ({ page: pages[current] }),
    getCurrentPages: () => [pages[foreground]],
    getStorageInfoSync: () => ({
      keys: [...new Set([...storage.keys(), ...(credential == null ? [] : ['heymoro.user.token'])])],
    }),
    getStorageSync: (key) => (key === 'heymoro.user.token' ? credential : storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: () => {
      throw Error('unexpected logout')
    },
    getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844, statusBarHeight: 20 }),
    getMenuButtonBoundingClientRect: () => ({ top: 28, height: 32, left: 303 }),
    onWindowResize: () => {},
    offWindowResize: () => {},
    onKeyboardHeightChange: () => {},
    offKeyboardHeightChange: () => {},
    nextTick: (cb) => ticks.push(cb),
    showToast: (args) => {
      toasts.push(args)
      return options.toast?.(args)
    },
    navigateTo: (args) => {
      navigation.push(args)
      if (options.navigate) return options.navigate(args)
      args.success?.({})
    },
    navigateBack: () => {},
    switchTab: () => {},
    createSelectorQuery: () => {
      const q = {
        select: () => q,
        selectAll: () => q,
        boundingClientRect: () => q,
        scrollOffset: () => q,
        exec: (cb) => {
          queries.push(cb)
          if (options.geometryGate) options.geometryGate.promise.then(() => cb(geometry()))
          else if (!options.queryNever) cb(geometry())
        },
      }
      return q
    },
  }
  native.request = async (args) => {
    const path = args.url.split('/api/v1')[1],
      url = new URL(path, 'https://local')
    calls.push({ ...args, path })
    const override = await options.request?.({ ...args, path, calls })
    if (override) return override
    let result
    const session = {
      id: 4,
      title: '原来的会话',
      titleSource: 'user',
      mode: 'free',
      templateId: 1,
      lastActivityAt: stamp,
      runningTask: null,
      cover: null,
      draft: { input: { description: '原来的描述', userNotes: '', inputMediaIds: [] }, updatedAt: stamp },
    }
    if (url.pathname === '/me')
      result = { id: credential.userId, displayName: '用户', avatarUrl: null, status: 'active' }
    else if (url.pathname === '/creation-account') result = account
    else if (['/credits/ledger', '/credits/reservations'].includes(url.pathname)) {
      const rows = url.pathname.endsWith('ledger') ? ledgerRows : reservationRows,
        start = Number(url.searchParams.get('cursor') || 0),
        size = options.pageSize || 2,
        hasMore = start + size < rows.length
      result = { items: rows.slice(start, start + size), nextCursor: hasMore ? String(start + size) : null, hasMore }
    } else if (url.pathname === '/creation-sessions') result = { items: [], nextCursor: null, hasMore: false }
    else if (url.pathname === '/creation-sessions/4') result = session
    else if (url.pathname === '/creation-sessions/4/draft')
      result = args.method === 'PUT' ? { input: args.data, updatedAt: stamp } : session.draft
    else if (url.pathname === '/creation-sessions/4/generations')
      result = { items: [], nextCursor: null, hasMore: false }
    else if (url.pathname === '/creation-presets/free') result = template()
    else if (url.pathname === '/generation-quotes') {
      if (quoteError) return failure(quoteError)
      result = { costCredits: 3, templateId: 1, quoteToken: 'quote', validUntil: '2099-01-01T00:00:00.000Z' }
    } else if (url.pathname === '/generations/9') result = taskValue
    else throw Error(`unexpected ${args.method} ${path}`)
    return envelope(result)
  }
  const mocks = {
    '@tarojs/taro': native,
    '@tarojs/components': {
      View: component('div'),
      ScrollView: component('section'),
      Button: component('button'),
      Text: component('span'),
      Image: component('img'),
      Input: component('input'),
      Textarea: component('textarea'),
    },
  }
  // Load one graph, not one API singleton per page. This also preserves auth epochs.
  const api = load('src/creation-api.js', mocks)
  const accountModule = load('src/use-account.js', { ...mocks, './creation-api': api })
  const allMocks = { ...mocks, '../../creation-api': api, '../../use-account': accountModule }
  const Components = {}
  const render = (name = current) => {
    current = name
    if (!Components[name]) Components[name] = load(`src/pages/${name}/index.jsx`, allMocks).default
    roots[name].render(React.createElement(Components[name]))
  }
  const act = React.act
  const flush = async () =>
    act(async () => {
      while (ticks.length) ticks.shift()()
      await Promise.resolve()
    })
  const mount = async (name = current) => {
    foreground = name
    await act(async () => render(name))
    await act(async () => fire(name, 'show'))
    await flush()
  }
  const click = (name, text) => {
    const node = [...document.querySelectorAll(`#${name} button`)].find(
      (n) => n.textContent.replace(' · 正在打开…', '') === text
    )
    assert.ok(node, `${name}: ${text}`)
    node.click()
  }
  try {
    await run({
      act,
      render,
      mount,
      fire,
      flush,
      click,
      native,
      calls,
      navigation,
      ticks,
      queries,
      toasts,
      handlers,
      storage,
      pages,
      api: api.creationApi,
      text: (name = current) => document.getElementById(name).textContent,
      handler: (name = current) => handlers.get(`${name}:credits-scroll`),
      scroll: (top, name = current) => {
        tops.set(name, top)
        handlers.get(`${name}:credits-scroll`).onScroll?.({ detail: { scrollTop: top } })
      },
      setAccount: (value) => (account = value),
      setRows: (rows) => (ledgerRows = rows),
      setReservations: (rows) => (reservationRows = rows),
      setTask: (value) => (taskValue = { ...taskValue, ...value }),
      setCredential: (value) => (credential = value),
      getCredential: () => credential,
      setForeground: (name) => (foreground = name),
      setQuoteError: (value) => (quoteError = value),
      unmount: (name = current) => roots[name].render(null),
    })
  } finally {
    await act(async () => Object.values(roots).forEach((root) => root.unmount()))
    dom.window.close()
    Object.assign(global, { window: before.window, document: before.document, IS_REACT_ACT_ENVIRONMENT: before.act })
  }
}
module.exports = { withCredits, ledger, reservation, gate, envelope, failure }
