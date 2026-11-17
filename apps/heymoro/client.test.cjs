const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const { test } = require('node:test')
const { transformSync } = require('@babel/core')
const presetRequire = createRequire(require.resolve('babel-preset-taro'))

// Execute the actual source; only the mini-program host and React hook runtime are stubbed.
function loadSource(file, mocks = {}) {
  const cache = new Map()
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename, babelrc: false, configFile: false,
      presets: [[presetRequire.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }],
        [presetRequire.resolve('@babel/preset-react'), { runtime: 'automatic' }]],
    })
    const localRequire = (request) => {
      if (request in mocks) return mocks[request]
      if (request.endsWith('.scss')) return {}
      if (request.startsWith('.')) return load(path.resolve(path.dirname(filename), `${request}.js`))
      throw new Error(`Unexpected dependency: ${request}`)
    }
    vm.runInNewContext('(function(require, module, exports) {' + code + '\n})', { process })(localRequire, module, module.exports)
    return module.exports
  }
  return load(path.join(__dirname, file))
}

function mountPage(file, services = {}, host = {}) {
  const states = []
  let cursor = 0
  let onShow
  const jsx = (type, props) => ({ type, props })
  const mediaHelpers = loadSource('src/media.js', { '@tarojs/taro': host })
  const Page = loadSource(file, {
    '@tarojs/components': { Button: 'Button', Text: 'Text', View: 'View', Input: 'Input', Textarea: 'Textarea' },
    '@tarojs/taro': { ...host, useDidShow: (callback) => { onShow = callback } },
    react: {
      useRef: (initial) => { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
      useCallback: (callback) => callback,
      useState: (initial) => {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../auth': { getStoredToken: () => 'test-token' },
    ...services,
    '../../media': { chooseUploadFile: mediaHelpers.chooseUploadFile, uploadErrorMessage: mediaHelpers.uploadErrorMessage, ...services['../../media'] },
  }).default
  function render() { cursor = 0; return Page() }
  function nodes(node) {
    if (Array.isArray(node)) return node.flatMap(nodes)
    if (!node || typeof node !== 'object') return []
    return [node, ...[node.props?.children].flat().flatMap(nodes)]
  }
  render()
  return {
    async show() { onShow(); await new Promise(setImmediate) },
    button(label) { return nodes(render()).find((node) => node.type === 'Button' && node.props.children === label)?.props },
    clickable(label) { return nodes(render()).find((node) => node.props?.onClick && nodes(node).some((child) => child.props?.children === label)).props },
    input(placeholder) { return nodes(render()).find((node) => node.props?.placeholder === placeholder).props },
    text() { return nodes(render()).filter((node) => node.type === 'Text').map((node) => node.props.children).flat().join(' ') },
  }
}

const homeServices = (overrides = {}) => ({
  '../../auth': { getStoredToken: () => 'test-token', getCurrentUser: async () => ({ displayName: 'Test' }), logout: async () => {}, ...overrides },
  '../../media': { listMedia: async () => ({ items: [1], totalDocs: 31 }) },
})

test('API base URL is injected at the expression actually used by the client', (t) => {
  const previous = process.env.TARO_APP_API_BASE_URL
  process.env.TARO_APP_API_BASE_URL = 'https://api.example.test'
  const filename = require.resolve('./config/index.js')
  delete require.cache[filename]
  t.after(() => {
    if (previous === undefined) delete process.env.TARO_APP_API_BASE_URL
    else process.env.TARO_APP_API_BASE_URL = previous
    delete require.cache[filename]
  })
  const config = require(filename)((_, base) => base)
  assert.equal(config.defineConstants['process.env.TARO_APP_API_BASE_URL'], '"https://api.example.test"')
})





test('failed logout retains the token so revocation can be retried', async () => {
  const session = { token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z', userId: 1 }
  let token = session
  const auth = loadSource('src/auth.js', {
    '@tarojs/taro': {
      getStorageSync: () => token,
      removeStorageSync: () => { token = '' },
      request: async () => ({ statusCode: 500, data: { error: { code: 'SERVER_ERROR' } } }),
    },
  })
  await assert.rejects(auth.logout(), /SERVER_ERROR/)
  assert.equal(token, session)
})



for (const [file, dependency, method, label] of [
  ['sub1', '../../records', 'listRecords', 'private record'],
  ['sub2', '../../media', 'listMedia', 'private file'],
]) {
  test(`${file} clears prior account data after an authentication failure`, async () => {
    let expired = false
    const page = mountPage(`src/pages/${file}/index.jsx`, {
      [dependency]: { [method]: async () => {
        if (expired) throw new Error('AUTH_REQUIRED')
        return { items: [{ id: 1, title: label, originalName: label }] }
      } },
    })
    await page.show()
    assert.ok(page.text().includes(label))
    expired = true
    await page.show()
    assert.ok(!page.text().includes(label))
    assert.match(page.text(), /请先登录/)
  })
}

test('records distinguish failed reads from a confirmed empty result', async () => {
  let calls = 0
  const page = mountPage('src/pages/sub1/index.jsx', { '../../records': {
    listRecords: async () => {
      if (++calls === 1) throw new Error('offline')
      return { items: [] }
    },
  } })
  await page.show()
  assert.match(page.text(), /读取记录失败/)
  assert.doesNotMatch(page.text(), /还没有记录/)
  await page.button('刷新记录').onClick()
  assert.match(page.text(), /还没有记录/)
  assert.doesNotMatch(page.text(), /读取记录失败/)
})

test('signed-out records show a home login action without exposing an active editor', async () => {
  let requests = 0
  const visited = []
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../auth': { getStoredToken: () => '' },
    '../../records': { listRecords: async () => { requests++; throw new Error('AUTH_REQUIRED') } },
  }, { switchTab: ({ url }) => visited.push(url) })
  await page.show()
  assert.equal(requests, 0)
  assert.match(page.text(), /请先登录/)
  assert.doesNotMatch(page.text(), /还没有记录/)
  assert.equal(page.button('保存记录'), undefined)
  page.button('去首页登录').onClick()
  assert.deepEqual(visited, ['/pages/index/index'])
})

test('file preview failure is reported to the user', async () => {
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../media': {
      listMedia: async () => ({ items: [{ id: 1, originalName: 'private.pdf' }] }),
      openMedia: async () => { throw new Error('MEDIA_DOWNLOAD_FAILED') },
    },
  })
  await page.show()
  await page.clickable('private.pdf').onClick()
  assert.match(page.text(), /文件打开失败/)
})

