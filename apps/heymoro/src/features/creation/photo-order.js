/** Slot identity, not upload metadata, is the ordering concurrency contract. */
export function orderedPhotoIds({ photos }) {
  if (!Array.isArray(photos)) return null
  const ids = []
  for (let index = 0; index < photos.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(photos, index)) return null
    const id = photos[index]?.id
    if (typeof id !== 'string' || !id || ids.includes(id)) return null
    ids.push(id)
  }
  return ids
}

export function samePhotoIds({ left, right }) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const seen = new Set()
  for (let index = 0; index < left.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(left, index) ||
      !Object.prototype.hasOwnProperty.call(right, index) ||
      typeof left[index] !== 'string' ||
      !left[index] ||
      seen.has(left[index]) ||
      left[index] !== right[index]
    ) {
      return false
    }
    seen.add(left[index])
  }
  return true
}

export function movePhotoSlot({ photos, slotId, targetIndex, expectedIds }) {
  const ids = orderedPhotoIds({ photos })
  if (!ids || !samePhotoIds({ left: expectedIds, right: ids })) return null
  const sourceIndex = ids.indexOf(slotId)
  if (
    sourceIndex < 0 ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= ids.length ||
    sourceIndex === targetIndex
  ) {
    return null
  }
  const next = [...photos]
  next.splice(targetIndex, 0, next.splice(sourceIndex, 1)[0])
  return next
}
