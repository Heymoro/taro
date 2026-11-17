const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const artifact = (extra = {}) => ({
  id: 66,
  mediaId: 90,
  sessionId: 4,
  taskId: 9,
  isFavorite: false,
  savedAt: null,
  ...extra
})

async function withDetail(run, { initialShow = false, strict = false, realAccount = false } = {}) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const events = { show: new Set(), hide: new Set() }
  let firstShow = initialShow
  const lifecycle = (event) => (callback) => {
    const latest = React.useRef(callback)
    latest.current = callback
    React.useLayoutEffect(() => {
      const call = () => latest.current()
      events[event].add(call)
      return () => events[event].delete(call)
    }, [])
  }
  let stored = { userId: 1, token: 'token-a', expiresAt: 'expiry-a' }
  const key = () => (stored ? `${stored.userId}:${stored.token}:${stored.expiresAt}` : '')
  let account = { user: { id: 1 }, accountKey: key() }
  let route = '66'
  let returnTo
  const channelListeners = new Map(), returnRequests = [], backs = []
  const channel = {
    on(name, fn) { if (!channelListeners.has(name)) channelListeners.set(name, new Set()); channelListeners.get(name).add(fn) },
    off(name, fn) { channelListeners.get(name)?.delete(fn) },
    emit(name, value) { if (name === 'creation:return:request') returnRequests.push(value); for (const fn of [...(channelListeners.get(name) || [])]) fn(value) }
  }
  const parentPage = {route: 'pages/create/index'}
  const nativePage = {route: 'pages/artifact/index', get options() {return {id: route}}, getOpenerEventChannel() {assert.equal(this, nativePage);return channel}}
  const requests = []
  const writes = []
  const downloads = []
  const nativeSaves = []
  const toasts = []
  const api = {
    artifact: (input) => {
      const job = deferred()
      requests.push({ ...job, input })
      return job.promise
    },
    favorite: (input) => {
      const job = deferred()
      writes.push({ ...job, input })
      return job.promise
    }
  }
  const taro = {
    useDidShow: lifecycle('show'),
    useDidHide: lifecycle('hide'),
    useRouter: () => ({ params: { id: route, returnTo } }),
    getCurrentInstance: () => ({page: nativePage}),
    getCurrentPages: () => [parentPage, nativePage],
    navigateBack(options) {backs.push(options);options.success({})},
    saveImageToPhotosAlbum: (input) => {
      const job = deferred()
      nativeSaves.push({ ...job, input })
      return job.promise
    },
    showToast: (input) => toasts.push(input),
    navigateTo() {}
  }
  const accountMock = { creationAccountKey: key, useAccount: () => account }
  const mocks = {
    '@tarojs/taro': taro,
    '../../creation-api': {
      creationApi: api,
      privateImage: (id) => {
        const job = deferred()
        downloads.push({ ...job, id })
        return job.promise
      }
    },
    './creation-api': { ensureCreationUser: async () => ({ id: stored.userId }) },
    './auth': { getStoredSession: () => stored },
    '../../components/primitives': {
      Brand: () => React.createElement('i', null, 'loading'),
      NavBar: () => null,
      Notice: ({ children, onRetry, label = '重试' }) =>
        React.createElement(
          'div',
          { className: 'notice' },
          children,
          onRetry && React.createElement('button', { onClick: onRetry }, label)
        )
    },
    '../../components/PrivateImage': ({ mediaId }) =>
      React.createElement('img', { 'data-media': mediaId }),
    '@tarojs/components': {
      View: ({ children, className }) => React.createElement('div', { className }, children),
      Button: ({ children, ...props }) => React.createElement('button', props, children)
    }
  }
  if (!realAccount) mocks['../../use-account'] = accountMock
  let current
  let Component
  const hook = () => {
    const { useArtifact } = load('src/features/artifact/use-artifact.js', mocks)
    Component = function Probe() {
      current = useArtifact({
        artifactId: Number(route),
        account,
        saveToAlbum: async (input) => {
          downloads.push(input)
        }
      })
      return null
    }
  }
  const returnHook = () => {
    const { useArtifactReturn } = load('src/features/artifact/use-artifact-return.js', mocks)
    Component = function ReturnProbe() {
      current = useArtifactReturn({account, artifactId:Number(route), item:artifact(), fromOpener:true})
      return null
    }
  }
  const page = () => {
    Component = load('src/pages/artifact/index.jsx', mocks).default
  }
  function Shell() {
    React.useLayoutEffect(() => {
      if (firstShow) {
        fire('show')
        firstShow = false
      }
    }, [])
    return React.createElement(Component)
  }
  const render = () =>
    root.render(
      strict
        ? React.createElement(React.StrictMode, null, React.createElement(Shell))
        : React.createElement(Shell)
    )
  const act = React.act
  const fire = (name) => {
    for (const call of [...events[name]]) call()
    if (name === 'show') firstShow = false
  }
  try {
    await run({
      act,
      hook,
      returnHook,
      page,
      channel,
      channelListeners,
      returnRequests,
      backs,
      setBackUnknown() { taro.navigateBack = options => backs.push(options) },
      setReturnTo(value) {returnTo = value},
      render,
      fire,
      requests,
      writes,
      downloads,
      nativeSaves,
      toasts,
      get current() {
        return current
      },
      setAccount(value) {
        account = value
      },
      account: () => account,
      key,
      setStored(value) {
        stored = value
      },
      setRoute(value) {
        route = value
      },
      unmount: () => root.unmount(),
      button: (text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    global.window = previous.window
    global.document = previous.document
    global.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
}

test('actual ArtifactPage and useAccount refresh stale favorite when page shows again', async () => {
  await withDetail(
    async (h) => {
      h.page()
      await h.act(async () => h.render())
      await h.act(async () => h.fire('show'))
      assert.equal(h.requests.length, 1)
      await h.act(async () => h.requests[0].resolve(artifact()))
      assert.ok(h.button('收藏'))
      await h.act(async () => {
        h.fire('hide')
        h.fire('show')
      })
      assert.equal(
        h.requests.length,
        2,
        're-show must request current artifact, not preserve stale favorite'
      )
      await h.act(async () =>
        h.requests[1].resolve(artifact({ isFavorite: true, savedAt: 'saved' }))
      )
      assert.ok(h.button('已收藏'))
      assert.equal(h.writes.length, 0)
    },
    { realAccount: true }
  )
})

for (const initialShow of [false, true]) {
  test(`initial show ${
    initialShow ? 'before' : 'after'
  } effect shares initial GET; later show refreshes`, async () => {
    await withDetail(
      async (h) => {
        h.hook()
        await h.act(async () => h.render())
        if (!initialShow) await h.act(async () => h.fire('show'))
        assert.equal(h.requests.length, 1)
        await h.act(async () => h.requests[0].resolve(artifact()))
        await h.act(async () => h.fire('show'))
        assert.equal(h.requests.length, 2)
        assert.equal(h.current.item.mediaId, 90)
        assert.equal(h.current.loading, false)
      },
      { initialShow }
    )
  })
}

test('show before account ready is completed by identity effect; no stale item without user', async () => {
  await withDetail(async (h) => {
    h.setAccount({ user: null, accountKey: h.key() })
    h.hook()
    await h.act(async () => {
      h.render()
    })
    await h.act(async () => h.fire('show'))
    assert.equal(h.requests.length, 0)
    h.setAccount({ user: { id: 1 }, accountKey: h.key() })
    await h.act(async () => h.render())
    assert.equal(h.requests.length, 1)
    await h.act(async () => h.requests[0].resolve(artifact()))
    h.setAccount({ user: null, accountKey: h.key() })
    await h.act(async () => h.render())
    assert.equal(h.current.item, null)
  })
})

test('StrictMode cleanup replay reads again, ignores disposed GET, and leaves no permanent loading', async () => {
  await withDetail(
    async (h) => {
      h.hook()
      await h.act(async () => h.render())
      assert.equal(h.requests.length, 2)
      await h.act(async () => h.requests[0].resolve(artifact({ mediaId: 1 })))
      assert.equal(h.current.item, null)
      await h.act(async () => h.requests[1].resolve(artifact()))
      assert.equal(h.current.item.mediaId, 90)
      assert.equal(h.current.loading, false)
    },
    { strict: true }
  )
})

test('hide/show invalidates the read started before hiding', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => h.fire('show'))
    await h.act(async () => {
      h.fire('hide')
      h.fire('show')
    })
    assert.equal(h.requests.length, 2)
    await h.act(async () => h.requests[1].resolve(artifact({ mediaId: 91 })))
    await h.act(async () => h.requests[0].resolve(artifact({ mediaId: 1 })))
    assert.equal(h.current.item.mediaId, 91)
  })
})

