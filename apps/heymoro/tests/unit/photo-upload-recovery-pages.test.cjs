const { test } = require('node:test')
const assert = require('node:assert/strict')
const { template } = require('../fixtures/creation.cjs')
const { pages, ordinary, frozen, frozenMap, clone, gate } = require('../fixtures/session-unavailable.cjs')

const pick = (id = 'a') => ({ path: `/${id}.png`, name: id, size: 12, mimeType: 'image/png' })
const slot = (status, id = 'local') => ({ ...pick(id), id, status })
const options = (photos = []) => ({
  saved: new Map([['session:4', ordinary({ photos })]]),
  api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) },
})
const button = (text) => [...document.querySelectorAll('#create button')].find((b) => b.textContent === text)
const retryButtons = () => [...document.querySelectorAll('.photo-tile__retry')]

for (const publication of ['pending', 'uploading']) {
  test(`actual page ${publication} publication interruption exposes continue without refresh and double click uploads once`, async () => {
    let uploads = 0
    const held = gate()
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0],
          text = w.getSnapshot().description
        let stopped = false
        const off = w.subscribe(() => {
          if (!stopped && w.getSnapshot().photos.some((p) => p.status === publication)) {
            stopped = true
            h.fire(h.createPage, 'hide')
            h.fire(h.createPage, 'show')
          }
        })
        await h.act(async () => w.addPhotos())
        off()
        assert.equal(stopped, true)
        assert.equal(uploads, 0)
        assert.ok(button('继续上传'))
        assert.doesNotMatch(document.querySelector('#create').textContent, /上传中|等待上传/)
        const node = button('继续上传')
        await h.act(async () => {
          node.click()
          node.click()
        })
        assert.equal(uploads, 1)
        assert.equal(retryButtons().length, 0)
        assert.match(document.querySelector('#create').textContent, /上传中/)
        await h.act(async () => held.resolve({ id: 99 }))
        assert.equal(w.getSnapshot().photos[0].status, 'ready')
        assert.equal(w.getSnapshot().photos[0].mediaId, 99)
        assert.equal(w.getSnapshot().description, text)
        assert.equal(retryButtons().length, 0)
      },
      {
        ...options(),
        photoPorts: {
          choose: async () => [pick()],
          upload: async () => {
            uploads++
            return held.promise
          },
        },
      }
    )
  })
}

for (const outcome of ['success', 'failure']) {
  test(`actual hook obsolete flight ${outcome} emits continue after settle, no false ready or durable writes`, async () => {
    const held = gate()
    let uploads = 0
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0]
        let pending
        await h.act(async () => {
          pending = w.addPhotos()
        })
        const id = w.getSnapshot().photos[0].id
        await h.act(async () => {
          h.fire(h.createPage, 'hide')
          h.fire(h.createPage, 'show')
        })
        assert.equal(uploads, 1)
        assert.equal(retryButtons().length, 0)
        assert.match(document.querySelector('#create').textContent, /上传中/)
        await h.act(async () => Promise.all([w.resumePhoto(id), w.resumePhoto(id)]))
        assert.equal(uploads, 1)
        const raw = clone([...h.storage.saved]),
          writes = h.storage.writes.length,
          photos = clone(w.getSnapshot().photos)
        await h.act(async () => {
          if (outcome === 'success') held.resolve({ id: 88 })
          else held.reject(Error('old upload failure'))
          await pending
        })
        assert.deepEqual(clone(w.getSnapshot().photos), photos)
        assert.deepEqual(clone([...h.storage.saved]), raw)
        assert.equal(h.storage.writes.length, writes)
        assert.ok(button('继续上传'), 'settle notification reaches the actual hook without a refresh')
        await h.act(async () => {
          h.click('create', '继续上传')
          h.click('create', '继续上传')
        })
        assert.equal(uploads, 2)
        assert.equal(w.getSnapshot().photos[0].mediaId, 99)
        assert.equal(w.getSnapshot().photos[0].status, 'ready')
      },
      {
        ...options(),
        photoPorts: { choose: async () => [pick()], upload: async () => (++uploads === 1 ? held.promise : { id: 99 }) },
      }
    )
  })
}

