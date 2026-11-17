const { test } = require('node:test')
const assert = require('node:assert/strict')
const React = require('react')
const { load } = require('../source.cjs')

const componentFile = 'src/components/PrivateImage/index.jsx'
const componentExport = 'default'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function withImage(run) {
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
  const requests = []
  const invalidations = []
  const previews = []
  const layouts = []
  let token = 'token-a'
  let mounted = true
  let commits = 0
  const api = {
    privateImage(mediaId) {
      const job = deferred()
      requests.push({ ...job, mediaId })
      return job.promise
    },
    invalidatePrivateImage: (mediaId) => invalidations.push(mediaId)
  }
  const auth = { getStoredToken: () => token }
  const Image = load(componentFile, {
    '@tarojs/components': {
      View: ({ children, ...props }) => React.createElement('div', props, children),
      Text: ({ children }) => React.createElement('span', null, children),
      Image: ({ mode, ...props }) => React.createElement('img', { ...props, 'data-mode': mode })
    },
    '@tarojs/taro': { previewImage: (input) => previews.push(input) },
    '../../auth': auth,
    '../../creation-api': api
  })[componentExport]
  function Probe(props) {
    React.useLayoutEffect(() => {
      layouts.push(document.querySelector('img')?.getAttribute('src') || '')
    })
    return React.createElement(Image, props)
  }
  const act = React.act
  const render = (props = {}) =>
    root.render(
      React.createElement(
        React.Profiler,
        { id: 'private-image', onRender: () => commits++ },
        React.createElement(Probe, { mediaId: 90, accountKey: 'owner-a', ...props })
      )
    )
  const unmount = async () => {
    await act(async () => root.unmount())
    mounted = false
  }
  try {
    await run({
      act,
      render,
      unmount,
      requests,
      invalidations,
      previews,
      layouts,
      setToken: (value) => (token = value),
      commits: () => commits,
      container: document.getElementById('root'),
      click: (element) =>
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
      imageError: () => document.querySelector('img').dispatchEvent(new dom.window.Event('error'))
    })
  } finally {
    if (mounted) await unmount()
    dom.window.close()
    global.window = previous.window
    global.document = previous.document
    global.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
}

for (const change of ['token', 'accountKey', 'mediaId']) {
  test(`PrivateImage hides a loaded image immediately when ${change} changes`, async () => {
    await withImage(async ({ act, render, requests, setToken, container, layouts }) => {
      await act(async () => render())
      await act(async () => requests[0].resolve('/old.png'))
      assert.equal(container.querySelector('img').getAttribute('src'), '/old.png')
      if (change === 'token') setToken('token-b')
      await act(async () =>
        render(change === 'token' ? {} : { [change]: change === 'mediaId' ? 91 : 'owner-b' })
      )
      assert.equal(
        layouts.at(-1),
        '',
        'the first layout must not expose the previous identity image'
      )
      assert.equal(container.querySelector('img'), null)
      assert.match(container.textContent, /图片加载中/)
      assert.equal(requests.length, 2)
      assert.equal(requests[1].mediaId, change === 'mediaId' ? 91 : 90)
      await act(async () => requests[1].resolve('/new.png'))
      assert.equal(container.querySelector('img').getAttribute('src'), '/new.png')
    })
  })
}

for (const outcome of ['resolve', 'reject']) {
  test(`PrivateImage ignores a previous identity download ${outcome}`, async () => {
    await withImage(async ({ act, render, requests, setToken, container }) => {
      await act(async () => render())
      setToken('token-b')
      await act(async () => render())
      await act(async () => requests[1].resolve('/current.png'))
      await act(async () =>
        requests[0][outcome](outcome === 'resolve' ? '/stale.png' : Error('old failure'))
      )
      assert.equal(container.querySelector('img').getAttribute('src'), '/current.png')
      assert.doesNotMatch(container.textContent, /失败/)
      assert.equal(requests.length, 2)
    })
  })

  test(`PrivateImage ignores a download ${outcome} after unmount`, async () => {
    await withImage(async ({ act, render, unmount, requests, container, commits }) => {
      await act(async () => render())
      await unmount()
      const before = commits()
      await act(async () =>
        requests[0][outcome](outcome === 'resolve' ? '/late.png' : Error('late failure'))
      )
      assert.equal(container.innerHTML, '')
      assert.equal(commits(), before)
      assert.equal(requests.length, 1)
    })
  })
}

test('PrivateImage retries failed downloads only on the placeholder click', async () => {
  await withImage(async ({ act, render, requests, container, click, invalidations }) => {
    await act(async () => render({ className: 'private-thumb' }))
    const placeholder = () => container.querySelector('.image-loading')
    assert.ok(placeholder().classList.contains('private-thumb'))
    await act(async () => click(placeholder()))
    assert.equal(requests.length, 1)
    await act(async () => requests[0].reject(Error('download failed')))
    assert.match(placeholder().textContent, /图片加载失败 · 点此重试/)
    await act(async () => click(placeholder()))
    assert.equal(requests.length, 2)
    assert.match(placeholder().textContent, /图片加载中/)
    await act(async () => requests[1].resolve('/retried.png'))
    assert.equal(container.querySelector('img').getAttribute('src'), '/retried.png')
    assert.deepEqual(invalidations, [])
  })
})

test('PrivateImage invalidates the existing media cache on image error and retries through the same API', async () => {
  await withImage(
    async ({ act, render, requests, container, imageError, invalidations, click }) => {
      await act(async () => render({ mediaId: 91 }))
      await act(async () => requests[0].resolve('/broken.png'))
      await act(async () => imageError())
      assert.deepEqual(invalidations, [91])
      assert.equal(container.querySelector('img'), null)
      assert.match(container.textContent, /图片加载失败 · 点此重试/)
      assert.equal(requests.length, 1)
      await act(async () => click(container.querySelector('.image-loading')))
      assert.equal(requests[1].mediaId, 91)
      await act(async () => requests[1].resolve('/reloaded.png'))
      assert.equal(container.querySelector('img').getAttribute('src'), '/reloaded.png')
    }
  )
})

test('PrivateImage preserves mode/class props and previews the downloaded path by default', async () => {
  await withImage(async ({ act, render, requests, container, previews, click }) => {
    await act(async () => render({ className: 'artifact-image' }))
    await act(async () => requests[0].resolve('/preview.png'))
    const image = container.querySelector('img')
    assert.equal(image.className, 'artifact-image')
    assert.equal(image.getAttribute('data-mode'), 'aspectFill')
    await act(async () => click(image))
    assert.equal(previews.length, 1)
    assert.deepEqual(Array.from(previews[0].urls), ['/preview.png'])
    assert.equal(previews[0].current, '/preview.png')
  })
})

test('PrivateImage custom click receives the downloaded path instead of opening native preview', async () => {
  await withImage(async ({ act, render, requests, container, previews, click }) => {
    const paths = []
    await act(async () => render({ mode: 'aspectFit', onClick: (path) => paths.push(path) }))
    await act(async () => requests[0].resolve('/custom.png'))
    assert.equal(container.querySelector('img').getAttribute('data-mode'), 'aspectFit')
    await act(async () => click(container.querySelector('img')))
    assert.deepEqual(paths, ['/custom.png'])
    assert.deepEqual(previews, [])
  })
})

function moduleStatements(file) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { parseSync } = require('@babel/core')
  const filename = path.resolve(__dirname, '../..', file)
  assert.ok(fs.existsSync(filename), `shared component module must exist: ${file}`)
  return parseSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['jsx'] }
  }).program.body
}

