const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const React = require('react')
const { load } = require('../source.cjs')

// Real React effects/state; only the native event and geometry boundary is simulated.
async function withViewport({ run, initialInfo, initialRect, defer = false, initialScheduleError = false }) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const previous = { window: global.window, document: global.document, act: global.IS_REACT_ACT_ENVIRONMENT }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const page = { route: 'pages/create/index' }
  let owner = page
  let pages = [page]
  let info = initialInfo || { windowHeight: 762, windowWidth: 390 }
  let rect = initialRect === undefined ? rectangle({ height: 844 }) : initialRect
  let viewport,
    show,
    hide,
    unmounted = false
  const callbacks = { keyboard: [], resize: [] }
  const removals = { keyboard: [], resize: [] }
  const queries = []
  const pending = []
  const closeRequests = []
  const ticks = []
  let deferTicks = false
  let schedulingError = initialScheduleError
  let queueBeforeError = false
  const taro = {
    useDidShow(fn) {
      show = fn
    },
    useDidHide(fn) {
      hide = fn
    },
    getCurrentInstance: () => ({ page: owner }),
    getCurrentPages: () => pages,
    getWindowInfo: () => ({ ...info }),
    nextTick: (fn) => {
      if (schedulingError) {
        if (queueBeforeError) ticks.push(fn)
        throw new Error('native scheduling failed')
      }
      return deferTicks ? ticks.push(fn) : fn()
    },
    hideKeyboard: (request) => closeRequests.push(request),
    onKeyboardHeightChange: (fn) => callbacks.keyboard.push(fn),
    offKeyboardHeightChange: (fn) => removals.keyboard.push(fn),
    onWindowResize: (fn) => callbacks.resize.push(fn),
    offWindowResize: (fn) => removals.resize.push(fn),
    createSelectorQuery() {
      const request = { page: null, selector: null }
      queries.push(request)
      const query = {
        in(value) {
          request.page = value
          return query
        },
        select(value) {
          request.selector = value
          return query
        },
        boundingClientRect() {
          return query
        },
        exec(fn) {
          const respond = () => fn([rect])
          if (defer) pending.push(respond)
          else respond()
        },
      }
      return query
    },
  }
  const { useViewport } = load('src/use-viewport.js', { '@tarojs/taro': taro })
  function Probe() {
    viewport = useViewport()
    return React.createElement('div', { style: viewport.style })
  }
  const act = React.act
  const api = {
    get viewport() {
      return viewport
    },
    page,
    queries,
    callbacks,
    removals,
    pending,
    closeRequests,
    deferTicks() {
      deferTicks = true
    },
    failScheduling({ queue = false } = {}) {
      schedulingError = true
      queueBeforeError = queue
    },
    restoreScheduling() {
      schedulingError = false
      queueBeforeError = false
    },
    flushTicks: async () => act(async () => ticks.splice(0).forEach((fn) => fn())),
    act: async (fn) => act(fn),
    focus: async (height) => act(async () => viewport.onFocus(height === undefined ? {} : { detail: { height } })),
    blur: async () => act(async () => viewport.onBlur()),
    keyboard: async (height, local = false) =>
      act(async () =>
        local ? viewport.onKeyboardHeightChange({ detail: { height } }) : callbacks.keyboard[0]({ height })
      ),
    resize: async (height, width = 390) =>
      act(async () => {
        info = { windowHeight: height, windowWidth: width }
        callbacks.resize[0]({ size: info })
      }),
    hide: async () => act(async () => hide()),
    show: async () => act(async () => show()),
    setInfo(value) {
      info = value
    },
    setRect(value) {
      rect = value
    },
    setPage(value) {
      owner = value
      pages = [value]
    },
    setPages(value) {
      pages = value
    },
    flush: async () =>
      act(async () => {
        pending.splice(0).forEach((fn) => fn())
      }),
    unmount: async () => {
      await act(async () => root.unmount())
      unmounted = true
    },
  }
  try {
    await act(async () => root.render(React.createElement(Probe)))
    await run(api)
  } finally {
    if (!unmounted) await act(async () => root.unmount())
    dom.window.close()
    global.window = previous.window
    global.document = previous.document
    global.IS_REACT_ACT_ENVIRONMENT = previous.act
  }
}

