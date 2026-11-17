const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { load } = require('../source.cjs')
const { template, task } = require('../fixtures/creation.cjs')

function nativeComponent(tag) {
  return function Native({
    children,
    className,
    style,
    id,
    disabled,
    onClick,
    src,
    value,
    placeholder,
    ...props
  }) {
    const attributes = {
      className,
      style,
      id,
      disabled,
      onClick,
      src,
      value,
      placeholder,
      'aria-label': props['aria-label']
    }
    if (tag === 'textarea' || tag === 'input') attributes.readOnly = true
    return React.createElement(tag, attributes, children)
  }
}
const components = {
  View: nativeComponent('div'),
  ScrollView: nativeComponent('section'),
  Button: nativeComponent('button'),
  Image: nativeComponent('img'),
  Text: nativeComponent('span'),
  Input: nativeComponent('input'),
  Textarea: nativeComponent('textarea')
}
const nativePage = { route: 'pages/cabinet/index', options: {} }
const taro = {
  useDidShow() {},
  useDidHide() {},
  useRouter: () => ({ params: {} }),
  getCurrentInstance: () => ({ page: nativePage }),
  getCurrentPages: () => [nativePage],
  nextTick: (callback) => callback(),
  createSelectorQuery: () => {
    let selector, all = false
    const reads = []
    const query = {
      select(value) { selector = value; all = false; return query },
      selectAll(value) { selector = value; all = true; return query },
      boundingClientRect() {
        const selected = selector, multiple = all
        reads.push(() => {
          const nodes = typeof document === 'undefined' ? [] : [...document.querySelectorAll(selected)]
          const rects = nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            return { id: node.id, top: rect.top, bottom: rect.bottom, height: rect.height }
          })
          return multiple ? rects : rects[0] || null
        })
        return query
      },
      scrollOffset() { reads.push(() => ({ scrollTop: 0, scrollHeight: 0 })); return query },
      exec(callback) { callback?.(reads.map((read) => read())) }
    }
    return query
  },
  getWindowInfo: () => ({ windowHeight: 844, windowWidth: 390, statusBarHeight: 20 }),
  getMenuButtonBoundingClientRect: () => ({ top: 55, height: 30, left: 303 })
}
const mocks = {
  '@tarojs/components': components,
  '@tarojs/taro': taro,
  './auth': { getStoredToken: () => 'account-token', getStoredSession: () => null },
  '../auth': { getStoredToken: () => 'account-token', getStoredSession: () => null },
  '../../auth': { getStoredToken: () => 'account-token', getStoredSession: () => null }
}
const render = (file, props) => renderToStaticMarkup(React.createElement(load(file, mocks).default, props))

test('PhotoInput shows native picker action, ordered own images and retry/remove controls', () => {
  const file = 'src/features/creation/PhotoInput/index.jsx'
  const empty = render(file, { photos: [], schema: template().inputSchema, mode: 'free' })
  assert.match(empty, /我的照片.*选填.*添加我的照片/)
  assert.doesNotMatch(empty, /示例|相册列表|胶囊/)
  const filled = render(file, {
    photos: [
      { id: 'a', path: '/a.png', status: 'ready' },
      { id: 'b', path: '/b.png', status: 'failed' }
    ],
    schema: template().inputSchema,
    mode: 'effect'
  })
  assert.ok(filled.indexOf('/a.png') < filled.indexOf('/b.png'))
  assert.match(filled, /2 \/ 8 张/)
  assert.match(filled, /移除照片/)
  assert.match(filled, /重试上传/)
})

test('TemplateGuide is large before upload and compact afterwards; preview uses an administrator-shared session', () => {
  const effect = template('effect')
  effect.displayConfig.showcaseShareKeys = ['a'.repeat(32)]
  const file = 'src/features/creation/TemplateGuide/index.jsx'
  const expanded = render(file, { template: effect, compact: false })
  const compact = render(file, { template: effect, compact: true })
  assert.match(expanded, /template-guide__hero/)
  assert.match(expanded, /\/session-shares\/a{32}\/cover/)
  assert.match(compact, /template-guide--compact/)
  assert.match(compact, /template-guide__thumb/)
  assert.doesNotMatch(compact, /template-guide__hero/)
})

test('Composer separates raw free description from default-collapsed effect notes and puts real cost inside button', () => {
  const file = 'src/features/creation/CreationComposer/index.jsx'
  const props = {
    description: '  raw description  ',
    userNotes: 'notes',
    schema: template().inputSchema,
    controls: { canGenerate: true, generateLabel: '生成', costCredits: 7 }
  }
  const free = render(file, { ...props, mode: 'free' })
  assert.match(free, /<textarea[^>]*> {2}raw description {2}<\/textarea>/)
  assert.match(free, /<button[^>]*composer__generate[^>]*>.*生成.*generation-cost\.png.*7 积分.*<\/button>/)
  const effect = render('src/features/creation/EffectNotes/index.jsx', { ...props, mode: 'effect' })
  assert.match(effect, /补充要求（选填）/)
  assert.doesNotMatch(effect, /<textarea|raw description|systemPrompt/)
})

for (const status of ['queued', 'running', 'unknown', 'succeeded', 'failed', 'closed', 'cancelled']) {
  test(`RoundCard renders ${status} without pretending a Task is an Artifact`, () => {
    const round = task(
      {},
      {
        status,
        artifactIds: status === 'succeeded' ? [88] : [],
        resolution: status === 'closed' ? { releasedAvailableCredits: 2, releasedExpiredCredits: 1 } : null
      }
    )
    const html = render('src/features/creation/RoundCard/index.jsx', {
      round,
      artifacts: { 88: { id: 88, mediaId: 90, isFavorite: true } },
      accountKey: 'owner'
    })
    if (status === 'closed') {
      assert.match(html, /本轮已结清.*2.*1/)
      assert.doesNotMatch(html, /generation__waiting/)
    }
    if (status === 'cancelled') assert.match(html, /本轮已取消/)
    if (status === 'unknown') assert.match(html, /不会自动重复生成/)
    if (status === 'succeeded') assert.match(html, /已收藏.*换一张.*查看作品/)
    if (['queued', 'running'].includes(status)) assert.match(html, /brand--animated/)
    assert.match(html, /带回输入/)
  })
}

test('all ten actual pages SSR with native boundaries only, without old protocol rendering', () => {
  for (const page of ['index', 'effects', 'me', 'create', 'cabinet', 'artifact', 'sessions', 'example', 'credits', 'credit-reservations']) {
    const html = render(`src/pages/${page}/index.jsx`)
    assert.ok(html.includes('screen'), page)
    assert.doesNotMatch(html, /本次 1 点|体验版|查看套餐|outputMediaId|systemPrompt/)
  }
})

test('useAccount real React lifecycle rejects previous identity and same-user token responses', async () => {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const { act } = React
  const dom = new JSDOM('<div id="root"></div>')
  const before = {
    window: global.window,
    document: global.document,
    navigator: global.navigator,
    act: global.IS_REACT_ACT_ENVIRONMENT
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  let session = { userId: 1, token: 'first', expiresAt: '2099-01-01T00:00:00Z' }
  const pending = []
  const accountModule = load('src/use-account.js', {
    '@tarojs/taro': { useDidShow() {} },
    './auth': { getStoredSession: () => session },
    './creation-api': { ensureCreationUser: () => new Promise((resolve) => pending.push(resolve)) }
  })
  let account
  function Probe() {
    account = accountModule.useAccount()
    return React.createElement('div', null, account.user?.id || 'none')
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(Probe)))
    let first
    await act(async () => {
      first = account.refresh()
    })
    session = { ...session, token: 'second' }
    let second
    await act(async () => {
      second = account.refresh()
    })
    await act(async () => {
      pending[0]({ id: 1 })
      await first
    })
    assert.equal(account.user, null)
    await act(async () => {
      pending[1]({ id: 1 })
      await second
    })
    assert.equal(account.user.id, 1)
    session = { ...session, userId: 2, token: 'third' }
    await act(async () => root.render(React.createElement(Probe)))
    assert.equal(account.user, null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    global.window = before.window
    global.document = before.document
    global.IS_REACT_ACT_ENVIRONMENT = before.act
  }
})