for (const status of ['pending', 'uploading', 'failed']) {
  test(`cold ${status} actual DOM keeps prior restore semantics and explicit recovery`, async () => {
    let uploads = 0
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        assert.equal(uploads, 0)
        assert.equal(h.storage.writes.length, 0)
        const label = status === 'pending' ? '继续上传' : '重试上传'
        assert.ok(button(label))
        await h.act(async () => h.click('create', label))
        assert.equal(uploads, 1)
        assert.equal(h.controllers[0].getSnapshot().photos[0].mediaId, 99)
      },
      {
        ...options([slot(status)]),
        photoPorts: {
          upload: async () => {
            uploads++
            return { id: 99 }
          },
        },
      }
    )
  })
}

for (const disabled of ['unknown-schema', 'zero-schema', 'unavailable', 'active-intent']) {
  test(`actual DOM ${disabled} withholds continue action but retains remove`, async () => {
    let uploads = 0
    const config = template()
    if (disabled === 'unknown-schema') delete config.inputSchema.maxImages
    if (disabled === 'zero-schema') config.inputSchema.maxImages = 0
    const opts = options([slot('pending')])
    if (disabled === 'unavailable') opts.control = { missing: true }
    if (disabled === 'active-intent')
      opts.saved.set('initial-input:session:4', { private: 'malformed intent remains preserved' })
    opts.api = { ...opts.api, template: async () => config, freePreset: async () => config }
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const node = button('继续上传')
        assert.ok(node)
        assert.equal(node.disabled, true)
        await h.act(async () => node.click())
        assert.equal(uploads, 0)
        assert.equal(h.storage.writes.length, 0)
        assert.equal(document.querySelectorAll('.photo-tile__remove').length, 1)
      },
      {
        ...opts,
        photoPorts: {
          upload: async () => {
            uploads++
            return { id: 9 }
          },
        },
      }
    )
  })
}

test('real F actual page continue uploads editable photo without changing frozen body', async () => {
  const record = frozen('generate')
  record.photos = [slot('pending')]
  const saved = frozenMap(record)
  let uploads = 0
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const original = clone(h.controllers[0].getSnapshot().submission)
      assert.equal(button('继续上传').disabled, false)
      await h.act(async () => h.click('create', '继续上传'))
      assert.equal(uploads, 1)
      assert.equal(h.controllers[0].getSnapshot().photos[0].mediaId, 99)
      assert.deepEqual(clone(h.controllers[0].getSnapshot().submission), original)
      assert.deepEqual(clone(saved.get('session:4').submission), original)
      assert.deepEqual(clone(saved.get('unsettled:session:4').record.submission), original)
    },
    {
      ...options(),
      saved,
      photoPorts: {
        upload: async () => {
          uploads++
          return { id: 99 }
        },
      },
    }
  )
})

test('continue uses production photoOrder action and stopTouch; cancelled longpress synthetic click never uploads', async () => {
  let uploads = 0
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.act(async () => h.click('create', '整理'))
      const tile = h.handlers.get('photo-order__slot')
      const touch = { identifier: 1, clientX: 10, clientY: 20 }
      const event = { touches: [touch], stopPropagation() {} }
      await h.act(async () => {
        tile.onTouchStart(event)
        tile.onLongPress(event)
        tile.onTouchCancel({ touches: [], changedTouches: [touch] })
        h.click('create', '继续上传')
      })
      assert.equal(uploads, 0)
      let stopped = 0
      await h.act(async () => {
        h.handlers.get('photo-tile__retry').onTouchStart({ touches: [touch], stopPropagation: () => stopped++ })
        h.click('create', '继续上传')
      })
      assert.equal(stopped, 1)
      assert.equal(uploads, 1)
      assert.equal(h.controllers[0].getSnapshot().photos[0].mediaId, 99)
    },
    {
      ...options([slot('pending')]),
      photoPorts: {
        upload: async () => {
          uploads++
          return { id: 99 }
        },
      },
    }
  )
})

