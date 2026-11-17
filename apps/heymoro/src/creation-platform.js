import Taro from '@tarojs/taro'

import { privateImage } from './creation-api'
import { uploadMedia } from './media'

export function requestKey() {
  return `wx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`
}

export const photoPlatform = {
  choose: async (count) => {
    try {
      if (Taro.canIUse?.('requirePrivacyAuthorize')) await Taro.requirePrivacyAuthorize()
      const response = await Taro.chooseMedia({
        count,
        mediaType: ['image'],
        sourceType: ['album'],
        sizeType: ['compressed']
      })
      return await Promise.all(
        (response.tempFiles || []).map(async (file) => {
          const image = await Taro.getImageInfo({ src: file.tempFilePath })
          const type = image.type?.toLowerCase()
          return {
            path: file.tempFilePath,
            size: file.size,
            mimeType: ['jpg', 'jpeg'].includes(type)
              ? 'image/jpeg'
              : type === 'png'
                ? 'image/png'
                : `image/${type || 'unknown'}`,
            name: `照片-${Date.now()}.${type === 'png' ? 'png' : 'jpg'}`
          }
        })
      )
    } catch (error) {
      if (error?.errMsg?.includes('cancel')) return []
      throw error
    }
  },
  upload: uploadMedia,
  preview: privateImage,
  exists: (path) =>
    new Promise((resolve) =>
      Taro.getFileSystemManager().access({ path, success: () => resolve(true), fail: () => resolve(false) })
    )
}

export function accountStorage(userId) {
  const namespace = `heymoro.creation.v1:${userId}:`
  function nativeKeys() {
    const keys = Taro.getStorageInfoSync()?.keys
    if (!Array.isArray(keys) || !Array.from(keys).every((key) => typeof key === 'string')) {
      throw Error('STORAGE_METADATA_INVALID')
    }
    return keys
  }
  return {
    listKeys: ({ prefix }) => nativeKeys()
      .filter((key) => key.startsWith(namespace + prefix))
      .map((key) => key.slice(namespace.length)),
    get: (key) => {
      const storageKey = namespace + key
      const keys = nativeKeys()
      // Native storage returns '' for both missing keys and persisted empty strings.
      return keys.includes(storageKey) ? Taro.getStorageSync(storageKey) : undefined
    },
    set: (key, value) => Taro.setStorageSync(namespace + key, value)
  }
}
