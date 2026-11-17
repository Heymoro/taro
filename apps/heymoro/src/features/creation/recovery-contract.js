import { readInput } from '../../creation-input'
import { hasCarryBackSource } from './carry-back-input'

const isPositiveId = ({ value }) => Number.isSafeInteger(value) && value > 0
const isNonnegativeInteger = ({ value }) => Number.isSafeInteger(value) && value >= 0
const isRecord = ({ value }) => !!value && typeof value === 'object' && !Array.isArray(value)

/** Classify a durable request by its complete discriminated union, not by truthiness. */
export function readPendingSubmission({ value, sessionId }) {
  const exactFields = ({ record, fields }) =>
    isRecord({ value: record }) &&
    Object.keys(record).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  try {
    if (
      !isRecord({ value }) ||
      value.protocol !== 2 ||
      !isPositiveId({ value: sessionId }) ||
      value.sessionId !== sessionId ||
      (value.templateId === undefined ? !isPositiveId({ value: value.templateVersionId }) : !isPositiveId({ value: value.templateId })) ||
      !isNonnegativeInteger({ value: value.costCredits })
    ) {
      return null
    }
    const body = value.body
    if (
      !isRecord({ value: body }) ||
      typeof body.clientRequestId !== 'string' ||
      !body.clientRequestId.trim() ||
      body.clientRequestId.length > 128 ||
      typeof body.quoteToken !== 'string' ||
      !body.quoteToken.trim() ||
      body.quoteToken.length > 8192
    ) {
      return null
    }
    let operation
    if (value.path === '/generations' && value.sourceArtifactId === null) {
      if (
        !exactFields({ record: body, fields: ['sessionId', 'input', 'clientRequestId', 'quoteToken'] }) ||
        body.sessionId !== sessionId ||
        !exactFields({ record: body.input, fields: ['inputMediaIds', 'description', 'userNotes'] })
      ) {
        return null
      }
      readInput({ value: body.input })
      if (Reflect.ownKeys(body.input.inputMediaIds).length !== body.input.inputMediaIds.length + 1) {
        return null
      }
      operation = 'generate'
    } else if (
      isPositiveId({ value: value.sourceArtifactId }) &&
      value.path === `/artifacts/${value.sourceArtifactId}/regenerations`
    ) {
      if (!exactFields({ record: body, fields: ['clientRequestId', 'quoteToken'] })) return null
      operation = 'regenerate'
    } else return null
    // Absolute HTTP JSON budget, not today's template schema or a quote-expiry admission gate.
    const json = JSON.stringify(body)
    let bytes = 0
    for (const character of json) {
      const point = character.codePointAt(0)
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      if (bytes > 131072) return null
    }
    return { operation, submission: value }
  } catch {
    return null
  }
}

/** Slot identity/state and optional metadata types only; never today's input schema limits. */
export function hasRecoverablePhotoSlots({ photos, carryBackSourceTaskId, sessionId }) {
  if (!Array.isArray(photos) || Reflect.ownKeys(photos).length !== photos.length + 1) return false
  const slotIds = new Set()
  const slotsValid = photos.every((photo) => {
    if (
      !isRecord({ value: photo }) ||
      typeof photo.id !== 'string' ||
      !photo.id.trim() ||
      slotIds.has(photo.id) ||
      !['pending', 'failed', 'uploading', 'ready', 'unavailable'].includes(photo.status)
    ) {
      return false
    }
    slotIds.add(photo.id)
    if (photo.path != null && typeof photo.path !== 'string') return false
    if (photo.mediaId != null && !isPositiveId({ value: photo.mediaId })) return false
    if (['ready', 'unavailable'].includes(photo.status) && !isPositiveId({ value: photo.mediaId })) {
      return false
    }
    if (photo.size !== undefined && (!Number.isFinite(photo.size) || photo.size < 0)) return false
    return ['name', 'mimeType', 'error'].every(
      (field) => photo[field] === undefined || typeof photo[field] === 'string'
    )
  })
  return slotsValid && hasCarryBackSource({ photos, carryBackSourceTaskId, sessionId })
}

