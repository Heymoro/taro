import { hasRecoverablePhotoSlots } from './recovery-contract'

// Structural classifications only: no IO, source admission, or write authorization.
export const MAX_INITIAL_INPUT_INTENT_BYTES = 1_048_576
const MAX_WORK = 1_048_576
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const objectText = Function.prototype.toString.call(Object)
const arrayText = Function.prototype.toString.call(Array)
// Weak internal error brands only; never inspect properties of a thrown user value.
const failures = new WeakMap()
const stop = (code, path) => {
  const token = {}
  failures.set(token, { code, path })
  throw token
}
const id = (value) => Number.isSafeInteger(value) && value > 0
const nullableId = (value) => value === null || id(value)
const mode = (value) => value === 'free' || value === 'effect'
const opaqueKey = (value) => typeof value === 'string' && value.trim().length > 0

function nativePrototype(proto, text) {
  if (!proto) return false
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')
  if (!ctor || !own(ctor, 'value') || typeof ctor.value !== 'function') return false
  const back = Object.getOwnPropertyDescriptor(ctor.value, 'prototype')
  return !!back && own(back, 'value') && back.value === proto &&
    Function.prototype.toString.call(ctor.value) === text
}
function plainPrototype(proto) {
  return proto === null || (Object.getPrototypeOf(proto) === null && nativePrototype(proto, objectText))
}
function dataDescriptors(value, path) {
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAX_WORK) stop('LIMIT_EXCEEDED', path)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of keys) {
    if (typeof key !== 'string') stop('INVALID_JSON', path)
    if (key.length > MAX_WORK) stop('LIMIT_EXCEEDED', path)
    const descriptor = descriptors[key]
    if (!own(descriptor, 'value')) stop('INVALID_JSON', path)
  }
  return { keys, descriptors }
}

