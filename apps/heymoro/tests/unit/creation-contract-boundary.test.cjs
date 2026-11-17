const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseSync } = require('@babel/core')
const { load } = require('../source.cjs')
const { task } = require('../fixtures/creation.cjs')

const root = path.resolve(__dirname, '../..')
const remotePath = 'src/creation-contract.js'
const inputPath = 'src/creation-input.js'
const recoveryPath = 'src/features/creation/recovery-contract.js'
const localNames = ['hasRecoverablePhotoSlots', 'readPendingSubmission', 'readRecoveryEntry', 'readUnsettledRecord']
const remoteNames = [
  'decode',
  'readAccount',
  'readArtifact',
  'readDraft',
  'readFavorite',
  'readHistory',
  'readPage',
  'readQuote',
  'readRename',
  'readSession',
  'readTask',
  'readTemplate',
  'readSessionShare',
]
const plain = (value) => JSON.parse(JSON.stringify(value))
const rawInput = () => ({ inputMediaIds: [9, 3], description: ' \n猫🙂  ', userNotes: '\t raw\n' })
// Characterize the original producer before the split. Capability tests below independently
// require the new module/export, so this fallback never makes a missing boundary pass.
const recovery = () => load(fs.existsSync(path.join(root, recoveryPath)) ? recoveryPath : remotePath)
const readInput = (options) => (load(inputPath).readInput || load(remotePath).readInput)(options)
const pending = () => ({
  protocol: 2,
  path: '/generations',
  sessionId: 4,
  sourceArtifactId: null,
  templateVersionId: 2,
  costCredits: 3,
  body: { sessionId: 4, input: rawInput(), clientRequestId: ' request ', quoteToken: ' quote ' },
})
const regenerate = () => ({
  ...pending(),
  path: '/artifacts/8/regenerations',
  sourceArtifactId: 8,
  body: { clientRequestId: ' request ', quoteToken: ' quote ' },
})
const record = () => ({
  protocol: 2,
  mode: 'free',
  templateId: 1,
  templateVersionId: 2,
  sessionId: 4,
  recoveryKey: 'unsettled:session:4',
  description: ' raw draft ',
  userNotes: '',
  photos: [],
  sessionRequest: null,
  submission: pending(),
})
function blocked(id, marker) {
  return Object.defineProperty({}, id, {
    get() {
      throw Error(marker)
    },
  })
}
function ast(file) {
  return parseSync(fs.readFileSync(path.join(root, file), 'utf8'), {
    babelrc: false,
    configFile: false,
    sourceType: 'module',
  }).program
}
function visit(node, match) {
  if (!node || typeof node !== 'object') return []
  const found = match(node) ? [node] : []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => found.push(...visit(child, match)))
    else if (value && typeof value === 'object') found.push(...visit(value, match))
  }
  return found
}
function imported(program) {
  return program.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => ({ source: node.source.value, names: node.specifiers.map((s) => s.imported.name) }))
}

