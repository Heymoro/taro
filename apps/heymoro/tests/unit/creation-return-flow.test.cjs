const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withPages } = require('../fixtures/creation-pages.cjs')


for (const explicit of [false, true])
  test(`actual pages ${
    explicit ? 'ack return' : 'native back'
  } preserve controller and input, refresh source task only`, async () => {
    await withPages(async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      const controller = h.controllers[0]
      await h.act(async () => {
        controller.setDescription('keep this draft')
        await controller.prepareQuote()
      })
      const before = controller.getSnapshot(),
        writes = h.businessWrites.length,
        local = h.storageWrites.length
      await h.act(async () => h.click('create', '查看作品'))
      await h.act(async () => h.render('detail'))
      h.setFavorite(true)
      h.reads.length = 0
      await h.act(async () => {
        if (explicit) h.click('detail', '返回创作')
        else h.native.navigateBack({ success() {} })
      })
      await h.flush()
      assert.equal(h.controllers.length, 1)
      assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=66&returnTo=opener', 'back'])
      assert.ok(h.reads.some(([kind, id]) => kind === 'task' && id === 9))
      assert.equal(controller.getSnapshot().artifacts[66].isFavorite, true)
      assert.equal(controller.getSnapshot().description, before.description)
      assert.deepEqual(controller.getSnapshot().quote, before.quote)
      assert.equal(controller.getSnapshot().submission, before.submission)
      assert.equal(controller.getSnapshot().sourceArtifactId, before.sourceArtifactId)
      assert.equal(h.businessWrites.length, writes)
      assert.equal(h.storageWrites.length, local)
      assert.equal(document.querySelector('#create section').getAttribute('data-anchor'), '')
      assert.equal(h.listeners.get('creation:return:request').size, 0)
    })
  })

test('actual old RoundCard retry reads that task, not just latest history', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      h.setFailArtifact(false)
      h.reads.length = 0
      await h.act(async () => h.click('create', '重试'))
      assert.ok(h.reads.some(([kind, id]) => kind === 'task' && id === 9))
      assert.equal(
        h.reads.some(([kind]) => kind === 'tasks'),
        false
      )
      assert.equal(h.controllers[0].getSnapshot().artifacts[66].id, 66)
    },
    { missingOldArtifact: true }
  )
})

test('new creation route without session freezes actual workflow session at opening', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      await h.act(async () => {
        h.controllers[0].setDescription('new draft')
        await h.controllers[0].prepareQuote()
        await h.controllers[0].generate()
      })
      await h.act(async () => h.controllers[0].focusTask({ taskId: 9 }))
      await h.act(async () => h.click('create', '查看作品'))
      await h.act(async () => h.render('detail'))
      await h.act(async () => h.click('detail', '返回创作'))
      assert.equal(h.controllers.length, 1)
      assert.equal(h.controllers[0].getSnapshot().sessionId, 4)
      assert.equal(h.nativeCalls.at(-1), 'back')
    },
    { route: {} }
  )
})

test('fast native back before open success is consumed once only after navigation settles', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      await h.act(async () => h.click('create', '查看作品'))
      h.reads.length = 0
      await h.act(async () => h.native.navigateBack({ success() {} }))
      assert.equal(h.reads.filter(([kind]) => kind === 'task').length, 0)
      await h.act(async () => h.settleOpen())
      assert.equal(h.reads.filter(([kind]) => kind === 'task').length, 1)
      await h.act(async () => h.fire(h.createPage, 'show'))
      assert.equal(h.reads.filter(([kind]) => kind === 'task').length, 1)
    },
    { lateOpen: true }
  )
})

test('actual StrictMode page replay keeps return protocol live and disposes old channels', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      const count = h.controllers.length
      await h.act(async () => h.click('create', '查看作品'))
      await h.act(async () => h.render('detail'))
      await h.act(async () => h.click('detail', '返回创作'))
      assert.equal(h.nativeCalls.at(-1), 'back')
      assert.equal(h.controllers.length, count)
      assert.equal(h.listeners.get('creation:return:request').size, 0)
    },
    { strict: true }
  )
})

function gate() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

for (const order of ['show-before-restore', 'restore-while-hidden'])
  test(`real workflow route focus gates ${order} without first-frame end scroll`, async () => {
    const restoreGate = gate()
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        if (order === 'restore-while-hidden') await h.act(async () => h.fire(h.createPage, 'hide'))
        else await h.act(async () => h.fire(h.createPage, 'show'))
        assert.equal(h.reads.filter(([kind]) => kind === 'task').length, 0)
        await h.act(async () => restoreGate.resolve())
        if (order === 'restore-while-hidden') {
          assert.equal(h.reads.filter(([kind]) => kind === 'task').length, 0)
          await h.act(async () => h.fire(h.createPage, 'show'))
        }
        await h.flush()
        assert.equal(h.controllers.length, 1)
        assert.ok(h.reads.some(([kind, id]) => kind === 'task' && id === 9))
        assert.equal(h.anchors.includes('timeline-end'), false)
        assert.equal(h.anchors.at(-1), 'round-9')
        const reads = h.reads.length
        await h.act(async () => h.handlers.get('timeline').onScrollToUpper())
        assert.equal(h.reads.length, reads)
      },
      { route: { session: '4', focusTask: '9' }, restoreGate }
    )
  })

