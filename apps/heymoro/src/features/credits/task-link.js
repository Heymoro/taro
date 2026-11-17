const id = ({ value }) => Number.isSafeInteger(value) && value > 0

/** Closed destinations and owner-local read→dispatch→settle flight. Native unknown
 * pending is not a cancellable timer: only its first actual settlement counts. */
export function createCreditNavigation({
  readTask,
  navigate,
  isCurrent = () => true,
  feedback = () => {},
  beforeDispatch,
}) {
  let visible = true
  let disposed = false
  let intent = 0
  let flight = null
  const listeners = new Set()
  const current = () => !disposed && visible && isCurrent()
  const emit = () => {
    if (current()) listeners.forEach((listener) => listener())
  }
  const report = () => {
    if (!current()) return
    try {
      Promise.resolve(feedback()).catch(() => {})
    } catch {
      /* native feedback is best-effort */
    }
  }
  const open = async ({ entry, reservation, destination }) => {
    if (!current() || flight) return
    const taskId = reservation?.taskId ?? entry?.taskId
    if (!destination && !id({ value: taskId })) return
    const target = destination || (reservation ? `reservation:${reservation.reservationId}` : `ledger:${entry.id}`)
    const request = { intent, target, dispatched: false, settled: false, hidden: false, feedback: true }
    flight = request
    emit()
    const owns = () => current() && flight === request && intent === request.intent
    const settle = ({ failed = false } = {}) => {
      if (request.settled) return
      request.settled = true
      if (disposed || flight !== request) return
      if (failed || (request.hidden && current())) flight = null
      emit()
      if (failed && request.feedback) report()
    }
    try {
      if (!owns()) return
      let url = destination
      if (!destination) {
        const fresh = await readTask({ taskId, isInterested: owns })
        if (!owns()) return
        if (
          !id({ value: fresh?.id }) ||
          !id({ value: fresh.sessionId }) ||
          !id({ value: fresh.roundNo }) ||
          fresh.id !== taskId ||
          (reservation && (fresh.sessionId !== reservation.sessionId || fresh.roundNo !== reservation.roundNo))
        ) {
          throw Error('TASK_BINDING_MISMATCH')
        }
        url = `/pages/create/index?session=${fresh.sessionId}&focusTask=${fresh.id}`
      }
      if (beforeDispatch) {
        const allowed = await beforeDispatch()
        if (allowed === false || !owns()) return
      }
      if (!owns()) return
      request.dispatched = true
      try {
        const result = navigate({ url, success: () => settle(), fail: () => settle({ failed: true }) })
        emit()
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).then(
            () => settle(),
            () => settle({ failed: true })
          )
        }
      } catch {
        settle({ failed: true })
      }
    } catch {
      if (owns()) {
        flight = null
        emit()
        report()
      }
    } finally {
      if (flight === request && !request.dispatched) {
        flight = null
        emit()
      }
    }
  }
  const cancel = () => {
    intent++
    if (flight && !flight.dispatched) flight = null
    emit()
  }
  return {
    // UI feedback follows the current visible intent, not the native-flight lock.
    // A hidden unknown flight stays held even when it no longer paints feedback.
    getSnapshot: () => {
      const shown = Boolean(flight && !flight.hidden && current())
      return {
        pending: shown,
        target: shown ? flight.target : null,
        phase: !flight ? 'idle' : flight.dispatched ? 'native' : 'read',
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    openLedger: ({ entry }) => open({ entry }),
    openReservation: ({ reservation }) => open({ reservation }),
    openCredits: () => open({ destination: '/pages/credits/index' }),
    openReservations: () => open({ destination: '/pages/credit-reservations/index' }),
    cancel,
    hide: () => {
      visible = false
      if (flight?.dispatched) {
        flight.hidden = true
        flight.feedback = false
      }
      cancel()
    },
    show: () => {
      visible = true
      if (flight?.hidden && flight.settled) flight = null
      emit()
    },
    dispose: () => {
      disposed = true
      cancel()
      flight = null
      listeners.clear()
    },
  }
}
