import { Text, View } from '@tarojs/components'
import React from 'react'

import { OfficialImage } from '../../../components/primitives'

export default function TemplateGuide({ template, compact, onOpen }) {
  if (!template || template.mode !== 'effect') return null
  const display = template.displayConfig
  const shareKey = display.showcaseShareKeys[0]
  if (!shareKey) return null
  return (
    <View className={`template-guide ${compact ? 'template-guide--compact' : ''}`} onClick={onOpen}>
      {(
        <OfficialImage
          shareKey={shareKey}
          className={compact ? 'template-guide__thumb' : 'template-guide__hero'}
        />
      )}
      <View className="template-guide__caption">
        <View>
          <Text className="strong">效果示例</Text>
          {!compact && <Text className="small muted">{display.photoHint}</Text>}
        </View>
        <Text className="link">查看作品会话 ›</Text>
      </View>
    </View>
  )
}
