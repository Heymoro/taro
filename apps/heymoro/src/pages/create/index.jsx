import { ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidHide, useRouter } from '@tarojs/taro'
import React, { useEffect, useRef, useState } from 'react'

import { Brand, NavBar, Notice } from '../../components/primitives'
import CreationComposer from '../../features/creation/CreationComposer'
import EffectNotes from '../../features/creation/EffectNotes'
import PhotoInput from '../../features/creation/PhotoInput'
import { usePhotoOrder } from '../../features/creation/PhotoInput/use-photo-order'
import RoundCard from '../../features/creation/RoundCard'
import TemplateGuide from '../../features/creation/TemplateGuide'
import { useCreationTimeline } from '../../features/creation/use-creation-timeline'
import { useCreationWorkflow } from '../../features/creation/use-creation-workflow'
import { useCreditNavigation } from '../../features/credits/use-credit-navigation'
import { useAccount } from '../../use-account'
import { useViewport } from '../../use-viewport'

// Presentation only: missing or conflicting facts must not reclassify a retained draft.
function creationMode({ params, state }) {
  const routeKeys = ['session', 'template', 'source', 'carry']
  const hasRoute = (key) => Object.prototype.hasOwnProperty.call(params, key)
  const validId = (key) => Number.isSafeInteger(Number(params[key])) && Number(params[key]) > 0
  if (routeKeys.some((key) => hasRoute(key) && !validId(key))) return null
  const facts = [state?.template?.mode, state?.session?.mode, state?.mode]
    .filter((value) => value != null)
  if (facts.some((value) => value !== 'free' && value !== 'effect')) return null
  const modes = new Set(facts)
  if (modes.size > 1) return null
  if (modes.size === 1) return facts[0]
  if (hasRoute('template')) return 'effect'
  return routeKeys.some(hasRoute) ? null : 'free'
}

function creationNoticeLabel({ state, sessionNotice }) {
  if (sessionNotice?.label) return sessionNotice.label
  if (state.sessionRequest) return '确认会话结果'
  if (state.submission) return '确认提交结果'
  return state.errorAction === 'quote' ? '重试报价' : '刷新'
}

function pausedDraftMessage({ sessionUnavailable }) {
  return sessionUnavailable
    ? '远端保存已暂停。原创作当前不可读取，请先重新检查；此时不执行远端恢复保存。'
    : '远端保存已暂停，后续编辑仅保留在本机。确认恢复后将保存当前输入。'
}

