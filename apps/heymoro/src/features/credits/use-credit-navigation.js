import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationApi } from '../../creation-api'
import { createCreditNavigation } from './task-link'
import { useCreditOwner } from './use-credit-pages'

/** Native IO adapter shared by both credit pages and the two read-only entries. */
export function useCreditNavigation({ account, beforeDispatch }) {
  const owner = useCreditOwner({ account })
  const capture = useRef(beforeDispatch)
  capture.current = beforeDispatch
  const navigation = useMemo(
    () =>
      createCreditNavigation({
        readTask: (args) => creationApi.task(args),
        navigate: (options) => Taro.navigateTo(options),
        isCurrent: owner.current,
        beforeDispatch: async () => (capture.current ? capture.current() : true),
        feedback: () => Taro.showToast({ title: '页面未打开，请点选重试', icon: 'none' }),
      }),
    [owner]
  )
  const [, render] = useState(0)
  useEffect(() => navigation.subscribe(() => render((value) => value + 1)), [navigation])
  useEffect(
    () => () => {
      Promise.resolve().then(() => {
        if (!owner.active) navigation.dispose()
      })
    },
    [owner, navigation]
  )
  useDidHide(() => {
    navigation.hide()
    render((value) => value + 1)
  })
  useDidShow(navigation.show)
  return { ...navigation, ...navigation.getSnapshot() }
}