for (const action of ['touch', 'input'])
  test(`actual ${action} handler wins over late route-focus completion`, async () => {
    const taskGate = gate()
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        assert.ok(h.reads.some(([kind]) => kind === 'task'))
        await h.act(async () => {
          if (action === 'touch') h.handlers.get('timeline').onTouchMove()
          else
            h.handlers.get('composer__input').onInput({ detail: { value: 'explicit new input' } })
        })
        await h.act(async () => taskGate.resolve())
        await h.flush()
        assert.equal(h.anchors.includes('round-9'), false)
        assert.equal(h.anchors.includes('timeline-end'), false)
        if (action === 'input')
          assert.equal(h.controllers[0].getSnapshot().description, 'explicit new input')
        assert.equal(
          h.businessWrites.some(([kind]) => kind === 'generate' || kind === 'favorite'),
          false
        )
      },
      { route: { session: '4', focusTask: '9' }, taskGate }
    )
  })

function assertNeutralCreation() {
  assert.equal(!!document.querySelector('#create .creation-intro'), false)
  assert.equal(!!document.querySelector('#create .composer__input'), false)
  assert.equal(!!document.querySelector('#create .effect-notes'), false)
  assert.equal(document.querySelector('#create .composer__generate').disabled, true)
}

function assertNoNativePhotoAdd() {
  assert.equal(!!document.querySelector('#create .photo-add'), false)
  for (const button of document.querySelectorAll('#create button')) {
    if (button.textContent.includes('添加我的照片')) assert.equal(button.disabled, true)
  }
}

test('actual CreatePage restores effect input after configuration and session reads fail without falling to free', async () => {
  const { template } = require('../fixtures/creation.cjs')
  let fail = false
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      await h.act(async () => h.controllers[0].setUserNotes('retained effect notes'))
      const saved = h.storageWrites.filter(([key]) => key === 'session:4').at(-1)[1]
      assert.equal(saved.mode, 'effect')
      assert.equal(saved.photos.length, 2)
      await h.act(async () => h.unmountCreate())
      fail = true
      const writes = h.businessWrites.length
      await h.act(async () => h.render('create'))
      await h.flush()
      const state = h.controllers.at(-1).getSnapshot()
      assert.equal(state.mode, 'effect')
      assert.equal(state.template, null)
      assert.equal(state.session, null)
      assert.equal(state.userNotes, 'retained effect notes')
      assert.equal(state.photos.length, 2)
      assert.equal(document.querySelectorAll('#create .photo-tile').length, 2)
      assert.equal(document.querySelector('#create .references__count').textContent, '已选 2 张')
      assert.equal(!!document.querySelector('#create .creation-intro'), false)
      assert.equal(!!document.querySelector('#create .composer__input'), false)
      assert.ok(document.querySelector('#create .effect-notes'))
      assertNoNativePhotoAdd()
      assert.equal(h.businessWrites.length, writes)
    },
    {
      createApi: ({ ports }) => ({
        creationApi: {
          ...ports,
          getSession: async (args) => {
            if (fail) throw Error('NETWORK')
            return {
              ...(await ports.getSession(args)),
              mode: 'effect',
              draft: {
                updatedAt: '2026-11-13T00:00:00Z',
                input: { description: '', userNotes: '', inputMediaIds: [15, 16] }
              }
            }
          },
          template: async () => {
            if (fail) throw Error('NETWORK')
            return template('effect')
          },
          tasks: async () => ({ items: [], hasMore: false, nextCursor: null })
        }
      })
    }
  )
})

test('actual CreatePage valid template route stays effect while configuration is loading', async () => {
  const { template } = require('../fixtures/creation.cjs')
  const pending = gate()
  await withPages(
    async (h) => {
      try {
        await h.act(async () => h.render('create'))
        assert.equal(h.controllers[0].getSnapshot().template, null)
        assert.equal(!!document.querySelector('#create .creation-intro'), false)
        assert.equal(!!document.querySelector('#create .composer__input'), false)
        assert.ok(document.querySelector('#create .effect-notes'))
        assertNoNativePhotoAdd()
        assert.equal(h.businessWrites.length, 0)
      } finally {
        await h.act(async () => pending.resolve(template('effect')))
      }
      assert.ok(h.controllers[0].getSnapshot().template)
    },
    {
      route: { template: '1', version: '2' },
      createApi: ({ ports }) => ({ creationApi: { ...ports, template: () => pending.promise } })
    }
  )
})