/** Bounded manual canonical serialization; stringify is used on primitives only. */
function canonical(value, path) {
  let bytes = 0
  let nodes = 0
  const chunks = []
  const ancestors = new Set()
  const emit = (chunk) => {
    for (const character of chunk) {
      const point = character.codePointAt(0)
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      if (bytes > MAX_INITIAL_INPUT_INTENT_BYTES) stop('BYTE_BUDGET_EXCEEDED', path)
    }
    chunks.push(chunk)
  }
  const walk = (input, depth) => {
    if (depth > 64 || ++nodes > MAX_WORK) stop('LIMIT_EXCEEDED', path)
    if (input === null || typeof input === 'boolean') { emit(JSON.stringify(input)); return input }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)) stop('INVALID_JSON', path)
      emit(JSON.stringify(input)); return input
    }
    if (typeof input === 'string') {
      if (input.length > MAX_WORK) stop('LIMIT_EXCEEDED', path)
      emit(JSON.stringify(input)); return input
    }
    if (typeof input !== 'object') stop('INVALID_JSON', path)
    if (ancestors.has(input)) stop('INVALID_JSON', path)
    const array = Array.isArray(input)
    const proto = Object.getPrototypeOf(input)
    if (array) {
      if (proto !== null && !(nativePrototype(proto, arrayText) &&
        Object.getPrototypeOf(proto) !== null && plainPrototype(Object.getPrototypeOf(proto)))) stop('INVALID_JSON', path)
    } else if (!plainPrototype(proto)) stop('INVALID_JSON', path)
    const { keys, descriptors } = dataDescriptors(input, path)
    ancestors.add(input)
    let copy
    if (array) {
      const length = descriptors.length
      if (!length || !own(length, 'value') || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0) stop('INVALID_JSON', path)
      if (length.value > MAX_WORK) stop('LIMIT_EXCEEDED', path)
      if (keys.length !== length.value + 1) stop('INVALID_JSON', path)
      copy = []
      emit('[')
      for (let i = 0; i < length.value; i++) {
        const descriptor = descriptors[String(i)]
        if (!descriptor || !descriptor.enumerable) stop('INVALID_JSON', path)
        if (i) emit(',')
        copy.push(walk(descriptor.value, depth + 1))
      }
      emit(']')
    } else {
      copy = {}
      emit('{')
      keys.sort()
      keys.forEach((key, index) => {
        const descriptor = descriptors[key]
        if (!descriptor.enumerable) stop('INVALID_JSON', path)
        if (index) emit(',')
        emit(JSON.stringify(key)); emit(':')
        Object.defineProperty(copy, key, { value: walk(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
      })
      emit('}')
    }
    ancestors.delete(input)
    return copy
  }
  try {
    const copy = walk(value, 0)
    return { copy, json: chunks.join(''), bytes }
  } catch (error) {
    if (failures.has(error)) throw error
    stop('INVALID_JSON', path)
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function result(action) {
  try { return freeze({ ok: true, value: action() }) } catch (error) {
    const failure = failures.get(error)
    return freeze({ ok: false, error: failure || { code: 'INVALID_JSON', path: '' } })
  }
}
function exact(value, required, optional, path, code = 'INVALID_DTO') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stop(code, path)
  for (const key of required) if (!own(value, key)) stop(code, `${path}/${key}`)
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) stop(code, path)
}
function check(condition, path, code = 'INVALID_DTO') { if (!condition) stop(code, path) }
function envelope(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !plainPrototype(Object.getPrototypeOf(args))) stop('INVALID_DTO', '')
  const { keys, descriptors } = dataDescriptors(args, '')
  for (const key of fields) {
    if (!own(descriptors, key)) stop('INVALID_DTO', `/${key}`)
    if (!descriptors[key].enumerable) stop('INVALID_JSON', `/${key}`)
  }
  if (keys.some((key) => !fields.includes(key))) stop('INVALID_DTO', '')
  // Values may be undefined only where the API explicitly permits whole-value absence.
  const copy = {}
  fields.forEach((key) => { copy[key] = descriptors[key].value })
  return copy
}
function readEntry(entry, path, code) {
  exact(entry, ['key', 'kind', 'mode', 'templateId', 'sessionId'], ['templateVersionId'], path, code)
  check(opaqueKey(entry.key), `${path}/key`, code)
  check(entry.kind === 'template' || entry.kind === 'session', `${path}/kind`, code)
  check(entry.mode === null || mode(entry.mode), `${path}/mode`, code)
  for (const key of ['templateId', 'sessionId']) check(nullableId(entry[key]), `${path}/${key}`, code)
  if (own(entry, 'templateVersionId')) check(nullableId(entry.templateVersionId), `${path}/templateVersionId`, code)
  if (entry.kind === 'template') {
    check(mode(entry.mode), `${path}/mode`, code)
    check(entry.sessionId === null, `${path}/sessionId`, code)
    check(entry.mode !== 'effect' || id(entry.templateId), `${path}/templateId`, code)
  } else {
    check(id(entry.sessionId), `${path}/sessionId`, code)
    check(entry.key === `session:${entry.sessionId}`, `${path}/key`, code)
  }
}
function readBinding(binding, path, code = 'INVALID_DTO') {
  exact(binding, ['mode', 'templateId', 'sessionId'], ['templateVersionId'], path, code)
  check(mode(binding.mode), `${path}/mode`, code)
  check(id(binding.templateId), `${path}/templateId`, code)
  if (own(binding, 'templateVersionId')) check(id(binding.templateVersionId), `${path}/templateVersionId`, code)
  check(nullableId(binding.sessionId), `${path}/sessionId`, code)
}
function matchEntry(entry, binding, path) {
  for (const key of ['mode', 'templateId']) if (entry[key] !== null && entry[key] !== binding[key]) stop('ENTRY_MISMATCH', path)
  if (own(entry, 'templateVersionId') && entry.templateVersionId !== null && own(binding, 'templateVersionId') && entry.templateVersionId !== binding.templateVersionId) stop('ENTRY_MISMATCH', path)
  if (entry.kind === 'session' && entry.sessionId !== binding.sessionId) stop('ENTRY_MISMATCH', path)
}
function equal(a, b) { return canonical(a, '').json === canonical(b, '').json }
function readContext(input) {
  let context
  try {
    context = canonical(input, '/context').copy
    exact(context, ['entry', 'binding'], [], '/context', 'INVALID_CONTEXT')
    readEntry(context.entry, '/context/entry', 'INVALID_CONTEXT')
    if (context.binding !== null) readBinding(context.binding, '/context/binding', 'INVALID_CONTEXT')
  } catch (error) {
    if (failures.get(error)?.code === 'INVALID_CONTEXT') throw error
    stop('INVALID_CONTEXT', '/context')
  }
  if (context.binding !== null) matchEntry(context.entry, context.binding, '/context/binding')
  return context
}
function matchBinding(context, binding, path) {
  matchEntry(context.entry, binding, path)
  if (context.binding !== null && !sameBinding(context.binding, binding)) stop('ENTRY_MISMATCH', path)
}
// Only identity comparisons adapt legacy metadata; raw fingerprint bytes never change.
function sameBinding(left, right) {
  return ['mode', 'templateId', 'sessionId'].every((key) => left[key] === right[key]) &&
    (!own(left, 'templateVersionId') || !own(right, 'templateVersionId') || left.templateVersionId === right.templateVersionId)
}
function sameEntry(left, right) {
  return ['key', 'kind', 'mode', 'templateId', 'sessionId'].every((key) => left[key] === right[key]) &&
    (!own(left, 'templateVersionId') || !own(right, 'templateVersionId') || left.templateVersionId === right.templateVersionId)
}
function photosValid(photos, carry, sessionId, path, pending = false) {
  check(Array.isArray(photos), path)
  const ids = new Set()
  photos.forEach((photo, index) => {
    const p = `${path}/${index}`
    exact(photo, ['id', 'status'], ['path', 'mediaId', 'size', 'name', 'mimeType', 'error'], p)
    check(opaqueKey(photo.id) && !ids.has(photo.id), `${p}/id`)
    ids.add(photo.id)
    check(['pending', 'failed', 'uploading', 'ready', 'unavailable'].includes(photo.status), `${p}/status`)
    if (own(photo, 'path')) check(photo.path === null || typeof photo.path === 'string', `${p}/path`)
    if (own(photo, 'mediaId')) check(nullableId(photo.mediaId), `${p}/mediaId`)
    if (['ready', 'unavailable'].includes(photo.status)) check(id(photo.mediaId), `${p}/mediaId`)
    if (own(photo, 'size')) check(typeof photo.size === 'number' && photo.size >= 0, `${p}/size`)
    for (const key of ['name', 'mimeType', 'error']) if (own(photo, key)) check(typeof photo[key] === 'string', `${p}/${key}`)
  })
  if (pending && !id(sessionId) && (id(carry) || photos.some((p) => p.status === 'unavailable'))) stop('BINDING_REQUIRED', path)
  check(hasRecoverablePhotoSlots({ photos, carryBackSourceTaskId: carry, sessionId }), path)
}
function ordinary(record, context, path) {
  exact(record, ['protocol', 'mode', 'sessionId', 'templateId', 'description', 'userNotes', 'photos', 'sessionRequest', 'submission', 'draftPaused', 'recoveryKey'], ['carryBackSourceTaskId', 'templateVersionId'], path)
  check(record.protocol === 2, `${path}/protocol`)
  const binding = { mode: record.mode, templateId: record.templateId, sessionId: record.sessionId, ...(own(record, 'templateVersionId') ? { templateVersionId: record.templateVersionId } : {}) }
  readBinding(binding, path)
  for (const key of ['description', 'userNotes']) check(typeof record[key] === 'string', `${path}/${key}`)
  if (own(record, 'carryBackSourceTaskId')) check(nullableId(record.carryBackSourceTaskId), `${path}/carryBackSourceTaskId`)
  check(record.sessionRequest === null, `${path}/sessionRequest`)
  check(record.submission === null, `${path}/submission`)
  check(typeof record.draftPaused === 'boolean', `${path}/draftPaused`)
  const origins = [`unsettled:template:${record.mode === 'free' ? 'free' : record.templateId}`]
  if (id(record.sessionId)) origins.push(`unsettled:session:${record.sessionId}`)
  check(origins.includes(record.recoveryKey), `${path}/recoveryKey`)
  photosValid(record.photos, record.carryBackSourceTaskId, record.sessionId, `${path}/photos`)
  matchBinding(context, binding, path)
  return binding
}