test('file list distinguishes first load, offline failure, and a confirmed empty result', async () => {
  let rejectFirst, calls = 0
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../media': { listMedia: () => ++calls === 1
      ? new Promise((_, reject) => { rejectFirst = reject })
      : Promise.resolve({ items: [], page: 1, totalPages: 0 }) },
  })
  await page.show()
  assert.match(page.text(), /正在读取文件/)
  assert.doesNotMatch(page.text(), /还没有文件/)
  rejectFirst(new Error('offline'))
  await new Promise(setImmediate)
  assert.match(page.text(), /读取文件失败/)
  assert.doesNotMatch(page.text(), /还没有文件|请先登录/)
  await page.button('重试读取').onClick()
  assert.match(page.text(), /还没有文件/)
  assert.doesNotMatch(page.text(), /读取文件失败/)
})

test('file list asks for login instead of showing empty files when the session is absent or expired', async () => {
  let token = '', calls = 0
  const visited = []
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../auth': { getStoredToken: () => token },
    '../../media': { listMedia: async () => { calls++; throw new Error('AUTH_REQUIRED') } },
  }, { switchTab: ({ url }) => visited.push(url) })
  await page.show()
  assert.equal(calls, 0)
  for (const expectedCalls of [0, 1]) {
    if (expectedCalls) { token = 'expired'; await page.show() }
    assert.equal(calls, expectedCalls)
    assert.match(page.text(), /请先登录/)
    assert.doesNotMatch(page.text(), /还没有文件/)
    assert.equal(page.button('上传').disabled, true)
    page.button('去首页登录').onClick()
  }
  assert.deepEqual(visited, ['/pages/index/index', '/pages/index/index'])
})

test('file list retry repeats the failed page while preserving previously loaded files', async () => {
  const calls = []
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../media': { listMedia: async ({ page: number }) => {
      calls.push(number)
      if (calls.length === 2) throw new Error('offline')
      return { items: [{ id: number, originalName: `page-${number}.pdf` }], page: number, totalPages: 2 }
    } },
  })
  await page.show()
  await page.button('下一页').onClick()
  assert.match(page.text(), /page-1\.pdf/)
  assert.match(page.text(), /读取文件失败/)
  await page.button('重试读取').onClick()
  assert.deepEqual(calls, [1, 2, 2])
  assert.match(page.text(), /page-2\.pdf/)
  assert.doesNotMatch(page.text(), /page-1\.pdf|读取文件失败/)
})

test('retry after deleting the last file on a page refreshes the list without submitting deletion again', async () => {
  const calls = []
  let deletes = 0
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../media': {
      listMedia: async ({ page: number }) => {
        calls.push(number)
        if (calls.length === 4) throw new Error('offline')
        return { items: deletes && number === 2 ? [] : [{ id: number, originalName: `page-${number}.pdf` }], page: number, totalPages: deletes ? 1 : 2 }
      },
      deleteMedia: async () => { deletes++ },
    },
  }, { showModal: async () => ({ confirm: true }) })
  await page.show()
  await page.button('下一页').onClick()
  await page.button('删除').onClick()
  assert.match(page.text(), /读取文件失败/)
  assert.doesNotMatch(page.text(), /page-2\.pdf|文件删除失败/)
  await page.button('重试读取').onClick()
  assert.deepEqual(calls, [1, 2, 2, 1, 1])
  assert.equal(deletes, 1)
  assert.match(page.text(), /page-1\.pdf/)
})

test('cancelling the file picker does not report an upload failure', async () => {
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../media': { listMedia: async () => ({ items: [] }) },
  }, {
    chooseMessageFile: async () => { throw { errMsg: 'chooseMessageFile:fail cancel' } },
  })
  await page.button('上传').onClick()
  assert.ok(!page.text().includes('上传失败'))
})

