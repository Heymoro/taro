import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import React, { useEffect, useRef, useState } from 'react'

import { Action, Brand, NavBar, Notice, openTemplate } from '../../components/primitives'
import { creationApi, sharedSessionImage } from '../../creation-api'

export default function ExamplePage() {
  const { params } = useRouter()
  const [state, setState] = useState({ share: null, loading: true, error: '' })
  const sequence = useRef(0)
  const isAlive = useRef(true)
  const load = async () => {
    const request = ++sequence.current
    setState({ share: null, loading: true, error: '' })
    try {
      const share = await creationApi.sessionShare({ key: params.key })
      if (isAlive.current && request === sequence.current)setState({ share, loading: false, error: '' })
    } catch {
      if (isAlive.current && request === sequence.current)setState({ share: null, loading: false, error: '分享已取消或暂不可用' })
    }
  }
  useEffect(() => () => { isAlive.current = false; sequence.current++ }, [])
  useDidShow(() => { isAlive.current = true; load() })
  useDidHide(() => { sequence.current++; setState({ share: null, loading: true, error: '' }) })
  const unavailable = () => { sequence.current++; setState({ share: null, loading: false, error: '作品暂不可用，请重新读取' }) }
  const sameTemplate = async () => {
    const current = state.share
    if (!current) return
    try {
      const fresh = await creationApi.sessionShare({ key: params.key })
      if (fresh.templateId !== current.templateId) return unavailable()
      const pages = Taro.getCurrentPages()
      if (pages.at(-2)?.route === 'pages/create/index' && Number(pages.at(-2)?.options?.template) === fresh.templateId) return Taro.navigateBack()
      return openTemplate({ templateId: fresh.templateId })
    } catch { unavailable() }
  }
  return <View className="screen">
    <NavBar title="作品会话" canBack />
    <ScrollView className="page-scroll" scrollY><View className="scroll-content">
      {state.loading && <View className="inline-loading"><Brand animated/></View>}
      {state.error && <Notice onRetry={load}>{state.error}</Notice>}
      {state.share && <>
        <Text className="example-title">{state.share.title}</Text>
        <Text className="muted example-description">{state.share.images.length} 张作品 · AI 生成</Text>
        {state.share.images.map((image, index) => <Image key={image.id} src={sharedSessionImage({ key: params.key, artifactId: image.id })} className="example-image" mode="widthFix" aria-label={`作品 ${index + 1}`} onError={unavailable}/>)}
      </>}
    </View></ScrollView>
    <View className="bottom-action"><Action disabled={!state.share || state.loading} onClick={sameTemplate}>做同款</Action><View className="safe-spacer"/></View>
  </View>
}
