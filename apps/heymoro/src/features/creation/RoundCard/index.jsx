import { Button, Text, View } from '@tarojs/components'
import React from 'react'

import { Brand, Notice } from '../../../components/primitives'
import PrivateImage from '../../../components/PrivateImage'

export default function RoundCard({
  round,
  artifacts,
  accountKey,
  onFavorite,
  onRegenerate,
  onOpen,
  onCarryBack,
  onRefresh
}) {
  const outputs = (round.artifactIds || []).map((id) => artifacts[id]).filter(Boolean)
  function renderResult() {
    if (round.status === 'succeeded') {
      return (
        <>
          {outputs.map((artifact) => (
            <View key={artifact.id}>
              <PrivateImage
                mediaId={artifact.mediaId}
                accountKey={accountKey}
                className="generation__image"
                mode="aspectFit"
                onClick={() => onOpen(artifact.id)}
              />
              <View className="generation__actions">
                <Button
                  className="text-button"
                  disabled={artifact.saving}
                  onClick={() => onFavorite(artifact.id)}
                >
                  {artifact.isFavorite ? '已收藏' : '收藏'}
                </Button>
                <Button className="text-button" onClick={() => onRegenerate(artifact.id)}>
                  换一张
                </Button>
                <Button className="text-button" onClick={() => onOpen(artifact.id)}>
                  查看作品
                </Button>
              </View>
            </View>
          ))}
          {!outputs.length && <Notice onRetry={onRefresh}>作品记录暂未读取，请刷新</Notice>}
        </>
      )
    }
    if (round.status === 'closed') {
      return (
        <Notice>
          本轮已结清，不再等待出图。
          {round.resolution
            ? `已释放 ${round.resolution.releasedAvailableCredits} 可用积分，${round.resolution.releasedExpiredCredits} 积分已过期。`
            : '积分结算详情请刷新核对。'}
        </Notice>
      )
    }
    if (round.status === 'cancelled') return <Notice>本轮已取消，输入已保留。</Notice>
    if (round.status === 'failed') {
      return (
        <View className="generation__failure">
          <Text>这次没有生成成功</Text>
          <Text className="muted small">输入已保留；如需调整，可带回输入。</Text>
        </View>
      )
    }
    if (round.status === 'unknown') {
      return <Notice onRetry={onRefresh}>结果待确认，请稍后查询，不会自动重复生成。</Notice>
    }
    return (
      <View className="generation__waiting">
        <Brand animated />
        <Text>{round.status === 'queued' ? '正在排队' : '正在生成'}</Text>
      </View>
    )
  }
  return (
    <View className="generation" id={`round-${round.id}`}>
      <View className="input-summary">
        <Text className="small muted">
          第 {round.roundNo} 轮 ·{' '}
          {round.input.inputMediaIds.length ? `${round.input.inputMediaIds.length} 张照片` : '仅文字'}
        </Text>
        <Text>{round.input.description || round.input.userNotes}</Text>
      </View>
      {renderResult()}
      <Button className="text-button generation__carry" onClick={() => onCarryBack(round.id)}>
        带回输入
      </Button>
    </View>
  )
}