test('mini build avoids RAF self-imports in the workspace runtime', () => {
  delete require.cache[require.resolve('./config/index.js')]
  const config = require('./config/index.js')((_, base) => base)
  let providers = {
    window: ['@tarojs/runtime', 'window'],
    requestAnimationFrame: ['@tarojs/runtime', 'requestAnimationFrame'],
    cancelAnimationFrame: ['@tarojs/runtime', 'cancelAnimationFrame'],
  }
  config.mini.webpackChain?.({ plugin: (name) => {
    assert.equal(name, 'providerPlugin')
    return { tap: (update) => { [providers] = update([providers]) } }
  } })
  assert.equal(providers.requestAnimationFrame, undefined)
  assert.equal(providers.cancelAnimationFrame, undefined)
  assert.deepEqual(providers.window, ['@tarojs/runtime', 'window'])
})


test('record edit loads latest detail, saves PATCH and can cancel', async () => {
  let updated
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': {
      listRecords: async () => ({ items: [{ id: 1, title: 'Original' }], page: 1, totalPages: 1 }),
      getRecord: async () => ({ id: 1, title: 'Latest', body: 'Body', attachments: [8] }),
      updateRecord: async (id, input) => { updated = { id, ...input } },
    },
    '../../media': { listMedia: async () => ({ items: [], page: 1, totalPages: 1 }) },
  })
  await page.show()
  await page.button('编辑').onClick()
  assert.equal(page.input('记录标题').value, 'Latest')
  page.input('记录标题').onInput({ detail: { value: 'Edited' } })
  await page.button('保存修改').onClick()
  assert.equal(updated.id, 1)
  assert.equal(updated.title, 'Edited')
  assert.deepEqual(Array.from(updated.attachments), [8])
  assert.equal(page.input('记录标题').value, '')
})

test('record attachments can be selected and removed before create', async () => {
  let saved
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [] }), createRecord: async (input) => { saved = input } },
    '../../media': { listMedia: async () => ({ items: [{ id: 7, originalName: 'report.pdf' }], totalPages: 1 }) },
  })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'With files' } })
  await page.button('选择已有文件').onClick()
  page.button('添加附件').onClick()
  await page.button('保存记录').onClick()
  assert.deepEqual(Array.from(saved.attachments), [7])
})

test('records pagination uses requested page and does not advance on failure', async () => {
  const calls = []
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async (options) => { calls.push(options.page); if (options.page === 2) throw new Error('offline'); return { items: [], page: 1, totalPages: 2 } } },
  })
  await page.show()
  await page.button('下一页').onClick()
  assert.deepEqual(calls, [1, 2])
  assert.match(page.text(), /第\s+1\s+页/)
})











test('record and media clients send pagination and record PATCH through existing API', async () => {
  const calls = []
  const host = { request: async (options) => { calls.push(options); return { statusCode: 200, data: { data: { items: [] } } } } }
  const mocks = { '@tarojs/taro': host, './auth': { getStoredToken: () => 'token' } }
  const records = loadSource('src/records.js', mocks)
  const media = loadSource('src/media.js', mocks)
  await records.listRecords({ page: 3, limit: 20 })
  await media.listMedia({ page: 2, limit: 20 })
  await records.updateRecord(8, { title: 'Updated', attachments: [] })
  assert.match(calls[0].url, /records\?page=3&limit=20$/)
  assert.match(calls[1].url, /media\?page=2&limit=20$/)
  assert.equal(calls[2].method, 'PATCH')
  assert.equal(calls[2].header.Authorization, 'Bearer token')
})



test('record duplicate save is blocked and errors preserve title and attachments', async () => {
  let rejectSave, calls = 0
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [] }), createRecord: () => { calls++; return new Promise((resolve, reject) => { rejectSave = reject }) } },
  })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Draft' } })
  const first = page.button('保存记录').onClick()
  await page.button('保存记录').onClick()
  assert.equal(calls, 1)
  rejectSave(new Error('offline'))
  await first
  assert.equal(page.input('记录标题').value, 'Draft')
  assert.match(page.text(), /输入已保留/)
})

test('removing a selected attachment submits an empty attachment list', async () => {
  let saved
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Record' }] }), getRecord: async () => ({ id: 1, title: 'Record', attachments: [7] }), updateRecord: async (id, input) => { saved = input } },
  })
  await page.show()
  await page.button('编辑').onClick()
  page.button('移除附件').onClick()
  await page.button('保存修改').onClick()
  assert.deepEqual(Array.from(saved.attachments), [])
})

test('an old unauthorized request must not clear a newer login token', async () => {
  let token = { token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z', userId: 1 }
  let resolveRequest
  const auth = loadSource('src/auth.js', {
    '@tarojs/taro': {
      getStorageSync: () => token,
      removeStorageSync: () => { token = '' },
      request: () => new Promise((resolve) => { resolveRequest = resolve }),
    },
  })
  const pending = auth.getCurrentUser()
  const newer = { token: 'B'.repeat(42) + 'A', expiresAt: '2099-01-01T00:00:00.000Z', userId: 2 }
  token = newer
  resolveRequest({ statusCode: 401 })
  await assert.rejects(pending, /AUTH_REQUIRED/)
  assert.equal(token, newer)
})



test('record submission is blocked while the list is loading', async () => {
  let resolveList, calls = 0
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: () => new Promise((resolve) => { resolveList = resolve }), createRecord: async () => { calls++ } },
  })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Draft' } })
  assert.equal(page.button('保存记录').disabled, true)
  await page.button('保存记录').onClick()
  assert.equal(calls, 0)
  resolveList({ items: [] })
  await new Promise(setImmediate)
  assert.equal(page.button('保存记录').disabled, false)
})


