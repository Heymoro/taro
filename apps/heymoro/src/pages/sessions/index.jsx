import { Button, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import React from 'react'

import { Brand, NavBar, Notice } from '../../components/primitives'
import PrivateImage from '../../components/PrivateImage'
import { creationApi } from '../../creation-api'
import { useAccount } from '../../use-account'
import { useCursorList } from '../../use-cursor-list'

export default function SessionsPage() {
  const account = useAccount()
  const list = useCursorList({
    read: creationApi.sessions,
    accountKey: account.accountKey,
    enabled: !!account.user
  })
  return (
    <View className="screen">
      <NavBar title="我的创作" canBack />
      <ScrollView className="page-scroll" scrollY onScrollToLower={list.load}>
        <View className="scroll-content">
          {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
          {list.error && <Notice onRetry={list.load}>{list.error}</Notice>}
          {list.items.map((item) => (
            <View
              className="session-card"
              key={item.id}
              onClick={() => Taro.navigateTo({ url: `/pages/create/index?session=${item.id}` })}
            >
              {item.cover && (
                <PrivateImage
                  mediaId={item.cover.mediaId}
                  accountKey={account.accountKey}
                  className="session-card__cover"
                />
              )}
              <View>
                <Text className="strong ellipsis">{item.title}</Text>
                <Text className="small muted">{item.runningTask ? '处理中 · 继续查看' : '继续创作 ›'}</Text>
              </View>
            </View>
          ))}
          {list.loading && (
            <View className="inline-loading">
              <Brand animated />
            </View>
          )}
          {list.loaded && !list.items.length && !list.hasMore && (
            <Text className="list-status">从一个喜欢的特效开始吧。</Text>
          )}
          {list.loaded && list.hasMore && (
            <Button className="text-button" onClick={list.load}>
              读取更多创作
            </Button>
          )}
        </View>
      </ScrollView>
    </View>
  )
}
