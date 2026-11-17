const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { load } = require('../source.cjs')
const modulePath = 'src/features/creation/initial-input-intent.js'
// Only the initial absent file is tolerated; dependency/transform failures remain visible.
const api = fs.existsSync(path.resolve(__dirname, '../../', modulePath)) ? load(modulePath) : {}
const plain = (v) => JSON.parse(JSON.stringify(v))
const binding = (sessionId = 4) => ({ mode: 'free', templateId: 1, templateVersionId: 2, sessionId })
const entry = () => ({ key: 'template:free', kind: 'template', mode: 'free', templateId: null, templateVersionId: null, sessionId: null })
const context = (b = binding()) => ({ entry: entry(), binding: b })
const record = (extra = {}) => ({ protocol: 2, ...binding(), description: 'old', userNotes: 'inactive retained', photos: [], sessionRequest: null, submission: null, draftPaused: false, recoveryKey: 'unsettled:session:4', ...extra })
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.value }
const bad = (r, code, pointer) => { assert.equal(r.ok, false); assert.equal(r.error.code, code); if (pointer !== undefined) assert.equal(r.error.path, pointer); return r }
const fp = (value) => ok(api.fingerprintInitialInputValue({ value }))
function frozen(v) { if (v && typeof v === 'object') { assert.equal(Object.isFrozen(v), true); for (const child of Object.values(v)) frozen(child) } }

test('public fingerprint and complete-record APIs exist before any fixture setup', () => {
  assert.equal(typeof api.fingerprintInitialInputValue, 'function')
  assert.equal(typeof api.readCompleteOrdinaryRecord, 'function')
})

test('fingerprints sort lexical numeric keys and distinguish absence and primitives', () => {
  assert.deepEqual(plain(fp(undefined)), { kind: 'absent' })
  for (const [v, json] of [[null, 'null'], [false, 'false'], [0, '0'], ['', '""']]) assert.equal(fp(v).json, json)
  assert.equal(fp({ 2: 'b', 10: 'a', z: { b: 2, a: 1 } }).json, '{"10":"a","2":"b","z":{"a":1,"b":2}}')
  assert.equal(fp({ b: 2, a: 1 }).json, fp({ a: 1, b: 2 }).json)
  assert.notEqual(fp([1, 2]).json, fp([2, 1]).json)
  const shared = { x: 1 }
  assert.equal(fp([shared, shared]).json, '[{"x":1},{"x":1}]')
})

test('JSON accepts genuine host, VM and null prototypes without mutating input', () => {
  for (const value of [{ x: [1] }, vm.runInNewContext('({x:[1]})'), Object.assign(Object.create(null), { x: [1] })]) {
    const result = api.fingerprintInitialInputValue({ value })
    assert.equal(ok(result).json, '{"x":[1]}')
    frozen(result)
    assert.equal(Object.isFrozen(value), false)
  }
  const sealed = Object.freeze({ x: Object.freeze([1]) })
  assert.equal(fp(sealed).json, '{"x":[1]}')
})

test('JSON rejects unsafe values descriptor-first and keeps opaque paths private', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'SECRET_TOKEN', { enumerable: true, get() { calls++; throw Error('SECRET_VALUE') } })
  const hidden = Object.defineProperty({}, 'SECRET_TOKEN', { value: 1 })
  const extra = [1]; extra.SECRET_TOKEN = 2
  const symbol = { [Symbol('SECRET_TOKEN')]: 1 }
  const cycle = {}; cycle.x = cycle
  const values = [getter, hidden, extra, symbol, cycle, new Date(), new (class X {})(), Object.create({}), [1, , 2], { x: undefined }, -0, NaN, Infinity, 1n, () => {}, Symbol('x')]
  for (const value of values) {
    const result = bad(api.fingerprintInitialInputValue({ value }), 'INVALID_JSON', '/value')
    assert.doesNotMatch(JSON.stringify(result), /SECRET/)
    frozen(result)
  }
  assert.equal(calls, 0)
  bad(api.fingerprintInitialInputValue({}), 'INVALID_DTO', '/value')
  bad(api.fingerprintInitialInputValue({ value: 1, SECRET_TOKEN: 1 }), 'INVALID_DTO', '')
  bad(api.fingerprintInitialInputValue(new Proxy({}, { ownKeys() { throw Error('SECRET') } })), 'INVALID_JSON', '')
})

