import './index.scss'

import { Button, Input, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import React, { useRef, useState } from 'react'

import { getStoredToken } from '../../auth'
import { chooseUploadFile, getMedia, listMedia, openMedia, uploadErrorMessage, uploadMedia } from '../../media'
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord } from '../../records'

export default function RecordsPage() {
  const [records, setRecords] = useState([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [files, setFiles] = useState([])
  const [picker, setPicker] = useState(false)
  const [filePage, setFilePage] = useState(1)
  const [filePages, setFilePages] = useState(1)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [listStatus, setListStatus] = useState('idle')
  const [busy, setBusy] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const generation = useRef(0)
  const session = useRef(null)
  const baseline = useRef({ title: '', body: '', attachments: [] })
  const [attachmentInfo, setAttachmentInfo] = useState({})
  const [attachmentError, setAttachmentError] = useState('')
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const locked = useRef(false)
  const listing = useRef(false)
  const picking = useRef(false)
  const needsLogin = listStatus === 'auth'

  const resetDraft = () => { baseline.current = { title: '', body: '', attachments: [] }; setAttachmentInfo({}); setAttachmentError(''); setAttachmentLoading(false); setEditing(null); setTitle(''); setBody(''); setAttachments([]); setPicker(false); setFiles([]) }
  const refresh = async (nextPage = 1, version = generation.current) => {
    if (listing.current) return
    listing.current = true
    setLoading(true)
    setError('')
    try {
      if (!getStoredToken()) throw new Error('AUTH_REQUIRED')
      let result = await listRecords({ page: nextPage, limit: 20 })
      if (!result.items?.length && nextPage > 1) result = await listRecords({ page: nextPage - 1, limit: 20 })
      if (version !== generation.current || getStoredToken() !== session.current) return
      setRecords(result.items || [])
      setPage(result.page || 1)
      setPages(Math.max(1, result.totalPages || 1))
      setListStatus('ready')
    } catch (cause) {
      if (version !== generation.current || getStoredToken() !== session.current) return
      if (cause?.message === 'AUTH_REQUIRED') {
        setRecords([])
        setListStatus('auth')
        setError('请先登录或重新登录后查看记录')
      } else {
        setListStatus('failed')
        setError('读取记录失败，请检查网络后重试')
      }
    } finally {
      if (version === generation.current) { listing.current = false; setLoading(false) }
    }
  }
  useDidShow(() => {
    const token = getStoredToken()
    if (session.current !== token) {
      session.current = token
      generation.current += 1
      listing.current = false; locked.current = false; picking.current = false
      setBusy(false); setFileLoading(false); setRecords([]); resetDraft()
      setListStatus('idle')
      refresh(1)
    } else if (!locked.current && !listing.current) refresh(page)
  })
  const hasChanges = () => title !== baseline.current.title || body !== baseline.current.body ||
    JSON.stringify([...attachments].sort()) !== JSON.stringify([...baseline.current.attachments].sort())
  const confirmDiscard = async () => !hasChanges() || Boolean((await Taro.showModal({
    title: '放弃未保存的修改？', content: '标题、正文和附件选择尚未保存。已上传的文件会保留在文件列表中。', confirmText: '放弃修改', cancelText: '继续编辑',
  })).confirm)
  const handleCancel = async () => {
    if (locked.current || picking.current) return
    locked.current = true; setBusy(true)
    const version = generation.current
    try { if (await confirmDiscard() && version === generation.current) resetDraft() } catch { if (version === generation.current) setError('确认操作失败，草稿已保留') } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }
  const handleUpload = async () => {
    if (needsLogin || locked.current || listing.current || picking.current) return
    if (attachments.length >= 20) { setError('最多关联 20 个附件'); return }
    locked.current = true; setBusy(true); setError('')
    const version = generation.current
    try {
      const file = await chooseUploadFile()
      if (version !== generation.current || getStoredToken() !== session.current) return
      if (!file) return
      const uploaded = await uploadMedia(file.path, file.name)
      if (version !== generation.current || getStoredToken() !== session.current) return
      setAttachments((current) => [...new Set([...current, uploaded.id])])
      setAttachmentInfo((current) => ({ ...current, [uploaded.id]: { ...uploaded, originalName: uploaded.originalName || file.name } }))
    } catch (cause) {
      if (version === generation.current && getStoredToken() === session.current) setError(`${uploadErrorMessage(cause)}，草稿已保留`)
    } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }

  const loadAttachmentInfo = async (ids, version) => {
    setAttachmentLoading(true); setAttachmentError('')
    const results = await Promise.allSettled(ids.map(async (id) => getMedia(id)))
    if (version !== generation.current || getStoredToken() !== session.current) return
    const available = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
    setAttachmentInfo((current) => ({ ...current, ...Object.fromEntries(available.map((item) => [item.id, item])) }))
    if (results.some((result) => result.status === 'rejected')) setAttachmentError('部分附件信息读取失败，可重试；记录内容和附件选择已保留')
    setAttachmentLoading(false)
  }
  const handleReloadAttachments = async () => {
    if (locked.current || listing.current || picking.current) return
    locked.current = true; setBusy(true)
    const version = generation.current
    try { await loadAttachmentInfo(attachments, version) } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }
  const handlePreview = async (id) => {
    if (locked.current || listing.current || picking.current) return
    locked.current = true; setBusy(true); setAttachmentError('')
    const version = generation.current
    try {
      const item = attachmentInfo[id] || await getMedia(id)
      if (version !== generation.current || getStoredToken() !== session.current) return
      setAttachmentInfo((current) => ({ ...current, [id]: item }))
      await openMedia(item)
    } catch {
      if (version === generation.current && getStoredToken() === session.current) setAttachmentError('附件打开失败，请重试；记录内容已保留')
    } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }

  const handleEdit = async (id) => {
    if (locked.current || listing.current || picking.current) return
    locked.current = true; setBusy(true); setError('')
    const version = generation.current
    try {
      if (!(await confirmDiscard()) || version !== generation.current || getStoredToken() !== session.current) return
      const record = await getRecord(id)
      if (version !== generation.current || getStoredToken() !== session.current) return
      baseline.current = { title: record.title, body: record.body || '', attachments: record.attachments || [] }
      setAttachmentInfo({}); setAttachmentError('')
      setEditing(record.id); setTitle(record.title); setBody(record.body || '')
      setAttachments(record.attachments || []); setPicker(false); setFiles([])
      await loadAttachmentInfo(record.attachments || [], version)
    } catch { if (version === generation.current) setError('读取记录详情失败，请重试') } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }
  const loadFiles = async (nextPage = 1) => {
    if (picking.current || locked.current) return
    picking.current = true; setFileLoading(true); setError('')
    const version = generation.current
    try {
      const result = await listMedia({ page: nextPage, limit: 20 })
      if (version !== generation.current || getStoredToken() !== session.current) return
      setAttachmentInfo((current) => ({ ...current, ...Object.fromEntries((result.items || []).map((item) => [item.id, item])) }))
      setFiles(result.items || []); setFilePage(result.page || 1); setFilePages(Math.max(1, result.totalPages || 1)); setPicker(true)
    } catch { if (version === generation.current) setError('读取附件失败，请先登录或稍后重试') } finally { if (version === generation.current) { picking.current = false; setFileLoading(false) } }
  }
  const toggleAttachment = (id) => {
    if (locked.current || picking.current) return
    if (!attachments.includes(id) && attachments.length >= 20) { setError('最多关联 20 个附件'); return }
    setAttachments((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < 20 ? [...current, id] : current)
  }
  const handleSave = async () => {
    if (needsLogin || locked.current || listing.current || picking.current) return
    if (!title.trim() || title.trim().length > 100) { setError('请输入 1-100 字的记录标题'); return }
    if (attachments.length > 20) { setError('最多关联 20 个附件'); return }
    if (body.length > 10000) { setError('正文不能超过 10000 字'); return }
    locked.current = true; setBusy(true); setError('')
    const version = generation.current
    try {
      const input = { title: title.trim(), body: body.trim() || null, attachments }
      if (editing !== null) await updateRecord(editing, input)
      else await createRecord(input)
      if (version !== generation.current || getStoredToken() !== session.current) return
      resetDraft(); await refresh(editing !== null ? page : 1, version)
    } catch (cause) {
      if (version === generation.current) setError(cause.message === 'FILE_NOT_ATTACHABLE' ? '附件已失效或无权使用，请移除后重试' : '保存记录失败，输入已保留，请重试')
    } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }
  const handleDelete = async (id) => {
    if (locked.current || listing.current || picking.current) return
    locked.current = true; setBusy(true)
    const version = generation.current
    try {
      const answer = await Taro.showModal({ title: '确认删除记录？', content: '删除后无法恢复。附件文件不会随记录一起删除。', confirmText: '删除', cancelText: '取消', confirmColor: '#c94d5d' })
      if (!answer.confirm || version !== generation.current || getStoredToken() !== session.current) return
      await deleteRecord(id)
      if (version !== generation.current || getStoredToken() !== session.current) return
      if (editing === id) resetDraft()
      await refresh(page, version)
    } catch { if (version === generation.current) setError('删除记录失败') } finally { if (version === generation.current) { locked.current = false; setBusy(false) } }
  }
  return (
    <View className='records-page'>
      <Text className='page-title'>我的记录</Text>
      {(!needsLogin || hasChanges()) && <View className='editor-card'>
        <Text>{editing !== null ? '编辑记录' : '新建记录'}</Text>
        <Input disabled={busy} maxlength={100} value={title} onInput={(event) => setTitle(event.detail.value)} placeholder='记录标题' />
        <Textarea disabled={busy} maxlength={10000} value={body} onInput={(event) => setBody(event.detail.value)} placeholder='写点内容…' />
        <Button disabled={needsLogin || busy || loading || fileLoading} loading={busy} onClick={handleUpload}>上传附件</Button>
        <Text>支持 JPG、PNG、PDF，单文件最多 10 MB；上传成功后自动加入附件，保存记录后关联生效。</Text>
        <Button disabled={needsLogin || busy || fileLoading} onClick={() => loadFiles()}>选择已有文件</Button>
        {attachmentLoading && <Text>正在读取附件信息…</Text>}
        {attachmentError && <View><Text className='error-text'>{attachmentError}</Text><Button size='mini' disabled={busy || loading || fileLoading} onClick={handleReloadAttachments}>重试附件信息</Button></View>}
        {attachments.map((id) => <View className='attachment-row' key={id}>
          <Text className='attachment-name'>{attachmentInfo[id]?.originalName || `附件 #${id}`}</Text>
          <View className='attachment-actions'>
            <Button size='mini' disabled={busy || loading || fileLoading} onClick={() => handlePreview(id)}>预览附件</Button>
            <Button size='mini' disabled={busy || fileLoading} onClick={() => toggleAttachment(id)}>移除附件</Button>
          </View>
        </View>)}
        {picker && <View>
          {files.length === 0 && <Text>暂无可选文件，请先到文件页上传</Text>}
          {files.map((file) => <View key={file.id}><Text>{file.originalName}</Text><Button size='mini' disabled={busy || fileLoading} onClick={() => toggleAttachment(file.id)}>{attachments.includes(file.id) ? '取消选择' : '添加附件'}</Button></View>)}
          <Text>附件第 {filePage} 页 / {filePages} 页</Text>
          <Button disabled={fileLoading || filePage <= 1} onClick={() => loadFiles(filePage - 1)}>附件上一页</Button>
          <Button disabled={fileLoading || filePage >= filePages} onClick={() => loadFiles(filePage + 1)}>附件下一页</Button>
        </View>}
        <Button disabled={needsLogin || busy || loading || fileLoading} loading={busy} onClick={handleSave}>{editing !== null ? '保存修改' : '保存记录'}</Button>
        <Button disabled={busy || fileLoading} onClick={handleCancel}>取消编辑</Button>
      </View>}
      {error && <Text className='error-text'>{error}</Text>}
      {loading && <Text>正在读取记录…</Text>}
      <View className='records-list'>
        {!loading && listStatus === 'ready' && records.length === 0 && <Text className='empty-text'>还没有记录</Text>}
        {records.map((record) => <View className='record-card' key={record.id}>
          <View><Text className='record-title'>{record.title}</Text><Text className='record-body'>{record.body || '暂无正文'}</Text><Text>附件 {record.attachments?.length || 0} 个</Text></View>
          <Button size='mini' disabled={busy || loading} onClick={() => handleEdit(record.id)}>编辑</Button>
          <Button size='mini' disabled={busy || loading} onClick={() => handleDelete(record.id)}>删除</Button>
        </View>)}
      </View>
      {needsLogin ? <Button onClick={() => Taro.switchTab({ url: '/pages/index/index' })}>去首页登录</Button> : <View>
        <Text>第 {page} 页 / {pages} 页</Text>
        <Button disabled={loading || busy || page <= 1} onClick={() => refresh(page - 1)}>上一页</Button>
        <Button disabled={loading || busy || page >= pages} onClick={() => refresh(page + 1)}>下一页</Button>
        <Button disabled={loading || busy} onClick={() => refresh(page)}>刷新记录</Button>
      </View>}
    </View>
  )
}