for (const isFavorite of [false, true]) {
  for (const oldFails of [false, true]) {
    test(`${isFavorite ? 'DELETE' : 'PUT'} favorite survives older GET ${
      oldFails ? 'failure' : 'metadata'
    } and merges repeated shows into one settle read`, async () => {
      await withDetail(async (h) => {
        h.hook()
        await h.act(async () => h.render())
        await h.act(async () => h.requests[0].resolve(artifact({ isFavorite })))
        await h.act(async () => {
          h.current.reload()
        })
        await h.act(async () => {
          h.current.toggleFavorite()
          h.current.toggleFavorite()
          h.current.download()
        })
        assert.equal(h.writes.length, 1)
        assert.equal(h.writes[0].input.isFavorite, !isFavorite)
        assert.equal(h.downloads.length, 0)
        await h.act(async () => {
          h.fire('show')
          h.fire('show')
          h.current.reload()
        })
        assert.equal(h.requests.length, 2)
        if (oldFails) await h.act(async () => h.requests[1].reject(Error('SERVER SECRET')))
        else await h.act(async () => h.requests[1].resolve(artifact({ mediaId: 95, isFavorite })))
        assert.equal(h.current.busy, true)
        assert.equal(h.current.error, '')
        await h.act(async () =>
          h.writes[0].resolve({
            isFavorite: !isFavorite,
            savedAt: !isFavorite ? 'new' : null,
            mediaId: 999
          })
        )
        assert.equal(h.current.item.isFavorite, !isFavorite)
        assert.equal(h.current.item.mediaId, oldFails ? 90 : 95)
        assert.equal(h.requests.length, 3)
        assert.equal(h.current.busy, false)
        await h.act(async () => h.requests[2].resolve(artifact({ isFavorite: !isFavorite })))
        assert.equal(h.current.item.isFavorite, !isFavorite)
      })
    })
  }
}