test('complete ordinary records preserve inactive text, optionals, old carry omission and copies', () => {
  const source = record({ photos: [{ id: 'slot', status: 'pending', path: null, mediaId: null, size: 0, name: '', mimeType: '', error: '' }] })
  const result = api.readCompleteOrdinaryRecord({ context: context(null), record: source })
  const value = ok(result)
  assert.deepEqual(plain(value.binding), binding())
  assert.equal(value.record.userNotes, 'inactive retained')
  assert.equal('carryBackSourceTaskId' in value.record, false)
  assert.notEqual(value.record, source)
  frozen(result)
  assert.equal(Object.isFrozen(source), false)
  const withNull = ok(api.readCompleteOrdinaryRecord({ context: context(), record: record({ carryBackSourceTaskId: null }) }))
  assert.equal(withNull.record.carryBackSourceTaskId, null)
  assert.notEqual(fp(source).json, fp({ ...source, carryBackSourceTaskId: null }).json)
})

test('complete predicate rejects partial, unknown, frozen and invalid closed photos', () => {
  for (const field of Object.keys(record()).filter((key) => key !== 'templateVersionId')) { const r = record(); delete r[field]; bad(api.readCompleteOrdinaryRecord({ context: context(), record: r }), 'INVALID_DTO') }
  for (const r of [record({ x: 1 }), record({ sessionRequest: {} }), record({ submission: {} }), record({ photos: [{ id: 'x', status: 'ready' }] }), record({ photos: [{ id: 'x', status: 'pending', extra: 1 }] }), record({ photos: [{ id: 'x', status: 'pending', path: undefined }] }), record({ photos: [{ id: 'x', status: 'pending' }, { id: 'x', status: 'failed' }] }), record({ recoveryKey: 'unsettled:session:999' })]) bad(api.readCompleteOrdinaryRecord({ context: context(), record: r }), r.photos?.[0]?.path === undefined && Object.hasOwn(r.photos?.[0] || {}, 'path') ? 'INVALID_JSON' : 'INVALID_DTO')
  const unavailable = { id: 'media:9', status: 'unavailable', mediaId: 9 }
  bad(api.readCompleteOrdinaryRecord({ context: context(), record: record({ photos: [unavailable] }) }), 'INVALID_DTO')
  ok(api.readCompleteOrdinaryRecord({ context: context(), record: record({ photos: [unavailable], carryBackSourceTaskId: 8 }) }))
  for (const r of [record({ mode: 'effect' }), record({ templateVersionId: 7 }), record({ sessionId: 5, recoveryKey: 'unsettled:session:5' })]) bad(api.readCompleteOrdinaryRecord({ context: context(), record: r }), 'ENTRY_MISMATCH')
})

const pending = (extra = {}) => ({ protocol: 1, kind: 'ordinary-initial-input', entry: entry(), fields: ['description'], patch: { description: '' }, observed: [], prepared: null, ...extra })
const sortObservations = (values) => values.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
function preparedFixture(sourceRole = 'primary', expected = fp(record())) {
  const primary = 'template:free'
  const alias = 'session:4'
  const targets = [{ key: alias, expected, desired: record({ description: '' }) }, { key: primary, expected, desired: record({ description: '' }) }]
  const source = { kind: 'local', key: sourceRole === 'alias' ? alias : primary, fingerprint: expected }
  return pending({ observed: targets.map(({ key, expected: fingerprint }) => ({ key, fingerprint })), prepared: { binding: binding(), primaryKey: primary, source, targets } })
}
const encode = (intent, ctx = context()) => ok(api.encodeInitialInputIntent({ context: ctx, intent }))
const journal = (intent, ctx = context()) => ({ kind: 'json', json: encode(intent, ctx).json })

test('all six public APIs are functions', () => {
  for (const key of ['fingerprintInitialInputValue', 'readCompleteOrdinaryRecord', 'encodeInitialInputIntent', 'decodeInitialInputIntent', 'prepareInitialInputIntent', 'planInitialInputReplay']) assert.equal(typeof api[key], 'function', key)
})

