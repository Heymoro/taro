import { createCursorList } from '../../cursor-list'
import { createRetainedCursorList } from '../../retained-cursor-list'

const emptyPosition = () => ({ scrollTop: 0, anchor: null, neighbors: [] })

/** Cabinet retains only two-view coordination; prefix transactions are shared. */
export function createCabinetList({ read, isCurrent = () => true }) {
  let selected = 'all'
  let disposed = false
  let visible = true
  const listeners = new Set()
  const positions = { all: emptyPosition(), saved: emptyPosition() }
  const views = Object.fromEntries(['all', 'saved'].map((key) => [key, createRetainedCursorList({
    read,
    cursorFactory: createCursorList,
    filters: { saved: key === 'saved' },
    isCurrent: () => !disposed && isCurrent() && selected === key,
  })]))
  const emit = () => { if (!disposed && isCurrent()) listeners.forEach((fn) => fn()) }
  Object.values(views).forEach((list) => list.subscribe(emit))
  return {
    getSnapshot: () => ({ ...views[selected].getSnapshot(), view: selected, position: positions[selected] }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    start: () => views[selected].start(),
    show: () => { visible = true; return views[selected].show() },
    hide: () => { visible = false; Object.values(views).forEach((list) => list.hide()); emit() },
    select: ({ saved }) => {
      const key = saved ? 'saved' : 'all'
      if (disposed || !isCurrent() || key === selected) return
      views[selected].suspend()
      selected = key
      emit()
      if (visible) return views[key].activate()
    },
    load: () => views[selected].load(),
    continueUpdating: () => views[selected].continueUpdating(),
    refresh: () => views[selected].refresh(),
    setPosition: ({ position }) => {
      if (disposed || !visible || !isCurrent()) return
      positions[selected] = { ...emptyPosition(), ...position }
      emit()
    },
    dispose: () => { disposed = true; Object.values(views).forEach((list) => list.dispose()); listeners.clear() },
  }
}