test('record delete requires explicit confirmation and cancel makes no request', async () => {
  let deleted = 0, confirm = false
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Record' }] }), deleteRecord: async () => { deleted++ } },
  }, { showModal: async () => ({ confirm }) })
  await page.show()
  await page.button('删除').onClick()
  assert.equal(deleted, 0)
  confirm = true
  await page.button('删除').onClick()
  assert.equal(deleted, 1)
})

test('discard confirmation preserves draft on cancel and clears it on confirm', async () => {
  let confirm = false, modals = 0
  const page = mountPage('src/pages/sub1/index.jsx', { '../../records': { listRecords: async () => ({ items: [] }) } }, {
    showModal: async () => { modals++; return { confirm } },
  })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Unsaved' } })
  await page.button('取消编辑').onClick()
  assert.equal(page.input('记录标题').value, 'Unsaved')
  confirm = true
  await page.button('取消编辑').onClick()
  assert.equal(page.input('记录标题').value, '')
  assert.equal(modals, 2)
})

test('editor upload associates the new file and retains draft when file picker returns', async () => {
  let page, saved
  page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [] }), createRecord: async (data) => { saved = data } },
    '../../media': { uploadMedia: async () => ({ id: 42, originalName: 'inside.pdf' }) },
  }, { chooseMessageFile: async () => { await page.show(); return { tempFiles: [{ path: '/tmp/file.pdf', name: 'inside.pdf', size: 12 }] } } })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Keep me' } })
  await page.button('上传附件').onClick()
  assert.equal(page.input('记录标题').value, 'Keep me')
  await page.button('保存记录').onClick()
  assert.deepEqual(Array.from(saved.attachments), [42])
})

test('upload cancel/failure preserves draft and never creates an attachment', async () => {
  let failure = { errMsg: 'chooseMessageFile:fail cancel' }, saved
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [] }), createRecord: async (data) => { saved = data } },
  }, { chooseMessageFile: async () => { throw failure } })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Draft' } })
  await page.button('上传附件').onClick()
  assert.ok(!page.text().includes('上传失败'))
  failure = new Error('offline')
  await page.button('上传附件').onClick()
  assert.match(page.text(), /上传失败/)
  await page.button('保存记录').onClick()
  assert.deepEqual(Array.from(saved.attachments), [])
})