test('pending canonical roundtrip preserves edits and returns fresh frozen copies', () => {
  const intent = pending({ fields: ['description', 'userNotes', 'photos'], patch: { description: '', userNotes: '', photos: [] } })
  const encoded = encode(intent, context(null))
  const decoded = ok(api.decodeInitialInputIntent({ context: context(null), json: encoded.json }))
  assert.deepEqual(plain(decoded.intent), intent)
  assert.equal(encoded.bytes, Buffer.byteLength(encoded.json))
  assert.notEqual(encoded.intent, intent)
  frozen(encoded); frozen(decoded)
  assert.equal(Object.isFrozen(intent), false)
  for (const raw of [' ' + encoded.json, encoded.json + '\n', encoded.json.replace('"protocol":1', '"protocol":1,"protocol":1'), encoded.json.replace('ordinary-initial-input', '\\u006frdinary-initial-input'), JSON.stringify(intent)]) bad(api.decodeInitialInputIntent({ context: context(null), json: raw }), 'NON_CANONICAL')
  bad(api.decodeInitialInputIntent({ context: context(), json: '{' }), 'INVALID_JSON', '/json')
})

test('closed masks reject missing, extra, unordered and carry-only patch fields', () => {
  const invalid = [pending({ extra: 1 }), pending({ fields: [] }), pending({ fields: ['description', 'description'] }), pending({ fields: ['photos', 'description'], patch: { photos: [], description: '' } }), pending({ patch: { description: '', sessionId: 4 } }), pending({ fields: ['carryBackSourceTaskId'], patch: { carryBackSourceTaskId: null } }), pending({ fields: ['photos'], patch: { photos: [], description: '' } })]
  for (const intent of invalid) bad(api.encodeInitialInputIntent({ context: context(), intent }), 'INVALID_DTO')
  const accessor = pending(); Object.defineProperty(accessor.patch, 'SECRET_PASSWORD', { enumerable: true, get() { throw Error('do not invoke') } })
  const error = bad(api.encodeInitialInputIntent({ context: context(), intent: accessor }), 'INVALID_JSON', '/intent')
  assert.doesNotMatch(JSON.stringify(error), /SECRET_PASSWORD/)
  bad(api.encodeInitialInputIntent({ context: context(), intent: pending(), allowedKeys: [] }), 'INVALID_DTO', '')
  bad(api.encodeInitialInputIntent({ context: { ...context(), extra: 1 }, intent: pending() }), 'INVALID_CONTEXT')
})

test('pending provenance waits for externally resolved session and closed slots', () => {
  const photos = [{ id: 'media:9', status: 'unavailable', mediaId: 9 }]
  const intent = pending({ fields: ['photos', 'carryBackSourceTaskId'], patch: { photos, carryBackSourceTaskId: 8 } })
  bad(api.encodeInitialInputIntent({ context: context(null), intent }), 'BINDING_REQUIRED')
  encode(intent)
  bad(api.encodeInitialInputIntent({ context: context(), intent: pending({ fields: ['photos'], patch: { photos } }) }), 'INVALID_DTO')
})

test('prepared exact derived target coverage and opaque immutable observations', () => {
  const intent = preparedFixture()
  encode(intent)
  const standard = 'template:free:entry:free:1:2'
  const copy = plain(intent)
  copy.prepared.source.key = standard
  copy.observed.push({ key: standard, fingerprint: copy.prepared.source.fingerprint }); sortObservations(copy.observed)
  encode(copy)
  const mutations = [
    (i) => { i.prepared.targets.pop() },
    (i) => { i.prepared.targets[0].key = 'session:999'; i.observed[0].key = 'session:999' },
    (i) => { i.prepared.primaryKey = 'session:4' },
    (i) => { i.prepared.targets.reverse() },
    (i) => { i.prepared.targets[0].desired.userNotes = 'different' },
    (i) => { i.prepared.targets[0].desired.description = 'not patch' },
    (i) => { i.observed[0].fingerprint = fp(null) },
    (i) => { i.prepared.targets.push(plain(i.prepared.targets[1])) }
  ]
  for (const mutate of mutations) { const i = plain(intent); mutate(i); assert.equal(api.encodeInitialInputIntent({ context: context(), intent: i }).ok, false) }
  for (const key of ['initial-input:template:free', 'unsettled:template:free', 'arbitrary']) bad(api.encodeInitialInputIntent({ context: context(), intent: pending({ observed: [{ key, fingerprint: fp(undefined) }] }) }), 'KEY_NOT_ALLOWED')
  const opaque = fp({ unknown: ['faithful'], sessionRequest: { keep: true } })
  copy.observed.find((o) => o.key === standard).fingerprint = opaque
  copy.prepared.source = { kind: 'local', key: 'template:free', fingerprint: copy.prepared.targets[1].expected }
  encode(copy)
  for (const property of ['sessionRequest', 'submission']) {
    const frozenFp = fp({ [property]: {} })
    const target = preparedFixture('primary', frozenFp)
    bad(api.encodeInitialInputIntent({ context: context(), intent: target }), 'FROZEN_TARGET')
    const sourceOnly = plain(copy); sourceOnly.prepared.source = { kind: 'local', key: standard, fingerprint: frozenFp }; sourceOnly.observed.find((o) => o.key === standard).fingerprint = frozenFp
    bad(api.encodeInitialInputIntent({ context: context(), intent: sourceOnly }), 'FROZEN_SOURCE')
  }
})

