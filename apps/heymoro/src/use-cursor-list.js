import { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { createCursorList } from './cursor-list'

export function useCursorList({ read, filters = {}, accountKey = 'public', enabled = true, isInterested = () => true }) {
  const reader = useRef(read)
  reader.current = read
  const filterKey = JSON.stringify(filters)
  const visibility = useRef(true)
  const interest = useRef(isInterested)
  interest.current = isInterested
  const live = useRef(null)
  const controller = useMemo(
    () => {
      const next = createCursorList({
        read: (args) => reader.current(args),
        filters: JSON.parse(filterKey),
        isInterested: () => live.current === next && enabled && visibility.current && interest.current()
      })
      return next
    },
    [accountKey, filterKey, enabled]
  )
  live.current = controller
  const [snapshot, setSnapshot] = useState({ controller, state: controller.getSnapshot() })
  useEffect(() => {
    const unsubscribe = controller.subscribe(() =>
      setSnapshot({ controller, state: controller.getSnapshot() })
    )
    if (enabled) controller.load()
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller, enabled])
  useDidHide(() => { visibility.current = false })
  useDidShow(() => {
    visibility.current = true
    if (enabled) {
      controller.reset(JSON.parse(filterKey))
      controller.load()
    }
  })
  // Synchronous identity guard prevents a frame of old-account or old-filter results.
  const state = snapshot.controller === controller ? snapshot.state : controller.getSnapshot()
  return {
    ...state,
    load: () => enabled && controller.load(),
    refresh: () => {
      controller.reset(JSON.parse(filterKey))
      return enabled && controller.load()
    }
  }
}
