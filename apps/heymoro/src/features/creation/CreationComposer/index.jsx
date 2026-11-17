import { Image, Text, View } from '@tarojs/components'
import React from 'react'

import costIcon from '../../../assets/generation-cost.png'
import { Action } from '../../../components/primitives'
import { CreationTextarea } from '../CreationTextarea'

export default function CreationComposer({
  mode,
  description,
  schema,
  controls,
  keyboard,
  onDescription,
  onGenerate,
  onFocus,
  onKeyboardHeightChange,
  onBlur
}) {
  return (
    <View className={`composer ${keyboard ? 'composer--keyboard' : ''}`}>
      {mode === 'free' && (
        <CreationTextarea
          variant="composer"
          className="composer__input"
          value={description}
          maxlength={schema?.maxDescriptionLength}
          fixed
          adjustPosition={false}
          showConfirmBar={false}
          placeholder="描述想生成的画面"
          onInput={(event) => onDescription(event.detail.value)}
          onFocus={onFocus}
          onKeyboardHeightChange={onKeyboardHeightChange}
          onBlur={onBlur}
        />
      )}
      <Action
        className="composer__generate"
        disabled={!controls.canGenerate}
        loading={controls.generateLabel === '提交中'}
        onClick={onGenerate}
      >
        <Text>{controls.generateLabel}</Text>
        {controls.costCredits !== null && (
          <View className="composer__cost">
            <Image src={costIcon} />
            <Text>{controls.costCredits} 积分</Text>
          </View>
        )}
      </Action>
      {!keyboard && <View className="safe-spacer" />}
    </View>
  )
}
