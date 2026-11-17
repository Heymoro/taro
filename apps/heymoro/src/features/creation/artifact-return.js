const REQUEST = 'creation:return:request'
const ACK = 'creation:return:ack'
const TIMEOUT = 5000
let intentSequence = 0
const positive = ({ value }) => Number.isSafeInteger(value) && value > 0
const sameBinding = ({ a, b }) =>
  a?.sessionId === b?.sessionId && a?.taskId === b?.taskId && a?.artifactId === b?.artifactId
const detailMatches = ({ page, binding }) =>
  page && Number(page.options?.id) === binding.artifactId && page.route === 'pages/artifact/index'

function detach({ channel, event, callback }) {
  if (typeof callback !== 'function') return
  try {
    if (typeof channel?.off === 'function') channel.off(event, callback)
  } catch {
    // Native cleanup failure must not keep a logically terminal visit or action alive.
  }
}

// Native APIs may settle via callbacks, promises, both, or neither. Void is not success.
function navigate({ invoke, onSuccess, onFailure }) {
  let settled = false
  const success = (result) => {
    if (settled) return
    settled = true
    onSuccess(result)
  }
  const fail = () => {
    if (settled) return
    settled = true
    onFailure()
  }
  try {
    const result = invoke({ success, fail })
    if (result?.then) result.then(success, fail)
  } catch {
    fail()
  }
}

/** One outbound native detail visit. No creation facts are owned here. */
export function createArtifactOpener({ native, page, readOwner, acceptFocus, onError }) {
  let visit = null
  let disposed = false
  const release = ({ candidate = visit } = {}) => {
    if (!candidate) return
    clearTimeout(candidate.timer)
    detach({ channel: candidate.channel, event: REQUEST, callback: candidate.request })
    if (visit === candidate) visit = null
  }
  const owns = ({ candidate }) => {
    const owner = readOwner()
    return (
      !disposed &&
      visit === candidate &&
      owner?.accountKey &&
      owner.accountKey === candidate.owner.accountKey &&
      owner.controller === candidate.owner.controller &&
      owner.sessionId === candidate.binding.sessionId
    )
  }
  const acknowledge = ({ candidate, ack }) => {
    try {
      candidate.channel.emit(ACK, ack)
    } catch {
      if (owns({ candidate })) onError('返回通道未就绪，请使用左上角返回')
    }
  }
  const returned = ({ candidate }) => {
    if (!owns({ candidate })) {
      release({ candidate })
      return
    }
    const pages = native.getCurrentPages?.() || []
    if (pages.at(-1) !== page) return
    candidate.returned = true
    if (!candidate.confirmed) return
    if (!candidate.accepted) acceptFocus({ ...candidate.binding, mode: 'preserve' })
    release({ candidate })
  }
  return {
    isPending: () => Boolean(visit),
    open({ taskId, artifactId }) {
      if (disposed || visit) return false
      const owner = readOwner()
      if (
        !owner?.accountKey ||
        !owner.controller ||
        !positive({ value: owner.sessionId }) ||
        !positive({ value: taskId }) ||
        !positive({ value: artifactId }) ||
        !page ||
        native.getCurrentPages?.().at(-1) !== page
      ) {
        onError('原创作归属已变化，请重新打开作品')
        return false
      }
      const candidate = {
        owner,
        binding: { sessionId: owner.sessionId, taskId, artifactId },
        channel: null,
        confirmed: false,
        accepted: false,
        returned: false,
        ack: null
      }
      visit = candidate
      candidate.request = (request) => {
        if (!owns({ candidate })) {
          release({ candidate })
          return
        }
        const pages = native.getCurrentPages?.() || []
        const detail = pages.at(-1)
        const accepted = Boolean(
          typeof request?.intentId === 'string' &&
            request.intentId &&
            sameBinding({ a: request, b: candidate.binding }) &&
            pages.at(-2) === page &&
            detailMatches({ page: detail, binding: candidate.binding }) &&
            (!candidate.detail || candidate.detail === detail)
        )
        if (accepted) candidate.detail = candidate.detail || detail
        if (accepted && !candidate.accepted) {
          candidate.accepted = acceptFocus({ ...candidate.binding, mode: 'preserve' }) === true
        }
        const ack = {
          intentId: request?.intentId,
          ...candidate.binding,
          accepted: accepted && candidate.accepted
        }
        if (accepted || !candidate.ack) candidate.ack = ack
        if (candidate.channel) acknowledge({ candidate, ack })
      }
      candidate.timer = setTimeout(() => {
        if (owns({ candidate }) && !candidate.confirmed) {
          onError('打开结果尚未确认，请返回后重新打开')
        }
      }, TIMEOUT)
      navigate({
        invoke: (callbacks) =>
          native.navigateTo({
            url: `/pages/artifact/index?id=${artifactId}&returnTo=opener`,
            events: { [REQUEST]: candidate.request },
            ...callbacks
          }),
        onSuccess: (result) => {
          let channelReady = false
          try {
            candidate.channel = result?.eventChannel
            channelReady =
              typeof candidate.channel?.emit === 'function' &&
              typeof candidate.channel?.off === 'function'
          } catch {
            /* Invalid native channel access is reported below for the current visit. */
          }
          if (!owns({ candidate })) {
            return release({ candidate })
          }
          clearTimeout(candidate.timer)
          candidate.confirmed = true
          const pages = native.getCurrentPages?.() || []
          if (
            pages.at(-2) === page &&
            detailMatches({ page: pages.at(-1), binding: candidate.binding })
          ) {
            candidate.detail = candidate.detail || pages.at(-1)
          }
          if (!channelReady) {
            onError('返回通道未就绪，请使用左上角返回')
          } else if (candidate.ack) acknowledge({ candidate, ack: candidate.ack })
          if (candidate.returned) returned({ candidate })
        },
        onFailure: () => {
          if (!owns({ candidate })) {
            return release({ candidate })
          }
          onError('作品未打开，请重试')
          release({ candidate })
        }
      })
      return true
    },
    show() {
      if (visit) returned({ candidate: visit })
    },
    invalidate() {
      if (visit && !owns({ candidate: visit })) release()
    },
    dispose() {
      disposed = true
      release()
    }
  }
}

