const positive = (value) => Number.isSafeInteger(value) && value > 0
const nullableId = (value) => value == null || positive(value)
const keys = new Set([
  'protocol', 'mode', 'sessionId', 'templateId', 'templateVersionId', 'description',
  'userNotes', 'photos', 'carryBackSourceTaskId', 'sessionRequest', 'submission',
  'draftPaused', 'recoveryKey'
])

/** Only the existing serializer's ordinary, local-only, unconfirmed text is eligible. */
export function classifyEntryDraft({ record, mode, templateId, recoveryKey }) {
  const rejected = { kind: 'rejected' }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.protocol !== 2) {
    return rejected
  }
  // Frozen requests keep the original recovery validator and confirmation path, even without a journal.
  if (record.sessionRequest != null || record.submission != null) return { kind: 'bound' }
  // These ordinary-record facts are decidable before configuration IO, including for bound records.
  if (
    Object.keys(record).some((key) => !keys.has(key)) ||
    !nullableId(record.templateId) || !nullableId(record.templateVersionId) ||
    (record.mode != null && record.mode !== mode) ||
    (record.recoveryKey != null && record.recoveryKey !== recoveryKey) ||
    (templateId != null && record.templateId != null && record.templateId !== templateId)
  ) {
    return rejected
  }
  if (record.mode != null && record.templateId != null) {
    return { kind: 'bound' }
  }
  if (
    record.sessionId != null || record.sessionRequest != null || record.submission != null ||
    record.carryBackSourceTaskId != null ||
    (record.draftPaused != null && record.draftPaused !== false) ||
    !Array.isArray(record.photos) || record.photos.length !== 0 ||
    typeof record.description !== 'string' || typeof record.userNotes !== 'string' ||
    (record.templateId != null && record.templateId !== templateId) ||
    (mode === 'free' ? record.userNotes !== '' : record.description !== '')
  ) {
    return rejected
  }
  return {
    kind: 'eligible',
    binding: {
      mode,
      templateId: templateId ?? record.templateId ?? null
    }
  }
}

/** The API decoder owns the full DTO; entry recovery additionally checks route/pin identity. */
export function entryConfiguration({ config, mode, templateId }) {
  if (!config || config.mode !== mode || !positive(config.templateId) ||
    (templateId != null && config.templateId !== templateId)) throw Error('TEMPLATE_UNAVAILABLE')
  return { template: config, mode: config.mode, templateId: config.templateId }
}

export function templateEntryKey({ key, binding }) {
  return `${key}:entry:${binding.mode}:${binding.templateId}`
}