async function withReactDOM({ run }) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  try {
    await run({ root, act: React.act })
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    global.window = previous.window
    global.document = previous.document
    global.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
}

test('cursor hook real React lifecycle clears old account and survives enabled false/true', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const pending = []
      const { useCursorList } = load('src/use-cursor-list.js', { '@tarojs/taro': { useDidShow() {}, useDidHide() {} } })
      let list
      function Probe({ accountKey, enabled }) {
        list = useCursorList({
          accountKey,
          enabled,
          read: (args) => new Promise((resolve) => pending.push({ args, resolve }))
        })
        return React.createElement('div', null, list.items.map((item) => item.id).join(','))
      }
      await act(async () => root.render(React.createElement(Probe, { accountKey: 'a', enabled: true })))
      await act(async () => root.render(React.createElement(Probe, { accountKey: 'b', enabled: true })))
      assert.equal(list.items.length, 0)
      await act(async () => pending[0].resolve({ items: [{ id: 1 }], nextCursor: null, hasMore: false }))
      assert.equal(list.items.length, 0)
      await act(async () => pending[1].resolve({ items: [{ id: 2 }], nextCursor: null, hasMore: false }))
      assert.equal(list.items[0].id, 2)
      await act(async () => root.render(React.createElement(Probe, { accountKey: 'b', enabled: false })))
      await act(async () => root.render(React.createElement(Probe, { accountKey: 'b', enabled: true })))
      assert.equal(pending.length, 3)
    }
  })
})

test('viewport real lifecycle treats native resize and keyboard event as one occlusion even resize arrives first', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      let resized, keyboardChanged, viewport
      let height = 844
      const page = { route: 'pages/create/index' }
      const { useViewport } = load('src/use-viewport.js', {
        '@tarojs/taro': {
          useDidHide() {},
          useDidShow() {},
          getCurrentInstance: () => ({ page }),
          getCurrentPages: () => [page],
          nextTick: (fn) => fn(),
          createSelectorQuery: () => {
            const query = {
              in: () => query,
              select: () => query,
              boundingClientRect: () => query,
              exec: (fn) => fn([{ top: 0, left: 0, bottom: 844, right: 390, width: 390, height: 844 }])
            }
            return query
          },
          getWindowInfo: () => ({ windowHeight: height, windowWidth: 390 }),
          onWindowResize: (fn) => {
            resized = (event) => {
              height = event.size.windowHeight
              fn(event)
            }
          },
          offWindowResize() {},
          onKeyboardHeightChange: (fn) => {
            keyboardChanged = fn
          },
          offKeyboardHeightChange() {}
        }
      })
      function Probe() {
        viewport = useViewport()
        return React.createElement('div', { style: viewport.style })
      }
      await act(async () => root.render(React.createElement(Probe)))
      await act(async () => viewport.onFocus())
      await act(async () => resized({ size: { windowHeight: 544, windowWidth: 390 } }))
      await act(async () => keyboardChanged({ height: 300 }))
      assert.equal(viewport.style.height, '544px')
    }
  })
})

test('effect notes expand inline through real React interaction and can collapse without a dialog', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const EffectNotes = load('src/features/creation/EffectNotes/index.jsx', mocks).default
      await act(async () =>
        root.render(
          React.createElement(EffectNotes, {
            mode: 'effect',
            description: '',
            userNotes: '  optional notes  ',
            schema: template('effect').inputSchema,
            controls: { canGenerate: true, generateLabel: '生成', costCredits: 5 }
          })
        )
      )
      assert.equal(document.querySelector('textarea'), null)
      await act(async () => document.querySelector('.effect-notes__toggle').click())
      assert.equal(document.querySelector('textarea').value, '  optional notes  ')
      assert.equal(document.querySelector('[role="dialog"]'), null)
      await act(async () => document.querySelector('.effect-notes__toggle').click())
      assert.equal(document.querySelector('textarea'), null)
    }
  })
})

test('actual workflow hook visits effect history then fresh free entry without storage contamination', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const { workflowFixture } = require('../fixtures/creation.cjs')
      const f = workflowFixture({ mode: 'effect' })
      const effect = { ...template('effect'), templateId: 9, templateVersionId: 10 }
      f.api.getSession = async () => ({
        ...f.session,
        mode: 'effect',
        templateId: 9,
        templateVersionId: 10,
        draft: { input: { inputMediaIds: [], description: '', userNotes: 'history notes' }, updatedAt: '2026-11-13T00:00:00Z' }
      })
      f.api.template = async () => effect
      f.api.freePreset = async () => template()
      const saved = new Map()
      const { useCreationWorkflow } = load('src/features/creation/use-creation-workflow.js', {
        '@tarojs/taro': {
          useDidShow() {},
          useDidHide() {},
          showModal: async () => ({ confirm: true })
        },
        '../../auth': { getStoredToken: () => 'token' },
        '../../use-account': { creationAccountKey: () => 'owner' },
        '../../creation-api': { creationApi: f.api },
        '../../creation-platform': {
          accountStorage: () => ({
            get: (key) => saved.get(key),
            set: (key, value) => saved.set(key, JSON.parse(JSON.stringify(value)))
          }),
          photoPlatform: { exists: async () => true, preview: async () => '/private.png' },
          requestKey: () => 'request'
        }
      })
      let creation
      function Probe({ sessionId, carryArtifactId }) {
        creation = useCreationWorkflow({
          account: { user: { id: 1 }, accountKey: 'owner' },
          sessionId,
          carryArtifactId
        })
        return React.createElement('div', null, creation.state?.template?.mode || '')
      }
      try {
        await act(async () => root.render(React.createElement(Probe, { sessionId: 4 })))
        await act(async () => creation.workflow.setUserNotes('edited history'))
        await act(async () => root.render(React.createElement(Probe, { sessionId: null })))
        assert.equal(creation.state.sessionId, null)
        assert.equal(creation.state.template.mode, 'free')
        assert.equal(creation.state.userNotes, '')
        assert.equal(saved.get('session:4').userNotes, 'edited history')
        f.api.task = async () =>
          task(
            { input: { inputMediaIds: [], description: '', userNotes: 'original source' } },
            { inputAvailability: [] }
          )
        await act(async () => root.render(React.createElement(Probe, { sessionId: 4, carryArtifactId: 66 })))
        assert.equal(creation.state.userNotes, 'original source')
        assert.equal(creation.state.sourceArtifactId, null)
        assert.equal(f.sent.length, 0)
      } finally {
        f.workflow.dispose()
      }
    }
  })
})

test('free footer has one-to-three-row input and generation action; effect notes are outside composer', () => {
  const html = render('src/features/creation/CreationComposer/index.jsx', {
    mode: 'free',
    description: '',
    schema: template().inputSchema,
    controls: { canGenerate: false, generateLabel: '生成', costCredits: null }
  })
  assert.doesNotMatch(html, /查看本次报价|composer__refresh|composer__toggle|按原作品输入/)
  const effect = render('src/features/creation/CreationComposer/index.jsx', {
    mode: 'effect',
    userNotes: 'notes',
    sourceSelected: true,
    controls: { canGenerate: false, generateLabel: '生成', costCredits: null }
  })
  assert.doesNotMatch(effect, /textarea|补充要求|查看本次报价|按原作品输入/)
})