test('favorite response does not restore stale metadata; GET finishing after write preserves favorite', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => {
      h.current.reload()
      h.current.toggleFavorite()
    })
    await h.act(async () => h.writes[0].resolve({ isFavorite: true, savedAt: 'new' }))
    await h.act(async () => h.requests[1].resolve(artifact({ mediaId: 97 })))
    assert.equal(h.current.item.mediaId, 97)
    assert.equal(h.current.item.isFavorite, true)
    assert.equal(h.current.item.savedAt, 'new')
  })
})

test('unknown favorite result is reconciled by GET, never a repeated write; feedback stays controlled', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => {
      h.current.toggleFavorite()
    })
    await h.act(async () => h.writes[0].reject(Error('private server detail')))
    assert.equal(h.writes.length, 1)
    assert.equal(h.requests.length, 2)
    assert.equal(h.current.busy, false)
    assert.ok(h.current.error)
    assert.doesNotMatch(h.current.error, /private server detail/)
    await h.act(async () => h.requests[1].resolve(artifact({ isFavorite: true })))
    assert.equal(h.current.item.isFavorite, true)
    assert.equal(h.writes.length, 1)
  })
})

for (const change of ['user', 'token', 'expiry', 'route']) {
  test(`${change} change rejects old GET/action/finally without releasing new flight`, async () => {
    await withDetail(async (h) => {
      h.hook()
      await h.act(async () => h.render())
      await h.act(async () => h.requests[0].resolve(artifact()))
      await h.act(async () => {
        h.current.reload()
        h.current.toggleFavorite()
      })
      const oldToggle = h.current.toggleFavorite
      if (change === 'route') h.setRoute('67')
      else {
        h.setStored({
          userId: change === 'user' ? 2 : 1,
          token: change === 'token' ? 'token-b' : 'token-a',
          expiresAt: change === 'expiry' ? 'expiry-b' : 'expiry-a'
        })
        // Live storage alone invalidates entry points before account has rendered.
        await h.act(async () => {
          oldToggle()
        })
        assert.equal(h.writes.length, 1)
        h.setAccount({ user: { id: change === 'user' ? 2 : 1 }, accountKey: h.key() })
      }
      await h.act(async () => h.render())
      assert.equal(h.current.item, null)
      await h.act(async () =>
        h.requests[2].resolve(artifact({ id: change === 'route' ? 67 : 66, mediaId: 100 }))
      )
      await h.act(async () => {
        h.current.toggleFavorite()
      })
      assert.equal(h.writes.length, 2)
      await h.act(async () => {
        h.requests[1].resolve(artifact({ mediaId: 1 }))
        h.writes[0].resolve({ isFavorite: true, savedAt: 'old' })
      })
      assert.equal(h.current.busy, true)
      assert.equal(h.current.item.mediaId, 100)
      await h.act(async () => h.writes[1].resolve({ isFavorite: true, savedAt: 'new' }))
      assert.equal(h.current.busy, false)
      assert.equal(h.current.item.savedAt, 'new')
    })
  })
}

