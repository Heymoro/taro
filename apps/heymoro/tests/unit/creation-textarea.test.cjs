const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const React = require('react')
const { load } = require('../source.cjs')

// Real component state/effects; only Taro's native node/event boundary is replaced.
async function withTextarea({ run }) {
  const { JSDOM } = require('jsdom')
  const { createRoot } = require('react-dom/client')
  const dom = new JSDOM('<div id="root"></div>')
  const before = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT,
  }
  global.window = dom.window
  global.document = dom.window.document
  global.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const nodes = new Map()
  let mounts = 0
  function NativeTextarea(props) {
    nodes.set(props.className.includes('composer__input') ? 'free' : 'notes', props)
    React.useEffect(() => {
      mounts += 1
    }, [])
    return React.createElement('textarea', {
      className: props.className,
      value: props.value,
      readOnly: true,
    })
  }
  const components = {
    Textarea: NativeTextarea,
    View: ({ children, className, onClick }) => React.createElement('div', { className, onClick }, children),
    Button: ({ children, className, onClick, disabled }) =>
      React.createElement('button', { className, onClick, disabled }, children),
    Text: ({ children }) => React.createElement('span', null, children),
    Image: () => null,
  }
  const mocks = { '@tarojs/components': components, '@tarojs/taro': {} }
  const Composer = load('src/features/creation/CreationComposer/index.jsx', mocks).default
  const EffectNotes = load('src/features/creation/EffectNotes/index.jsx', mocks).default
  const defaults = {
    mode: 'free',
    description: '',
    schema: { maxDescriptionLength: 500, maxNotesLength: 200 },
    controls: { canGenerate: false, generateLabel: '生成', costCredits: null },
  }
  const act = (fn) => React.act(fn)
  const api = {
    Composer,
    EffectNotes,
    defaults,
    act,
    props: (kind = 'free') => nodes.get(kind),
    rows: (kind = 'free') => Number(nodes.get(kind).className.match(/creation-textarea__input--rows-(\d)/)?.[1]),
    node: (kind = 'free') => document.querySelector(kind === 'free' ? '.composer__input' : '.effect-notes__input'),
    get mounts() {
      return mounts
    },
    render: async (props = {}) =>
      act(async () => root.render(React.createElement(Composer, { ...defaults, ...props }))),
    renderTree: async (tree) => act(async () => root.render(tree)),
    event: async (name, event, kind = 'free') => act(async () => nodes.get(kind)[name]?.(event)),
    clickShell: async (kind = 'free') => act(async () => api.node(kind).parentElement.click()),
  }
  try {
    await run(api)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    global.window = before.window
    global.document = before.document
    global.IS_REACT_ACT_ENVIRONMENT = before.act
  }
}

test('free native input starts at one row with explicit bounded-height native flags', async () => {
  await withTextarea({
    run: async (f) => {
      await f.render()
      assert.equal(f.rows(), 1)
      assert.equal(f.props().autoHeight, false)
      assert.equal(f.props().disableDefaultPadding, true)
      assert.equal(f.props().fixed, true)
      assert.equal(f.props().adjustPosition, false)
      assert.equal(f.props().showConfirmBar, false)
      assert.equal(f.props().maxlength, 500)
      assert.equal(f.props().placeholder, '描述想生成的画面')
      assert.match(f.node().parentElement.className, /creation-textarea/)
      assert.equal(f.props().style, undefined)
      assert.equal(f.props().cursor, undefined)
    },
  })
})

test('real native line counts grow and shrink one through three rows without replacing the input', async () => {
  await withTextarea({
    run: async (f) => {
      await f.render({ description: '中文软换行不是字符数或换行符的推测' })
      assert.equal(f.rows(), 3, 'nonempty initial layout has a readable unknown fallback, not an exact line estimate')
      const node = f.node()
      node.setSelectionRange(2, 4)
      for (const [lineCount, rows] of [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 3],
        [500, 3],
        [2, 2],
        [1, 1],
      ]) {
        await f.event('onLineChange', { detail: { lineCount, height: 99999, heightRpx: 88888 } })
        assert.equal(f.rows(), rows)
        assert.equal(f.node(), node)
        assert.equal(node.selectionStart, 2)
        assert.equal(node.selectionEnd, 4)
      }
      assert.equal(f.mounts, 1)
      assert.equal(f.props().value, '中文软换行不是字符数或换行符的推测')
    },
  })
})