test('Artifact toolbar is compact and carry-back navigation is distinct from source regeneration', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const navigations = []
      const nativePage = { options: { id: '66' }, route: 'pages/artifact/index' }
      const ArtifactPage = load('src/pages/artifact/index.jsx', {
        ...mocks,
        '@tarojs/taro': {
          ...taro,
          getCurrentInstance: () => ({ page: nativePage }),
          getCurrentPages: () => [nativePage],
          useRouter: () => ({ params: { id: '66' } }),
          navigateTo: ({ url }) => navigations.push(url)
        },
        '../../use-account': {
          useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }),
          creationAccountKey: () => 'owner'
        },
        '../../creation-api': {
          creationApi: {
            artifact: async () => ({ id: 66, mediaId: 90, taskId: 7, sessionId: 4, isFavorite: false })
          },
          privateImage: async () => '/private.png'
        }
      }).default
      await act(async () => root.render(React.createElement(ArtifactPage)))
      assert.equal(document.querySelectorAll('.artifact-toolbar__primary button').length, 3)
      const source = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === '按原输入换一张'
      )
      const carry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === '带回输入'
      )
      const returnToCreation = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === '返回创作'
      )
      await act(async () => returnToCreation.click())
      await act(async () => source.click())
      await act(async () => carry.click())
      assert.deepEqual(navigations, [
        '/pages/create/index?session=4&focusTask=7',
        '/pages/create/index?session=4&source=66',
        '/pages/create/index?session=4&carry=66'
      ])
    }
  })
})

test('actual free hook discovers original session request before an unavailable preset after unmount', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const { workflowFixture } = require('../fixtures/creation.cjs')
      const f = workflowFixture()
      const saved = new Map()
      const requests = []
      let offline = false
      f.api.freePreset = async () => {
        if (offline) throw Error('TEMPLATE_UNAVAILABLE')
        return template()
      }
      f.api.createSession = async (body) => {
        requests.push(JSON.parse(JSON.stringify(body)))
        if (!offline) throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
        return f.session
      }
      const { useCreationWorkflow } = load('src/features/creation/use-creation-workflow.js', {
        '@tarojs/taro': { useDidShow() {}, useDidHide() {} },
        '../../auth': { getStoredToken: () => 'token' },
        '../../use-account': { creationAccountKey: () => 'owner' },
        '../../creation-api': { creationApi: f.api },
        '../../creation-platform': {
          accountStorage: () => ({
            get: (key) => saved.get(key),
            set: (key, value) => saved.set(key, JSON.parse(JSON.stringify(value)))
          }),
          photoPlatform: { exists: async () => true },
          requestKey: () => 'original-hook-key'
        }
      })
      let creation
      function Probe() {
        creation = useCreationWorkflow({
          account: { user: { id: 1 }, accountKey: 'owner' },
          sessionId: null,
          templateId: null
        })
        return React.createElement('div', null, creation.state?.description || '')
      }
      try {
        await act(async () => root.render(React.createElement(Probe)))
        await act(async () => {
          creation.workflow.setDescription('  hook original  ')
          await creation.workflow.prepareQuote()
        })
        assert.ok(creation.state.sessionRequest)
        await act(async () => root.render(null))
        offline = true
        await act(async () => root.render(React.createElement(Probe)))
        assert.equal(creation.state.description, '  hook original  ')
        await act(async () => creation.workflow.generate())
        assert.deepEqual(requests[1], requests[0])
        assert.equal(f.sent.length, 0)
        assert.equal(saved.get('unsettled:template:free'), null)
      } finally {
        f.workflow.dispose()
      }
    }
  })
})

test('PhotoInput missing slot renders status, original-position supplement and explicit remove with real events', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const events = []
      const PhotoInput = load('src/features/creation/PhotoInput/index.jsx', mocks).default
      await act(async () =>
        root.render(
          React.createElement(PhotoInput, {
            photos: [{ id: 'media:16', mediaId: 16, path: '', status: 'unavailable' }],
            mode: 'free',
            schema: template().inputSchema,
            onReplace: (id) => events.push(['replace', id]),
            onRemove: (id) => events.push(['remove', id])
          })
        )
      )
      assert.match(document.body.textContent, /照片已失效/)
      const supplement = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === '补选照片'
      )
      assert.ok(supplement)
      await act(async () => supplement.click())
      await act(async () => document.querySelector('[aria-label="移除照片"]').click())
      assert.deepEqual(events, [
        ['replace', 'media:16'],
        ['remove', 'media:16']
      ])
    }
  })
})

test('actual page round button and route-after-restore share native confirmation, lifecycle invalidation and workflow ownership', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const { workflowFixture } = require('../fixtures/creation.cjs')
      const f = workflowFixture()
      const saved = new Map(),
        writes = [],
        modals = []
      let finishModal
      const hides = [], shows = []
      const hide = () => hides.forEach((fn) => fn())
      const show = () => shows.forEach((fn) => fn())
      let params = { session: '4' }
      const original = task(
        {},
        {
          status: 'succeeded',
          artifactIds: [],
          inputAvailability: [
            { mediaId: 15, position: 1, status: 'active' },
            { mediaId: 16, position: 2, status: 'unavailable' }
          ]
        }
      )
      let taskReads = 0
      f.api.tasks = async () => ({ items: [original], nextCursor: null, hasMore: false })
      f.api.task = async () => {
        taskReads++
        return original
      }
      const CreatePage = load('src/pages/create/index.jsx', {
        ...mocks,
        '@tarojs/taro': {
          ...taro,
          useRouter: () => ({ params }),
          useDidShow: (fn) => {
            shows.push(fn)
          },
          useDidHide: (fn) => {
            hides.push(fn)
          },
          showModal: (args) => {
            modals.push(args)
            return new Promise((resolve) => {
              finishModal = resolve
            })
          }
        },
        '../../auth': { getStoredToken: () => 'token' },
        '../../use-account': { creationAccountKey: () => 'owner' },
        '../../creation-api': { creationApi: f.api },
        '../../creation-platform': {
          accountStorage: () => ({
            get: (key) => saved.get(key),
            set: (key, value) => {
              writes.push(key)
              saved.set(key, JSON.parse(JSON.stringify(value)))
            }
          }),
          photoPlatform: { exists: async () => true, preview: async () => '/preview.png' },
          requestKey: () => 'request'
        },
        '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }), creationAccountKey: () => 'owner' },
        '../../use-viewport': { useViewport: () => ({ style: {}, keyboard: {} }) }
      }).default
      try {
        await act(async () => root.render(React.createElement(CreatePage)))
        const carry = () =>
          [...document.querySelectorAll('button')].find(
            (button) => button.textContent === '带回输入'
          )
        await act(async () => carry().click())
        assert.equal(modals.length, 1)
        assert.equal(writes.length, 0)
        assert.equal(taskReads, 1)
        assert.notEqual(modals[0].editable, true)
        await act(async () => {
          finishModal({ confirm: false })
        })
        assert.equal(writes.length, 0)
        await act(async () => carry().click())
        await act(async () => {
          hide()
          show()
          finishModal({ confirm: true })
        })
        assert.equal(writes.length, 0)
        await act(async () => carry().click())
        await act(async () => finishModal({ confirm: true }))
        assert.equal(saved.get('session:4').carryBackSourceTaskId, 9)
        assert.equal(saved.get('session:4').photos[1].status, 'unavailable')
        const writesBeforeRoute = writes.length
        params = { session: '4', carry: '88' }
        await act(async () => root.render(React.createElement(CreatePage)))
        assert.equal(modals.length, 4)
        assert.equal(writes.length, writesBeforeRoute)
        await act(async () => finishModal({ confirm: false }))
        assert.equal(writes.length, writesBeforeRoute)
        assert.equal(f.sent.length, 0)
      } finally {
        f.workflow.dispose()
      }
    }
  })
})

