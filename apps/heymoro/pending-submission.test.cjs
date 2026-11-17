const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workflowFixture: fixture, ready } = require('./tests/fixtures/creation.cjs')

const KEY = 'owner:1:free'
const clone = (v) => JSON.parse(JSON.stringify(v))
const unknown = async () => {
  throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
}
const seed = () =>
  new Map([
    [
      'session:4',
      {
        protocol: 2,
        sessionId: 4,
        mode: 'free', templateId: 1, templateVersionId: 2,
        sessionRequest: null, draftPaused: false, recoveryKey: 'unsettled:session:4',
        description: '  原来的描述  ',
        userNotes: '',
        photos: [
          { id: 'second', mediaId: 17, path: '/a.png', status: 'ready', size: 10, mimeType: 'image/png' },
          { id: 'first', mediaId: 4, path: '/b.png', status: 'ready', size: 10, mimeType: 'image/png' }
        ],
        submission: null
      }
    ]
  ])
test('should not submit when primary pending write fails', async () => {
  const { workflow: w, sent, control } = fixture({ saved: seed() })
  await w.restore()
  await w.prepareQuote()
  control.fail = (k, d) => k === 'session:4' && !!d.submission
  await w.generate()
  assert.equal(sent.length, 0)
  assert.equal(w.getSnapshot().submission.body.input.description, '  原来的描述  ')
  assert.deepEqual(clone(w.getSnapshot().submission.body.input.inputMediaIds), [17, 4])
  assert.equal(w.getSnapshot().photos.length, 2)
  assert.equal(w.getSnapshot().submitting, false)
  assert.ok(w.getSnapshot().storageError)
})
test('canonical freeze failure retains envelope and unchanged mirror without HTTP', async () => {
  const { workflow: w, saved, sent, control } = fixture({ sessionId: null })
  await ready(w)
  const mirrorKey = `${KEY}:entry:free:1`
  assert.ok(saved.has(mirrorKey), 'the retained bound mirror must really exist')
  const mirror = clone(saved.get(mirrorKey))
  const canonical = clone(saved.get('session:4'))
  control.fail = (k, d) => k === 'session:4' && !!d?.submission
  await w.generate()
  assert.equal(sent.length, 0)
  assert.deepEqual(saved.get(mirrorKey), mirror)
  assert.deepEqual(saved.get('session:4'), canonical)
  assert.deepEqual(saved.get('unsettled:template:free').record.submission, clone(w.getSnapshot().submission))
  assert.ok(w.getSnapshot().storageError)
})
test('session create identity is durable before HTTP and same identity survives unknown', async () => {
  const calls = []
  const { workflow: w, control } = fixture({
    sessionId: null,
    api: {
      createSession: async (body) => {
        calls.push(clone(body))
        throw Object.assign(Error('NETWORK'), { isOutcomeUnknown: true })
      }
    }
  })
  w.setDescription('original')
  control.fail = (k, d) => !!d.sessionRequest
  await w.prepareQuote()
  assert.equal(calls.length, 0)
  control.fail = () => false
  await w.prepareQuote()
  await w.prepareQuote()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], calls[0])
  assert.deepEqual(Object.keys(calls[0]).sort(), ['clientRequestId', 'templateId'])
})
test('sessionless generation pending is durable before sending', async () => {
  const { workflow: w, sent, control } = fixture({ sessionId: null })
  await ready(w)
  control.fail = (k, d) => k === 'session:4' && !!d.submission
  await w.generate()
  assert.equal(sent.length, 0)
  assert.equal(w.getSnapshot().submission.body.sessionId, 4)
  assert.equal(w.getSnapshot().sessionId, 4)
})
test('ambiguous retry does not send if retry cannot be persisted', async () => {
  const { workflow: w, sent, control } = fixture({ submit: unknown })
  await ready(w)
  await w.generate()
  const pending = clone(w.getSnapshot().submission)
  control.fail = (_, d) => !!d.submission
  await w.generate()
  assert.equal(sent.length, 1)
  assert.deepEqual(clone(w.getSnapshot().submission), pending)
  assert.equal(w.getSnapshot().submitting, false)
})
test('frozen key and ordered raw input survives edits after storage recovers', async () => {
  const { workflow: w, sent, control } = fixture({ saved: seed() })
  await w.restore()
  await w.prepareQuote()
  control.fail = (_, d) => !!d.submission
  await w.generate()
  const pending = clone(w.getSnapshot().submission)
  w.setDescription('新的描述')
  w.removePhoto('second')
  control.fail = () => false
  await w.generate()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], pending.body)
  assert.deepEqual(sent[0].input.inputMediaIds, [17, 4])
  assert.equal(w.getSnapshot().description, '新的描述')
  assert.equal(w.getSnapshot().photos.length, 1)
  assert.equal(w.getSnapshot().storageError, '')
})
for (const gate of ['unavailable template', 'expired quote', 'running task']) {
  test('restart pending replay outranks ' + gate, async () => {
    const saved = seed()
    const first = fixture({ saved, submit: unknown })
    await first.workflow.restore()
    await first.workflow.prepareQuote()
    await first.workflow.generate()
    const pending = clone(first.workflow.getSnapshot().submission)
    first.workflow.dispose()
    const second = fixture({
      saved,
      api: {
        template: async () => {
          if (gate === 'unavailable template') throw Error('TEMPLATE_UNAVAILABLE')
          return first.template
        },
        freePreset: async () => {
          if (gate === 'unavailable template') throw Error('TEMPLATE_UNAVAILABLE')
          return first.template
        },
        getSession: async () => ({
          ...first.session,
          runningTask: gate === 'running task' ? { id: 99, status: 'running', roundNo: 2 } : null,
          draft: { input: { description: '', userNotes: '', inputMediaIds: [] } }
        }),
        quote: async () => ({
          costCredits: 3,
          templateVersionId: 2,
          quoteToken: 'new-quote',
          validUntil: '2000-01-01T00:00:00Z'
        })
      }
    })
    await second.workflow.restore()
    second.workflow.setDescription('new draft')
    second.workflow.removePhoto('second')
    await second.workflow.generate()
    assert.equal(first.sent.length, 1)
    assert.equal(second.sent.length, 1)
    assert.deepEqual(second.sent[0], pending.body)
    assert.equal(second.sent[0].clientRequestId, first.sent[0].clientRequestId)
  })
}
test('failed local save reports false while notifying subscribers and successful save clears error', () => {
  const { workflow: w, control } = fixture()
  let notifications = 0
  w.subscribe(() => notifications++)
  control.fail = () => true
  assert.equal(w.setDescription('保留草稿'), false)
  assert.equal(w.getSnapshot().description, '保留草稿')
  assert.equal(notifications, 1)
  assert.ok(w.getSnapshot().storageError)
  control.fail = () => false
  assert.equal(w.setDescription('已保存'), true)
  assert.equal(w.getSnapshot().storageError, '')
})
test('no-longer-current workflow performs no writes or notifications', () => {
  let current = true
  const { workflow: w, writes } = fixture({ isCurrent: () => current })
  let notifications = 0
  w.subscribe(() => notifications++)
  current = false
  assert.equal(w.setDescription('过期'), false)
  assert.equal(writes.length, 0)
  assert.equal(notifications, 0)
  assert.equal(w.getSnapshot().description, '')
})
for (const invalidation of ['account change', 'disposal']) {
  for (const retry of [false, true]) {
    test(`no ${
      retry ? 'retry' : 'new'
    } send invalidated by ${invalidation} during local storage`, async () => {
      let current = true
      const { workflow: w, sent, control } = fixture({ isCurrent: () => current, submit: unknown })
      await ready(w)
      if (retry) await w.generate()
      const pending = retry ? clone(w.getSnapshot().submission) : null
      control.beforeSet = (_, d) => {
        if (d.submission) {
          if (invalidation === 'disposal') w.dispose()
          else current = false
        }
      }
      await w.generate()
      assert.equal(sent.length, retry ? 1 : 0)
      assert.ok(w.getSnapshot().submission)
      if (retry) assert.deepEqual(clone(w.getSnapshot().submission), pending)
    })
  }
}
for (const invalidation of ['account change', 'disposal']) {
  test('no late session response after ' + invalidation, async () => {
    let current = true
    let finish
    const { workflow: w, sent } = fixture({
      sessionId: null,
      isCurrent: () => current,
      api: {
        createSession: () =>
          new Promise((resolve) => {
            finish = resolve
          })
      }
    })
    w.setDescription('original')
    const preparing = w.prepareQuote()
    await new Promise(setImmediate)
    if (invalidation === 'disposal') w.dispose()
    else current = false
    finish({ id: 4 })
    await preparing
    assert.equal(sent.length, 0)
    assert.equal(w.getSnapshot().sessionId, null)
  })
}
test('legacy local record is preserved and never guessed into a formal submission', async () => {
  const legacy = {
    sessionId: 4,
    prompt: 'old',
    submission: { sessionId: 4, prompt: 'old', clientRequestId: 'old' }
  }
  const saved = new Map([['session:4', clone(legacy)]])
  const { workflow: w, sent } = fixture({ saved })
  await w.restore()
  w.setDescription('new')
  await w.prepareQuote()
  await w.generate()
  assert.equal(sent.length, 0)
  assert.deepEqual(saved.get('session:4'), legacy)
  assert.ok(w.getSnapshot().legacyRecord)
})