function rectangle({ height, width = 390 }) {
  return { top: 0, left: 0, right: width, bottom: height, width, height }
}
function natural(viewport) {
  assert.equal(viewport.style.height, undefined)
}

test('no keyboard leaves CSS natural despite SDK762 versus independent rect844', async () => {
  await withViewport({
    run: async (v) => {
      natural(v.viewport)
      assert.equal(v.queries.length, 1)
      assert.equal(v.queries[0].page, v.page)
      assert.equal(v.queries[0].selector, '#creation-viewport-probe')
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

for (const first of ['resize', 'keyboard']) {
  test(`focus cycle uses max overlap, ${first} first, global/local duplicates do not double deduct`, async () => {
    await withViewport({
      run: async (v) => {
        await v.focus()
        if (first === 'resize') {
          await v.resize(462)
          assert.equal(v.viewport.style.height, '544px')
          await v.keyboard(300)
        } else {
          await v.keyboard(300)
          await v.resize(462)
        }
        await v.keyboard(300, true)
        await v.keyboard(300)
        await v.resize(462)
        assert.equal(v.viewport.style.height, '544px')
        await v.keyboard(250, true)
        assert.equal(v.viewport.style.height, '544px')
        assert.equal(v.callbacks.keyboard.length, 1)
        assert.equal(v.callbacks.resize.length, 1)
      },
    })
  })
}

test('SDK844 case preserves the existing 544 assertion and never adds keyboard and resize', async () => {
  await withViewport({
    initialInfo: { windowHeight: 844, windowWidth: 390 },
    run: async (v) => {
      await v.focus()
      await v.resize(544)
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('blur is not keyboard closure; transfer focus keeps the frozen pair until height zero', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      await v.keyboard(300, true)
      await v.blur()
      assert.equal(v.viewport.keyboard, 300)
      assert.equal(v.viewport.style.height, '544px')
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
      await v.keyboard(0, true)
      natural(v.viewport)
      await v.blur()
      natural(v.viewport)
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('zero before blur and delayed native restore return natural CSS without waiting for an old SDK height', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      await v.resize(462)
      await v.keyboard(300)
      await v.keyboard(0)
      natural(v.viewport)
      await v.blur()
      natural(v.viewport)
      await v.resize(762)
      await v.keyboard(0)
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('hide invalidates geometry and blocks both event paths; show remeasures album return', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      await v.keyboard(300)
      await v.hide()
      natural(v.viewport)
      assert.equal(v.viewport.keyboard, 0)
      await v.keyboard(400)
      await v.keyboard(400, true)
      await v.resize(362)
      natural(v.viewport)
      assert.equal(v.viewport.keyboard, 0)
      // The visible host is restored when returning from the album.
      await v.resize(762)
      await v.show()
      natural(v.viewport)
      await v.focus()
      await v.keyboard(300)
      natural(v.viewport)
      await v.keyboard(0)
      await v.blur()
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('outside-focus same-width real shrink discards the pair then remeasures the new CSS viewport', async () => {
  await withViewport({
    run: async (v) => {
      v.setRect(rectangle({ height: 744 }))
      await v.resize(662)
      natural(v.viewport)
      await v.keyboard(0)
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '444px')
    },
  })
})

test('ambiguous resize before focus never revives an invalid pair when keyboard arrives late', async () => {
  await withViewport({
    run: async (v) => {
      await v.resize(462)
      natural(v.viewport)
      await v.focus()
      await v.keyboard(300)
      natural(v.viewport)
      await v.keyboard(0)
      await v.blur()
      await v.resize(762)
      await v.keyboard(0)
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('rotation while editing falls back and only closed stable geometry can establish a new pair', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      await v.keyboard(300)
      v.setRect(rectangle({ height: 390, width: 844 }))
      await v.resize(308, 844)
      natural(v.viewport)
      await v.keyboard(200)
      natural(v.viewport)
      await v.blur()
      natural(v.viewport)
      await v.keyboard(0)
      natural(v.viewport)
      await v.focus()
      await v.keyboard(100)
      assert.equal(v.viewport.style.height, '290px')
    },
  })
})

for (const invalid of [
  null,
  {},
  rectangle({ height: 0 }),
  rectangle({ height: NaN }),
  { ...rectangle({ height: 844 }), bottom: 700 },
  { ...rectangle({ height: 844 }), top: 30 },
  rectangle({ height: 844, width: 0 }),
  rectangle({ height: 844, width: 400 }),
]) {
  test(`unknown or malformed independent geometry falls back (${JSON.stringify(invalid)})`, async () => {
    await withViewport({
      initialRect: invalid,
      run: async (v) => {
        natural(v.viewport)
        await v.focus()
        await v.keyboard(300)
        natural(v.viewport)
      },
    })
  })
}

test('nonpositive or malformed occlusion cannot manufacture a 240px visible floor', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      await v.keyboard(900)
      natural(v.viewport)
      await v.keyboard('300')
      natural(v.viewport)
      await v.keyboard(NaN)
      natural(v.viewport)
      await v.keyboard(0)
      natural(v.viewport)
    },
  })
})

test('focus before delayed initial measurement leaves no trustworthy keyboard-free pair', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.focus()
      await v.keyboard(300)
      await v.flush()
      natural(v.viewport)
    },
  })
})

test('query crossing resize or hide is discarded, including an old response after show', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      const old = v.pending.shift()
      v.setRect(rectangle({ height: 744 }))
      await v.resize(662)
      await v.focus()
      await v.act(async () => old())
      await v.keyboard(300)
      natural(v.viewport)
      await v.hide()
      await v.show()
      await v.focus()
      await v.flush()
      await v.keyboard(300)
      natural(v.viewport)
    },
  })
})

test('foreground ownership gates events and delayed queries, even for another create route', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      v.setPages([v.page, { route: 'pages/create/index' }])
      await v.flush()
      await v.focus()
      await v.keyboard(300)
      assert.equal(v.viewport.keyboard, 0)
      natural(v.viewport)
      v.setPage({ route: 'pages/create/index' })
      await v.show()
      await v.flush()
      await v.keyboard(300, true)
      assert.equal(v.viewport.keyboard, 0)
      natural(v.viewport)
    },
  })
})