test('invalid route stays local; read failure retains item with retry; unmount suppresses work', async () => {
  await withDetail(async (h) => {
    h.setRoute('bad')
    h.hook()
    await h.act(async () => h.render())
    assert.equal(h.requests.length, 0)
    assert.ok(h.current.error)
    h.setRoute('66')
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => {
      h.current.reload()
    })
    await h.act(async () => h.requests[1].reject(Error('raw server')))
    assert.equal(h.current.item.mediaId, 90)
    assert.ok(h.current.error)
    assert.doesNotMatch(h.current.error, /raw server/)
    await h.act(async () => {
      h.current.reload()
    })
    await h.act(async () => h.requests[2].resolve(artifact({ mediaId: 92 })))
    assert.equal(h.current.error, '')
    await h.act(async () => {
      h.current.toggleFavorite()
      h.unmount()
    })
    await h.act(async () => h.writes[0].reject(Error('late')))
    assert.equal(h.requests.length, 3)
  })
})

for (const boundary of ['private', 'native']) {
  test(`native ${boundary} await checks storage ownership before save/toast`, async () => {
    await withDetail(async (h) => {
      h.page()
      await h.act(async () => h.render())
      await h.act(async () => h.requests[0].resolve(artifact()))
      await h.act(async () => {
        h.button('保存到相册').click()
        h.button('保存到相册').click()
      })
      assert.equal(h.downloads.length, 1)
      if (boundary === 'native') await h.act(async () => h.downloads[0].resolve('/private.png'))
      h.setStored({ userId: 1, token: 'changed', expiresAt: 'expiry-a' })
      await h.act(async () =>
        boundary === 'private' ? h.downloads[0].resolve('/private.png') : h.nativeSaves[0].resolve()
      )
      assert.equal(h.nativeSaves.length, boundary === 'native' ? 1 : 0)
      assert.equal(h.toasts.length, 0)
      assert.equal(h.writes.length, 0)
    })
  })
}

