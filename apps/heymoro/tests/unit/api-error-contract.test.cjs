const assert = require('node:assert/strict')
const { test } = require('node:test')

const { load } = require('../source.cjs')
const { template, task } = require('../fixtures/creation.cjs')

const response = ({ code = 'DATA_INTEGRITY_CONFLICT', retryable = false, statusCode = 503 } = {}) => ({
  statusCode,
  data: { error: { code, message: 'Controlled service message.', retryable }, requestId: 'owned-request' }
})

test('preserves the controlled HTTP error contract without replacing Error.message compatibility', () => {
  const api = load('src/api.js')
  assert.throws(
    () => api.parseJsonResponse(response()),
    (error) => {
      assert.equal(error.message, 'DATA_INTEGRITY_CONFLICT')
      assert.equal(error.code, 'DATA_INTEGRITY_CONFLICT')
      assert.equal(error.serverMessage, 'Controlled service message.')
      assert.equal(error.status, 503)
      assert.equal(error.requestId, 'owned-request')
      assert.equal(error.retryable, false)
      assert.equal(error.isOutcomeUnknown, false)
      return true
    }
  )
})

for (const entry of [
  { code: 'DATA_INTEGRITY_CONFLICT', retryable: false, statusCode: 503 },
  { code: 'RESOURCE_BUSY', retryable: true, statusCode: 409 }
]) {
  test(`does not infer recovery from HTTP ${entry.statusCode}`, async () => {
    const client = fixture({ request: async () => response(entry) })
    await assert.rejects(client.api.account(), (error) => {
      assert.equal(error.retryable, entry.retryable)
      assert.equal(error.code, entry.code)
      assert.equal(error.requestId, 'owned-request')
      return true
    })
  })
}

for (const entry of [
  { label: 'malformed JSON', value: { statusCode: 201, data: '{' }, code: 'INVALID_RESPONSE' },
  {
    label: 'non-contract response',
    value: { statusCode: 502, data: '<html>proxy</html>' },
    code: 'INVALID_RESPONSE'
  },
  {
    label: 'missing recovery flag',
    value: { statusCode: 503, data: { error: { code: 'SERVER_ERROR' } } },
    code: 'SERVER_ERROR'
  },
  {
    label: 'non-boolean recovery flag',
    value: response({ retryable: 'false' }),
    code: 'DATA_INTEGRITY_CONFLICT'
  },
  {
    label: 'JSON-valid success without a data envelope',
    value: { statusCode: 201, data: {} },
    code: 'INVALID_RESPONSE'
  },
  { label: 'JSON-null success', value: { statusCode: 201, data: 'null' }, code: 'INVALID_RESPONSE' }
]) {
  test(`treats ${entry.label} as unconfirmed, not a business rejection`, async () => {
    const client = fixture({ request: async () => entry.value })
    await assert.rejects(client.api.account(), (error) => {
      assert.equal(error.code, entry.code)
      assert.equal(error.isOutcomeUnknown, true)
      assert.equal(error.retryable, false)
      return true
    })
  })
}

test('sanitizes a native transport failure without an automatic retry', async () => {
  let calls = 0
  const client = fixture({
    request: async () => {
      calls++
      throw Object.assign(Error('https://private.example.test/?token=secret'), {
        errMsg: 'private-host',
        cause: 'secret'
      })
    }
  })
  await assert.rejects(client.api.account(), (error) => {
    assert.equal(error.code, 'REQUEST_OUTCOME_UNKNOWN')
    assert.equal(error.isOutcomeUnknown, true)
    assert.equal(error.retryable, false)
    assert.equal(error.status, null)
    assert.equal(error.requestId, null)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(JSON.stringify(error), /secret|private-host|private\.example/)
    return true
  })
  assert.equal(calls, 1)
})

test('retains a frozen submission for OPERATION_OUTCOME_UNKNOWN even with retryable false', async () => {
  const sent = []
  const client = fixture({
    request: async (options) => {
      sent.push(JSON.parse(JSON.stringify(options.data)))
      return sent.length === 1
        ? response({ code: 'OPERATION_OUTCOME_UNKNOWN', retryable: false })
        : {
          statusCode: 201,
          data: { data: task(options.data, { id: 7, sessionId: 1 }), requestId: 'confirmed-request' }
        }
    }
  })
  const workflow = makeWorkflow({ api: client.api })
  workflow.setDescription('original description')
  await workflow.prepareQuote()
  await workflow.generate()
  const pending = workflow.getSnapshot().submission
  assert.ok(pending)
  assert.equal(sent.length, 1, 'unknown result must not start an automatic retry')
  workflow.setDescription('a later draft')
  await workflow.prepareQuote()
  await workflow.generate()
  assert.deepEqual(sent[1], sent[0])
  assert.equal(sent[1].clientRequestId, pending.body.clientRequestId)
  assert.equal(sent[1].input.description, 'original description')
  assert.equal(workflow.getSnapshot().description, 'a later draft')
  assert.equal(workflow.getSnapshot().submission, null)
})