export default function CreatePage() {
  const { params } = useRouter()
  const account = useAccount()
  const creditsNavigation = useCreditNavigation({ account })
  const openingCredits = creditsNavigation.pending && creditsNavigation.target === '/pages/credits/index'
  const viewport = useViewport()
  const { state, workflow, restored, carryBackInput } = useCreationWorkflow({
    account,
    sessionId: params.session ? Number(params.session) : null,
    templateId: params.template ? Number(params.template) : null,
    sourceArtifactId: params.source ? Number(params.source) : null,
    carryArtifactId: params.carry ? Number(params.carry) : null
  })
  const timeline = useCreationTimeline({
    account,
    state,
    workflow,
    restored,
    focusTaskId: params.focusTask ? Number(params.focusTask) : null
  })
  const [notesFocused, setNotesFocused] = useState(null)
  const liveWorkflow = useRef(workflow)
  liveWorkflow.current = workflow
  const notesOwner = useRef(null)
  const notesCancel = useRef(null)
  const notesTimeline = useRef(timeline)
  notesTimeline.current = timeline
  useDidHide(() => {
    notesOwner.current = null
    setNotesFocused(null)
  })
  useEffect(() => {
    if (!notesFocused || notesFocused !== workflow || notesOwner.current !== workflow || viewport.keyboard <= 0) return undefined
    // The new viewport height is committed before the timeline's native nextTick.
    // Its existing owner/epoch guards cancel the anchor on hide or disposal.
    const cancel = notesTimeline.current.revealNotes()
    notesCancel.current = cancel
    return () => {
      cancel?.()
      if (notesCancel.current === cancel) notesCancel.current = null
    }
  }, [notesFocused, viewport.keyboard, viewport.style.height, workflow])
  const photoOrder = usePhotoOrder({
    photos: state?.photos || [],
    context: workflow,
    disabled: !state?.controls.canReorderPhotos || viewport.keyboard > 0,
    onMove: (args) => {
      timeline.interrupt()
      return workflow.movePhoto(args)
    }
  })
  const rename = async () => {
    if (state?.controls.canRename === false) return
    if (!state?.sessionId) return Taro.showToast({ title: '会话创建后可重命名', icon: 'none' })
    timeline.interrupt()
    const result = await Taro.showModal({
      title: '重命名创作',
      editable: true,
      placeholderText: state.session?.title || '新的创作',
      confirmText: '保存'
    })
    if (result.confirm && result.content?.trim()) await workflow.rename(result.content)
  }
  const sessionNotice = state?.controls.sessionNotice
  const readAction = () => {
    timeline.interrupt()
    if (sessionNotice?.action === 'confirm') return workflow.generate()
    if (sessionNotice?.action === 'quote') return workflow.prepareQuote()
    return workflow.recheckSession()
  }
  const template = state?.template
  const mode = creationMode({ params, state })
  // A frozen explicit confirmation is not a new generation; core guards still decide it.
  const controls = state && !mode && !state.submission && !state.sessionRequest
    ? { ...state.controls, canGenerate: false }
    : state?.controls
  return (
    <>
      <View id="creation-viewport-probe" className="creation-viewport-probe" aria-hidden />
      <View className="screen create-screen" style={viewport.style}>
        <NavBar
          title={state?.session?.title || template?.displayConfig.name || '新的创作'}
          canBack
          onRename={state?.controls.canRename === false ? undefined : rename}
        />
        {account.error ? (
          <Notice onRetry={account.refresh}>{account.error}</Notice>
        ) : !state ? (
          <View className="screen-loading">
            <Brand animated />
            <Text>正在准备创作…</Text>
          </View>
        ) : (
          <>
            <PhotoInput
              photos={state.photos}
              photoOrder={photoOrder}
              canReorder={state.controls.canReorderPhotos && !viewport.keyboard}
              canSelectPhotos={state.controls.canSelectPhotos}
              activeUploadIds={state.controls.activeUploadIds}
              photoBatchBusy={state.controls.photoBatchBusy}
              schema={template?.inputSchema}
              mode={mode}
              onAdd={() => {
                timeline.interrupt()
                return workflow.addPhotos()
              }}
              onRemove={(id) => {
                timeline.interrupt()
                return workflow.removePhoto(id)
              }}
              onResume={(id) => {
                timeline.interrupt()
                return workflow.resumePhoto(id)
              }}
              onRetry={(id) => {
                timeline.interrupt()
                return workflow.retryPhoto(id)
              }}
              onReplace={(id) => {
                timeline.interrupt()
                return workflow.replacePhoto({ id })
              }}
              onPreview={(photo) =>
                Taro.previewImage({
                  urls: state.photos.filter((p) => p.path).map((p) => p.path),
                  current: photo.path
                })
              }
            />
            <ScrollView
              className="timeline"
              scrollY
              enhanced
              scrollIntoView={timeline.anchor}
              onScrollToUpper={state.controls.sessionUnavailable ? undefined : () => timeline.loadOlder({ manual: false })}
              onScroll={timeline.onScroll}
              onTouchMove={timeline.onUserIntent}
            >
              <View className="scroll-content scroll-content--timeline">
                {state.hasOlder && !state.controls.sessionUnavailable && (
                  <Notice onRetry={() => timeline.loadOlder({ manual: true })} label="读取更早轮次">
                    {state.loadingOlder ? '正在读取…' : '还有更早的创作'}
                  </Notice>
                )}
                {timeline.notice && (!state.controls.sessionUnavailable || !timeline.notice.onRetry) && (
                  <Notice onRetry={timeline.notice.onRetry} label={timeline.notice.label}>
                    {timeline.notice.message}
                  </Notice>
                )}
                {state.loading && (
                  <View className="inline-loading">
                    <Brand animated />
                  </View>
                )}
                {state.account?.configured === false && !state.controls.sessionUnavailable && (
                  <Notice>生图服务尚未配置。可以先选图和编辑，输入会保留。</Notice>
                )}
                {(sessionNotice || state.error) && (
                  <Notice
                    secondaryAction={sessionNotice?.secondaryAction === 'recheck' ? {
                      label: '重新检查',
                      onClick: () => { timeline.interrupt(); return workflow.recheckSession() }
                    } : state.errorCode === 'CREDITS_INSUFFICIENT' && !state.submission ? {
                      label: openingCredits ? '查看积分 · 正在打开…' : '查看积分',
                      onClick: () => { timeline.interrupt(); return creditsNavigation.openCredits() }
                    } : undefined}
                    onRetry={() => {
                      timeline.interrupt()
                      return sessionNotice ? readAction() : workflow.retryError()
                    }}
                    label={creationNoticeLabel({ state, sessionNotice })}
                  >
                    {sessionNotice?.message}{state.error}
                  </Notice>
                )}
                {state.corruptPending && <Notice>本机待确认请求不完整，原始记录已保留，未发送新请求。</Notice>}
                {state.localInputRecovery?.message && (
                  <Notice
                    onRetry={state.localInputRecovery.canRetryLocalSave ? () => {
                      timeline.interrupt()
                      return workflow.resumeDraftSave({ target: 'local-input' })
                    } : undefined}
                    label={state.localInputRecovery.phase === 'pending-ready' ? '保存本机输入' : '重试本机保存'}
                  >{state.localInputRecovery.message}</Notice>
                )}
                {state.storageError && !state.localInputRecovery?.ownsStorageError && <Notice>{state.storageError}</Notice>}
                {state.draftPaused && (
                  <Notice onRetry={state.controls.sessionUnavailable ? undefined : () => { timeline.interrupt(); return workflow.resumeDraftSave({ target: 'remote-draft' }) }} label="恢复保存">
                    {pausedDraftMessage(state.controls)}
                  </Notice>
                )}
                {!state.rounds.length && mode === 'effect' && (
                  <TemplateGuide
                    template={template}
                    compact={state.photos.length > 0}
                    onOpen={() =>
                      Taro.navigateTo({
                        url: `/pages/example/index?key=${template.displayConfig.showcaseShareKeys[0]}`
                      })
                    }
                  />
                )}
                {!state.rounds.length && mode === 'free' && (
                  <View className="creation-intro">
                    <Brand large />
                    <Text className="section-title">把想法变成图片</Text>
                  </View>
                )}
                {state.rounds.map((round) => (
                  <RoundCard
                    key={round.id}
                    round={round}
                    artifacts={state.artifacts}
                    accountKey={account.accountKey}
                    onFavorite={(id) => {
                      timeline.interrupt()
                      return workflow.toggleFavorite(id)
                    }}
                    onRegenerate={(id) => {
                      timeline.interrupt()
                      return workflow.prepareRegeneration(id)
                    }}
                    onOpen={(id) => timeline.openArtifact({ taskId: round.id, artifactId: id })}
                    onCarryBack={(id) => {
                      timeline.interrupt()
                      return carryBackInput({ taskId: id })
                    }}
                    onRefresh={state.controls.sessionUnavailable ? undefined : () => timeline.focusRound({ taskId: round.id, mode: 'preserve' })}
                  />
                ))}
                {state.sourceArtifactId && (
                  <Notice>按原作品输入和版本换一张，不使用当前草稿。确认报价后点击底部「确认换一张」。</Notice>
                )}
                {mode === 'effect' && (
                  <EffectNotes
                    key={`${state.templateId}:${state.templateVersionId}`}
                    userNotes={state.userNotes}
                    schema={template?.inputSchema}
                    onNotes={(value) => {
                      timeline.interrupt()
                      return workflow.setUserNotes(value)
                    }}
                    onExpand={timeline.revealNotes}
                    onFocus={(event) => {
                      if (liveWorkflow.current !== workflow) return
                      notesOwner.current = workflow
                      setNotesFocused(workflow)
                      viewport.onFocus?.(event)
                    }}
                    onKeyboardHeightChange={viewport.onKeyboardHeightChange}
                    onBlur={(event) => {
                      if (liveWorkflow.current !== workflow || notesOwner.current !== workflow) return
                      notesOwner.current = null
                      setNotesFocused(null)
                      // Cancel only this notes reveal, never a newer round intent.
                      notesCancel.current?.()
                      notesCancel.current = null
                      viewport.onBlur?.(event)
                    }}
                  />
                )}
                <View id="timeline-end" className="timeline-end" />
              </View>
            </ScrollView>
            <CreationComposer
              mode={mode}
              description={state.description}
              schema={template?.inputSchema}
              controls={controls}
              keyboard={viewport.keyboard}
              onDescription={(value) => {
                timeline.interrupt()
                return workflow.setDescription(value)
              }}
              onGenerate={() => {
                timeline.interrupt()
                return workflow.generate()
              }}
              onFocus={viewport.onFocus}
              onKeyboardHeightChange={viewport.onKeyboardHeightChange}
              onBlur={viewport.onBlur}
            />
          </>
        )}
      </View>
    </>
  )
}
