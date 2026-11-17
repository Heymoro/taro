import Taro from '@tarojs/taro'

import { apiUrl, authorizationHeaders, parseJsonResponse } from './api'
import { getStoredToken } from './auth'

export async function listRecords({ page = 1, limit = 20 } = {}) {
  const response = await Taro.request({
    url: apiUrl(`/records?page=${page}&limit=${limit}`),
    method: 'GET',
    header: authorizationHeaders({ token: getStoredToken(), json: true }),
  })
  return parseJsonResponse(response).data
}

export async function createRecord(input) {
  const response = await Taro.request({
    url: apiUrl('/records'),
    method: 'POST',
    data: input,
    header: authorizationHeaders({ token: getStoredToken(), json: true }),
  })
  return parseJsonResponse(response).data
}

export async function deleteRecord(id) {
  const response = await Taro.request({
    url: apiUrl(`/records/${id}`),
    method: 'DELETE',
    header: authorizationHeaders({ token: getStoredToken(), json: true }),
  })
  if (response.statusCode !== 204) parseJsonResponse(response)
}

export async function getRecord(id) {
  const response = await Taro.request({ url: apiUrl(`/records/${id}`), method: 'GET', header: authorizationHeaders({ token: getStoredToken(), json: true }) })
  return parseJsonResponse(response).data
}

export async function updateRecord(id, input) {
  const response = await Taro.request({ url: apiUrl(`/records/${id}`), method: 'PATCH', data: input, header: authorizationHeaders({ token: getStoredToken(), json: true }) })
  return parseJsonResponse(response).data
}
