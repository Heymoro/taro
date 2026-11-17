import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import React, { useEffect, useState } from 'react'

import { getStoredToken } from '../../auth'
import { invalidatePrivateImage, privateImage } from '../../creation-api'

export default function PrivateImage({
  mediaId,
  accountKey = '',
  className,
  mode = 'aspectFill',
  onClick
}) {
  const identity = `${getStoredToken()}:${accountKey}:${mediaId}`
  const [state, setState] = useState({ identity, path: '', failed: false, attempt: 0 })
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, identity, path: '', failed: false }))
    privateImage(mediaId)
      .then((path) => {
        if (alive) setState((s) => ({ ...s, path }))
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, failed: true }))
      })
    return () => {
      alive = false
    }
  }, [identity, mediaId, state.attempt])
  if (state.identity !== identity || !state.path) {
    return (
      <View
        className={`image-loading ${className || ''}`}
        onClick={() => state.failed && setState((s) => ({ ...s, attempt: s.attempt + 1 }))}
      >
        <Text>{state.failed ? '图片加载失败 · 点此重试' : '图片加载中'}</Text>
      </View>
    )
  }
  return (
    <Image
      src={state.path}
      className={className}
      mode={mode}
      onError={() => {
        invalidatePrivateImage(mediaId)
        setState((s) => ({ ...s, path: '', failed: true }))
      }}
      onClick={() =>
        onClick
          ? onClick(state.path)
          : Taro.previewImage({ urls: [state.path], current: state.path })
      }
    />
  )
}
