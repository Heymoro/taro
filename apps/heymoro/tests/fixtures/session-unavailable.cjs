const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')
const { workflowFixture } = require('./creation.cjs')
const { withPages } = require('./creation-pages.cjs')

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const gate = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const response = (data, statusCode = 200) => ({
  statusCode,
  data: { data, requestId: 'memory-read' }
})
const notFound = () => ({
  statusCode: 404,
  data: {
    error: { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false },
    requestId: 'memory-404'
  }
})
function memoryStorage(saved = new Map()) {
  const writes = [],
    reads = []
  return {
    saved,
    writes,
    reads,
    get(key) {
      reads.push(key)
      return clone(saved.get(key))
    },
    set(key, value) {
      writes.push([key, clone(value)])
      saved.set(key, clone(value))
    }
  }
}
function ordinary(patch = {}) {
  return {
    protocol: 2,
    mode: 'free',
    sessionId: 4,
    templateId: 1,
    templateVersionId: 2,
    description: '  original idea  ',
    userNotes: '',
    photos: [],
    carryBackSourceTaskId: null,
    sessionRequest: null,
    submission: null,
    draftPaused: false,
    recoveryKey: 'unsettled:session:4',
    ...patch
  }
}
function frozen(operation = 'generate') {
  const record =
    operation === 'session'
      ? ordinary({
          sessionId: null,
          recoveryKey: 'unsettled:template:free',
          sessionRequest: {
            templateId: 1,
            templateVersionId: 2,
            clientRequestId: 'original-session'
          }
        })
      : ordinary({
          submission: {
            protocol: 2,
            path: operation === 'regenerate' ? '/artifacts/66/regenerations' : '/generations',
            body:
              operation === 'regenerate'
                ? { clientRequestId: 'original-generation', quoteToken: 'original-quote' }
                : {
                    sessionId: 4,
                    input: { description: '  original idea  ', userNotes: '', inputMediaIds: [] },
                    clientRequestId: 'original-generation',
                    quoteToken: 'original-quote'
                  },
            sessionId: 4,
            sourceArtifactId: operation === 'regenerate' ? 66 : null,
            templateVersionId: 2,
            costCredits: 3
          }
        })
  assert.ok(load('src/features/creation/recovery-contract.js').readUnsettledRecord({ record }))
  return record
}
function frozenMap(
  record,
  draftKey = record.sessionId ? `session:${record.sessionId}` : 'template:free'
) {
  const envelope = { protocol: 2, draftKey, record }
  const checked = load('src/features/creation/recovery-contract.js').readRecoveryEntry({
    value: envelope,
    recoveryKey: record.recoveryKey,
    storageKey: draftKey
  })
  assert.ok(checked, 'the recovery envelope must validate before exercising F confirmation')
  return new Map([
    [draftKey, record],
    [record.recoveryKey, envelope]
  ])
}
function controlledApi(ports, options = {}) {
  const calls = [],
    wire = []
  const control = { missing: false, sessionResponse: null, gate: null, ...options }
  let clears = 0
  const owner = { userId: 1, token: 'fixture-token', expiresAt: '2099-01-01' }
  const native = load('src/creation-api.js', {
    '@tarojs/taro': {
      request: async (request) => {
        wire.push({ method: request.method, url: request.url, data: clone(request.data) })
        if (control.transport) throw Error('memory transport failure')
        if (control.gate) {
          const heldResponse = await control.gate.promise
          if (heldResponse) return heldResponse
        }
        if (control.sessionResponse) return control.sessionResponse
        if (control.missing) return notFound()
        return response(await ports.getSession({ sessionId: 4 }))
      },
      downloadFile: async () => control.downloadResponse || { statusCode: 404 }
    },
    './auth': {
      getStoredSession: () => owner,
      getStoredToken: () => owner.token,
      clearToken: () => clears++
    }
  })
  const api = {}
  for (const name of Object.keys(ports)) {
    api[name] = async (...args) => {
      calls.push({ name, args: clone(args), owner: clone(owner) })
      return name === 'getSession' ? native.creationApi.getSession(...args) : ports[name](...args)
    }
  }
  return { api, calls, wire, control, native, clears: () => clears }
}
function fixture(options = {}) {
  const storage = memoryStorage(options.saved || new Map())
  const base = workflowFixture({ ...options, saved: storage.saved })
  const controlled = controlledApi(base.api, options.control)
  const workflow = load('src/creation-workflow.js').createWorkflow({
    api: controlled.api,
    files: {
      choose: async () => [],
      upload: async () => ({ id: 7 }),
      exists: async () => true,
      preview: async () => '/private.png',
      ...options.files
    },
    storage,
    key: 'template:free',
    template: options.template === null ? null : base.template,
    sessionId: options.sessionId === undefined ? 4 : options.sessionId,
    makeId: options.makeId || (() => 'new-request'),
    isCurrent: options.isCurrent
  })
  base.workflow.dispose()
  return { ...controlled, workflow, storage, base }
}
async function pages(run, options = {}) {
  const storage = memoryStorage(options.saved || new Map())
  let controlled
  return withPages(async (h) => run({ ...h, ...controlled, storage }), {
    ...options,
    creationStorage: storage,
    createApi: ({ ports, native }) => {
      if (options.showModal) native.showModal = options.showModal
      controlled = controlledApi({ ...ports, ...options.api }, options.control)
      return { creationApi: controlled.api }
    }
  })
}
const tick = async (t, h, ms) => {
  await h.act(async () => t.mock.timers.tick(ms))
  await h.flush()
}
function productionNavBar() {
  const component =
    (tag) =>
    ({ children, className, onClick, disabled }) =>
      React.createElement(tag, { className, onClick, disabled }, children)
  return load('src/components/primitives.jsx', {
    '@tarojs/taro': {
      getWindowInfo: () => ({ windowWidth: 390, statusBarHeight: 20 }),
      getMenuButtonBoundingClientRect: () => ({ top: 50, height: 30, left: 303 }),
      getCurrentPages: () => [],
      navigateBack: () => {},
      switchTab: () => {}
    },
    '@tarojs/components': {
      Button: component('button'),
      View: component('div'),
      Text: component('span'),
      Image: component('img')
    },
    '../creation-api': { officialImage: () => '' },
    '../templates': { templateRoute: () => '' }
  }).NavBar
}

module.exports = {
  productionNavBar,
  clone,
  gate,
  response,
  notFound,
  memoryStorage,
  ordinary,
  frozen,
  frozenMap,
  controlledApi,
  fixture,
  pages,
  tick
}