test('PhotoInput numbers own photos and offers same-area arrange action', () => {
  const html = render('src/features/creation/PhotoInput/index.jsx', {
    photos: [
      { id: 'a', path: '/a', status: 'ready' },
      { id: 'b', path: '/b', status: 'ready' }
    ],
    schema: template().inputSchema,
    mode: 'free',
    canReorder: true
  })
  assert.match(html, /图1/)
  assert.match(html, /图2/)
  assert.match(html, /整理/)
})

async function photoOrderDOM(run) {
  await withReactDOM({
    run: async ({ root, act }) => {
      const tiles = new Map(),
        moves = [],
        queries = []
      const lifecycle = {}
      const controlHandlers = new Map()
      let order, setPhotos, setDisabled, setContext
      const initial = ['a', 'b', 'c'].map((id) => ({ id, path: `/${id}`, status: 'ready' }))
      const rects = () =>
        initial.map((_, i) => ({
          left: i * 83,
          right: i * 83 + 60,
          top: 30,
          bottom: 90,
          width: 60,
          height: 60
        }))
      const native = {
        ...components,
        Button: function NativeButton(props) {
          controlHandlers.set(props.children, props)
          return React.createElement(components.Button, props)
        },
        View: function NativeView(props) {
          if (props.className === 'references') lifecycle.panel = props
          if (props['data-slot-id']) tiles.set(props['data-slot-id'], props)
          return React.createElement(
            'div',
            { className: props.className, style: props.style },
            props.children
          )
        }
      }
      const localTaro = {
        ...taro,
        useDidHide: (fn) => {
          lifecycle.hide = fn
        },
        useDidShow: (fn) => {
          lifecycle.show = fn
        },
        onWindowResize: (fn) => {
          lifecycle.resize = fn
        },
        offWindowResize() {},
        createSelectorQuery: () => ({
          selectAll() {
            return this
          },
          boundingClientRect(fn) {
            this.callback = fn
            return this
          },
          exec() {
            if (lifecycle.failQuery) throw Error('geometry unavailable')
            queries.push(this.callback)
          }
        })
      }
      const localMocks = { ...mocks, '@tarojs/components': native, '@tarojs/taro': localTaro }
      const { usePhotoOrder } = load(
        'src/features/creation/PhotoInput/use-photo-order.js',
        localMocks
      )
      const PhotoInput = load('src/features/creation/PhotoInput/index.jsx', localMocks).default
      function Probe() {
        const [photos, changePhotos] = React.useState(initial)
        const [disabled, changeDisabled] = React.useState(false)
        const [context, changeContext] = React.useState({ owner: 'first' })
        setContext = changeContext
        setPhotos = changePhotos
        setDisabled = changeDisabled
        order = usePhotoOrder({ photos, disabled, context, onMove: (args) => moves.push(args) })
        return React.createElement(PhotoInput, {
          photos,
          schema: template().inputSchema,
          mode: 'free',
          canReorder: !disabled,
          photoOrder: order,
          onPreview: () => moves.push('preview'),
          onRemove: () => moves.push('remove'),
          onRetry: () => moves.push('retry'),
          onReplace: () => moves.push('replace')
        })
      }
      await act(async () => root.render(React.createElement(Probe)))
      const click = async (label) => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (item) => item.textContent === label
        )
        assert.ok(button, label)
        await act(async () => button.click())
      }
      const point = (x, y = 55, identifier = 0) => ({ clientX: x, clientY: y, identifier })
      const event = (touches, changedTouches = touches) => ({
        touches,
        changedTouches,
        stopPropagation() {}
      })
      const send = async (id, name, e) => {
        await act(async () => tiles.get(id)[name](e))
      }
      const start = async () => {
        await send('a', 'onTouchStart', event([point(20)]))
        await send('a', 'onLongPress', event([point(20)]))
      }
      await click('整理')
      await run({
        root,
        act,
        tiles,
        moves,
        queries,
        lifecycle,
        controlHandlers,
        order: () => order,
        setPhotos,
        setDisabled,
        setContext,
        initial,
        rects,
        click,
        point,
        event,
        send,
        start
      })
    }
  })
}

test('actual photo native touch chain keeps catchMove fixed, commits exactly once using final touchend position; suppresses click', async () => {
  await photoOrderDOM(async ({ tiles, moves, queries, rects, start, send, event, point, act }) => {
    assert.equal(tiles.get('a').catchMove, true)
    await start()
    await act(async () => queries.shift()(rects()))
    await send('a', 'onTouchMove', event([point(105)]))
    assert.equal(moves.length, 0)
    await send('a', 'onTouchEnd', event([], [point(190)]))
    await send('a', 'onTouchEnd', event([], [point(105)]))
    assert.equal(moves.length, 1)
    assert.equal(moves[0].slotId, 'a')
    assert.equal(moves[0].targetIndex, 2)
    assert.deepEqual(Array.from(moves[0].expectedIds), ['a', 'b', 'c'])
    await act(async () => document.querySelector('.photo-tile__image').click())
    await act(async () => document.querySelector('.photo-tile__remove').click())
    assert.equal(moves.length, 1)
  })
})

for (const reason of [
  'no-move',
  'same-slot',
  'outside',
  'cancel',
  'multi-start',
  'multi-move',
  'multi-longpress',
  'sparse-geometry',
  'wrong-end-identifier',
  'late-geometry',
  'bad-geometry',
  'geometry-throws',
  'hide-show',
  'keyboard',
  'resize',
  'add',
  'remove',
  'replace',
  'reorder'
]) {
  test(`photo drag is terminal with zero business moves after ${reason}`, async () => {
    await photoOrderDOM(
      async ({
        moves,
        queries,
        lifecycle,
        rects,
        start,
        send,
        point,
        event,
        act,
        setPhotos,
        setDisabled,
        initial
      }) => {
        if (reason === 'geometry-throws') lifecycle.failQuery = true
        if (reason === 'multi-start' || reason === 'multi-longpress') {
          await send(
            'a',
            'onTouchStart',
            event(reason === 'multi-start' ? [point(20), point(30, 55, 1)] : [point(20)])
          )
          await send(
            'a',
            'onLongPress',
            event(reason === 'multi-longpress' ? [point(20), point(30, 55, 1)] : [point(20)])
          )
        } else await start()
        const query = queries.shift()
        const measured = rects()
        if (reason === 'sparse-geometry') delete measured[1]
        if (reason !== 'late-geometry' && query)
          await act(async () => query(reason === 'bad-geometry' ? [] : measured))
        if (reason === 'cancel') await send('a', 'onTouchCancel', event([]))
        if (reason === 'multi-move')
          await send('a', 'onTouchMove', event([point(105), point(40, 55, 1)]))
        if (reason === 'hide-show')
          await act(async () => {
            lifecycle.hide()
            lifecycle.show()
          })
        if (reason === 'keyboard') await act(async () => setDisabled(true))
        if (reason === 'resize') await act(async () => lifecycle.resize())
        if (reason === 'add') await act(async () => setPhotos([...initial, { id: 'd' }]))
        if (reason === 'remove') await act(async () => setPhotos(initial.slice(0, 2)))
        if (reason === 'replace')
          await act(async () => setPhotos([initial[0], { id: 'new' }, initial[2]]))
        if (reason === 'reorder') await act(async () => setPhotos([...initial].reverse()))
        const x =
          reason === 'no-move' ? 20 : reason === 'same-slot' ? 30 : reason === 'outside' ? 900 : 190
        await send(
          'a',
          'onTouchEnd',
          event([], [point(x, 55, reason === 'wrong-end-identifier' ? 2 : 0)])
        )
        if (reason === 'late-geometry' && query) await act(async () => query(rects()))
        assert.equal(moves.length, 0)
      }
    )
  })
}