test('durable unknown session creation can be confirmed after restart without a current preset', async () => {
  const saved = new Map()
  const first = fixture({ saved, sessionId: null, api: { createSession: unknown } })
  await ready(first.workflow)
  const request = clone(first.workflow.getSnapshot().sessionRequest)
  first.workflow.dispose()
  const calls = []
  const second = fixture({
    saved,
    sessionId: null,
    template: null,
    api: {
      template: async () => {
        throw Error('TEMPLATE_UNAVAILABLE')
      },
      freePreset: async () => {
        throw Error('TEMPLATE_UNAVAILABLE')
      },
      createSession: async (body) => {
        calls.push(clone(body))
        return first.session
      }
    }
  })
  await second.workflow.restore()
  await second.workflow.generate()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], request)
  assert.equal(second.sent.length, 0, 'session confirmation never automatically authorizes generation')
})

test('unknown regeneration replays original Artifact path and two-field body after draft edits', async () => {
  const { workflow: w, sent } = fixture({ submit: unknown })
  await w.restore()
  await w.prepareRegeneration(88)
  await w.generate()
  const pending = clone(w.getSnapshot().submission)
  assert.equal(pending.path, '/artifacts/88/regenerations')
  assert.deepEqual(Object.keys(pending.body).sort(), ['clientRequestId', 'quoteToken'])
  w.setDescription('a different current draft')
  await w.prepareRegeneration(99)
  await w.generate()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], sent[0])
  assert.equal(sent[1].sourceArtifactId, 88)
  assert.equal(w.getSnapshot().description, 'a different current draft')
})

