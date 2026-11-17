/** Raw text and ordered media identity are the request contract, never a generated prompt. */
export function creationInput({ description = '', userNotes = '', photos = [] }) {
  return {
    inputMediaIds: photos.filter((p) => p.status === undefined || p.status === 'ready').map((p) => p.mediaId),
    description,
    userNotes
  }
}
export function validateInput({ input, mode, schema, draft = false }) {
  if (
    !Array.isArray(input.inputMediaIds) ||
    input.inputMediaIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(input.inputMediaIds).size !== input.inputMediaIds.length
  ) {
    return '照片记录有重复或已失效，请检查后重试'
  }
  if (!schema || !['free', 'effect'].includes(mode)) return '当前玩法配置暂不可用，输入已保留'
  if (
    input.description.length > schema.maxDescriptionLength ||
    input.userNotes.length > schema.maxNotesLength
  ) {
    return '输入超过当前玩法字数上限'
  }
  if (mode === 'free' ? input.userNotes !== '' : input.description !== '') return '输入与当前玩法不匹配'
  if (input.inputMediaIds.length > schema.maxImages) return `最多添加 ${schema.maxImages} 张照片`
  if (!draft && input.inputMediaIds.length < schema.minImages) return '先添加自己的照片，就可以生成了'
  if (!draft && mode === 'free' && !input.description.trim()) return '先写下你想生成的画面'
  return ''
}
export function validatePhotos({ photos, schema }) {
  if (!schema) return '当前玩法配置暂不可用'
  if (photos.length > schema.maxImages) return `最多添加 ${schema.maxImages} 张照片`
  // Remote draft slots have trusted media identity but no client file metadata. Do not invent bytes/MIME.
  const knownFiles = photos.filter(
    (photo) =>
      !(
        ['ready', 'unavailable'].includes(photo.status) &&
        Number.isSafeInteger(photo.mediaId) &&
        photo.mediaId > 0 &&
        photo.size === undefined &&
        photo.mimeType === undefined
      )
  )
  if (knownFiles.some((photo) => !schema.allowedMimeTypes.includes(photo.mimeType))) {
    return '请选择当前玩法支持的 JPG 或 PNG 照片'
  }
  if (
    knownFiles.some(
      (photo) => !Number.isFinite(photo.size) || photo.size <= 0 || photo.size > schema.maxImageBytes
    )
  ) {
    return '单张照片超过当前玩法大小上限'
  }
  if (knownFiles.reduce((bytes, photo) => bytes + photo.size, 0) > schema.maxTotalImageBytes) {
    return '这组照片超过当前玩法总大小上限'
  }
  // Quote and submit validate the authoritative bytes for every ID, including remote-only slots.
  return ''
}

const isPositiveId = ({ value }) => Number.isSafeInteger(value) && value > 0
const isString = ({ value }) => typeof value === 'string'
const isRecord = ({ value }) => !!value && typeof value === 'object' && !Array.isArray(value)
const isIdList = ({ value }) =>
  Array.isArray(value) &&
  value.every((value) =>
    isPositiveId({
      value
    })
  ) &&
  new Set(value).size === value.length
function assertContract({ condition }) {
  if (!condition) throw Error('INVALID_RESPONSE')
}
export function readInput({ value }) {
  assertContract({
    condition:
      isRecord({ value }) &&
      isIdList({ value: value.inputMediaIds }) &&
      isString({ value: value.description }) &&
      isString({ value: value.userNotes })
  })
  return {
    inputMediaIds: [...value.inputMediaIds],
    description: value.description,
    userNotes: value.userNotes
  }
}
