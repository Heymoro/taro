import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'

import { orderedPhotoIds, samePhotoIds } from '../photo-order'

const point = (touch) =>
  touch && Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)
    ? { x: touch.clientX, y: touch.clientY }
    : null
function targetAt(rects, position) {
  if (!rects || !position) return -1
  return rects.findIndex(
    (rect) =>
      position.x >= rect.left &&
      position.x <= rect.right &&
      position.y >= rect.top &&
      position.y <= rect.bottom
  )
}

/** UI-only gesture state. The workflow remains the sole owner of photos. */
export function usePhotoOrder({ photos, disabled, context, onMove }) {
  const [editing, setEditing] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [drag, setDrag] = useState(null)
  const visible = useRef(true)
  const gesture = useRef(null)
  const suppressClick = useRef(false)
  const ids = orderedPhotoIds({ photos })
  const live = useRef(null)
  live.current = { ids, disabled, editing, context, onMove }
  const cancel = () => {
    gesture.current = null
    setDrag(null)
  }
  const valid = (value) =>
    gesture.current === value &&
    visible.current &&
    live.current.editing &&
    !live.current.disabled &&
    value.context === live.current.context &&
    samePhotoIds({ left: value.expectedIds, right: live.current.ids })
  const signature = JSON.stringify(ids)
  useEffect(() => {
    cancel()
  }, [signature, disabled, editing, context])
  useEffect(() => {
    const resize = () => cancel()
    Taro.onWindowResize?.(resize)
    return () => {
      gesture.current = null
      Taro.offWindowResize?.(resize)
    }
  }, [])
  useDidHide(() => {
    visible.current = false
    cancel()
  })
  useDidShow(() => {
    visible.current = true
  })
  const consume = (event) => {
    event?.stopPropagation?.()
    return suppressClick.current || !visible.current
  }
  const action = (callback) => (event) => {
    if (!consume(event)) callback?.()
  }
  const move = (direction) => {
    if (disabled || !ids) return
    const index = ids.indexOf(selectedId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return
    cancel()
    onMove({ slotId: selectedId, targetIndex, expectedIds: ids })
  }
  const tileEvents = (slotId) => ({
    catchMove: true,
    onClick: action(() => setSelectedId(slotId)),
    onTouchStart: (event) => {
      cancel()
      if (event.touches?.length === 1) suppressClick.current = false
      if (!editing || disabled || !visible.current || !ids || event.touches?.length !== 1) return
      const touch = event.touches[0]
      const start = point(touch)
      if (!start || touch.identifier == null) return
      gesture.current = {
        slotId,
        identifier: touch.identifier,
        start,
        context,
        expectedIds: [...ids]
      }
    },
    onLongPress: (event) => {
      const value = gesture.current
      if (!value || !valid(value)) return
      if (event.touches?.length !== 1 || event.touches[0].identifier !== value.identifier) {
        cancel()
        return
      }
      if (value.active) return
      value.active = true
      suppressClick.current = true
      setSelectedId(slotId)
      setDrag({ slotId, position: value.start, targetIndex: -1 })
      try {
        Taro.createSelectorQuery()
          .selectAll('.photo-order__slot')
          .boundingClientRect((rects) => {
            if (!valid(value) || !value.active) return
            if (
              !Array.isArray(rects) ||
              rects.length !== value.expectedIds.length ||
              Array.from(rects).some(
                (rect) =>
                  !rect ||
                  ![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) ||
                  rect.right <= rect.left ||
                  rect.bottom <= rect.top
              )
            ) {
              cancel()
              return
            }
            value.rects = rects
          })
          .exec()
      } catch {
        cancel()
      }
    },
    onTouchMove: (event) => {
      const value = gesture.current
      if (!value) return
      const touch = event.touches?.[0]
      if (!valid(value) || event.touches?.length !== 1 || touch.identifier !== value.identifier) {
        cancel()
        return
      }
      const position = point(touch)
      if (!position) return cancel()
      if (value.active) {
        setDrag({ slotId, position, targetIndex: targetAt(value.rects, position) })
      }
    },
    onTouchEnd: (event) => {
      const value = gesture.current
      const wasValid = value && valid(value)
      // End is terminal before reading geometry or invoking business code.
      gesture.current = null
      setDrag(null)
      const touch = event.changedTouches?.[0]
      if (
        !wasValid ||
        !value.active ||
        event.touches?.length ||
        event.changedTouches?.length !== 1 ||
        touch.identifier !== value.identifier
      ) {
        return
      }
      const position = point(touch)
      if (!position || (position.x === value.start.x && position.y === value.start.y)) return
      const targetIndex = targetAt(value.rects, position)
      if (targetIndex < 0 || targetIndex === value.expectedIds.indexOf(slotId)) return
      live.current.onMove({ slotId, targetIndex, expectedIds: value.expectedIds })
    },
    onTouchCancel: cancel
  })
  const selectedIndex = ids?.indexOf(selectedId) ?? -1
  return {
    editing,
    selectedId,
    drag,
    action,
    tileEvents,
    onPanelTouchStart: (event) => {
      if (!gesture.current && event.touches?.length === 1) suppressClick.current = false
    },
    begin: action(() => {
      if (disabled || !ids?.length) return
      setSelectedId(ids[0])
      setEditing(true)
    }),
    done: action(() => {
      cancel()
      setEditing(false)
    }),
    previous: action(() => move(-1)),
    next: action(() => move(1)),
    previousDisabled: disabled || selectedIndex <= 0,
    nextDisabled: disabled || selectedIndex < 0 || selectedIndex >= (ids?.length || 0) - 1
  }
}