test('version-only and independent session route pins are preserved without inference', () => {
  for (const pins of [{ mode: null, templateId: null, templateVersionId: 2 }, { mode: 'free', templateId: null, templateVersionId: null }, { mode: null, templateId: 1, templateVersionId: null }]) {
    const e = { key: 'session:4', kind: 'session', ...pins, sessionId: 4 }
    const ctx = { entry: e, binding: binding() }
    assert.deepEqual(plain(ok(api.readCompleteOrdinaryRecord({ context: { ...ctx, binding: null }, record: record() })).binding), binding())
    const i = pending({ entry: e, observed: [{ key: e.key, fingerprint: fp(record()) }] })
    assert.deepEqual(plain(encode(i, ctx).intent.entry), e)
    const proposal = { binding: binding(), primaryKey: e.key, source: { kind: 'local', key: e.key, fingerprint: fp(record()) }, targets: [{ key: e.key, expected: fp(record()), desired: record({ description: '' }) }] }
    const prepared = ok(api.prepareInitialInputIntent({ context: ctx, pending: i, proposal, currentJournal: journal(i, ctx), current: i.observed }))
    assert.deepEqual(plain(prepared.intent.entry), e)
    assert.deepEqual(plain(ok(api.decodeInitialInputIntent({ context: { ...ctx, binding: null }, json: prepared.json })).intent.entry), e)
    bad(api.planInitialInputReplay({ context: { ...ctx, binding: null }, intent: prepared.intent, currentJournal: prepared.desiredJournal, current: i.observed, serverAnchor: null }), 'BINDING_REQUIRED')
    assert.equal(ok(api.planInitialInputReplay({ context: ctx, intent: prepared.intent, currentJournal: prepared.desiredJournal, current: i.observed, serverAnchor: null })).classification, 'targets-pending')
    for (const changed of [{ mode: 'effect' }, { templateId: 8 }, { templateVersionId: 8 }, { sessionId: 8, key: 'session:8' }]) bad(api.readCompleteOrdinaryRecord({ context: { entry: { ...e, ...changed }, binding: null }, record: record() }), 'ENTRY_MISMATCH')
  }
})

test('journal-derived binding permits inspection but never replay authority', () => {
  const i = preparedFixture()
  i.prepared.binding.sessionId = 999
  for (const target of i.prepared.targets) { if (target.key === 'session:4') target.key = 'session:999'; target.desired.sessionId = 999; target.desired.recoveryKey = 'unsettled:session:999' }
  for (const o of i.observed) if (o.key === 'session:4') o.key = 'session:999'
  const encoded = encode(i, context(null))
  ok(api.decodeInitialInputIntent({ context: context(null), json: encoded.json }))
  bad(api.encodeInitialInputIntent({ context: context(), intent: i }), 'ENTRY_MISMATCH')
  bad(api.planInitialInputReplay({ context: context(null), intent: i, currentJournal: { kind: 'json', json: encoded.json }, current: i.observed, serverAnchor: null }), 'BINDING_REQUIRED')
})