for (const fixture of [
  { extension: 'pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF') },
  { extension: 'png', mimeType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') },
]) test(`complete local MVP page workflow against the real Payload HTTP backend (${fixture.extension})`, { skip: process.env.LOCAL_MVP_HTTP !== 'true' }, async () => {
  const base = new URL(process.env.TARO_APP_API_BASE_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  let token = '', confirm = true, uploadedID, previews = 0
  const name = `编辑页上传.${fixture.extension}`
  const selectedPath = `/virtual/local-test.${fixture.extension}`
  const previewPath = `/virtual/authenticated-preview.${fixture.extension}`
  const code = `mock:page-flow-${require('node:crypto').randomUUID()}`
  const host = {
    login: async () => ({ code }),
    getStorageSync: () => token,
    setStorageSync: (key, value) => { token = value },
    removeStorageSync: () => { token = '' },
    showToast: () => {},
    showModal: async () => ({ confirm }),
    chooseMessageFile: async () => ({ tempFiles: [{ path: selectedPath, name, size: fixture.bytes.length }] }),
    downloadFile: async ({ url, header }) => {
      const response = await fetch(url, { headers: header, signal: AbortSignal.timeout(30000) })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), fixture.mimeType)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes)
      return { statusCode: response.status, tempFilePath: previewPath }
    },
    openDocument: async ({ filePath, fileType }) => {
      assert.equal(fixture.extension, 'pdf')
      assert.equal(filePath, previewPath)
      assert.equal(fileType, 'pdf')
      previews++
    },
    previewImage: async ({ current, urls }) => {
      assert.equal(fixture.extension, 'png')
      assert.equal(current, previewPath)
      assert.deepEqual(Array.from(urls), [previewPath])
      previews++
    },
    request: async ({ url, method, data, header }) => {
      const response = await fetch(url, { method, headers: header, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000) })
      return { statusCode: response.status, data: response.status === 204 ? null : await response.json() }
    },
    uploadFile: async ({ url, header, filePath }) => {
      assert.equal(filePath, selectedPath)
      const form = new FormData()
      form.set('file', new Blob([fixture.bytes], { type: fixture.mimeType }), name)
      const response = await fetch(url, { method: 'POST', headers: header, body: form })
      const text = await response.text()
      if (response.ok) uploadedID = JSON.parse(text).data.id
      return { statusCode: response.status, data: text }
    },
  }
  const mocks = { '@tarojs/taro': host }
  const auth = loadSource('src/auth.js', mocks)
  const records = loadSource('src/records.js', mocks)
  const media = loadSource('src/media.js', mocks)
  let page
  try {
    await auth.loginWithWechat()
    await auth.updateCurrentUser({ displayName: '完整流程测试', avatarUrl: null })
    assert.equal((await auth.getCurrentUser()).displayName, '完整流程测试')
    page = mountPage('src/pages/sub1/index.jsx', { '../../auth': auth, '../../records': records, '../../media': media }, host)
    await page.show()
    // mountPage.show normally waits one tick, so wait for real HTTP initial load.
    for (let n = 0; n < 100 && page.button('保存记录').disabled; n++) await new Promise((resolve) => setTimeout(resolve, 20))
    page.input('记录标题').onInput({ detail: { value: 'MVP 完整流程' } })
    await page.button('上传附件').onClick()
    await page.button('保存记录').onClick()
    let result = await records.listRecords({ page: 1, limit: 1 })
    assert.equal(result.items[0].title, 'MVP 完整流程')
    assert.deepEqual(Array.from(result.items[0].attachments), [uploadedID])
    await assert.rejects(media.deleteMedia(uploadedID), /FILE_IN_USE/)
    await page.button('编辑').onClick()
    assert.ok(page.text().includes(name))
    await page.button('预览附件').onClick()
    assert.equal(previews, 1)
    page.input('记录标题').onInput({ detail: { value: '未保存修改' } })
    confirm = false
    await page.button('取消编辑').onClick()
    assert.equal(page.input('记录标题').value, '未保存修改')
    confirm = true
    await page.button('取消编辑').onClick()
    assert.equal(page.input('记录标题').value, '')
    await page.button('编辑').onClick()
    page.input('记录标题').onInput({ detail: { value: '已更新' } })
    page.button('移除附件').onClick()
    await page.button('保存修改').onClick()
    result = await records.listRecords()
    assert.equal(result.items[0].title, '已更新')
    assert.equal(result.items[0].attachments.length, 0)
    confirm = false
    await page.button('删除').onClick()
    assert.equal((await records.listRecords()).totalDocs, 1)
    confirm = true
    await page.button('删除').onClick()
    assert.equal((await records.listRecords()).totalDocs, 0)
    await media.deleteMedia(uploadedID)
    uploadedID = null
    await auth.logout()
    assert.equal(token, '')
  } finally {
    if (token) {
      for (const record of (await records.listRecords()).items) await records.deleteRecord(record.id)
      if (uploadedID) await media.deleteMedia(uploadedID)
      await auth.logout()
    }
  }
})

test('session expiry on returning to the editor preserves the unsaved draft', async () => {
  let expired = false
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => { if (expired) throw new Error('AUTH_REQUIRED'); return { items: [] } } },
  })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Preserve on expiry' } })
  expired = true
  await page.show()
  assert.equal(page.input('记录标题').value, 'Preserve on expiry')
  assert.match(page.text(), /请先登录/)
  assert.equal(page.button('保存记录').disabled, true)
  assert.doesNotMatch(page.text(), /还没有记录/)
})

test('switching records with a dirty draft requires discard confirmation', async () => {
  let confirm = false, reads = 0
  const page = mountPage('src/pages/sub1/index.jsx', { '../../records': {
    listRecords: async () => ({ items: [{ id: 1, title: 'Saved' }] }),
    getRecord: async () => { reads++; return { id: 1, title: 'Saved', attachments: [] } },
  } }, { showModal: async () => ({ confirm }) })
  await page.show()
  page.input('记录标题').onInput({ detail: { value: 'Draft' } })
  await page.button('编辑').onClick()
  assert.equal(reads, 0)
  assert.equal(page.input('记录标题').value, 'Draft')
  confirm = true
  await page.button('编辑').onClick()
  assert.equal(reads, 1)
  assert.equal(page.input('记录标题').value, 'Saved')
})

test('file deletion is not submitted when the confirmation is cancelled', async () => {
  let calls = 0, confirm = false
  const page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: [{ id: 1, originalName: 'file.pdf' }] }),
    deleteMedia: async () => { calls++ },
  } }, { showModal: async () => ({ confirm }) })
  await page.show()
  await page.button('删除').onClick()
  assert.equal(calls, 0)
  confirm = true
  await page.button('删除').onClick()
  assert.equal(calls, 1)
})

test('file picker returning to the same session completes upload and refreshes the list', async () => {
  let page, uploaded = false
  page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: uploaded ? [{ id: 8, originalName: 'returned.pdf' }] : [] }),
    uploadMedia: async () => { uploaded = true },
  } }, { chooseMessageFile: async () => { await page.show(); return { tempFiles: [{ path: '/file.pdf', name: 'returned.pdf', size: 10 }] } } })
  await page.show()
  await page.button('上传').onClick()
  assert.match(page.text(), /returned.pdf/)
})

test('changing accounts during file selection cancels upload into the new account', async () => {
  let token = 'owner', page, uploaded = 0
  page = mountPage('src/pages/sub2/index.jsx', {
    '../../auth': { getStoredToken: () => token },
    '../../media': { listMedia: async () => ({ items: [] }), uploadMedia: async () => { uploaded++ } },
  }, { chooseMessageFile: async () => { token = 'other'; await page.show(); return { tempFiles: [{ path: '/old-owner.pdf', name: 'old.pdf' }] } } })
  await page.show()
  await page.button('上传').onClick()
  assert.equal(uploaded, 0)
})

