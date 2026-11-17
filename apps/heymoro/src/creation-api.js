import Taro from '@tarojs/taro'

import { apiUrl, authorizationHeaders, createTransportError, parseJsonResponse } from './api'
import { clearToken, getCurrentUser, getStoredSession, getStoredToken, loginWithWechat } from './auth'
import {
  decode,
  readAccount,
  readArtifact,
  readDraft,
  readFavorite,
  readHistory,
  readPage,
  readQuote,
  readRename,
  readSession,
  readSessionShare,
  readTask,
  readTemplate
} from './creation-contract'
import { createFavoriteSettlement } from './features/artifact/favorite-settlement'
import { readCreditLedgerEntry, readCreditReservation } from './features/credits/credits-contract'

const favoriteSettlement = createFavoriteSettlement({ getOwner: getStoredSession })
const sameSession = ({ left, right }) => Boolean(
  left && right && left.userId === right.userId && left.token === right.token &&
  left.expiresAt === right.expiresAt
)

let userFlight
let userEpoch = 0
const images = new Map()
export function invalidateCreationUser() {
  userEpoch++
  userFlight = null
}
export async function ensureCreationUser() {
  const session = getStoredSession()
  const key = session ? `${session.token}:${session.expiresAt}:${session.userId}` : ''
  if (userFlight && userFlight.key === key && userFlight.epoch === userEpoch) return userFlight.promise
  const flight = {
    key,
    epoch: userEpoch
  }
  flight.promise = (async () => {
    const user = session ? await getCurrentUser() : await loginWithWechat()
    const current = getStoredSession()
    if (
      flight.epoch !== userEpoch ||
      !current ||
      user?.id !== current.userId ||
      (session && current.token !== session.token)
    ) {
      throw Error('AUTH_REQUIRED')
    }
    return user
  })()
  userFlight = flight
  try {
    return await flight.promise
  } finally {
    if (userFlight === flight) userFlight = null
  }
}
async function request({ path, method = 'GET', data, read, publicRead = false, acceptedStatuses }) {
  const session = publicRead ? null : getStoredSession()
  const requireSession = () => {
    if (!publicRead && !sameSession({ left: session, right: getStoredSession() })) {
      throw Error('AUTH_REQUIRED')
    }
  }
  requireSession()
  const token = session?.token
  const header = publicRead
    ? {}
    : authorizationHeaders({
      token,
      json: data !== undefined
    })
  let response
  try {
    response = await Taro.request({
      url: apiUrl(path),
      method,
      data,
      timeout: 15000,
      header
    })
  } catch {
    requireSession()
    throw createTransportError()
  }
  requireSession()
  if (!publicRead && response?.statusCode === 401) {
    clearToken()
    invalidateCreationUser()
  }
  const body = parseJsonResponse(response)
  return decode({
    data: body?.data,
    status: response?.statusCode,
    requestId: body?.requestId,
    acceptedStatuses,
    read
  })
}
const query = (values = {}) => {
  const pairs = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}
