import { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import { creationApi } from '../../creation-api'
import { creationAccountKey } from '../../use-account'

const initialState = () => ({
  item: null,
  loading: false,
  busy: false,
  readError: '',
  favoriteError: '',
  downloadError: ''
})

export function useArtifact({ artifactId, account, saveToAlbum }) {
  const visibility = useRef({ seenShow: false, visible: true })
  const accountKey = account.accountKey
  const userId = account.user?.id
  const owner = useMemo(
    () => ({
      accountKey,
      artifactId,
      userId,
      active: true,
      initialized: false,
      visible: visibility.current.visible,
      read: 0,
      revision: 0,
      action: null,
      pendingRead: false,
      state: initialState()
    }),
    [accountKey, artifactId, userId]
  )
  const liveOwner = useRef(owner)
  liveOwner.current = owner
  const [snapshot, setSnapshot] = useState({ owner, state: owner.state })
  const isCurrent = () =>
    owner.active &&
    liveOwner.current === owner &&
    Boolean(userId && accountKey) &&
    accountKey === creationAccountKey()
  const publish = (patch) => {
    if (!isCurrent()) return
    owner.state = { ...owner.state, ...patch }
    setSnapshot({ owner, state: owner.state })
  }
  const validId = Number.isSafeInteger(artifactId) && artifactId > 0
  const reload = async () => {
    if (!isCurrent() || !validId) return
    if (owner.action?.kind === 'favorite') {
      owner.pendingRead = true
      return
    }
    const read = ++owner.read
    const revision = owner.revision
    owner.initialized = true
    publish({ loading: !owner.state.item, readError: '' })
    const ownsRead = () => isCurrent() && owner.read === read && owner.visible
    try {
      let warning = ''
      const result = await creationApi.artifact({
        artifactId,
        isInterested: ownsRead,
        onWarning: (value) => {
          warning = value
        }
      })
      if (!ownsRead()) return
      // A read may update metadata without undoing a newer favorite mutation.
      let item = result
      if (revision !== owner.revision && owner.state.item) {
        item = {
          ...result,
          isFavorite: owner.state.item.isFavorite,
          savedAt: owner.state.item.savedAt
        }
      }
      publish({
        item,
        loading: false,
        readError: '',
        ...(revision === owner.revision ? { favoriteError: warning } : {})
      })
    } catch (error) {
      if (!ownsRead()) return
      publish({
        loading: false,
        ...(revision === owner.revision ? {
          readError: error?.message === 'FAVORITE_PENDING'
            ? '收藏状态仍待核对，请稍后重试读取' : '作品暂时无法读取，请重试'
        } : {})
      })
    }
  }
  useEffect(() => {
    owner.active = true
    if (!owner.initialized) reload()
    return () => {
      owner.active = false
      owner.read++
      owner.initialized = false
      owner.action = null
      owner.pendingRead = false
    }
  }, [owner])
  useDidShow(() => {
    const wasHidden = !owner.visible
    visibility.current.visible = true
    owner.visible = true
    if (!visibility.current.seenShow) {
      visibility.current.seenShow = true
      if (!owner.initialized || wasHidden || owner.action?.kind === 'favorite') reload()
      return
    }
    reload()
  })
  useDidHide(() => {
    visibility.current.visible = false
    owner.visible = false
    owner.read++
  })
  const toggleFavorite = async () => {
    if (!isCurrent() || !validId || !owner.state.item || owner.action) return
    const flight = { kind: 'favorite' }
    owner.action = flight
    owner.revision++
    const ownsAction = () => isCurrent() && owner.action === flight
    const isFavorite = !owner.state.item.isFavorite
    publish({ busy: true, favoriteError: '' })
    try {
      const result = await creationApi.favorite({ artifactId, isFavorite })
      if (!ownsAction()) return
      publish({
        item: {
          ...owner.state.item,
          isFavorite: result.isFavorite,
          savedAt: result.savedAt
        }
      })
    } catch {
      if (!ownsAction()) return
      owner.pendingRead = true
      publish({ favoriteError: '收藏状态未确认，请重试读取' })
    } finally {
      if (ownsAction()) {
        owner.action = null
        publish({ busy: false })
        if (owner.pendingRead) {
          owner.pendingRead = false
          if (owner.visible) reload()
        }
      }
    }
  }
  const download = async () => {
    if (!isCurrent() || !validId || !owner.state.item || owner.action) return
    const flight = { kind: 'download' }
    owner.action = flight
    const ownsAction = () => isCurrent() && owner.action === flight
    publish({ busy: true, downloadError: '' })
    try {
      await saveToAlbum({ item: owner.state.item, isCurrent: ownsAction })
    } catch (error) {
      if (ownsAction()) {
        publish({
          downloadError:
            error?.code === 'ALBUM_PERMISSION'
              ? '请在微信设置中允许保存到相册，再重试'
              : '保存未完成，作品仍在收纳柜中'
        })
      }
    } finally {
      if (ownsAction()) {
        owner.action = null
        publish({ busy: false })
      }
    }
  }
  const state = snapshot.owner === owner && isCurrent() ? snapshot.state : initialState()
  return {
    item: state.item,
    loading: state.loading,
    busy: state.busy,
    error: !validId
      ? '作品链接无效，请返回'
      : state.favoriteError || state.downloadError || state.readError,
    canRetryRead:
      validId && Boolean(state.favoriteError || (!state.downloadError && state.readError)),
    reload,
    toggleFavorite,
    download
  }
}