const formalPending = () => ({
  protocol: 2,
  path: '/generations',
  sessionId: 4,
  sourceArtifactId: null,
  templateVersionId: 2,
  costCredits: 3,
  body: {
    sessionId: 4,
    input: { inputMediaIds: [7, 3], description: ' raw ', userNotes: '' },
    clientRequestId: 'original-key',
    quoteToken: 'original-quote'
  }
})
for (const [label, mutate] of [
  [
    'protocol',
    (pending) => {
      pending.protocol = 1
    }
  ],
  [
    'state session',
    (pending) => {
      pending.sessionId = 5
    }
  ],
  [
    'body session',
    (pending) => {
      pending.body.sessionId = 5
    }
  ],
  [
    'zero session',
    (pending) => {
      pending.sessionId = 0
      pending.body.sessionId = 0
    }
  ],
  [
    'version',
    (pending) => {
      pending.templateVersionId = 0
    }
  ],
  [
    'cost',
    (pending) => {
      pending.costCredits = -1
    }
  ],
  [
    'generate source',
    (pending) => {
      pending.sourceArtifactId = 8
    }
  ],
  [
    'generation path',
    (pending) => {
      pending.path = '/artifacts/null/regenerations'
    }
  ],
  [
    'extra body field',
    (pending) => {
      pending.body.operation = 'generate'
    }
  ],
  [
    'missing input',
    (pending) => {
      delete pending.body.input
    }
  ],
  [
    'extra input field',
    (pending) => {
      pending.body.input.prompt = 'legacy'
    }
  ],
  [
    'duplicate image',
    (pending) => {
      pending.body.input.inputMediaIds = [7, 7]
    }
  ],
  [
    'invalid image',
    (pending) => {
      pending.body.input.inputMediaIds = [0]
    }
  ],
  [
    'non-string text',
    (pending) => {
      pending.body.input.description = 5
    }
  ],
  [
    'blank key',
    (pending) => {
      pending.body.clientRequestId = ' '
    }
  ],
  [
    'long key',
    (pending) => {
      pending.body.clientRequestId = 'a'.repeat(129)
    }
  ],
  [
    'long quote',
    (pending) => {
      pending.body.quoteToken = 'q'.repeat(8193)
    }
  ],
  [
    'regen source zero',
    (pending) => {
      pending.sourceArtifactId = 0
      pending.path = '/artifacts/0/regenerations'
      delete pending.body.input
      delete pending.body.sessionId
    }
  ],
  [
    'regen source path mismatch',
    (pending) => {
      pending.sourceArtifactId = 8
      pending.path = '/artifacts/9/regenerations'
      delete pending.body.input
      delete pending.body.sessionId
    }
  ],
  [
    'regen extra session',
    (pending) => {
      pending.sourceArtifactId = 8
      pending.path = '/artifacts/8/regenerations'
      delete pending.body.input
    }
  ]
]) {
  test(`corrupt frozen pending ${label} is retained with zero network sends`, async () => {
    const pending = formalPending()
    mutate(pending)
    const record = {
      protocol: 2,
      mode: 'free',
      sessionId: 4,
      templateId: 1,
      templateVersionId: 2,
      description: 'local',
      userNotes: '',
      photos: [],
      submission: pending
    }
    const saved = new Map([['session:4', clone(record)]])
    const f = fixture({ saved })
    await f.workflow.restore()
    f.workflow.setDescription('later edit')
    await f.workflow.generate()
    assert.equal(f.sent.length, 0)
    assert.deepEqual(clone(f.workflow.getSnapshot().submission), pending)
    assert.deepEqual(saved.get('session:4'), record)
  })
}