test('malformed native line-count events preserve the last valid row count', async () => {
  await withTextarea({
    run: async (f) => {
      await f.render({ description: 'notes' })
      await f.event('onLineChange', { detail: { lineCount: 2 } })
      for (const event of [
        undefined,
        {},
        { detail: null },
        ...[undefined, null, '3', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((lineCount) => ({
          detail: { lineCount },
        })),
      ]) {
        await f.event('onLineChange', event)
        assert.equal(f.rows(), 2)
      }
    },
  })
})

test('controlled input echoes raw text once without resetting rows, focus or cursor', async () => {
  await withTextarea({
    run: async (f) => {
      const inputs = []
      let value = 'first'
      function Controlled() {
        const [description, setDescription] = React.useState(value)
        return React.createElement(f.Composer, {
          ...f.defaults,
          description,
          onDescription: (next) => {
            inputs.push(next)
            value = next
            setDescription(next)
          },
        })
      }
      await f.renderTree(React.createElement(Controlled))
      await f.event('onLineChange', { detail: { lineCount: 2 } })
      await f.event('onFocus', { detail: { height: 300 } })
      const node = f.node()
      for (const next of ['  中文🙂\nline  ', '  中文🙂\nline  more']) {
        await f.event('onInput', { detail: { value: next } })
        assert.equal(f.props().value, next)
        assert.equal(f.rows(), 2)
        assert.equal(f.node(), node)
        assert.equal(f.props().cursor, undefined)
      }
      assert.deepEqual(inputs, ['  中文🙂\nline  ', '  中文🙂\nline  more'])
      assert.equal(f.mounts, 1)
    },
  })
})

test('native line counts survive either ordering around the first nonempty controlled input echo', async () => {
  for (const lineCountFirst of [true, false]) {
    await withTextarea({
      run: async (f) => {
        const inputs = []
        function Controlled() {
          const [description, setDescription] = React.useState('')
          return React.createElement(f.Composer, {
            ...f.defaults,
            description,
            onDescription: (value) => {
              inputs.push(value)
              setDescription(value)
            },
          })
        }
        await f.renderTree(React.createElement(Controlled))
        const node = f.node()
        const value = '  中文🙂 large paste  '
        if (lineCountFirst) {
          await f.event('onLineChange', { detail: { lineCount: 4 } })
          assert.equal(f.rows(), 1, 'empty controlled text remains visibly one row')
        }
        await f.event('onInput', { detail: { value } })
        if (!lineCountFirst) await f.event('onLineChange', { detail: { lineCount: 4 } })
        assert.equal(f.rows(), 3, 'the measured native cap survives the controlled echo without a second layout event')
        assert.equal(f.props().value, value)
        assert.equal(f.props().maxlength, 500)
        assert.deepEqual(inputs, [value])
        assert.equal(f.node(), node)
        assert.equal(f.mounts, 1)
      },
    })
  }
})

test('controlled clearing stays visibly one row while retaining the latest native row candidate', async () => {
  await withTextarea({
    run: async (f) => {
      await f.render({ description: 'long text' })
      await f.event('onLineChange', { detail: { lineCount: 8 } })
      const node = f.node()
      await f.render({ description: '' })
      assert.equal(f.rows(), 1)
      await f.event('onLineChange', { detail: { lineCount: 3 } })
      assert.equal(f.rows(), 1)
      assert.equal(f.node(), node)
      await f.render({ description: 'external draft restore' })
      assert.equal(f.rows(), 3, 'external replacement uses the latest native candidate pending its own real layout')
      await f.event('onLineChange', { detail: { lineCount: 2 } })
      assert.equal(f.rows(), 2)
    },
  })
})

test('shell clicks request focus without fabricating viewport events and blur permits a new request', async () => {
  await withTextarea({
    run: async (f) => {
      const events = []
      await f.render({
        onFocus: (event) => events.push(['focus', event]),
        onBlur: (event) => events.push(['blur', event]),
        onKeyboardHeightChange: (event) => events.push(['keyboard', event]),
      })
      assert.equal(f.props().focus, false)
      await f.clickShell()
      assert.equal(f.props().focus, true)
      assert.equal(events.length, 0)
      const focusEvent = { detail: { height: 301 } }
      const keyboardEvent = { detail: { height: 301, duration: 250 } }
      const blurEvent = { detail: { value: 'kept' } }
      await f.event('onFocus', focusEvent)
      const focusedProps = f.props()
      await f.clickShell()
      assert.equal(f.props(), focusedProps, 'already-focused clicks do not create a new focus/cursor request')
      await f.event('onKeyboardHeightChange', keyboardEvent)
      await f.event('onBlur', blurEvent)
      assert.equal(f.props().focus, false)
      assert.deepEqual(events, [
        ['focus', focusEvent],
        ['keyboard', keyboardEvent],
        ['blur', blurEvent],
      ])
      await f.clickShell()
      assert.equal(f.props().focus, true)
      assert.equal(events.length, 3)
    },
  })
})

test('free footer and optional inline notes use independent real shared input instances', async () => {
  await withTextarea({
    run: async (f) => {
      const notes = []
      const focuses = []
      await f.renderTree(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(f.Composer, { ...f.defaults, description: 'free' }),
          React.createElement(f.EffectNotes, {
            userNotes: '  notes🙂  ',
            schema: f.defaults.schema,
            onNotes: (value) => notes.push(value),
            onFocus: (event) => focuses.push(event),
          })
        )
      )
      assert.equal(f.node('notes'), null)
      await f.act(async () => document.querySelector('.effect-notes__toggle').click())
      assert.equal(f.props('notes').value, '  notes🙂  ')
      assert.equal(f.props('notes').maxlength, 200)
      assert.equal(f.props('notes').placeholder, '补充要求（选填）')
      assert.notEqual(f.props('notes').fixed, true)
      assert.equal(f.props('notes').autoHeight, false)
      assert.equal(f.props('notes').disableDefaultPadding, true)
      assert.equal(f.props('notes').adjustPosition, false)
      assert.equal(f.props('notes').showConfirmBar, false)
      await f.event('onLineChange', { detail: { lineCount: 1 } }, 'notes')
      assert.equal(f.rows('notes'), 1)
      assert.equal(f.rows('free'), 3)
      await f.clickShell('notes')
      assert.equal(f.props('notes').focus, true)
      assert.equal(f.props('free').focus, false)
      assert.equal(focuses.length, 0)
      await f.event('onInput', { detail: { value: '  unchanged raw notes  ' } }, 'notes')
      assert.deepEqual(notes, ['  unchanged raw notes  '])
      const freeNode = f.node()
      await f.act(async () => document.querySelector('.effect-notes__toggle').click())
      assert.equal(f.node('notes'), null)
      await f.act(async () => document.querySelector('.effect-notes__toggle').click())
      assert.equal(f.props('notes').value, '  notes🙂  ')
      assert.equal(f.rows('notes'), 3)
      assert.equal(f.props('notes').focus, false)
      assert.equal(f.node(), freeNode)
    },
  })
})

test('row heights and line height use CSS units while padding and decoration belong only to the shell', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/app.scss'), 'utf8')
  const rule = (selector) =>
    css.match(new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1] || ''
  assert.match(rule('creation-textarea'), /padding:\s*11px 12px/)
  assert.match(rule('creation-textarea'), /border:\s*1px solid/)
  assert.match(rule('creation-textarea'), /border-radius:\s*14px/)
  assert.match(rule('creation-textarea__input'), /line-height:\s*20px/)
  for (const rows of [1, 2, 3])
    assert.match(rule(`creation-textarea__input--rows-${rows}`), new RegExp(`height:\\s*${rows * 20}px`))
  for (const selector of ['creation-textarea__input', 'composer__input', 'effect-notes__input']) {
    assert.doesNotMatch(rule(selector), /(?:^|;)\s*(?:padding|(?:min-|max-)?height|border|background)\s*:/)
  }
  assert.match(rule('creation-textarea--composer'), /background:\s*\$canvas/)
  assert.match(rule('creation-textarea--notes'), /background:\s*\$quiet/)
})
