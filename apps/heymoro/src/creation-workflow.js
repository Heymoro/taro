import { creationInput, validateInput, validatePhotos } from './creation-input'
import { readCarryBackSource } from './features/creation/carry-back-input'
import { entryConfiguration } from './features/creation/entry-draft'
import { createInitialInputRecovery } from './features/creation/initial-input-recovery'
import { movePhotoSlot } from './features/creation/photo-order'
import { isReadTransportError, readPollDelay } from './features/creation/read-poll-policy'
import { readPendingSubmission } from './features/creation/recovery-contract'
import {
  initialSessionAvailability, isFormalSessionNotFound, isUnavailableSession,
  sameTerminalInterest, SESSION_UNAVAILABLE_MESSAGE,
  sessionAvailable, sessionUnavailable
} from './features/creation/session-read-policy'
import { createTaskHistory } from './features/creation/task-history'

export const ACTIVE_STATUSES = ['queued', 'running', 'unknown']
const active = (task) => ACTIVE_STATUSES.includes(task.status)
const copy = (value) => JSON.parse(JSON.stringify(value))
// Compare only photo projections; persisted JSON and recovery fingerprints keep their original representation.
const photoProjectionJson = (photo) =>
  JSON.stringify(Object.fromEntries(Object.keys(photo).sort().map((key) => [key, photo[key]])))
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function creationError(error) {
  return (
    {
      GENERATION_NOT_CONFIGURED: '生图服务尚未配置，输入已保留',
      CREDITS_INSUFFICIENT: '可用积分不足，输入已保留',
      GENERATION_IN_PROGRESS: '上一张作品仍在处理中，请稍等',
      AUTH_UNCONFIGURED: '微信登录尚未配置，输入已保留',
      AUTH_REQUIRED: '登录已过期，输入已保留，请重新登录',
      UNAUTHENTICATED: '登录已过期，输入已保留，请重新登录',
      FILE_NOT_ATTACHABLE: '部分照片已失效，请重新添加',
      TEMPLATE_UNAVAILABLE: '玩法暂不可用，历史和输入已保留',
      IDEMPOTENCY_CONFLICT: '请求内容不一致，原请求已保留，请重新进入核对',
      QUOTE_EXPIRED: '报价已过期，请查看新报价后再次点击生成',
      QUOTE_CHANGED: '报价已变化，请查看新报价后再次点击生成'
    }[error?.code || error?.message] || '暂时连接不上，输入已保留，请重试'
  )
}