test('oversized frozen input is preserved rather than sent beyond the absolute HTTP body budget', async () => {
  const pending = formalPending()
  pending.body.input.description = '猫'.repeat(50000)
  const record = {
    protocol: 2,
    mode: 'free',
    sessionId: 4,
    templateId: 1,
    templateVersionId: 2,
    description: '',
    userNotes: '',
    photos: [],
    submission: pending
  }
  const saved = new Map([['session:4', clone(record)]])
  const f = fixture({ saved })
  await f.workflow.restore()
  await f.workflow.generate()
  assert.equal(f.sent.length, 0)
  assert.deepEqual(saved.get('session:4'), record)
})

for (const operation of ['session', 'generation']) {
  for (const availability of ['offline', 'upgraded']) {
    test(`real free entry discovers frozen ${operation} after restart with ${availability} preset`, async () => {
      const saved = new Map()
      const originalRequests = []
      const first = fixture({
        saved,
        key: 'template:free',
        template: null,
        sessionId: null,
        submit: operation === 'generation' ? unknown : undefined,
        api:
          operation === 'session'
            ? {
              createSession: async (body) => {
                originalRequests.push(clone(body))
                return unknown()
              }
            }
            : {}
      })
      await first.workflow.restore()
      await ready(first.workflow, '  original input  ')
      if (operation === 'generation') await first.workflow.generate()
      const frozen = clone(
        operation === 'session'
          ? first.workflow.getSnapshot().sessionRequest
          : first.workflow.getSnapshot().submission
      )
      first.workflow.dispose()
      const replayed = []
      const second = fixture({
        saved,
        key: 'template:free',
        template: null,
        sessionId: null,
        api: {
          freePreset: async () => {
            if (availability === 'offline') throw Error('TEMPLATE_UNAVAILABLE')
            return { ...first.template, templateVersionId: 3 }
          },
          createSession: async (body) => {
            replayed.push(clone(body))
            return first.session
          }
        }
      })
      await second.workflow.restore()
      assert.equal(second.workflow.getSnapshot().description, '  original input  ')
      await second.workflow.generate()
      if (operation === 'session') {
        assert.deepEqual(replayed, [frozen])
        assert.deepEqual(replayed[0], originalRequests[0])
        assert.equal(second.sent.length, 0)
      } else {
        assert.deepEqual(second.sent, [frozen.body])
        assert.deepEqual(second.sent[0], first.sent[0])
      }
    })
  }
}