test('unmount pairs stable subscriptions and invalidates native listeners plus late queries', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.unmount()
      assert.equal(v.removals.keyboard.length, 1)
      assert.equal(v.removals.resize.length, 1)
      assert.equal(v.removals.keyboard[0], v.callbacks.keyboard[0])
      assert.equal(v.removals.resize[0], v.callbacks.resize[0])
      await v.flush()
      await v.keyboard(300)
      await v.keyboard(300, true)
      natural(v.viewport)
      assert.equal(v.viewport.keyboard, 0)
    },
  })
})

test('page probe is a screen sibling, native inputs actually forward the shared focus handler', () => {
  const { parseSync: parse, traverse } = require('@babel/core')
  const page = parse(fs.readFileSync('src/pages/create/index.jsx', 'utf8'), {
    babelrc: false,
    configFile: false,
    parserOpts: { sourceType: 'module', plugins: ['jsx'] },
  })
  let probe, screen
  const wired = []
  traverse(page, {
    JSXElement(path) {
      const opening = path.node.openingElement
      const attributes = opening.attributes
      if (attributes.some((a) => a.name?.name === 'id' && a.value?.value === 'creation-viewport-probe')) probe = path
      if (attributes.some((a) => a.name?.name === 'className' && a.value?.value === 'screen create-screen'))
        screen = path
      if (['CreationComposer', 'EffectNotes'].includes(opening.name.name)) {
        const focus = attributes.find((a) => a.name?.name === 'onFocus')
        const expression = focus?.value?.expression
        if (opening.name.name === 'CreationComposer') {
          assert.equal(expression?.object?.name, 'viewport')
          assert.equal(expression?.property?.name, 'onFocus')
        } else {
          assert.equal(expression?.type, 'ArrowFunctionExpression')
          const event = expression.params[0]?.name
          assert.ok(event)
          assert.ok(expression.body.body.some((statement) => {
            const call = statement.expression
            return ['CallExpression', 'OptionalCallExpression'].includes(call?.type) &&
              call.callee?.object?.name === 'viewport' && call.callee?.property?.name === 'onFocus' &&
              call.arguments.length === 1 && call.arguments[0]?.name === event
          }), 'notes wrapper must forward its actual focus event to the shared viewport handler')
        }
        const keyboard = attributes.find((a) => a.name?.name === 'onKeyboardHeightChange')
        assert.equal(keyboard?.value?.expression?.object?.name, 'viewport')
        assert.equal(keyboard?.value?.expression?.property?.name, 'onKeyboardHeightChange')
        wired.push(opening.name.name)
      }
    },
  })
  assert.ok(probe)
  assert.ok(screen)
  assert.equal(probe.parentPath.node.type, 'JSXFragment')
  assert.equal(probe.parentPath.node, screen.parentPath.node)
  assert.equal(wired.length, 2)
  for (const file of ['CreationComposer', 'EffectNotes']) {
    let forwarded = false
    traverse(
      parse(fs.readFileSync(`src/features/creation/${file}/index.jsx`, 'utf8'), {
        babelrc: false,
        configFile: false,
        parserOpts: { sourceType: 'module', plugins: ['jsx'] },
      }),
      {
        JSXOpeningElement(path) {
          if (path.node.name.name !== 'CreationTextarea') return
          forwarded = path.node.attributes.some(
            (a) => a.name?.name === 'onFocus' && a.value?.expression?.name === 'onFocus'
          )
        },
      }
    )
    assert.ok(forwarded, file)
  }
  const css = fs.readFileSync('src/app.scss', 'utf8')
  const rule = css.match(/\.creation-viewport-probe\s*\{([^}]+)\}/)?.[1]
  assert.ok(rule)
  for (const declaration of [
    /position:\s*fixed/,
    /height:\s*100vh/,
    /width:\s*100vw/,
    /visibility:\s*hidden/,
    /pointer-events:\s*none/,
    /top:\s*0/,
    /left:\s*0/,
  ])
    assert.match(rule, declaration)
})

