import { createCursorList } from './cursor-list'

const AUTO_PAGES = 20

/** One owner-local committed projection and an unpublished fresh-prefix candidate.
 * Every row and cursor comes from the injected DTO read.
 */
export function createRetainedCursorList({
  read,
  identity,
  filters = {},
  cursorFactory = createCursorList,
  isCurrent = () => true,
}) {
  let visible = true
  let disposed = false
  let started = false
  let epoch = 0
  let flight = null
  const listeners = new Set()
  const current = () => !disposed && isCurrent()
  const emit = () => {
    if (current()) listeners.forEach((listener) => listener())
  }
  const projection = () => {
    const value = { active: true, pages: 0, warning: '', failure: '', cursors: new Set() }
    value.controller = cursorFactory({
      filters,
      identity,
      isInterested: () => current() && visible && value.active,
      read: async (args) => {
        const intent = epoch
        const interested = () => intent === epoch && args.isInterested()
        const result = await read({
          ...args,
          isInterested: interested,
          onWarning: (warning) => {
            if (!interested()) return
            args.onWarning(warning)
            if (warning) value.warning = warning
          },
        })
        if (!interested()) throw Error('READ_CANCELLED')
        if (
          result.hasMore &&
          (!result.nextCursor || result.nextCursor === args.cursor || value.cursors.has(result.nextCursor))
        ) {
          value.failure = '分页位置异常，请重试更新'
          throw Error('CURSOR_LOOP')
        }
        if (result.nextCursor) value.cursors.add(result.nextCursor)
        value.pages++ // Successful empty scan pages count toward the committed prefix too.
        value.failure = ''
        return result
      },
    })
    return value
  }
  const makeView = () => ({
    committed: projection(),
    candidate: null,
    dirty: 0,
    revision: 0,
    error: '',
    paused: false,
  })
  const view = makeView()
  const discard = ({ view }) => {
    view.candidate?.projection.controller.dispose()
    view.candidate = null
    view.paused = false
  }
  const cancel = () => {
    epoch++
    if (flight?.kind === 'older') {
      // Shared cursor controllers have no cancellation API. Freeze this committed
      // projection's interest rather than resetting (and losing) its old prefix.
      view.committed.active = false
      view.dirty++
    }
    flight = null
    discard({ view })
  }
  const getSnapshot = () => {
    const state = view.committed.controller.getSnapshot()
    return {
      ...state,
      loading: Boolean(current() && flight),
      error: view.error,
      warning: view.candidate?.projection.warning || view.committed.warning,
      pages: view.committed.pages,
      dirty: Boolean(view.dirty),
      revalidating: Boolean(view.dirty && flight),
      paused: view.paused,
      revision: view.revision,
    }
  }
  const run = async ({ resume = false } = {}) => {
    if (!current() || !visible || flight) return
    if (view.paused && !resume) return
    const validating = view.dirty || !view.committed.controller.getSnapshot().loaded
    if (!validating && !view.committed.controller.getSnapshot().hasMore) return
    const request = { epoch, kind: validating ? 'prefix' : 'older' }
    flight = request
    const interested = () => current() && visible && flight === request && epoch === request.epoch
    view.error = ''
    view.paused = false
    if (validating && !view.candidate) {
      view.candidate = {
        projection: projection(),
        target: Math.max(1, view.committed.pages),
      }
    }
    emit()
    try {
      if (!interested()) return
      const candidate = view.candidate
      const value = validating ? candidate.projection : view.committed
      for (let budget = 0; budget < (validating ? AUTO_PAGES : 1); budget++) {
        if (!interested()) return
        await value.controller.load()
        if (!interested()) return
        const state = value.controller.getSnapshot()
        if (state.error) {
          view.error = value.failure || state.error
          return
        }
        if (!validating) return
        if (value.pages >= candidate.target || !state.hasMore) {
          const previous = view.committed
          view.committed = value
          view.candidate = null
          view.dirty = 0
          view.revision++
          previous.controller.dispose()
          return
        }
      }
      view.paused = true
    } finally {
      // A cancelled native request can finish after a new view's request began.
      if (flight === request) {
        flight = null
        emit()
      }
    }
  }
  return {
    getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => {
      if (started) return
      started = true
      return run()
    },
    show: () => {
      const shouldRead = !visible || !started
      visible = true
      started = true
      if (shouldRead) return run()
    },
    hide: () => {
      if (!visible || disposed) return
      visible = false
      cancel()
      view.dirty++
      emit()
    },
    suspend: () => {
      cancel()
    },
    activate: ({ retryErrors = true } = {}) => {
      visible = true
      started = true
      if ((!view.error || retryErrors) && (view.dirty || !view.committed.controller.getSnapshot().loaded)) return run()
    },
    load: () => run(),
    continueUpdating: () => run({ resume: true }),
    refresh: () => {
      if (!current() || flight) return
      if (!view.dirty && view.committed.controller.getSnapshot().loaded) view.dirty++
      return run()
    },
    dispose: () => {
      if (disposed) return
      cancel()
      disposed = true
      view.committed.controller.dispose()
      listeners.clear()
    },
  }
}
