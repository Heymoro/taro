import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationApi } from '../../creation-api'
import { creationAccountKey } from '../../use-account'
import { createCabinetList } from './cabinet-list'

const tileId = ({ artifactId }) => `cabinet-artifact-${artifactId}`
const finite = ({ value, fallback = 0 }) => (Number.isFinite(value) ? value : fallback)

/** Cabinet-only native geometry: one bounded query, not a scroll/cache platform. */
export function useCabinetList({ account }) {
  const page = useRef(Taro.getCurrentInstance?.().page)
  const foreground = () => {
    const pages = Taro.getCurrentPages?.()
    return Boolean(page.current && Array.isArray(pages) && pages.at(-1) === page.current)
  }
  const live = useRef(null)
  const visibility = useRef(true)
  const accountKey = account.accountKey
  const userId = account.user?.id
  const owner = useMemo(() => {
    const value = {
      active: true,
      visible: visibility.current,
      intent: 0,
      queries: new Set(),
      programmatic: null,
      navigation: null,
    }
    value.current = () =>
      value.active && live.current === value && Boolean(accountKey && userId) && accountKey === creationAccountKey()
    value.controller = createCabinetList({
      read: creationApi.artifacts,
      isCurrent: () => value.current() && foreground(),
    })
    return value
  }, [accountKey, userId])
  live.current = owner
  const [, render] = useState(0)
  const [restored, setRestored] = useState(null)
  const state = owner.controller.getSnapshot()
  const current = () => owner.current() && owner.visible && foreground()
  const token = () => ({
    intent: owner.intent,
    view: owner.controller.getSnapshot().view,
    revision: owner.controller.getSnapshot().revision,
  })
  const owns = ({ stamp }) =>
    current() &&
    stamp.intent === owner.intent &&
    stamp.view === owner.controller.getSnapshot().view &&
    stamp.revision === owner.controller.getSnapshot().revision
  const cancelGeometry = () => {
    owner.intent++
    owner.programmatic = null
    for (const finish of [...owner.queries]) finish(null)
  }
  const measure = ({ stamp }) =>
    new Promise((resolve) => {
      if (!owns({ stamp })) {
        resolve(null)
        return
      }
      let timer = null
      const finish = (result) => {
        clearTimeout(timer)
        owner.queries.delete(finish)
        resolve(owns({ stamp }) ? result : null)
      }
      owner.queries.add(finish)
      // Broken native queries must not hold detail navigation hostage.
      timer = setTimeout(() => finish(null), 120)
      try {
        Taro.createSelectorQuery()
          .select('#cabinet-scroll')
          .boundingClientRect()
          .selectAll('.artifact-tile')
          .boundingClientRect()
          .select('#cabinet-scroll')
          .scrollOffset()
          .exec((result) => finish(result))
      } catch {
        finish(null)
      }
    })
  const capture = async () => {
    if (!current()) return
    cancelGeometry()
    const stamp = token()
    const result = await measure({ stamp })
    if (!owns({ stamp })) return
    if (!result) return stamp
    const [viewport, tiles, scroll] = result
    if (!viewport || !Array.isArray(tiles)) return stamp
    const snapshot = owner.controller.getSnapshot()
    const rows = new Set(snapshot.items.map((item) => tileId({ artifactId: item.id })))
    const measured = tiles.filter(
      (tile) => rows.has(tile.id) && Number.isFinite(tile.top) && Number.isFinite(tile.bottom)
    )
    const index = measured.findIndex((tile) => tile.bottom > viewport.top && tile.top < viewport.top + viewport.height)
    const point = (tile) => ({
      artifactId: Number(tile.id.slice('cabinet-artifact-'.length)),
      offset: tile.top - viewport.top,
    })
    const neighbors = []
    for (const step of [-1, 1, -2, 2]) {
      const neighbor = measured[index + step]
      if (index >= 0 && neighbor) neighbors.push(point(neighbor))
    }
    owner.controller.setPosition({
      position: {
        scrollTop: finite({ value: scroll?.scrollTop, fallback: snapshot.position.scrollTop }),
        anchor: index >= 0 ? point(measured[index]) : null,
        neighbors,
      },
    })
    return stamp
  }
  const navigate = ({ artifactId }) => {
    if (!current() || owner.navigation) return
    // Capture intents may supersede one another only BEFORE dispatch. Native IO
    // cannot be cancelled by touch, a new measurement, or an elapsed timeout.
    const request = { settled: false, hidden: false, feedback: true }
    owner.navigation = request
    const settle = ({ failed = false } = {}) => {
      if (request.settled) return
      request.settled = true
      if (owner.navigation !== request) return
      if (failed || (request.hidden && current())) owner.navigation = null
      if (!failed || !request.feedback || !current()) return
      try {
        Promise.resolve(Taro.showToast({ title: '作品未打开，请点选作品重试', icon: 'none' })).catch(() => {})
      } catch {
        // Native feedback failure does not turn failed navigation into success.
      }
    }
    try {
      const result = Taro.navigateTo({
        url: `/pages/artifact/index?id=${artifactId}`,
        success: () => settle(),
        fail: () => settle({ failed: true }),
      })
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(
          () => settle(),
          () => settle({ failed: true })
        )
      }
    } catch {
      settle({ failed: true })
    }
  }
  useEffect(() => {
    owner.active = true
    const unsubscribe = owner.controller.subscribe(() => render((value) => value + 1))
    if (owner.visible) owner.controller.start()
    else owner.controller.hide()
    return () => {
      owner.active = false
      if (owner.navigation) owner.navigation.feedback = false
      owner.navigation = null
      cancelGeometry()
      unsubscribe()
      // React effect replay may reacquire this same owner synchronously. On real
      // unmount owner.current() is already false, including for native HTTP.
      Promise.resolve().then(() => {
        if (!owner.active) owner.controller.dispose()
      })
    }
  }, [owner])
  useDidHide(() => {
    if (owner.navigation) {
      owner.navigation.hidden = true
      owner.navigation.feedback = false
    }
    visibility.current = false
    owner.visible = false
    cancelGeometry()
    owner.controller.hide()
  })
  useDidShow(() => {
    visibility.current = true
    owner.visible = true
    if (owner.navigation?.hidden && owner.navigation.settled) owner.navigation = null
    owner.controller.show()
  })
  useEffect(() => {
    if (!current() || !state.loaded) return
    cancelGeometry()
    const stamp = token()
    const position = state.position
    // First restore the view's independent numeric top. Post-commit geometry
    // refines this using the old anchor/neighbor's measured viewport offset.
    const apply = ({ top }) => {
      if (!owns({ stamp })) return
      owner.programmatic = { top }
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
        const top = finite({ value: scroll?.scrollTop, fallback: position.scrollTop })
        const byId = new Map(tiles.map((tile) => [tile.id, tile]))
        const anchor = [position.anchor, ...position.neighbors].find(
          (point) => point && byId.has(tileId({ artifactId: point.artifactId }))
        )
        const target = anchor
          ? top + byId.get(tileId({ artifactId: anchor.artifactId })).top - viewport.top - anchor.offset
          : position.scrollTop
        const measuredHeight = tiles.reduce(
          (max, tile) => Math.max(max, finite({ value: tile.bottom }) - viewport.top + top),
          0
        )
        const maxTop = Math.max(0, finite({ value: scroll?.scrollHeight, fallback: measuredHeight }) - viewport.height)
        apply({ top: Math.max(0, Math.min(maxTop, finite({ value: target, fallback: position.scrollTop }))) })
      })
    } catch {
      /* Numeric position remains usable if native nextTick is unavailable. */
    }
    // Position updates deliberately do not schedule restoration after manual scroll.
  }, [owner, state.view, state.revision])
  const valid = owner.current()
  const snapshot = valid
    ? state
    : { ...state, items: [], loaded: false, loading: false, error: '', warning: '', paused: false }
  return {
    ...snapshot,
    saved: snapshot.view === 'saved',
    tileId,
    scrollTop: valid
      ? restored?.owner === owner && restored.view === state.view
        ? restored.top
        : state.position.scrollTop
      : 0,
    load: () => current() && owner.controller.load(),
    continueUpdating: () => current() && owner.controller.continueUpdating(),
    refresh: () => current() && owner.controller.refresh(),
    capture,
    select: async ({ saved }) => {
      if (!current()) return
      if (saved === (owner.controller.getSnapshot().view === 'saved')) {
        cancelGeometry()
        return
      }
      const stamp = await capture()
      if (stamp && owns({ stamp })) owner.controller.select({ saved })
    },
    open: async ({ artifactId }) => {
      if (
        !current() ||
        owner.navigation ||
        !owner.controller.getSnapshot().items.some((item) => item.id === artifactId)
      ) {
        return
      }
      const stamp = await capture()
      if (stamp && owns({ stamp })) {
        navigate({ artifactId })
      }
    },
    onTouchStart: () => {
      if (state.revision !== owner.controller.getSnapshot().revision) return
      if (current() && state.view === owner.controller.getSnapshot().view) cancelGeometry()
    },
    onTouchMove: () => {
      if (state.revision !== owner.controller.getSnapshot().revision) return
      if (current() && state.view === owner.controller.getSnapshot().view) cancelGeometry()
    },
    onScroll: (event) => {
      if (!current() || state.view !== owner.controller.getSnapshot().view) return
      if (state.revision !== owner.controller.getSnapshot().revision) return
      const top = finite({ value: event.detail?.scrollTop })
      if (!owner.programmatic || Math.abs(owner.programmatic.top - top) > 2) cancelGeometry()
      const position = owner.controller.getSnapshot().position
      owner.controller.setPosition({ position: { ...position, scrollTop: top } })
      setRestored({ owner, view: state.view, top })
    },
  }
}