test('clears a confirmed rejection without clearing the draft', async () => {
  const client = fixture({ request: async () => response({ code: 'CREDITS_INSUFFICIENT', statusCode: 402 }) })
  const workflow = makeWorkflow({ api: client.api })
  workflow.setDescription('preserved draft')
  await workflow.prepareQuote()
  await workflow.generate()
  assert.equal(workflow.getSnapshot().submission, null)
  assert.equal(workflow.getSnapshot().description, 'preserved draft')
})

for (const task of [
  null,
  {},
  { id: 0, status: 'queued' },
  { id: 7, status: 'invented' },
  { id: 7, status: 'queued', sessionId: 9, clientRequestId: 'another-request' }
]) {
  test(`retains the frozen request when a success response has invalid task identity: ${JSON.stringify(
    task
  )}`, async () => {
    let calls = 0
    const client = fixture({
      request: async () => {
        calls++
        return { statusCode: 201, data: { data: task, requestId: 'invalid-task-request' } }
      }
    })
    const workflow = makeWorkflow({ api: client.api })
    workflow.setDescription('preserved draft')
    await workflow.prepareQuote()
    await workflow.generate()
    assert.ok(workflow.getSnapshot().submission)
    assert.equal(workflow.getSnapshot().rounds.length, 0)
    assert.equal(workflow.getSnapshot().description, 'preserved draft')
    assert.equal(calls, 1)
  })
}

for (const value of [{ statusCode: 204, data: null }, { statusCode: 204 }, null, undefined]) {
  test(`keeps pending for an empty native response: ${JSON.stringify(value)}`, async () => {
    const sent = []
    const client = fixture({
      request: async ({ data }) => {
        sent.push(JSON.parse(JSON.stringify(data)))
        return value
      }
    })
    const workflow = makeWorkflow({ api: client.api })
    workflow.setDescription('preserved draft')
    await workflow.prepareQuote()
    await workflow.generate()
    assert.ok(workflow.getSnapshot().submission)
    assert.equal(workflow.getSnapshot().rounds.length, 0)
    assert.equal(sent.length, 1)
    workflow.setDescription('a different draft')
    await workflow.prepareQuote()
    await workflow.generate()
    assert.deepEqual(sent[1], sent[0])
    assert.equal(workflow.getSnapshot().submission.body.clientRequestId, sent[0].clientRequestId)
  })
}

test('rejects a late old-account response before parsing or clearing a new token', async () => {
  let finish
  const client = fixture({
    request: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  })
  const result = client.api.account()
  client.changeToken({ value: 'new-account-token' })
  finish({ statusCode: 401, data: response().data })
  await assert.rejects(result, /AUTH_REQUIRED/)
  assert.equal(client.readToken(), 'new-account-token')
})

function fixture({ request }) {
  let token = 'owned-account-token'
  const api = load('src/creation-api.js', {
    '@tarojs/taro': { request },
    './auth': {
      clearToken: () => {
        token = ''
      },
      getStoredToken: () => token,
      getStoredSession: () => token ? { userId: 1, token, expiresAt: '2099-01-01T00:00:00.000Z' } : null
    }
  }).creationApi
  return {
    api,
    changeToken: ({ value }) => {
      token = value
    },
    readToken: () => token
  }
}

function makeWorkflow({ api }) {
  const { createWorkflow } = load('src/creation-workflow.js')
  let sequence = 0
  const saved = new Map([['session:1', { protocol: 2, mode: 'free', templateId: 1, templateVersionId: 2,
    sessionId: 1, description: '', userNotes: '', photos: [], sessionRequest: null, submission: null,
    draftPaused: false, recoveryKey: 'unsettled:session:1' }]])
  return createWorkflow({
    api: {
      ...api,
      quote: async () => ({
        costCredits: 3,
        templateId: 1,
        quoteToken: 'q',
        validUntil: '2099-01-01T00:00:00Z'
      }),
      putDraft: async () => ({})
    },
    sessionId: 1,
    template: template(),
    files: {},
    key: 'owned-draft',
    makeId: () => `owned-request-${++sequence}`,
    storage: { get: (key) => saved.get(key), set: (key, value) => saved.set(key, value) }
  })
}
