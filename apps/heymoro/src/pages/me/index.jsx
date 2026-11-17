import { Button, Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import React, { useEffect, useRef, useState } from 'react'

import meIcon from '../../assets/me-selected.png'
import { updateCurrentUser } from '../../auth'
import { Brand, NavBar, Notice } from '../../components/primitives'
import { creationApi, invalidateCreationUser } from '../../creation-api'
import { useCreditNavigation } from '../../features/credits/use-credit-navigation'
import { creationAccountKey, useAccount } from '../../use-account'
import { useCursorList } from '../../use-cursor-list'

export default function MePage() {
  const account = useAccount()
  const creditsNavigation = useCreditNavigation({ account })
  const openingCredits = creditsNavigation.pending && creditsNavigation.target === '/pages/credits/index'
  const [wallet, setWallet] = useState({ key: '', value: null, error: '' })
  const generation = useRef(0)
  const sessions = useCursorList({
    read: creationApi.sessions,
    accountKey: account.accountKey,
    enabled: !!account.user
  })
  const load = async () => {
    if (!account.user) return
    const epoch = ++generation.current
    const key = account.accountKey
    setWallet({ key, value: null, error: '' })
    try {
      const value = await creationApi.account()
      if (epoch === generation.current && key === creationAccountKey()) setWallet({ key, value, error: '' })
    } catch {
      if (epoch === generation.current && key === creationAccountKey()) {
        setWallet({ key, value: null, error: '积分暂时无法读取，请重试' })
      }
    }
  }
  useEffect(() => {
    load()
    return () => {
      generation.current++
    }
  }, [account.accountKey, account.user?.id])
  useDidShow(() => {
    if (account.user) load()
  })
  const rename = async () => {
    const key = account.accountKey
    const answer = await Taro.showModal({
      title: '编辑昵称',
      editable: true,
      placeholderText: account.user?.displayName || '微信用户',
      confirmText: '保存'
    })
    if (!answer.confirm || !answer.content?.trim() || key !== creationAccountKey()) return
    try {
      await updateCurrentUser({ displayName: answer.content })
      if (key !== creationAccountKey()) return
      invalidateCreationUser()
      await account.refresh()
    } catch {
      if (key === creationAccountKey()) {
        setWallet((previous) => ({ ...previous, error: '昵称没有保存成功，请重试' }))
      }
    }
  }
  const balance = wallet.key === account.accountKey ? wallet.value : null
  const recent = sessions.items[0]
  const accountReady = !!account.user && !account.loading && !account.error
  const confirmedEmpty = accountReady && sessions.loaded && !sessions.loading &&
    !sessions.error && !sessions.warning && !recent && !sessions.hasMore
  return (
    <View className="screen">
      <NavBar title="我的" />
      <ScrollView className="page-scroll" scrollY>
        <View className="scroll-content">
          {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
          {wallet.key === account.accountKey && wallet.error && <Notice onRetry={load}>{wallet.error}</Notice>}
          {account.loading && (
            <View className="inline-loading">
              <Brand animated />
            </View>
          )}
          <View className="profile-row" onClick={rename}>
            <View className="profile-avatar">
              <Image src={meIcon} style={{ width: '24px', height: '24px' }} />
            </View>
            <View className="profile-name">
              <Text className="section-title">{account.user?.displayName || '微信用户'}</Text>
              <Text className="muted small">编辑昵称</Text>
            </View>
            <Text className="muted">›</Text>
          </View>
          <View className="wallet-card" onClick={creditsNavigation.openCredits}>
            <View className="settings-row">
              <Text className="strong">可用积分{openingCredits && <Text className="small muted"> · 正在打开…</Text>}</Text>
              <Text className="strong link">{balance ? `${balance.available} 点 ›` : '—'}</Text>
            </View>
            <View className="settings-row">
              <Text>处理中占用</Text>
              <Text className="muted">{balance ? `${balance.reserved} 点` : '—'}</Text>
            </View>
          </View>
          <View className="settings-group">
            <View
              className="settings-row settings-row--tall"
              onClick={() => Taro.navigateTo({ url: '/pages/cabinet/index' })}
            >
              <Text className="strong">作品收纳柜</Text>
              <Text>›</Text>
            </View>
            <View className="settings-row">
              <Text>最近创作</Text>
              <Button className="text-button" onClick={() => Taro.navigateTo({ url: '/pages/sessions/index' })}>
                查看全部 ›
              </Button>
            </View>
            {(sessions.error || sessions.warning) && (
              <Notice onRetry={sessions.error ? sessions.load : sessions.refresh}>
                {sessions.error || sessions.warning}
              </Notice>
            )}
            {!recent && sessions.loading && (
              <View className="inline-loading">
                <Brand animated />
              </View>
            )}
            {recent && (
              <View
                className="recent-session"
                onClick={() => Taro.navigateTo({ url: `/pages/create/index?session=${recent.id}` })}
              >
                <Text className="strong ellipsis">{recent.title}</Text>
                <Text className="small muted">继续创作 ›</Text>
              </View>
            )}
            {!recent && accountReady && sessions.loaded && !sessions.loading &&
              !sessions.error && !sessions.warning && sessions.hasMore && (
              <View className="settings-row">
                <Button className="text-button" onClick={sessions.load}>
                  继续读取
                </Button>
              </View>
            )}
            {confirmedEmpty && (
              <View className="settings-row">
                <Text className="muted">暂无记录</Text>
                <Button className="text-button" onClick={() => Taro.switchTab({ url: '/pages/effects/index' })}>
                  去创作 ›
                </Button>
              </View>
            )}
          </View>
          <View className="settings-group">
            <View
              className="settings-row"
              onClick={() =>
                Taro.showModal({
                  title: '使用说明',
                  content: '照片和作品保存在当前账号，收藏不等于下载。支付、分享与 AI 配文尚未开放。',
                  showCancel: false
                })
              }
            >
              <Text>设置与说明</Text>
              <Text>›</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}