test('same-ID metadata refresh and background loading do not cancel drag; arrow boundaries and Done keep one live order', async () => {
  await photoOrderDOM(
    async ({
      start,
      queries,
      rects,
      act,
      setPhotos,
      initial,
      send,
      event,
      point,
      moves,
      click
    }) => {
      const buttons = () => Array.from(document.querySelectorAll('button'))
      assert.equal(buttons().find((b) => b.textContent === '前移').disabled, true)
      await start()
      await act(async () => queries.shift()(rects()))
      await act(async () =>
        setPhotos(initial.map((p) => ({ ...p, mediaId: 9, path: '/updated', status: 'ready' })))
      )
      await send('a', 'onTouchEnd', event([], [point(190)]))
      assert.equal(moves.length, 1)
      // A fresh ordinary tap releases only the synthesized-click suppression.
      await send('a', 'onTouchStart', event([point(20)]))
      await send('a', 'onTouchEnd', event([], [point(20)]))
      await click('后移')
      assert.equal(moves.length, 2)
      assert.equal(moves[1].targetIndex, 1)
      await click('完成')
      assert.equal(document.querySelector('.photo-order__grid'), null)
      assert.match(document.body.textContent, /图1.*图2.*图3/)
    }
  )
})

test('a new panel touch releases drag-click suppression for Done without requiring another photo selection', async () => {
  await photoOrderDOM(
    async ({ start, queries, rects, act, send, event, point, lifecycle, click, moves }) => {
      await start()
      await act(async () => queries.shift()(rects()))
      await send('a', 'onTouchEnd', event([], [point(190)]))
      assert.equal(moves.length, 1)
      assert.equal(typeof lifecycle.panel.onTouchStart, 'function')
      await act(async () => lifecycle.panel.onTouchStart(event([point(300, 10)])))
      await click('完成')
      assert.equal(document.querySelector('.photo-order__grid'), null)
      assert.equal(moves.length, 1)
    }
  )
})

test('unmount makes old native events and delayed geometry permanently inert', async () => {
  await photoOrderDOM(async ({ root, start, queries, rects, act, tiles, event, point, moves }) => {
    await start()
    const oldTile = tiles.get('a'),
      measure = queries.shift()
    await act(async () => root.render(null))
    await act(async () => measure(rects()))
    await act(async () => oldTile.onTouchEnd(event([], [point(190)])))
    assert.equal(moves.length, 0)
  })
})

test('CreatePage wires arrange arrows into real workflow and numbers update from the single saved photo order', async () => {
  const { workflowFixture } = require('../fixtures/creation.cjs')
  let media = 0
  const f = workflowFixture({
    files: {
      choose: async () =>
        ['a', 'b', 'c'].map((id) => ({ path: `/${id}`, size: 10, mimeType: 'image/png' })),
      upload: async () => ({ id: ++media })
    }
  })
  await f.workflow.addPhotos()
  const originalIds = Array.from(f.workflow.getSnapshot().photos, (p) => p.id)
  await withReactDOM({
    run: async ({ root, act }) => {
      const CreatePage = load('src/pages/create/index.jsx', {
        ...mocks,
        '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }), creationAccountKey: () => 'owner' },
        '../../use-viewport': { useViewport: () => ({ style: {}, keyboard: 0 }) },
        '../../features/creation/use-creation-workflow': {
          useCreationWorkflow: () => ({
            state: React.useSyncExternalStore(f.workflow.subscribe, f.workflow.getSnapshot),
            workflow: f.workflow
          })
        }
      }).default
      await act(async () => root.render(React.createElement(CreatePage)))
      const button = (label) =>
        Array.from(document.querySelectorAll('button')).find((node) => node.textContent === label)
      await act(async () => button('整理').click())
      assert.equal(button('前移').disabled, true)
      await act(async () => button('后移').click())
      assert.deepEqual(
        Array.from(f.workflow.getSnapshot().photos, (p) => p.id),
        [originalIds[1], originalIds[0], originalIds[2]]
      )
      await act(async () => document.querySelectorAll('.photo-tile__image')[2].click())
      assert.equal(button('后移').disabled, true)
      assert.equal(button('前移').disabled, false)
      await act(async () => button('完成').click())
      assert.equal(document.querySelector('.photo-order__grid'), null)
      assert.deepEqual(
        f.saved.get('session:4').photos.map((p) => p.id),
        [originalIds[1], originalIds[0], originalIds[2]]
      )
      assert.match(document.body.textContent, /图1.*图2.*图3/)
    }
  })
  f.workflow.dispose()
})

test('same slot IDs in a replacement workflow context reject every old native drop', async () => {
  await photoOrderDOM(
    async ({ start, queries, rects, act, setContext, send, event, point, moves }) => {
      await start()
      await act(async () => queries.shift()(rects()))
      await act(async () => setContext({ owner: 'second' }))
      await send('a', 'onTouchEnd', event([], [point(190)]))
      assert.equal(moves.length, 0)
    }
  )
})


for (const terminal of ['drop', 'cancel']) {
  for (const [label, callback] of [
    ['×', 'remove'],
    ['重试上传', 'retry'],
    ['补选照片', 'replace']
  ]) {
    test(`fresh ${label} control touch after ${terminal} releases only the prior drag click barrier`, async () => {
      await photoOrderDOM(
        async ({
          start,
          queries,
          rects,
          act,
          send,
          event,
          point,
          moves,
          initial,
          setPhotos,
          controlHandlers
        }) => {
          await act(async () =>
            setPhotos(
              initial.map((photo, index) => ({
                ...photo,
                status: ['ready', 'failed', 'unavailable'][index]
              }))
            )
          )
          await start()
          await act(async () => queries.shift()(rects()))
          if (terminal === 'drop') await send('a', 'onTouchEnd', event([], [point(190)]))
          else await send('a', 'onTouchCancel', event([]))
          const moveCount = terminal === 'drop' ? 1 : 0
          const button = () =>
            Array.from(document.querySelectorAll('button')).find(
              (node) => node.textContent === label
            )
          // The same drag's synthesized click remains inert without a new touchstart.
          await act(async () => button().click())
          assert.equal(moves.length, moveCount)
          let stopped = false
          const fresh = {
            ...event([point(190)]),
            stopPropagation() {
              stopped = true
            }
          }
          // Invoke the actual child's touch handler. It stops propagation, so do not call the panel.
          await act(async () => controlHandlers.get(label).onTouchStart(fresh))
          assert.equal(stopped, true)
          await send('c', 'onLongPress', event([point(190)]))
          assert.equal(queries.length, 0, 'control touch never starts an ancestor tile drag')
          await act(async () => button().click())
          assert.equal(moves.length, moveCount + 1)
          assert.equal(moves.at(-1), callback)
        }
      )
    })
  }
}