for (const operation of ['session', 'generation']) {
  test(`stable unresolved entry write failure prevents ${operation} HTTP`, async () => {
    let sessionCalls = 0
    const f = fixture({
      key: 'template:free',
      template: null,
      sessionId: null,
      api: {
        createSession: async () => {
          sessionCalls++
          return { id: 4, templateId: 1, templateVersionId: 2 }
        }
      }
    })
    await f.workflow.restore()
    if (operation === 'session') {
      f.workflow.setDescription('input')
      f.control.fail = (key, record) => key === 'unsettled:template:free' && !!record?.record?.sessionRequest
      await f.workflow.prepareQuote()
      assert.equal(sessionCalls, 0)
    } else {
      await ready(f.workflow)
      f.control.fail = (key, record) => key === 'unsettled:template:free' && !!record?.record?.submission
      await f.workflow.generate()
      assert.equal(f.sent.length, 0)
    }
    assert.ok(f.workflow.getSnapshot().storageError)
  })
}

const sessionRecoveryRecord = () => ({
  protocol: 2,
  mode: 'free',
  sessionId: null,
  templateId: 1,
  templateVersionId: 2,
  description: 'unresolved input',
  userNotes: '',
  photos: [],
  sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'another-session' },
  submission: null,
  recoveryKey: 'unsettled:template:free'
})
const recoveryEnvelope = (record) => ({ protocol: 2, draftKey: 'template:free:entry:free:1:2', record })
for (const [label, mutate] of [
  [
    'template identity',
    (record) => {
      record.sessionRequest.templateId = 9
    }
  ],
  [
    'version identity',
    (record) => {
      record.sessionRequest.templateVersionId = 3
    }
  ],
  [
    'blank request key',
    (record) => {
      record.sessionRequest.clientRequestId = ' '
    }
  ],
  [
    'extra request property',
    (record) => {
      record.sessionRequest.input = {}
    }
  ],
  [
    'missing template identity',
    (record) => {
      delete record.sessionRequest.templateId
    }
  ],
  [
    'arbitrary origin',
    (record) => {
      record.recoveryKey = 'unsettled:any-other-key'
    }
  ],
  [
    'logical mode',
    (record) => {
      record.mode = 'effect'
    }
  ]
]) {
  test(`damaged stable session recovery ${label} remains untouched and sends zero creates`, async () => {
    const record = sessionRecoveryRecord()
    mutate(record)
    const envelope = recoveryEnvelope(record)
    const saved = new Map([['unsettled:template:free', clone(envelope)]])
    let creates = 0
    const f = fixture({
      saved,
      key: 'template:free',
      template: null,
      sessionId: null,
      api: {
        createSession: async () => {
          creates++
          return f.session
        }
      }
    })
    await f.workflow.restore()
    f.workflow.setDescription('later draft')
    await f.workflow.prepareQuote()
    await f.workflow.generate()
    assert.equal(creates, 0)
    assert.equal(f.sent.length, 0)
    assert.deepEqual(saved.get('unsettled:template:free'), envelope)
  })
}

