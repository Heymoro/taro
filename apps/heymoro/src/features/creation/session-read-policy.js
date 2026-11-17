/** Session evidence is accepted only by the workflow's matching getSession boundary. */
export function isFormalSessionNotFound(error) {
  try {
    return error?.status === 404 && error?.code === 'NOT_FOUND' &&
      error?.isOutcomeUnknown === false &&
      typeof error?.requestId === 'string' && error.requestId.trim().length > 0 &&
      typeof error?.retryable === 'boolean'
  } catch {
    return false
  }
}

export const initialSessionAvailability = () => Object.freeze({
  status: 'unchecked', sessionId: null, terminalEpoch: 0, evidence: null
})

export const isUnavailableSession = ({ availability, sessionId }) =>
  availability.status === 'unavailable' && availability.sessionId === sessionId

export const sameTerminalInterest = ({ capturedEpoch, availability }) =>
  capturedEpoch === availability.terminalEpoch

export function sessionAvailable({ availability, sessionId }) {
  if (availability.status === 'available' && availability.sessionId === sessionId) return availability
  return Object.freeze({ status: 'available', sessionId, terminalEpoch: availability.terminalEpoch, evidence: null })
}

export function sessionUnavailable({ availability, sessionId, error }) {
  if (isUnavailableSession({ availability, sessionId })) return availability
  return Object.freeze({
    status: 'unavailable',
    sessionId,
    terminalEpoch: availability.terminalEpoch + 1,
    evidence: Object.freeze({ status: 404, code: 'NOT_FOUND', requestId: error.requestId, retryable: error.retryable })
  })
}

export const SESSION_UNAVAILABLE_MESSAGE = '原创作当前不可读取。此次结果不代表原请求未受理或未扣费。'
