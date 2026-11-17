import './index.scss'

import { Button, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import React, { useRef, useState } from 'react'

import { getStoredToken } from '../../auth'
import { chooseUploadFile, deleteMedia, listMedia, openMedia, uploadErrorMessage, uploadMedia } from '../../media'

export default function MediaPage() {
  const [media, setMedia] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [retryPage, setRetryPage] = useState(null)
  const version = useRef(0)
  const session = useRef(null)
  const listing = useRef(false)
  const acting = useRef(false)

  const refresh = async (nextPage = 1) => {
    if (listing.current) return
    listing.current = true
    const current = version.current
    let targetPage = nextPage
    setLoading(true)
    setError('')
    try {
      if (!getStoredToken()) throw new Error('AUTH_REQUIRED')
      let result = await listMedia({ page: targetPage, limit: 20 })
      if (current !== version.current) return
      if (!result.items?.length && targetPage > 1) {
        targetPage -= 1
        result = await listMedia({ page: targetPage, limit: 20 })
      }
      if (current !== version.current) return
      setPage(result.page || 1)
      setPages(Math.max(1, result.totalPages || 1))
      setMedia(result.items || [])
      setLoaded(true)
      setNeedsLogin(false)
      setRetryPage(null)
    } catch (cause) {
      if (current !== version.current) return
      if (cause?.message === 'AUTH_REQUIRED') {
        setMedia([])
        setLoaded(false)
        setNeedsLogin(true)
        setRetryPage(null)
        setError('请先登录或重新登录后查看文件')
      } else {
        setNeedsLogin(false)
        setRetryPage(targetPage)
        setError('读取文件失败，请检查网络后重试')
      }
    } finally { if (current === version.current) { listing.current = false; setLoading(false) } }
  }

  useDidShow(() => {
    const token = getStoredToken()
    if (session.current !== token) {
      session.current = token
      version.current += 1; listing.current = false; acting.current = false; setBusy(false); setMedia([])
      setLoaded(false)
      setNeedsLogin(false)
      setRetryPage(null)
      refresh()
    } else if (!acting.current && !listing.current) refresh(retryPage ?? page)
  })

  const handleUpload = async () => {
    if (needsLogin || listing.current || acting.current) return
    acting.current = true
    const current = version.current
    setBusy(true)
    setError('')
    try {
      const file = await chooseUploadFile()
      if (current !== version.current || getStoredToken() !== session.current) return
      if (!file) return
      await uploadMedia(file.path, file.name)
      if (current === version.current && getStoredToken() === session.current) await refresh()
    } catch (uploadError) {
      if (current !== version.current || getStoredToken() !== session.current) return
      setError(uploadErrorMessage(uploadError))
    } finally {
      if (current === version.current) { acting.current = false; setBusy(false) }
    }
  }

  const handleOpen = async (item) => {
    if (listing.current || acting.current || getStoredToken() !== session.current) return
    acting.current = true; setBusy(true); setError('')
    const current = version.current
    try {
      await openMedia(item)
    } catch {
      if (current === version.current && getStoredToken() === session.current) setError('文件打开失败，请稍后重试')
    } finally {
      if (current === version.current) { acting.current = false; setBusy(false) }
    }
  }

  const handleDelete = async (item) => {
    if (listing.current || acting.current) return
    acting.current = true; setBusy(true)
    const current = version.current
    try {
      const answer = await Taro.showModal({ title: '确认删除文件？', content: '删除后将进入清理流程。被记录引用的文件需要先解除关联。', confirmText: '删除', cancelText: '取消', confirmColor: '#c94d5d' })
      if (!answer.confirm || current !== version.current || getStoredToken() !== session.current) return
      setError('')
      await deleteMedia(item.id)
      if (current === version.current && getStoredToken() === session.current) {
        setMedia((items) => items.filter((file) => file.id !== item.id))
        await refresh(page)
      }
    } catch (cause) {
      if (current === version.current && getStoredToken() === session.current) setError(cause?.message === 'FILE_IN_USE' ? '文件正在被记录引用，请先解除附件关联后再删除' : '文件删除失败，请稍后重试')
    } finally {
      if (current === version.current) { acting.current = false; setBusy(false) }
    }
  }

  return (
    <View className='media-page'>
      <View className='page-heading'><Text className='page-title'>我的文件</Text><Button size='mini' disabled={needsLogin || busy || loading} loading={busy} onClick={handleUpload}>上传</Button></View>
      {error && <Text className='error-text'>{error}</Text>}
      {loading && <Text>正在读取文件…</Text>}
      {loaded && !loading && retryPage === null && media.length === 0 && <Text className='empty-text'>还没有文件，可点击上传添加文件</Text>}
      {media.map((item) => (
        <View className='media-card' key={item.id}>
          <View onClick={() => handleOpen(item)}><Text className='media-name'>{item.originalName}</Text><Text className='media-meta'>{item.mimeType || '文件'} · {item.filesize} B</Text></View>
          <Button size='mini' disabled={busy || loading} onClick={() => handleDelete(item)}>删除</Button>
        </View>
      ))}
      {loaded && <View>
        <Text>第 {page} 页 / {pages} 页</Text>
        <Button disabled={loading || busy || page <= 1} onClick={() => refresh(page - 1)}>上一页</Button>
        <Button disabled={loading || busy || page >= pages} onClick={() => refresh(page + 1)}>下一页</Button>
      </View>}
      {needsLogin ? <Button onClick={() => Taro.switchTab({ url: '/pages/index/index' })}>去首页登录</Button> : (
        <Button disabled={loading || busy} onClick={() => refresh(retryPage ?? page)}>{retryPage === null ? '刷新文件' : '重试读取'}</Button>
      )}
    </View>
  )
}