/** One detail page's explicit return handshake; page getter keeps its native receiver. */
export function createArtifactReturn({ native, page, readOwner, onError }) {
  let disposed = false
  let action = null
  const owns = ({ flight }) => {
    const owner = readOwner()
    return (
      !disposed &&
      action === flight &&
      owner?.accountKey === flight.owner.accountKey &&
      sameBinding({ a: owner, b: flight.owner })
    )
  }
  const current = ({ flight }) => {
    const pages = native.getCurrentPages?.() || []
    return (
      owns({ flight }) &&
      page &&
      pages.at(-1) === page &&
      (!flight.opener || pages.at(-2) === flight.parent)
    )
  }
  const reportStackChange = ({ flight }) => {
    if (owns({ flight }) && native.getCurrentPages?.().at(-1) === page) {
      onError('原创作页面已变化，请使用左上角返回')
    }
  }
  const clean = ({ flight }) => {
    clearTimeout(flight.timer)
    detach({ channel: flight.channel, event: ACK, callback: flight.ack })
  }
  const back = ({ flight }) => {
    if (!current({ flight })) {
      reportStackChange({ flight })
      clean({ flight })
      if (action === flight) action = null
      return
    }
    if (flight.phase === 'backing' || flight.phase === 'unknown') return
    flight.phase = 'backing'
    flight.timer = setTimeout(() => {
      if (!current({ flight })) {
        clean({ flight })
        if (action === flight) action = null
        return
      }
      flight.phase = 'unknown'
      onError('返回结果尚未确认，请使用左上角返回')
    }, TIMEOUT)
    navigate({
      invoke: (callbacks) => native.navigateBack({ delta: 1, ...callbacks }),
      onSuccess: () => {
        // Native success may already have removed this page from the stack.
        if (action !== flight || disposed) return
        clean({ flight })
        action = null
      },
      onFailure: () => {
        if (!current({ flight })) return
        clean({ flight })
        action = null
        onError('返回未完成，请重试返回创作')
      }
    })
  }
  return {
    isPending: () => Boolean(action),
    returnToCreation({ opener }) {
      if (disposed) return false
      if (action) {
        if (!current({ flight: action })) {
          reportStackChange({ flight: action })
          clean({ flight: action })
          action = null
          return false
        }
        if (action.phase === 'accepted') back({ flight: action })
        return false
      }
      const owner = readOwner()
      if (
        !owner?.accountKey ||
        !positive({ value: owner.sessionId }) ||
        !positive({ value: owner.taskId }) ||
        !positive({ value: owner.artifactId }) ||
        !detailMatches({ page, binding: owner }) ||
        native.getCurrentPages?.().at(-1) !== page ||
        (opener && native.getCurrentPages?.().at(-2)?.route !== 'pages/create/index')
      ) {
        onError('原创作归属已变化，请使用左上角返回')
        return false
      }
      const flight = {
        owner: { ...owner },
        phase: 'waiting',
        opener,
        parent: native.getCurrentPages?.().at(-2)
      }
      action = flight
      if (!opener) {
        flight.phase = 'unknown'
        flight.timer = setTimeout(() => {
          if (current({ flight })) onError('打开结果尚未确认，请使用左上角返回')
        }, TIMEOUT)
        navigate({
          invoke: (callbacks) =>
            native.navigateTo({
              url: `/pages/create/index?session=${owner.sessionId}&focusTask=${owner.taskId}`,
              ...callbacks
            }),
          onSuccess: () => {
            if (action !== flight || disposed) return
            clean({ flight })
            action = null
          },
          onFailure: () => {
            if (!current({ flight })) return
            clean({ flight })
            action = null
            onError('创作未打开，请重试')
          }
        })
        return true
      }
      try {
        if (typeof page.getOpenerEventChannel !== 'function') throw Error('CHANNEL_UNAVAILABLE')
        flight.channel = page.getOpenerEventChannel()
        if (
          typeof flight.channel?.on !== 'function' ||
          typeof flight.channel?.off !== 'function' ||
          typeof flight.channel?.emit !== 'function'
        ) {
          throw Error('CHANNEL_UNAVAILABLE')
        }
        const intentId = `return-${Date.now()}-${++intentSequence}`
        flight.ack = (ack) => {
          if (!current({ flight })) {
            reportStackChange({ flight })
            clean({ flight })
            if (action === flight) action = null
            return
          }
          if (flight.phase !== 'waiting') return
          if (ack?.intentId !== intentId || !sameBinding({ a: ack, b: owner })) return
          clean({ flight })
          if (ack.accepted !== true) {
            action = null
            onError('原创作已变化，请使用左上角返回')
            return
          }
          flight.phase = 'accepted'
          back({ flight })
        }
        flight.timer = setTimeout(() => {
          const valid = current({ flight })
          clean({ flight })
          if (action === flight) action = null
          if (valid) onError('原创作尚未确认返回，请重试或使用左上角返回')
        }, TIMEOUT)
        flight.channel.on(ACK, flight.ack)
        flight.channel.emit(REQUEST, {
          intentId,
          sessionId: owner.sessionId,
          taskId: owner.taskId,
          artifactId: owner.artifactId
        })
      } catch {
        // An accepted synchronous ack has already transferred control to native navigation.
        if (action !== flight || flight.phase !== 'waiting') return true
        const valid = current({ flight })
        clean({ flight })
        action = null
        if (valid) onError('返回通道未就绪，请使用左上角返回')
        return false
      }
      return true
    },
    invalidate() {
      if (action && !current({ flight: action })) {
        clean({ flight: action })
        action = null
      }
    },
    dispose() {
      disposed = true
      if (action) clean({ flight: action })
      action = null
    }
  }
}