/** The one unfinished operation in a record has one canonical identity and origin. */
export function readUnsettledRecord({ record }) {
  try {
    if (
      !isRecord({ value: record }) ||
      record.protocol !== 2 ||
      !['free', 'effect'].includes(record.mode) ||
      !isPositiveId({ value: record.templateId }) ||
      (record.templateVersionId !== undefined && !isPositiveId({ value: record.templateVersionId })) ||
      typeof record.description !== 'string' ||
      typeof record.userNotes !== 'string' ||
      !hasRecoverablePhotoSlots({
        photos: record.photos,
        carryBackSourceTaskId: record.carryBackSourceTaskId,
        sessionId: record.sessionId,
      })
    ) {
      return null
    }
    const templateKey = `template:${record.mode === 'free' ? 'free' : record.templateId}`
    const origins = [`unsettled:${templateKey}`]
    if (isPositiveId({ value: record.sessionId })) origins.push(`unsettled:session:${record.sessionId}`)
    if (!origins.includes(record.recoveryKey)) return null
    let request
    if (record.sessionRequest != null && record.submission == null) {
      const value = record.sessionRequest
      if (
        record.sessionId !== null ||
        !isRecord({ value }) ||
        Object.keys(value).length !== (Object.prototype.hasOwnProperty.call(value, 'templateVersionId') ? 3 : 2) ||
        !['templateId', 'clientRequestId'].every((field) =>
          Object.prototype.hasOwnProperty.call(value, field)
        ) ||
        value.templateId !== record.templateId ||
        (value.templateVersionId !== undefined && value.templateVersionId !== record.templateVersionId) ||
        typeof value.clientRequestId !== 'string' ||
        !value.clientRequestId.trim() ||
        value.clientRequestId.length > 128
      ) {
        return null
      }
      request = {
        operation: 'session',
        templateId: value.templateId,
        templateVersionId: value.templateVersionId,
        clientRequestId: value.clientRequestId,
      }
    } else if (record.submission != null && record.sessionRequest == null) {
      const pending = readPendingSubmission({ value: record.submission, sessionId: record.sessionId })
      if (!pending || (record.submission.templateVersionId !== undefined && record.submission.templateVersionId !== record.templateVersionId) || (record.submission.templateId !== undefined && record.submission.templateId !== record.templateId)) return null
      const value = pending.submission
      // prettier-ignore
      const body =
        pending.operation === 'generate'
          ? {
            sessionId: value.body.sessionId,
            input: readInput({ value: value.body.input }),
            clientRequestId: value.body.clientRequestId,
            quoteToken: value.body.quoteToken,
          }
          : { clientRequestId: value.body.clientRequestId, quoteToken: value.body.quoteToken }
      request = {
        operation: pending.operation,
        path: value.path,
        sessionId: value.sessionId,
        sourceArtifactId: value.sourceArtifactId,
        ...(value.templateId === undefined ? { templateVersionId: value.templateVersionId } : { templateId: value.templateId }),
        costCredits: value.costCredits,
        body,
      }
    } else return null
    return {
      identity: JSON.stringify({
        mode: record.mode,
        templateId: record.templateId,
        templateVersionId: record.templateVersionId,
        request,
      }),
      templateKey,
    }
  } catch {
    return null
  }
}

export function readRecoveryEntry({ value, recoveryKey, storageKey }) {
  if (
    !isRecord({ value }) ||
    value.protocol !== 2 ||
    Object.keys(value).length !== 3 ||
    !['protocol', 'draftKey', 'record'].every((field) => Object.prototype.hasOwnProperty.call(value, field))
  ) {
    return null
  }
  const pending = readUnsettledRecord({ record: value.record })
  if (!pending || value.record.recoveryKey !== recoveryKey) return null
  const binding = `${value.record.mode}:${value.record.templateId}${value.record.templateVersionId === undefined ? '' : `:${value.record.templateVersionId}`}`
  const draftKeys = [
    pending.templateKey,
    `${pending.templateKey}:entry:${binding}`,
    storageKey,
    `${storageKey}:entry:${binding}`,
  ]
  if (isPositiveId({ value: value.record.sessionId })) draftKeys.push(`session:${value.record.sessionId}`)
  if (!draftKeys.includes(value.draftKey)) return null
  return { ...pending, draftKey: value.draftKey, record: value.record }
}