// These markers must be hit by the actual old dependency graph, not a mocked function call.
test('remote loading never evaluates the local carry-back dependency', () => {
  assert.doesNotThrow(() =>
    load(remotePath, blocked('./features/creation/carry-back-input', 'T19_OLD_REMOTE_LOADS_CARRY_BACK'))
  )
})
test('workflow loading never evaluates the remote DTO contract', () => {
  assert.doesNotThrow(() =>
    load('src/creation-workflow.js', blocked('./creation-contract', 'T19_OLD_WORKFLOW_LOADS_REMOTE_DTO'))
  )
})
test('workflow loading never evaluates the remote API environment module', () => {
  assert.doesNotThrow(() =>
    load('src/creation-workflow.js', blocked('./api', 'T19_OLD_WORKFLOW_LOADS_API_ENVIRONMENT'))
  )
})
test('new capability: the recovery module owns exactly the four local exports', () => {
  assert.ok(fs.existsSync(path.join(root, recoveryPath)), 'NEW_CAPABILITY_MISSING_RECOVERY_MODULE')
  assert.deepEqual(Object.keys(load(recoveryPath)).sort(), [...localNames].sort())
})
test('new capability: the pure input module exposes readInput and remote exports stay remote-only', () => {
  assert.equal(typeof load(inputPath).readInput, 'function', 'NEW_CAPABILITY_MISSING_SHARED_READ_INPUT')
  assert.deepEqual(Object.keys(load(remotePath)).sort(), [...remoteNames].sort())
})
test('AST boundaries keep one input projection with direct inward imports and no reexports', () => {
  const input = ast(inputPath)
  const remote = ast(remotePath)
  assert.equal(
    visit(input, (n) => n.type === 'FunctionDeclaration' && n.id.name === 'readInput').length,
    1,
    'NEW_CAPABILITY_MISSING_SINGLE_INPUT_DEFINITION'
  )
  const local = ast(recoveryPath)
  assert.deepEqual(imported(input), [])
  assert.deepEqual(imported(remote), [
    { source: './api', names: ['ApiResponseError'] },
    { source: './creation-input', names: ['readInput'] },
  ])
  assert.deepEqual(imported(local), [
    { source: '../../creation-input', names: ['readInput'] },
    { source: './carry-back-input', names: ['hasCarryBackSource'] },
  ])
  for (const program of [remote, local]) {
    assert.equal(visit(program, (n) => n.type === 'FunctionDeclaration' && n.id.name === 'readInput').length, 0)
    assert.equal(
      program.body.filter(
        (n) =>
          n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && (!n.declaration || n.source))
      ).length,
      0
    )
  }
  for (const [program, names] of [
    [remote, ['readTask', 'readDraft']],
    [local, ['readPendingSubmission', 'readUnsettledRecord']],
  ]) {
    for (const name of names) {
      const fn = visit(program, (n) => n.type === 'FunctionDeclaration' && n.id.name === name)[0]
      assert.ok(visit(fn, (n) => n.type === 'CallExpression' && n.callee.name === 'readInput').length, name)
    }
  }
  const workflowImports = imported(ast('src/creation-workflow.js'))
  assert.deepEqual(
    workflowImports.find((item) => item.source === './features/creation/recovery-contract'),
    { source: './features/creation/recovery-contract', names: ['readPendingSubmission'] }
  )
  assert.deepEqual(
    workflowImports.find((item) => item.source === './features/creation/initial-input-recovery'),
    { source: './features/creation/initial-input-recovery', names: ['createInitialInputRecovery'] }
  )
  assert.deepEqual(
    imported(ast('src/features/creation/initial-input-recovery.js')).find((item) => item.source === './recovery-contract'),
    { source: './recovery-contract', names: localNames.filter((name) => name !== 'readPendingSubmission') }
  )
  assert.equal(
    workflowImports.some((item) => item.source === './creation-contract'),
    false
  )
})

test('input projection preserves raw text, field order and media order without array aliases', () => {
  const value = { ...rawInput(), privateField: 'discard' }
  value.inputMediaIds.extra = 'accepted but not projected'
  const got = readInput({ value })
  assert.deepEqual(Object.keys(got), ['inputMediaIds', 'description', 'userNotes'])
  assert.deepEqual(plain(got), rawInput())
  assert.notEqual(got.inputMediaIds, value.inputMediaIds)
  assert.equal(got.inputMediaIds.extra, undefined)
  got.inputMediaIds.push(42)
  assert.deepEqual(value.inputMediaIds.slice(), [9, 3])
})
test('input projection retains the original sparse-array acceptance boundary', () => {
  const oneHole = new Array(1)
  const got = readInput({ value: { ...rawInput(), inputMediaIds: oneHole } })
  assert.equal(got.inputMediaIds.length, 1)
  assert.equal(Object.hasOwn(got.inputMediaIds, 0), true)
  assert.equal(got.inputMediaIds[0], undefined)
  const mixed = [9, , 3]
  assert.deepEqual(Array.from(readInput({ value: { ...rawInput(), inputMediaIds: mixed } }).inputMediaIds), [
    9,
    undefined,
    3,
  ])
  assert.throws(() => readInput({ value: { ...rawInput(), inputMediaIds: new Array(2) } }), {
    message: 'INVALID_RESPONSE',
  })
})
test('input invalid records keep INVALID_RESPONSE while accessors keep their original exception', () => {
  for (const value of [
    null,
    [],
    {},
    { ...rawInput(), inputMediaIds: [3, 3] },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9', null, undefined].map((id) => ({
      ...rawInput(),
      inputMediaIds: [id],
    })),
    { ...rawInput(), description: null },
    { ...rawInput(), userNotes: 1 },
  ]) {
    assert.throws(() => readInput({ value }), { message: 'INVALID_RESPONSE' })
  }
  const marker = Error('input accessor failure')
  const value = Object.defineProperty(rawInput(), 'description', {
    get() {
      throw marker
    },
  })
  assert.throws(
    () => readInput({ value }),
    (error) => error === marker
  )
})
test('remote and local real consumers delegate to the exact shared input export', () => {
  const shared = load(inputPath)
  assert.equal(typeof shared.readInput, 'function', 'NEW_CAPABILITY_MISSING_SHARED_DELEGATION')
  const values = []
  const inputModule = {
    readInput: (options) => {
      values.push(options.value)
      return shared.readInput(options)
    },
  }
  const remote = load(remotePath, { './creation-input': inputModule })
  const local = load(recoveryPath, { '../../creation-input': inputModule })
  const input = rawInput()
  remote.readTask({ value: task({ input }) })
  remote.readDraft({ value: { input, updatedAt: '2026-11-13T00:00:00Z' } })
  assert.equal(values.filter((value) => value === input).length, 2)
  const value = pending()
  assert.equal(local.readPendingSubmission({ value, sessionId: 4 }).submission, value)
  const saved = { ...record(), submission: value }
  assert.ok(local.readUnsettledRecord({ record: saved }))
  assert.equal(values.filter((input) => input === value.body.input).length, 3)
})