test('native focus positive height uses the same overlap cycle before duplicate global/local events', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      assert.equal(v.viewport.keyboard, 300)
      assert.equal(v.viewport.style.height, '544px')
      await v.keyboard(300)
      await v.keyboard(300, true)
      await v.resize(462)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('changed independent probe during a focus cycle invalidates the pair instead of assuming occlusion', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus()
      v.setRect(rectangle({ height: 744 }))
      await v.resize(662)
      natural(v.viewport)
      await v.keyboard(300)
      natural(v.viewport)
      await v.keyboard(0)
      await v.blur()
      await v.focus(200)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('known closed album hide/show makes a fresh pair before the first input, without requiring a missing zero event', async () => {
  await withViewport({
    run: async (v) => {
      const count = v.queries.length
      await v.hide()
      await v.show()
      natural(v.viewport)
      assert.equal(v.queries.length, count + 1)
      await v.focus(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('probe verification crossing a keyboard callback is replaced, never leaving a changed rect paired', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.flush()
      await v.focus()
      v.setRect(rectangle({ height: 744 }))
      await v.resize(662)
      await v.keyboard(300)
      await v.flush()
      natural(v.viewport)
    },
  })
})

for (const first of ['success', 'zero']) {
  test(`uncertain album return closes through native hideKeyboard handshake, ${first} first`, async () => {
    await withViewport({
      run: async (v) => {
        await v.focus(300)
        await v.hide()
        await v.show()
        assert.equal(v.closeRequests.length, 1)
        if (first === 'success') {
          await v.act(async () => v.closeRequests[0].success())
          await v.focus(300)
          assert.equal(v.viewport.style.height, '544px')
          await v.blur()
          // A new owned return starts a new close handshake.
          await v.hide()
          await v.show()
          await v.act(async () => v.closeRequests[1].success())
          await v.keyboard(0)
        } else {
          await v.keyboard(0)
          await v.act(async () => v.closeRequests[0].success())
        }
        await v.focus(300)
        assert.equal(v.viewport.style.height, '544px')
      },
    })
  })
}

test('hideKeyboard failure stays unknown', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      await v.show()
      assert.equal(v.closeRequests.length, 1)
      await v.act(async () => v.closeRequests[0].fail())
      await v.focus(300)
      natural(v.viewport)
    },
  })
})