/** One closure per session: no UI, native calls, or account facts are synthesized here. */
export function createWorkflow({
  api,
  files,
  storage,
  key,
  template = null,
  templateId = null,
  sessionId = null,
  makeId,
  isCurrent = () => true
}) {
  let disposed = false
  let adding = false
  let refreshFlight = null
  let recheckFlight = null
  let readEpoch = 0
  let errorRevision = 0
  let readErrorRevision = null
  let readLaneErrorRevision = null
  let editVersion = 0
  let carryEpoch = 0
  let carryCandidate = null
  let pageVisible = true
  let quoteEpoch = 0
  let draftFlight = null
  let draftDirty = false
  let quoteFlight = null
  let publishingQuoteAttempt = false
  let originalConfirmationFlight = false
  let localResumeFlight = null
  let sessionFlight = null
  let draftKey = sessionId ? `session:${sessionId}` : key
  let renameEpoch = 0
  let titleEpoch = 0
  const entryMode = template?.mode || (templateId ? 'effect' : 'free')
  const entryTemplateId = template?.templateId || templateId
  let recoveryKey = sessionId
    ? `unsettled:session:${sessionId}`
    : `unsettled:template:${entryMode === 'free' ? 'free' : entryTemplateId}`
  let entryBinding = {
    mode: entryMode,
    templateId: template?.templateId || templateId,
  }
  let protectedDraftKey = null
  let preservedEntryInput = false
  let state = {
    template,
    mode: template?.mode || null,
    templateId: template?.templateId || templateId,
    sessionId,
    sessionAvailability: initialSessionAvailability(),
    session: null,
    description: '',
    userNotes: '',
    photos: [],
    rounds: [],
    artifacts: {},
    quote: null,
    quoteAttemptRevision: 0,
    quoting: false,
    sourceArtifactId: null,
    carryBackSourceTaskId: null,
    sessionRequest: null,
    submission: null,
    submitting: false,
    loading: false,
    error: '',
    errorAction: null,
    errorCode: null,
    storageError: '',
    draftPaused: false,
    draftSaving: false,
    account: null,
    legacyRecord: null,
    corruptPending: false,
    olderCursor: null,
    hasOlder: false,
    loadingOlder: false,
    readRecovery: { phase: 'idle', failureCount: 0, nextAttemptAt: null }
  }
  const listeners = new Set()
  const uploads = new Set()
  const favoriteEpochs = new Map()
  const current = () => !disposed && isCurrent()
  const emit = () => listeners.forEach((fn) => fn())
  const unavailable = () => isUnavailableSession({ availability: state.sessionAvailability, sessionId: state.sessionId })
  const continuation = () => Object.freeze({
    eligibleAtStart: !unavailable(),
    terminalEpoch: state.sessionAvailability.terminalEpoch,
    readEpoch,
    sessionId: state.sessionId
  })
  const ordinaryInterested = (ticket) => ticket.eligibleAtStart && current() && pageVisible &&
    ticket.readEpoch === readEpoch && (ticket.sessionId === null || ticket.sessionId === state.sessionId) &&
    sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) && !unavailable()
  const historyInterested = (ticket) => ticket.eligibleAtStart && current() &&
    ticket.sessionId === state.sessionId &&
    sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) && !unavailable()
  const entry = Object.freeze({
    key: sessionId ? `session:${sessionId}` : key,
    kind: sessionId ? 'session' : 'template',
    mode: sessionId && !template && !templateId ? null : entryMode,
    templateId: template?.templateId || templateId,
    sessionId
  })
  const recovery = createInitialInputRecovery({
    storage,
    entry,
    originStorageKey: key,
    isInterested: ({ epoch }) => current() && pageVisible && readEpoch === epoch
  })
  let storageFeedback = null
  let initialSourceProjected = false
  function applyRecovery(result, { project = true } = {}) {
    const facts = result.facts
    if (project && result.projection) {
      initialSourceProjected = facts.sourceReady
      const projection = result.projection
      const patch = {}
      for (const field of ['description', 'userNotes', 'photos', 'carryBackSourceTaskId', 'mode',
        'templateId', 'sessionId', 'sessionRequest', 'submission', 'draftPaused', 'legacyRecord', 'corruptPending']) {
        if (Object.prototype.hasOwnProperty.call(projection, field)) {
          patch[field] = field === 'photos'
            ? projection.photos.map((photo) => {
              const existing = state.photos.find((slot) => slot.id === photo.id)
              if (existing && photo.path === '' && existing.path && existing.mediaId === photo.mediaId) photo = { ...photo, path: existing.path }
              if (existing && photoProjectionJson(existing) === photoProjectionJson(photo)) return existing
              return photo.status === 'uploading' ? { ...photo, status: 'failed', error: '上传未完成，点此重试' } : photo
            })
            : state[field] && JSON.stringify(state[field]) === JSON.stringify(projection[field]) ? state[field] : projection[field]
        }
      }
      for (const field of ['sessionRequest', 'submission']) {
        if (patch[field]) patch[field] = freeze(patch[field])
      }
      state = { ...state, ...patch }
    }
    if (result.error && (!storageFeedback || result.error.revision >= storageFeedback.revision)) {
      storageFeedback = result.error
      state = { ...state, storageError: result.error.message }
    } else if (!result.error && ['saved', 'ready'].includes(result.status) && storageFeedback &&
      (storageFeedback.owner === 'protected-entry' ? facts.sourceReady : storageFeedback.owner === 'initial-input' ? !facts.activeIntent && !facts.hasUnsavedOverlay : result.status === 'saved')) {
      state = { ...state, storageError: '' }; storageFeedback = null
    }
    draftKey = facts.primaryKey
    recoveryKey = facts.recoveryKey
    preservedEntryInput = facts.preserved
    protectedDraftKey = !facts.sourceReady && !facts.activeIntent ? draftKey : null
    state = {
      ...state,
      localInputRecovery: {
        phase: facts.phase,
        canRetryLocalSave: facts.canRetryLocalSave,
        hasUnsavedOverlay: facts.hasUnsavedOverlay,
        message: facts.message,
        ownsStorageError: !!result.error && result.error.owner === 'initial-input' &&
        storageFeedback?.owner === result.error.owner && storageFeedback?.revision === result.error.revision
      }
    }
    entryBinding = {
      mode: state.mode || entryBinding.mode,
      templateId: state.templateId,
    }
    return result
  }
  let initialConfigResolved = false
  let inspectedInput = false
  function inspectInput() {
    const inspected = recovery.inspect({ epoch: readEpoch })
    const needsProjection = !inspectedInput || (!initialSourceProjected && inspected.facts.sourceReady)
    inspectedInput = true
    const result = needsProjection ? applyRecovery(inspected) : inspected
    if (template && !initialConfigResolved) {
      initialConfigResolved = true
      return applyRecovery(recovery.resolveConfiguration({ epoch: readEpoch, config: template }))
    }
    return result
  }
  function admission(operation) {
    inspectInput()
    return applyRecovery(recovery.admit({ epoch: readEpoch, operation }), { project: false }).status === 'ready'
  }
  function admitOrdinary(operation, ticket) {
    return ordinaryInterested(ticket) && admission(operation) && ordinaryInterested(ticket)
  }
  const persist = () => {
    if (state.legacyRecord || state.corruptPending) return false
    // Old unfinished requests retain their complete durable identity until the
    // original outcome is confirmed. Ordinary and new records have no version.
    const legacyVersion = state.sessionRequest?.templateVersionId ?? state.submission?.templateVersionId
    const record = copy({
      protocol: 2,
      mode: state.mode,
      sessionId: state.sessionId,
      templateId: state.templateId,
      ...(legacyVersion === undefined ? {} : { templateVersionId: legacyVersion }),
      description: state.description,
      userNotes: state.userNotes,
      photos: state.photos,
      carryBackSourceTaskId: state.carryBackSourceTaskId,
      sessionRequest: state.sessionRequest,
      submission: state.submission,
      draftPaused: state.draftPaused,
      recoveryKey
    })
    const result = applyRecovery(recovery.saveNormal({ epoch: readEpoch, record }), { project: false })
    return result.status === 'saved'
  }
  const update = (patch, save = true) => {
    if (!current()) return false
    if (
      Object.prototype.hasOwnProperty.call(patch, 'error') &&
      !Object.prototype.hasOwnProperty.call(patch, 'errorAction')
    ) {
      patch = { ...patch, errorAction: null }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error') && !Object.prototype.hasOwnProperty.call(patch, 'errorCode')) {
      patch = { ...patch, errorCode: null }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) errorRevision++
    state = { ...state, ...patch }
    const saved = !save || persist()
    state = { ...state, controls: controls() }
    emit()
    return saved
  }
  function updateReadFeedback(patch, { offline = false } = {}) {
    // Record expected ownership before emit: a subscriber may synchronously publish another lane.
    if (state.error && readLaneErrorRevision !== errorRevision) {
      const facts = { ...patch }
      delete facts.error
      delete facts.errorAction
      delete facts.errorCode
      return update(facts, false)
    }
    readLaneErrorRevision = errorRevision + 1
    if (offline) readErrorRevision = readLaneErrorRevision
    return update(patch, false)
  }
  function recordUnavailable({ sessionId, error }) {
    invalidateCarryBack()
    const clearError = readLaneErrorRevision !== null && readLaneErrorRevision === errorRevision
    update({
      sessionAvailability: sessionUnavailable({ availability: state.sessionAvailability, sessionId, error }),
      loading: false,
      loadingOlder: false,
      quoting: false,
      draftSaving: false,
      readRecovery: { ...state.readRecovery, phase: 'unavailable', nextAttemptAt: null },
      ...(clearError ? { error: '' } : {})
    }, false)
  }
  const input = () => creationInput(state)
  const hasUnavailable = () => state.photos.some((photo) => photo.status === 'unavailable')
  const hasPendingCarryBackPhotos = () =>
    hasUnavailable() ||
    (!!state.carryBackSourceTaskId && state.photos.some((photo) => photo.status !== 'ready'))
  const inputError = () => {
    if (hasUnavailable()) return '部分照片已失效，请补选或移除后继续'
    if (state.photos.some((photo) => photo.status !== 'ready')) {
      return '请先完成照片上传，失败的照片可以重试'
    }
    return validateInput({ input: input(), mode: state.template?.mode, schema: state.template?.inputSchema })
  }
  const hasActive = () => !!state.session?.runningTask || state.rounds.some(active)
  function reportPreservedEntryInput() {
    if (preservedEntryInput) {
      updateReadFeedback({ error: '旧入口输入未匹配当前玩法，原记录已保留；当前内容可继续编辑' })
    }
  }
  function offerEntryQuote() {
    if (
      state.template && !state.quote && !state.storageError && !protectedDraftKey &&
      !state.sessionId && !state.sessionRequest && !state.submission &&
      !state.legacyRecord && !state.corruptPending && !hasActive() && !inputError()
    ) {
      updateReadFeedback({
        error: preservedEntryInput
          ? '旧入口输入已另行保留；当前输入请重试获取报价，确认费用后再生成'
          : '输入已保留，请重试获取报价，确认费用后再生成',
        errorAction: 'quote'
      })
    }
  }
  const validQuote = () => !!state.quote && !unavailable() &&
    (state.quote.terminalEpoch ?? 0) === state.sessionAvailability.terminalEpoch &&
    Date.parse(state.quote.validUntil) > Date.now()
  function sessionNotice() {
    const facts = recovery.getFacts()
    const frozen = facts.frozen === 'valid' && (state.submission || state.sessionRequest)
    if (unavailable()) {
      return {
        message: SESSION_UNAVAILABLE_MESSAGE + (frozen ? '原请求结果待核对。' : ''),
        action: frozen ? 'confirm' : 'recheck',
        label: frozen ? state.sessionRequest ? '确认会话结果' : '确认提交结果' : '重新检查',
        secondaryAction: frozen ? 'recheck' : null
      }
    }
    if (state.error && state.errorAction === 'quote') return null
    if (state.sessionAvailability.status === 'available' && state.sessionAvailability.sessionId === state.sessionId &&
      state.sessionAvailability.terminalEpoch > 0 && facts.sourceReady && !facts.activeIntent &&
      facts.frozen === 'none' && !state.submission && !state.sessionRequest && !state.submitting &&
      !state.legacyRecord && !state.corruptPending && !state.storageError && !!state.template &&
      !hasActive() && !hasPendingCarryBackPhotos() && !inputError() && !validQuote()) {
      return { message: '原会话已可读取，请重新获取报价后再生成。', action: 'quote', label: '重新获取报价' }
    }
    return null
  }
  const canReorderPhotos = () =>
    current() &&
    pageVisible &&
    !state.legacyRecord &&
    !state.corruptPending &&
    !state.submitting &&
    !state.submission &&
    !state.sessionRequest
  function movePhoto({ slotId, targetIndex, expectedIds }) {
    inspectInput()
    if (!canReorderPhotos()) return false
    const photos = movePhotoSlot({ photos: state.photos, slotId, targetIndex, expectedIds })
    return photos ? edit({ photos }) : false
  }
  function hasPhotoUploadConfiguration() {
    const max = state.template?.inputSchema?.maxImages
    return Number.isSafeInteger(max) && max > 0
  }
  function controls() {
    let generateLabel = state.sourceArtifactId ? '确认换一张' : '生成'
    if (state.quoting) generateLabel = '正在获取报价'
    if (hasActive()) generateLabel = '处理中'
    if (state.sessionRequest) generateLabel = '确认会话结果'
    if (state.submission) generateLabel = '确认提交结果'
    if (state.submitting) generateLabel = '提交中'
    return {
      activeUploadIds: Array.from(uploads),
      photoBatchBusy: adding,
      sessionNotice: sessionNotice(),
      sessionUnavailable: unavailable(),
      canRename: !unavailable(),
      canReorderPhotos: canReorderPhotos(),
      canSelectPhotos: !unavailable() && recovery.getFacts().sourceReady && !recovery.getFacts().activeIntent &&
        recovery.getFacts().frozen !== 'conflict' && !recovery.getFacts().knownCreationSessionId && hasPhotoUploadConfiguration() && current() && pageVisible,
      canGenerate:
        current() &&
        !state.submitting &&
        !state.legacyRecord &&
        !state.corruptPending &&
        (!!state.submission ||
          !!state.sessionRequest ||
          (!unavailable() && !hasActive() &&
            !hasPendingCarryBackPhotos() &&
            (state.sourceArtifactId || !inputError()) &&
            validQuote())),
      generateLabel,
      costCredits: state.submission?.costCredits ?? state.quote?.costCredits ?? null
    }
  }
  // Draft PUTs are serialized. Unknown outcome permanently closes this automatic lane until explicit resume.
  async function flushDraft() {
    const ticket = continuation()
    if (
      !ordinaryInterested(ticket) ||
      !current() ||
      draftFlight ||
      !draftDirty ||
      state.draftPaused ||
      state.legacyRecord ||
      state.corruptPending ||
      !state.sessionId ||
      !state.template ||
      state.photos.some((p) => p.status !== 'ready')
    ) {
      return
    }
    if (!admission('normal-save') || !ordinaryInterested(ticket)) return
    const snapshot = input()
    if (
      validateInput({
        input: snapshot,
        mode: state.template.mode,
        schema: state.template.inputSchema,
        draft: true
      })
    ) {
      return
    }
    if (!persist() || !ordinaryInterested(ticket)) {
      emit()
      return
    }
    const flight = {}
    draftFlight = flight
    draftDirty = false
    update({ draftSaving: true }, false)
    let succeeded = false
    try {
      if (!ordinaryInterested(ticket)) return
      await api.putDraft({ sessionId: state.sessionId, input: copy(snapshot) })
      succeeded = ordinaryInterested(ticket)
    } catch (error) {
      if (ordinaryInterested(ticket)) {
        draftDirty = true
        update({
          draftPaused: true,
          error: error.isOutcomeUnknown
            ? '草稿保存结果待确认。后续编辑仅保存在本机；确认后可恢复保存'
            : '草稿远端保存未完成，输入保留在本机，可恢复保存'
        })
      }
    } finally {
      if (draftFlight === flight) {
        draftFlight = null
        update({ draftSaving: false }, false)
        if (succeeded && ordinaryInterested(ticket)) flushDraft()
      }
    }
  }
  function schedule() {
    const ticket = continuation()
    Promise.resolve().then(() => {
      if (ordinaryInterested(ticket)) {
        flushDraft()
        if (
          ordinaryInterested(ticket) && !state.submission &&
          !state.sessionRequest &&
          !state.legacyRecord &&
          !hasActive() &&
          !inputError()
        ) {
          prepareQuote()
        }
      }
    })
  }
  function edit(patch) {
    if (!current() || !pageVisible) return false
    inspectInput()
    editVersion++
    invalidateCarryBack()
    quoteEpoch++
    draftDirty = true
    // Provenance gates only an unfinished carry-back repair, not later ordinary draft edits.
    if (patch.photos?.every((photo) => photo.status === 'ready')) {
      patch = { ...patch, carryBackSourceTaskId: null }
    }
    const keepEntryReadError = !state.sessionId && !state.template &&
      readErrorRevision === errorRevision && !!state.error
    const local = recovery.noteEdit({ epoch: readEpoch, patch })
    applyRecovery(local, { project: false })
    const ordinary = local.status === 'ready' && !local.facts.activeIntent
    const saved = update({
      ...patch,
      quote: null,
      quoting: false,
      sourceArtifactId: null,
      ...(keepEntryReadError ? {} : { error: '' })
    }, ordinary)
    const accepted = ordinary ? saved : local.status === 'saved' || (local.status === 'pending' && !local.facts.hasUnsavedOverlay)
    if (!ordinary) applyRecovery(local)
    // A failed synchronous local write must not initiate any remote operation.
    if (ordinary && saved) schedule()
    return accepted
  }
  async function ensureSession() {
    const ticket = continuation()
    const epoch = readEpoch
    const interested = () => current() && pageVisible && readEpoch === epoch
    if (!interested()) return false
    inspectInput()
    if (recovery.getFacts().knownCreationSessionId) return false
    if (state.sessionId) return ordinaryInterested(ticket)
    if (!state.sessionRequest && !ordinaryInterested(ticket)) return false
    if (!state.sessionRequest && (!admission('new-session') || !ordinaryInterested(ticket))) return false
    if (sessionFlight) return sessionFlight
    if (
      (!state.template && !state.sessionRequest) ||
      !interested() ||
      state.legacyRecord ||
      state.corruptPending
    ) {
      return false
    }
    let request =
      state.sessionRequest ||
      freeze({
        templateId: state.template.templateId,
        clientRequestId: makeId()
      })
    if (state.sessionRequest) {
      let original = recovery.readFrozen({ epoch })
      if (!original.record && recovery.getFacts().frozen === 'valid' && persist()) original = recovery.readFrozen({ epoch })
      if (original.record?.sessionRequest) request = freeze(copy(original.record.sessionRequest))
      if (!original.record || !interested()) return false
      // Source-only legacy F needs its crash envelope, but an existing receipt
      // stage must never be serialized backwards as the original request.
      if (original.needsEnvelope &&
        applyRecovery(recovery.saveNormal({ epoch, record: original.record }), { project: false }).status !== 'saved') return false
      if (!interested()) return false
    } else if (!update({ sessionRequest: request }) || !interested()) return false
    const flight = (async () => {
      try {
        const session = await api.createSession({ templateId: request.templateId, clientRequestId: request.clientRequestId })
        if (!interested()) return false
        if (
          session.templateId !== request.templateId
        ) {
          throw Object.assign(Error('INVALID_RESPONSE'), { isOutcomeUnknown: true })
        }
        const settled = applyRecovery(recovery.settleSession({ epoch, receipt: session }))
        const saved = settled.status === 'saved'
        if (saved) update({ sessionId: session.id, session, sessionRequest: null }, false)
        if (!saved) {
          update(
            {
              sessionId: null,
              session: null,
              sessionRequest: request,
              error: '会话已确认，本机未结记录尚未更新，请再次核对原请求'
            },
            false
          )
        }
        if (saved && interested() && ordinaryInterested(ticket)) flushDraft()
        return saved && interested()
      } catch (error) {
        if (!interested()) return false
        update({
          error:
            error.isOutcomeUnknown || error.retryable
              ? '创作会话受理结果待确认，再试仍核对同一请求'
              : creationError(error)
        })
        return false
      }
    })()
    sessionFlight = flight
    try {
      return await flight
    } finally {
      if (sessionFlight === flight) sessionFlight = null
    }
  }
  async function prepareQuote() {
    const ticket = continuation()
    if (!current() || unavailable()) return
    const attemptEpoch = readEpoch
    const attemptRevision = state.quoteAttemptRevision + 1
    if (publishingQuoteAttempt) {
      state = { ...state, quoteAttemptRevision: attemptRevision }
      return
    }
    publishingQuoteAttempt = true
    try { update({ quoteAttemptRevision: attemptRevision }, false) } finally { publishingQuoteAttempt = false }
    if (!ordinaryInterested(ticket) || readEpoch !== attemptEpoch || state.quoteAttemptRevision !== attemptRevision) return
    inspectInput()
    if (recovery.getFacts().knownCreationSessionId || recovery.getFacts().creationPending) return
    if (state.sessionRequest && !recovery.getFacts().activeIntent && !(await ensureSession())) return
    if (!ordinaryInterested(ticket) || !admission('quote') || !ordinaryInterested(ticket)) return
    if (
      !current() || state.submission || state.legacyRecord || state.corruptPending || hasActive() ||
      hasPendingCarryBackPhotos()
    ) {
      return
    }
    if (state.sessionRequest && !(await ensureSession())) return
    const sourceArtifactId = state.sourceArtifactId
    const error = sourceArtifactId ? '' : inputError()
    if (error) {
      update({ quote: null }, false)
      return
    }
    if (validQuote()) return state.quote
    if (state.storageError && !persist()) {
      emit()
      return
    }
    const epoch = quoteEpoch
    if (quoteFlight?.epoch === epoch && quoteFlight.terminalEpoch === ticket.terminalEpoch) return quoteFlight.promise
    const flight = { epoch, terminalEpoch: ticket.terminalEpoch }
    quoteFlight = flight
    const promise = Promise.resolve().then(async () => {
      if (!ordinaryInterested(ticket)) return
      update({ quoting: true }, false)
      try {
        if (!sourceArtifactId && !(await ensureSession())) return
        if (!ordinaryInterested(ticket) || readEpoch !== attemptEpoch || epoch !== quoteEpoch || !admission('quote') || !ordinaryInterested(ticket)) return
        const request = sourceArtifactId
          ? { sourceArtifactId }
          : { sessionId: state.sessionId, input: copy(input()) }
        const quote = await api.quote(request)
        if (!ordinaryInterested(ticket) || readEpoch !== attemptEpoch || epoch !== quoteEpoch || !admission('quote') || !ordinaryInterested(ticket)) return
        if (!sourceArtifactId && quote.templateId !== state.templateId) {
          throw Error('TEMPLATE_UNAVAILABLE')
        }
        update({ quote: freeze({ ...quote, binding: request, terminalEpoch: ticket.terminalEpoch }), error: '' }, false)
        return quote
      } catch (error) {
        if (ordinaryInterested(ticket) && epoch === quoteEpoch) {
          update({ quote: null, error: creationError(error), errorAction: 'quote', errorCode: !error.isOutcomeUnknown && (error.code || error.message) === 'CREDITS_INSUFFICIENT' ? 'CREDITS_INSUFFICIENT' : null }, false)
        }
      } finally {
        if (quoteFlight === flight) {
          quoteFlight = null
          update({ quoting: false }, false)
        }
      }
    })
    flight.promise = promise
    return promise
  }
  function mergeRounds(incoming) {
    const rows = new Map(state.rounds.map((row) => [row.id, row]))
    incoming.forEach((row) => {
      const prior = rows.get(row.id)
      // An idempotency receipt can be older than already retrieved terminal history.
      if (prior && !active(prior) && active(row)) return
      rows.set(row.id, { ...prior, ...row })
    })
    update({ rounds: [...rows.values()].sort((a, b) => a.roundNo - b.roundNo) }, false)
  }
  async function readArtifacts({ rounds, isInterested = () => true, feedback = 'workflow', onTransportFailure }) {
    const sessionId = state.sessionId
    const interested = () => current() && pageVisible && state.sessionId === sessionId && isInterested()
    let result = 'fresh'
    for (const round of rounds) {
      for (const artifactId of round.artifactIds || []) {
        if (!interested()) return 'pending'
        if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
          result = 'failed'
          if (feedback === 'workflow') update({ error: creationError(Error('INVALID_RESPONSE')) }, false)
          continue
        }
        if (state.artifacts[artifactId]?.saving) {
          if (result !== 'failed') result = 'pending'
          continue
        }
        const epoch = favoriteEpochs.get(artifactId) || 0
        try {
          let warning = ''
          const artifact = await api.artifact({
            artifactId,
            isInterested: interested,
            onWarning: (value) => {
              warning = value
            }
          })
          if (!interested()) return 'pending'
          if (
            epoch !== (favoriteEpochs.get(artifactId) || 0) ||
            state.artifacts[artifactId]?.saving
          ) {
            if (result !== 'failed') result = 'pending'
            continue
          }
          if (
            artifact?.id !== artifactId ||
            artifact.taskId !== round.id ||
            artifact.sessionId !== sessionId
          ) {
            throw Error('INVALID_RESPONSE')
          }
          update({ artifacts: { ...state.artifacts, [artifact.id]: artifact } }, false)
          if (warning && result !== 'failed') result = 'pending'
        } catch (error) {
          if (!interested()) return 'pending'
          if (isReadTransportError(error)) {
            onTransportFailure?.()
            if (feedback === 'workflow') update({ error: creationError(error) }, false)
            return 'failed'
          }
          if (error?.message === 'FAVORITE_PENDING') {
            if (result !== 'failed') result = 'pending'
          } else {
            result = 'failed'
            if (feedback === 'workflow') update({ error: creationError(error) }, false)
          }
        }
      }
    }
    return result
  }
  const taskHistory = createTaskHistory({
    api: { tasks: (args) => api.tasks(args), task: (args) => api.task(args) },
    readHistory: () => ({
      sessionId: state.sessionId,
      rounds: state.rounds,
      olderCursor: state.olderCursor,
      hasOlder: state.hasOlder
    }),
    mergePage: ({ page, advance, isInterested = () => true }) => {
      if (!isInterested()) return
      mergeRounds(page.items)
      if (!isInterested()) return
      if (advance) {
        update({ olderCursor: page.hasMore ? page.nextCursor : null, hasOlder: page.hasMore }, false)
      }
    },
    mergeTarget: ({ task }) => mergeRounds([task]),
    setLoadingOlder: ({ loadingOlder }) => update({ loadingOlder }, false),
    readArtifacts: (args) => readArtifacts({ ...args, feedback: 'caller' }),
    isCurrent: current,
    canFocus: () => pageVisible
  })
  function canRecoverEntryConfiguration({ accountSucceeded, reason }) {
    return accountSucceeded && ['manual', 'show'].includes(reason) && !state.template &&
      !state.submission && !state.sessionRequest && !state.legacyRecord &&
      !state.corruptPending && !hasActive()
  }
  function fetchEntryConfiguration(binding) {
    return binding.mode === 'free'
      ? api.freePreset()
      : api.template({
        templateId: binding.templateId,
      })
  }
  function applyEntryConfiguration(config) {
    const patch = entryConfiguration({ config, ...entryBinding })
    entryBinding = {
      mode: patch.mode,
      templateId: patch.templateId,
    }
    applyRecovery(recovery.resolveConfiguration({ epoch: readEpoch, config }))
    update(patch, false)
  }
  async function recoverEntryConfiguration({ interested, failure }) {
    try {
      const config = await fetchEntryConfiguration({ ...entryBinding })
      if (!interested()) return { status: 'cancelled' }
      applyEntryConfiguration(config)
      if (!interested()) return { status: 'cancelled' }
      if (!interested()) return { status: 'cancelled' }
      reportPreservedEntryInput()
      if (!interested()) return { status: 'cancelled' }
      offerEntryQuote()
    } catch (error) {
      if (!interested()) return { status: 'cancelled' }
      failure(error)
    }
    return null
  }
  function refresh({ reason = 'manual' } = {}) {
    if (unavailable()) return Promise.resolve({ status: 'unavailable' })
    return runRefresh({ reason })
  }
  function recheckSession() {
    if (recheckFlight) return recheckFlight.promise
    const epoch = readEpoch
    const sessionId = state.sessionId
    const terminalEpoch = state.sessionAvailability.terminalEpoch
    const interested = () => current() && pageVisible && readEpoch === epoch &&
      state.sessionId === sessionId && state.sessionAvailability.terminalEpoch === terminalEpoch
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return Promise.resolve({ status: 'cancelled' })
    const previous = refreshFlight
    const flight = {}
    recheckFlight = flight
    flight.promise = Promise.resolve().then(async () => {
      if (previous) await previous.promise
      if (!interested()) return { status: 'cancelled' }
      return runRefresh({ reason: 'manual', recheck: true })
    }).finally(() => { if (recheckFlight === flight) recheckFlight = null })
    return flight.promise
  }
  function runRefresh({ reason, recheck = false }) {
    if (refreshFlight) return refreshFlight.promise
    if (!current() || !pageVisible) return Promise.resolve({ status: 'cancelled' })
    if (reason !== 'manual' && state.readRecovery.nextAttemptAt > Date.now()) {
      return Promise.resolve({ status: 'cancelled' })
    }
    const epoch = readEpoch
    const capturedSessionId = state.sessionId
    const ticket = continuation()
    const ownerInterested = () => current() && pageVisible && epoch === readEpoch && capturedSessionId === state.sessionId
    const interested = () => ownerInterested() &&
      sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) &&
      (recheck || !unavailable())
    const flight = { epoch }
    refreshFlight = flight
    // Assign before emitting: subscribers may re-enter refresh synchronously.
    flight.promise = Promise.resolve().then(async () => {
      let status = 'ok'
      let accountSucceeded = false
      const failure = (error) => {
        if (isReadTransportError(error)) {
          status = 'offline'
          updateReadFeedback({ error: creationError(error) }, { offline: true })
          return true
        }
        status = 'degraded'
        updateReadFeedback({ error: creationError(error) })
        return false
      }
      async function readConfiguration(session) {
        try {
          const config =
            session.mode === 'free'
              ? await api.freePreset()
              : await api.template({
                templateId: session.templateId,
              })
          if (!interested()) return { status: 'cancelled' }
          if (
            config.templateId !== session.templateId ||
            config.templateId !== session.templateId
          ) {
            throw Error('TEMPLATE_UNAVAILABLE')
          }
          applyRecovery(recovery.resolveConfiguration({ epoch, config }))
          update({ template: config, mode: config.mode }, false)
        } catch (error) {
          if (!interested()) return { status: 'cancelled' }
          if (isReadTransportError(error)) {
            failure(error)
            return { status }
          }
          status = 'degraded'
          updateReadFeedback({
            template: null,
            quote: null,
            error: '玩法暂不可用，历史和输入已保留；待确认请求仍可核对'
          })
        }
        return null
      }
      function settleRead() {
        if (refreshFlight === flight) {
          refreshFlight = null
          if (ownerInterested() && (interested() || status === 'unavailable')) {
            const failureCount =
              status === 'offline'
                ? state.readRecovery.failureCount + 1
                : status === 'ok'
                  ? 0
                  : state.readRecovery.failureCount
            const clearError =
              status === 'ok' && readErrorRevision !== null && readErrorRevision === errorRevision
            update(
              {
                loading: false,
                readRecovery: {
                  phase: unavailable() ? 'unavailable' : status === 'ok' ? 'ready' : status,
                  failureCount,
                  nextAttemptAt: status === 'unavailable' || unavailable() ? null : Date.now() + readPollDelay({ failureCount })
                },
                ...(clearError ? { error: '' } : {})
              },
              false
            )
            if (clearError) readErrorRevision = null
          } else {
            update(
              {
                loading: false,
                readRecovery: {
                  ...state.readRecovery,
                  phase: unavailable() ? 'unavailable' : state.readRecovery.failureCount ? 'offline' : 'idle'
                }
              },
              false
            )
          }
        }
      }
      try {
        if (!interested()) return { status: 'cancelled' }
        update(
          { loading: !state.session, readRecovery: { ...state.readRecovery, phase: 'reading' } },
          false
        )
        if (!interested()) return { status: 'cancelled' }
        try {
          const account = await api.account()
          if (!interested()) return { status: 'cancelled' }
          update({ account }, false)
          accountSucceeded = true
        } catch (error) {
          if (!interested()) return { status: 'cancelled' }
          if (failure(error)) return { status }
        }
        if (!interested()) return { status: 'cancelled' }
        if (!capturedSessionId) {
          if (canRecoverEntryConfiguration({ accountSucceeded, reason })) {
            const result = await recoverEntryConfiguration({ interested, failure })
            if (result) return result
          }
          return { status }
        }
        const titleReadEpoch = titleEpoch
        try {
          let loaded
          try {
            loaded = await api.getSession({ sessionId: capturedSessionId })
          } catch (error) {
            if (!interested()) return { status: 'cancelled' }
            if (isFormalSessionNotFound(error) && interested()) {
              status = 'unavailable'
              recordUnavailable({ sessionId: capturedSessionId, error })
              return { status }
            }
            throw error
          }
          if (!interested()) return { status: 'cancelled' }
          if (loaded?.id !== capturedSessionId) throw Error('INVALID_RESPONSE')
          update({ sessionAvailability: sessionAvailable({ availability: state.sessionAvailability, sessionId: capturedSessionId }) }, false)
          if (!interested()) return { status: 'cancelled' }
          const session =
            titleReadEpoch !== titleEpoch && state.session
              ? { ...loaded, title: state.session.title, titleSource: state.session.titleSource }
              : loaded
          update(
            { session, templateId: session.templateId },
            false
          )
          if (!interested()) return { status: 'cancelled' }
          applyRecovery(recovery.resolveSession({ epoch, session }))
          update({}, false)
          if (!interested()) return { status: 'cancelled' }
          const configuration = await readConfiguration(session)
          if (!interested()) return { status: 'cancelled' }
          if (configuration) return configuration
          if (recheck) return { status }
        } catch (error) {
          if (!interested()) return { status: 'cancelled' }
          if (isReadTransportError(error)) {
            failure(error)
            return { status }
          }
          status = 'degraded'
          updateReadFeedback({ template: null, quote: null, error: creationError(error) })
        }
        if (!interested()) return { status: 'cancelled' }
        if (unavailable()) return { status }
        // Configuration failures still permit the independent historical read lane.
        const history = await taskHistory.readLatest({ isInterested: interested })
        if (!interested() || history.status === 'cancelled') return { status: 'cancelled' }
        if (history.failureKind === 'transport') {
          failure({ code: 'REQUEST_OUTCOME_UNKNOWN', status: null, isOutcomeUnknown: true })
          return { status }
        }
        if (history.status === 'failed' || history.artifacts === 'failed') {
          failure(Error(history.reason || 'INVALID_RESPONSE'))
        }
        for (const round of state.rounds.filter(active)) {
          if (!interested()) return { status: 'cancelled' }
          try {
            const task = await api.task({ taskId: round.id })
            if (!interested()) return { status: 'cancelled' }
            mergeRounds([task])
            if (!interested()) return { status: 'cancelled' }
            let transportFailed = false
            const artifacts = await readArtifacts({
              rounds: [task],
              isInterested: interested,
              feedback: 'caller',
              onTransportFailure: () => {
                transportFailed = true
              }
            })
            if (!interested()) return { status: 'cancelled' }
            if (transportFailed) {
              failure({ code: 'REQUEST_OUTCOME_UNKNOWN', status: null, isOutcomeUnknown: true })
              return { status }
            }
            if (artifacts === 'failed') failure(Error('INVALID_RESPONSE'))
          } catch (error) {
            if (!interested()) return { status: 'cancelled' }
            if (failure(error)) return { status }
          }
        }
        if (!interested()) return { status: 'cancelled' }
        if (
          state.session?.runningTask &&
          state.rounds.some((r) => r.id === state.session.runningTask.id && !active(r))
        ) {
          update({ session: { ...state.session, runningTask: null } }, false)
        }
        return { status }
      } finally {
        settleRead()
      }
    })
    return flight.promise
  }
  async function restore() {
    if (unavailable()) return { status: 'unavailable' }
    const ticket = continuation()
    const epoch = readEpoch
    const interested = () => ordinaryInterested(ticket) && epoch === readEpoch
    inspectInput()
    update({}, false)
    if (!interested()) return { status: 'cancelled' }
    if (!state.sessionId && !state.template && !state.corruptPending && !state.legacyRecord) {
      try {
        const config = await fetchEntryConfiguration(entryBinding)
        if (!interested()) return { status: 'cancelled' }
        applyEntryConfiguration(config)
      } catch (error) {
        if (!interested()) return { status: 'cancelled' }
        const offline = isReadTransportError(error)
        const failureCount = state.readRecovery.failureCount + 1
        updateReadFeedback({ error: creationError(error), ...(offline ? { readRecovery: { phase: 'offline', failureCount, nextAttemptAt: Date.now() + readPollDelay({ failureCount }) } } : {}) }, { offline })
        return { status: isReadTransportError(error) ? 'offline' : 'degraded' }
      }
    }
    const result = await refresh({ reason: 'restore' })
    if (result.status === 'unavailable') return result
    if (!interested()) return { status: 'cancelled' }
    if (result.status === 'offline' || result.status === 'cancelled') return result
    await readPhotoPreviews({ isInterested: interested })
    if (!interested()) return { status: 'cancelled' }
    reportPreservedEntryInput()
    if (state.sessionId && !state.sessionRequest && !state.submission && !recovery.getFacts().activeIntent && recovery.getFacts().sourceReady) schedule()
    else offerEntryQuote()
    return result
  }
  async function upload(id) {
    const ticket = continuation()
    if (!ordinaryInterested(ticket) || !hasPhotoUploadConfiguration()) return
    const uploadEpoch = readEpoch
    if (!admitOrdinary('upload', ticket) || uploadEpoch !== readEpoch || !hasPhotoUploadConfiguration()) return
    // The first quote may still be creating this session. Capture upload ownership
    // only after its durable receipt has moved the draft to the session key.
    if (!(await ensureSession()) || !ordinaryInterested(ticket) ||
      uploadEpoch !== readEpoch || !hasPhotoUploadConfiguration()) return
    const sourceKey = draftKey
    const lane = recovery.getFacts().lane
    const photo = state.photos.find((p) => p.id === id)
    if (!photo || ['ready', 'unavailable'].includes(photo.status) || uploads.has(id)) return
    const uploadingPhoto = { ...photo, status: 'uploading' }
    const ownsUpload = () =>
      ordinaryInterested(ticket) &&
      pageVisible &&
      uploadEpoch === readEpoch &&
      draftKey === sourceKey &&
      recovery.getFacts().lane === lane &&
      state.photos.includes(uploadingPhoto)
    // Admission may call injected storage ports; recheck the captured invocation afterward.
    const interested = () => ownsUpload() && admission('upload') && ownsUpload()
    uploads.add(id)
    try {
      const saved = update({
        photos: state.photos.map((p) => (p.id === id ? uploadingPhoto : p))
      })
      if (!ownsUpload()) return
      if (!saved) {
        update(
          {
            photos: state.photos.map((slot) =>
              slot.id === id
                ? { ...photo, status: 'failed', error: '本机记录未保存，尚未上传，请重试' }
                : slot
            )
          },
          false
        )
        return
      }
      if (!interested() || !hasPhotoUploadConfiguration()) return
      const media = await files.upload(photo.path, photo.name)
      if (interested()) {
        edit({
          photos: state.photos.map((p) =>
            p.id === id ? { ...p, status: 'ready', mediaId: media.id, error: '' } : p
          )
        })
      }
    } catch {
      if (interested()) {
        update({
          photos: state.photos.map((p) =>
            p.id === id ? { ...p, status: 'failed', error: '上传失败，点此重试' } : p
          )
        })
      }
    } finally {
      uploads.delete(id)
      if (current()) {
        state = { ...state, controls: controls() }
        emit()
      }
    }
  }
  async function addPhotos() {
    const ticket = continuation()
    if (!ordinaryInterested(ticket) || !hasPhotoUploadConfiguration()) return
    if (adding || !current() || state.legacyRecord || !admitOrdinary('upload', ticket) || !hasPhotoUploadConfiguration()) return
    adding = true
    try {
      const schema = state.template.inputSchema
      if (state.photos.length >= schema.maxImages) throw Error(`最多添加 ${schema.maxImages} 张照片`)
      const version = editVersion
      let sourceKey = draftKey
      const picked = await files.choose(schema.maxImages - state.photos.length)
      // Native selection may hide/show the page; only its accepted return starts this batch epoch.
      const batchEpoch = readEpoch
      const batchCurrent = () =>
        current() && pageVisible && !unavailable() && hasPhotoUploadConfiguration() &&
        sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) &&
        readEpoch === batchEpoch
      const batchInterested = () => batchCurrent() && draftKey === sourceKey
      if (
        !batchInterested() || editVersion !== version || !picked?.length ||
        !admission('upload') || !batchInterested()
      ) return
      const error = validatePhotos({ photos: [...state.photos, ...picked], schema })
      if (error) throw Error(error)
      const photos = picked.map((p) => ({
        ...p,
        id: makeId(),
        name: p.name || '我的照片',
        status: 'pending'
      }))
      if (!batchInterested() || !edit({ photos: [...state.photos, ...photos] })) return
      // Persist all selections first, then bind the batch to the confirmed
      // session key. Its owned promotion must not strand the remaining files.
      if (!(await ensureSession()) || !batchCurrent()) return
      sourceKey = draftKey
      for (const photo of photos) {
        if (!batchInterested()) break
        await upload(photo.id)
        if (!batchInterested()) break
      }
    } catch (error) {
      if (hasPhotoUploadConfiguration() && !unavailable() && sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) && current() && pageVisible && !error?.errMsg?.includes('cancel')) {
        update(
          { error: /照片|JPG|PNG|玩法/.test(error.message) ? error.message : '选择照片失败，请重试' },
          false
        )
      }
    } finally {
      adding = false
      if (current()) {
        state = { ...state, controls: controls() }
        emit()
      }
    }
  }
  function invalidateCarryBack() {
    carryEpoch++
    carryCandidate = null
  }
  const carryAllowed = () =>
    !unavailable() && admission('upload') && !unavailable() &&
    current() &&
    pageVisible &&
    !!state.sessionId &&
    !state.submission &&
    !state.sessionRequest &&
    !state.submitting &&
    !state.legacyRecord &&
    !state.corruptPending
  async function prepareCarryBackInput({ taskId, artifactId }) {
    const ticket = continuation()
    if (!ordinaryInterested(ticket)) return null
    invalidateCarryBack()
    if (!carryAllowed()) return null
    const epoch = carryEpoch
    const version = editVersion
    const sourceSessionId = state.sessionId
    const valid = () =>
      ordinaryInterested(ticket) && carryAllowed() && ordinaryInterested(ticket) &&
      epoch === carryEpoch &&
      version === editVersion &&
      state.sessionId === sourceSessionId
    try {
      if (!valid()) return null
      if (artifactId) {
        const artifact = await api.artifact({ artifactId })
        if (!valid()) return null
        if (artifact.id !== artifactId || artifact.sessionId !== sourceSessionId) {
          throw Error('INVALID_RESPONSE')
        }
        taskId = artifact.taskId
      }
      if (!valid()) return null
      const task = await api.task({ taskId })
      if (!valid()) return null
      const source = readCarryBackSource({ task, taskId, sessionId: sourceSessionId })
      carryCandidate = freeze({
        ...source,
        epoch,
        editVersion: version,
        sessionId: sourceSessionId
      })
      return carryCandidate
    } catch (error) {
      if (valid()) update({ error: creationError(error) }, false)
      return null
    }
  }
  function cancelCarryBackInput({ candidate }) {
    if (!candidate || candidate !== carryCandidate) return false
    invalidateCarryBack()
    return true
  }
  async function confirmCarryBackInput({ candidate }) {
    const ticket = continuation()
    if (
      !ordinaryInterested(ticket) ||
      !candidate ||
      candidate !== carryCandidate ||
      !carryAllowed() ||
      candidate.epoch !== carryEpoch ||
      candidate.editVersion !== editVersion ||
      candidate.sessionId !== state.sessionId
    ) {
      return false
    }
    const saved = edit({
      description: candidate.description,
      userNotes: candidate.userNotes,
      carryBackSourceTaskId: candidate.carryBackSourceTaskId,
      photos: copy(candidate.photos)
    })
    if (!saved || !ordinaryInterested(ticket)) return false
    await readPhotoPreviews({ isInterested: () => ordinaryInterested(ticket) })
    return true
  }
  async function readPhotoPreviews({ isInterested = () => true } = {}) {
    const ticket = continuation()
    const interested = () => ordinaryInterested(ticket) && isInterested() && ordinaryInterested(ticket)
    if (!interested()) return
    const version = editVersion
    const photos = [...state.photos]
    let previewFailed = false
    for (const photo of photos) {
      if (!current() || !interested() || version !== editVersion) return
      if (photo.status === 'unavailable') continue
      const same = () =>
        current() && interested() &&
        version === editVersion &&
        state.photos.some(
          (slot) =>
            slot.id === photo.id && slot.mediaId === photo.mediaId && slot.status === photo.status
        )
      try {
        const exists = photo.path && (await files.exists(photo.path))
        if (!same()) return
        if (!exists && photo.mediaId) {
          const path = await files.preview(photo.mediaId)
          if (!same()) return
          update(
            { photos: state.photos.map((slot) => (slot.id === photo.id ? { ...slot, path } : slot)) },
            false
          )
        } else if (!exists) {
          update(
            {
              photos: state.photos.map((slot) => {
                if (slot.id !== photo.id) return slot
                return { ...slot, status: 'failed', error: '照片缓存失效，请重新添加' }
              })
            },
            false
          )
        }
      } catch {
        if (same()) {
          previewFailed = true
          update({ error: '部分照片暂时无法读取，请重试', errorAction: 'carry-preview' }, false)
        }
      }
    }
    if (
      current() && interested() &&
      version === editVersion &&
      !previewFailed &&
      state.errorAction === 'carry-preview'
    ) {
      update({ error: '' }, false)
    }
  }
  async function replacePhoto({ id }) {
    const ticket = continuation()
    if (!ordinaryInterested(ticket) || !hasPhotoUploadConfiguration() || !admission('upload') || !ordinaryInterested(ticket) || !hasPhotoUploadConfiguration()) return
    const original = state.photos.find((slot) => slot.id === id)
    if (
      adding ||
      !current() ||
      !hasPhotoUploadConfiguration() ||
      state.legacyRecord ||
      state.corruptPending ||
      original?.status !== 'unavailable'
    ) {
      return
    }
    adding = true
    const version = editVersion
    const source = Object.freeze({
      key: draftKey,
      sessionId: state.sessionId,
      mode: state.mode,
      templateId: state.templateId,
      lane: recovery.getFacts().lane
    })
    const choiceInterested = () => current() && pageVisible && !unavailable() && hasPhotoUploadConfiguration() &&
      sameTerminalInterest({ capturedEpoch: ticket.terminalEpoch, availability: state.sessionAvailability }) &&
      draftKey === source.key && state.sessionId === source.sessionId && state.mode === source.mode &&
      state.templateId === source.templateId &&
      recovery.getFacts().lane === source.lane && version === editVersion && state.photos.includes(original)
    let selectedTicket = null
    const interested = () => choiceInterested() && (!selectedTicket || ordinaryInterested(selectedTicket))
    try {
      const picked = await files.choose(1)
      // Native selection may hide/show; only this return adopts the current read epoch.
      selectedTicket = continuation()
      if (!interested() || !picked?.length || !admission('upload') || !interested()) return
      if (picked.length !== 1) throw Error('请选择一张照片')
      const replacement = {
        ...picked[0],
        id: makeId(),
        name: picked[0].name || '我的照片',
        status: 'pending'
      }
      if (!interested()) return
      const photos = state.photos.map((slot) => (slot.id === id ? replacement : slot))
      const error = validatePhotos({ photos, schema: state.template.inputSchema })
      if (!interested() || !admission('upload') || !interested()) return
      if (error) throw Error(error)
      if (edit({ photos }) && ordinaryInterested(selectedTicket) && state.photos.includes(replacement)) await upload(replacement.id)
    } catch (error) {
      if (interested() && !error?.errMsg?.includes('cancel')) {
        update(
          { error: /照片|JPG|PNG|玩法/.test(error.message) ? error.message : '选择照片失败，请重试' },
          false
        )
      }
    } finally {
      adding = false
      if (current()) {
        state = { ...state, controls: controls() }
        emit()
      }
    }
  }
  function needsOriginalConfirmation() {
    const facts = recovery.getFacts()
    return facts.knownCreationSessionId || (facts.activeIntent && facts.frozen === 'valid')
  }
  async function confirmOriginalRequest() {
    if (recovery.getFacts().knownCreationSessionId) return confirmKnownCreation()
    const epoch = readEpoch
    const interested = () => current() && pageVisible && readEpoch === epoch
    if (!current() || !pageVisible || state.submitting || originalConfirmationFlight) return
    originalConfirmationFlight = true
    const original = recovery.readFrozen({ epoch })
    if (!original.record || !current() || !pageVisible) { originalConfirmationFlight = false; return }
    const record = original.record
    update({ submitting: true }, false)
    if (!interested()) { originalConfirmationFlight = false; update({ submitting: false }, false); return }
    try {
      let originalResult
      if (record.sessionRequest) originalResult = await api.createSession(copy(record.sessionRequest))
      else {
        const pending = readPendingSubmission({ value: record.submission, sessionId: record.sessionId })
        if (!pending) return
        originalResult = pending.operation === 'regenerate'
          ? await api.regenerate({ sourceArtifactId: record.submission.sourceArtifactId, sessionId: record.sessionId, ...copy(record.submission.body) })
          : await api.generate(copy(record.submission.body))
      }
      if (interested()) update({ originalResult, locallyBlocked: true, error: '原请求已核对，本机输入仍待保存；原记录已保留' }, false)
    } catch { if (interested()) update({ locallyBlocked: true, error: '原请求结果待确认，本机记录已保留' }, false) } finally { originalConfirmationFlight = false; update({ submitting: false }, false) }
  }
  async function confirmKnownCreation() {
    const epoch = readEpoch
    const knownId = recovery.getFacts().knownCreationSessionId
    const interested = () => current() && pageVisible && readEpoch === epoch && state.sessionId === knownId
    if (!knownId || originalConfirmationFlight || state.submitting || !interested()) return
    originalConfirmationFlight = true
    const original = recovery.readFrozen({ epoch })
    if (!original.record?.sessionRequest || !interested()) { originalConfirmationFlight = false; return }
    update({ submitting: true }, false)
    try {
      if (!interested()) return
      const receipt = await api.createSession(copy(original.record.sessionRequest))
      if (!interested()) return
      if (receipt?.id !== knownId || receipt.mode !== original.record.mode ||
        receipt.templateId !== original.record.templateId) throw Error('INVALID_RESPONSE')
      const facts = recovery.getFacts()
      if (facts.activeIntent || facts.hasUnsavedOverlay) {
        update({
          originalResult: receipt,
          locallyBlocked: true,
          error: '原请求已核对，本机输入仍待保存；原记录已保留'
        }, false)
        return
      }
      const settled = applyRecovery(recovery.settleSession({ epoch, receipt }))
      if (!interested()) return
      if (settled.status === 'saved') {
        draftDirty = false
        update({
          session: receipt,
          sessionId: knownId,
          sessionRequest: null,
          quote: null,
          originalResult: receipt,
          error: '原会话已确认，请另行获取报价后再生成',
          errorAction: 'quote'
        }, false)
      } else update({ error: '会话已确认，本机未结记录尚未更新，请再次核对原请求' }, false)
    } catch {
      if (interested()) update({ error: '原请求结果待确认，本机记录已保留' }, false)
    } finally {
      originalConfirmationFlight = false
      update({ submitting: false }, false)
    }
  }
  async function readDeliveredTask({ task, ticket }) {
    try {
      const delivered = await api.task({ taskId: task.id })
      if (!ordinaryInterested(ticket)) return
      mergeRounds([delivered])
      if (!ordinaryInterested(ticket)) return
      await readArtifacts({ rounds: [delivered], isInterested: () => ordinaryInterested(ticket) })
    } catch {
      if (ordinaryInterested(ticket)) update({ error: '作品已受理，详情暂未读取，请刷新核对' }, false)
    }
  }
  async function generate() {
    const ticket = continuation()
    if (!current() || !pageVisible || state.submitting || originalConfirmationFlight) return
    const generationEpoch = readEpoch
    const interested = () => current() && pageVisible && readEpoch === generationEpoch
    inspectInput()
    if (needsOriginalConfirmation()) return confirmOriginalRequest()
    if (!state.submission && !state.sessionRequest && !admitOrdinary('new-submission', ticket)) return
    if (!interested() || state.submitting || state.legacyRecord || state.corruptPending) return
    invalidateCarryBack()
    // Frozen requests are recovery operations, not new admission decisions.
    if (!state.submission && state.sessionRequest) {
      if (await ensureSession() && ordinaryInterested(ticket)) {
        await refresh()
        if (ordinaryInterested(ticket)) await prepareQuote()
      }
      return
    }
    if (!state.submission) {
      if (hasActive()) {
        update({ error: '上一张作品仍在处理中，请先等待结果' }, false)
        return
      }
      const error = state.sourceArtifactId && !hasPendingCarryBackPhotos() ? '' : inputError()
      if (error) {
        update({ error }, false)
        return
      }
      if (!validQuote()) {
        update({ quote: null, error: '请查看有效报价后再次点击生成' }, false)
        prepareQuote()
        return
      }
      const quote = state.quote
      const body = state.sourceArtifactId
        ? { clientRequestId: makeId(), quoteToken: quote.quoteToken }
        : {
          sessionId: state.sessionId,
          input: copy(quote.binding.input),
          clientRequestId: makeId(),
          quoteToken: quote.quoteToken
        }
      const submission = freeze({
        protocol: 2,
        path: state.sourceArtifactId ? `/artifacts/${state.sourceArtifactId}/regenerations` : '/generations',
        body,
        sessionId: state.sessionId,
        sourceArtifactId: state.sourceArtifactId,
        costCredits: quote.costCredits,
        templateId: quote.templateId
      })
      if (!update({ submission })) {
        return
      }
    }
    const pending = state.submission
    const classified = readPendingSubmission({ value: pending, sessionId: state.sessionId })
    if (!classified) {
      update({ corruptPending: true, error: '待确认请求不完整，已保留原记录，未发送新请求' }, false)
      return
    }
    if (!update({ submitting: true, error: '' }) || !interested()) {
      update({ submitting: false }, false)
      return
    }
    try {
      const task =
        classified.operation === 'regenerate'
          ? await api.regenerate({
            sourceArtifactId: pending.sourceArtifactId,
            sessionId: pending.sessionId,
            ...copy(pending.body)
          })
          : await api.generate(copy(pending.body))
      if (!interested()) return
      if (task.templateId !== state.templateId || task.costCredits !== pending.costCredits) {
        throw Object.assign(Error('INVALID_RESPONSE'), { isOutcomeUnknown: true })
      }
      mergeRounds([task])
      if (!update({ submission: null, quote: null, sourceArtifactId: null })) {
        update({ submission: pending, error: '请求已确认，本机未结记录尚未更新，请再次核对原请求' }, false)
        return
      }
      if (task.status === 'succeeded' && ordinaryInterested(ticket)) await readDeliveredTask({ task, ticket })
    } catch (error) {
      if (!interested()) return
      if (error.isOutcomeUnknown || error.retryable || error.code === 'IDEMPOTENCY_CONFLICT') {
        update({ error: '提交结果待确认，请点「确认提交结果」核对原请求；不会重复生成' })
      } else {
        const needsQuote = ['QUOTE_EXPIRED', 'QUOTE_CHANGED', 'QUOTE_INVALID'].includes(
          error.code || error.message
        )
        const settled = update({
          submission: null,
          quote: null,
          sourceArtifactId: needsQuote ? pending.sourceArtifactId : null,
          error: creationError(error),
          errorCode: (error.code || error.message) === 'CREDITS_INSUFFICIENT' ? 'CREDITS_INSUFFICIENT' : null
        })
        if (!settled) {
          update({ submission: pending, error: '请求已核对，本机记录未更新，请再次核对原请求' }, false)
          return
        }
        if (needsQuote && ordinaryInterested(ticket)) prepareQuote()
      }
    } finally {
      update({ submitting: false }, false)
    }
  }
  async function prepareRegeneration(artifactId) {
    const ticket = continuation()
    if (!ordinaryInterested(ticket)) return
    if (!current() || state.submitting || state.submission || hasActive() || hasPendingCarryBackPhotos()) {
      return
    }
    const epoch = ++quoteEpoch
    update({ sourceArtifactId: null, quote: null, quoting: true }, false)
    try {
      if (!ordinaryInterested(ticket)) return
      const source = state.artifacts[artifactId] || (await api.artifact({ artifactId }))
      if (!ordinaryInterested(ticket) || epoch !== quoteEpoch) return
      if (source.sessionId !== state.sessionId) throw Error('ARTIFACT_NOT_FOUND')
      update({ artifacts: { ...state.artifacts, [source.id]: source }, sourceArtifactId: source.id }, false)
      if (ordinaryInterested(ticket)) await prepareQuote()
    } catch (error) {
      if (ordinaryInterested(ticket) && epoch === quoteEpoch) update({ quoting: false, error: creationError(error) }, false)
    }
  }
  async function toggleFavorite(artifactId) {
    const original = state.artifacts[artifactId]
    if (!current() || !original || original.saving) return
    favoriteEpochs.set(artifactId, (favoriteEpochs.get(artifactId) || 0) + 1)
    update({ artifacts: { ...state.artifacts, [artifactId]: { ...original, saving: true } } }, false)
    try {
      const result = await api.favorite({ artifactId, isFavorite: !original.isFavorite })
      update(
        {
          artifacts: { ...state.artifacts, [artifactId]: { ...original, ...result, saving: false } },
          error: ''
        },
        false
      )
    } catch (error) {
      update(
        { artifacts: { ...state.artifacts, [artifactId]: original }, error: creationError(error) },
        false
      )
    }
  }
  function resumeLocalInput() {
    if (localResumeFlight) return localResumeFlight.promise
    const epoch = readEpoch
    const ticket = continuation()
    const interested = () => current() && pageVisible && readEpoch === epoch
    const flight = {}
    // Install the sentinel before the first source/storage callback, not after an async IIFE starts.
    localResumeFlight = flight
    flight.promise = Promise.resolve().then(async () => {
      if (!interested()) return { status: 'cancelled' }
      inspectInput()
      const request = recovery.beginLocalResume({ epoch })
      if (!request.ticket) { applyRecovery(request); update({}, false); return request }
      let session
      if (request.needsServerSession) {
        if (!ordinaryInterested(ticket)) {
          const blocked = applyRecovery(recovery.resumeLocal({ epoch, ticket: request.ticket, session: null }))
          update({}, false)
          return blocked
        }
        try {
          session = await api.getSession({ sessionId: request.sessionId })
          if (!ordinaryInterested(ticket)) return { status: 'cancelled' }
          if (session?.id !== request.sessionId) session = null
          else update({ sessionAvailability: sessionAvailable({ availability: state.sessionAvailability, sessionId: request.sessionId }) }, false)
        } catch (error) {
          if (!ordinaryInterested(ticket)) return { status: 'cancelled' }
          if (state.sessionId === request.sessionId && isFormalSessionNotFound(error)) recordUnavailable({ sessionId: request.sessionId, error })
          session = null
        }
        if (!ordinaryInterested(ticket)) return { status: unavailable() ? 'unavailable' : 'cancelled' }
        if (!interested()) return { status: 'cancelled' }
      }
      const result = applyRecovery(recovery.resumeLocal({ epoch, ticket: request.ticket, session }))
      update({}, false)
      if (result.status === 'saved') offerEntryQuote()
      return result
    }).finally(() => { if (localResumeFlight === flight) localResumeFlight = null })
    return flight.promise
  }
  state.controls = controls()
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setDescription: (description) => edit({ description }),
    setUserNotes: (userNotes) => edit({ userNotes }),
    removePhoto: (id) => {
      inspectInput()
      return state.photos.some((p) => p.id === id) ? edit({ photos: state.photos.filter((p) => p.id !== id) }) : false
    },
    addPhotos,
    movePhoto,
    retryPhoto: upload,
    resumePhoto: (id) => {
      if (adding) return
      return upload(id)
    },
    generate,
    prepareQuote,
    prepareRegeneration,
    toggleFavorite,
    restore,
    refresh,
    recheckSession,
    expireQuote: () => {
      quoteEpoch++
      update({ quote: null }, false)
    },
    resumeDraftSave: async ({ target } = {}) => {
      if (target === 'local-input') return resumeLocalInput()
      inspectInput()
      if (!target && recovery.getFacts().activeIntent) return resumeLocalInput()
      if (target === 'remote-draft' && recovery.getFacts().activeIntent) return { status: 'blocked' }
      const ticket = continuation()
      if (!ordinaryInterested(ticket) || draftFlight || !admission('normal-save') || !ordinaryInterested(ticket)) return
      if (!update({ draftPaused: false }) || !ordinaryInterested(ticket)) return
      draftDirty = true
      await flushDraft()
    },
    focusTask: (args) => {
      const ticket = continuation()
      return taskHistory.focusTask({ ...args, isInterested: () => ordinaryInterested(ticket) })
    },
    cancelTaskFocus: () => taskHistory.cancelFocus(),
    loadOlder: async () => {
      const ticket = continuation()
      const result = await taskHistory.readOlder({ isInterested: () => historyInterested(ticket) })
      if (!historyInterested(ticket)) return result
      if (result.status === 'failed' || result.artifacts === 'failed') {
        update({ error: creationError(Error(result.reason || 'INVALID_RESPONSE')) }, false)
      }
      return result
    },
    shouldPoll: () => !unavailable() && (!!state.session?.runningTask || state.rounds.some(active)),
    prepareCarryBackInput,
    confirmCarryBackInput,
    cancelCarryBackInput,
    replacePhoto,
    setPageVisible: ({ visible }) => {
      pageVisible = visible
      if (!visible) {
        readEpoch++
        invalidateCarryBack()
        taskHistory.cancelFocus()
      }
      update({}, false)
    },
    retryError: () => {
      if (state.submission || state.sessionRequest) return generate()
      if (unavailable()) return Promise.resolve({ status: 'unavailable' })
      if (state.errorAction === 'quote') return prepareQuote()
      if (state.errorAction === 'carry-preview') return readPhotoPreviews()
      return refresh()
    },
    rename: async (title) => {
      const ticket = continuation()
      if (!ordinaryInterested(ticket)) return
      if (!current() || !state.sessionId || !title.trim()) return
      const epoch = ++renameEpoch
      titleEpoch++
      try {
        const result = await api.rename({ sessionId: state.sessionId, title })
        if (ordinaryInterested(ticket) && epoch === renameEpoch) {
          titleEpoch++
          update(
            { session: { ...state.session, title: result.title, titleSource: result.titleSource } },
            false
          )
        }
      } catch (error) {
        if (ordinaryInterested(ticket) && epoch === renameEpoch) update({ error: creationError(error) }, false)
      }
    },
    dispose: () => {
      disposed = true
      taskHistory.dispose()
      invalidateCarryBack()
      quoteEpoch++
      listeners.clear()
    }
  }
}
