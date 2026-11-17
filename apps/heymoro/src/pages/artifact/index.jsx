import { Button, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import React from 'react'

import { Brand, NavBar, Notice } from '../../components/primitives'
import PrivateImage from '../../components/PrivateImage'
import { privateImage } from '../../creation-api'
import { useArtifact } from '../../features/artifact/use-artifact'
import { useArtifactReturn } from '../../features/artifact/use-artifact-return'
import { useAccount } from '../../use-account'

async function saveToAlbum({ item, isCurrent }) {
  if (!isCurrent()) return
  try {
    const filePath = await privateImage(item.mediaId)
    if (!isCurrent()) return
    await Taro.saveImageToPhotosAlbum({ filePath })
    if (!isCurrent()) return
    Taro.showToast({ title: '已保存到相册', icon: 'success' })
  } catch (error) {
    if (!isCurrent()) return
    const failure = Error('ALBUM_SAVE_FAILED')
    failure.code = /auth deny|authorize|permission/i.test(error?.errMsg || '')
      ? 'ALBUM_PERMISSION'
      : 'ALBUM_SAVE_FAILED'
    throw failure
  }
}

export default function ArtifactPage() {
  const { params } = useRouter()
  const artifactId = Number(params.id)
  const account = useAccount()
  const { item, loading, error, busy, canRetryRead, reload, toggleFavorite, download } = useArtifact({
    artifactId,
    account,
    saveToAlbum
  })
  const returnFlow = useArtifactReturn({
    account,
    artifactId,
    item,
    fromOpener: params.returnTo === 'opener'
  })
  return (
    <View className="screen">
      <NavBar title="我的作品" canBack />
      {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
      {error && (
        <Notice onRetry={canRetryRead ? reload : undefined} label="重试读取">{error}</Notice>
      )}
      {returnFlow.error && (
        <Notice
          onRetry={returnFlow.busy ? undefined : returnFlow.returnToCreation}
          label="重试返回创作"
        >
          {returnFlow.error}
        </Notice>
      )}
      {loading && (
        <View className="screen-loading">
          <Brand animated />
        </View>
      )}
      {item && (
        <>
          <View className="artifact-detail">
            <PrivateImage
              mediaId={item.mediaId}
              accountKey={account.accountKey}
              className="artifact-detail__image"
              mode="aspectFit"
            />
          </View>
          <View className="artifact-toolbar">
            <View className="artifact-toolbar__primary">
              <Button className="artifact-tool" disabled={busy} onClick={toggleFavorite}>
                {item.isFavorite ? '已收藏' : '收藏'}
              </Button>
              <Button className="artifact-tool" disabled={busy} onClick={download}>
                保存到相册
              </Button>
              <Button
                className="artifact-tool"
                disabled={returnFlow.busy}
                onClick={returnFlow.returnToCreation}
              >
                返回创作
              </Button>
            </View>
            <View className="artifact-toolbar__links">
              <Button
                className="text-button"
                onClick={() =>
                  Taro.navigateTo({ url: `/pages/create/index?session=${item.sessionId}&source=${item.id}` })
                }
              >
                按原输入换一张
              </Button>
              <Button
                className="text-button"
                onClick={() =>
                  Taro.navigateTo({ url: `/pages/create/index?session=${item.sessionId}&carry=${item.id}` })
                }
              >
                带回输入
              </Button>
            </View>
            <View className="safe-spacer" />
          </View>
        </>
      )}
    </View>
  )
}