test('PrivateImage belongs to a shared module with one default export', () => {
  const exports = moduleStatements('src/components/PrivateImage/index.jsx').filter((node) =>
    node.type.startsWith('Export')
  )
  assert.equal(exports.length, 1)
  assert.equal(exports[0].type, 'ExportDefaultDeclaration')
  assert.equal(exports[0].declaration.id.name, 'PrivateImage')
})

test('all four consumers import PrivateImage directly from the shared module', () => {
  for (const [file, source] of [
    ['src/pages/artifact/index.jsx', '../../components/PrivateImage'],
    ['src/pages/cabinet/index.jsx', '../../components/PrivateImage'],
    ['src/pages/sessions/index.jsx', '../../components/PrivateImage'],
    ['src/features/creation/RoundCard/index.jsx', '../../../components/PrivateImage']
  ]) {
    const imports = moduleStatements(file).filter((node) => node.type === 'ImportDeclaration')
    const direct = imports.find((node) => node.source.value === source)
    assert.ok(direct, `${file} must import the shared module directly`)
    assert.equal(direct.specifiers.length, 1)
    assert.equal(direct.specifiers[0].type, 'ImportDefaultSpecifier')
    assert.equal(direct.specifiers[0].local.name, 'PrivateImage')
    for (const statement of imports.filter((node) => node.source.value.endsWith('/primitives'))) {
      assert.ok(statement.specifiers.every((specifier) => specifier.local.name !== 'PrivateImage'))
    }
  }
})

test('primitives no longer owns private image identity, downloads or re-exports', () => {
  const statements = moduleStatements('src/components/primitives.jsx')
  const imports = statements.filter((node) => node.type === 'ImportDeclaration')
  assert.ok(imports.every((node) => !node.source.value.endsWith('/auth')))
  const api = imports.find((node) => node.source.value.endsWith('/creation-api'))
  assert.deepEqual(
    api.specifiers.map((specifier) => specifier.imported.name),
    ['officialImage', 'sharedSessionCover']
  )
  const exports = statements.filter((node) => node.type.startsWith('Export'))
  assert.ok(exports.every((node) => !node.source && node.declaration?.id?.name !== 'PrivateImage'))
  assert.ok(exports.some((node) => node.declaration?.id?.name === 'OfficialImage'))
  assert.ok(exports.some((node) => node.declaration?.id?.name === 'openTemplate'))
})
