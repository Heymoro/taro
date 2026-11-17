import { ApiResponseError } from './api'
import { readInput } from './creation-input'

const isPositiveId = ({ value }) => Number.isSafeInteger(value) && value > 0
const isNonnegativeInteger = ({ value }) => Number.isSafeInteger(value) && value >= 0
const isString = ({ value }) => typeof value === 'string'
const isTimestamp = ({ value }) => isString({ value }) && Number.isFinite(Date.parse(value))
const isRecord = ({ value }) => !!value && typeof value === 'object' && !Array.isArray(value)
const isIdList = ({ value }) =>
  Array.isArray(value) &&
  value.every((value) =>
    isPositiveId({
      value
    })
  ) &&
  new Set(value).size === value.length
const isNullable = ({ value, check }) =>
  value === null ||
  check({
    value
  })
const statuses = ['queued', 'running', 'unknown', 'succeeded', 'failed', 'closed', 'cancelled']
function assertContract({ condition }) {
  if (!condition) throw Error('INVALID_RESPONSE')
}
function project({ value, fields }) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]))
}
export function readTask({ value, binding = {} }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      !['templateVersionId', 'publishedVersionId', 'versionNo'].some((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      isPositiveId({ value: value.id }) &&
      isPositiveId({ value: value.sessionId }) &&
      isPositiveId({ value: value.templateId }) &&
      isPositiveId({ value: value.roundNo }) &&
      isString({ value: value.clientRequestId }) &&
      !!value.clientRequestId.trim() &&
      isNonnegativeInteger({ value: value.costCredits }) &&
      isNullable({ value: value.errorCode, check: isString }) &&
      isNullable({ value: value.sourceTaskId, check: isPositiveId }) &&
      statuses.includes(value.status)
  })
  const input = readInput({ value: value.input })
  if (binding.sessionId !== undefined) {
    assertContract({
      condition: value.sessionId === binding.sessionId
    })
  }
  if (binding.clientRequestId !== undefined) {
    assertContract({
      condition: value.clientRequestId === binding.clientRequestId
    })
  }
  if (binding.templateId !== undefined) {
    assertContract({
      condition: value.templateId === binding.templateId
    })
  }
  if (binding.input) {
    assertContract({
      condition: JSON.stringify(input) === JSON.stringify(readInput({ value: binding.input }))
    })
  }
  if (binding.generate) {
    assertContract({
      condition: value.sourceTaskId === null
    })
  }
  if (binding.regenerate) assertContract({ condition: value.sourceTaskId !== null })
  return {
    ...project({
      value,
      fields: [
        'id',
        'sessionId',
        'clientRequestId',
        'roundNo',
        'templateId',
        'sourceTaskId',
        'status',
        'costCredits',
        'errorCode'
      ]
    }),
    input
  }
}
export function readHistory({ value, binding }) {
  const task = readTask({
    value,
    binding: binding
  })
  assertContract({
    condition:
      isIdList({ value: value.artifactIds }) &&
      Array.isArray(value.inputAvailability) &&
      isTimestamp({ value: value.createdAt }) &&
      isNullable({ value: value.startedAt, check: isTimestamp }) &&
      isNullable({ value: value.finishedAt, check: isTimestamp })
  })
  const inputAvailability = value.inputAvailability.map((v) => {
    assertContract({
      condition:
        isRecord({ value: v }) &&
        isPositiveId({ value: v.mediaId }) &&
        isPositiveId({ value: v.position }) &&
        ['active', 'unavailable'].includes(v.status)
    })
    return project({
      value: v,
      fields: ['mediaId', 'position', 'status']
    })
  })
  let resolution = null
  if (value.status === 'closed') {
    assertContract({
      condition: isRecord({ value: value.resolution })
    })
    // Only controlled business settlement text is rendered; no provider internals.
    resolution = readResolution({ value: value.resolution })
  } else {
    assertContract({
      condition: value.resolution === null
    })
  }
  return {
    ...task,
    artifactIds: [...value.artifactIds],
    inputAvailability,
    resolution,
    ...project({
      value,
      fields: ['createdAt', 'startedAt', 'finishedAt']
    })
  }
}
function readResolution({ value }) {
  assertContract({
    condition:
      value.reason === 'UNKNOWN_CLOSED' &&
      isTimestamp({ value: value.closedAt }) &&
      isNonnegativeInteger({ value: value.releasedAvailableCredits }) &&
      isNonnegativeInteger({ value: value.releasedExpiredCredits })
  })
  return project({
    value,
    fields: ['reason', 'closedAt', 'releasedAvailableCredits', 'releasedExpiredCredits']
  })
}
export function readArtifact({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      ['id', 'mediaId', 'sessionId', 'taskId', 'outputIndex', 'width', 'height'].every((k) =>
        isPositiveId({ value: value[k] })
      ) &&
      typeof value.isFavorite === 'boolean' &&
      isString({ value: value.mimeType }) &&
      isTimestamp({ value: value.createdAt }) &&
      isNullable({ value: value.savedAt, check: isTimestamp })
  })
  return project({
    value,
    fields: [
      'id',
      'mediaId',
      'sessionId',
      'taskId',
      'outputIndex',
      'width',
      'height',
      'isFavorite',
      'mimeType',
      'createdAt',
      'savedAt'
    ]
  })
}
export function readFavorite({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      typeof value.isFavorite === 'boolean' &&
      isNullable({ value: value.savedAt, check: isTimestamp })
  })
  return project({
    value,
    fields: ['isFavorite', 'savedAt']
  })
}
export function readDraft({ value }) {
  assertContract({
    condition: isRecord({ value }) && isTimestamp({ value: value.updatedAt })
  })
  return {
    input: readInput({ value: value.input }),
    updatedAt: value.updatedAt
  }
}
export function readSession({ value, options: { summary = false, detail = false } = {} }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      !['templateVersionId', 'publishedVersionId', 'versionNo'].some((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      isPositiveId({ value: value.id }) &&
      isPositiveId({ value: value.templateId }) &&
      ['free', 'effect'].includes(value.mode) &&
      isString({ value: value.title }) &&
      ['ai', 'template', 'user'].includes(value.titleSource) &&
      isTimestamp({ value: value.lastActivityAt })
  })
  const session = project({
    value,
    fields: ['id', 'templateId', 'mode', 'title', 'titleSource', 'lastActivityAt']
  })
  if (summary || detail) {
    assertContract({
      condition:
        value.runningTask === null ||
        (isRecord({ value: value.runningTask }) &&
          isPositiveId({ value: value.runningTask.id }) &&
          isPositiveId({ value: value.runningTask.roundNo }) &&
          ['queued', 'running', 'unknown'].includes(value.runningTask.status))
    })
    session.runningTask =
      value.runningTask === null
        ? null
        : project({ value: value.runningTask, fields: ['id', 'roundNo', 'status'] })
    session.cover = value.cover === null ? null : readArtifact({ value: value.cover })
  }
  if (detail) {
    session.draft = readDraft({ value: value.draft })
    if (Object.prototype.hasOwnProperty.call(value, 'creationClientRequestId')) {
      assertContract({
        condition:
          isString({ value: value.creationClientRequestId }) &&
          !!value.creationClientRequestId.trim() &&
          value.creationClientRequestId.length <= 128,
      })
      session.creationClientRequestId = value.creationClientRequestId
    }
  }
  return session
}
export function readRename({ value, binding: { sessionId } }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      value.sessionId === sessionId &&
      isString({ value: value.title }) &&
      ['ai', 'template', 'user'].includes(value.titleSource)
  })
  return project({
    value,
    fields: ['sessionId', 'title', 'titleSource']
  })
}
export function readQuote({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      !['templateVersionId', 'publishedVersionId', 'versionNo'].some((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      isNonnegativeInteger({ value: value.costCredits }) &&
      isPositiveId({ value: value.templateId }) &&
      isString({ value: value.quoteToken }) &&
      !!value.quoteToken &&
      isTimestamp({ value: value.validUntil })
  })
  return project({
    value,
    fields: ['costCredits', 'templateId', 'quoteToken', 'validUntil']
  })
}
export function readTemplate({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      !['templateVersionId', 'publishedVersionId', 'versionNo'].some((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      isPositiveId({ value: value.templateId }) &&
      ['free', 'effect'].includes(value.mode) &&
      isNonnegativeInteger({ value: value.costCredits }) &&
      value.schemaVersion === 1 &&
      isString({ value: value.minClientCapability })
  })
  const s = value.inputSchema
  const d = value.displayConfig
  assertContract({
    condition:
      isRecord({ value: s }) &&
      ['minImages', 'maxImages', 'maxDescriptionLength', 'maxNotesLength'].every((k) =>
        isNonnegativeInteger({ value: s[k] })
      ) &&
      ['maxImageBytes', 'maxTotalImageBytes'].every((k) => isPositiveId({ value: s[k] })) &&
      s.minImages <= s.maxImages &&
      Array.isArray(s.allowedMimeTypes) &&
      s.allowedMimeTypes.length > 0 &&
      s.allowedMimeTypes.every((value) =>
        isString({
          value
        })
      )
  })
  assertContract({
    condition:
      value.mode === 'free'
        ? s.minImages === 0 && s.maxNotesLength === 0 && s.maxDescriptionLength > 0
        : s.minImages >= 1 && s.maxDescriptionLength === 0
  })
  assertContract({
    condition:
      isRecord({ value: d }) &&
      isString({ value: d.name }) &&
      isString({ value: d.description }) &&
      isString({ value: d.photoHint }) &&
      isNullable({
        value: d.coverMediaId,
        check: isPositiveId
      }) &&
      isNullable({
        value: d.categoryId,
        check: isPositiveId
      }) &&
      isNullable({
        value: d.categoryName,
        check: isString
      }) &&
      isIdList({ value: d.tagIds }) &&
      isNullable({
        value: d.primaryTagId,
        check: isPositiveId
      }) &&
      Array.isArray(d.tags) &&
      d.tags.every(
        (t) => isRecord({ value: t }) && isPositiveId({ value: t.id }) && isString({ value: t.name })
      ) &&
      Array.isArray(d.searchAliases) &&
      d.searchAliases.every((value) =>
        isString({
          value
        })
      ) &&
      Array.isArray(d.showcaseShareKeys) && d.showcaseShareKeys.length <= 8 &&
      new Set(d.showcaseShareKeys).size === d.showcaseShareKeys.length &&
      d.showcaseShareKeys.every((key) => typeof key === 'string' && /^[A-Za-z0-9_-]{32}$/.test(key))
  })

  return {
    ...project({
      value,
      fields: [
        'templateId',
        'mode',
        'costCredits',
        'schemaVersion',
        'minClientCapability'
      ]
    }),
    inputSchema: {
      ...project({
        value: s,
        fields: [
          'minImages',
          'maxImages',
          'maxDescriptionLength',
          'maxNotesLength',
          'maxImageBytes',
          'maxTotalImageBytes'
        ]
      }),
      allowedMimeTypes: [...s.allowedMimeTypes]
    },
    displayConfig: {
      ...project({
        value: d,
        fields: [
          'name',
          'description',
          'photoHint',
          'coverMediaId',
          'categoryId',
          'categoryName',
          'primaryTagId'
        ]
      }),
      tagIds: [...d.tagIds],
      tags: d.tags.map((t) =>
        project({
          value: t,
          fields: ['id', 'name']
        })
      ),
      searchAliases: [...d.searchAliases],
      showcaseShareKeys: [...d.showcaseShareKeys]
    }
  }
}
export function readPage({ value, read }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      Array.isArray(value.items) &&
      typeof value.hasMore === 'boolean' &&
      isNullable({ value: value.nextCursor, check: ({ value: v }) => isString({ value: v }) && !!v }) &&
      (value.hasMore ? !!value.nextCursor : value.nextCursor === null)
  })
  return {
    items: value.items.map((value) =>
      read({
        value
      })
    ),
    nextCursor: value.nextCursor,
    hasMore: value.hasMore
  }
}
export function readAccount({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      ['available', 'reserved'].every((k) => isNonnegativeInteger({ value: value[k] })) &&
      typeof value.configured === 'boolean' &&
      Array.isArray(value.sources)
  })
  const sources = value.sources.map((source) => {
    assertContract({
      condition:
        isRecord({ value: source }) &&
        isNonnegativeInteger({ value: source.available }) &&
        ['compensation', 'subscription', 'topup', 'trial'].includes(source.sourceType)
    })
    return project({
      value: source,
      fields: ['available', 'sourceType']
    })
  })
  return {
    ...project({
      value,
      fields: ['available', 'reserved', 'configured']
    }),
    sources
  }
}
export function decode({ data, read, status, requestId, acceptedStatuses }) {
  try {
    if (acceptedStatuses && !acceptedStatuses.includes(status)) throw Error('INVALID_RESPONSE')
    return read({ value: data })
  } catch {
    throw new ApiResponseError({
      code: 'INVALID_RESPONSE',
      status,
      requestId,
      isOutcomeUnknown: true
    })
  }
}

export function readSessionShare({ value, key }) {
  assertContract({ condition: isRecord({ value }) && typeof key === 'string' && /^[A-Za-z0-9_-]{32}$/.test(key) && value.key === key && isString({ value: value.title }) && value.title.length > 0 && value.title.length <= 100 && isPositiveId({ value: value.templateId }) && Array.isArray(value.images) && value.images.length > 0 && value.images.length <= 20 && new Set(value.images.map((image) => image?.id)).size === value.images.length })
  return {
    key,
    title: value.title,
    templateId: value.templateId,
    images: value.images.map((image) => {
      assertContract({ condition: isRecord({ value: image }) && isPositiveId({ value: image.id }) && isPositiveId({ value: image.width }) && isPositiveId({ value: image.height }) && isTimestamp({ value: image.createdAt }) })
      return project({ value: image, fields: ['id', 'width', 'height', 'createdAt'] })
    })
  }
}