test('another unresolved journal is not overwritten by a newly frozen generation', async () => {
  const f = fixture({ key: 'template:free', template: null, sessionId: null })
  await f.workflow.restore()
  await ready(f.workflow)
  const another = recoveryEnvelope(sessionRecoveryRecord())
  f.saved.set('unsettled:template:free', clone(another))
  await f.workflow.generate()
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.saved.get('unsettled:template:free'), another)
  assert.ok(f.workflow.getSnapshot().storageError)
})

for (const operation of ['session', 'generation']) {
  test(`journal clear failure keeps original ${operation} discoverable and permits only its original replay`, async () => {
    const requests = []
    const f = fixture({
      key: 'template:free',
      template: null,
      sessionId: null,
      api: {
        createSession: async (body) => {
          requests.push(clone(body))
          return { id: 4, templateId: 1, templateVersionId: 2 }
        }
      }
    })
    await f.workflow.restore()
    if (operation === 'generation') await ready(f.workflow)
    f.control.fail = (key, value) => key === 'unsettled:template:free' && value === null
    if (operation === 'session') await ready(f.workflow)
    else await f.workflow.generate()
    assert.ok(f.saved.get('unsettled:template:free'))
    const journal = clone(f.saved.get('unsettled:template:free'))
    assert.ok(journal)
    const pending =
      operation === 'session' ? f.workflow.getSnapshot().sessionRequest : f.workflow.getSnapshot().submission
    assert.ok(pending)
    f.workflow.setDescription('new edited draft')
    await f.workflow.generate()
    const sent = operation === 'session' ? requests : f.sent
    assert.equal(new Set(sent.map((body) => body.clientRequestId)).size, 1)
    f.control.fail = () => false
    await f.workflow.generate()
    assert.equal(f.saved.get('unsettled:template:free'), null)
    assert.equal(new Set(sent.map((body) => body.clientRequestId)).size, 1)
  })
}

test('journal and bound index containing different unresolved requests are both preserved without sending', async () => {
  const stableRecord = sessionRecoveryRecord()
  const boundRecord = {
    ...sessionRecoveryRecord(),
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'different-bound-request' }
  }
  const envelope = recoveryEnvelope(stableRecord)
  const saved = new Map([
    ['unsettled:template:free', clone(envelope)],
    ['template:free:entry:free:1:2', clone(boundRecord)]
  ])
  let creates = 0
  const f = fixture({
    saved,
    key: 'template:free',
    template: null,
    sessionId: null,
    api: {
      createSession: async () => {
        creates++
        return f.session
      }
    }
  })
  await f.workflow.restore()
  await f.workflow.generate()
  assert.equal(creates, 0)
  assert.deepEqual(saved.get('unsettled:template:free'), envelope)
  assert.deepEqual(saved.get('template:free:entry:free:1:2'), boundRecord)
})

test('normal draft edit does not overwrite the bound record of another unresolved journal', async () => {
  const f = fixture({ key: 'template:free', template: null, sessionId: null })
  await f.workflow.restore()
  const foreign = recoveryEnvelope(sessionRecoveryRecord())
  f.saved.set('unsettled:template:free', clone(foreign))
  f.saved.set(foreign.draftKey, clone(foreign.record))
  f.workflow.setDescription('not the unresolved draft')
  assert.deepEqual(f.saved.get(foreign.draftKey), foreign.record)
  assert.deepEqual(f.saved.get('unsettled:template:free'), foreign)
})