for (const reason of ['unknown-submission', 'keyboard']) {
  test(`Done exits editing without business writes after enabled becomes disabled by ${reason}`, async () => {
    const { workflowFixture } = require('../fixtures/creation.cjs')
    let media = 0,
      keyboard = 0
    const f = workflowFixture({
      files: {
        choose: async () =>
          ['a', 'b', 'c'].map((id) => ({ path: `/${id}`, size: 10, mimeType: 'image/png' })),
        upload: async () => ({ id: ++media })
      },
      submit: async () => {
        throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
      }
    })
    f.workflow.setDescription('ready')
    await f.workflow.addPhotos()
    await f.workflow.prepareQuote()
    await withReactDOM({
      run: async ({ root, act }) => {
        const CreatePage = load('src/pages/create/index.jsx', {
          ...mocks,
          '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }), creationAccountKey: () => 'owner' },
          '../../use-viewport': { useViewport: () => ({ style: {}, keyboard }) },
          '../../features/creation/use-creation-workflow': {
            useCreationWorkflow: () => ({
              state: React.useSyncExternalStore(f.workflow.subscribe, f.workflow.getSnapshot),
              workflow: f.workflow
            })
          }
        }).default
        const button = (label) =>
          Array.from(document.querySelectorAll('button')).find((node) => node.textContent === label)
        await act(async () => root.render(React.createElement(CreatePage)))
        await act(async () => button('整理').click())
        assert.ok(document.querySelector('.photo-order__grid'))
        if (reason === 'unknown-submission') {
          await act(async () => f.workflow.generate())
          assert.ok(f.workflow.getSnapshot().submission)
        } else {
          keyboard = 300
          await act(async () => root.render(React.createElement(CreatePage)))
        }
        assert.equal(button('前移').disabled, true)
        assert.equal(button('后移').disabled, true)
        assert.equal(button('完成').disabled, false)
        const before = f.workflow.getSnapshot(),
          writes = f.writes.length,
          sent = f.sent.length
        await act(async () => button('完成').click())
        assert.equal(document.querySelector('.photo-order__grid'), null)
        assert.equal(button('整理').disabled, true)
        assert.equal(f.workflow.getSnapshot(), before)
        assert.equal(f.writes.length, writes)
        assert.equal(f.sent.length, sent)
      }
    })
    f.workflow.dispose()
  })
}


test('workflow hook rejects full identity expiry change before a React rerender', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const { workflowFixture } = require('../fixtures/creation.cjs')
      const f = workflowFixture()
      let key = '1:token:expiry-a'
      const { useCreationWorkflow } = load('src/features/creation/use-creation-workflow.js', {
        '@tarojs/taro': { useDidShow() {}, useDidHide() {} },
        '../../auth': { getStoredToken: () => 'token' },
        '../../use-account': { creationAccountKey: () => key },
        '../../creation-api': { creationApi: f.api },
        '../../creation-platform': {
          accountStorage: () => ({ get() {}, set() {} }),
          photoPlatform: {},
          requestKey: () => 'id'
        }
      })
      let creation
      function Probe() {
        creation = useCreationWorkflow({
          account: { user: { id: 1 }, accountKey: key },
          sessionId: 4
        })
        return null
      }
      await act(async () => root.render(React.createElement(Probe)))
      const before = creation.workflow.getSnapshot()
      key = '1:token:expiry-b'
      await act(async () => creation.workflow.setDescription('stale owner'))
      assert.equal(creation.workflow.getSnapshot(), before)
      f.workflow.dispose()
    }
  })
})

test('late restore cannot publish readiness for a replacement workflow owner', async () => {
  await withReactDOM({
    run: async ({ root, act }) => {
      const { workflowFixture } = require('../fixtures/creation.cjs')
      const f = workflowFixture()
      let finishOld
      const old = new Promise((resolve) => {
        finishOld = resolve
      })
      f.api.getSession = async ({ sessionId }) => {
        if (sessionId === 4) await old
        return {
          ...f.session,
          id: sessionId,
          draft: { input: { inputMediaIds: [], description: '', userNotes: '' } }
        }
      }
      const { useCreationWorkflow } = load('src/features/creation/use-creation-workflow.js', {
        '@tarojs/taro': { useDidShow() {}, useDidHide() {} },
        '../../use-account': { creationAccountKey: () => 'owner' },
        '../../creation-api': { creationApi: f.api },
        '../../creation-platform': {
          accountStorage: () => ({ get() {}, set() {} }),
          photoPlatform: {},
          requestKey: () => 'id'
        }
      })
      let creation
      function Probe({ sessionId }) {
        creation = useCreationWorkflow({
          account: { user: { id: 1 }, accountKey: 'owner' },
          sessionId
        })
        return null
      }
      await act(async () => root.render(React.createElement(Probe, { sessionId: 4 })))
      assert.equal(creation.restored, false)
      const previous = creation.workflow
      await act(async () => root.render(React.createElement(Probe, { sessionId: 5 })))
      const current = creation.workflow
      assert.notEqual(current, previous)
      assert.equal(creation.restored, true)
      await act(async () => finishOld())
      assert.equal(creation.workflow, current)
      assert.equal(creation.restored, true)
      assert.equal(creation.state.sessionId, 5)
      f.workflow.dispose()
    }
  })
})

test('cursor hook composes owner/visibility/controller interest without recreating on hide', async () => {
  await withReactDOM({ run: async ({ root, act }) => {
    const pending = [], shows = [], hides = []
    let list, owner = 'a'
    const { useCursorList } = load('src/use-cursor-list.js', { '@tarojs/taro': {
      useDidShow: (fn) => { shows.push(fn) }, useDidHide: (fn) => { hides.push(fn) }
    } })
    function Probe({ accountKey = 'a', saved = false }) {
      list = useCursorList({ accountKey, filters: { saved }, isInterested: () => owner === accountKey,
        read: (args) => new Promise((resolve) => pending.push({ args, resolve })) })
      return null
    }
    await act(async () => root.render(React.createElement(Probe)))
    assert.equal(pending[0].args.isInterested(), true)
    await act(async () => hides.at(-1)())
    assert.equal(pending[0].args.isInterested(), false)
    pending[0].args.onWarning('hidden warning')
    await act(async () => pending[0].resolve({ items: [{ id: 1 }], nextCursor: null, hasMore: false }))
    assert.equal(list.items.length, 0); assert.equal(list.warning, '')
    await act(async () => list.load()); assert.equal(pending.length, 1)
    await act(async () => shows.at(-1)()); assert.equal(pending.length, 2)
    owner = 'b' // Real owner can change before the next React render.
    assert.equal(pending[1].args.isInterested(), false)
    pending[1].args.onWarning('old owner')
    await act(async () => pending[1].resolve({ items: [], nextCursor: null, hasMore: false }))
    assert.equal(list.warning, '')
    await act(async () => root.render(React.createElement(Probe, { accountKey: 'b' })))
    assert.equal(pending.length, 3)
    pending[2].args.onWarning('current owner warning')
    await act(async () => pending[2].resolve({ items: [], nextCursor: null, hasMore: false }))
    assert.equal(list.warning, 'current owner warning'); assert.equal(list.loaded, true)
    await act(async () => root.render(React.createElement(Probe, { accountKey: 'b', saved: true })))
    assert.equal(list.warning, ''); assert.equal(pending[2].args.isInterested(), false)
    await act(async () => root.unmount())
    assert.equal(pending[3].args.isInterested(), false)
  } })
})

