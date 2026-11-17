import { Button, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import React from 'react'

import { Action, Brand, NavBar, Notice, OfficialImage, openTemplate } from '../../components/primitives'
import { creationApi } from '../../creation-api'
import { useAccount } from '../../use-account'
import { useCursorList } from '../../use-cursor-list'

export default function HomePage() {
  const account = useAccount()
  const catalog = useCursorList({ read: creationApi.templates })
  const sessions = useCursorList({
    read: creationApi.sessions,
    accountKey: account.accountKey,
    enabled: !!account.user
  })
  const recent = sessions.items[0]
  const featured = catalog.items[0]
  const display = featured?.displayConfig
  return (
    <View className="screen">
      <NavBar title="Heymoro" />
      <ScrollView className="page-scroll" scrollY onScrollToLower={catalog.load}>
        <View className="scroll-content">
          {recent && (
            <View
              className="continue-card"
              onClick={() => Taro.navigateTo({ url: `/pages/create/index?session=${recent.id}` })}
            >
              <Text className="strong ellipsis">{recent.title}</Text>
              <Text className="small muted">继续上次创作 ›</Text>
            </View>
          )}
          <View className="row row--between home-kicker">
            <Text className="eyebrow">本期玩法</Text>
            <Action quiet className="compact" onClick={() => openTemplate({ templateId: '' })}>
              ＋ 自由创作
            </Action>
          </View>
          {catalog.error && <Notice onRetry={catalog.load}>{catalog.error}</Notice>}
          {catalog.loading && (
            <View className="inline-loading">
              <Brand animated />
            </View>
          )}
          {featured && (
            <>
              <Text className="home-headline">{display.name}</Text>
              <View onClick={() => openTemplate(featured)}>
                <OfficialImage mediaId={display.coverMediaId} shareKey={display.showcaseShareKeys[0]} className="home-cover" />
              </View>
              <Text className="home-description muted">{display.description}</Text>
              <Action onClick={() => openTemplate(featured)}>试试这个玩法</Action>
            </>
          )}
          <View className="row row--between section-heading">
            <Text className="section-title">更多玩法</Text>
            <Button className="text-button" onClick={() => Taro.switchTab({ url: '/pages/effects/index' })}>
              全部特效 ›
            </Button>
          </View>
          <View className="home-more">
            {catalog.items.slice(1, 4).map((template) => (
              <View
                className="home-more__item"
                key={template.templateId}
                onClick={() => openTemplate(template)}
              >
                <OfficialImage mediaId={template.displayConfig.coverMediaId} shareKey={template.displayConfig.showcaseShareKeys[0]} />
                <Text>{template.displayConfig.name}</Text>
              </View>
            ))}
          </View>
          {catalog.loaded && !catalog.items.length && <Notice onRetry={catalog.load}>当前暂无可用玩法</Notice>}
          {catalog.hasMore && (
            <Button className="text-button" onClick={catalog.load}>
              查看更多玩法
            </Button>
          )}
        </View>
      </ScrollView>
    </View>
  )
}
