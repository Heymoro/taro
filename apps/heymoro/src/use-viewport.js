import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'

function windowSize() {
  try {
    const { windowHeight: height, windowWidth: width } = Taro.getWindowInfo()
    return Number.isFinite(height) && height > 0 && Number.isFinite(width) && width > 0 ? { height, width } : null
  } catch {
    return null
  }
}

function currentPage() {
  try {
    return Taro.getCurrentInstance()?.page
  } catch {
    return null
  }
}

function sameSize({ first, second }) {
  return !!first && !!second && first.height === second.height && first.width === second.width
}

function measuredSize({ rect, sdk }) {
  if (!rect || !sdk) return null
  const { top, left, bottom, right, width, height } = rect
  if (![top, left, bottom, right, width, height].every(Number.isFinite)) return null
  // The independent fixed probe must describe the whole CSS viewport, not a child/content rect.
  if (height <= 0 || width <= 0 || Math.abs(top) > 1 || Math.abs(left) > 1) return null
  if (Math.abs(bottom - top - height) > 1 || Math.abs(right - left - width) > 1) return null
  if (Math.abs(width - sdk.width) > 1) return null
  return { height, width }
}

export function useViewport() {
  const owner = useRef(currentPage())
  const state = useRef({
    alive: false,
    foreground: true,
    epoch: 0,
    focused: false,
    // Initial mount has no owned input yet. Invalid geometry later needs a native
    // closed-input signal, or a successful bounded hideKeyboard recovery.
    closed: true,
    cycle: false,
    keyboard: 0,
    sdk: null,
    baseline: null,
    closeAttempt: null,
  })
  const [viewport, setViewport] = useState({ keyboard: 0, style: {} })

  const ownsForeground = () => {
    const value = state.current
    if (!value.alive || !value.foreground || !owner.current) return false
    try {
      const pages = Taro.getCurrentPages()
      return currentPage() === owner.current && pages[pages.length - 1] === owner.current
    } catch {
      return false
    }
  }
  const publish = () => {
    const value = state.current
    let height
    if (value.cycle && value.baseline && value.sdk) {
      const { rendered, sdk } = value.baseline
      const occlusion = Math.max(value.keyboard, sdk.height - value.sdk.height, 0)
      const target = rendered.height - occlusion
      if (occlusion > 0 && Number.isFinite(target) && target > 0) height = `${target}px`
    }
    setViewport({ keyboard: value.keyboard, style: height ? { height } : {} })
  }
  const invalidate = () => {
    const value = state.current
    value.epoch++
    value.baseline = null
    value.cycle = false
    value.closed = false
    if (value.closeAttempt) value.closeAttempt.zero = false
  }
  const measure = ({ verifyCycle = false, closeAttempt = null, previous = null } = {}) => {
    if (!ownsForeground()) return
    const value = state.current
    if (closeAttempt && (value.closeAttempt !== closeAttempt || !closeAttempt.succeeded || value.focused)) return
    if (!verifyCycle && !closeAttempt && (!value.closed || value.keyboard > 0)) return
    const sdk = windowSize()
    if (!sdk) {
      invalidate()
      publish()
      return
    }
    const epoch = ++value.epoch
    const baseline = value.baseline
    // SDK and rect belong to one stable query epoch, on the exact native page.
    // The probe is outside the screen whose height this hook controls.
    try {
      Taro.nextTick?.(() => {
        if (!ownsForeground() || epoch !== value.epoch) return
        try {
          Taro.createSelectorQuery()
            .in(owner.current)
            .select('#creation-viewport-probe')
            .boundingClientRect()
            .exec((results) => {
              if (!ownsForeground() || epoch !== value.epoch) return
              if (!sameSize({ first: sdk, second: windowSize() })) {
                invalidate()
                publish()
                return
              }
              const rendered = measuredSize({ rect: results?.[0], sdk })
              if (closeAttempt) {
                if (value.closeAttempt !== closeAttempt || value.focused) return
                if (
                  !rendered ||
                  (previous &&
                    (!sameSize({ first: rendered, second: previous.rendered }) ||
                      !sameSize({ first: sdk, second: previous.sdk })))
                ) {
                  value.closeAttempt = null
                  invalidate()
                  publish()
                  return
                }
                if (!previous) {
                  measure({ closeAttempt, previous: { rendered, sdk } })
                  return
                }
                // hideKeyboard succeeded and two no-focus native frames agree. This
                // is a bounded SDK-contract recovery, not proof of physical animation.
                value.closed = true
                value.keyboard = 0
                value.sdk = sdk
                value.baseline = { rendered, sdk }
                value.closeAttempt = null
                publish()
                return
              }
              if (verifyCycle) {
                // A changed CSS viewport could already have resized for the keyboard,
                // or be a real window change. Neither is a proven occlusion baseline.
                if (!rendered || !baseline || !sameSize({ first: rendered, second: baseline.rendered })) {
                  invalidate()
                  publish()
                } else {
                  value.sdk = sdk
                  publish()
                }
                return
              }
              if (!value.closed || value.keyboard > 0) return
              value.sdk = sdk
              value.baseline = rendered ? { rendered, sdk } : null
              if (rendered) value.closeAttempt = null
              publish()
            })
        } catch {
          // Missing/unsupported native measurement is unknown, never guessed SDK pixels.
          if (ownsForeground() && epoch === value.epoch) {
            invalidate()
            publish()
          }
        }
      })
    } catch {
      // Scheduling can fail before the callback runs; keep effect cleanup reachable.
      if (ownsForeground() && epoch === value.epoch) {
        value.closeAttempt = null
        invalidate()
        publish()
      }
    }
  }
  const keyboardChanged = ({ height }) => {
    if (!ownsForeground()) return
    const value = state.current
    value.epoch++
    if (!Number.isFinite(height) || height < 0) {
      invalidate()
      value.keyboard = 0
      publish()
      return
    }
    value.keyboard = height
    if (height === 0) {
      value.cycle = false
      value.baseline = null
      const attempt = value.closeAttempt
      if (attempt) attempt.zero = true
      value.closed = !attempt || attempt.succeeded
      publish()
      measure()
      return
    }
    // Explicit height zero can close/re-pair while the same input stays focused.
    // Only its fresh closed pair can start another opening without a new focus.
    if (value.focused && value.closed && value.baseline) value.cycle = true
    value.closed = false
    // A positive notification during closing is evidence that it is not settled.
    value.closeAttempt = null
    // An event without a preceding owned focus cannot resurrect an invalid pair.
    if (!value.cycle) value.baseline = null
    publish()
    if (value.cycle && value.baseline) measure({ verifyCycle: true })
  }
  const onFocus = (event) => {
    if (!ownsForeground()) return
    const value = state.current
    value.epoch++
    value.closeAttempt = null
    value.focused = true
    value.closed = false
    value.cycle = true
    // Native textarea focus can carry the keyboard height before either notification.
    if (Number.isFinite(event?.detail?.height) && event.detail.height > 0) {
      keyboardChanged({ height: event.detail.height })
    }
  }
  const onBlur = () => {
    if (!ownsForeground()) return
    const value = state.current
    value.epoch++
    value.focused = false
    // Blur may just be a transfer between the two textareas; it is not height zero.
    if (value.closed) measure()
    else if (value.cycle && value.baseline) measure({ verifyCycle: true })
  }
  const resize = (event) => {
    if (!ownsForeground()) return
    const value = state.current
    const { windowHeight: height, windowWidth: width } = event.size || {}
    const previous = value.sdk
    const focusedClosed = value.focused && value.closed && value.baseline
    value.epoch++
    value.sdk = Number.isFinite(height) && height > 0 && Number.isFinite(width) && width > 0 ? { height, width } : null
    if (focusedClosed && value.sdk && previous?.width === width) {
      if (height >= previous.height) {
        // Closing native resize may arrive after zero. Re-pair the restored SDK
        // rather than freezing its smaller closing height for the next opening.
        invalidate()
        value.closed = true
        publish()
        measure()
        return
      }
      // Resize can precede the next positive event on an already owned input.
      value.cycle = true
      value.closed = false
    }
    if (!value.sdk || !previous || previous.width !== width || !value.cycle || !value.baseline) {
      // Outside a focus cycle, even same-width shrink is ambiguous. Rotation and
      // unknown dimensions also require a fresh, explicitly closed-input epoch.
      invalidate()
      publish()
      if (value.closeAttempt?.succeeded && !value.focused) measure({ closeAttempt: value.closeAttempt })
      return
    }
    publish()
    measure({ verifyCycle: true })
  }
  useEffect(() => {
    const value = state.current
    value.alive = true
    value.sdk = windowSize()
    const onKeyboard = (event) => keyboardChanged({ height: event.height })
    Taro.onKeyboardHeightChange?.(onKeyboard)
    Taro.onWindowResize?.(resize)
    measure()
    return () => {
      value.alive = false
      value.closeAttempt = null
      value.epoch++
      Taro.offKeyboardHeightChange?.(onKeyboard)
      Taro.offWindowResize?.(resize)
    }
    // Native listeners live once per mounted owner; their callbacks read refs.
  }, [])
  useDidHide(() => {
    const value = state.current
    if (!value.alive) return
    const closed = value.closed && !value.focused && value.keyboard === 0 && !value.cycle
    value.closeAttempt = null
    value.foreground = false
    value.focused = false
    value.keyboard = 0
    invalidate()
    value.closed = closed
    publish()
  })
  useDidShow(() => {
    const value = state.current
    if (!value.alive) return
    if (!value.foreground) {
      const closed = value.closed
      invalidate()
      value.closed = closed
      value.foreground = true
      value.sdk = windowSize()
    }
    measure()
    if (!value.closed && ownsForeground() && !value.focused) {
      const attempt = { succeeded: false, zero: false }
      value.closeAttempt = attempt
      const current = () => ownsForeground() && !value.focused && value.closeAttempt === attempt
      // Returning from an album may have lost the closing notification. Ask the
      // real native input to close. Success starts bounded stable-frame sampling;
      // a fresh native height-zero event can establish closure directly as well.
      const epoch = value.epoch
      try {
        Taro.nextTick?.(() => {
          if (!current()) return
          try {
            Taro.hideKeyboard({
              success: () => {
                if (!current()) return
                attempt.succeeded = true
                if (attempt.zero) {
                  value.closed = true
                  measure()
                } else measure({ closeAttempt: attempt })
              },
              fail: () => {
                if (!current()) return
                value.closeAttempt = null
                invalidate()
                publish()
              },
            })
          } catch {
            if (current()) value.closeAttempt = null
          }
        })
      } catch {
        if (current() && epoch === value.epoch) {
          value.closeAttempt = null
          invalidate()
          publish()
        }
      }
    }
  })
  return {
    ...viewport,
    onFocus,
    onKeyboardHeightChange: (event) => keyboardChanged({ height: event.detail?.height }),
    onBlur,
  }
}
