import { createRetainedCursorList } from '../../retained-cursor-list'

const emptyPosition = () => ({ scrollTop: 0, anchor: null, neighbors: [] })

/** Owner-local account read and lazy ledger. No wallet amount is derived from rows. */
export function createCreditWallet({ readAccount, readLedger, isCurrent = () => true }) {
  let visible = true
  let disposed = false
  let started = false
  let tab = 'balance'
  let epoch = 0
  let accountFlight = null
  let account = { value: null, loaded: false, loading: false, error: '' }
  let balancePosition = emptyPosition()
  let ledgerPosition = emptyPosition()
  const listeners = new Set()
  const current = () => !disposed && isCurrent()
  const emit = () => {
    if (current()) listeners.forEach((fn) => fn())
  }
  const ledger = createRetainedCursorList({
    read: readLedger,
    identity: (row) => row.id,
    isCurrent: () => current() && visible && tab === 'ledger',
  })
  const unsubscribe = ledger.subscribe(emit)
  const read = async () => {
    if (!current() || !visible || accountFlight) return
    const request = { epoch }
    accountFlight = request
    const interested = () => current() && visible && accountFlight === request && epoch === request.epoch
    account = { ...account, loading: true, error: '' }
    emit()
    try {
      if (!interested()) return
      const value = await readAccount({ isInterested: interested })
      if (interested()) account = { value, loaded: true, loading: true, error: '' }
    } catch {
      if (interested()) account = { ...account, error: '积分暂时无法读取，请重试' }
    } finally {
      if (accountFlight === request) {
        accountFlight = null
        account = { ...account, loading: false }
        emit()
      }
    }
  }
  const start = () => {
    if (started || !current() || !visible) return
    started = true
    return read()
  }
  return {
    getSnapshot: () => ({
      ...ledger.getSnapshot(),
      account,
      view: tab,
      position: tab === 'balance' ? balancePosition : ledgerPosition,
    }),
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    start,
    show: () => {
      const fresh = !visible
      visible = true
      if (!started) return start()
      if (!fresh) return
      const tasks = [read()]
      if (tab === 'ledger') tasks.push(ledger.show())
      return Promise.all(tasks)
    },
    hide: () => {
      if (!visible || disposed) return
      visible = false
      epoch++
      accountFlight = null
      account = { ...account, loading: false }
      ledger.hide()
      emit()
    },
    select: ({ tab: next }) => {
      if (!current() || !visible || !['balance', 'ledger'].includes(next) || tab === next) return
      if (tab === 'ledger') ledger.suspend()
      tab = next
      emit()
      if (tab === 'ledger') return ledger.activate({ retryErrors: false })
    },
    load: () => tab === 'ledger' && ledger.load(),
    continueUpdating: () => tab === 'ledger' && ledger.continueUpdating(),
    refresh: () => (tab === 'ledger' ? ledger.refresh() : read()),
    refreshAccount: read,
    setPosition: ({ position }) => {
      if (!current() || !visible) return
      if (tab === 'balance') {
        balancePosition = { ...emptyPosition(), ...position }
        emit()
      } else {
        ledgerPosition = { ...emptyPosition(), ...position }
        emit()
      }
    },
    dispose: () => {
      disposed = true
      epoch++
      accountFlight = null
      unsubscribe()
      ledger.dispose()
      listeners.clear()
    },
  }
}

export function createCreditReservations({ read, isCurrent = () => true }) {
  let position = emptyPosition()
  let visible = true
  let disposed = false
  const listeners = new Set()
  const list = createRetainedCursorList({ read, identity: (row) => row.reservationId, isCurrent })
  const emit = () => {
    if (!disposed && isCurrent()) listeners.forEach((listener) => listener())
  }
  const unsubscribe = list.subscribe(emit)
  return {
    ...list,
    getSnapshot: () => ({ ...list.getSnapshot(), view: 'reservations', position }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hide: () => {
      visible = false
      list.hide()
    },
    show: () => {
      visible = true
      return list.show()
    },
    setPosition: ({ position: next }) => {
      if (disposed || !visible || !isCurrent()) return
      position = { ...emptyPosition(), ...next }
      emit()
    },
    dispose: () => {
      disposed = true
      unsubscribe()
      list.dispose()
      listeners.clear()
    },
  }
}