test('prepare requires every current snapshot including overlap and exact pending journal', () => {
  const i = pending({ observed: [{ key: 'template:free', fingerprint: fp({ opaque: true }) }] })
  const expected = i.observed[0].fingerprint
  const proposal = preparedFixture('primary', expected).prepared
  const current = proposal.targets.map((t) => ({ key: t.key, fingerprint: t.expected }))
  const args = { context: context(), pending: i, proposal, currentJournal: journal(i), current }
  const value = ok(api.prepareInitialInputIntent(args))
  assert.equal(value.classification, 'prepare')
  assert.deepEqual(plain(value.expectedJournal), args.currentJournal)
  assert.equal(value.desiredJournal.json, value.json)
  assert.deepEqual(plain(value.intent.observed), plain(current))
  frozen(value)
  bad(api.prepareInitialInputIntent({ ...args, currentJournal: fp(null) }), 'JOURNAL_MISMATCH')
  for (const index of [0, 1]) { const c = plain(current); c[index].fingerprint = fp(false); bad(api.prepareInitialInputIntent({ ...args, current: c }), 'OBSERVATION_CONFLICT') }
  const p = plain(proposal); p.source.fingerprint = fp('third')
  bad(api.prepareInitialInputIntent({ ...args, proposal: p }), 'OBSERVATION_CONFLICT')
  bad(api.prepareInitialInputIntent({ ...args, current: current.slice(1) }), 'INVALID_DTO')
  bad(api.prepareInitialInputIntent({ ...args, pending: value.intent, currentJournal: value.desiredJournal }), 'NOT_PENDING')
  assert.deepEqual(i.patch, { description: '' }); assert.equal(i.prepared, null)
})

test('reflection exceptions cannot forge errors or invoke thrown-object getters', () => {
  let calls = 0
  for (const thrown of [{ code: 'UNTRUSTED_CODE', path: 'PRIVATE_RAW' }, Object.defineProperty({}, 'code', { get() { calls++; throw Error('ESCAPED_REFLECTION_ERROR') } }), new Proxy({}, { get() { calls++; throw Error('ESCAPED_REFLECTION_ERROR') }, getPrototypeOf() { calls++; throw Error('ESCAPED_REFLECTION_ERROR') } })]) {
    const value = new Proxy({}, { getPrototypeOf() { throw thrown } })
    bad(api.fingerprintInitialInputValue({ value }), 'INVALID_JSON', '/value')
    bad(api.readCompleteOrdinaryRecord({ context: value, record: record() }), 'INVALID_CONTEXT', '/context')
    const result = bad(api.fingerprintInitialInputValue(value), 'INVALID_JSON', '')
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RAW|UNTRUSTED|ESCAPED/)
  }
  assert.equal(calls, 0)
})

function replayArgs(intent = preparedFixture(), ctx = context()) {
  return { context: ctx, intent, currentJournal: journal(intent, ctx), current: plain(intent.observed), serverAnchor: null }
}
function desiredCurrent(args, keys) {
  const copy = { ...args, current: plain(args.current) }
  for (const key of keys) copy.current.find((o) => o.key === key).fingerprint = fp(args.intent.prepared.targets.find((t) => t.key === key).desired)
  return copy
}

test('replay target roles outrank overlapping old source observations in every orientation', () => {
  for (const role of ['primary', 'alias']) {
    const args = replayArgs(preparedFixture(role))
    for (const keys of [[], ['template:free'], ['session:4'], ['session:4', 'template:free']]) {
      const value = ok(api.planInitialInputReplay(desiredCurrent(args, keys)))
      assert.equal(value.classification, keys.length === 2 ? 'cleanup-only' : 'targets-pending')
      assert.deepEqual(plain(value.pendingTargetKeys), ['session:4', 'template:free'].filter((k) => !keys.includes(k)))
      assert.deepEqual(plain(value.targetStates), ['session:4', 'template:free'].map((key) => ({ key, state: keys.includes(key) ? 'desired' : 'expected' })))
      frozen(value)
    }
  }
  const i = preparedFixture('primary', fp(record({ description: '' })))
  const value = ok(api.planInitialInputReplay(replayArgs(i)))
  assert.equal(value.classification, 'cleanup-only')
  assert.deepEqual(plain(value.pendingTargetKeys), [])
})

