const { load } = require('../source.cjs')

exports.template = (mode = 'free') => ({
  templateId: 1,
  mode,
  costCredits: 3,
  schemaVersion: 1,
  minClientCapability: '1',
  displayConfig: {
    name: '自由创作',
    description: '',
    photoHint: '本人照片',
    coverMediaId: null,
    showcaseShareKeys: [],
    categoryId: null,
    categoryName: null,
    tags: [],
    tagIds: [],
    primaryTagId: null,
    searchAliases: []
  },
  inputSchema: {
    minImages: mode === 'free' ? 0 : 1,
    maxImages: 8,
    allowedMimeTypes: ['image/jpeg', 'image/png'],
    maxImageBytes: 10485760,
    maxTotalImageBytes: 33554432,
    maxDescriptionLength: mode === 'free' ? 2000 : 0,
    maxNotesLength: mode === 'free' ? 0 : 2000
  }
})
exports.task = (body = {}, extra = {}) => ({
  id: 9,
  clientRequestId: body.clientRequestId || 'history',
  costCredits: 3,
  errorCode: null,
  input: body.input || { description: '原要求', userNotes: '', inputMediaIds: [15, 16] },
  roundNo: 1,
  sessionId: 4,
  sourceTaskId: null,
  status: 'queued',
  templateId: 1,
  ...extra
})
exports.workflowFixture = (options = {}) => {
  const saved = options.saved || new Map()
  const sent = []
  const writes = []
  const control = { fail: () => false, beforeSet: () => {} }
  let sequence = 0
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  const template = exports.template(options.mode)
  const session = {
    id: 4,
    title: '自由创作',
    titleSource: 'template',
    mode: template.mode,
    templateId: 1,
    lastActivityAt: '2026-11-13T00:00:00Z',
    runningTask: null,
    cover: null
  }
  const storage = {
    listKeys: ({ prefix }) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
    get: (k) => clone(saved.get(k)),
    set: (k, v) => {
      writes.push({ key: k, draft: clone(v) })
      control.beforeSet(k, v)
      if (control.fail(k, v)) throw Error('STORAGE_FULL')
      saved.set(k, clone(v))
    }
  }
  const api = {
    account: async () => ({
      available: 20,
      reserved: 0,
      sources: [{ sourceType: 'trial', available: 20 }],
      configured: true
    }),
    template: async () => template,
    freePreset: async () => template,
    createSession: async () => session,
    getSession: async () => ({
      ...session,
      draft: {
        input: { description: '', userNotes: '', inputMediaIds: [] },
        updatedAt: '2026-11-13T00:00:00Z'
      }
    }),
    putDraft: async ({ input }) => ({ input, updatedAt: '2026-11-13T00:00:00Z' }),
    tasks: async () => ({ items: [], nextCursor: null, hasMore: false }),
    task: async () => exports.task(),
    artifact: async ({ artifactId }) => ({
      id: artifactId,
      taskId: 9,
      sessionId: 4,
      mediaId: 90,
      isFavorite: false
    }),
    favorite: async ({ artifactId, isFavorite }) => ({ artifactId, isFavorite, savedAt: null }),
    quote: async () => ({
      costCredits: 3,
      templateId: 1,
      quoteToken: 'quote',
      validUntil: '2099-01-01T00:00:00Z'
    }),
    generate: async (body) => {
      sent.push(clone(body))
      return options.submit ? options.submit(body) : exports.task(body)
    },
    regenerate: async (body) => {
      sent.push(clone(body))
      return options.submit ? options.submit(body) : exports.task(body, { sourceTaskId: 9 })
    },
    ...options.api
  }
  const files = {
    choose: async () => [],
    upload: async () => ({ id: 7 }),
    exists: async () => true,
    preview: async () => '/private.png',
    ...options.files
  }
  const effectiveTemplate = options.template === null ? null : template
  const resolvedSessionId = options.sessionId === undefined ? 4 : options.sessionId
  if (options.saved === undefined && effectiveTemplate &&
    Number.isSafeInteger(resolvedSessionId) && resolvedSessionId > 0) {
    saved.set(`session:${resolvedSessionId}`, { protocol: 2, mode: effectiveTemplate.mode,
      // Deliberately retain a pre-migration local draft; API fixtures above use current DTOs.
      templateId: effectiveTemplate.templateId, templateVersionId: 2,
      sessionId: resolvedSessionId, description: '', userNotes: '', photos: [],
      carryBackSourceTaskId: null, sessionRequest: null, submission: null, draftPaused: false,
      recoveryKey: `unsettled:session:${resolvedSessionId}` })
  }
  const { createWorkflow } = load('src/creation-workflow.js')
  const workflow = createWorkflow({
    api,
    files,
    storage,
    key: options.key || 'owner:1:free',
    template: options.template === null ? null : template,
    sessionId: options.sessionId === undefined ? 4 : options.sessionId,
    makeId: () => `request-${++sequence}`,
    isCurrent: options.isCurrent
  })
  return { workflow, saved, state: saved, sent, submissions: sent, writes, control, api, session, template }
}
exports.ready = async (w, description = '原来的描述') => {
  w.setDescription(description)
  await w.prepareQuote()
}
