import { isReadTransportError } from './read-poll-policy'

const positiveId = ({ value }) => Number.isSafeInteger(value) && value > 0
const cancelled = () => ({ status: 'cancelled' })
const failed = ({ reason }) => ({ status: 'failed', reason })
const validTask = ({ task, sessionId }) =>
  task &&
  positiveId({ value: task.id }) &&
  positiveId({ value: task.roundNo }) &&
  task.sessionId === sessionId &&
  (task.artifactIds == null || Array.isArray(task.artifactIds))

/** Read scheduling only. History and artifact facts belong exclusively to the workflow. */
export function createTaskHistory({
  api,
  readHistory,
  mergePage,
  mergeTarget,
  setLoadingOlder,
  readArtifacts,
  isCurrent,
  canFocus
}) {
  let pageFlight = null
  let initialized = false
  let focusEpoch = 0
  let disposed = false
  const consumedCursors = new Set()
  const current = ({ sessionId }) =>
    !disposed && isCurrent() && readHistory().sessionId === sessionId

  async function readPage({ kind, isInterested = () => true }) {
    for (;;) {
      const history = readHistory()
      const sessionId = history.sessionId
      if (!positiveId({ value: sessionId }) || !current({ sessionId }) || !isInterested()) {
        return cancelled()
      }
      const cursor = kind === 'older' ? history.olderCursor : undefined
      if (kind === 'older' && initialized && !history.hasOlder) return { status: 'eof' }
      // Initialization is not an older result: re-evaluate its frontier before reading older.
      if (kind === 'older' && !initialized) {
        const initial = await readPage({ kind: 'latest', isInterested })
        if (initial.status !== 'read') return initial
        continue
      }
      const actualKind = kind
      const actualCursor = cursor
      if (pageFlight) {
        const flight = pageFlight
        if (flight.kind === actualKind && flight.cursor === actualCursor &&
          [...flight.interests].some((interest) => interest())) {
          flight.interests.add(isInterested)
          const result = await flight.promise
          return isInterested() && current({ sessionId }) ? result : cancelled()
        }
        await flight.promise
        continue
      }
      const flight = { kind: actualKind, cursor: actualCursor, interests: new Set([isInterested]) }
      const interested = () =>
        current({ sessionId }) && [...flight.interests].some((interest) => interest())
      pageFlight = flight
      // Publish the promise before loading emits: subscribers may synchronously join.
      flight.promise = Promise.resolve().then(async () => {
        try {
          if (!interested()) return cancelled()
          if (actualKind === 'older') setLoadingOlder({ loadingOlder: true })
          if (!interested()) return cancelled()
          const page = await api.tasks({ sessionId, cursor: actualCursor })
          if (!interested()) return cancelled()
          if (
            !page ||
            !Array.isArray(page.items) ||
            typeof page.hasMore !== 'boolean' ||
            !page.items.every((task) => validTask({ task, sessionId }))
          ) {
            return failed({ reason: 'invalid-page' })
          }
          const advances = actualKind === 'older' || !initialized
          if (
            advances &&
            page.hasMore &&
            (typeof page.nextCursor !== 'string' ||
              !page.nextCursor ||
              page.nextCursor === actualCursor ||
              consumedCursors.has(page.nextCursor))
          ) {
            return failed({ reason: 'cursor-loop' })
          }
          mergePage({ page, advance: advances, isInterested: interested })
          if (!interested()) return cancelled()
          if (advances) {
            initialized = true
            if (actualKind === 'older') consumedCursors.add(actualCursor)
          }
          let transportFailed = false
          const artifacts = await readArtifacts({
            rounds: page.items,
            isInterested: interested,
            onTransportFailure: () => { transportFailed = true }
          })
          if (!interested()) return cancelled()
          return transportFailed
            ? { ...failed({ reason: 'page-read' }), failureKind: 'transport' }
            : { status: 'read', artifacts }
        } catch (error) {
          if (!interested()) return cancelled()
          return {
            ...failed({ reason: 'page-read' }),
            ...(isReadTransportError(error) ? { failureKind: 'transport' } : {})
          }
        } finally {
          if (pageFlight === flight) {
            pageFlight = null
            if (actualKind === 'older') setLoadingOlder({ loadingOlder: false })
          }
        }
      })
      const result = await flight.promise
      return isInterested() && current({ sessionId }) ? result : cancelled()
    }
  }
  function cancelFocus() {
    focusEpoch++
  }
  async function focusTask({ taskId, isInterested = () => true } = {}) {
    const epoch = ++focusEpoch
    const sessionId = readHistory().sessionId
    const interested = () => epoch === focusEpoch && current({ sessionId }) && canFocus() && isInterested()
    if (!interested()) return cancelled()
    if (!positiveId({ value: sessionId })) return failed({ reason: 'invalid-session' })
    if (!positiveId({ value: taskId })) return failed({ reason: 'invalid-task-id' })
    let target
    try {
      target = await api.task({ taskId })
    } catch {
      return interested() ? failed({ reason: 'task-read' }) : cancelled()
    }
    if (!interested()) return cancelled()
    if (!validTask({ task: target, sessionId }) || target.id !== taskId) {
      return failed({ reason: 'invalid-task' })
    }
    let pages = 0
    for (;;) {
      if (!interested()) return cancelled()
      const history = readHistory()
      const reached = history.rounds.some(
        (round) => round.id === taskId || round.roundNo <= target.roundNo
      )
      if (reached || (initialized && !history.hasOlder)) break
      if (pages === 20) return { status: 'paused', taskId, reason: 'page-budget' }
      const result = await readPage({
        kind: initialized ? 'older' : 'latest',
        isInterested: interested
      })
      if (!interested()) return cancelled()
      if (result.status === 'failed' || result.status === 'cancelled') return result
      pages++
    }
    mergeTarget({ task: target })
    if (!interested()) return cancelled()
    const round = readHistory().rounds.find((item) => item.id === taskId)
    const artifacts = await readArtifacts({ rounds: [round], isInterested: interested })
    if (!interested()) return cancelled()
    return { status: 'focused', taskId, roundNo: target.roundNo, artifacts }
  }
  return {
    readLatest: ({ isInterested = () => true } = {}) => readPage({ kind: 'latest', isInterested }),
    readOlder: ({ isInterested = () => true } = {}) => readPage({ kind: 'older', isInterested }),
    focusTask,
    cancelFocus,
    dispose: () => {
      disposed = true
      cancelFocus()
    }
  }
}