test('new focus preempts hideKeyboard completion and old page callbacks never re-pair', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      await v.show()
      assert.equal(v.closeRequests.length, 1)
      await v.focus(200)
      await v.act(async () => v.closeRequests[0].success())
      assert.equal(v.viewport.keyboard, 200)
      natural(v.viewport)
      await v.hide()
      await v.show()
      v.setPage({ route: 'pages/create/index' })
      await v.act(async () => v.closeRequests[1].success())
      await v.keyboard(0)
      natural(v.viewport)
      assert.equal(v.viewport.keyboard, 0)
    },
  })
})

test('hideKeyboard success without another zero can re-pair two stable independent native samples', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      await v.show()
      await v.act(async () => v.closeRequests[0].success())
      await v.focus(300)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('hide success samples that still change stay natural rather than guessing animation completion', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.flush()
      await v.focus(300)
      await v.flush()
      await v.hide()
      await v.show()
      await v.act(async () => v.closeRequests[0].success())
      await v.flush()
      v.setRect(rectangle({ height: 744 }))
      await v.flush()
      await v.focus(200)
      natural(v.viewport)
    },
  })
})

test('new focus before deferred hide request prevents dispatch to the newly active input', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      v.deferTicks()
      await v.show()
      await v.focus(200)
      await v.flushTicks()
      assert.equal(v.closeRequests.length, 0)
      natural(v.viewport)
    },
  })
})

test('a stale pre-hide callback cannot pair after a new visible epoch has started', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      const old = v.pending.shift()
      await v.hide()
      await v.show()
      assert.equal(v.pending.length, 1)
      await v.act(async () => old())
      await v.focus(300)
      await v.flush()
      natural(v.viewport)
    },
  })
})

test('focus between closing samples cancels the second read and preserves the new keyboard state', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.flush()
      await v.focus(300)
      await v.flush()
      await v.hide()
      await v.show()
      await v.act(async () => v.closeRequests[0].success())
      await v.flush()
      await v.focus(200)
      await v.flush()
      assert.equal(v.viewport.keyboard, 200)
      natural(v.viewport)
    },
  })
})

test('native closing callbacks after unmount cannot update or issue geometry reads', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      await v.show()
      const before = v.queries.length
      await v.unmount()
      await v.act(async () => v.closeRequests[0].success())
      assert.equal(v.queries.length, before)
    },
  })
})

test('a valid small visible target is not inflated to a fictitious 240px minimum', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(744)
      assert.equal(v.viewport.style.height, '100px')
    },
  })
})

for (const info of [
  { windowHeight: 0, windowWidth: 390 },
  { windowHeight: 762, windowWidth: NaN },
  { windowHeight: '762', windowWidth: 390 },
]) {
  test(`invalid SDK geometry leaves the independent rect unpaired (${JSON.stringify(info)})`, async () => {
    await withViewport({
      initialInfo: info,
      run: async (v) => {
        await v.focus(300)
        natural(v.viewport)
      },
    })
  })
}

test('a changed SDK read during a cycle query invalidates geometry instead of retaining an unpaired height', async () => {
  await withViewport({
    defer: true,
    run: async (v) => {
      await v.flush()
      await v.focus(300)
      v.setInfo({ windowHeight: 500, windowWidth: 390 })
      await v.flush()
      natural(v.viewport)
    },
  })
})

