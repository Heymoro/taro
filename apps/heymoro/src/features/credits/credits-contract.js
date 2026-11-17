const isRecord = ({ value }) => !!value && typeof value === 'object' && !Array.isArray(value)
const isId = ({ value }) => Number.isSafeInteger(value) && value > 0
const isAmount = ({ value }) => Number.isSafeInteger(value) && value >= 0
const isTimestamp = ({ value }) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

export function readCreditLedgerEntry({ value }) {
  if (!isRecord({ value })) throw Error('INVALID_RESPONSE')
  const {
    id,
    operation,
    ledgerDelta,
    statusCredits,
    sourceType,
    createdAt,
    reservationId,
    taskId,
    availableDelta,
    reservedDelta,
    expiredDelta,
  } = value
  const taskOperation = ['reserve', 'capture', 'release'].includes(operation)
  if (
    !isId({ value: id }) ||
    !['grant', 'compensate', 'reserve', 'capture', 'release', 'expire'].includes(operation) ||
    !['trial', 'subscription', 'topup', 'compensation'].includes(sourceType) ||
    !isTimestamp({ value: createdAt }) ||
    ![ledgerDelta, availableDelta, reservedDelta].every(Number.isSafeInteger) ||
    !isAmount({ value: expiredDelta }) ||
    !Number.isSafeInteger(availableDelta + reservedDelta) ||
    ledgerDelta !== availableDelta + reservedDelta ||
    (taskOperation
      ? !isId({ value: taskId }) || !isId({ value: reservationId })
      : taskId !== null || reservationId !== null) ||
    (['reserve', 'release'].includes(operation) ? !isAmount({ value: statusCredits }) : statusCredits !== null)
  ) {
    throw Error('INVALID_RESPONSE')
  }

  let consistent = false
  switch (operation) {
    case 'reserve':
      consistent =
        ledgerDelta === 0 && availableDelta === -statusCredits && reservedDelta === statusCredits && expiredDelta === 0
      break
    case 'capture':
      consistent = availableDelta === 0 && reservedDelta <= 0 && expiredDelta === 0 && ledgerDelta === reservedDelta
      break
    case 'release':
      consistent =
        reservedDelta === -statusCredits &&
        availableDelta >= 0 &&
        Number.isSafeInteger(availableDelta + expiredDelta) &&
        availableDelta + expiredDelta === statusCredits &&
        ledgerDelta === -expiredDelta
      break
    case 'grant':
    case 'compensate':
      consistent =
        (operation === 'compensate') === (sourceType === 'compensation') &&
        availableDelta === ledgerDelta &&
        ledgerDelta >= 0 &&
        reservedDelta === 0 &&
        expiredDelta === 0
      break
    case 'expire':
      consistent =
        availableDelta === ledgerDelta && ledgerDelta <= 0 && reservedDelta === 0 && expiredDelta === -ledgerDelta
      break
  }
  if (!consistent) throw Error('INVALID_RESPONSE')
  return {
    id,
    operation,
    ledgerDelta,
    statusCredits,
    sourceType,
    createdAt,
    reservationId,
    taskId,
    availableDelta,
    reservedDelta,
    expiredDelta,
  }
}

export function readCreditReservation({ value }) {
  if (!isRecord({ value })) throw Error('INVALID_RESPONSE')
  const { reservationId, taskId, sessionId, roundNo, reservedCredits, taskStatus, reviewHint } = value
  if (
    ![reservationId, taskId, sessionId, roundNo].every((value) => isId({ value })) ||
    !isAmount({ value: reservedCredits }) ||
    !['queued', 'running', 'unknown'].includes(taskStatus) ||
    (reviewHint !== null && reviewHint !== 'PENDING_REVIEW') ||
    (taskStatus === 'unknown' && reviewHint !== 'PENDING_REVIEW')
  ) {
    throw Error('INVALID_RESPONSE')
  }
  return { reservationId, taskId, sessionId, roundNo, reservedCredits, taskStatus, reviewHint }
}
