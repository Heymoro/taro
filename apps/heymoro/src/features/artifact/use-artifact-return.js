import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationAccountKey } from '../../use-account'
import { createArtifactReturn } from '../creation/artifact-return'

export function useArtifactReturn({ account, artifactId, item, fromOpener }) {
  const page = useRef(Taro.getCurrentInstance?.().page)
  const visible = useRef(true)
  const live = useRef(null)
  live.current = { accountKey: account.accountKey, artifactId, item }
  const [feedback, setFeedback] = useState(null)
  const [, renderNavigation] = useState(0)
  const accountKey = account.accountKey
  const owner = useMemo(() => ({ active: true, protocol: null }), [accountKey, artifactId])
  const current = () =>
    owner.active &&
    visible.current &&
    live.current.accountKey === accountKey &&
    live.current.artifactId === artifactId &&
    creationAccountKey() === accountKey
  useEffect(() => {
    owner.active = true
    const protocol = createArtifactReturn({
      native: Taro,
      page: page.current,
      readOwner: () => {
        const value = live.current.item
        if (!current() || value?.id !== artifactId) return null
        return { accountKey, artifactId, taskId: value.taskId, sessionId: value.sessionId }
      },
      onError: (message) => {
        if (current()) setFeedback({ accountKey, artifactId, message })
      }
    })
    owner.protocol = protocol
    return () => {
      owner.active = false
      protocol.dispose()
    }
  }, [owner])
  useEffect(() => owner.protocol?.invalidate(), [owner, item])
  useDidHide(() => {
    visible.current = false
    owner.protocol?.invalidate()
  })
  useDidShow(() => {
    visible.current = true
  })
  return {
    busy: current() && Boolean(owner.protocol?.isPending()),
    error:
      current() && feedback?.accountKey === accountKey && feedback.artifactId === artifactId
        ? feedback.message
        : '',
    returnToCreation: () => {
      if (!current() || owner.protocol?.isPending()) return
      setFeedback(null)
      owner.protocol?.returnToCreation({ opener: fromOpener })
      if (current()) renderNavigation((version) => version + 1)
    }
  }
}