test('replay blocks third targets, immutable source changes and every journal mismatch', () => {
  const args = replayArgs()
  for (const key of ['session:4', 'template:free']) {
    const changed = desiredCurrent(args, ['session:4', 'template:free'])
    changed.current.find((o) => o.key === key).fingerprint = fp('third')
    const result = bad(api.planInitialInputReplay(changed), 'TARGET_CONFLICT')
    assert.equal('value' in result, false)
  }
  const i = preparedFixture()
  const key = 'template:free:entry:free:1:2'
  i.prepared.source = { kind: 'local', key, fingerprint: fp({ opaque: 'source' }) }
  i.observed.push({ key, fingerprint: i.prepared.source.fingerprint }); sortObservations(i.observed)
  const changed = desiredCurrent(replayArgs(i), ['session:4', 'template:free'])
  changed.current.find((o) => o.key === key).fingerprint = fp({ opaque: 'changed' })
  bad(api.planInitialInputReplay(changed), 'OBSERVATION_CONFLICT')
  bad(api.planInitialInputReplay({ ...args, currentJournal: fp(null) }), 'JOURNAL_MISMATCH')
  for (const current of [args.current.slice(1), [...args.current, args.current[1]], [...args.current].reverse()]) bad(api.planInitialInputReplay({ ...args, current }), 'INVALID_DTO')
  bad(api.planInitialInputReplay({ ...args, intent: pending(), currentJournal: journal(pending()) }), 'NOT_PREPARED')
})

const anchor = () => ({ sessionId: 4, updatedAt: '2026-01-01T00:00:00Z', inputFingerprint: fp({ description: 'server', userNotes: '', inputMediaIds: [9, 10] }) })
test('server anchors are exact only while targets remain expected; all desired is cleanup-only', () => {
  const i = preparedFixture(); i.prepared.source = { kind: 'server', ...anchor() }
  const args = replayArgs(i)
  bad(api.planInitialInputReplay(args), 'SERVER_ANCHOR_REQUIRED')
  assert.equal(ok(api.planInitialInputReplay({ ...args, serverAnchor: anchor() })).classification, 'targets-pending')
  for (const changed of [{ ...anchor(), sessionId: 5 }, { ...anchor(), updatedAt: '2026-01-01T00:00:00.000Z' }, { ...anchor(), inputFingerprint: fp({ description: 'changed', userNotes: '', inputMediaIds: [9, 10] }) }]) {
    bad(api.planInitialInputReplay({ ...args, serverAnchor: changed }), 'SERVER_ANCHOR_CONFLICT')
    const partial = desiredCurrent(args, ['template:free'])
    bad(api.planInitialInputReplay({ ...partial, serverAnchor: changed }), 'SERVER_ANCHOR_CONFLICT')
    assert.equal(ok(api.planInitialInputReplay({ ...desiredCurrent(args, ['template:free', 'session:4']), serverAnchor: changed })).classification, 'cleanup-only')
  }
  const allDesired = desiredCurrent(args, ['template:free', 'session:4'])
  assert.equal(ok(api.planInitialInputReplay(allDesired)).classification, 'cleanup-only')
  for (const a of [{ ...anchor(), updatedAt: 'not-a-date' }, { ...anchor(), inputFingerprint: fp({ description: '', userNotes: '', inputMediaIds: [9, 9] }) }, { ...anchor(), extra: 1 }]) bad(api.planInitialInputReplay({ ...allDesired, serverAnchor: a }), 'INVALID_DTO')
  bad(api.planInitialInputReplay({ ...replayArgs(), serverAnchor: anchor() }), 'INVALID_DTO')
  const fresh = preparedFixture('primary', fp(undefined)); fresh.prepared.source = { kind: 'new' }
  encode(fresh)
  bad(api.planInitialInputReplay({ ...replayArgs(fresh), serverAnchor: anchor() }), 'INVALID_DTO')
  assert.equal(ok(api.planInitialInputReplay(replayArgs(fresh))).classification, 'targets-pending')
})

