/** One cursor per filter/account generation. An old finally never unlocks a new flight. */
export function createCursorList({ read, identity = (item) => item.id, filters = {}, isInterested = () => true }) {
  let epoch = 0
  let flight = null
  let disposed = false
  let state = { items: [], nextCursor: null, hasMore: true, loading: false, loaded: false, error: '', warning: '' }
  const listeners = new Set()
  const emit = (patch) => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }
  const load = async () => {
    if (disposed || flight || !state.hasMore || !isInterested()) return
    const request = { epoch }
    flight = request
    const interested = () => !disposed && flight === request && request.epoch === epoch && isInterested()
    let warning = ''
    emit({ loading: true, error: '' })
    try {
      if (!interested()) return
      const result = await read({
        ...filters,
        cursor: state.nextCursor || undefined,
        isInterested: interested,
        onWarning: (value) => { warning = value }
      })
      if (!interested()) return
      const rows = new Map(state.items.map((item) => [identity(item), item]))
      result.items.forEach((item) => rows.set(identity(item), item))
      emit({
        items: [...rows.values()],
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        loaded: true,
        warning
      })
    } catch (error) {
      if (interested()) {
        emit({
          error: error?.message === 'FAVORITE_PENDING'
            ? '收藏状态仍待核对，请稍后重试读取' : '暂时连接不上，请重试'
        })
      }
    } finally {
      if (!disposed && flight === request) {
        flight = null
        emit({ loading: false })
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    load,
    reset: (next) => {
      epoch++
      flight = null
      filters = next || {}
      emit({ items: [], nextCursor: null, hasMore: true, loading: false, loaded: false, error: '', warning: '' })
    },
    dispose: () => {
      disposed = true
      epoch++
      listeners.clear()
    }
  }
}