test('same-owner refresh does not cancel download and download never patches favorite', async () => {
  await withDetail(async (h) => {
    h.page()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => h.button('保存到相册').click())
    await h.act(async () => {
      h.fire('show')
      h.fire('show')
    })
    await h.act(async () => h.requests[1].resolve(artifact({ isFavorite: true })))
    await h.act(async () => h.downloads[0].resolve('/private.png'))
    await h.act(async () => h.nativeSaves[0].resolve())
    assert.equal(h.toasts.length, 1)
    assert.ok(h.button('已收藏'))
    assert.equal(h.writes.length, 0)
  })
})

test('album permission failure uses controlled feedback separate from favorite result', async () => {
  await withDetail(async (h) => {
    h.page()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => h.button('保存到相册').click())
    await h.act(async () => h.downloads[0].resolve('/private.png'))
    await h.act(async () =>
      h.nativeSaves[0].reject({ errMsg: 'permission auth deny private message' })
    )
    assert.match(document.body.textContent, /请在微信设置中允许保存到相册，再重试/)
    assert.doesNotMatch(document.body.textContent, /private message/)
    await h.act(async () => h.button('收藏').click())
    await h.act(async () => h.writes[0].resolve({ isFavorite: true, savedAt: 'saved' }))
    assert.ok(h.button('已收藏'))
    assert.match(document.body.textContent, /请在微信设置中允许保存到相册，再重试/)
  })
})

test('hide before first show still requires a fresh read instead of initial-show deduplication', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => {
      h.fire('hide')
      h.fire('show')
    })
    assert.equal(h.requests.length, 2)
    await h.act(async () => h.requests[0].resolve(artifact({ mediaId: 1 })))
    await h.act(async () => h.requests[1].resolve(artifact()))
    assert.equal(h.current.item.mediaId, 90)
  })
})

test('successful reconciliation clears favorite uncertainty without replaying a write', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => {
      h.current.toggleFavorite()
    })
    await h.act(async () => h.writes[0].reject(Error('timeout')))
    await h.act(async () => h.requests[1].resolve(artifact({ isFavorite: true })))
    assert.equal(h.current.error, '')
    assert.equal(h.writes.length, 1)
  })
})

test('StrictMode with first-show-before-effect still replaces the disposed initial read', async () => {
  await withDetail(
    async (h) => {
      h.hook()
      await h.act(async () => h.render())
      assert.equal(h.requests.length, 2)
      await h.act(async () => h.requests[1].resolve(artifact({ mediaId: 93 })))
      await h.act(async () => h.requests[0].resolve(artifact({ mediaId: 1 })))
      assert.equal(h.current.item.mediaId, 93)
      assert.equal(h.current.loading, false)
    },
    { strict: true, initialShow: true }
  )
})

for (const change of ['route', 'unmount', 'no-user']) {
  test(`native continuation after ${change} does not save or toast`, async () => {
    await withDetail(async (h) => {
      h.page()
      await h.act(async () => h.render())
      await h.act(async () => h.requests[0].resolve(artifact()))
      await h.act(async () => h.button('保存到相册').click())
      if (change === 'route') h.setRoute('67')
      if (change === 'no-user') h.setAccount({ user: null, accountKey: h.key() })
      await h.act(async () => (change === 'unmount' ? h.unmount() : h.render()))
      await h.act(async () => h.downloads[0].resolve('/private.png'))
      assert.equal(h.nativeSaves.length, 0)
      assert.equal(h.toasts.length, 0)
      assert.equal(h.writes.length, 0)
    })
  })
}

test('raw private image download failure maps to controlled album error and remains retryable', async () => {
  await withDetail(async (h) => {
    h.page()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => h.button('保存到相册').click())
    await h.act(async () => h.downloads[0].reject(Error('private server secret')))
    assert.match(document.body.textContent, /保存未完成，作品仍在收纳柜中/)
    assert.doesNotMatch(document.body.textContent, /private server secret/)
    await h.act(async () => h.button('保存到相册').click())
    assert.equal(h.downloads.length, 2)
    await h.act(async () => h.downloads[1].resolve('/private.png'))
    await h.act(async () => h.nativeSaves[0].resolve())
    assert.equal(h.toasts.length, 1)
    assert.ok(h.button('收藏'))
    assert.equal(h.writes.length, 0)
  })
})