for (const route of [{ session: '4' }, { source: '66' }, { carry: '66' }]) {
  test(`actual CreatePage unresolved resource route ${
    Object.keys(route)[0]
  } stays neutral`, async () => {
    const pending = gate()
    await withPages(
      async (h) => {
        try {
          await h.act(async () => h.render('create'))
          assertNeutralCreation()
          assertNoNativePhotoAdd()
          assert.equal(h.businessWrites.length, 0)
        } finally {
          await h.act(async () => pending.resolve())
        }
        await h.flush()
        assert.equal(h.controllers[0].getSnapshot().mode, null)
        assertNeutralCreation()
        assertNoNativePhotoAdd()
        assert.equal(h.businessWrites.length, 0)
      },
      {
        route,
        createApi: ({ ports }) => ({
          creationApi: {
            ...ports,
            getSession: async () => {
              await pending.promise
              throw Error('NETWORK')
            },
            freePreset: async () => {
              await pending.promise
              throw Error('NETWORK')
            }
          }
        })
      }
    )
  })
}

test('actual CreatePage ordinary new entry retains free intro and description', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      assert.ok(document.querySelector('#create .creation-intro'))
      assert.ok(document.querySelector('#create .composer__input'))
      assert.equal(!!document.querySelector('#create .effect-notes'), false)
      assert.equal(document.querySelector('#create .references__count').textContent, '选填')
      assert.equal(h.businessWrites.length, 0)
    },
    { route: {} }
  )
})

for (const route of [{ version: '0' }, { template: '1', version: 'old-bookmark' }]) {
  test(`legacy version bookmark is ignored without blocking the current creation mode ${JSON.stringify(route)}`, async () => {
    const { template } = require('../fixtures/creation.cjs')
    await withPages(async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      const state = h.controllers[0].getSnapshot()
      assert.equal(state.templateId, 1)
      assert.equal(state.mode, route.template ? 'effect' : 'free')
      assert.equal(Object.hasOwn(state, 'templateVersionId'), false)
      assert.equal(h.businessWrites.length, 0)
    }, { route, createApi: ({ ports }) => ({ creationApi: { ...ports, template: async () => template('effect') } }) })
  })
}

for (const route of [
  { session: '0' },
  { session: '-1' },
  { session: '1.5' },
  { session: 'bad' },
  { session: '' },
  { source: '9007199254740992' },
  { carry: 'bad' },
  { template: 'bad' }
]) {
  test(`actual CreatePage invalid resource route ${JSON.stringify(
    route
  )} stays neutral despite free config`, async () => {
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await h.flush()
        assertNeutralCreation()
        assert.equal(h.businessWrites.length, 0)
      },
      { route }
    )
  })
}

for (const sessionMode of ['effect', 'invalid']) {
  test(`actual CreatePage ${sessionMode} session with free config is neutral and retains history/input`, async () => {
    await withPages(
      async (h) => {
        await h.act(async () => h.render('create'))
        await h.flush()
        await h.act(async () => {
          h.controllers[0].setDescription('retained description')
          await h.controllers[0].prepareQuote()
        })
        const state = h.controllers[0].getSnapshot()
        assert.equal(state.template.mode, 'free')
        assert.equal(state.session.mode, sessionMode)
        assert.equal(state.controls.canGenerate, false, 'complete source guard blocks a mismatched session identity')
        assertNeutralCreation()
        assert.equal(state.description, 'retained description')
        assert.equal(state.rounds.length, 2)
        assert.equal(document.querySelectorAll('#create .generation').length, 2)
        const writes = h.businessWrites.length
        await h.act(async () => document.querySelector('#create .composer__generate').click())
        assert.equal(h.businessWrites.length, writes)
      },
      {
        createApi: ({ ports }) => ({
          creationApi: {
            ...ports,
            getSession: async (args) => ({ ...(await ports.getSession(args)), mode: sessionMode })
          }
        })
      }
    )
  })
}

// A valid version hint does not contradict the authoritative session mode.
test('actual CreatePage session plus valid version retains its known free mode', async () => {
  await withPages(
    async (h) => {
      await h.act(async () => h.render('create'))
      await h.flush()
      assert.equal(h.controllers[0].getSnapshot().session.mode, 'free')
      assert.ok(document.querySelector('#create .composer__input'))
      assert.equal(!!document.querySelector('#create .effect-notes'), false)
      assert.equal(h.businessWrites.length, 0)
    },
    { route: { session: '4', version: '2' } }
  )
})
