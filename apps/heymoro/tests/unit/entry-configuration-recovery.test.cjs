const { test: nodeTest } = require('node:test')
const test = (name, run) => nodeTest(name, { timeout: 3000 }, run)
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { workflowFixture, template } = require('../fixtures/creation.cjs')
const { withPages } = require('../fixtures/creation-pages.cjs')
const offline = () => Object.assign(Error('REQUEST_OUTCOME_UNKNOWN'), {
  code: 'REQUEST_OUTCOME_UNKNOWN', status: null, isOutcomeUnknown: true
})
const gate = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const key = 'owner:1:free'
const boundKey = `${key}:entry:free:1`
const local = (extra = {}) => ({
  protocol: 2, mode: null, sessionId: null, templateId: null, templateVersionId: null,
  description: '断线时的文字', userNotes: '', photos: [], carryBackSourceTaskId: null,
  sessionRequest: null, submission: null, draftPaused: false,
  recoveryKey: 'unsettled:template:free', ...extra
})
const bytes = (saved) => JSON.stringify([...saved])
function direct({ mode = 'free', saved = new Map(), api = {}, version = null, requestedVersion = null, isCurrent } = {}) {
  const f = workflowFixture({ template: null, sessionId: null, saved })
  f.workflow.dispose()
  const config = template(mode)
  const ports = { ...f.api, freePreset: async () => config, template: async () => config, ...api }
  const storage = {
    listKeys: ({ prefix }) => [...saved.keys()].filter((key) => key.startsWith(prefix)),
    get: (k) => saved.get(k),
    set: (k, v) => { f.writes.push({ key: k, draft: v }); if (f.control.fail(k, v)) throw Error('FULL'); saved.set(k, v) }
  }
  const workflow = load('src/creation-workflow.js').createWorkflow({
    api: ports, files: { exists: async () => true, preview: async () => '' }, storage, key,
    templateId: mode === 'effect' ? 1 : null, templateVersionId: requestedVersion, isCurrent, makeId: () => 'request-new'
  })
  return { ...f, workflow, api: ports, config }
}
for (const mode of ['free', 'effect']) {
  test(`${mode} manual recovery reads account and correct config once without writes`, async () => {
    const calls = []
    let down = true
    const f = direct({ mode, api: {
      account: async () => { calls.push('account'); return { configured: true } },
      [mode === 'free' ? 'freePreset' : 'template']: async (args) => {
        calls.push(['config', args]); if (down) throw offline(); return f.config
      }
    } })
    await f.workflow.restore()
    mode === 'free' ? f.workflow.setDescription('current') : f.workflow.setUserNotes('current notes')
    await Promise.resolve()
    const before = bytes(f.saved), count = f.writes.length
    calls.length = 0
    down = false
    assert.equal((await f.workflow.refresh()).status, 'ok')
    assert.equal(calls[0], 'account')
    assert.equal(calls.length, 2)
    if (mode === 'effect') assert.equal(calls[1][1].templateId, 1)
    const state = f.workflow.getSnapshot()
    assert.equal(state.template.mode, mode)
    assert.equal(state[mode === 'free' ? 'description' : 'userNotes'], mode === 'free' ? 'current' : 'current notes')
    assert.equal(bytes(f.saved), before)
    assert.equal(f.writes.length, count)
    assert.equal(state.sessionId, null)
    assert.equal(state.controls.canGenerate, false)
    if (mode === 'free') assert.equal(state.errorAction, 'quote')
    f.workflow.dispose()
  })
}
test('actual page retry retains explicit quote CTA, then cost, then separate generation click', async () => {
  let down = true
  const calls = []
  await withPages(async (h) => {
    await h.act(async () => h.render('create'))
    const w = h.controllers[0]
    await h.act(async () => h.handlers.get('composer__input').onInput({ detail: { value: '页面文字' } }))
    down = false
    calls.length = 0
    await h.act(async () => h.click('create', '刷新'))
    assert.deepEqual(calls, ['account', 'config'])
    assert.equal(w.getSnapshot().description, '页面文字')
    assert.equal(w.getSnapshot().errorAction, 'quote')
    assert.equal(w.getSnapshot().controls.canGenerate, false)
    assert.equal(h.businessWrites.length, 0)
    await h.act(async () => h.click('create', '保存本机输入'))
    assert.equal(h.businessWrites.length, 0)
    await h.act(async () => h.click('create', '重试报价'))
    assert.equal(w.getSnapshot().controls.costCredits, 3)
    assert.equal(w.getSnapshot().controls.canGenerate, true)
    assert.equal(h.businessWrites.some(([name]) => name === 'generate'), false)
    await h.act(async () => h.click('create', '生成3 积分'))
    assert.equal(h.businessWrites.filter(([name]) => name === 'generate').length, 1)
  }, { route: {}, createApi: ({ ports }) => ({ creationApi: {
    ...ports,
    account: async () => { calls.push('account'); return { available: 20, configured: true } },
    freePreset: async () => { calls.push('config'); if (down) throw offline(); return template() }
  } }) })
})
for (const down of [true, false]) {
  test(`eligible unbound restore preserves text and raw bytes, config down=${down}, no schedule POST`, async () => {
    const saved = new Map([[key, local()]])
    const before = bytes(saved)
    const f = direct({ saved, api: { freePreset: async () => { if (down) throw offline(); return template() } } })
    await f.workflow.restore()
    await Promise.resolve()
    assert.equal(f.workflow.getSnapshot().description, '断线时的文字')
    assert.equal(bytes(saved), before)
    assert.equal(f.writes.length, 0)
    assert.equal(f.workflow.getSnapshot().sessionId, null)
    if (!down) assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
    f.workflow.dispose()
  })
}
test('mode-null old draft selects its current effect while preserving input', async () => {
  const saved = new Map([[key, local({ description: '', userNotes: '效果文字', templateId: 1,
    templateVersionId: 7, recoveryKey: 'unsettled:template:1' })]])
  const calls = []
  const f = direct({ mode: 'effect', saved, version: 7, api: {
    template: async (args) => { calls.push(args); return f.config }
  } })
  const before = bytes(saved)
  await f.workflow.restore()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ templateId: 1 }])
  assert.equal(Object.hasOwn(f.workflow.getSnapshot(), 'templateVersionId'), false)
  assert.equal(f.workflow.getSnapshot().userNotes, '效果文字')
  assert.equal(bytes(saved), before)
  f.workflow.dispose()
})
for (const extra of [
  { unexpected: 'keep' }, { photos: [{ mediaId: 8, status: 'ready' }] },
  { mode: 'effect', description: '', userNotes: 'foreign', templateId: 99 },
  { mode: 'unknown' }, { sourceArtifactId: 66 }
]) {
  test(`rejected generic record stays protected before config and occupied target: ${JSON.stringify(extra)}`, async () => {
    let down = true
    const saved = new Map([[key, local(extra)], [boundKey, local({ description: 'occupied' })]])
    const before = bytes(saved)
    const f = direct({ saved, api: { freePreset: async () => { if (down) throw offline(); return template() } } })
    await f.workflow.restore()
    f.workflow.setDescription('visible unsaved')
    assert.equal(bytes(saved), before)
    assert.ok(f.workflow.getSnapshot().storageError)
    down = false
    await f.workflow.refresh()
    assert.equal(f.workflow.getSnapshot().description, 'visible unsaved')
    assert.ok(f.workflow.getSnapshot().storageError)
    await f.workflow.prepareQuote()
    assert.equal(f.workflow.getSnapshot().sessionId, null)
    assert.equal(bytes(saved), before)
    f.workflow.dispose()
  })
}
test('rejected generic record releases only to empty distinct bound key, read itself never saves', async () => {
  let down = true
  const original = local({ unknown: true })
  const saved = new Map([[key, original]])
  const f = direct({ saved, api: { freePreset: async () => { if (down) throw offline(); return template() } } })
  await f.workflow.restore()
  f.workflow.setDescription('new text')
  assert.equal(saved.get(key), original)
  down = false
  await f.workflow.refresh()
  assert.equal(saved.has(boundKey), false)
  assert.equal(f.workflow.getSnapshot().storageError, '')
  f.api.createSession = async () => { throw offline() }
  f.workflow.setDescription('later edit')
  assert.equal(saved.get(key), original)
  assert.equal(saved.get(boundKey).description, 'later edit')
  f.workflow.dispose()
})
for (const phase of ['initial', 'manual']) {
  test(`${phase} in-flight edit wins even when synchronous save fails`, async () => {
    const entered = gate(), wait = gate()
    let shouldWait = phase === 'initial', down = phase === 'manual'
    const saved = new Map([[key, local()]])
    const f = direct({ saved, api: { freePreset: async () => {
      if (down) throw offline()
      if (shouldWait) { entered.resolve(); await wait.promise }
      return template()
    } } })
    let flight
    if (phase === 'initial') flight = f.workflow.restore()
    else { await f.workflow.restore(); down = false; shouldWait = true; flight = f.workflow.refresh() }
    await entered.promise
    f.control.fail = () => true
    f.workflow.setDescription('newest edit')
    wait.resolve()
    await flight
    assert.equal(f.workflow.getSnapshot().description, 'newest edit')
    assert.ok(f.workflow.getSnapshot().storageError)
    assert.equal(f.workflow.getSnapshot().errorAction, null)
    assert.equal(f.workflow.getSnapshot().sessionId, null)
    f.workflow.dispose()
  })
}
for (const error of [offline(), Object.assign(Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' })]) {
  test(`any account failure blocks sessionless config: ${error.message}`, async () => {
    let reads = 0
    const f = direct({ api: { freePreset: async () => { reads++; throw offline() } } })
    await f.workflow.restore()
    f.api.account = async () => { throw error }
    await f.workflow.refresh()
    assert.equal(reads, 1)
    f.workflow.dispose()
  })
}
for (const action of ['hide', 'hide-show', 'dispose', 'account']) {
  test(`config await cancels ${action} without stale adoption or IO`, async () => {
    const wait = gate(), entered = gate()
    let down = true, reads = 0, current = true
    const f = direct({ isCurrent: () => current, api: { freePreset: async () => {
      reads++; if (down) throw offline(); entered.resolve(); await wait.promise; return template()
    } } })
    await f.workflow.restore()
    down = false
    const flight = f.workflow.refresh()
    await entered.promise
    if (action === 'dispose') f.workflow.dispose()
    else if (action === 'account') { current = false }
    else { f.workflow.setPageVisible({ visible: false }); if (action === 'hide-show') f.workflow.setPageVisible({ visible: true }) }
    wait.resolve()
    assert.equal((await flight).status, 'cancelled')
    assert.equal(f.workflow.getSnapshot().template, null)
    assert.equal(reads, 2)
    assert.equal(f.writes.length, 0)
    assert.equal(current, action !== 'account')
    f.workflow.dispose()
  })
}
test('closed pure classifier rejects wrong fields/pending/unknown while retaining known bound rules', () => {
  const { classifyEntryDraft } = load('src/features/creation/entry-draft.js')
  const classify = (record, mode = 'free') => classifyEntryDraft({ record, mode,
    templateId: mode === 'effect' ? 1 : null, templateVersionId: null,
    recoveryKey: mode === 'effect' ? 'unsettled:template:1' : 'unsettled:template:free' }).kind
  assert.equal(classify(local()), 'eligible')
  assert.equal(classify(local({ description: '', userNotes: 'notes', templateId: 1,
    recoveryKey: 'unsettled:template:1' }), 'effect'), 'eligible')
  assert.notEqual(classify(local(), 'effect'), 'eligible')
  for (const extra of [{ submission: {} }, { sessionRequest: {} }, { sessionId: 4 },
    { protocol: 1 }, { x: true }, { photos: [8] }, { mode: 'bad' }, { templateVersionId: -1 },
    { carryBackSourceTaskId: 9 }, { description: 8 }, { draftPaused: true }]) {
    assert.notEqual(classify(local(extra)), 'eligible')
  }
  assert.equal(classify(local({ mode: 'free', templateId: 1, templateVersionId: 2 })), 'bound')
})
for (const phase of ['initial', 'manual']) {
  test(`${phase} legacy metadata never adds a second config request or starts writes`, async () => {
    const saved = new Map([[key, local({ templateVersionId: 7 })]])
    let count = 0
    const f = direct({ saved, api: { freePreset: async () => { count++; return template() } } })
    const before = bytes(saved)
    await f.workflow.restore()
    assert.equal(count, 1)
    if (phase === 'manual') { await f.workflow.refresh(); assert.equal(count, 1) }
    assert.equal(f.workflow.getSnapshot().template.templateId, 1)
    assert.equal(Object.hasOwn(f.workflow.getSnapshot(), 'templateVersionId'), false)
    assert.equal(f.workflow.getSnapshot().description, '断线时的文字')
    assert.equal(bytes(saved), before)
    assert.equal(f.writes.length, 0)
    f.workflow.dispose()
  })
}
test('bound old draft uses current configuration after manual recovery', async () => {
  let down = true
  const saved = new Map([[key, local({ mode: 'free', templateId: 1, templateVersionId: 7 })]])
  const f = direct({ saved, api: { freePreset: async () => { if (down) throw offline(); return template() } } })
  await f.workflow.restore()
  down = false
  await f.workflow.refresh()
  assert.equal(f.workflow.getSnapshot().template.templateId, 1)
  assert.equal(Object.hasOwn(f.workflow.getSnapshot(), 'templateVersionId'), false)
  f.workflow.dispose()
})
test('successful in-flight initial edit skips restore auto quote tail too', async () => {
  const wait = gate(), entered = gate()
  const f = direct({ api: { freePreset: async () => { entered.resolve(); await wait.promise; return template() } } })
  const flight = f.workflow.restore()
  await entered.promise
  f.workflow.setDescription('new input during GET')
  await Promise.resolve()
  wait.resolve()
  await flight
  await Promise.resolve()
  assert.equal(f.workflow.getSnapshot().description, 'new input during GET')
  assert.equal(f.workflow.getSnapshot().sessionId, null)
  assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
  f.workflow.dispose()
})
test('effect rejects free description without converting to notes and preserves original bytes', async () => {
  const raw = local({ recoveryKey: 'unsettled:template:1' })
  const saved = new Map([[key, raw]])
  const f = direct({ mode: 'effect', saved, api: { template: async () => { throw offline() } } })
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().description, '')
  assert.equal(f.workflow.getSnapshot().userNotes, '')
  assert.ok(f.workflow.getSnapshot().storageError)
  f.workflow.setUserNotes('new notes')
  assert.equal(saved.get(key), raw)
  f.workflow.dispose()
})
test('foreign before first restore and setter is preserved with zero storage attempts', async () => {
  const raw = local({ unknown: true })
  const saved = new Map([[key, raw]])
  const f = direct({ saved })
  let attempts = 0
  f.control.fail = () => { attempts++; return true }
  f.workflow.setDescription('visible unsaved input')
  assert.equal(attempts, 0)
  assert.equal(saved.get(key), raw)
  assert.equal(f.writes.length, 0)
  f.workflow.dispose()
})
test('configuration read does not clear an owned pending-journal save failure', async () => {
  const wait = gate(), entered = gate()
  const f = direct({ api: { freePreset: async () => { entered.resolve(); await wait.promise; return template() } } })
  f.control.fail = (key) => key.startsWith('initial-input:')
  f.workflow.setDescription('new unsaved input')
  const flight = f.workflow.restore()
  await entered.promise
  const error = f.workflow.getSnapshot().storageError
  assert.ok(error)
  wait.resolve()
  await flight
  assert.equal(f.workflow.getSnapshot().storageError, error)
  assert.equal(f.workflow.getSnapshot().description, 'new unsaved input')
  assert.equal(f.workflow.getSnapshot().errorAction, null)
  f.workflow.dispose()
})
test('manual/show config GET shares flight and ignores automatic poll for an idle entry', async () => {
  const wait = gate(), entered = gate()
  let down = true, calls = 0
  const f = direct({ api: { freePreset: async () => {
    calls++; if (down) throw offline(); entered.resolve(); await wait.promise; return template()
  } } })
  await f.workflow.restore()
  await f.workflow.refresh({ reason: 'poll' })
  assert.equal(calls, 1)
  down = false
  const a = f.workflow.refresh(), b = f.workflow.refresh({ reason: 'show' })
  assert.equal(a, b)
  await entered.promise
  wait.resolve()
  await a
  assert.equal(calls, 2)
  assert.equal(f.workflow.shouldPoll(), false)
  f.workflow.dispose()
})
test('other-lane feedback and independent storage failure suppress quote CTA ownership', async () => {
  const wait = gate(), entered = gate()
  let down = true
  const f = direct({ api: { freePreset: async () => {
    if (down) throw offline(); entered.resolve(); await wait.promise; return template()
  } } })
  await f.workflow.restore()
  f.workflow.setDescription('valid input')
  down = false
  const flight = f.workflow.refresh()
  await entered.promise
  f.api.artifact = async () => { throw Error('ARTIFACT_NOT_FOUND') }
  await f.workflow.prepareRegeneration(66)
  const before = f.workflow.getSnapshot()
  wait.resolve()
  await flight
  assert.equal(f.workflow.getSnapshot().error, before.error)
  assert.equal(f.workflow.getSnapshot().errorAction, before.errorAction)
  f.workflow.dispose()
})
test('initial rejected generic key is protected before the config await permits a successful edit', async () => {
  const wait = gate(), entered = gate()
  const original = local({ unknown: true })
  const saved = new Map([[key, original]])
  const f = direct({ saved, api: { freePreset: async () => { entered.resolve(); await wait.promise; return template() } } })
  const flight = f.workflow.restore()
  await entered.promise
  f.workflow.setDescription('edit while GET pending')
  assert.equal(saved.get(key), original)
  wait.resolve()
  await flight
  assert.equal(saved.get(key), original)
  assert.equal(f.workflow.getSnapshot().description, 'edit while GET pending')
  assert.equal(f.workflow.getSnapshot().sessionId, null)
  f.workflow.dispose()
})
for (const record of [
  local({ mode: 'free', templateId: 1, templateVersionId: 2,
    sessionRequest: { templateId: 1, templateVersionId: 2, clientRequestId: 'original-session' } }),
  local({ sessionRequest: { damaged: true } }),
  { protocol: 1, description: 'legacy bytes' }
]) {
  test(`refresh never reads new config or changes recovery bytes for protocol ${record.protocol}, request ${JSON.stringify(record.sessionRequest)}`, async () => {
    let reads = 0
    const saved = new Map([[key, record]])
    if (record.protocol === 2 && record.mode === 'free') {
      saved.set('unsettled:template:free', { protocol: 2, draftKey: key, record })
    }
    const f = direct({ saved, api: { freePreset: async () => { reads++; throw offline() } } })
    await f.workflow.restore()
    const count = reads, before = bytes(saved), state = f.workflow.getSnapshot()
    await f.workflow.refresh()
    assert.equal(reads, count)
    assert.equal(bytes(saved), before)
    assert.equal(JSON.stringify(f.workflow.getSnapshot().sessionRequest), JSON.stringify(state.sessionRequest))
    assert.equal(JSON.stringify(f.workflow.getSnapshot().submission), JSON.stringify(state.submission))
    assert.equal(f.writes.length, 0)
    f.workflow.dispose()
  })
}
for (const mode of ['free', 'effect']) {
  test(`${mode} offline reopen adopts only its field, then config recovery preserves prior raw record`, async () => {
    let down = true
    const raw = local(mode === 'effect' ? {
      description: '', userNotes: 'effect offline notes', templateId: 1, templateVersionId: 7,
      recoveryKey: 'unsettled:template:1'
    } : { templateVersionId: 7 })
    const saved = new Map([[key, raw]])
    const f = direct({ mode, version: 7, saved, api: {
      [mode === 'free' ? 'freePreset' : 'template']: async () => { if (down) throw offline(); return f.config }
    } })
    const before = bytes(saved)
    await f.workflow.restore()
    assert.equal(f.workflow.getSnapshot().description, raw.description)
    assert.equal(f.workflow.getSnapshot().userNotes, raw.userNotes)
    down = false
    await f.workflow.refresh()
    assert.equal(Object.hasOwn(f.workflow.getSnapshot(), 'templateVersionId'), false)
    assert.equal(f.workflow.getSnapshot().description, raw.description)
    assert.equal(f.workflow.getSnapshot().userNotes, raw.userNotes)
    assert.equal(bytes(saved), before)
    assert.equal(f.writes.length, 0)
    f.workflow.dispose()
  })
}
test('initial in-flight edit persists the validated unbound requested pin rather than losing it', async () => {
  const wait = gate(), entered = gate()
  const saved = new Map([[key, local({ templateVersionId: 7 })]])
  const f = direct({ version: 7, saved, api: { freePreset: async () => {
    entered.resolve(); await wait.promise; return f.config
  } } })
  const flight = f.workflow.restore()
  await entered.promise
  f.workflow.setDescription('pin remains with edited text')
  assert.equal(saved.get(key).templateVersionId, 7)
  wait.resolve()
  await flight
  assert.equal(f.workflow.getSnapshot().description, 'pin remains with edited text')
  assert.equal(f.workflow.getSnapshot().sessionId, null)
  f.workflow.dispose()
})
test('offline free entry rejects mode-null foreign ID rather than treating it as a trusted free pin', async () => {
  const raw = local({ templateId: 12, templateVersionId: 7 })
  const saved = new Map([[key, raw]])
  const f = direct({ saved, api: { freePreset: async () => { throw offline() } } })
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().description, '')
  assert.ok(f.workflow.getSnapshot().storageError)
  f.workflow.setDescription('new local text')
  assert.equal(saved.get(key), raw)
  f.workflow.dispose()
})
test('effect in-flight notes preserve old evidence while reopened GET uses stable identity', async () => {
  const wait = gate(), entered = gate(), calls = []
  const saved = new Map([[key, local({
    description: '', userNotes: 'old notes', templateId: 1, templateVersionId: 7,
    recoveryKey: 'unsettled:template:1'
  })]])
  const f = direct({ mode: 'effect', version: 7, saved, api: { template: async (args) => {
    calls.push(args); entered.resolve(); await wait.promise; return f.config
  } } })
  const flight = f.workflow.restore()
  await entered.promise
  f.workflow.setUserNotes('notes edited during GET')
  assert.equal(saved.get(key).templateVersionId, 7)
  assert.equal(saved.get(key).mode, null)
  wait.resolve()
  await flight
  f.workflow.dispose()
  const reopened = direct({ mode: 'effect', version: 7, saved, api: { template: async (args) => {
    calls.push(args); return reopened.config
  } } })
  await reopened.workflow.restore()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { templateId: 1 }, { templateId: 1 }
  ])
  assert.equal(reopened.workflow.getSnapshot().userNotes, 'notes edited during GET')
  assert.equal(reopened.workflow.getSnapshot().sessionId, null)
  reopened.workflow.dispose()
})
test('initial matching config may validate a previously unknown local ID but releases only to empty distinct key', async () => {
  const saved = new Map([[key, local({ templateId: 1 })]])
  const original = bytes(saved)
  const f = direct({ saved })
  await f.workflow.restore()
  assert.equal(f.workflow.getSnapshot().description, '断线时的文字')
  assert.equal(f.workflow.getSnapshot().storageError, '')
  assert.equal(f.workflow.getSnapshot().errorAction, 'quote')
  assert.equal(bytes(saved), original)
  f.workflow.dispose()
})
for (const downInitially of [true, false]) {
  test(`rejected input still has honest preservation notice after safe guard release, offline first=${downInitially}`, async () => {
    let down = downInitially
    const saved = new Map([[key, local({ unknown: 'retain' })]])
    const f = direct({ saved, api: { freePreset: async () => { if (down) throw offline(); return template() } } })
    await f.workflow.restore()
    if (down) { down = false; await f.workflow.refresh() }
    assert.equal(f.workflow.getSnapshot().storageError, '')
    assert.match(f.workflow.getSnapshot().error, /旧.*保留/)
    assert.equal(f.workflow.getSnapshot().errorAction, null)
    f.workflow.dispose()
  })
}
for (const scenario of [
  { name: 'foreign mode and ID', mode: 'free', raw: { mode: 'effect', templateId: 99,
    templateVersionId: 7, description: '', userNotes: 'foreign notes', recoveryKey: 'unsettled:template:99' } },
  { name: 'foreign effect ID', mode: 'effect', raw: { mode: 'effect', templateId: 99,
    templateVersionId: 7, description: '', userNotes: 'foreign notes', recoveryKey: 'unsettled:template:99' } },
  { name: 'foreign effect identity despite legacy requested version', mode: 'effect', requestedVersion: 2,
    raw: { mode: 'effect', templateId: 2, templateVersionId: 7, description: '',
      userNotes: 'other version notes', recoveryKey: 'unsettled:template:1' } },
  { name: 'fully-bound unknown fields', mode: 'free', raw: { mode: 'free', templateId: 1,
    templateVersionId: 2, unknownSerializerField: 'retain' } }
]) {
  for (const occupied of [false, true]) {
    test(`initial fully-bound ${scenario.name} is protected before GET and occupied=${occupied}`, async () => {
      const wait = gate(), entered = gate()
      const raw = local(scenario.raw)
      const target = `${key}:entry:${scenario.mode}:1`
      const other = local({ description: 'occupied target' })
      const saved = new Map([[key, raw]])
      if (occupied) saved.set(target, other)
      const before = bytes(saved)
      const f = direct({ mode: scenario.mode, requestedVersion: scenario.requestedVersion, saved, api: {
        [scenario.mode === 'free' ? 'freePreset' : 'template']: async () => {
          entered.resolve(); await wait.promise; return f.config
        }
      } })
      const flight = f.workflow.restore()
      await entered.promise
      scenario.mode === 'free' ? f.workflow.setDescription('current edit') : f.workflow.setUserNotes('current edit')
      assert.equal(bytes(saved), before)
      assert.ok(f.workflow.getSnapshot().storageError)
      assert.equal(f.writes.length, 0)
      wait.resolve()
      await flight
      assert.equal(bytes(saved), before)
      assert.equal(f.workflow.getSnapshot()[scenario.mode === 'free' ? 'description' : 'userNotes'], 'current edit')
      assert.equal(f.workflow.getSnapshot().sessionId, null)
      if (occupied) {
        assert.ok(f.workflow.getSnapshot().storageError)
        await f.workflow.prepareQuote()
        assert.equal(f.workflow.getSnapshot().sessionId, null)
        assert.equal(saved.get(target), other)
      } else {
        assert.equal(f.workflow.getSnapshot().storageError, '')
      }
      assert.equal(saved.get(key), raw)
      f.workflow.dispose()
    })
  }
}
test('valid frozen session request in generic key without journal remains confirmable by original protocol', async () => {
  const request = { templateId: 1, templateVersionId: 2, clientRequestId: 'original-frozen-request' }
  const raw = local({ mode: 'free', templateId: 1, templateVersionId: 2, sessionRequest: request })
  const saved = new Map([[key, raw]])
  const confirmed = []
  const f = direct({ saved, api: {
    freePreset: async () => { throw offline() },
    createSession: async (body) => { confirmed.push(body); return f.session }
  } })
  const before = bytes(saved)
  await f.workflow.restore()
  assert.equal(bytes(saved), before)
  assert.equal(f.workflow.getSnapshot().corruptPending, false)
  assert.equal(f.workflow.getSnapshot().storageError, '')
  assert.equal(JSON.stringify(f.workflow.getSnapshot().sessionRequest), JSON.stringify(request))
  await f.workflow.prepareQuote()
  assert.deepEqual(JSON.parse(JSON.stringify(confirmed)), [{ templateId: request.templateId, clientRequestId: request.clientRequestId }])
  assert.equal(f.workflow.getSnapshot().sessionId, 4)
  assert.equal(f.workflow.getSnapshot().sessionRequest, null)
  assert.equal(f.workflow.getSnapshot().storageError, '')
  f.workflow.dispose()
})
const frozenRecord = (kind) => {
  const request = { templateId: 1, templateVersionId: 2, clientRequestId: 'original-frozen-request' }
  const body = { sessionId: 4, input: { description: 'frozen body', userNotes: '', inputMediaIds: [] },
    clientRequestId: 'original-generation-request', quoteToken: 'original-quote' }
  return local({ mode: 'free', templateId: 1, templateVersionId: 2,
    description: 'original input', sessionId: kind === 'submission' ? 4 : null,
    sessionRequest: kind === 'sessionRequest' ? request : null,
    submission: kind === 'submission' ? { protocol: 2, path: '/generations', sessionId: 4,
      sourceArtifactId: null, templateVersionId: 2, costCredits: 3, body } : null })
}
for (const kind of ['sessionRequest', 'submission']) {
  test(`generic ${kind} without journal is projected before config await and edit preserves frozen identity through reopen`, async () => {
    const wait = gate(), entered = gate(), raw = frozenRecord(kind)
    const saved = new Map([[key, raw]])
    const remote = []
    const f = direct({ saved, api: {
      freePreset: async () => { entered.resolve(); await wait.promise; return template() },
      putDraft: async (body) => { remote.push(['draft', body]); return { input: body.input } },
      quote: async (body) => { remote.push(['quote', body]); throw Error('UNEXPECTED_QUOTE') },
      createSession: async (body) => { remote.push(['session', body]); return f.session }
    } })
    const flight = f.workflow.restore()
    await entered.promise
    assert.equal(JSON.stringify(f.workflow.getSnapshot()[kind]), JSON.stringify(raw[kind]))
    f.workflow.setDescription('edited during frozen config GET')
    await Promise.resolve()
    assert.equal(saved.get(key).description, 'edited during frozen config GET')
    assert.equal(JSON.stringify(saved.get(key)[kind]), JSON.stringify(raw[kind]))
    assert.equal(JSON.stringify(f.workflow.getSnapshot()[kind]), JSON.stringify(raw[kind]))
    wait.resolve()
    await flight
    await Promise.resolve()
    assert.equal(f.workflow.getSnapshot().description, 'edited during frozen config GET')
    assert.equal(saved.get(key).description, 'edited during frozen config GET')
    assert.equal(JSON.stringify(saved.get(key)[kind]), JSON.stringify(raw[kind]))
    assert.equal(JSON.stringify(f.workflow.getSnapshot()[kind]), JSON.stringify(raw[kind]))
    assert.deepEqual(remote, [])
    f.workflow.dispose()
    const reopened = direct({ saved, api: { account: async () => { throw offline() } } })
    await reopened.workflow.restore()
    assert.equal(reopened.workflow.getSnapshot().description, 'edited during frozen config GET')
    assert.equal(JSON.stringify(reopened.workflow.getSnapshot()[kind]), JSON.stringify(raw[kind]))
    reopened.workflow.dispose()
  })
  test(`generic ${kind} explicit original request confirmation remains writable while config is gated`, async () => {
    const wait = gate(), entered = gate(), raw = frozenRecord(kind)
    const saved = new Map([[key, raw]]), confirmed = []
    const f = direct({ saved, api: {
      freePreset: async () => { entered.resolve(); await wait.promise; return template() },
      createSession: async (body) => { confirmed.push(body); return f.session },
      generate: async (body) => { confirmed.push(body); throw offline() }
    } })
    const flight = f.workflow.restore()
    await entered.promise
    f.workflow.setDescription('editing does not replace original request')
    if (kind === 'sessionRequest') await f.workflow.prepareQuote()
    else await f.workflow.generate()
    assert.deepEqual(JSON.parse(JSON.stringify(confirmed)), [kind === 'sessionRequest' ? { templateId: raw.sessionRequest.templateId, clientRequestId: raw.sessionRequest.clientRequestId } : raw.submission.body])
    assert.equal(f.workflow.getSnapshot().corruptPending, false)
    wait.resolve()
    await flight
    if (kind === 'sessionRequest') assert.equal(f.workflow.getSnapshot().sessionRequest, null)
    else assert.equal(JSON.stringify(f.workflow.getSnapshot().submission), JSON.stringify(raw.submission))
    f.workflow.dispose()
  })
}
for (const kind of ['sessionRequest', 'submission']) {
  test(`malformed generic ${kind} locks before any config IO and retains original raw key`, async () => {
    const raw = frozenRecord(kind)
    raw[kind] = { damaged: true }
    const saved = new Map([[key, raw]]), before = bytes(saved)
    let reads = 0
    const f = direct({ saved, api: { freePreset: async () => { reads++; return template() } } })
    await f.workflow.restore()
    assert.equal(reads, 0)
    assert.equal(f.workflow.getSnapshot().corruptPending, true)
    f.workflow.setDescription('in memory only')
    await f.workflow.prepareQuote()
    await f.workflow.generate()
    assert.equal(bytes(saved), before)
    assert.equal(f.writes.length, 0)
    f.workflow.dispose()
  })
}
test('conflicting generic frozen request and existing journal lock before config and retain both fingerprints', async () => {
  const raw = frozenRecord('sessionRequest'), other = frozenRecord('sessionRequest')
  other.sessionRequest = { ...other.sessionRequest, clientRequestId: 'other-frozen-request' }
  const saved = new Map([[key, raw], ['unsettled:template:free', { protocol: 2, draftKey: key, record: other }]])
  const before = bytes(saved)
  let reads = 0
  const f = direct({ saved, api: { freePreset: async () => { reads++; return template() } } })
  await f.workflow.restore()
  assert.equal(reads, 0)
  assert.equal(f.workflow.getSnapshot().corruptPending, true)
  f.workflow.setDescription('do not overwrite either request')
  assert.equal(bytes(saved), before)
  f.workflow.dispose()
})