test('handlers retained from an old route stay bound to that owner after new item loads', async () => {
  await withDetail(async (h) => {
    h.hook()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    const old = h.current
    h.setRoute('67')
    await h.act(async () => h.render())
    await h.act(async () => h.requests[1].resolve(artifact({ id: 67, mediaId: 100 })))
    await h.act(async () => {
      old.toggleFavorite()
      old.download()
      old.reload()
    })
    assert.equal(h.requests.length, 2)
    assert.equal(h.writes.length, 0)
    assert.equal(h.downloads.length, 0)
    assert.equal(h.current.item.id, 67)
    assert.equal(h.current.busy, false)
  })
})

for (const boundary of ['private', 'native']) {
  test(`album ${boundary} failure has no read retry; original save action remains available`, async () => {
    await withDetail(async (h) => {
      h.page()
      await h.act(async () => h.render())
      await h.act(async () => h.requests[0].resolve(artifact()))
      await h.act(async () => h.button('保存到相册').click())
      if (boundary === 'private') {
        await h.act(async () => h.downloads[0].reject(Error('download error')))
      } else {
        await h.act(async () => h.downloads[0].resolve('/private.png'))
        await h.act(async () => h.nativeSaves[0].reject({ errMsg: 'auth deny' }))
      }
      assert.equal(document.querySelectorAll('.notice button').length, 0)
      assert.equal(h.button('保存到相册').disabled, false)
      assert.equal(h.requests.length, 1)
      assert.equal(h.writes.length, 0)
    })
  })
}

test('invalid artifact route has no no-op retry button or remote request', async () => {
  await withDetail(async (h) => {
    h.setRoute('bad')
    h.page()
    await h.act(async () => h.render())
    assert.match(document.body.textContent, /作品链接无效/)
    assert.equal(document.querySelectorAll('.notice button').length, 0)
    assert.equal(h.requests.length, 0)
    assert.equal(h.writes.length, 0)
  })
})

for (const failure of ['read', 'favorite']) {
  test(`${failure} failure keeps an effective read-only retry action`, async () => {
    await withDetail(async (h) => {
      h.page()
      await h.act(async () => h.render())
      if (failure === 'favorite') {
        await h.act(async () => h.requests[0].resolve(artifact()))
        await h.act(async () => h.button('收藏').click())
        await h.act(async () => h.writes[0].reject(Error('unknown favorite outcome')))
      }
      await h.act(async () => h.requests.at(-1).reject(Error('read failed')))
      const count = h.requests.length
      const retry = document.querySelector('.notice button')
      assert.ok(retry)
      assert.equal(retry.textContent, '重试读取')
      await h.act(async () => retry.click())
      assert.equal(h.requests.length, count + 1)
      assert.equal(h.writes.length, failure === 'favorite' ? 1 : 0)
      await h.act(async () => h.requests.at(-1).resolve(artifact({ isFavorite: true })))
      assert.equal(document.querySelectorAll('.notice button').length, 0)
      assert.ok(h.button('已收藏'))
    })
  })
}


test('actual detail background hide cancels ack even when native stack still contains detail', async () => {
  await withDetail(async (h) => {
    h.setReturnTo('opener')
    h.page()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => h.button('返回创作').click())
    const first = h.returnRequests[0]
    assert.equal(h.channelListeners.get('creation:return:ack').size, 1)
    await h.act(async () => h.fire('hide'))
    assert.equal(h.channelListeners.get('creation:return:ack').size, 0)
    await h.act(async () => h.channel.emit('creation:return:ack', { ...first, accepted: true }))
    assert.equal(h.backs.length, 0)
    await h.act(async () => h.fire('show'))
    await h.act(async () => h.button('返回创作').click())
    const second = h.returnRequests.at(-1)
    await h.act(async () => h.channel.emit('creation:return:ack', { ...second, accepted: true }))
    assert.equal(h.backs.length, 1)
  })
})

