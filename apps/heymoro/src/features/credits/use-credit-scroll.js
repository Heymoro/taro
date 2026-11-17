import Taro, { useDidHide } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'

import { creditRowId } from './credits-view'

const finite = ({ value, fallback = 0 }) => (Number.isFinite(value) ? value : fallback)

/** Native geometry only. Position belongs to the pure controller; row heights
 * are measured, never inferred from a design's minimum height. */
export function useCreditScroll({ owner, controller, state, onIntent }) {
  const metadata = useRef(null)
  if (metadata.current?.owner !== owner) metadata.current = { owner, intent: 0, queries: new Set(), programmatic: null }
  const value = metadata.current
  const [restored, setRestored] = useState(null)
  const current = () => metadata.current === value && owner.current()
  const token = () => ({
    intent: value.intent,
    view: controller.getSnapshot().view,
    revision: controller.getSnapshot().revision,
  })
  const owns = ({ stamp }) =>
    current() &&
    stamp.intent === value.intent &&
    stamp.view === controller.getSnapshot().view &&
    stamp.revision === controller.getSnapshot().revision
  const cancel = () => {
    value.intent++
    value.programmatic = null
    for (const finish of [...value.queries]) finish(null)
  }
  const measure = ({ stamp }) =>
    new Promise((resolve) => {
      if (!owns({ stamp })) {
        resolve(null)
        return
      }
      const timeout = { id: null }
      const finish = (result) => {
        clearTimeout(timeout.id)
        value.queries.delete(finish)
        resolve(owns({ stamp }) ? result : null)
      }
      value.queries.add(finish)
      timeout.id = setTimeout(() => finish(null), 120)
      try {
        Taro.createSelectorQuery()
          .select('#credits-scroll')
          .boundingClientRect()
          .selectAll('.credits-row')
          .boundingClientRect()
          .select('#credits-scroll')
          .scrollOffset()
          .exec(finish)
      } catch {
        finish(null)
      }
    })
  const capture = async () => {
    if (!current()) return
    cancel()
    const stamp = token()
    const result = await measure({ stamp })
    if (!owns({ stamp })) return
    if (!result) return stamp
    const [viewport, tiles, scroll] = result
    if (!viewport || !Array.isArray(tiles)) return stamp
    const snapshot = controller.getSnapshot()
    const ids = new Set(
      snapshot.items.map((row) =>
        creditRowId({ view: stamp.view, id: stamp.view === 'reservations' ? row.reservationId : row.id })
      )
    )
    const measured = tiles.filter(
      (tile) => ids.has(tile.id) && Number.isFinite(tile.top) && Number.isFinite(tile.bottom)
    )
    const index = measured.findIndex((tile) => tile.bottom > viewport.top && tile.top < viewport.top + viewport.height)
    const point = ({ tile }) => ({ id: tile.id, offset: tile.top - viewport.top })
    const neighbors = [-1, 1, -2, 2]
      .filter((step) => index >= 0 && measured[index + step])
      .map((step) => point({ tile: measured[index + step] }))
    controller.setPosition({
      position: {
        scrollTop: finite({ value: scroll?.scrollTop, fallback: snapshot.position.scrollTop }),
        anchor: index >= 0 ? point({ tile: measured[index] }) : null,
        neighbors,
      },
    })
    return stamp
  }
  useDidHide(cancel)
  useEffect(() => () => cancel(), [owner])
  useEffect(() => {
    if (!current()) return
    cancel()
    const stamp = token()
    const position = state.position
    const apply = ({ top }) => {
      if (!owns({ stamp })) return
      value.programmatic = { top }
      setRestored({ owner, view: stamp.view, top })
    }
    apply({ top: position.scrollTop })
    try {
      Taro.nextTick(async () => {
        if (!owns({ stamp })) return
        const result = await measure({ stamp })
        if (!owns({ stamp }) || !result) return
        const [viewport, tiles, scroll] = result
        if (!viewport || !Array.isArray(tiles) || !Number.isFinite(viewport.height)) return
        if (stamp.view === 'balance') return
        const top = finite({ value: scroll?.scrollTop, fallback: position.scrollTop })
        const byId = new Map(tiles.map((tile) => [tile.id, tile]))
        const anchor = [position.anchor, ...position.neighbors].find((point) => point && byId.has(point.id))
        const target = anchor ? top + byId.get(anchor.id).top - viewport.top - anchor.offset : position.scrollTop
        const measuredHeight = tiles.reduce(
          (max, tile) => Math.max(max, finite({ value: tile.bottom }) - viewport.top + top),
          0
        )
        const max = Math.max(0, finite({ value: scroll?.scrollHeight, fallback: measuredHeight }) - viewport.height)
        apply({ top: Math.max(0, Math.min(max, finite({ value: target, fallback: position.scrollTop }))) })
      })
    } catch {
      /* Numeric restoration remains available. */
    }
  }, [owner, state.view, state.revision])
  const eventCurrent = () =>
    current() && state.view === controller.getSnapshot().view && state.revision === controller.getSnapshot().revision
  const touch = () => {
    if (eventCurrent()) {
      cancel()
      onIntent?.()
    }
  }
  return {
    capture,
    owns,
    cancel,
    scrollTop: owner.identityCurrent()
      ? restored?.owner === owner && restored.view === state.view
        ? restored.top
        : state.position.scrollTop
      : 0,
    onTouchStart: touch,
    onTouchMove: touch,
    onScroll: (event) => {
      if (!eventCurrent()) return
      const top = finite({ value: event.detail?.scrollTop })
      if (!value.programmatic || Math.abs(value.programmatic.top - top) > 2) {
        cancel()
        onIntent?.()
      }
      controller.setPosition({ position: { ...controller.getSnapshot().position, scrollTop: top } })
      setRestored({ owner, view: state.view, top })
    },
  }
}
