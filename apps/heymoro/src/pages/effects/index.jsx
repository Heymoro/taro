import { Button, Image, Input, ScrollView, Text, View } from '@tarojs/components'
import React, { useEffect, useState } from 'react'

import search from '../../assets/search.png'
import { Action, Brand, NavBar, Notice, OfficialImage, openTemplate } from '../../components/primitives'
import { creationApi } from '../../creation-api'
import { templateLabels } from '../../templates'
import { useCursorList } from '../../use-cursor-list'

export default function EffectsPage() {
  const [keyword, setKeyword] = useState('')
  const [categoryId, setCategoryId] = useState(null)
  const [taxonomy, setTaxonomy] = useState({ categories: [], labels: [], error: '' })
  const list = useCursorList({ read: creationApi.templates, filters: { keyword, categoryId } })
  useEffect(() => {
    let alive = true
    creationApi
      .taxonomy()
      .then((result) => {
        if (alive) setTaxonomy({ ...result, error: '' })
      })
      .catch(() => {
        if (alive) setTaxonomy({ categories: [], labels: [], error: '分类暂时无法读取' })
      })
    return () => {
      alive = false
    }
  }, [])
  return (
    <View className="screen">
      <NavBar title="特效" />
      <View className="effects-controls">
        <View className="row effects-search">
          <View className="search-input">
            <Image src={search} />
            <Input
              value={keyword}
              placeholder="搜索特效或标签"
              maxlength={40}
              confirmType="search"
              onInput={(event) => setKeyword(event.detail.value)}
            />
            {!!keyword && (
              <Button className="icon-button" aria-label="清除搜索" onClick={() => setKeyword('')}>
                ×
              </Button>
            )}
          </View>
          <Action quiet className="compact" onClick={() => openTemplate({ templateId: '' })}>
            ＋ 自由创作
          </Action>
        </View>
        <ScrollView scrollX className="category-strip" showScrollbar={false}>
          <View className="row category-row">
            {[{ id: null, name: '全部' }, ...taxonomy.categories].map((category) => (
              <Button
                key={category.id || 'all'}
                className={`category ${categoryId === category.id ? 'category--active' : ''}`}
                onClick={() => setCategoryId(category.id)}
              >
                {category.name}
              </Button>
            ))}
          </View>
        </ScrollView>
      </View>
      <ScrollView className="page-scroll effects-results" scrollY onScrollToLower={list.load}>
        <View className="scroll-content scroll-content--effects">
          {taxonomy.error && <Notice>{taxonomy.error}</Notice>}
          {list.error && <Notice onRetry={list.load}>{list.error}</Notice>}
          <View className="effect-grid">
            {list.items.map((template) => {
              const labels = templateLabels({ template })
              return (
                <View key={template.templateId} className="effect-card" onClick={() => openTemplate(template)}>
                  <OfficialImage mediaId={template.displayConfig.coverMediaId} shareKey={template.displayConfig.showcaseShareKeys[0]} className="effect-card__image" />
                  <Text className="effect-card__title">{template.displayConfig.name}</Text>
                  <View className="row effect-card__labels">
                    <Text className="muted">{labels.category}</Text>
                    {labels.label && <Text className="tag">{labels.label}</Text>}
                  </View>
                </View>
              )
            })}
          </View>
          {list.loading && (
            <View className="inline-loading">
              <Brand animated />
            </View>
          )}
          {list.loaded && !list.items.length && !list.hasMore && (
            <View className="empty-card">
              <Text className="section-title">没有找到这个玩法</Text>
              <Action
                quiet
                onClick={() => {
                  setKeyword('')
                  setCategoryId(null)
                }}
              >
                清除筛选
              </Action>
            </View>
          )}
          {list.hasMore && list.loaded && (
            <Button className="text-button" onClick={list.load}>
              查看更多玩法
            </Button>
          )}
        </View>
      </ScrollView>
    </View>
  )
}