for (const local of [false, true]) {
  for (const first of ['keyboard', 'resize']) {
    test(`still-focused input reopens from a fresh zero pair: ${
      local ? 'local' : 'global'
    } positive, ${first} first`, async () => {
      await withViewport({
        run: async (v) => {
          await v.focus(300)
          assert.equal(v.viewport.style.height, '544px')
          await v.keyboard(0, !local)
          natural(v.viewport)
          if (first === 'resize') {
            await v.resize(462)
            assert.equal(v.viewport.style.height, '544px')
            await v.keyboard(300, local)
          } else {
            await v.keyboard(300, local)
            assert.equal(v.viewport.style.height, '544px')
            await v.resize(462)
          }
          await v.keyboard(300, !local)
          assert.equal(v.viewport.style.height, '544px')
        },
      })
    })
  }
}

test('focused height zero re-pairs current geometry rather than reviving the previous opening pair', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      v.setRect(rectangle({ height: 744 }))
      v.setInfo({ windowHeight: 662, windowWidth: 390 })
      await v.keyboard(0)
      await v.keyboard(200, true)
      assert.equal(v.viewport.style.height, '544px')
    },
  })
})

test('focused zero followed by delayed SDK restore remeasures before another resize-first opening', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.resize(462)
      await v.keyboard(0)
      natural(v.viewport)
      await v.resize(762)
      natural(v.viewport)
      await v.resize(562)
      await v.keyboard(100)
      assert.equal(v.viewport.style.height, '644px')
    },
  })
})

for (const crossing of ['positive', 'focus', 'hide', 'page']) {
  test(`focused zero measurement crossing ${crossing} cannot install its closed pair late`, async () => {
    await withViewport({
      defer: true,
      run: async (v) => {
        await v.flush()
        await v.focus(300)
        await v.flush()
        await v.keyboard(0)
        assert.equal(v.pending.length, 1)
        if (crossing === 'positive') await v.keyboard(300)
        if (crossing === 'focus') await v.focus(300)
        if (crossing === 'hide') await v.hide()
        if (crossing === 'page') v.setPage({ route: 'pages/create/index' })
        await v.flush()
        if (crossing !== 'hide' && crossing !== 'page') await v.keyboard(300, true)
        natural(v.viewport)
      },
    })
  })
}

test('mount-time native scheduling failure stays natural and still returns paired subscription cleanup', async () => {
  await withViewport({
    initialScheduleError: true,
    run: async (v) => {
      natural(v.viewport)
      assert.equal(v.callbacks.keyboard.length, 1)
      assert.equal(v.callbacks.resize.length, 1)
      await v.unmount()
      assert.equal(v.removals.keyboard[0], v.callbacks.keyboard[0])
      assert.equal(v.removals.resize[0], v.callbacks.resize[0])
    },
  })
})

test('cycle measurement scheduling failure invalidates current geometry without throwing', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      v.failScheduling()
      await v.keyboard(200)
      natural(v.viewport)
      await v.unmount()
      assert.equal(v.removals.keyboard.length, 1)
      assert.equal(v.removals.resize.length, 1)
    },
  })
})

test('show-time native close scheduling failure cannot escape or lose listener cleanup', async () => {
  await withViewport({
    run: async (v) => {
      await v.focus(300)
      await v.hide()
      v.failScheduling()
      await v.show()
      natural(v.viewport)
      assert.equal(v.closeRequests.length, 0)
      await v.unmount()
      assert.equal(v.removals.keyboard.length, 1)
      assert.equal(v.removals.resize.length, 1)
    },
  })
})

for (const boundary of ['measurement', 'hideKeyboard']) {
  test(`a ${boundary} callback queued before scheduling throws is invalidated before a new focus`, async () => {
    await withViewport({
      run: async (v) => {
        await v.focus(300)
        v.failScheduling({ queue: true })
        if (boundary === 'measurement') await v.keyboard(200)
        else {
          await v.hide()
          await v.show()
        }
        natural(v.viewport)
        v.restoreScheduling()
        await v.focus(100)
        await v.flushTicks()
        natural(v.viewport)
        assert.equal(v.viewport.keyboard, 100)
        assert.equal(v.closeRequests.length, 0)
      },
    })
  })
}
