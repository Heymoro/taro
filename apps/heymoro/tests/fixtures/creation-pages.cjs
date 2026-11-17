const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')
const { workflowFixture, task } = require('./creation.cjs')

async function withPages(
  run,
  {
    route = { session: '4' },
    missingOldArtifact = false,
    lateOpen = false,
    strict = false,
    taskGate,
    restoreGate,
    createApi,
    initialFavorite = false,
    initialAccountKey = '1:token:expiry',
    creationStorage,
    photoPorts,
    navBar
  } = {}
) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="create"></div><div id="detail"></div>')
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const roots = {
    create: createRoot(document.getElementById('create')),
    detail: createRoot(document.getElementById('detail'))
  }
  const createPage = { route: 'pages/create/index', options: route },
    detailPage = { route: 'pages/artifact/index', options: { id: '66', returnTo: 'opener' } }
  let currentPage = createPage,
    pages = [createPage],
    storedKey = initialAccountKey
  const anchors = [],
    handlers = new Map()
  const callbacks = new Map(),
    listeners = new Map(),
    nativeCalls = [],
    reads = [],
    ticks = [],
    controllers = [],
    saved = new Map(),
    storageWrites = [],
    businessWrites = []
  const channel = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn)
    },
    emit(name, value) {
      for (const fn of [...(listeners.get(name) || [])]) fn(value)
    }
  }
  detailPage.getOpenerEventChannel = function () {
    assert.equal(this, detailPage)
    return channel
  }
  const fire = (page, name) => {
    currentPage = page
    for (const cb of [...(callbacks.get(page)?.[name] || [])]) cb()
  }
  const lifecycle = (name) => (fn) => {
    const ref = React.useRef(fn)
    ref.current = fn
    const page = React.useRef(currentPage).current
    React.useEffect(() => {
      if (!callbacks.has(page)) callbacks.set(page, { show: new Set(), hide: new Set() })
      const callback = () => ref.current()
      callbacks.get(page)[name].add(callback)
      return () => callbacks.get(page)[name].delete(callback)
    }, [])
  }
  let openOptions
  const native = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    useRouter: () => ({ params: React.useRef(currentPage).current.options }),
    getCurrentInstance: () => ({ page: currentPage }),
    getCurrentPages: () => pages,
    nextTick: (cb) => ticks.push(cb),
    getWindowInfo: () => ({ windowHeight: 844, windowWidth: 390 }),
    getMenuButtonBoundingClientRect: () => ({ top: 50, height: 30, left: 303 }),
    navigateTo(options) {
      nativeCalls.push(options.url)
      openOptions = options
      if (options.events) {
        channel.on('creation:return:request', options.events['creation:return:request'])
        fire(createPage, 'hide')
        pages = [createPage, detailPage]
        currentPage = detailPage
        if (!lateOpen) options.success({ eventChannel: channel })
      } else options.success?.({})
    },
    navigateBack(options) {
      nativeCalls.push('back')
      fire(detailPage, 'hide')
      pages = [createPage]
      fire(createPage, 'show')
      options.success({})
    },
    createSelectorQuery: () => ({
      select() {
        return this
      },
      boundingClientRect(cb) {
        cb({ height: 500 })
        return this
      },
      exec() {}
    })
  }
  const old = task({}, { id: 9, roundNo: 1, status: 'succeeded', artifactIds: [66] })
  const newest = task({}, { id: 10, roundNo: 2, status: 'succeeded', artifactIds: [] })
  let failArtifact = missingOldArtifact,
    favorite = initialFavorite
  const f = workflowFixture()
  const ports = {
    ...f.api,
    getSession: async (args) => {
      if (restoreGate) await restoreGate.promise
      return f.api.getSession(args)
    },
    tasks: async (args) => {
      reads.push(['tasks', args.cursor])
      return { items: [old, newest], nextCursor: null, hasMore: false }
    },
    task: async ({ taskId }) => {
      reads.push(['task', taskId])
      if (taskGate) await taskGate.promise
      return taskId === 9 ? old : newest
    },
    artifact: async ({ artifactId }) => {
      reads.push(['artifact', artifactId])
      if (failArtifact) throw Error('NETWORK')
      return { id: 66, taskId: 9, sessionId: 4, mediaId: 90, isFavorite: favorite }
    },
    putDraft: async (args) => {
      businessWrites.push(['draft', args])
      return f.api.putDraft(args)
    },
    quote: async (args) => {
      businessWrites.push(['quote', args])
      return {
        ...(await f.api.quote(args)),
        validUntil: new Date(Date.now() + 60000).toISOString()
      }
    },
    generate: async (args) => {
      businessWrites.push(['generate', args])
      return f.api.generate(args)
    },
    favorite: async (args) => {
      businessWrites.push(['favorite', args])
      return f.api.favorite(args)
    }
  }
  const apiExports = createApi ? createApi({ native, ports }) : { creationApi: ports }
  const api = apiExports.creationApi
  const real = load('src/creation-workflow.js')
  const component = (tag) => (props) => {
    const {
      children,
      className,
      id,
      onClick,
      disabled,
      value,
      onInput,
      onTouchMove,
      scrollIntoView
    } = props
    if (className) {
      handlers.set(className, props)
      for (const token of className.split(/\s+/).filter(Boolean)) handlers.set(token, props)
    }
    if (className === 'timeline') anchors.push(scrollIntoView)
    return React.createElement(
      tag,
      {
        className,
        id,
        onClick,
        disabled,
        value,
        onInput,
        onTouchMove,
        'data-anchor': scrollIntoView
      },
      children
    )
  }
  const accountMock = {
    useAccount: () => ({ user: { id: 1 }, accountKey: storedKey }),
    creationAccountKey: () => storedKey
  }
  const mocks = {
    '@tarojs/taro': native,
    '@tarojs/components': {
      View: component('div'),
      ScrollView: component('section'),
      Text: component('span'),
      Button: component('button'),
      Textarea: component('textarea'),
      Image: component('img')
    },
    '../../use-account': accountMock,
    '../../use-viewport': { useViewport: () => ({ style: {}, keyboard: 0 }) },
    '../../auth': { getStoredToken: () => 'token' },
    '../../creation-api': {
      ...apiExports,
      creationApi: api,
      privateImage: async () => '/image.png'
    },
    '../../creation-platform': {
      accountStorage: () => creationStorage || ({
        listKeys: ({ prefix }) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
        get: (key) => saved.get(key),
        set: (key, value) => {
          storageWrites.push([key, value])
          saved.set(key, value)
        }
      }),
      photoPlatform: { exists: async () => true, preview: async () => '/image.png', ...photoPorts },
      requestKey: () => `request-${businessWrites.length}`
    },
    '../../creation-workflow': {
      createWorkflow: (args) => {
        const controller = real.createWorkflow(args)
        controllers.push(controller)
        return controller
      }
    },
    '../../components/PrivateImage': ({ onClick }) =>
      React.createElement('button', { onClick }, 'image'),
    '../../../components/PrivateImage': ({ onClick }) =>
      React.createElement('button', { onClick }, 'image'),
    '../../components/primitives': {
      Brand: () => null,
      NavBar: navBar || (() => null),
      Notice: ({ children, onRetry, label = '重试', secondaryAction }) =>
        React.createElement(
          'aside',
          null,
          children,
          onRetry && React.createElement('button', { onClick: onRetry }, label),
          secondaryAction && React.createElement('button', { onClick: secondaryAction.onClick }, secondaryAction.label)
        )
    },
    '../../../components/primitives': {
      Action: component('button'),
      Brand: () => null,
      Notice: ({ children, onRetry, label = '重试' }) =>
        React.createElement(
          'aside',
          null,
          children,
          onRetry && React.createElement('button', { onClick: onRetry }, label)
        )
    }
  }
  const Create = load('src/pages/create/index.jsx', mocks).default,
    Detail = load('src/pages/artifact/index.jsx', mocks).default
  const act = React.act
  const render = (name) => {
    currentPage = name === 'create' ? createPage : detailPage
    roots[name].render(
      strict
        ? React.createElement(
            React.StrictMode,
            null,
            React.createElement(name === 'create' ? Create : Detail)
          )
        : React.createElement(name === 'create' ? Create : Detail)
    )
  }
  const click = (name, text) => {
    const button = [...document.querySelectorAll(`#${name} button`)].find(
      (b) => b.textContent === text
    )
    assert.ok(button, `button ${text}`)
    button.click()
  }
  const flush = async () => {
    await act(async () => {
      while (ticks.length) ticks.shift()()
    })
  }
  try {
    await run({
      act,
      render,
      unmountDetail: () => roots.detail.render(null),
      unmountCreate: () => roots.create.render(null),
      api,
      anchors,
      handlers,
      click,
      flush,
      fire,
      createPage,
      detailPage,
      channel,
      listeners,
      nativeCalls,
      reads,
      controllers,
      storageWrites,
      businessWrites,
      native,
      setFavorite: (v) => {
        favorite = v
      },
      setFailArtifact: (v) => {
        failArtifact = v
      },
      setKey: (v) => {
        storedKey = v
      },
      setPages: (v) => {
        pages = v
      },
      settleOpen: () => openOptions.success({ eventChannel: channel })
    })
  } finally {
    await act(async () => {
      roots.detail.unmount()
      roots.create.unmount()
    })
    f.workflow.dispose()
    dom.window.close()
    Object.assign(global, {
      window: previous.window,
      document: previous.document,
      IS_REACT_ACT_ENVIRONMENT: previous.act
    })
  }
}

exports.withPages = withPages