test('history follows only its matching canonical origin and settles both indexes of the original request', async () => {
  const saved = new Map()
  const first = fixture({ saved, key: 'template:free', template: null, sessionId: null, submit: unknown })
  await first.workflow.restore()
  await ready(first.workflow)
  await first.workflow.generate()
  const pending = clone(first.workflow.getSnapshot().submission)
  const boundKey = 'template:free:entry:free:1'
  const frozenRecord = clone(saved.get('unsettled:template:free').record)
  saved.set(boundKey, clone(frozenRecord))
  saved.set('session:4', clone(frozenRecord))
  saved.set('unsettled:template:free', { protocol: 2, draftKey: boundKey, record: clone(frozenRecord) })
  assert.notEqual(boundKey, 'session:4')
  first.workflow.dispose()
  const history = fixture({
    saved,
    key: 'session:4',
    template: null,
    sessionId: 4,
    api: {
      freePreset: async () => {
        throw Error('TEMPLATE_UNAVAILABLE')
      }
    }
  })
  await history.workflow.restore()
  await history.workflow.generate()
  assert.deepEqual(history.sent, [pending.body])
  assert.equal(saved.get('unsettled:template:free'), null)
  assert.equal(saved.get('session:4').submission, null)
  assert.equal(saved.get(boundKey).submission, null)
})

for (const [label, slot] of [
  ['null', null],
  ['number', 7],
  ['string', 'photo'],
  ['boolean', true],
  ['array', []],
  ['missing slot identity', { status: 'failed', path: '/old.png' }],
  ['invalid status', { id: 'old', status: 'unknown', path: '/old.png' }],
  ['invalid path type', { id: 'old', status: 'failed', path: {} }],
  ['invalid ready media identity', { id: 'old', status: 'ready', mediaId: '7' }]
]) {
  test(`unsettled photo slot ${label} locks recovery without losing journal or bound record`, async () => {
    const record = { ...sessionRecoveryRecord(), photos: [slot] }
    const envelope = recoveryEnvelope(record)
    const saved = new Map([
      ['unsettled:template:free', clone(envelope)],
      [envelope.draftKey, clone(record)]
    ])
    let creates = 0
    let quotes = 0
    let uploads = 0
    const f = fixture({
      saved,
      key: 'template:free',
      template: null,
      sessionId: null,
      api: {
        createSession: async () => {
          creates++
          return f.session
        },
        quote: async () => {
          quotes++
          return {}
        }
      },
      files: {
        upload: async () => {
          uploads++
          return { id: 7 }
        }
      }
    })
    await assert.doesNotReject(f.workflow.restore())
    assert.equal(f.workflow.getSnapshot().corruptPending, true)
    assert.ok(f.workflow.getSnapshot().error || f.workflow.getSnapshot().storageError)
    f.workflow.setDescription('later edit')
    await f.workflow.prepareQuote()
    await f.workflow.generate()
    await f.workflow.retryPhoto('old')
    assert.equal(creates + quotes + uploads + f.sent.length, 0)
    assert.deepEqual(saved.get('unsettled:template:free'), envelope)
    assert.deepEqual(saved.get(envelope.draftKey), record)
    assert.equal(f.writes.length, 0)
  })
}

for (const status of ['pending', 'failed', 'uploading', 'ready']) {
  test(`unsettled photo slot ${status} remains recoverable without current schema validation`, async () => {
    const photo =
      status === 'ready'
        ? { id: 'registered', status, mediaId: 7, path: '' }
        : { id: 'local', status, path: '/old.png', size: 99999999, mimeType: 'image/old-format' }
    const record = { ...sessionRecoveryRecord(), photos: [photo] }
    const envelope = recoveryEnvelope(record)
    const f = fixture({
      saved: new Map([['unsettled:template:free', envelope]]),
      key: 'template:free',
      template: null,
      sessionId: null
    })
    await assert.doesNotReject(f.workflow.restore())
    assert.equal(f.workflow.getSnapshot().corruptPending, false)
    assert.equal(f.workflow.getSnapshot().photos[0].status, status === 'uploading' ? 'failed' : status)
    if (status === 'ready') {
      assert.equal(f.workflow.getSnapshot().photos[0].mediaId, 7)
      assert.equal(f.workflow.getSnapshot().photos[0].size, undefined)
      assert.equal(f.workflow.getSnapshot().photos[0].mimeType, undefined)
    }
    assert.deepEqual(clone(f.workflow.getSnapshot().sessionRequest), record.sessionRequest)
  })
}