test('Cabinet renders one uncertain Notice with read-only retry alongside normal empty data', async () => {
  await withReactDOM({ run: async ({ root, act }) => {
    let reads = 0, writes = 0
    const Page = load('src/pages/cabinet/index.jsx', {
      ...mocks,
      '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }), creationAccountKey: () => 'owner' },
      '../../creation-api': { creationApi: {
        artifacts: async ({ isInterested, onWarning }) => {
          reads++; assert.equal(isInterested(), true); onWarning('收藏状态仍待核对')
          return { items: [], nextCursor: null, hasMore: false }
        },
        favorite: async () => { writes++ }
      } },
      '../../components/PrivateImage': () => null,
      '../../components/primitives': {
        Brand: () => null, NavBar: () => null,
        Action: nativeComponent('button'),
        Notice: ({ children, onRetry }) => React.createElement('aside', null, children, React.createElement('button', { onClick: onRetry }, '重试读取'))
      }
    }).default
    await act(async () => root.render(React.createElement(Page)))
    assert.equal(document.querySelectorAll('aside').length, 1)
    assert.match(document.body.textContent, /当前未读到作品/)
    await act(async () => document.querySelector('aside button').click())
    assert.equal(reads, 2); assert.equal(writes, 0); assert.equal(document.querySelectorAll('aside').length, 1)
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '已收藏').click())
    assert.equal(reads, 3); assert.equal(writes, 0); assert.equal(document.querySelectorAll('aside').length, 1)
    assert.match(document.body.textContent, /当前未读到收藏/)
  } })
})

test('Cabinet prioritizes one read error over retained uncertainty and retries the same cursor', async () => {
  await withReactDOM({ run: async ({ root, act }) => {
    const cursors = []; let failure = true
    const Page = load('src/pages/cabinet/index.jsx', {
      ...mocks,
      '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }), creationAccountKey: () => 'owner' },
      '../../creation-api': { creationApi: { artifacts: async ({ cursor, onWarning }) => {
        cursors.push(cursor)
        if (cursor && failure) throw Error('NETWORK')
        onWarning('收藏状态仍待核对')
        return { items: [], nextCursor: cursor ? null : 'older', hasMore: !cursor }
      } } },
      '../../components/PrivateImage': () => null,
      '../../components/primitives': {
        Brand: () => null, NavBar: () => null, Action: nativeComponent('button'),
        Notice: ({ children, onRetry }) => React.createElement('aside', null, children, React.createElement('button', { onClick: onRetry }, '重试读取'))
      }
    }).default
    await act(async () => root.render(React.createElement(Page)))
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '查看更多作品').click())
    assert.equal(document.querySelectorAll('aside').length, 1)
    assert.match(document.querySelector('aside').textContent, /暂时连接不上/)
    failure = false
    await act(async () => document.querySelector('aside button').click())
    assert.deepEqual(cursors, [undefined, 'older', 'older'])
    assert.equal(document.querySelectorAll('aside').length, 1)
    assert.match(document.querySelector('aside').textContent, /收藏状态仍待核对/)
    assert.match(document.body.textContent, /当前未读到作品/)
  } })
})

const photoConfigurationCases = [
  ['missing', undefined],
  ['missing maximum', {}],
  ['numeric string', { maxImages: '8' }],
  ['negative', { maxImages: -1 }],
  ['fraction', { maxImages: 1.5 }],
  ['NaN', { maxImages: NaN }],
  ['unsafe integer', { maxImages: Number.MAX_SAFE_INTEGER + 1 }],
  ['zero', { maxImages: 0 }],
  ['normal', { maxImages: 8 }]
]

for (const [label, schema] of photoConfigurationCases) {
  for (const mode of ['free', 'effect']) {
    test(`PhotoInput ${mode} ${label} projects truthful count and gates native selection`, async () => {
      await withReactDOM({
        run: async ({ root, act }) => {
          const PhotoInput = load('src/features/creation/PhotoInput/index.jsx', mocks).default
          const calls = []
          const props = {
            schema,
            mode,
            onAdd: () => calls.push('add'),
            onReplace: () => calls.push('replace'),
            onRetry: () => calls.push('retry'),
            onRemove: () => calls.push('remove'),
            onPreview: () => calls.push('preview')
          }
          const positive = label === 'normal'
          const zero = label === 'zero'
          await act(async () =>
            root.render(React.createElement(PhotoInput, { ...props, photos: [] }))
          )
          const count = document.querySelector('.references__count').textContent
          assert.equal(
            count,
            positive ? (mode === 'free' ? '选填' : '支持多张') : zero ? '无需照片' : '配置待就绪'
          )
          const emptyAdd = [...document.querySelectorAll('button')].find((button) =>
            button.textContent.includes('添加我的照片')
          )
          if (emptyAdd) {
            assert.equal(emptyAdd.disabled, !positive)
            await act(async () => emptyAdd.click())
          }
          assert.equal(calls.includes('add'), positive)
          calls.length = 0
          await act(async () =>
            root.render(
              React.createElement(PhotoInput, {
                ...props,
                photos: [
                  { id: 'a', path: '/a.png', status: 'failed' },
                  { id: 'b', path: '/b.png', status: 'unavailable' }
                ]
              })
            )
          )
          assert.equal(
            document.querySelector('.references__count').textContent,
            positive ? '2 / 8 张' : '已选 2 张'
          )
          assert.doesNotMatch(
            document.querySelector('.references__heading').textContent,
            /2 \/ 0|最多|不接受照片/
          )
          if (zero) assert.match(document.body.textContent, /无需照片/)
          const add = document.querySelector('.photo-add')
          assert.equal(!!add, positive)
          for (const button of document.querySelectorAll('.photo-tile__retry')) {
            assert.equal(button.disabled, !positive)
            await act(async () => button.click())
          }
          assert.deepEqual(calls, positive ? ['retry', 'replace'] : [])
          await act(async () => {
            document.querySelector('.photo-tile__image').click()
            document.querySelector('.photo-tile__remove').click()
            add?.click()
          })
          assert.deepEqual(
            calls.slice(positive ? 2 : 0),
            positive ? ['preview', 'remove', 'add'] : ['preview', 'remove']
          )
          assert.equal(document.querySelectorAll('.photo-tile').length, 2)
        }
      })
    })
  }
}

for (const frozen of [null, 'submission', 'sessionRequest']) {
  for (const coreCanGenerate of [false, true]) {
    test(`actual CreatePage neutral projection preserves ${
      frozen || 'new generation'
    } core=${coreCanGenerate}`, async () => {
      await withReactDOM({
        run: async ({ root, act }) => {
          let generated = 0
          const state = {
            mode: null,
            template: null,
            photos: [],
            rounds: [],
            artifacts: {},
            description: 'retained input',
            controls: {
              canGenerate: coreCanGenerate,
              generateLabel: '确认提交结果',
              costCredits: null
            },
            ...(frozen ? { [frozen]: Object.freeze({ clientRequestId: 'frozen' }) } : {})
          }
          const before = JSON.stringify(state)
          const Page = load('src/pages/create/index.jsx', {
            ...mocks,
            '@tarojs/taro': { ...taro, useRouter: () => ({ params: { session: '4' } }) },
            '../../use-account': { useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }) },
            '../../use-viewport': { useViewport: () => ({ style: {}, keyboard: 0 }) },
            '../../features/creation/use-creation-workflow': {
              useCreationWorkflow: () => ({ state, workflow: { generate: () => generated++ } })
            },
            '../../features/creation/use-creation-timeline': {
              useCreationTimeline: () => ({ interrupt() {} })
            },
            '../../features/creation/PhotoInput/use-photo-order': { usePhotoOrder: () => ({}) }
          }).default
          await act(async () => root.render(React.createElement(Page)))
          assert.equal(!!document.querySelector('.creation-intro'), false)
          assert.equal(!!document.querySelector('.composer__input'), false)
          assert.equal(!!document.querySelector('.effect-notes'), false)
          const generate = document.querySelector('.composer__generate')
          assert.equal(generate.disabled, !(frozen && coreCanGenerate))
          assert.equal(generated, 0, 'rendering must not confirm or create requests')
          await act(async () => generate.click())
          assert.equal(generated, frozen && coreCanGenerate ? 1 : 0)
          assert.equal(
            JSON.stringify(state),
            before,
            'projection must not mutate the workflow snapshot'
          )
        }
      })
    })
  }
}

