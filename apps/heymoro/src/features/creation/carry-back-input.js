const positiveId = ({ value }) => Number.isSafeInteger(value) && value > 0

/** A freshly read Task, not an admission receipt or cached round, owns this snapshot. */
export function readCarryBackSource({ task, taskId, sessionId }) {
  const input = task?.input
  const ids = input?.inputMediaIds
  if (
    !positiveId({ value: taskId }) ||
    !positiveId({ value: sessionId }) ||
    task?.id !== taskId ||
    task.sessionId !== sessionId ||
    !Array.isArray(ids) ||
    Reflect.ownKeys(ids).length !== ids.length + 1 ||
    ids.some((value) => !positiveId({ value })) ||
    new Set(ids).size !== ids.length ||
    typeof input.description !== 'string' ||
    typeof input.userNotes !== 'string' ||
    !Array.isArray(task.inputAvailability) ||
    task.inputAvailability.length !== ids.length ||
    Reflect.ownKeys(task.inputAvailability).length !== task.inputAvailability.length + 1 ||
    task.inputAvailability.some(
      (slot, index) =>
        !slot ||
        slot.mediaId !== ids[index] ||
        slot.position !== index + 1 ||
        !['active', 'unavailable'].includes(slot.status)
    )
  ) {
    throw Error('INVALID_RESPONSE')
  }
  return {
    // The selected Task.id, never its regeneration predecessor TaskDTO.sourceTaskId.
    carryBackSourceTaskId: task.id,
    description: input.description,
    userNotes: input.userNotes,
    photos: task.inputAvailability.map((slot) => ({
      id: `media:${slot.mediaId}`,
      mediaId: slot.mediaId,
      path: '',
      status: slot.status === 'active' ? 'ready' : 'unavailable'
    }))
  }
}

/** Protocol 2 predates carry-back: normal records need no provenance field. */
export function hasCarryBackSource({ photos, carryBackSourceTaskId, sessionId }) {
  if (
    carryBackSourceTaskId != null &&
    (!positiveId({ value: carryBackSourceTaskId }) || !positiveId({ value: sessionId }))
  ) {
    return false
  }
  return photos.every(
    (slot) =>
      slot.status !== 'unavailable' ||
      (positiveId({ value: carryBackSourceTaskId }) &&
        positiveId({ value: slot.mediaId }) &&
        slot.id === `media:${slot.mediaId}` &&
        slot.size === undefined &&
        slot.mimeType === undefined &&
        !slot.path)
  )
}

/** Both UI entry intents use this stateless confirmation sequence. */
export async function coordinateCarryBackInput({
  intent,
  prepare,
  showConfirmation,
  confirm,
  cancel
}) {
  const candidate = await prepare(intent)
  if (!candidate) return false
  try {
    const missing = candidate.photos.some((photo) => photo.status === 'unavailable')
    const result = await showConfirmation({
      title: '带回本轮输入？',
      content: `确认后将替换当前草稿，不会自动生成。${
        missing ? '部分照片已失效，需补选或明确移除后再生成。' : ''
      }`,
      confirmText: '确认带回',
      cancelText: '取消'
    })
    if (result?.confirm === true) return await confirm({ candidate })
  } catch {
    // A dismissed or failed native confirmation never applies the candidate.
  }
  cancel({ candidate })
  return false
}