for (const failure of ['read throws', 'damaged', 'conflicting']) {
  test(`explicit session still reads history under ${failure} recovery without writes`, async () => {
    const record = {
      protocol: 2,
      mode: 'free',
      sessionId: 4,
      templateId: 1,
      templateVersionId: 2,
      description: 'local',
      userNotes: '',
      photos: [],
      sessionRequest: null,
      submission: formalPending(),
      recoveryKey: 'unsettled:session:4'
    }
    const envelope = { protocol: 2, draftKey: 'session:4', record }
    const saved = new Map([
      ['unsettled:session:4', clone(envelope)],
      ['session:4', clone(record)]
    ])
    if (failure === 'damaged') saved.get('unsettled:session:4').record.photos = [null]
    if (failure === 'conflicting') {
      saved.get('session:4').submission.body.clientRequestId = 'different-request'
    }
    const before = clone([...saved])
    let details = 0
    let histories = 0
    let artifacts = 0
    let creates = 0
    let quotes = 0
    const f = fixture({
      saved,
      key: 'session:4',
      sessionId: 4,
      template: null,
      api: {
        getSession: async () => {
          details++
          return {
            ...f.session,
            draft: { input: { inputMediaIds: [], description: 'remote', userNotes: '' } }
          }
        },
        tasks: async () => {
          histories++
          return {
            items: [
              require('./tests/fixtures/creation.cjs').task({}, { status: 'succeeded', artifactIds: [88] })
            ],
            nextCursor: null,
            hasMore: false
          }
        },
        artifact: async () => {
          artifacts++
          return { id: 88, mediaId: 90, taskId: 9, sessionId: 4, isFavorite: false }
        },
        createSession: async () => {
          creates++
          return f.session
        },
        quote: async () => {
          quotes++
          return {}
        }
      }
    })
    if (failure === 'read throws') {
      // The storage boundary throws only for journal reads; ordinary historical reads remain available.
      const { createWorkflow } = require('./tests/source.cjs').load('src/creation-workflow.js')
      f.workflow.dispose()
      f.workflow = createWorkflow({
        api: f.api,
        files: {},
        key: 'session:4',
        sessionId: 4,
        makeId: () => 'unused',
        storage: {
          get: (key) => {
            if (key.startsWith('unsettled:')) throw Error('STORAGE_READ_FAILED')
            return saved.get(key)
          },
          set: () => assert.fail('blocked recovery wrote storage')
        }
      })
    }
    await assert.doesNotReject(f.workflow.restore())
    assert.equal(details, 1)
    assert.equal(histories, 1)
    assert.equal(artifacts, 1)
    assert.equal(f.workflow.getSnapshot().rounds[0].status, 'succeeded')
    assert.equal(f.workflow.getSnapshot().artifacts[88].mediaId, 90)
    assert.equal(f.workflow.getSnapshot().corruptPending, true)
    assert.ok(f.workflow.getSnapshot().storageError)
    f.workflow.setDescription('editing read-only history')
    await f.workflow.prepareQuote()
    await f.workflow.generate()
    assert.equal(creates + quotes + f.sent.length, 0)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(clone([...saved]), before)
  })
}

test('bare unresolved record with a malformed photo also locks before local snapshot adoption', async () => {
  const record = { ...sessionRecoveryRecord(), photos: [null] }
  const boundKey = 'template:free:entry:free:1:2'
  const saved = new Map([[boundKey, clone(record)]])
  let creates = 0
  const f = fixture({
    saved,
    key: 'template:free',
    template: null,
    sessionId: null,
    api: {
      createSession: async () => {
        creates++
        return f.session
      }
    }
  })
  await assert.doesNotReject(f.workflow.restore())
  assert.equal(f.workflow.getSnapshot().corruptPending, true)
  f.workflow.setDescription('later edit')
  await f.workflow.prepareQuote()
  await f.workflow.generate()
  assert.equal(creates + f.sent.length, 0)
  assert.equal(f.writes.length, 0)
  assert.deepEqual(saved.get(boundKey), record)
})