test('unavailable photo keeps replace text and failed photo keeps original retry handler', async () => {
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      assert.ok(button('补选照片'))
      assert.ok(button('重试上传'))
      assert.equal(button('继续上传'), undefined)
      assert.match(document.querySelector('#create').textContent, /照片已失效/)
    },
    {
      ...options(),
      saved: new Map([
        [
          'session:4',
          ordinary({
            photos: [{ id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }, slot('failed')],
            carryBackSourceTaskId: 9,
          }),
        ],
      ]),
    }
  )
})

test('replacement pending interruption releases existing batch busy and exposes actual continue', async () => {
  let uploads = 0
  const saved = new Map([
    [
      'session:4',
      ordinary({ photos: [{ id: 'media:7', status: 'unavailable', path: '', mediaId: 7 }], carryBackSourceTaskId: 9 }),
    ],
  ])
  await pages(
    async (h) => {
      await h.act(async () => h.render('create'))
      const w = h.controllers[0]
      let stopped = false
      const off = w.subscribe(() => {
        if (!stopped && w.getSnapshot().photos.some((p) => p.status === 'pending')) {
          stopped = true
          h.fire(h.createPage, 'hide')
          h.fire(h.createPage, 'show')
        }
      })
      await h.act(async () => h.click('create', '补选照片'))
      off()
      assert.equal(stopped, true)
      assert.equal(uploads, 0)
      assert.equal(w.getSnapshot().controls.photoBatchBusy, false)
      assert.ok(button('继续上传'))
      await h.act(async () => h.click('create', '继续上传'))
      assert.equal(uploads, 1)
      assert.equal(w.getSnapshot().photos[0].mediaId, 99)
    },
    {
      ...options(),
      saved,
      photoPorts: {
        choose: async () => [pick()],
        upload: async () => {
          uploads++
          return { id: 99 }
        },
      },
    }
  )
})

for (const kind of ['zero', 'missing-decoded']) {
  test(`production captured continue callback after decoded ${kind} refresh is blocked until valid config returns`, async () => {
    let uploads = 0,
      configReads = 0
    await pages(
      async (h) => {
        await h.act(async () => h.render('create'))
        const w = h.controllers[0]
        assert.equal(button('继续上传').disabled, false)
        const oldContinue = h.handlers.get('photo-tile__retry').onClick
        const config = template()
        if (kind === 'zero') config.inputSchema.maxImages = 0
        else delete config.inputSchema.maxImages
        let responseConfig = config
        const { load } = require('../source.cjs')
        const decoded = load('src/creation-api.js', {
          '@tarojs/taro': {
            request: async () => {
              configReads++
              return { statusCode: 200, data: { data: responseConfig, requestId: 'fresh-config' } }
            },
          },
          './auth': {
            getStoredSession: () => ({ userId: 1, token: 'memory', expiresAt: '2099-01-01' }),
            getStoredToken: () => 'memory',
            clearToken() {},
          },
        }).creationApi
        h.api.freePreset = decoded.freePreset
        await h.act(async () => w.refresh())
        assert.equal(configReads, 1)
        if (kind === 'zero') assert.equal(w.getSnapshot().template.inputSchema.maxImages, 0)
        else assert.equal(w.getSnapshot().template, null)
        assert.equal(button('继续上传').disabled, true)
        const snapshot = clone(w.getSnapshot()),
          raw = clone([...h.storage.saved]),
          writes = h.storage.writes.length
        await h.act(async () => oldContinue({ stopPropagation() {} }))
        assert.equal(uploads, 0)
        assert.deepEqual(clone(w.getSnapshot()), snapshot)
        assert.deepEqual(clone([...h.storage.saved]), raw)
        assert.equal(h.storage.writes.length, writes)
        responseConfig = template()
        await h.act(async () => w.refresh())
        assert.equal(configReads, 2)
        assert.equal(button('继续上传').disabled, false)
        await h.act(async () => h.click('create', '继续上传'))
        assert.equal(uploads, 1)
        assert.equal(w.getSnapshot().photos[0].mediaId, 99)
      },
      {
        ...options([slot('pending')]),
        photoPorts: {
          upload: async () => {
            uploads++
            return { id: 99 }
          },
        },
      }
    )
  })
}
