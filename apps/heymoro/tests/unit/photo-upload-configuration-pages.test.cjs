const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const { template } = require('../fixtures/creation.cjs')
const { pages, ordinary, clone, gate } = require('../fixtures/session-unavailable.cjs')

const pick = { path: '/selected.png', name: 'selected', size: 12, mimeType: 'image/png' }
const photo = (command) =>
  command === 'replace'
    ? { id: 'media:7', path: '', status: 'unavailable', mediaId: 7 }
    : {
        ...pick,
        id: 'local',
        status: command === 'add' ? 'ready' : command === 'retry' ? 'failed' : 'pending',
        ...(command === 'add' ? { mediaId: 7 } : {}),
      }
const options = (command) => ({
  saved: new Map([
    ['session:4', ordinary({ photos: [photo(command)], carryBackSourceTaskId: command === 'replace' ? 9 : null })],
  ]),
  api: { tasks: async () => ({ items: [], hasMore: false, nextCursor: null }) },
})
function configuration(kind) {
  const value = template()
  if (kind === 'zero') value.inputSchema.maxImages = 0
  if (kind === 'missing-decoded') delete value.inputSchema.maxImages
  return load('src/creation-api.js', {
    '@tarojs/taro': { request: async () => ({ statusCode: 200, data: { data: value, requestId: 'page-config' } }) },
    './auth': {
      getStoredSession: () => ({ userId: 1, token: 'memory', expiresAt: '2099-01-01' }),
      getStoredToken: () => 'memory',
      clearToken() {},
    },
  }).creationApi.freePreset
}
const selector = (command) => (command === 'add' ? 'photo-add' : 'photo-tile__retry')
async function configure(h, kind) {
  h.api.freePreset = configuration(kind)
  await h.act(async () => h.controllers[0].refresh())
  const config = h.controllers[0].getSnapshot().template
  if (kind === 'missing-decoded') assert.equal(config, null)
  else assert.equal(config.inputSchema.maxImages, kind === 'zero' ? 0 : 8)
}

for (const kind of ['zero', 'missing-decoded']) {
  for (const command of ['retry', 'resume', 'replace', 'add']) {
    test(`production page old ${command} callback at decoded ${kind} has zero effects; fresh valid DOM action works`, async () => {
      let choices = 0,
        uploads = 0
      await pages(
        async (h) => {
          await h.act(async () => h.render('create'))
          const w = h.controllers[0],
            oldHandler = h.handlers.get(selector(command)).onClick
          assert.equal(typeof oldHandler, 'function')
          await configure(h, kind)
          const raw = clone([...h.storage.saved]),
            photos = clone(w.getSnapshot().photos),
            writes = h.storage.writes.length
          await h.act(async () => oldHandler({ stopPropagation() {} }))
          await h.flush()
          assert.equal(choices, 0)
          assert.equal(
            uploads,
            0,
            'captured production callback must be stopped by the workflow, not merely disabled DOM'
          )
          assert.deepEqual(clone([...h.storage.saved]), raw)
          assert.equal(h.storage.writes.length, writes)
          assert.deepEqual(clone(w.getSnapshot().photos), photos)
          assert.equal(w.getSnapshot().controls.canSelectPhotos, false)
          if (command !== 'add') assert.equal(document.querySelector('.photo-tile__retry').disabled, true)
          await configure(h, 'valid')
          assert.equal(uploads, 0)
          const node = document.querySelector(`.${selector(command)}`)
          assert.ok(node)
          assert.equal(node.disabled, false)
          await h.act(async () => node.click())
          await h.flush()
          assert.equal(uploads, 1)
          assert.equal(choices, ['add', 'replace'].includes(command) ? 1 : 0)
          assert.equal(w.getSnapshot().photos.at(-1).mediaId, 88)
        },
        {
          ...options(command),
          photoPorts: {
            choose: async () => {
              choices++
              return [pick]
            },
            upload: async () => {
              uploads++
              return { id: 88 }
            },
          },
        }
      )
    })
  }
}

for (const command of ['add', 'replace']) {
  for (const kind of ['zero', 'missing-decoded']) {
    test(`production page held ${command} selection after ${kind} retains original ordered input and raw storage`, async () => {
      const held = gate()
      let uploads = 0
      await pages(
        async (h) => {
          await h.act(async () => h.render('create'))
          const w = h.controllers[0],
            handler = h.handlers.get(selector(command)).onClick
          let pending
          await h.act(async () => {
            pending = handler({ stopPropagation() {} })
          })
          await configure(h, kind)
          const raw = clone([...h.storage.saved]),
            photos = clone(w.getSnapshot().photos),
            writes = h.storage.writes.length
          const text = w.getSnapshot().description
          await h.act(async () => {
            held.resolve([pick])
            await pending
          })
          await h.flush()
          assert.equal(uploads, 0)
          assert.deepEqual(clone([...h.storage.saved]), raw)
          assert.equal(h.storage.writes.length, writes)
          assert.deepEqual(clone(w.getSnapshot().photos), photos)
          assert.equal(w.getSnapshot().description, text)
          assert.equal(w.getSnapshot().controls.photoBatchBusy, false)
        },
        {
          ...options(command),
          photoPorts: {
            choose: () => held.promise,
            upload: async () => {
              uploads++
              return { id: 88 }
            },
          },
        }
      )
    })
  }
}
