import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationAccountKey } from '../../use-account'
import { createArtifactOpener } from './artifact-return'

/** Owns scroll intentions and read feedback, never history or input facts. */
export function useCreationTimeline({ account, workflow, state, restored, focusTaskId }) {
  const page = useRef(Taro.getCurrentInstance?.().page)
  const visibility = useRef(true)
  const accountKey = account.accountKey
  const owner = useMemo(
    () => ({
      active: true,
      workflow,
      accountKey,
      ready: false,
      visible: visibility.current,
      epoch: 0,
      measurement: 0,
      nearBottom: true,
      previousLast: null,
      focused: false,
      routeFocus: focusTaskId,
      pending: focusTaskId != null ? { taskId: focusTaskId, mode: 'reveal', started: false } : null
    }),
    [workflow, accountKey]
  )
  const live = useRef(owner)
  live.current = owner
  owner.ready = Boolean(restored)
  const [projection, setProjection] = useState({ owner, anchor: '', notice: null })
  const current = () =>
    owner.active &&
    live.current === owner &&
    Boolean(workflow && accountKey) &&
    creationAccountKey() === accountKey &&
    Boolean(page.current && Taro.getCurrentPages?.().includes(page.current))
  const foreground = () =>
    current() && owner.visible && Taro.getCurrentPages?.().at(-1) === page.current
  const publish = (patch) => {
    if (!current()) return
    setProjection((previous) => ({
      ...(previous.owner === owner ? previous : { anchor: '', notice: null }),
      owner,
      ...patch
    }))
  }
  const nextAnchor = ({ anchor, epoch }) => {
    if (!foreground()) return
    publish({ anchor: '' })
    const apply = () => {
      if (foreground() && owner.epoch === epoch) publish({ anchor })
    }
    if (Taro.nextTick) Taro.nextTick(apply)
    else Promise.resolve().then(apply)
  }
  const consume = async () => {
    const intent = owner.pending
    if (!foreground() || !owner.ready || !intent || intent.started) {
      return
    }
    intent.started = true
    const epoch = owner.epoch
    const result = await workflow.focusTask({ taskId: intent.taskId })
    if (!current() || owner.epoch !== epoch || owner.pending !== intent) return
    if (!foreground() || result.status === 'cancelled') {
      intent.started = false
      return
    }
    const retry = () => focusRound({ taskId: intent.taskId, mode: intent.mode })
    if (result.status === 'focused') {
      owner.pending = null
      owner.focused = true
      if (intent.mode === 'reveal') nextAnchor({ anchor: `round-${result.taskId}`, epoch })
      let notice = null
      if (result.artifacts !== 'fresh') {
        const message =
          result.artifacts === 'pending'
            ? '作品状态正在更新，请重试读取'
            : '作品暂时无法读取，请重试'
        notice = { message, label: '重试读取', onRetry: retry }
      }
      publish({ notice })
    } else {
      owner.focused = true
      publish({
        notice:
          result.status === 'paused'
            ? { message: '历史较长，已保留定位进度', label: '继续定位', onRetry: retry }
            : { message: '暂时无法定位来源轮次，请重试', label: '重试定位', onRetry: retry }
      })
    }
  }
  function focusRound({ taskId, mode = 'preserve', sessionId }) {
    if (
      !current() ||
      !Number.isSafeInteger(taskId) ||
      taskId <= 0 ||
      (sessionId && workflow.getSnapshot().sessionId !== sessionId)
    ) {
      return false
    }
    owner.epoch++
    workflow.cancelTaskFocus()
    owner.focused = true
    owner.pending = { taskId, mode, started: false }
    publish({ anchor: '', notice: null })
    consume()
    return true
  }
  const interrupt = () => {
    if (!current()) return
    owner.epoch++
    owner.pending = null
    owner.focused = false
    workflow.cancelTaskFocus()
    publish({ anchor: '', notice: null })
  }
  useEffect(() => {
    owner.active = true
    const opener = createArtifactOpener({
      native: Taro,
      page: page.current,
      readOwner: () => {
        if (!current()) return null
        return { accountKey, controller: workflow, sessionId: workflow.getSnapshot().sessionId }
      },
      acceptFocus: focusRound,
      onError: (message) => publish({ notice: { message } })
    })
    owner.opener = opener
    // Effect replay replaces disposed navigation resources, not the workflow facts.
    if (owner.pending) owner.pending.started = false
    consume()
    return () => {
      owner.active = false
      owner.epoch++
      workflow?.cancelTaskFocus()
      opener.dispose()
    }
  }, [owner])
  useEffect(() => {
    if (Object.is(owner.routeFocus, focusTaskId)) return
    owner.routeFocus = focusTaskId
    if (focusTaskId == null) interrupt()
    else focusRound({ taskId: focusTaskId, mode: 'reveal' })
  }, [owner, focusTaskId])
  useEffect(() => {
    owner.opener?.invalidate()
    consume()
  }, [owner, restored, state?.sessionId])
  useEffect(() => {
    const last = state?.rounds.at(-1)?.id
    if (
      foreground() &&
      last &&
      last !== owner.previousLast &&
      owner.nearBottom &&
      !owner.pending &&
      !owner.focused
    ) {
      nextAnchor({ anchor: 'timeline-end', epoch: owner.epoch })
    }
    owner.previousLast = last
  }, [owner, state?.rounds])
  useDidHide(() => {
    visibility.current = false
    owner.visible = false
    owner.epoch++
    // Cancel only an intent already running when hidden. A later channel request survives.
    if (owner.pending?.started) owner.pending = null
    workflow?.cancelTaskFocus()
  })
  useDidShow(() => {
    visibility.current = true
    owner.visible = true
    owner.opener?.show()
    consume()
  })
  const loadOlder = async ({ manual = true } = {}) => {
    if (!foreground()) return
    if (!manual && (owner.pending || owner.focused)) return
    if (manual) interrupt()
    const snapshot = workflow.getSnapshot()
    if (!snapshot.hasOlder || snapshot.loadingOlder) return
    const epoch = owner.epoch
    const first = snapshot.rounds[0]?.id
    await workflow.loadOlder()
    if (!foreground() || owner.epoch !== epoch || owner.pending || owner.focused) {
      return
    }
    if (first) nextAnchor({ anchor: `round-${first}`, epoch })
  }
  const onScroll = (event) => {
    if (!foreground()) return
    const epoch = owner.epoch
    const measurement = ++owner.measurement
    const { scrollHeight, scrollTop } = event.detail
    Taro.createSelectorQuery?.()
      .select('.timeline')
      .boundingClientRect((rect) => {
        if (foreground() && owner.epoch === epoch && owner.measurement === measurement && rect) {
          owner.nearBottom = scrollHeight - scrollTop - rect.height < 120
        }
      })
      .exec()
  }
  const openArtifact = ({ taskId, artifactId }) => {
    if (!foreground() || owner.opener?.isPending()) return false
    const snapshot = workflow.getSnapshot()
    const round = snapshot.rounds.find((item) => item.id === taskId)
    const artifact = snapshot.artifacts[artifactId]
    if (
      !round?.artifactIds?.includes(artifactId) ||
      artifact?.id !== artifactId ||
      artifact.taskId !== taskId ||
      artifact.sessionId !== snapshot.sessionId
    ) {
      return false
    }
    interrupt()
    return owner.opener?.open({ taskId, artifactId }) || false
  }
  const view = projection.owner === owner ? projection : { anchor: '', notice: null }
  return {
    anchor: view.anchor,
    notice: view.notice,
    focusRound,
    openArtifact,
    loadOlder,
    onScroll,
    onUserIntent: () => {
      if (!foreground()) return
      owner.nearBottom = false
      interrupt()
    },
    interrupt,
    revealNotes: () => {
      if (!foreground()) return
      interrupt()
      const epoch = owner.epoch
      nextAnchor({ anchor: 'effect-notes', epoch })
      return () => {
        // A newer scroll/focus intent owns its own epoch and must survive cleanup.
        if (current() && owner.epoch === epoch) interrupt()
      }
    }
  }
}
