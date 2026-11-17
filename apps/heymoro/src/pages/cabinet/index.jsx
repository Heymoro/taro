import { Button, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import React from 'react'

import { Action, Brand, NavBar, Notice } from '../../components/primitives'
import PrivateImage from '../../components/PrivateImage'
import { useCabinetList } from '../../features/cabinet/use-cabinet-list'
import { useAccount } from '../../use-account'

export default function CabinetPage() {
  const account = useAccount()
  const list = useCabinetList({ account })
  const saved = list.saved
  return (
    <View className="screen">
      <NavBar title="作品收纳柜" canBack />
      <View className="tabs">
        {[
          [false, '全部作品'],
          [true, '已收藏'],
        ].map(([value, title]) => (
          <Button
            key={title}
            className={`tabs__item ${saved === value ? 'tabs__item--active' : ''}`}
            onClick={() => list.select({ saved: value })}
          >
            {title}
          </Button>
        ))}
      </View>
      <ScrollView
        id="cabinet-scroll"
        className="page-scroll"
        scrollY
        scrollTop={list.scrollTop}
        onScroll={list.onScroll}
        onTouchStart={list.onTouchStart}
        onTouchMove={list.onTouchMove}
        onScrollToLower={list.paused ? undefined : list.load}
        lowerThreshold={120}
      >
        <View className="scroll-content">
          {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
          {(list.error || list.warning || list.paused) && (
            <Notice
              onRetry={list.paused ? list.continueUpdating : list.error ? list.load : list.refresh}
              label={list.paused ? '继续更新' : '重试'}
            >
              {list.error || list.warning || '作品较多，已暂停更新，请继续更新'}
            </Notice>
          )}
          {list.loaded && !list.items.length && !list.hasMore && (
            <View className="cabinet-empty">
              <Text className="section-title">
                {list.warning ? (saved ? '当前未读到收藏' : '当前未读到作品') : saved ? '还没有收藏' : '还没有作品'}
              </Text>
              <Action
                quiet
                onClick={() => (saved ? list.select({ saved: false }) : Taro.switchTab({ url: '/pages/effects/index' }))}
              >
                {saved ? '查看全部作品' : '去选一个特效'}
              </Action>
            </View>
          )}
          <View className="artifact-grid">
            {list.items.map((item) => (
              <View className="artifact-tile" key={item.id} id={list.tileId({ artifactId: item.id })}>
                <PrivateImage
                  mediaId={item.mediaId}
                  accountKey={account.accountKey}
                  className="artifact-tile__image"
                  onClick={() => list.open({ artifactId: item.id })}
                />
              </View>
            ))}
          </View>
          {list.loading && (
            <View className="inline-loading">
              <Brand animated />
            </View>
          )}
          {list.loaded && list.hasMore && !list.paused && (
            <Button className="text-button" onClick={list.load}>
              查看更多作品
            </Button>
          )}
          {list.loaded && !!list.items.length && !list.hasMore && <Text className="list-status">已经看到全部作品</Text>}
        </View>
      </ScrollView>
    </View>
  )
}