test('file delete explains referenced-file errors rather than reporting generic failure', async () => {
  const page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: [{ id: 1, originalName: 'used.pdf' }] }),
    deleteMedia: async () => { throw new Error('FILE_IN_USE') },
  } }, { showModal: async () => ({ confirm: true }) })
  await page.show()
  await page.button('删除').onClick()
  assert.match(page.text(), /先解除.*关联/)
  assert.match(page.text(), /used.pdf/)
})

test('file page rejects files larger than 10 MB before uploading', async () => {
  let uploaded = 0
  const page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: [] }), uploadMedia: async () => { uploaded++ },
  } }, { chooseMessageFile: async () => ({ tempFiles: [{ path: '/large.pdf', size: 10 * 1024 * 1024 + 1 }] }) })
  await page.show()
  await page.button('上传').onClick()
  assert.equal(uploaded, 0)
  assert.match(page.text(), /10 MB/)
})

test('attachment selector refuses a 21st file without discarding the current selection', async () => {
  let saved
  const original = Array.from({ length: 20 }, (_, n) => n + 1)
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Full' }] }), getRecord: async () => ({ id: 1, title: 'Full', attachments: original }), updateRecord: async (id, input) => { saved = input } },
    '../../media': { listMedia: async () => ({ items: [{ id: 21, originalName: 'extra.pdf' }] }) },
  })
  await page.show()
  await page.button('编辑').onClick()
  await page.button('选择已有文件').onClick()
  page.button('添加附件').onClick()
  assert.match(page.text(), /最多.*20/)
  await page.button('保存修改').onClick()
  assert.deepEqual(Array.from(saved.attachments), original)
})

test('returning from a file-delete modal in the same session keeps the action alive', async () => {
  let page, removed = false
  page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: removed ? [] : [{ id: 1, originalName: 'modal.pdf' }] }),
    deleteMedia: async () => { removed = true },
  } }, { showModal: async () => { await page.show(); return { confirm: true } } })
  await page.show()
  await page.button('删除').onClick()
  assert.equal(removed, true)
  assert.ok(!page.text().includes('modal.pdf'))
})

test('record editor does not upload a selected file after token replacement without a page-show event', async () => {
  let token = 'first', uploaded = 0
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../auth': { getStoredToken: () => token },
    '../../records': { listRecords: async () => ({ items: [] }) },
    '../../media': { uploadMedia: async () => { uploaded++ } },
  }, { chooseMessageFile: async () => { token = 'replacement'; return { tempFiles: [{ path: '/first.pdf', size: 12 }] } } })
  await page.show()
  await page.button('上传附件').onClick()
  assert.equal(uploaded, 0)
})







test('media metadata client uses the current authenticated API path', async () => {
  let requested
  const media = loadSource('src/media.js', {
    '@tarojs/taro': { request: async (options) => { requested = options; return { statusCode: 200, data: { data: { id: 7, originalName: 'saved.pdf' } } } } },
    './auth': { getStoredToken: () => 'current-token' },
  })
  const item = await media.getMedia(7)
  assert.match(requested.url, /\/api\/v1\/media\/7$/)
  assert.equal(requested.header.Authorization, 'Bearer current-token')
  assert.equal(item.originalName, 'saved.pdf')
})

test('saved record attachments show their filename and reuse authenticated preview', async () => {
  const opened = []
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Saved' }] }), getRecord: async () => ({ id: 1, title: 'Saved', attachments: [7] }) },
    '../../media': { getMedia: async (id) => ({ id, originalName: '历史附件.pdf', mimeType: 'application/pdf' }), openMedia: async (item) => opened.push(item) },
  })
  await page.show()
  await page.button('编辑').onClick()
  assert.match(page.text(), /历史附件.pdf/)
  assert.ok(!page.text().includes('附件 #7'))
  await page.button('预览附件').onClick()
  assert.equal(opened.length, 1)
  assert.equal(opened[0].id, 7)
  assert.equal(opened[0].mimeType, 'application/pdf')
})

test('existing file selection retains the name after moving to another picker page', async () => {
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [] }) },
    '../../media': { listMedia: async ({ page }) => ({ items: page === 1 ? [{ id: 7, originalName: 'selected.pdf' }] : [], page, totalPages: 2 }) },
  })
  await page.show()
  await page.button('选择已有文件').onClick()
  page.button('添加附件').onClick()
  await page.button('附件下一页').onClick()
  assert.match(page.text(), /selected.pdf/)
  assert.ok(!page.text().includes('附件 #7'))
})

