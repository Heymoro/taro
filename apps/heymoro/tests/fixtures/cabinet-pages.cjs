const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')

const stamp = '2026-11-14T00:00:00.000Z'
const artifact = (id, isFavorite = true) => ({
  id,
  mediaId: id + 100,
  sessionId: 4,
  taskId: 9,
  outputIndex: 1,
  width: 512,
  height: 512,
  mimeType: 'image/png',
  createdAt: stamp,
  isFavorite,
  savedAt: isFavorite ? stamp : null,
})
const gate = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Actual Cabinet + Detail hooks, one actual creation-api/auth graph; only native
// transport, geometry and rendering are simulated. No HTTP server or weapp runtime.
async function withCabinet(
  run,
  {
    rows = [1, 2, 3, 4, 5, 6, 7, 8],
    pageSize = 2,
    favorite = true,
    writeGate,
    outcome = 'success',
    readGate,
    geometryGate,
  } = {}
) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="cabinet"></div><div id="detail"></div>')
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const roots = Object.fromEntries(
    ['cabinet', 'detail'].map((name) => [name, createRoot(document.getElementById(name))])
  )
  const pages = {
    cabinet: { route: 'pages/cabinet/index', options: {} },
    detail: { route: 'pages/artifact/index', options: { id: '4' } },
  }
  let current = 'cabinet',
    visible = 'cabinet',
    credential = { userId: 1, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }
  let version = 0,
    serverRows = rows.map((id) => artifact(id, favorite)),
    scrollTop = 0
  const callbacks = new Map(),
    handlers = new Map(),
    calls = [],
    ticks = [],
    queries = [],
    nativeCalls = []
  const lifecycle = (name) => (fn) => {
    const ref = React.useRef(fn)
    ref.current = fn
    const page = React.useRef(current).current
    React.useEffect(() => {
      if (!callbacks.has(page)) callbacks.set(page, { show: new Set(), hide: new Set() })
      const callback = () => ref.current()
      callbacks.get(page)[name].add(callback)
      return () => callbacks.get(page)[name].delete(callback)
    }, [])
  }
  const fire = (page, event) => {
    current = page
    if (event === 'show') visible = page
    for (const cb of [...(callbacks.get(page)?.[event] || [])]) cb()
  }
  const key = () => `${credential.userId}:${credential.token}:${credential.expiresAt}`
  const geometry = () => {
    const tiles = [...document.querySelectorAll('#cabinet .artifact-tile')].map((node, index) => ({
      id: node.id,
      top: 100 + Math.floor(index / 2) * 150 - scrollTop,
      bottom: 250 + Math.floor(index / 2) * 150 - scrollTop,
      height: 150,
    }))
    return [
      { top: 100, bottom: 250, height: 150 },
      tiles,
      { scrollTop, scrollHeight: Math.ceil(tiles.length / 2) * 150 },
    ]
  }
  const native = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    useRouter: () => ({ params: React.useRef(pages[current].options).current }),
    getCurrentInstance: () => ({ page: pages[current] }),
    getCurrentPages: () => (visible === 'detail' ? [pages.cabinet, pages.detail] : [pages.cabinet]),
    getStorageSync: () => credential,
    removeStorageSync: () => {
      throw Error('unexpected logout')
    },
    nextTick: (cb) => ticks.push(cb),
    navigateTo: (options) => {
      nativeCalls.push(options.url)
      pages.detail.options = { id: new URL(options.url, 'https://local').searchParams.get('id') }
      fire('cabinet', 'hide')
      current = 'detail'
      visible = 'detail'
      options.success?.({})
    },
    navigateBack: (options = {}) => {
      nativeCalls.push('back')
      fire('detail', 'hide')
      fire('cabinet', 'show')
      options.success?.({})
    },
    switchTab: (options) => nativeCalls.push(options.url),
    createSelectorQuery: () => {
      const q = {
        select() {
          return q
        },
        selectAll() {
          return q
        },
        boundingClientRect() {
          return q
        },
        scrollOffset() {
          return q
        },
        exec(cb) {
          queries.push(cb)
          const finish = () => cb?.(geometry())
          if (geometryGate) geometryGate.promise.then(finish)
          else finish()
        },
      }
      return q
    },
  }
  native.request = async ({ url, method = 'GET', data, header }) => {
    const path = url.split('/api/v1')[1]
    calls.push({ path, method, data, header })
    const parsed = new URL(path, 'https://local')
    let result
    if (parsed.pathname === '/artifacts') {
      if (readGate) await readGate({ path, calls })
      const saved = parsed.searchParams.get('saved') === 'true'
      const cursor = parsed.searchParams.get('cursor')
      const start = cursor ? Number(cursor.split(':')[1]) : 0
      const filtered = serverRows.filter((row) => !saved || row.isFavorite)
      const items = filtered.slice(start, start + pageSize)
      const hasMore = start + pageSize < filtered.length
      result = { items, nextCursor: hasMore ? `v${version}:${start + pageSize}` : null, hasMore }
    } else if (/^\/artifacts\/\d+\/favorite$/.test(parsed.pathname)) {
      if (writeGate) await writeGate.promise
      if (outcome === 'unknown')
        return { statusCode: 200, data: { data: { broken: true }, requestId: 'unknown-memory' } }
      if (outcome === 'reject')
        return {
          statusCode: 403,
          data: { error: { code: 'FORBIDDEN', message: 'No', retryable: false }, requestId: 'known-memory' },
        }
      const id = Number(parsed.pathname.split('/')[2])
      const row = serverRows.find((entry) => entry.id === id)
      row.isFavorite = method === 'PUT'
      row.savedAt = row.isFavorite ? stamp : null
      version++
      result = { isFavorite: row.isFavorite, savedAt: row.savedAt }
    } else if (/^\/artifacts\/\d+$/.test(parsed.pathname)) {
      result = serverRows.find((row) => row.id === Number(parsed.pathname.split('/')[2]))
    } else throw Error(`Unexpected ${method} ${path}`)
    return { statusCode: 200, data: { data: result, requestId: 'memory' } }
  }
  const apiExports = load('src/creation-api.js', { '@tarojs/taro': native })
  const accountMock = {
    useAccount: () => ({ user: { id: credential.userId }, accountKey: key() }),
    creationAccountKey: key,
  }
  const component = (tag) => (props) => {
    if (props.className) handlers.set(`${current}:${props.className}`, props)
    if (props.className === 'page-scroll' && typeof props.scrollTop === 'number') scrollTop = props.scrollTop
    const { children, className, id, onClick, disabled } = props
    return React.createElement(tag, { className, id, onClick, disabled }, children)
  }
  const primitives = {
    Action: component('button'),
    Brand: () => null,
    NavBar: ({ canBack }) =>
      canBack && React.createElement('button', { onClick: () => native.navigateBack() }, 'header-back'),
    Notice: ({ children, onRetry, label = '重试' }) =>
      React.createElement(
        'aside',
        null,
        children,
        onRetry && React.createElement('button', { onClick: onRetry }, label)
      ),
  }
  const mocks = {
    '@tarojs/taro': native,
    '@tarojs/components': {
      View: component('div'),
      ScrollView: component('section'),
      Button: component('button'),
      Text: component('span'),
    },
    '../../use-account': accountMock,
    '../../creation-api': apiExports,
    '../../components/primitives': primitives,
    '../../components/PrivateImage': ({ onClick }) => React.createElement('button', { onClick }, 'image'),
  }
  const Cabinet = load('src/pages/cabinet/index.jsx', mocks).default
  const Detail = load('src/pages/artifact/index.jsx', mocks).default
  const act = React.act
  const render = (name = 'cabinet') => {
    current = name
    roots[name].render(React.createElement(name === 'cabinet' ? Cabinet : Detail))
  }
  const click = (name, text, index = 0) => {
    const button = [...document.querySelectorAll(`#${name} button`)].filter((node) => node.textContent === text)[index]
    assert.ok(button, `button ${name}:${text}[${index}]`)
    button.click()
  }
  const flush = async () => {
    await act(async () => {
      while (ticks.length) ticks.shift()()
      await Promise.resolve()
    })
  }
  try {
    await run({
      act,
      render,
      click,
      flush,
      fire,
      native,
      calls,
      ticks,
      queries,
      nativeCalls,
      handlers,
      api: apiExports.creationApi,
      scroll: (top) => {
        scrollTop = top
        handlers.get('cabinet:page-scroll')?.onScroll?.({ detail: { scrollTop: top } })
      },
      touch: () => handlers.get('cabinet:page-scroll')?.onTouchStart?.(),
      top: () => handlers.get('cabinet:page-scroll')?.scrollTop,
      ids: () =>
        [...document.querySelectorAll('#cabinet .artifact-tile')].map(
          (node) => Number(node.id.replace('cabinet-artifact-', '')) || Number(node.dataset.artifactId)
        ),
      count: () => document.querySelectorAll('#cabinet .artifact-tile').length,
      setRows: (ids) => {
        serverRows = ids.map((id) => artifact(id, favorite))
        version++
      },
      setCredential: (value) => {
        credential = value
      },
      setForeground: (value) => {
        visible = value
      },
      getCredential: () => credential,
      unmountDetail: () => roots.detail.render(null),
      unmountCabinet: () => roots.cabinet.render(null),
    })
  } finally {
    await act(async () => {
      roots.detail.unmount()
      roots.cabinet.unmount()
    })
    dom.window.close()
    Object.assign(global, {
      window: previous.window,
      document: previous.document,
      IS_REACT_ACT_ENVIRONMENT: previous.act,
    })
  }
}
exports.withCabinet = withCabinet
exports.gate = gate
exports.artifact = artifact
