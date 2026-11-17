import { classifyEntryDraft, templateEntryKey } from './entry-draft'
import { fingerprintInitialInputValue, readCompleteOrdinaryRecord } from './initial-input-intent'

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k)
const copy = (v) => JSON.parse(JSON.stringify(v))
export function overlayInitialFields({ base, patch = {} }) {
  const result = copy(base)
  for (const key of ['description', 'userNotes', 'photos', 'carryBackSourceTaskId']) {
    if (own(patch, key)) result[key] = copy(patch[key])
  }
  return result
}
/** A serializer default is not an explicit user provenance edit. */
export function preserveDraftProvenanceOmission({ record, base, patch }) {
  if (record.carryBackSourceTaskId !== null || own(base, 'carryBackSourceTaskId') ||
    own(patch, 'carryBackSourceTaskId')) return record
  const desired = { ...record }
  delete desired.carryBackSourceTaskId
  return desired
}

export function sessionDraftBase({ entry, session }) {
  try {
    if (session.id !== entry.sessionId || !Number.isFinite(Date.parse(session.draft.updatedAt))) {
      return null
    }
    const input = session.draft.input
    if (
      Object.keys(input).sort().join() !== 'description,inputMediaIds,userNotes' ||
      typeof input.description !== 'string' ||
      typeof input.userNotes !== 'string' ||
      !Array.isArray(input.inputMediaIds) ||
      input.inputMediaIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(input.inputMediaIds).size !== input.inputMediaIds.length
    ) {
      return null
    }
    const base = {
      protocol: 2,
      mode: session.mode,
      templateId: session.templateId,
      sessionId: session.id,
      description: input.description,
      userNotes: input.userNotes,
      photos: input.inputMediaIds.map((id) => ({
        id: `media:${id}`,
        status: 'ready',
        mediaId: id,
        path: ''
      })),
      carryBackSourceTaskId: null,
      sessionRequest: null,
      submission: null,
      draftPaused: false,
      recoveryKey: `unsettled:session:${session.id}`
    }
    const checked = readCompleteOrdinaryRecord({ context: { entry, binding: null }, record: base })
    if (!checked.ok) return null
    return {
      base: checked.value.record,
      binding: checked.value.binding,
      source: {
        kind: 'server',
        sessionId: session.id,
        updatedAt: session.draft.updatedAt,
        inputFingerprint: fingerprintInitialInputValue({ value: input }).value
      }
    }
  } catch {
    return null
  }
}
export function newEntryBase(binding) {
  return {
    protocol: 2,
    ...binding,
    description: '',
    userNotes: '',
    photos: [],
    carryBackSourceTaskId: null,
    sessionRequest: null,
    submission: null,
    draftPaused: false,
    recoveryKey: binding.sessionId
      ? `unsettled:session:${binding.sessionId}`
      : `unsettled:template:${binding.mode === 'free' ? 'free' : binding.templateId}`
  }
}
export function resolveEntrySource({ entry, binding, candidates, server = null }) {
  const complete = candidates.map((c) => ({
    ...c,
    checked: readCompleteOrdinaryRecord({ context: { entry, binding }, record: c.value })
  }))
  const valid = complete.filter((c) => c.checked.ok)
  const aliases = valid.filter(
    (c) =>
      c.checked.value.binding.sessionId !== null &&
      c.key === `session:${c.checked.value.binding.sessionId}`
  )
  if (aliases.length > 1) return { status: 'conflict' }
  const selected = aliases[0] || valid[0]
  if (selected) {
    const b = selected.checked.value.binding
    if (
      valid.some((c) =>
        ['mode', 'templateId', 'sessionId'].some(
          (key) => c.checked.value.binding[key] !== b[key]
        ) || (own(c.checked.value.binding, 'templateVersionId') && own(b, 'templateVersionId') &&
          c.checked.value.binding.templateVersionId !== b.templateVersionId)
      )
    ) {
      return { status: 'conflict' }
    }
    if (
      !aliases.length &&
      valid.some(
        (c) =>
          fingerprintInitialInputValue({ value: c.value }).value.json !==
          fingerprintInitialInputValue({ value: selected.value }).value.json
      )
    ) {
      return { status: 'conflict' }
    }
    const alias = b.sessionId && candidates.find((c) => c.key === `session:${b.sessionId}`)
    if (alias && alias.value !== undefined && !aliases.length) return { status: 'conflict' }
    return {
      status: 'ready',
      base: selected.checked.value.record,
      binding: b,
      primaryKey: selected.key,
      source: {
        kind: 'local',
        key: selected.key,
        fingerprint: fingerprintInitialInputValue({ value: selected.value }).value
      }
    }
  }
  const origin = candidates.find((c) => c.key === entry.key)
  if (entry.kind === 'session') {
    if (!origin || origin.value !== undefined) return { status: 'conflict' }
    const remote = server && sessionDraftBase({ entry, session: server })
    return remote ? { status: 'ready', ...remote, primaryKey: entry.key } : { status: 'pending' }
  }
  const classification =
    origin &&
    classifyEntryDraft({
      record: origin.value,
      mode: entry.mode,
      templateId: entry.templateId,
      recoveryKey: `unsettled:template:${entry.mode === 'free' ? 'free' : entry.templateId}`
    })
  const eligible = classification?.kind === 'eligible'
  if (eligible && binding) {
    const base = {
      ...newEntryBase(binding),
      description: origin.value.description,
      userNotes: origin.value.userNotes
    }
    return {
      status: 'ready',
      base,
      binding,
      primaryKey: entry.key,
      source: {
        kind: 'local',
        key: entry.key,
        fingerprint: fingerprintInitialInputValue({ value: origin.value }).value
      }
    }
  }
  if (!binding) {
    return {
      status: origin?.value === undefined || eligible ? 'pending' : 'protected',
      ...(eligible ? { base: copy(origin.value), pin: classification.binding } : {})
    }
  }
  const boundKey = templateEntryKey({ key: entry.key, binding })
  const bound = candidates.find((c) => c.key === boundKey)
  const newlyEligible =
    origin &&
    classifyEntryDraft({
      record: origin.value,
      ...binding,
      recoveryKey: newEntryBase(binding).recoveryKey
    }).kind === 'eligible'
  if (!bound || bound.value !== undefined) return { status: 'conflict' }
  if (newlyEligible) {
    return {
      status: 'ready',
      base: {
        ...newEntryBase(binding),
        description: origin.value.description,
        userNotes: origin.value.userNotes
      },
      binding,
      primaryKey: boundKey,
      source: {
        kind: 'local',
        key: entry.key,
        fingerprint: fingerprintInitialInputValue({ value: origin.value }).value
      }
    }
  }
  // Foreign entry references are immutable; only the independently derived empty bound key is released.
  if (origin?.value !== undefined && !eligible) {
    return {
      status: 'ready',
      base: newEntryBase(binding),
      binding,
      primaryKey: boundKey,
      source: null,
      preserved: true
    }
  }
  return {
    status: 'ready',
    base: newEntryBase(binding),
    binding,
    primaryKey: boundKey,
    source: { kind: 'new' }
  }
}
export function sessionReceiptDesired({ frozenRecord, receipt }) {
  if (
    !Number.isSafeInteger(receipt.id) ||
    receipt.id <= 0 ||
    receipt.templateId !== frozenRecord.templateId
  ) {
    return null
  }
  const original = copy(frozenRecord)
  delete original.templateVersionId
  return {
    ...original,
    sessionId: receipt.id,
    sessionRequest: null,
    submission: frozenRecord.submission ?? null,
    draftPaused: frozenRecord.draftPaused ?? false
  }
}