export function fingerprintInitialInputValue(args) {
  return result(() => {
    const { value } = envelope(args, ['value'])
    if (value === undefined) return { kind: 'absent' }
    return { kind: 'json', json: canonical(value, '/value').json }
  })
}
export function readCompleteOrdinaryRecord(args) {
  return result(() => {
    const input = envelope(args, ['context', 'record'])
    const context = readContext(input.context)
    const record = canonical(input.record, '/record').copy
    const binding = ordinary(record, context, '/record')
    return { record, binding }
  })
}

const patchFields = ['description', 'userNotes', 'photos', 'carryBackSourceTaskId']
function shallow(input, path) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      canonical(input, path)
      stop('INVALID_DTO', path)
    }
    check(plainPrototype(Object.getPrototypeOf(input)), path, 'INVALID_JSON')
    const { keys, descriptors } = dataDescriptors(input, path)
    const copy = {}
    keys.forEach((key) => {
      if (!descriptors[key].enumerable) stop('INVALID_JSON', path)
      const value = descriptors[key].value
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value) ||
        (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) stop('INVALID_JSON', path)
      if (typeof value === 'string' && value.length > MAX_WORK) stop('LIMIT_EXCEEDED', path)
      Object.defineProperty(copy, key, { value, enumerable: true })
    })
    return copy
  } catch (error) {
    if (failures.has(error)) throw error
    stop('INVALID_JSON', path)
  }
}
function boundedRaw(json, path) {
  check(typeof json === 'string', path)
  let bytes = 0
  for (const character of json) {
    const point = character.codePointAt(0)
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > MAX_INITIAL_INPUT_INTENT_BYTES) stop('BYTE_BUDGET_EXCEEDED', path)
  }
}
function parseCanonical(json, path) {
  boundedRaw(json, path)
  let value
  try { value = JSON.parse(json) } catch { stop('INVALID_JSON', path) }
  const serialized = canonical(value, path)
  check(serialized.json === json, path, 'NON_CANONICAL')
  return serialized
}
function fingerprint(input, path) {
  const value = shallow(input, path)
  check(value.kind === 'absent' || value.kind === 'json', `${path}/kind`)
  exact(value, value.kind === 'absent' ? ['kind'] : ['kind', 'json'], [], path)
  if (value.kind === 'json') {
    parseCanonical(value.json, path)
    return { kind: 'json', json: value.json }
  }
  return { kind: 'absent' }
}
const sameFingerprint = (a, b) => a.kind === b.kind && (a.kind === 'absent' || a.json === b.json)
function observations(input, path, max = 3) {
  // Validate the array's descriptors without serializing combined snapshot payloads.
  let values
  try {
    if (!Array.isArray(input)) { canonical(input, path); stop('INVALID_DTO', path) }
    const proto = Object.getPrototypeOf(input)
    check(proto === null || (nativePrototype(proto, arrayText) && Object.getPrototypeOf(proto) !== null && plainPrototype(Object.getPrototypeOf(proto))), path, 'INVALID_JSON')
    const { keys, descriptors } = dataDescriptors(input, path)
    const length = descriptors.length?.value
    check(Number.isInteger(length) && length >= 0 && length <= max, path)
    check(keys.length === length + 1, path, 'INVALID_JSON')
    values = []
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[index]
      check(!!descriptor && descriptor.enumerable, path, 'INVALID_JSON')
      const p = `${path}/${index}`
      const item = shallow(descriptor.value, p)
      exact(item, ['key', 'fingerprint'], [], p)
      check(opaqueKey(item.key), `${p}/key`)
      check(item.key.length <= MAX_WORK, `${p}/key`, 'LIMIT_EXCEEDED')
      if (index) check(values[index - 1].key < item.key, path)
      values.push({ key: item.key, fingerprint: fingerprint(item.fingerprint, `${p}/fingerprint`) })
    }
  } catch (error) {
    if (failures.has(error)) throw error
    stop('INVALID_JSON', path)
  }
  return values
}
function allowedKeys(context, binding) {
  const key = context.entry.key
  if (!binding || context.entry.kind === 'session') return [key]
  const base = `${key}:entry:${binding.mode}:${binding.templateId}`
  const keys = [key, own(binding, 'templateVersionId') ? `${base}:${binding.templateVersionId}` : base]
  if (own(binding, 'templateVersionId')) keys.push(base)
  if (binding.sessionId !== null) keys.push(`session:${binding.sessionId}`)
  return keys
}
function keyAllowed(key, allowed, path) {
  check(allowed.includes(key), path, 'KEY_NOT_ALLOWED')
}
function preparedKeys(context, prepared) {
  const allowed = allowedKeys(context, prepared.binding)
  const source = prepared.source
  if (context.entry.kind !== 'template' || source?.kind !== 'local' ||
    typeof source.key !== 'string' || source.fingerprint?.kind !== 'json') return allowed
  if (allowed.includes(source.key)) return allowed
  const prefix = `${context.entry.key}:entry:${prepared.binding.mode}:${prepared.binding.templateId}:`
  const suffix = source.key.startsWith(prefix) ? source.key.slice(prefix.length) : ''
  if (!/^[1-9]\d*$/.test(suffix) || !id(Number(suffix))) return allowed
  // An existing source at a retained alias grants only that exact address.
  // A new/absent source never grants arbitrary legacy target keys.
  const raw = JSON.parse(fingerprint(source.fingerprint, '/intent/prepared/source/fingerprint').json)
  ordinary(raw, { ...context, binding: prepared.binding }, '/intent/prepared/source/fingerprint')
  if (own(raw, 'templateVersionId')) check(raw.templateVersionId === Number(suffix), '/intent/prepared/source/key', 'KEY_NOT_ALLOWED')
  return [...new Set([...allowed, source.key])]
}
function frozenSnapshot(value, path, code) {
  if (value.kind === 'absent') return
  const root = JSON.parse(value.json)
  if (root && typeof root === 'object' && !Array.isArray(root) &&
    ['sessionRequest', 'submission'].some((key) => own(root, key) && root[key] !== null)) stop(code, path)
}
function serverFacts(value, path) {
  exact(value, ['sessionId', 'updatedAt', 'inputFingerprint'], [], path)
  check(id(value.sessionId), `${path}/sessionId`)
  check(typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)), `${path}/updatedAt`)
  const fp = fingerprint(value.inputFingerprint, `${path}/inputFingerprint`)
  check(fp.kind === 'json', `${path}/inputFingerprint`)
  const input = JSON.parse(fp.json)
  const inputPath = `${path}/inputFingerprint`
  try {
    exact(input, ['description', 'userNotes', 'inputMediaIds'], [], inputPath)
    check(typeof input.description === 'string' && typeof input.userNotes === 'string', inputPath)
    check(Array.isArray(input.inputMediaIds) && input.inputMediaIds.every(id) && new Set(input.inputMediaIds).size === input.inputMediaIds.length, inputPath)
  } catch (error) {
    // Parsed payload fields are not public Fingerprint DTO properties.
    const failure = failures.get(error)
    if (failure?.code === 'INVALID_DTO') stop(failure.code, inputPath)
    throw error
  }
}
function readPatch(patch, fields, sessionId, path) {
  check(Array.isArray(fields) && fields.length > 0, path.replace('/patch', '/fields'))
  exact(patch, [], patchFields, path)
  const expected = patchFields.filter((key) => own(patch, key))
  check(equal(fields, expected), path.replace('/patch', '/fields'))
  for (const key of ['description', 'userNotes']) if (own(patch, key)) check(typeof patch[key] === 'string', `${path}/${key}`)
  if (own(patch, 'carryBackSourceTaskId')) {
    check(own(patch, 'photos'), path)
    check(nullableId(patch.carryBackSourceTaskId), `${path}/carryBackSourceTaskId`)
  }
  if (own(patch, 'photos')) photosValid(patch.photos, patch.carryBackSourceTaskId, sessionId, `${path}/photos`, true)
}
function readPrepared(prepared, context, patch, path) {
  exact(prepared, ['binding', 'primaryKey', 'source', 'targets'], [], path)
  readBinding(prepared.binding, `${path}/binding`)
  matchBinding(context, prepared.binding, `${path}/binding`)
  const allowed = preparedKeys(context, prepared)
  const primaryAllowed = context.entry.kind === 'session' ? [context.entry.key] : allowed.filter((key) => !key.startsWith('session:'))
  keyAllowed(prepared.primaryKey, primaryAllowed, `${path}/primaryKey`)
  const required = [prepared.primaryKey]
  if (context.entry.kind === 'template' && prepared.binding.sessionId !== null) {
    const alias = `session:${prepared.binding.sessionId}`
    if (!required.includes(alias)) required.push(alias)
  }
  required.sort()
  check(Array.isArray(prepared.targets) && prepared.targets.length >= 1 && prepared.targets.length <= 2, `${path}/targets`)
  let previous = null
  let desired = null
  prepared.targets.forEach((target, index) => {
    const p = `${path}/targets/${index}`
    exact(target, ['key', 'expected', 'desired'], [], p)
    keyAllowed(target.key, allowed, `${p}/key`)
    check(previous === null || previous < target.key, `${path}/targets`)
    previous = target.key
    fingerprint(target.expected, `${p}/expected`)
    ordinary(target.desired, { ...context, binding: prepared.binding }, `${p}/desired`)
    if (desired !== null) check(equal(target.desired, desired), `${p}/desired`)
    desired = target.desired
    for (const key of patchFields) if (own(patch, key)) check(own(target.desired, key) && equal(target.desired[key], patch[key]), `${p}/desired/${key}`)
  })
  check(equal(prepared.targets.map((target) => target.key), required), `${path}/targets`)
  const source = prepared.source
  check(source && typeof source === 'object' && !Array.isArray(source), `${path}/source`)
  if (source.kind === 'local') {
    exact(source, ['kind', 'key', 'fingerprint'], [], `${path}/source`)
    keyAllowed(source.key, allowed, `${path}/source/key`)
    check(fingerprint(source.fingerprint, `${path}/source/fingerprint`).kind === 'json', `${path}/source/fingerprint`)
  } else if (source.kind === 'server') {
    exact(source, ['kind', 'sessionId', 'updatedAt', 'inputFingerprint'], [], `${path}/source`)
    serverFacts({ sessionId: source.sessionId, updatedAt: source.updatedAt, inputFingerprint: source.inputFingerprint }, `${path}/source`)
    check(source.sessionId === prepared.binding.sessionId, `${path}/source/sessionId`, 'ENTRY_MISMATCH')
  } else {
    exact(source, ['kind'], [], `${path}/source`)
    check(source.kind === 'new', `${path}/source/kind`)
  }
  for (let index = 0; index < prepared.targets.length; index++) frozenSnapshot(prepared.targets[index].expected, `${path}/targets/${index}/expected`, 'FROZEN_TARGET')
  if (source.kind === 'local') frozenSnapshot(source.fingerprint, `${path}/source/fingerprint`, 'FROZEN_SOURCE')
}
function validateIntent(intent, context) {
  exact(intent, ['protocol', 'kind', 'entry', 'fields', 'patch', 'observed', 'prepared'], [], '/intent')
  check(intent.protocol === 1, '/intent/protocol')
  check(intent.kind === 'ordinary-initial-input', '/intent/kind')
  readEntry(intent.entry, '/intent/entry', 'INVALID_DTO')
  check(sameEntry(intent.entry, context.entry), '/intent/entry', 'ENTRY_MISMATCH')
  const prepared = intent.prepared
  const sessionId = prepared?.binding?.sessionId ?? context.binding?.sessionId ?? context.entry.sessionId
  readPatch(intent.patch, intent.fields, sessionId, '/intent/patch')
  const observed = observations(intent.observed, '/intent/observed')
  if (prepared === null) {
    check(observed.length <= 1, '/intent/observed')
    for (const item of observed) keyAllowed(item.key, [context.entry.key], '/intent/observed')
    return
  }
  readPrepared(prepared, context, intent.patch, '/intent/prepared')
  const allowed = preparedKeys(context, prepared)
  for (const item of observed) keyAllowed(item.key, allowed, '/intent/observed')
  for (const target of prepared.targets) {
    const observation = observed.find((item) => item.key === target.key)
    check(!!observation && sameFingerprint(observation.fingerprint, target.expected), '/intent/observed')
  }
  if (prepared.source.kind === 'local') {
    const observation = observed.find((item) => item.key === prepared.source.key)
    check(!!observation && sameFingerprint(observation.fingerprint, prepared.source.fingerprint), '/intent/observed')
  }
  if (prepared.source.kind === 'new') check(observed.every((o) => o.fingerprint.kind === 'absent') && prepared.targets.every((t) => t.expected.kind === 'absent'), '/intent/prepared/source')
}
function validateAtArgument(intent, context, path, opaque = false) {
  try { validateIntent(intent, context) } catch (error) {
    const failure = failures.get(error)
    if (failure && failure.path.startsWith('/intent')) {
      stop(failure.code, path + (opaque ? '' : failure.path.slice('/intent'.length)))
    }
    throw error
  }
}
function encodedIntent(input, context, path = '/intent', opaque = false) {
  const serialized = canonical(input, path)
  validateAtArgument(serialized.copy, context, path, opaque)
  return { intent: serialized.copy, json: serialized.json, bytes: serialized.bytes }
}
export function encodeInitialInputIntent(args) {
  return result(() => {
    const input = envelope(args, ['context', 'intent'])
    return encodedIntent(input.intent, readContext(input.context))
  })
}
export function decodeInitialInputIntent(args) {
  return result(() => {
    const input = envelope(args, ['context', 'json'])
    const context = readContext(input.context)
    const serialized = parseCanonical(input.json, '/json')
    validateAtArgument(serialized.copy, context, '/json', true)
    return { intent: serialized.copy, json: serialized.json, bytes: serialized.bytes }
  })
}
export function prepareInitialInputIntent(args) {
  return result(() => {
    const input = envelope(args, ['context', 'pending', 'proposal', 'currentJournal', 'current'])
    const context = readContext(input.context)
    const pending = encodedIntent(input.pending, context, '/pending')
    const proposal = canonical(input.proposal, '/proposal').copy
    const currentJournal = fingerprint(input.currentJournal, '/currentJournal')
    const current = observations(input.current, '/current')
    readPrepared(proposal, context, pending.intent.patch, '/proposal')
    check(pending.intent.prepared === null, '/pending', 'NOT_PENDING')
    check(context.binding !== null, '/context/binding', 'BINDING_REQUIRED')
    const expectedJournal = { kind: 'json', json: pending.json }
    check(sameFingerprint(currentJournal, expectedJournal), '/currentJournal', 'JOURNAL_MISMATCH')
    const expected = [...pending.intent.observed]
    if (proposal.source.kind === 'local') expected.push({ key: proposal.source.key, fingerprint: proposal.source.fingerprint })
    proposal.targets.forEach((target) => expected.push({ key: target.key, fingerprint: target.expected }))
    const keys = [...new Set(expected.map((item) => item.key))].sort()
    check(equal(current.map((item) => item.key), keys), '/current')
    for (const observation of expected) {
      const read = current.find((item) => item.key === observation.key)
      check(sameFingerprint(read.fingerprint, observation.fingerprint), '/current', 'OBSERVATION_CONFLICT')
    }
    const encoded = encodedIntent({ ...pending.intent, observed: current, prepared: proposal }, context, '', true)
    return { classification: 'prepare', ...encoded, expectedJournal, desiredJournal: { kind: 'json', json: encoded.json } }
  })
}
export function planInitialInputReplay(args) {
  return result(() => {
    const input = envelope(args, ['context', 'intent', 'currentJournal', 'current', 'serverAnchor'])
    const context = readContext(input.context)
    const encoded = encodedIntent(input.intent, context)
    const currentJournal = fingerprint(input.currentJournal, '/currentJournal')
    const current = observations(input.current, '/current')
    const serverAnchor = input.serverAnchor === null ? null : shallow(input.serverAnchor, '/serverAnchor')
    if (serverAnchor !== null) serverFacts(serverAnchor, '/serverAnchor')
    const prepared = encoded.intent.prepared
    check(prepared !== null, '/intent/prepared', 'NOT_PREPARED')
    check(context.binding !== null, '/context/binding', 'BINDING_REQUIRED')
    if (prepared.source.kind !== 'server') check(serverAnchor === null, '/serverAnchor')
    const journalFingerprint = { kind: 'json', json: encoded.json }
    check(sameFingerprint(currentJournal, journalFingerprint), '/currentJournal', 'JOURNAL_MISMATCH')
    check(equal(current.map((item) => item.key), encoded.intent.observed.map((item) => item.key)), '/current')
    const targetStates = prepared.targets.map((target) => {
      const actual = current.find((item) => item.key === target.key).fingerprint
      const desired = { kind: 'json', json: canonical(target.desired, '/intent/prepared/targets').json }
      if (sameFingerprint(actual, desired)) return { key: target.key, state: 'desired' }
      check(sameFingerprint(actual, target.expected), '/current', 'TARGET_CONFLICT')
      return { key: target.key, state: 'expected' }
    })
    // Target-role keys may already be desired, including a local source/target overlap.
    for (const observed of encoded.intent.observed) {
      if (prepared.targets.some((target) => target.key === observed.key)) continue
      const actual = current.find((item) => item.key === observed.key).fingerprint
      check(sameFingerprint(actual, observed.fingerprint), '/current', 'OBSERVATION_CONFLICT')
    }
    const pendingTargetKeys = targetStates.filter((target) => target.state === 'expected').map((target) => target.key)
    if (pendingTargetKeys.length > 0 && prepared.source.kind === 'server') {
      check(serverAnchor !== null, '/serverAnchor', 'SERVER_ANCHOR_REQUIRED')
      const source = prepared.source
      check(serverAnchor.sessionId === source.sessionId && serverAnchor.updatedAt === source.updatedAt &&
        sameFingerprint(serverAnchor.inputFingerprint, source.inputFingerprint), '/serverAnchor', 'SERVER_ANCHOR_CONFLICT')
    }
    return { classification: pendingTargetKeys.length ? 'targets-pending' : 'cleanup-only', journalFingerprint, targetStates, pendingTargetKeys }
  })
}
