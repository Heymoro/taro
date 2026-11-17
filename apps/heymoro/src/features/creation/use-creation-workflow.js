import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'

import { creationApi } from '../../creation-api'
import { accountStorage, photoPlatform, requestKey } from '../../creation-platform'
import { createWorkflow } from '../../creation-workflow'
import { creationAccountKey } from '../../use-account'
import { coordinateCarryBackInput } from './carry-back-input'

function carryBackWithConfirmation({ workflow, intent }) {
  if (!workflow) return false
  return coordinateCarryBackInput({
    intent,
    prepare: workflow.prepareCarryBackInput,
    confirm: workflow.confirmCarryBackInput,
    cancel: workflow.cancelCarryBackInput,
    showConfirmation: (options) => Taro.showModal(options)
  })
}

export function useCreationWorkflow({
  account,
  sessionId,
  templateId,
  sourceArtifactId,
  carryArtifactId
}) {
  const visible = useRef(true)
  const controller = useRef(null)
  const runtimeRef = useRef(null)
  const [snapshot, setSnapshot] = useState(null)
  const key = `${account.accountKey}:${sessionId || ''}:${templateId || 'free'}`
  const liveKey = useRef(key)
  liveKey.current = key
  useDidShow(() => {
    visible.current = true
    runtimeRef.current?.show()
  })
  useDidHide(() => {
    visible.current = false
    runtimeRef.current?.hide()
  })
  useEffect(() => {
    if (!account.user || !account.accountKey) return undefined
    let restored = false
    const runtime = {
      ownerKey: key,
      active: true,
      disposed: false,
      timerId: null,
      timerDue: null,
      showDemand: false,
      epoch: 0,
      readingEpoch: null,
      lastPhase: null,
      pending: null,
      healthyDue: null,
      deferredQuote: false,
      readyEpoch: null
    }
    const workflow = createWorkflow({
      api: creationApi,
      files: photoPlatform,
      storage: accountStorage(account.user.id),
      key: sessionId ? `session:${sessionId}` : `template:${templateId || 'free'}`,
      templateId,
      sessionId,
      makeId: requestKey,
      isCurrent: () =>
        runtime.active &&
        liveKey.current === key &&
        controller.current !== null &&
        controller.current === workflow &&
        creationAccountKey() === account.accountKey
    })
    controller.current = workflow
    workflow.setPageVisible({ visible: visible.current })
    runtimeRef.current = runtime
    const isOwner = () =>
      runtime.active &&
      !runtime.disposed &&
      runtimeRef.current === runtime &&
      controller.current === workflow &&
      liveKey.current === runtime.ownerKey &&
      creationAccountKey() === account.accountKey
    const clearTimer = () => {
      if (runtime.timerId !== null) clearTimeout(runtime.timerId)
      runtime.timerId = null
      runtime.timerDue = null
    }
    const startRead = (reason) => {
      if (!isOwner() || !visible.current || runtime.pending || workflow.getSnapshot().sessionAvailability.status === 'unavailable') return
      const flight = { epoch: runtime.epoch }
      runtime.pending = flight
      if (runtime.showDemand) runtime.showDemand = false
      const promise = workflow.refresh({ reason })
      promise.finally(() => {
        if (!isOwner() || runtime.pending !== flight) return
        runtime.pending = null
        reconcileTimer()
        reconcileDeferredQuote()
      })
    }
    function reconcileTimer() {
      if (!isOwner() || !visible.current) {
        clearTimer()
        return
      }
      const state = workflow.getSnapshot()
      if (state.sessionAvailability.status === 'unavailable') {
        runtime.showDemand = false
        runtime.healthyDue = null
        clearTimer()
        return
      }
      if (runtime.pending || state.readRecovery.phase === 'reading') {
        clearTimer()
        return
      }
      if (!workflow.shouldPoll() && !runtime.showDemand) {
        runtime.healthyDue = null
        clearTimer()
        return
      }
      let due = state.readRecovery.nextAttemptAt
      if (due == null) {
        if (runtime.showDemand) due = Date.now()
        else {
          if (runtime.healthyDue === null) runtime.healthyDue = Date.now() + 2000
          due = runtime.healthyDue
        }
      }
      if (runtime.timerId !== null && runtime.timerDue === due) return
      clearTimer()
      if (runtime.showDemand && due <= Date.now()) {
        startRead('show')
        return
      }
      runtime.timerDue = due
      runtime.timerId = setTimeout(() => {
        runtime.timerId = null
        runtime.timerDue = null
        if (!isOwner() || !visible.current) return
        startRead(runtime.showDemand ? 'show' : 'poll')
      }, Math.max(0, due - Date.now()))
    }
    function reconcileDeferredQuote() {
      if (!isOwner() || !runtime.deferredQuote) return
      const state = workflow.getSnapshot()
      if (state.sessionAvailability.status === 'unavailable' || state.sessionAvailability.terminalEpoch !== runtime.deferredQuoteEpoch) {
        runtime.deferredQuote = false
        return
      }
      // A new quote attempt supersedes old intent even when its response will fail.
      if (
        state.quote || state.quoting || state.submission || state.sessionRequest || workflow.shouldPoll()
      ) {
        runtime.deferredQuote = false
        return
      }
      if (
        !visible.current ||
        runtime.pending ||
        runtime.showDemand ||
        runtime.readyEpoch !== runtime.epoch ||
        state.readRecovery.phase !== 'ready' ||
        state.readRecovery.failureCount !== 0
      ) {
        return
      }
      // Consume before prepareQuote emits; failures belong to the existing explicit quote retry.
      runtime.deferredQuote = false
      workflow.prepareQuote()
    }
    runtime.lastQuoteAttemptRevision = workflow.getSnapshot().quoteAttemptRevision
    const publish = () => {
      if (!isOwner()) return
      const state = workflow.getSnapshot()
      if (state.quoteAttemptRevision !== runtime.lastQuoteAttemptRevision) {
        runtime.lastQuoteAttemptRevision = state.quoteAttemptRevision
        runtime.deferredQuote = false
      }
      if (state.readRecovery.phase === 'reading' && runtime.lastPhase !== 'reading') {
        runtime.readingEpoch = runtime.epoch
      }
      if (
        runtime.lastPhase === 'reading' &&
        state.readRecovery.phase !== 'reading' &&
        runtime.readingEpoch === runtime.epoch &&
        state.readRecovery.phase !== 'idle'
      ) {
        runtime.showDemand = false
      }
      if (
        runtime.lastPhase === 'reading' &&
        state.readRecovery.phase === 'ready' &&
        state.readRecovery.failureCount === 0 &&
        runtime.readingEpoch === runtime.epoch
      ) {
        runtime.readyEpoch = runtime.epoch
      }
      runtime.lastPhase = state.readRecovery.phase
      setSnapshot({ key, workflow, restored, state })
      reconcileTimer()
      reconcileDeferredQuote()
    }
    runtime.hide = () => {
      if (!isOwner()) return
      runtime.epoch++
      clearTimer()
      workflow.setPageVisible({ visible: false })
    }
    runtime.show = () => {
      if (!isOwner()) return
      runtime.showDemand = workflow.getSnapshot().sessionAvailability.status !== 'unavailable'
      if (
        (runtime.pending && runtime.pending.epoch === runtime.epoch) ||
        (workflow.getSnapshot().readRecovery.phase === 'reading' &&
          runtime.readingEpoch === runtime.epoch)
      ) {
        runtime.showDemand = false
      }
      workflow.setPageVisible({ visible: true })
      reconcileTimer()
    }
    const unsubscribe = workflow.subscribe(publish)
    const restoreFlight = { epoch: runtime.epoch }
    runtime.pending = restoreFlight
    publish()
    workflow.restore().then(async (result) => {
      if (!isOwner()) return
      runtime.pending = null
      restored = true
      publish()
      if (
        !isOwner() ||
        !visible.current ||
        ['cancelled', 'unavailable'].includes(result?.status) ||
        workflow.getSnapshot().sessionAvailability.status === 'unavailable' ||
        ['offline', 'reading'].includes(workflow.getSnapshot().readRecovery.phase)
      ) {
        return
      }
      if (carryArtifactId) {
        await carryBackWithConfirmation({ workflow, intent: { artifactId: carryArtifactId } })
      } else if (sourceArtifactId) await workflow.prepareRegeneration(sourceArtifactId)
    })
    return () => {
      runtime.active = false
      runtime.disposed = true
      runtime.deferredQuote = false
      clearTimer()
      unsubscribe()
      workflow.dispose()
      if (runtimeRef.current === runtime) runtimeRef.current = null
      if (controller.current === workflow) controller.current = null
    }
  }, [
    key,
    account.user?.id,
    account.accountKey,
    sessionId,
    templateId,
    sourceArtifactId,
    carryArtifactId
  ])
  const quote = snapshot?.key === key ? snapshot.state.quote : null
  const availability = snapshot?.key === key ? snapshot.state.sessionAvailability : null
  useEffect(() => {
    const workflow = snapshot?.key === key ? snapshot.workflow : null
    const runtime = runtimeRef.current
    if (!quote || !workflow || !runtime || availability?.status === 'unavailable' ||
      (quote.terminalEpoch ?? 0) !== availability?.terminalEpoch) return undefined
    const timer = setTimeout(() => {
      if (
        !runtime.active ||
        runtime.disposed ||
        runtimeRef.current !== runtime ||
        controller.current !== workflow ||
        liveKey.current !== key ||
        creationAccountKey() !== account.accountKey
      ) {
        return
      }
      const state = workflow.getSnapshot()
      if (state.sessionAvailability.status === 'unavailable' ||
        (quote.terminalEpoch ?? 0) !== state.sessionAvailability.terminalEpoch) return
      const recovery = state.readRecovery
      const defer = !visible.current || recovery.phase === 'offline' || recovery.failureCount > 0
      if (defer) {
        runtime.deferredQuote = true
        runtime.deferredQuoteEpoch = state.sessionAvailability.terminalEpoch
      }
      workflow.expireQuote()
      if (!defer) workflow.prepareQuote()
    }, Math.max(0, Date.parse(quote.validUntil) - Date.now()))
    return () => clearTimeout(timer)
  }, [key, quote, availability, account.accountKey, snapshot?.workflow, snapshot?.key])
  return {
    state: snapshot?.key === key ? snapshot.state : null,
    workflow: snapshot?.key === key ? snapshot.workflow : null,
    restored:
      snapshot?.key === key && snapshot.workflow === controller.current && snapshot.restored,
    carryBackInput: (intent) =>
      visible.current && carryBackWithConfirmation({ workflow: controller.current, intent })
  }
}
