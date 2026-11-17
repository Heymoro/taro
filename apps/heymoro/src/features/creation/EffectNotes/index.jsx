import { Button, View } from '@tarojs/components'
import React, { useState } from 'react'

import { CreationTextarea } from '../CreationTextarea'

/** Optional user-authored notes live in the scroll lane, never in the fixed footer. */
export default function EffectNotes({
  userNotes,
  schema,
  onNotes,
  onExpand,
  onFocus,
  onKeyboardHeightChange,
  onBlur
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <View className="effect-notes" id="effect-notes">
      <Button
        className="text-button effect-notes__toggle"
        onClick={() => {
          setExpanded((value) => !value)
          if (!expanded) onExpand?.()
        }}
      >
        {expanded ? '收起补充要求' : '＋ 补充要求（选填）'}
      </Button>
      {expanded && (
        <CreationTextarea
          variant="notes"
          className="effect-notes__input"
          value={userNotes}
          maxlength={schema?.maxNotesLength}
          adjustPosition={false}
          showConfirmBar={false}
          placeholder="补充要求（选填）"
          onInput={(event) => onNotes(event.detail.value)}
          onFocus={onFocus}
          onKeyboardHeightChange={onKeyboardHeightChange}
          onBlur={onBlur}
        />
      )}
    </View>
  )
}