test('whole canonical journal accepts exactly 1MiB and rejects one more UTF8 byte', () => {
  const limit = 1_048_576
  const overhead = Buffer.byteLength(encode(pending(), context(null)).json)
  for (const unit of ['a', '汉', '😀', '"', '\\', '\u0001', '\ud800']) {
    const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2
    const available = limit - overhead
    const text = unit.repeat(Math.floor(available / unitBytes)) + 'a'.repeat(available % unitBytes)
    const intent = pending({ patch: { description: text } })
    const encoded = encode(intent, context(null))
    assert.equal(encoded.bytes, limit, JSON.stringify(unit))
    assert.equal(Buffer.byteLength(encoded.json), limit)
    assert.equal(ok(api.decodeInitialInputIntent({ context: context(null), json: encoded.json })).bytes, limit)
    bad(api.encodeInitialInputIntent({ context: context(null), intent: pending({ patch: { description: text + 'a' } }) }), 'BYTE_BUDGET_EXCEEDED')
    bad(api.decodeInitialInputIntent({ context: context(null), json: encoded.json + ' ' }), 'BYTE_BUDGET_EXCEEDED', '/json')
  }
})

test('whole budget includes escaped observed fingerprints and repeated desired records', () => {
  const opaque = fp({ secret: '"\\'.repeat(10000) })
  const i = preparedFixture('primary', opaque)
  const text = 'x'.repeat(100000)
  i.patch.description = text
  for (const target of i.prepared.targets) target.desired.description = text
  const encoded = encode(i)
  assert.equal(encoded.bytes, Buffer.byteLength(encoded.json))
  assert.ok(encoded.bytes > text.length * 3 + opaque.json.length * 4)
  const p = pending({ patch: { description: 'x'.repeat(400000) } })
  const before = encode(p)
  const proposal = preparedFixture().prepared
  for (const target of proposal.targets) target.desired.description = p.patch.description
  const current = proposal.targets.map((target) => ({ key: target.key, fingerprint: target.expected }))
  bad(api.prepareInitialInputIntent({ context: context(), pending: p, proposal, currentJournal: { kind: 'json', json: before.json }, current }), 'BYTE_BUDGET_EXCEEDED')
  assert.equal(p.prepared, null)
  assert.equal(encode(p).json, before.json)
})

test('depth64, raw string, own key and wide array work guards are deterministic', () => {
  const nest = (depth) => { let value = null; while (depth--) value = [value]; return value }
  assert.equal(fp(nest(64)).json.length, 132)
  bad(api.fingerprintInitialInputValue({ value: nest(65) }), 'LIMIT_EXCEEDED', '/value')
  bad(api.fingerprintInitialInputValue({ value: 'x'.repeat(1_048_577) }), 'LIMIT_EXCEEDED', '/value')
  bad(api.fingerprintInitialInputValue({ value: { ['x'.repeat(1_048_577)]: 1 } }), 'LIMIT_EXCEEDED', '/value')
  bad(api.fingerprintInitialInputValue({ value: new Array(1_048_577) }), 'LIMIT_EXCEEDED', '/value')
  const nodeHeavy = Array(600000).fill(null)
  bad(api.fingerprintInitialInputValue({ value: nodeHeavy }), 'BYTE_BUDGET_EXCEEDED', '/value')
})

test('every API returns frozen failures for malformed envelopes without invoking accessors', () => {
  let calls = 0
  const accessor = Object.defineProperty({}, 'context', { enumerable: true, get() { calls++; throw Error('SECRET') } })
  for (const fn of Object.values(api).filter((value) => typeof value === 'function')) {
    for (const args of [undefined, null, 0, '', [], {}, accessor, Object.create({}), new Proxy({}, { ownKeys() { throw Object.defineProperty({}, 'code', { get() { calls++; throw Error('SECRET') } }) } })]) {
      let result
      assert.doesNotThrow(() => { result = fn(args) })
      assert.equal(result.ok, false)
      frozen(result)
      assert.doesNotMatch(JSON.stringify(result), /SECRET/)
    }
  }
  assert.equal(calls, 0)
})

test('transient fingerprint and anchor operands reject non-JSON scalars before DTO checks', () => {
  const args = replayArgs()
  for (const value of [undefined, NaN, -0, 1n, Symbol('SECRET'), () => {}]) {
    bad(api.planInitialInputReplay({ ...args, currentJournal: { kind: value } }), 'INVALID_JSON')
    const current = plain(args.current); current[0].key = value
    bad(api.planInitialInputReplay({ ...args, current }), 'INVALID_JSON')
    const i = preparedFixture(); i.prepared.source = { kind: 'server', ...anchor() }
    bad(api.planInitialInputReplay({ ...replayArgs(i), serverAnchor: { ...anchor(), sessionId: value } }), 'INVALID_JSON')
  }
})