test('attachment metadata failure can be retried without losing text or selected IDs', async () => {
  let offline = true, saved
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Saved' }] }), getRecord: async () => ({ id: 1, title: 'Saved', body: 'Body', attachments: [7] }), updateRecord: async (id, input) => { saved = input } },
    '../../media': { getMedia: async (id) => { if (offline) throw new Error('offline'); return { id, originalName: 'recovered.pdf' } } },
  })
  await page.show()
  await page.button('编辑').onClick()
  assert.equal(page.input('记录标题').value, 'Saved')
  assert.match(page.text(), /附件信息读取失败/)
  page.input('记录标题').onInput({ detail: { value: 'Keep draft' } })
  offline = false
  await page.button('重试附件信息').onClick()
  assert.match(page.text(), /recovered.pdf/)
  assert.equal(page.input('记录标题').value, 'Keep draft')
  await page.button('保存修改').onClick()
  assert.equal(saved.title, 'Keep draft')
  assert.deepEqual(Array.from(saved.attachments), [7])
})

test('attachment preview failure preserves the editable draft and offers another attempt', async () => {
  let attempts = 0
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Draft' }] }), getRecord: async () => ({ id: 1, title: 'Draft', attachments: [7] }) },
    '../../media': { getMedia: async (id) => ({ id, originalName: 'file.pdf' }), openMedia: async () => { attempts++; if (attempts === 1) throw new Error('offline') } },
  })
  await page.show()
  await page.button('编辑').onClick()
  page.input('记录标题').onInput({ detail: { value: 'Unsaved draft' } })
  await page.button('预览附件').onClick()
  assert.match(page.text(), /附件打开失败/)
  assert.equal(page.input('记录标题').value, 'Unsaved draft')
  await page.button('预览附件').onClick()
  assert.equal(attempts, 2)
})

test('late attachment metadata from a replaced session is not displayed', async () => {
  let token = 'first', release
  const page = mountPage('src/pages/sub1/index.jsx', {
    '../../auth': { getStoredToken: () => token },
    '../../records': { listRecords: async () => ({ items: [{ id: 1, title: 'Saved' }] }), getRecord: async () => ({ id: 1, title: 'Saved', attachments: [7] }) },
    '../../media': { getMedia: () => new Promise((resolve) => { release = resolve }) },
  })
  await page.show()
  const editing = page.button('编辑').onClick()
  await new Promise(setImmediate)
  assert.equal(typeof release, 'function')
  token = 'second'
  release({ id: 7, originalName: 'first-account-private.pdf' })
  await editing
  assert.ok(!page.text().includes('first-account-private.pdf'))
  await page.show()
  assert.equal(page.input('记录标题').value, '')
})

test('download finishing after account replacement does not open a private native preview', async () => {
  let token = 'first', opened = 0
  const media = loadSource('src/media.js', {
    '@tarojs/taro': {
      downloadFile: async () => { token = 'second'; return { statusCode: 200, tempFilePath: '/private.pdf' } },
      openDocument: async () => { opened++ },
    },
    './auth': { getStoredToken: () => token },
  })
  await assert.rejects(media.openMedia({ id: 7, mimeType: 'application/pdf' }), /AUTH_REQUIRED/)
  assert.equal(opened, 0)
})

test('upload response preserves backend error codes from string and object bodies', async () => {
  for (const asString of [true, false]) {
    for (const [statusCode, code] of [[413, 'FILE_TOO_LARGE'], [400, 'FILE_TYPE_NOT_ALLOWED'], [401, 'AUTH_REQUIRED']]) {
      const body = { error: { code, message: 'fixture' } }
      const media = loadSource('src/media.js', {
        '@tarojs/taro': { uploadFile: async () => ({ statusCode, data: asString ? JSON.stringify(body) : body }) },
        './auth': { getStoredToken: () => 'token' },
      })
      await assert.rejects(media.uploadMedia('/fixture.pdf', 'fixture.pdf'), { message: code })
    }
  }
})

test('upload parses successful responses and gives malformed responses a consistent error', async () => {
  let response = { statusCode: 201, data: JSON.stringify({ data: { id: 7, originalName: 'file.pdf' } }) }
  const media = loadSource('src/media.js', {
    '@tarojs/taro': { uploadFile: async () => response },
    './auth': { getStoredToken: () => 'token' },
  })
  assert.equal((await media.uploadMedia('/fixture.pdf')).id, 7)
  response = { statusCode: 201, data: { data: { id: 8 } } }
  assert.equal((await media.uploadMedia('/fixture.pdf')).id, 8)
  for (const data of ['<html>not JSON</html>', '{}', 'null']) {
    response = { statusCode: 200, data }
    await assert.rejects(media.uploadMedia('/fixture.pdf'), /INVALID_RESPONSE/)
  }
})

test('record and media requests share authorization without setting multipart content-type', async () => {
  const api = loadSource('src/api.js')
  assert.throws(() => api.authorizationHeaders({ token: '' }), /AUTH_REQUIRED/)
  assert.equal(api.authorizationHeaders({ token: 'token', json: true })['content-type'], 'application/json')
  assert.equal(api.authorizationHeaders({ token: 'token' })['content-type'], undefined)
  const calls = []
  const mocks = {
    '@tarojs/taro': {
      request: async (options) => { calls.push(options); return { statusCode: 200, data: { data: { items: [] } } } },
      uploadFile: async (options) => { calls.push(options); return { statusCode: 201, data: JSON.stringify({ data: { id: 9 } }) } },
    },
    './auth': { getStoredToken: () => 'token' },
  }
  await loadSource('src/records.js', mocks).createRecord({ title: 'x' })
  await loadSource('src/media.js', mocks).uploadMedia('/fixture.pdf')
  assert.equal(calls[0].header.Authorization, 'Bearer token')
  assert.equal(calls[1].header.Authorization, 'Bearer token')
  assert.equal(calls[1].header['content-type'], undefined)
})

