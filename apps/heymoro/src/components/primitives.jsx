import { Button, Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import React from 'react'

import back from '../assets/back.png'
import brand from '../assets/brand.png'
import edit from '../assets/edit.png'
import { officialImage, sharedSessionCover } from '../creation-api'
import { templateRoute } from '../templates'

export function Action({ children, onClick, disabled, loading, quiet = false, className = '' }) {
  return (
    <Button
      className={`action ${quiet ? 'action--quiet' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      loading={loading}
    >
      {children}
    </Button>
  )
}
export function NavBar({ title, canBack = false, onRename }) {
  let info = {}
  let menu = {}
  try {
    info = Taro.getWindowInfo()
    menu = Taro.getMenuButtonBoundingClientRect()
  } catch {
    /* Component tests have no native navigation geometry. */
  }
  const status = info.statusBarHeight || 20
  const height = menu.height ? Math.max(44, (menu.top - status) * 2 + menu.height) : 44
  const right = menu.left ? Math.max(96, (info.windowWidth || 390) - menu.left + 10) : 96
  return (
    <View className="navbar" style={{ paddingTop: `${status}px` }}>
      <View className="navbar__row" style={{ height: `${height}px`, paddingRight: `${right}px` }}>
        {canBack && (
          <Button
            className="icon-button navbar__back"
            aria-label="返回"
            onClick={() => {
              if (Taro.getCurrentPages().length > 1) Taro.navigateBack()
              else Taro.switchTab({ url: '/pages/effects/index' })
            }}
          >
            <Image src={back} className="back-icon" />
          </Button>
        )}
        <Text className="navbar__title" onClick={onRename}>
          {title}
        </Text>
        {onRename && (
          <Button className="icon-button" aria-label="重命名创作" onClick={onRename}>
            <Image src={edit} className="edit-icon" />
          </Button>
        )}
      </View>
    </View>
  )
}
export function Brand({ large = false, animated = false }) {
  return (
    <Image
      src={brand}
      className={`brand ${large ? 'brand--large' : ''} ${animated ? 'brand--animated' : ''}`}
    />
  )
}
export function Notice({ children, onRetry, label = '重试', secondaryAction }) {
  return (
    <View className="notice">
      <Text className="notice__text">{children}</Text>
      {secondaryAction ? (
        <View className="credits-notice-actions">
          {onRetry && <Button className="text-button" onClick={onRetry}>{label}</Button>}
          <Button className="text-button" onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>
        </View>
      ) : onRetry && (
        <Button className="text-button" onClick={onRetry}>
          {label}
        </Button>
      )}
    </View>
  )
}
export function OfficialImage({ mediaId, shareKey, className, mode = 'aspectFill' }) {
  const src = mediaId ? officialImage({ mediaId }) : sharedSessionCover({ key: shareKey })
  return src ? <Image src={src} className={className} mode={mode} /> : <View className={className} />
}
export function openTemplate(template) {
  return Taro.navigateTo({ url: templateRoute(template) })
}