test('retained old return handler cannot clear a new owner return error', async () => {
  await withDetail(async (h) => {
    h.returnHook()
    await h.act(async () => h.render())
    const old = h.current.returnToCreation
    h.setStored({ userId: 2, token: 'next-token', expiresAt: 'next-expiry' })
    h.setAccount({ user: { id: 2 }, accountKey: h.key() })
    await h.act(async () => h.render())
    await h.act(async () => h.current.returnToCreation())
    const request = h.returnRequests.at(-1)
    await h.act(async () => h.channel.emit('creation:return:ack', { ...request, accepted: false }))
    assert.ok(h.current.error)
    const error = h.current.error
    await h.act(async () => old())
    assert.equal(h.current.error, error)
  })
})

test('unknown return navigation keeps its controlled feedback on repeated actual button taps', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withDetail(async (h) => {
    h.page()
    await h.act(async () => h.render())
    await h.act(async () => h.requests[0].resolve(artifact()))
    await h.act(async () => h.button('返回创作').click())
    await h.act(async () => t.mock.timers.tick(5000))
    assert.match(document.body.textContent, /结果尚未确认/)
    const text = document.body.textContent
    assert.equal(h.button('返回创作').disabled, true)
    await h.act(async () => h.button('返回创作').click())
    assert.equal(document.body.textContent, text)
    assert.equal(h.button('重试返回创作'), undefined)
  })
  t.mock.timers.reset()
})

test('unknown raw return handler does not erase feedback or issue another navigation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withDetail(async (h) => {
    h.returnHook()
    h.setBackUnknown()
    await h.act(async () => h.render())
    await h.act(async () => h.current.returnToCreation())
    const request = h.returnRequests.at(-1)
    await h.act(async () => h.channel.emit('creation:return:ack', { ...request, accepted: true }))
    await h.act(async () => t.mock.timers.tick(5000))
    assert.match(h.current.error, /尚未确认/)
    assert.equal(h.current.busy, true)
    const error = h.current.error
    await h.act(async () => h.current.returnToCreation())
    assert.equal(h.current.error, error)
    assert.equal(h.backs.length, 1)
  })
  t.mock.timers.reset()
})

test('synchronous request emit failure remains visible and retryable in the real return hook', async () => {
  await withDetail(async (h) => {
    h.returnHook()
    await h.act(async () => h.render())
    h.channel.emit = () => {
      throw Error('CHANNEL_FAILED')
    }
    await h.act(async () => h.current.returnToCreation())
    assert.match(h.current.error, /返回通道未就绪/)
    assert.equal(h.current.busy, false)
    assert.equal(h.channelListeners.get('creation:return:ack').size, 0)
  })
})

test('detail read forwards live interest and retains a local uncertain warning with observed facts', async () => {
  await withDetail(async (h) => {
    h.hook(); await h.act(async () => h.render())
    assert.equal(h.requests[0].input.isInterested(), true)
    h.requests[0].input.onWarning('收藏状态仍待核对')
    await h.act(async () => h.requests[0].resolve(artifact()))
    assert.equal(h.current.item.isFavorite, false)
    assert.equal(h.current.error, '收藏状态仍待核对')
    assert.equal(h.current.canRetryRead, true)
    await h.act(async () => { h.current.reload() })
    const read = h.requests.at(-1)
    await h.act(async () => h.fire('hide'))
    assert.equal(read.input.isInterested(), false)
    read.input.onWarning('stale warning')
    await h.act(async () => read.resolve(artifact({ isFavorite: true })))
    assert.equal(h.current.error, '收藏状态仍待核对')
    assert.equal(h.current.item.isFavorite, false)
  })
})