async function withNotesKeyboard(run, { mode = 'effect' } = {}) {
  const { workflowFixture } = require('../fixtures/creation.cjs')
  const f = workflowFixture({ mode })
  const fixtures = [f]
  let selected = f, params = {}
  try {
    await withReactDOM({ run: async ({ root, act }) => {
      const events = { hide: new Set(), show: new Set() }
      const lifecycle = (kind) => (callback) => {
        const current = React.useRef(callback)
        current.current = callback
        React.useEffect(() => {
          const fire = () => current.current()
          events[kind].add(fire)
          return () => events[kind].delete(fire)
        }, [])
      }
      const ticks = [], layouts = [], focusEvents = [], blurEvents = []
      let notes, composer
      const Page = load('src/pages/create/index.jsx', {
        ...mocks,
        '@tarojs/taro': {
          ...taro,
          useRouter: () => ({ params }),
          useDidHide: lifecycle('hide'),
          useDidShow: lifecycle('show'),
          nextTick: (callback) => ticks.push(() => {
            layouts.push(document.querySelector('.create-screen')?.style.height)
            callback()
          })
        },
        '@tarojs/components': {
          ...components,
          ScrollView: ({ children, className, scrollIntoView }) =>
            React.createElement('section', { className, 'data-anchor': scrollIntoView || '' }, children)
        },
        '../../use-account': {
          useAccount: () => ({ user: { id: 1 }, accountKey: 'owner' }),
          creationAccountKey: () => 'owner'
        },
        '../../use-viewport': {
          useViewport() {
            const [value, setValue] = React.useState({ keyboard: 0, style: { height: '844px' } })
            return {
              ...value,
              onFocus: (event) => focusEvents.push(event),
              onBlur: (event) => blurEvents.push(event),
              onKeyboardHeightChange: (event) => setValue({
                keyboard: event.detail.height,
                style: { height: `${844 - event.detail.height}px` }
              })
            }
          }
        },
        '../../features/creation/use-creation-workflow': {
          useCreationWorkflow: () => ({
            state: React.useSyncExternalStore(selected.workflow.subscribe, selected.workflow.getSnapshot),
            workflow: selected.workflow, restored: true
          })
        },
        '../../features/creation/EffectNotes': (props) => { notes = props; return null },
        '../../features/creation/CreationComposer': (props) => { composer = props; return null }
      }).default
      await act(async () => root.render(React.createElement(Page)))
      const h = {
        f, ticks, layouts, focusEvents, blurEvents,
        get notes() { return notes },
        get composer() { return composer },
        anchor: () => document.querySelector('.timeline')?.getAttribute('data-anchor'),
        call: async (callback) => act(async () => callback()),
        flush: async () => act(async () => { while (ticks.length) ticks.shift()() }),
        fire: async (kind) => act(async () => { for (const callback of events[kind]) callback() }),
        unmount: async () => act(async () => root.render(null)),
        switchWorkflow: async () => {
          selected = workflowFixture({ mode })
          fixtures.push(selected)
          await act(async () => root.render(React.createElement(Page)))
        },
        focusRoute: async (taskId) => {
          params = { ...params, focusTask: String(taskId) }
          await act(async () => root.render(React.createElement(Page)))
        }
      }
      await run(h)
    } })
  } finally { fixtures.forEach((fixture) => fixture.workflow.dispose()) }
}

test('notes focus reveals once after keyboard 300 layout commits, not on unrelated renders or free composer', async () => {
  await withNotesKeyboard(async (h) => {
    const focus = { detail: { height: 0 } }
    await h.call(() => h.notes.onFocus(focus))
    assert.equal(h.focusEvents[0], focus, 'notes must forward the original native event')
    assert.equal(h.ticks.length, 0)
    await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 300 } }))
    assert.equal(document.querySelector('.create-screen').style.height, '544px')
    assert.equal(h.ticks.length, 1, 'focused notes must schedule a fresh post-keyboard reveal')
    assert.equal(h.anchor(), '')
    await h.flush()
    assert.equal(h.anchor(), 'effect-notes')
    assert.deepEqual(h.layouts, ['544px'])
    await h.call(() => h.notes.onFocus({ detail: { height: 300 } }))
    await h.call(() => h.notes.onNotes('input retained without repeated following'))
    assert.equal(h.ticks.length, 0, 'typing and repeated focus must not steal scroll again')
    assert.equal(h.f.workflow.getSnapshot().userNotes, 'input retained without repeated following')
  })
  await withNotesKeyboard(async (h) => {
    const focus = { detail: { height: 0 } }
    await h.call(() => h.composer.onFocus(focus))
    assert.equal(h.focusEvents[0], focus, 'free composer keeps the original shared handler')
    await h.call(() => h.composer.onKeyboardHeightChange({ detail: { height: 300 } }))
    assert.equal(h.ticks.length, 0, 'free composer must not reveal effect notes')
  }, { mode: 'free' })
})

for (const boundary of ['blur', 'hide', 'unmount']) {
  test(`notes pending post-keyboard reveal is cancelled by ${boundary}`, async () => {
    await withNotesKeyboard(async (h) => {
      await h.call(() => h.notes.onFocus({ detail: { height: 0 } }))
      await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 300 } }))
      assert.equal(h.ticks.length, 1)
      if (boundary === 'blur') {
        const blur = { detail: { value: 'retained' } }
        await h.call(() => h.notes.onBlur(blur))
        assert.equal(h.blurEvents[0], blur)
      }
      else if (boundary === 'hide') await h.fire('hide')
      else await h.unmount()
      await h.flush()
      assert.ok(!h.anchor(), 'a stale callback must not restore the notes anchor')
      if (boundary === 'hide') {
        await h.fire('show')
        assert.equal(h.ticks.length, 0, 'show without a new input focus must not resume an old reveal')
      }
    })
  })
}


for (const event of ['focus', 'blur']) {
  test(`old workflow notes ${event} cannot disturb the newly focused workflow`, async () => {
    await withNotesKeyboard(async (h) => {
      await h.call(() => h.notes.onFocus({ detail: { height: 0 } }))
      await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 300 } }))
      await h.flush()
      const oldNotes = h.notes
      await h.switchWorkflow()
      await h.call(() => h.notes.onFocus({ detail: { height: 0 } }))
      assert.equal(h.ticks.length, 1, 'new workflow focus must reveal even while the same keyboard is already open')
      await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 320 } }))
      const focusCount = h.focusEvents.length, blurCount = h.blurEvents.length
      await h.call(() => event === 'focus' ? oldNotes.onFocus({ detail: { height: 320 } }) : oldNotes.onBlur({}))
      assert.equal(h.focusEvents.length, focusCount, 'old focus must not reach the current viewport')
      assert.equal(h.blurEvents.length, blurCount, 'old blur must not reach the current viewport')
      await h.flush()
      assert.equal(h.anchor(), 'effect-notes', 'old events must not cancel the new owner notes reveal')
    })
  })
}

test('notes cleanup preserves a subsequently requested round focus', async () => {
  await withNotesKeyboard(async (h) => {
    await h.call(() => h.notes.onFocus({ detail: { height: 0 } }))
    await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 300 } }))
    assert.equal(h.ticks.length, 1)
    await h.focusRoute(9)
    assert.ok(h.ticks.length > 1, 'new round focus must queue its own independent anchor')
    await h.call(() => h.notes.onKeyboardHeightChange({ detail: { height: 0 } }))
    await h.flush()
    assert.equal(h.anchor(), 'round-9', 'notes-only cleanup must not cancel a newer round intent')
  })
})
