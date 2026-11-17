import Taro from '@tarojs/taro'

import { ApiResponseError, apiUrl, authorizationHeaders, createTransportError, parseJsonResponse } from './api'

const TOKEN_KEY = 'heymoro.user.token'
let generation = 0
let loginFlight

function hasFields({ value, fields }) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
}

function isToken({ value }) {
  // 32 bytes: the final base64url sextet has exactly two zero padding bits.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)
}

function isExpiry({ value }) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function readCredential({ allowExpired = false } = {}) {
  const value = Taro.getStorageSync(TOKEN_KEY)
  if (!hasFields({ value, fields: ['token', 'expiresAt', 'userId'] }) || !isToken({ value: value.token }) || !isExpiry({ value: value.expiresAt }) ||
    !Number.isSafeInteger(value.userId) || value.userId <= 0 || (!allowExpired && Date.parse(value.expiresAt) <= Date.now())) return null
  return Object.freeze({ token: value.token, expiresAt: value.expiresAt, userId: value.userId })
}

export function getStoredSession() {
  return readCredential()
}

export function getStoredToken() {
  return getStoredSession()?.token || ''
}

function snapshot() {
  return { generation, stored: JSON.stringify(Taro.getStorageSync(TOKEN_KEY)) }
}

function isCurrent({ start }) {
  return start.generation === generation && start.stored === JSON.stringify(Taro.getStorageSync(TOKEN_KEY))
}

function requireCurrent({ start }) {
  if (!isCurrent({ start })) throw new Error('AUTH_REQUIRED')
}

export function clearToken() {
  generation++
  Taro.removeStorageSync(TOKEN_KEY)
}

function parseIdentityResponse({ response }) {
  try { return parseJsonResponse(response) } catch (error) {
    // The shared parser can reject an envelope before extracting its trace.
    if (error instanceof ApiResponseError && !error.requestId) {
      let body = response?.data
      if (typeof body === 'string') {
        try { body = JSON.parse(body) } catch { body = null }
      }
      if (typeof body?.requestId === 'string' && body.requestId) error.requestId = body.requestId
    }
    throw error
  }
}

function invalidResponse({ response, body }) {
  return new ApiResponseError({
    code: 'INVALID_RESPONSE', status: response?.statusCode, requestId: typeof body?.requestId === 'string' && body.requestId ? body.requestId : null, isOutcomeUnknown: true,
  })
}

function readUser({ response, body, userId }) {
  const user = body?.data
  if (!hasFields({ value: user, fields: ['id', 'displayName', 'avatarUrl', 'status'] }) || !Number.isSafeInteger(user.id) || user.id <= 0 ||
    (userId !== undefined && user.id !== userId) || user.status !== 'active' ||
    typeof user.displayName !== 'string' || !user.displayName.trim() || user.displayName.length > 80 ||
    (user.avatarUrl !== null && typeof user.avatarUrl !== 'string')) throw invalidResponse({ response, body })
  return user
}

async function send({ start, path, method, data, token }) {
  const header = token ? authorizationHeaders({ token, json: data !== undefined }) : { 'content-type': 'application/json' }
  let response
  try {
    response = await Taro.request({
      url: apiUrl(path),
      method,
      ...(data === undefined ? {} : { data }),
      timeout: 15000,
      header,
    })
  } catch {
    requireCurrent({ start })
    throw createTransportError()
  }
  return response
}

export async function loginWithWechat() {
  const start = snapshot()
  if (loginFlight && isCurrent({ start: loginFlight.start })) return loginFlight.promise
  const flight = { start }
  flight.promise = (async () => {
    let login
    try { login = await Taro.login() } catch {
      requireCurrent({ start })
      throw createTransportError()
    }
    requireCurrent({ start })
    if (typeof login?.code !== 'string' || !login.code.trim()) throw new Error('微信登录凭证为空')
    const response = await send({ start, path: '/auth/wechat', method: 'POST', data: { code: login.code } })
    requireCurrent({ start })
    const body = parseIdentityResponse({ response })
    const data = body?.data
    if (response.statusCode !== 201 || !hasFields({ value: data, fields: ['token', 'expiresAt', 'user'] }) ||
      !isToken({ value: data.token }) || !isExpiry({ value: data.expiresAt }) || Date.parse(data.expiresAt) <= Date.now()) throw invalidResponse({ response, body })
    const user = readUser({ response, body: { ...body, data: data.user } })
    Taro.setStorageSync(TOKEN_KEY, { token: data.token, expiresAt: data.expiresAt, userId: user.id })
    generation++
    return user
  })()
  loginFlight = flight
  try { return await flight.promise } finally { if (loginFlight === flight) loginFlight = null }
}

async function requestUser({ method, data }) {
  const start = snapshot()
  const session = getStoredSession()
  if (!session) {
    if (method === 'GET') return null
    throw new Error('AUTH_REQUIRED')
  }
  const response = await send({ start, path: '/me', method, data, token: session.token })
  requireCurrent({ start })
  // Expiry while in flight also makes a user result unusable, but retains its revocable record.
  if (!getStoredSession()) throw new Error('AUTH_REQUIRED')
  if (response?.statusCode === 401) clearToken()
  const body = parseIdentityResponse({ response })
  if (response.statusCode !== 200) throw invalidResponse({ response, body })
  return readUser({ response, body, userId: session.userId })
}

export function getCurrentUser() {
  return requestUser({ method: 'GET' })
}

export function updateCurrentUser(input) {
  return requestUser({ method: 'PATCH', data: { displayName: input.displayName } })
}

export async function logout() {
  // Invalidate even a credential-less login, and retain the record on revocation failure.
  generation++
  const start = snapshot()
  const session = readCredential({ allowExpired: true })
  if (!session) return
  const response = await send({ start, path: '/auth/logout', method: 'POST', token: session.token })
  const body = parseIdentityResponse({ response })
  if (response.statusCode !== 204) throw invalidResponse({ response, body })
  if (isCurrent({ start })) clearToken()
}
