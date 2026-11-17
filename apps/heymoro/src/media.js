import Taro from '@tarojs/taro'

import { apiUrl, authorizationHeaders, parseJsonResponse } from './api'
import { getStoredToken } from './auth'

const MEDIA_MAX_BYTES = 10 * 1024 * 1024

export async function chooseUploadFile() {
  try {
    const result = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: ['jpg', 'jpeg', 'png', 'pdf'] })
    const file = result.tempFiles?.[0]
    if (!file?.path) return null
    if (file.size > MEDIA_MAX_BYTES) throw new Error('FILE_TOO_LARGE')
    return file
  } catch (error) {
    if (error?.errMsg?.includes('cancel')) return null
    throw error
  }
}

export function uploadErrorMessage(error) {
  switch (error?.message) {
    case 'FILE_TOO_LARGE': return '文件不能超过 10 MB'
    case 'FILE_TYPE_NOT_ALLOWED':
    case 'FILE_SIGNATURE_INVALID': return '文件类型或内容无效，请选择 JPG、PNG 或 PDF'
    case 'AUTH_REQUIRED': return '请先登录或重新登录后重试'
    default: return '上传失败，请稍后重试'
  }
}

export async function listMedia({ page = 1, limit = 20 } = {}) {
  const response = await Taro.request({
    url: apiUrl(`/media?page=${page}&limit=${limit}`),
    method: 'GET',
    header: authorizationHeaders({ token: getStoredToken() }),
  })
  return parseJsonResponse(response).data
}

export async function getMedia(id) {
  const response = await Taro.request({
    url: apiUrl(`/media/${id}`),
    method: 'GET',
    header: authorizationHeaders({ token: getStoredToken() }),
  })
  return parseJsonResponse(response).data
}

export async function uploadMedia(filePath) {
  const response = await Taro.uploadFile({
    url: apiUrl('/media'),
    filePath,
    name: 'file',
    header: authorizationHeaders({ token: getStoredToken() }),
  })
  const body = parseJsonResponse(response)
  if (!body?.data?.id) throw new Error('INVALID_RESPONSE')
  return body.data
}

export async function deleteMedia(id) {
  const response = await Taro.request({
    url: apiUrl(`/media/${id}`),
    method: 'DELETE',
    header: authorizationHeaders({ token: getStoredToken() }),
  })
  parseJsonResponse(response)
}

export async function openMedia(item) {
  const token = getStoredToken()
  const response = await Taro.downloadFile({
    url: apiUrl(`/media/${item.id}/content`),
    header: authorizationHeaders({ token: getStoredToken() }),
  })
  if (getStoredToken() !== token) throw new Error('AUTH_REQUIRED')
  if (response.statusCode !== 200 || !response.tempFilePath) throw new Error('MEDIA_DOWNLOAD_FAILED')
  if (item.mimeType?.startsWith('image/')) {
    await Taro.previewImage({ current: response.tempFilePath, urls: [response.tempFilePath] })
  } else {
    await Taro.openDocument({ filePath: response.tempFilePath, fileType: 'pdf', showMenu: true })
  }
}
