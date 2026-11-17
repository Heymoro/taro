const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { withPages } = require('../fixtures/creation-pages.cjs')

// Real Pages/hooks/workflow and ONE actual creation-api/auth module graph. Native HTTP
// routing is in memory; this does not exercise a weapp Runtime or an HTTP server.
function gate() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function envelopeUnknown() {
  return { statusCode: 200, data: { data: { broken: true }, requestId: 'unknown-memory' } }
}
function httpApi({ native, ports, initialFavorite, writeGate, calls, unknown = false }) {
  let serverFavorite = initialFavorite
  const credential = { userId: 1, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }
  native.getStorageSync = () => credential
  native.removeStorageSync = () => {
    throw Error('unexpected logout')
  }
  const stamp = '2026-11-14T00:00:00.000Z'
  const history = (row) => ({
    ...row,
    inputAvailability: [],
    resolution: null,
    createdAt: stamp,
    startedAt: stamp,
    finishedAt: stamp
  })
  native.request = async ({ url, method, data, header }) => {
    const path = url.split('/api/v1')[1]
    calls.push({ path, method, data, header })
    let result
    if (path === '/creation-sessions/4') result = await ports.getSession({ sessionId: 4 })
    else if (path === '/creation-account') result = await ports.account()
    else if (path === '/creation-presets/free') result = await ports.freePreset()
    else if (path.startsWith('/templates/')) result = await ports.template()
    else if (path.startsWith('/creation-sessions/4/generations')) {
      const page = await ports.tasks({})
      result = { ...page, items: page.items.map(history) }
    } else if (path.startsWith('/generations/'))
      result = history(await ports.task({ taskId: Number(path.split('/').pop()) }))
    else if (path === '/generation-quotes') result = await ports.quote(data)
    else if (path === '/creation-sessions/4/draft') result = await ports.putDraft({ input: data })
    else if (path === '/artifacts/66/favorite') {
      await ports.favorite({ artifactId: 66, isFavorite: method === 'PUT' })
      await writeGate.promise // actual commit AND response are delayed, not just the UI callback.
      if (unknown) return envelopeUnknown()
      serverFavorite = method === 'PUT'
      result = { isFavorite: serverFavorite, savedAt: serverFavorite ? stamp : null }
    } else if (path === '/artifacts/66') {
      result = {
        ...(await ports.artifact({ artifactId: 66 })),
        isFavorite: serverFavorite,
        outputIndex: 1,
        width: 512,
        height: 512,
        mimeType: 'image/png',
        createdAt: stamp,
        savedAt: serverFavorite ? stamp : null
      }
    } else throw Error(`unexpected route ${method} ${path}`)
    return { statusCode: 200, data: { data: result, requestId: 'memory-http' } }
  }
  return load('src/creation-api.js', { '@tarojs/taro': native })
}
for (const initialFavorite of [false, true])
  for (const explicit of [false, true])
    test(`shared actual API ${initialFavorite ? 'DELETE' : 'PUT'} pending across ${
      explicit ? 'explicit Return' : 'native back'
    } refreshes original card after settlement`, async () => {
      const writeGate = gate(),
        calls = []
      await withPages(
        async (h) => {
          await h.act(async () => h.render('create'))
          await h.flush()
          const controller = h.controllers[0]
          assert.equal(controller.getSnapshot().artifacts[66].isFavorite, initialFavorite)
          await h.act(async () => {
            controller.setDescription('preserved input')
            await controller.prepareQuote()
          })
          const before = controller.getSnapshot(),
            local = h.storageWrites.length,
            writes = h.businessWrites.length
          await h.act(async () => h.click('create', '查看作品'))
          await h.act(async () => h.render('detail'))
          await h.act(async () => h.click('detail', initialFavorite ? '已收藏' : '收藏'))
          const beforeBack = calls.length
          await h.act(async () => {
            if (explicit) h.click('detail', '返回创作')
            else h.native.navigateBack({ success() {} })
            h.unmountDetail()
          })
          await h.flush()
          assert.equal(
            calls.slice(beforeBack).filter((c) => c.path === '/artifacts/66').length,
            0,
            'return read must wait for actual write transport, including after detail unmount'
          )
          await h.act(async () => writeGate.resolve())
          await h.flush()
          assert.equal(controller.getSnapshot().artifacts[66].isFavorite, !initialFavorite)
          assert.equal(h.controllers.length, 1)
          assert.equal(calls.filter((c) => c.path.endsWith('/favorite')).length, 1)
          assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=66&returnTo=opener', 'back'])
          const after = controller.getSnapshot()
          for (const key of [
            'description',
            'notes',
            'photos',
            'quote',
            'sourceArtifactId',
            'submission'
          ])
            assert.deepEqual(after[key], before[key], key)
          assert.equal(h.storageWrites.length, local)
          assert.equal(
            h.businessWrites.slice(writes).filter(([kind]) => kind !== 'favorite').length,
            0
          )
        },
        {
          initialFavorite,
          initialAccountKey: `1:${'A'.repeat(43)}:2099-01-01T00:00:00.000Z`,
          createApi: (args) => httpApi({ ...args, initialFavorite, writeGate, calls })
        }
      )
    })

for (const explicit of [false, true])
  test(`real API unknown write after ${
    explicit ? 'explicit' : 'native'
  } return keeps current observation and controlled read-only feedback`, async () => {
    const writeGate = gate(),
      calls = []
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await h.flush()
        const controller = h.controllers[0]
        await h.act(async () => h.click('create', '查看作品'))
        await h.act(async () => h.render('detail'))
        await h.act(async () => h.click('detail', '收藏'))
        await h.act(async () => {
          if (explicit) h.click('detail', '返回创作')
          else h.native.navigateBack({ success() {} })
          h.unmountDetail()
        })
        await h.act(async () => writeGate.resolve())
        await h.flush()
        assert.equal(controller.getSnapshot().artifacts[66].isFavorite, false)
        assert.match(document.querySelector('#create').textContent, /作品状态正在更新，请重试读取/)
        assert.equal(calls.filter((c) => c.path.endsWith('/favorite')).length, 1)
        const before = calls.length
        await h.act(async () => h.click('create', '重试读取'))
        await h.flush()
        assert.equal(controller.getSnapshot().artifacts[66].isFavorite, false)
        assert.match(document.querySelector('#create').textContent, /作品状态正在更新，请重试读取/)
        assert.equal(calls.slice(before).filter((c) => c.method !== 'GET').length, 0)
        assert.equal(h.nativeCalls.filter((v) => v === 'back').length, 1)
      },
      {
        initialAccountKey: `1:${'A'.repeat(43)}:2099-01-01T00:00:00.000Z`,
        createApi: (args) =>
          httpApi({ ...args, initialFavorite: false, writeGate, calls, unknown: true })
      }
    )
  })