test('pending generate and regenerate keep discriminants, original references and raw input', () => {
  const { readPendingSubmission } = recovery()
  for (const [value, operation] of [
    [pending(), 'generate'],
    [regenerate(), 'regenerate'],
  ]) {
    const before = JSON.stringify(value)
    const got = readPendingSubmission({ value, sessionId: 4 })
    assert.equal(got.operation, operation)
    assert.equal(got.submission, value)
    assert.equal(JSON.stringify(value), before)
  }
})
test('pending rejects mismatched session, source/path, exact fields and malformed input', () => {
  const { readPendingSubmission } = recovery()
  const cases = [
    { ...pending(), protocol: 1 },
    { ...pending(), sessionId: 5 },
    { ...pending(), templateVersionId: 0 },
    { ...pending(), costCredits: -1 },
    { ...pending(), sourceArtifactId: 8 },
    { ...pending(), path: '/other' },
    { ...regenerate(), sourceArtifactId: 9 },
    { ...regenerate(), sourceArtifactId: null },
    { ...regenerate(), body: { ...regenerate().body, input: rawInput() } },
  ]
  for (const transform of [
    (body) => ({ ...body, sessionId: 5 }),
    (body) => ({ ...body, extra: true }),
    (body) => {
      const { quoteToken, ...rest } = body
      return rest
    },
    (body) => ({ ...body, input: { ...body.input, extra: true } }),
    (body) => ({ ...body, input: { ...body.input, inputMediaIds: [3, 3] } }),
    (body) => ({ ...body, input: { ...body.input, inputMediaIds: new Array(1) } }),
    (body) => ({ ...body, input: { ...body.input, inputMediaIds: Object.assign([9], { extra: 1 }) } }),
  ])
    cases.push({ ...pending(), body: transform(pending().body) })
  for (const value of cases) assert.equal(readPendingSubmission({ value, sessionId: 4 }), null)
  assert.equal(readPendingSubmission({ value: pending(), sessionId: 0 }), null)
  const value = pending()
  Object.defineProperty(value.body, 'quoteToken', {
    get() {
      throw Error('broken persisted getter')
    },
  })
  assert.equal(readPendingSubmission({ value, sessionId: 4 }), null)
})
test('pending request and quote lengths retain inclusive limits without trimming or expiry admission', () => {
  const { readPendingSubmission } = recovery()
  for (const [field, limit] of [
    ['clientRequestId', 128],
    ['quoteToken', 8192],
  ]) {
    for (const [text, valid] of [
      ['', false],
      [' \n\t', false],
      ['x', true],
      ['x'.repeat(limit), true],
      ['x'.repeat(limit + 1), false],
    ]) {
      const value = pending()
      value.body[field] = text
      assert.equal(!!readPendingSubmission({ value, sessionId: 4 }), valid, `${field}:${text.length}`)
    }
  }
  const value = pending()
  value.body.input.description = ' beyond any current schema '.repeat(1000)
  value.validUntil = '2000-01-01T00:00:00Z'
  assert.ok(readPendingSubmission({ value, sessionId: 4 }))
})
test('pending HTTP JSON budget is exactly 131072 UTF-8 bytes including multibyte and escaped text', () => {
  const { readPendingSubmission } = recovery()
  for (const text of ['a', '猫', '🙂', '\n', '"', '\\']) {
    const value = pending()
    value.body.input.description = ''
    const overhead = Buffer.byteLength(JSON.stringify(value.body))
    const unit = Buffer.byteLength(JSON.stringify(text)) - 2
    const room = 131072 - overhead
    value.body.input.description = text.repeat(Math.floor(room / unit)) + 'a'.repeat(room % unit)
    assert.equal(Buffer.byteLength(JSON.stringify(value.body)), 131072)
    assert.ok(readPendingSubmission({ value, sessionId: 4 }), JSON.stringify(text))
    value.body.input.description += 'a'
    assert.equal(Buffer.byteLength(JSON.stringify(value.body)), 131073)
    assert.equal(readPendingSubmission({ value, sessionId: 4 }), null)
  }
})
test('recoverable slots preserve five states and reject duplicate, sparse or invalid metadata', () => {
  const { hasRecoverablePhotoSlots: valid } = recovery()
  for (const status of ['pending', 'failed', 'uploading', 'ready']) {
    assert.equal(valid({ photos: [{ id: status, status, ...(status === 'ready' ? { mediaId: 7 } : {}) }] }), true)
  }
  const slot = { id: 'slot', status: 'ready', mediaId: 7, size: 0, name: '', mimeType: '', error: '' }
  assert.equal(valid({ photos: [slot] }), true)
  for (const photos of [
    new Array(1),
    Object.assign([slot], { extra: true }),
    [slot, slot],
    [null],
    [{ ...slot, id: ' ' }],
    [{ ...slot, status: 'other' }],
    [{ ...slot, mediaId: null }],
    [{ ...slot, path: 1 }],
    [{ ...slot, size: -1 }],
    [{ ...slot, size: Infinity }],
    ...['name', 'mimeType', 'error'].map((field) => [{ ...slot, [field]: null }]),
  ]) {
    assert.equal(valid({ photos }), false)
  }
})
test('unavailable slots require the original carry provenance without imposing current schema limits', () => {
  const { hasRecoverablePhotoSlots: valid } = recovery()
  const slot = { id: 'media:7', mediaId: 7, status: 'unavailable', path: '' }
  const source = { carryBackSourceTaskId: 9, sessionId: 4 }
  assert.equal(valid({ photos: [], ...source }), true)
  assert.equal(valid({ photos: [{ id: 'old', status: 'pending' }] }), true)
  assert.equal(valid({ photos: [slot], ...source }), true)
  assert.equal(valid({ photos: [slot] }), false)
  for (const change of [{ id: 'other' }, { path: '/local' }, { size: 0 }, { mimeType: '' }, { mediaId: 8 }]) {
    assert.equal(valid({ photos: [{ ...slot, ...change }], ...source }), false)
  }
  for (const change of [{ sessionId: null }, { carryBackSourceTaskId: 0 }]) {
    assert.equal(valid({ photos: [slot], ...source, ...change }), false)
  }
})
test('unsettled generation identity is canonical, ignores draft edits and leaves inputs untouched', () => {
  const { readUnsettledRecord } = recovery()
  const value = record()
  const before = JSON.stringify(value)
  const got = readUnsettledRecord({ record: value })
  assert.equal(got.templateKey, 'template:free')
  assert.equal(
    got.identity,
    JSON.stringify({
      mode: 'free',
      templateId: 1,
      templateVersionId: 2,
      request: {
        operation: 'generate',
        path: '/generations',
        sessionId: 4,
        sourceArtifactId: null,
        templateVersionId: 2,
        costCredits: 3,
        body: value.submission.body,
      },
    })
  )
  assert.equal(
    readUnsettledRecord({ record: { ...value, description: 'changed unsent draft' } }).identity,
    got.identity
  )
  const changed = record()
  changed.submission.body.input.description += 'different request'
  assert.notEqual(readUnsettledRecord({ record: changed }).identity, got.identity)
  assert.equal(JSON.stringify(value), before)
  const effect = { ...record(), mode: 'effect', templateId: 8, recoveryKey: 'unsettled:template:8' }
  assert.equal(readUnsettledRecord({ record: effect }).templateKey, 'template:8')
})
test('unsettled session and regenerate identities retain discriminants and mutual exclusion', () => {
  const { readUnsettledRecord } = recovery()
  const request = { templateId: 1, templateVersionId: 2, clientRequestId: ' session ' }
  const value = {
    ...record(),
    sessionId: null,
    recoveryKey: 'unsettled:template:free',
    submission: null,
    sessionRequest: request,
  }
  const identity = readUnsettledRecord({ record: value }).identity
  assert.equal(
    identity,
    JSON.stringify({ mode: 'free', templateId: 1, templateVersionId: 2, request: { operation: 'session', ...request } })
  )
  const regenerated = { ...record(), submission: regenerate() }
  assert.equal(JSON.parse(readUnsettledRecord({ record: regenerated }).identity).request.operation, 'regenerate')
  for (const invalid of [
    { ...record(), sessionRequest: request },
    { ...record(), submission: null },
    { ...value, sessionId: 4 },
    { ...value, sessionRequest: { ...request, templateId: 9 } },
    { ...value, sessionRequest: { ...request, templateVersionId: 3 } },
    { ...value, sessionRequest: { ...request, extra: true } },
    { ...value, sessionRequest: { ...request, clientRequestId: ' ' } },
    { ...value, sessionRequest: { ...request, clientRequestId: 'x'.repeat(129) } },
    { ...record(), recoveryKey: 'unsettled:session:5' },
    { ...record(), templateVersionId: 3 },
    { ...record(), mode: 'other' },
    { ...record(), photos: new Array(1) },
  ])
    assert.equal(readUnsettledRecord({ record: invalid }), null)
})
test('recovery envelopes keep draft/recovery binding and original record references', () => {
  const { readRecoveryEntry } = recovery()
  const saved = record()
  const recoveryKey = saved.recoveryKey
  const storageKey = 'entry:free'
  for (const draftKey of [
    'template:free',
    'template:free:entry:free:1:2',
    storageKey,
    `${storageKey}:entry:free:1:2`,
    'session:4',
  ]) {
    const value = { protocol: 2, draftKey, record: saved }
    const before = JSON.stringify(value)
    const got = readRecoveryEntry({ value, recoveryKey, storageKey })
    assert.equal(got.record, saved)
    assert.equal(got.draftKey, draftKey)
    assert.equal(JSON.stringify(value), before)
  }
  for (const value of [
    null,
    [],
    { protocol: 2, draftKey: 'session:5', record: saved },
    { protocol: 2, draftKey: 'template:free:entry:free:1:3', record: saved },
    { protocol: 1, draftKey: storageKey, record: saved },
    { protocol: 2, draftKey: storageKey, record: saved, extra: true },
    { protocol: 2, draftKey: storageKey, record: { ...saved, submission: null } },
  ]) {
    assert.equal(readRecoveryEntry({ value, recoveryKey, storageKey }), null)
  }
  assert.equal(
    readRecoveryEntry({
      value: { protocol: 2, draftKey: storageKey, record: saved },
      recoveryKey: 'unsettled:session:5',
      storageKey,
    }),
    null
  )
})
test('remote Task and Draft projections retain binding, whitelist and INVALID_RESPONSE behavior', () => {
  const remote = load(remotePath)
  const input = rawInput()
  const value = task({ input }, { internal: 'hidden' })
  const got = remote.readTask({
    value,
    binding: { sessionId: 4, clientRequestId: value.clientRequestId, templateId: 1, input, generate: true },
  })
  assert.deepEqual(Object.keys(got), [
    'id',
    'sessionId',
    'clientRequestId',
    'roundNo',
    'templateId',
    'sourceTaskId',
    'status',
    'costCredits',
    'errorCode',
    'input',
  ])
  assert.deepEqual(plain(got.input), input)
  assert.notEqual(got.input.inputMediaIds, input.inputMediaIds)
  const draft = remote.readDraft({ value: { input, updatedAt: '2026-11-13T00:00:00Z', hidden: true } })
  assert.deepEqual(Object.keys(draft), ['input', 'updatedAt'])
  for (const binding of [
    { sessionId: 5 },
    { clientRequestId: 'wrong' },
    { templateId: 3 },
    { regenerate: true },
    { input: { ...input, inputMediaIds: [3, 9] } },
  ]) {
    assert.throws(() => remote.readTask({ value, binding }), { message: 'INVALID_RESPONSE' })
  }
})
test('remote decode preserves accepted statuses and outcome-unknown status/requestId on invalid responses', () => {
  const remote = load(remotePath)
  const data = task()
  for (const status of [200, 201]) {
    assert.equal(
      remote.decode({ data, read: remote.readTask, status, requestId: 'trace', acceptedStatuses: [200, 201] }).id,
      data.id
    )
  }
  for (const [status, value] of [
    [202, data],
    [201, {}],
    [200, { ...data, input: null }],
  ]) {
    assert.throws(
      () =>
        remote.decode({
          data: value,
          read: remote.readTask,
          status,
          requestId: 'trace-preserved',
          acceptedStatuses: [200, 201],
        }),
      (error) => {
        assert.equal(error.name, 'ApiResponseError')
        assert.equal(error.code, 'INVALID_RESPONSE')
        assert.equal(error.status, status)
        assert.equal(error.requestId, 'trace-preserved')
        assert.equal(error.isOutcomeUnknown, true)
        return true
      }
    )
  }
})
