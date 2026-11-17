import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationApi } from '../../creation-api'
import { creationAccountKey } from '../../use-account'
import { createCreditReservations, createCreditWallet } from './credits-state'

/** Identity metadata only. A temporary /me failure must not dispose a same-key
 * committed prefix or release a native transition whose outcome is unknown. */
export function useCreditOwner({ account }) {
  const page = useRef(Taro.getCurrentInstance?.().page)
  const binding = useRef({ key: '', userId: null })
  if (binding.current.key !== account.accountKey) {
    binding.current = { key: account.accountKey, userId: account.user?.id || null }
  } else if (account.user?.id) binding.current.userId = account.user.id
  const key = account.accountKey
  const userId = binding.current.userId
  const live = useRef(null)
  const visible = useRef(true)
  const owner = useMemo(() => {
    const value = { active: true, visible: visible.current }
    value.current = () => {
      const stack = Taro.getCurrentPages?.()
      return (
        value.active &&
        live.current === value &&
        value.visible &&
        Boolean(key && userId && page.current) &&
        key === creationAccountKey() &&
        Array.isArray(stack) &&
        stack.at(-1) === page.current
      )
    }
    value.identityCurrent = () =>
      value.active && live.current === value && Boolean(key && userId) && key === creationAccountKey()
    return value
  }, [key, userId])
  live.current = owner
  useEffect(() => {
    owner.active = true
    return () => {
      owner.active = false
    }
  }, [owner])
  useDidHide(() => {
    visible.current = false
    owner.visible = false
  })
  useDidShow(() => {
    visible.current = true
    owner.visible = true
  })
  return owner
}

function useCreditPage({ account, reservations }) {
  const owner = useCreditOwner({ account })
  const controller = useMemo(() => {
    if (reservations) {
      return createCreditReservations({ read: creationApi.creditReservations, isCurrent: owner.current })
    }
    return createCreditWallet({
      readAccount: creationApi.account,
      readLedger: creationApi.creditLedger,
      isCurrent: owner.current,
    })
  }, [owner, reservations])
  const [, render] = useState(0)
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => render((value) => value + 1))
    if (owner.visible) controller.start()
    else controller.hide()
    return () => {
      unsubscribe()
      Promise.resolve().then(() => {
        if (!owner.active) controller.dispose()
      })
    }
  }, [owner, controller])
  useDidHide(() => controller.hide())
  useDidShow(() => controller.show())
  const state = controller.getSnapshot()
  const valid = owner.identityCurrent()
  if (valid) return { owner, controller, state }
  const snapshot = {
    ...state,
    items: [],
    loaded: false,
    loading: false,
    error: '',
    warning: '',
    paused: false,
    account: state.account ? { value: null, loaded: false, loading: false, error: '' } : undefined,
  }
  return { owner, controller, state: snapshot }
}

export function useCreditWallet({ account }) {
  return useCreditPage({ account, reservations: false })
}
export function useCreditReservations({ account }) {
  return useCreditPage({ account, reservations: true })
}