test('transient custom prototypes remain INVALID_JSON rather than DTO snapshots', () => {
  const args = replayArgs()
  for (const value of [new Date(), new (class Snapshot {})(), Object.create({})]) {
    bad(api.planInitialInputReplay({ ...args, currentJournal: value }), 'INVALID_JSON')
    bad(api.planInitialInputReplay({ ...args, current: value }), 'INVALID_JSON')
    bad(api.planInitialInputReplay({ ...args, serverAnchor: value }), 'INVALID_JSON')
  }
})

test('diagnostic pointers name real argument containers for decode and prepare', () => {
  const invalid = pending({ protocol: 2 })
  bad(api.decodeInitialInputIntent({ context: context(), json: fp(invalid).json }), 'INVALID_DTO', '/json')
  const valid = preparedFixture()
  bad(api.prepareInitialInputIntent({ context: context(), pending: invalid, proposal: valid.prepared, currentJournal: fp(null), current: valid.observed }), 'INVALID_DTO', '/pending/protocol')
})

test('separate valid transient operands are not charged as one persisted journal envelope', () => {
  const text = 'x'.repeat(160000)
  const i = pending({ patch: { description: text } })
  const proposal = preparedFixture('primary', fp(undefined)).prepared
  proposal.source = { kind: 'new' }
  for (const target of proposal.targets) target.desired.description = text
  const current = proposal.targets.map((target) => ({ key: target.key, fingerprint: target.expected }))
  const prepared = ok(api.prepareInitialInputIntent({ context: context(), pending: i, proposal, currentJournal: journal(i), current }))
  const args = desiredCurrent(replayArgs(prepared.intent), ['session:4', 'template:free'])
  assert.ok(Buffer.byteLength(JSON.stringify(args)) > 1_048_576)
  assert.equal(ok(api.planInitialInputReplay(args)).classification, 'cleanup-only')
})

function serverFingerprintSurface(surface, inputFingerprint) {
  const intent = preparedFixture()
  intent.prepared.source = { kind: 'server', ...anchor() }
  if (surface === 'encode-source') {
    intent.prepared.source.inputFingerprint = inputFingerprint
    return api.encodeInitialInputIntent({ context: context(), intent })
  }
  if (surface === 'prepare-source') {
    intent.prepared.source.inputFingerprint = inputFingerprint
    const p = pending()
    return api.prepareInitialInputIntent({ context: context(), pending: p, proposal: intent.prepared, currentJournal: journal(p), current: intent.observed })
  }
  return api.planInitialInputReplay({ ...replayArgs(intent), serverAnchor: { ...anchor(), inputFingerprint } })
}
const serverFingerprintPaths = {
  'encode-source': '/intent/prepared/source/inputFingerprint',
  'prepare-source': '/proposal/source/inputFingerprint',
  'replay-anchor': '/serverAnchor/inputFingerprint'
}
for (const missing of ['description', 'userNotes', 'inputMediaIds']) {
  for (const [surface, pointer] of Object.entries(serverFingerprintPaths)) {
    test(`opaque server input missing ${missing} stays on real fingerprint container at ${surface}`, () => {
      const input = { description: '', userNotes: '', inputMediaIds: [] }
      delete input[missing]
      bad(serverFingerprintSurface(surface, fp(input)), 'INVALID_DTO', pointer)
    })
  }
}

test('all parsed server input DTO errors stay opaque while genuine fingerprint DTO paths survive', () => {
  for (const [surface, pointer] of Object.entries(serverFingerprintPaths)) {
    for (const input of [null, false, 7, [], { description: '', userNotes: '', inputMediaIds: [], SECRET_TOKEN: 1 }, { description: '', userNotes: '', inputMediaIds: [0] }, { description: '', userNotes: '', inputMediaIds: [1, 1] }, { description: 7, userNotes: '', inputMediaIds: [] }]) {
      const error = bad(serverFingerprintSurface(surface, fp(input)), 'INVALID_DTO', pointer)
      assert.doesNotMatch(JSON.stringify(error), /SECRET_TOKEN/)
    }
    bad(serverFingerprintSurface(surface, { kind: 'unknown' }), 'INVALID_DTO', `${pointer}/kind`)
    bad(serverFingerprintSurface(surface, { kind: 'json' }), 'INVALID_DTO', `${pointer}/json`)
  }
})