export const creationApi = {
  creditLedger: ({ cursor } = {}) =>
    request({
      path: `/credits/ledger${query({ cursor })}`,
      acceptedStatuses: [200],
      read: ({ value }) => readPage({ value, read: readCreditLedgerEntry })
    }),
  creditReservations: ({ cursor } = {}) =>
    request({
      path: `/credits/reservations${query({ cursor })}`,
      acceptedStatuses: [200],
      read: ({ value }) => readPage({ value, read: readCreditReservation })
    }),
  account: () =>
    request({
      path: '/creation-account',
      read: readAccount
    }),
  templates: ({ cursor, categoryId, keyword } = {}) =>
    request({
      path: `/templates${query({
        cursor,
        categoryId,
        keyword
      })}`,
      publicRead: true,
      read: ({ value: data }) =>
        readPage({
          value: data,
          read: readTemplate
        })
    }),
  sessionShare: ({ key }) => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(key)) return Promise.reject(Error('INVALID_RESPONSE'))
    return request({ path: `/session-shares/${key}`, publicRead: true, acceptedStatuses: [200], read: ({ value }) => readSessionShare({ value, key }) })
  },
  taxonomy: () =>
    request({
      path: '/template-taxonomies',
      publicRead: true,
      read: ({ value: data }) => {
        if (!data || !Array.isArray(data.categories) || !Array.isArray(data.labels)) {
          throw Error('INVALID_RESPONSE')
        }
        const terms = (rows) =>
          rows.map(({ id, name }) => {
            if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== 'string') {
              throw Error('INVALID_RESPONSE')
            }
            return {
              id,
              name
            }
          })
        return {
          categories: terms(data.categories),
          labels: terms(data.labels)
        }
      }
    }),
  template: ({ templateId }) =>
    request({
      path: `/templates/${templateId}`,
      publicRead: true,
      read: ({ value: data }) => {
        const template = readTemplate({
          value: data
        })
        if (
          template.mode !== 'effect' ||
          template.templateId !== templateId
        ) {
          throw Error('INVALID_RESPONSE')
        }
        return template
      }
    }),
  freePreset: () =>
    request({
      path: '/creation-presets/free',
      publicRead: true,
      read: ({ value }) => {
        const preset = readTemplate({ value })
        if (preset.mode !== 'free') throw Error('INVALID_RESPONSE')
        return preset
      }
    }),
  createSession: ({ templateId, clientRequestId }) =>
    request({
      path: '/creation-sessions',
      method: 'POST',
      acceptedStatuses: [200, 201],
      data: {
        templateId,
        clientRequestId
      },
      read: ({ value: data }) => {
        const session = readSession({
          value: data
        })
        if (session.templateId !== templateId) {
          throw Error('INVALID_RESPONSE')
        }
        return session
      }
    }),
  sessions: ({ cursor } = {}) =>
    request({
      path: `/creation-sessions${query({
        cursor
      })}`,
      read: ({ value: data }) =>
        readPage({
          value: data,
          read: ({ value }) =>
            readSession({
              value: value,
              options: {
                summary: true
              }
            })
        })
    }),
  getSession: ({ sessionId }) =>
    request({
      path: `/creation-sessions/${sessionId}`,
      read: ({ value: data }) => {
        const session = readSession({
          value: data,
          options: {
            detail: true
          }
        })
        if (session.id !== sessionId) throw Error('INVALID_RESPONSE')
        return session
      }
    }),
  rename: ({ sessionId, title }) =>
    request({
      path: `/creation-sessions/${sessionId}`,
      method: 'PATCH',
      data: {
        title
      },
      read: ({ value: data }) =>
        readRename({
          value: data,
          binding: {
            sessionId
          }
        })
    }),
  getDraft: ({ sessionId }) =>
    request({
      path: `/creation-sessions/${sessionId}/draft`,
      read: readDraft
    }),
  putDraft: ({ sessionId, input }) =>
    request({
      path: `/creation-sessions/${sessionId}/draft`,
      method: 'PUT',
      data: input,
      read: readDraft
    }),
  quote: ({ sessionId, input, sourceArtifactId }) =>
    request({
      path: '/generation-quotes',
      method: 'POST',
      data: sourceArtifactId
        ? {
          sourceArtifactId
        }
        : {
          sessionId,
          input
        },
      read: readQuote
    }),
  generate: ({ sessionId, input, clientRequestId, quoteToken }) =>
    request({
      path: '/generations',
      method: 'POST',
      acceptedStatuses: [200, 201],
      data: {
        sessionId,
        input,
        clientRequestId,
        quoteToken
      },
      read: ({ value: data }) =>
        readTask({
          value: data,
          binding: {
            sessionId,
            input,
            clientRequestId,
            generate: true
          }
        })
    }),
  regenerate: ({ sourceArtifactId, sessionId, clientRequestId, quoteToken }) =>
    request({
      path: `/artifacts/${sourceArtifactId}/regenerations`,
      method: 'POST',
      acceptedStatuses: [200, 201],
      data: {
        clientRequestId,
        quoteToken
      },
      read: ({ value: data }) =>
        readTask({
          value: data,
          binding: {
            sessionId,
            clientRequestId,
            regenerate: true
          }
        })
    }),
  task: ({ taskId }) =>
    request({
      path: `/generations/${taskId}`,
      read: ({ value: data }) => {
        const task = readHistory({
          value: data
        })
        if (task.id !== taskId) throw Error('INVALID_RESPONSE')
        return task
      }
    }),
  tasks: ({ sessionId, cursor }) =>
    request({
      path: `/creation-sessions/${sessionId}/generations${query({
        cursor
      })}`,
      read: ({ value: data }) =>
        readPage({
          value: data,
          read: ({ value }) =>
            readHistory({
              value: value,
              binding: {
                sessionId
              }
            })
        })
    }),
  artifacts: ({ cursor, saved = false, isInterested, onWarning } = {}) =>
    favoriteSettlement.read({
      owner: getStoredSession(),
      isInterested,
      onWarning,
      execute: () => request({
        path: `/artifacts${query({
          cursor,
          saved
        })}`,
        read: ({ value: data }) =>
          readPage({
            value: data,
            read: readArtifact
          })
      })
    }),
  artifact: ({ artifactId, isInterested, onWarning }) =>
    favoriteSettlement.read({
      owner: getStoredSession(),
      artifactId,
      isInterested,
      onWarning,
      execute: () => request({
        path: `/artifacts/${artifactId}`,
        read: ({ value: data }) => {
          const artifact = readArtifact({
            value: data
          })
          if (artifact.id !== artifactId) throw Error('INVALID_RESPONSE')
          return artifact
        }
      })
    }),
  favorite: ({ artifactId, isFavorite }) =>
    favoriteSettlement.write({
      owner: getStoredSession(),
      artifactId,
      execute: () => request({
        path: `/artifacts/${artifactId}/favorite`,
        method: isFavorite ? 'PUT' : 'DELETE',
        read: readFavorite
      })
    })
}
export const officialImage = ({ mediaId }) => apiUrl(`/media/examples/${mediaId}/content`)
export function invalidatePrivateImage(id) {
  images.delete(`${getStoredToken()}:${id}`)
}
export async function privateImage(id) {
  if (!id) throw Error('FILE_NOT_FOUND')
  const token = getStoredToken()
  const key = `${token}:${id}`
  if (images.has(key)) return images.get(key)
  const download = (async () => {
    const result = await Taro.downloadFile({
      url: apiUrl(`/media/${id}/content`),
      header: authorizationHeaders({
        token
      }),
      timeout: 30000
    })
    if (token !== getStoredToken()) throw Error('AUTH_REQUIRED')
    if (result.statusCode !== 200 || !result.tempFilePath) throw Error('MEDIA_DOWNLOAD_FAILED')
    return result.tempFilePath
  })()
  images.set(key, download)
  try {
    return await download
  } catch (error) {
    if (images.get(key) === download) images.delete(key)
    throw error
  }
}

export const sharedSessionImage = ({ key, artifactId }) => /^[A-Za-z0-9_-]{32}$/.test(key) && Number.isSafeInteger(artifactId) && artifactId > 0 ? apiUrl(`/session-shares/${key}/images/${artifactId}`) : ''
export const sharedSessionCover = ({ key }) => typeof key === 'string' && /^[A-Za-z0-9_-]{32}$/.test(key) ? apiUrl(`/session-shares/${key}/cover`) : ''
