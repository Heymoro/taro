const API_BASE_URL = (process.env.TARO_APP_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')

export function apiUrl(path) {
  return `${API_BASE_URL}/api/v1${path.startsWith('/') ? path : `/${path}`}`
}

export function authorizationHeaders({ token, json = false }) {
  if (!token) throw new Error('AUTH_REQUIRED')
  return { Authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }
}

export function parseJsonResponse(response) {
  const status = response?.statusCode
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new ApiResponseError({ code: 'INVALID_RESPONSE', isOutcomeUnknown: true })
  }
  let data = response.data
  if (response.statusCode !== 204 && typeof data === 'string') {
    try { data = JSON.parse(data) } catch {
      throw new ApiResponseError({ code: 'INVALID_RESPONSE', status, isOutcomeUnknown: true })
    }
  }
  if (status === 204) return data
  if (status >= 200 && status < 300) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, 'data')) {
      throw new ApiResponseError({ code: 'INVALID_RESPONSE', status, isOutcomeUnknown: true })
    }
    return data
  }
  const error = data?.error
  const code = typeof error?.code === 'string' && error.code ? error.code : 'REQUEST_FAILED'
  const serverMessage = typeof error?.message === 'string' ? error.message : null
  const requestId = typeof data?.requestId === 'string' && data.requestId ? data.requestId : null
  const isContract = code !== 'REQUEST_FAILED' && serverMessage !== null && typeof error?.retryable === 'boolean' && requestId !== null
  throw new ApiResponseError({
    code,
    serverMessage,
    retryable: isContract ? error.retryable : false,
    status,
    requestId,
    isOutcomeUnknown: !isContract || code === 'OPERATION_OUTCOME_UNKNOWN',
  })
}

export function createTransportError() {
  return new ApiResponseError({ code: 'REQUEST_OUTCOME_UNKNOWN', isOutcomeUnknown: true })
}

/** Keep the historical code-based message; user-facing service text is a separate field. */
export class ApiResponseError extends Error {
  constructor({ code, serverMessage = null, retryable = false, status = null, requestId = null, isOutcomeUnknown = false }) {
    super(code)
    this.name = 'ApiResponseError'
    this.code = code
    this.serverMessage = serverMessage
    this.retryable = retryable
    this.status = status
    this.requestId = requestId
    this.isOutcomeUnknown = isOutcomeUnknown
  }
}
