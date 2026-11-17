import { Textarea, View } from '@tarojs/components'
import React, { useRef, useState } from 'react'

/** Native layout owns wrapping; the shell owns padding and decoration. */
export function CreationTextarea({
  className,
  variant,
  value,
  onFocus,
  onBlur,
  ...nativeProps
}) {
  // Keep the last native layout candidate even when it arrives before the controlled input echo.
  // Nonempty initial content is readable while its first native layout is unknown.
  const [nativeRows, setNativeRows] = useState(value ? 3 : 1)
  const [focusRequest, setFocusRequest] = useState(false)
  const focused = useRef(false)

  return (
    <View
      className={`creation-textarea creation-textarea--${variant}`}
      onClick={() => {
        if (!focused.current) setFocusRequest(true)
      }}
    >
      <Textarea
        {...nativeProps}
        className={`creation-textarea__input creation-textarea__input--rows-${value ? nativeRows : 1} ${className}`}
        value={value}
        autoHeight={false}
        disableDefaultPadding
        focus={focusRequest}
        onLineChange={(event) => {
          const lineCount = event?.detail?.lineCount
          if (!Number.isSafeInteger(lineCount) || lineCount < 1) return
          setNativeRows(Math.min(lineCount, 3))
        }}
        onFocus={(event) => {
          focused.current = true
          onFocus?.(event)
        }}
        onBlur={(event) => {
          focused.current = false
          setFocusRequest(false)
          onBlur?.(event)
        }}
      />
    </View>
  )
}

export default CreationTextarea
