import { useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getCurrentUser, getStoredSession } from './auth'
import { ensureCreationUser } from './creation-api'

function accountIdentity() {
  const session = getStoredSession()
  return {
    key: session ? `${session.userId}:${session.token}:${session.expiresAt}` : '',
    userId: session?.userId
  }
}

export function creationAccountKey() {
  return accountIdentity().key
}

export function useAccount() {
  const [account, setAccount] = useState({ user: null, key: '', error: '', loading: true })
  const generation = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    if (!mounted.current) return null
    const epoch = ++generation.current
    const before = creationAccountKey()
    setAccount((previous) => ({
      user: previous.key === before ? previous.user : null,
      key: before,
      error: '',
      loading: true
    }))
    try {
      let user = await ensureCreationUser()
      if (!mounted.current || epoch !== generation.current) return null
      const after = accountIdentity()
      if (!after.key) throw Error('AUTH_REQUIRED')
      if (after.key !== before) {
        // A login or identity change invalidates the ensure candidate. Only read once.
        setAccount({ user: null, key: after.key, error: '', loading: true })
        user = await getCurrentUser()
        if (!mounted.current || epoch !== generation.current) return null
        if (accountIdentity().key !== after.key) throw Error('AUTH_REQUIRED')
      }
      if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.id !== after.userId) {
        throw Error('AUTH_REQUIRED')
      }
      setAccount({ user, key: after.key, error: '', loading: false })
      return user
    } catch (error) {
      if (mounted.current && epoch === generation.current) {
        setAccount({
          user: null,
          key: creationAccountKey(),
          error: error?.code === 'AUTH_UNCONFIGURED' ? '微信登录尚未配置' : '暂时连接不上，请检查网络后重试',
          loading: false
        })
      }
      return null
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  useDidShow(refresh)
  const valid = account.key === creationAccountKey()
  return {
    ...account,
    user: valid ? account.user : null,
    accountKey: valid ? account.key : '',
    refresh
  }
}