test('shared file chooser owns size boundaries, cancellation and empty selection', async () => {
  let result = { tempFiles: [{ path: '/file.pdf', name: 'file.pdf', size: 10 * 1024 * 1024 }] }, failure
  const media = loadSource('src/media.js', {
    '@tarojs/taro': { chooseMessageFile: async (options) => {
      assert.equal(options.count, 1)
      assert.deepEqual(Array.from(options.extension), ['jpg', 'jpeg', 'png', 'pdf'])
      if (failure) throw failure
      return result
    } },
  })
  assert.equal((await media.chooseUploadFile()).path, '/file.pdf')
  result.tempFiles[0].size++
  await assert.rejects(media.chooseUploadFile(), /FILE_TOO_LARGE/)
  result = { tempFiles: [] }
  assert.equal(await media.chooseUploadFile(), null)
  failure = { errMsg: 'chooseMessageFile:fail cancel' }
  assert.equal(await media.chooseUploadFile(), null)
  failure = new Error('offline')
  await assert.rejects(media.chooseUploadFile(), /offline/)
})

test('file preview blocks duplicate actions until the first preview settles', async () => {
  let calls = 0, release
  const page = mountPage('src/pages/sub2/index.jsx', { '../../media': {
    listMedia: async () => ({ items: [{ id: 1, originalName: 'one.pdf' }] }),
    openMedia: () => { calls++; return calls === 1 ? new Promise((resolve) => { release = resolve }) : Promise.resolve() },
  } })
  await page.show()
  const first = page.clickable('one.pdf').onClick()
  await page.clickable('one.pdf').onClick()
  release(); await first
  assert.equal(calls, 1)
  assert.equal(page.button('上传').disabled, false)
})

for (const notifyShow of [false, true]) {
  test(`old file preview failure cannot update a new account (page-show=${notifyShow})`, async () => {
    let token = 'first', rejectOld
    const page = mountPage('src/pages/sub2/index.jsx', {
      '../../auth': { getStoredToken: () => token },
      '../../media': { listMedia: async () => ({ items: [{ id: 1, originalName: 'file.pdf' }] }), openMedia: () => new Promise((resolve, reject) => { rejectOld = reject }) },
    })
    await page.show()
    const opening = page.clickable('file.pdf').onClick()
    token = 'second'
    if (notifyShow) await page.show()
    rejectOld(new Error('late failure'))
    await opening
    assert.ok(!page.text().includes('文件打开失败'))
  })
}

test('old preview completion does not unlock a newer account preview', async () => {
  let token = 'first', calls = 0
  const releases = []
  const page = mountPage('src/pages/sub2/index.jsx', {
    '../../auth': { getStoredToken: () => token },
    '../../media': { listMedia: async () => ({ items: [{ id: 1, originalName: 'file.pdf' }] }), openMedia: () => { calls++; return new Promise((resolve) => releases.push(resolve)) } },
  })
  await page.show()
  const old = page.clickable('file.pdf').onClick()
  token = 'second'; await page.show()
  const newer = page.clickable('file.pdf').onClick()
  releases[0](); await old
  const duplicate = page.clickable('file.pdf').onClick()
  for (const release of releases.slice(1)) release()
  await Promise.all([newer, duplicate])
  assert.equal(calls, 2)
})

for (const pageName of ['sub1', 'sub2']) {
  test(`${pageName} shows the shared backend upload reason and preserves existing content`, async () => {
    const page = mountPage(`src/pages/${pageName}/index.jsx`, {
      '../../records': { listRecords: async () => ({ items: [] }) },
      '../../media': {
        listMedia: async () => ({ items: [{ id: 1, originalName: 'existing.pdf' }] }),
        uploadMedia: async () => { throw new Error('FILE_TYPE_NOT_ALLOWED') },
      },
    }, { chooseMessageFile: async () => ({ tempFiles: [{ path: '/file.pdf', name: 'file.pdf', size: 10 }] }) })
    await page.show()
    if (pageName === 'sub1') page.input('记录标题').onInput({ detail: { value: 'Unsaved draft' } })
    await page.button(pageName === 'sub1' ? '上传附件' : '上传').onClick()
    assert.match(page.text(), /文件类型或内容无效/)
    if (pageName === 'sub1') assert.equal(page.input('记录标题').value, 'Unsaved draft')
    else assert.match(page.text(), /existing.pdf/)
  })
}

test('shared response parser and file delete accept empty 204 responses', async () => {
  const api = loadSource('src/api.js')
  for (const data of ['', null, undefined]) {
    assert.equal(api.parseJsonResponse({ statusCode: 204, data }), data)
    const media = loadSource('src/media.js', {
      '@tarojs/taro': { request: async () => ({ statusCode: 204, data }) },
      './auth': { getStoredToken: () => 'token' },
    })
    await media.deleteMedia(7)
  }
})
