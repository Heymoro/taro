const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { parseSync } = require('@babel/core')
const runner = createRequire(require.resolve('@tarojs/webpack5-runner/package.json'))
const sass = runner('sass')
const postcss = runner('postcss')
const { withCredits } = require('../fixtures/credits-pages.cjs')
const { withCabinet } = require('../fixtures/cabinet-pages.cjs')
const { withPages } = require('../fixtures/creation-pages.cjs')

const pages = {
  index: ['className', 'scrollY', 'onScrollToLower'],
  effects: ['className', 'scrollY', 'onScrollToLower'],
  me: ['className', 'scrollY'],
  create: ['className', 'scrollY', 'enhanced', 'scrollIntoView', 'onScrollToUpper', 'onScroll', 'onTouchMove'],
  cabinet: [
    'id',
    'className',
    'scrollY',
    'scrollTop',
    'onScroll',
    'onTouchStart',
    'onTouchMove',
    'onScrollToLower',
    'lowerThreshold',
  ],
  sessions: ['className', 'scrollY', 'onScrollToLower'],
  example: ['className', 'scrollY'],
  credits: [
    'id',
    'className',
    'scrollY',
    'scrollTop',
    'onScroll',
    'onTouchStart',
    'onTouchMove',
    'onScrollToLower',
    'lowerThreshold',
  ],
  'credit-reservations': [
    'id',
    'className',
    'scrollY',
    'scrollTop',
    'onScroll',
    'onTouchStart',
    'onTouchMove',
    'onScrollToLower',
    'lowerThreshold',
  ],
}
const app = path.resolve(__dirname, '../..')
const whitespace = (node) => node?.type === 'JSXText' && !node.value.trim()
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach((value) => walk(value, visit))
  visit(node)
  Object.values(node).forEach((value) => walk(value, visit))
}

const contentClasses = (page, view = 'balance') => [
  'scroll-content',
  ...(page === 'effects' ? ['scroll-content--effects'] : []),
  ...(page === 'create' ? ['scroll-content--timeline'] : []),
  ...(['credits', 'credit-reservations'].includes(page) ? ['scroll-content--credits'] : []),
  ...(page === 'credits' && view === 'ledger' ? ['scroll-content--ledger'] : []),
]
const readClasses = (content, text, view) => {
  const value = content.openingElement.attributes[0].value
  const className =
    value.type === 'StringLiteral'
      ? value.value
      : new Function('state', 'return (' + text.slice(value.expression.start, value.expression.end) + ')')({ view })
  return className.trim().split(/\s+/)
}
// Only standalone class rules can match the inner native View independently of
// ScrollView's generated template boundary. This is not a native layout engine.
const compiledContentRules = (css) => {
  const rules = []
  postcss.parse(sass.compileString(css).css).walkRules((rule) => {
    if (rule.selector.includes('scroll-content')) rules.push(rule)
  })
  return rules
}
const selfRules = (css) =>
  compiledContentRules(css).flatMap((rule) => {
    const match = /^\.(scroll-content(?:--[\w-]+)?)$/.exec(rule.selector)
    return match ? [[null, match[1], rule.nodes.map((node) => node.prop + ': ' + node.value + ';').join(' ')]] : []
  })

for (const [page, attributes] of Object.entries(pages)) {
  test('vertical viewport retains controls around one presentation-only content View: ' + page, () => {
    const text = fs.readFileSync(path.join(app, 'src/pages', page, 'index.jsx'), 'utf8')
    const ast = parseSync(text, { babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } }).program
    const scrolls = []
    walk(ast, (node) => {
      if (node.type === 'JSXElement' && node.openingElement.name.name === 'ScrollView') scrolls.push(node)
    })
    const vertical = scrolls.filter((node) =>
      node.openingElement.attributes.some((attr) => attr.name?.name === 'scrollY')
    )
    assert.equal(vertical.length, 1)
    const root = vertical[0],
      children = root.children.filter((node) => !whitespace(node))
    assert.equal(children.length, 1, 'exactly one shallow content View belongs inside the unchanged viewport')
    const content = children[0]
    assert.equal(content.type, 'JSXElement')
    assert.equal(content.openingElement.name.name, 'View')
    assert.deepEqual(
      content.openingElement.attributes.map((attr) => attr.name?.name),
      ['className']
    )
    for (const view of page === 'credits' ? ['balance', 'ledger'] : ['balance']) {
      assert.deepEqual(readClasses(content, text, view), contentClasses(page, view))
    }
    assert.deepEqual(
      root.openingElement.attributes.map((attr) => attr.name?.name),
      attributes
    )
    const props = Object.fromEntries(root.openingElement.attributes.map((attr) => [attr.name.name, attr.value]))
    if (page === 'cabinet') assert.equal(props.id.value, 'cabinet-scroll')
    if (page === 'credits' || page === 'credit-reservations') assert.equal(props.id.value, 'credits-scroll')
    if (page === 'create') assert.equal(props.className.value, 'timeline')
    else if (page === 'effects') assert.equal(props.className.value, 'page-scroll effects-results')
    else if (page !== 'credits' && page !== 'credit-reservations')
      assert.equal(props.className.value.includes('page-scroll'), true)
  })
}

test('vertical viewport sizing stays on roots and existing padding values belong only to inner content', () => {
  const css = fs.readFileSync(path.join(app, 'src/app.scss'), 'utf8')
  for (const root of ['page-scroll', 'timeline']) {
    const body = css.match(new RegExp('\\.' + root + ' \\{([^}]+)\\}'))?.[1]
    assert(body)
    assert.match(body, /flex:\s*1;/)
    assert.match(body, /height:\s*0;/)
    assert.match(body, /min-height:\s*0;/)
    assert.doesNotMatch(body, /padding/)
  }
  const rules = [
    ['scroll-content', 'padding', '12px 24px 24px'],
    ['scroll-content--timeline', 'padding', '12px 24px 16px'],
    ['scroll-content--effects', 'padding-top', '12px'],
    ['scroll-content--credits', 'padding', '16px 24px 24px'],
    ['scroll-content--ledger', 'padding-top', '20px'],
  ]
  const compiled = compiledContentRules(css)
  assert.equal(compiled.length, 5)
  for (const rule of compiled) {
    assert.match(
      rule.selector,
      /^\.scroll-content(?:--[\w-]+)?$/,
      'actual Sass output must match one native View class without ancestors/combinators'
    )
    assert.equal(rule.parent.type, 'root')
  }
  const matched = selfRules(css)
  assert.equal(matched.length, 5)
  for (const [name, property, value] of rules) {
    assert(matched.some((match) => match[1] === name && match[2] === property + ': ' + value + ';'))
  }
  let depth = 0
  for (const line of css.split('\n')) {
    if (line.includes('scroll-content')) {
      assert.equal(depth, 0, 'padding class rules must not be nested under another selector')
      assert.match(line, /^\.scroll-content(?:--[\w-]+)? \{[^{}]+\}$/)
      assert.doesNotMatch(line, /(?:height|flex|overflow)\s*:/)
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
  }
})

for (const page of ['credits', 'credit-reservations']) {
  test('actual ' + page + ' fixture retains scrolling handlers on the real viewport, never inner content', async () => {
    await withCredits(
      async (f) => {
        await f.mount(page)
        const root = document.querySelector('#' + page + ' #credits-scroll')
        assert.equal(root.tagName, 'SECTION')
        assert.equal(root.children.length, 1)
        assert.deepEqual([...root.firstElementChild.classList], contentClasses(page))
        const handler = f.handler(page),
          content = f.handlers.get(page + ':' + root.firstElementChild.className)
        assert.equal(handler.id, 'credits-scroll')
        assert.equal(typeof handler.onScroll, 'function')
        assert.equal(typeof handler.scrollTop, 'number')
        assert.notEqual(handler, content)
        assert.equal(content.onScroll, undefined)
        assert.equal(content.scrollTop, undefined)
      },
      { initial: page }
    )
  })
}

test('actual cabinet fixture keeps geometry viewport and artifact anchors outside the padding wrapper identity', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const root = document.querySelector('#cabinet-scroll')
    assert.equal(root.tagName, 'SECTION')
    assert.equal(root.children.length, 1)
    assert.equal(root.firstElementChild.className, 'scroll-content')
    assert(root.querySelector('.scroll-content .artifact-tile[id^="cabinet-artifact-"]'))
    const handler = h.handlers.get('cabinet:page-scroll'),
      content = h.handlers.get('cabinet:scroll-content')
    assert.equal(handler.id, 'cabinet-scroll')
    assert.equal(typeof handler.onScroll, 'function')
    assert.equal(content.onScroll, undefined)
    assert.equal(content.scrollTop, undefined)
  })
})

test('actual creation fixture measures and controls the timeline root while anchors remain descendants', async () => {
  await withPages(async (h) => {
    await h.act(async () => h.render('create'))
    await h.flush()
    const root = document.querySelector('#create .timeline')
    assert.equal(root.tagName, 'SECTION')
    assert.equal(root.children.length, 1)
    assert.deepEqual([...root.firstElementChild.classList], contentClasses('create'))
    assert(root.querySelector('.scroll-content #timeline-end'))
    assert(root.querySelector('[id^="round-"]'))
    const handler = h.handlers.get('timeline'),
      content = h.handlers.get(root.firstElementChild.className)
    assert.equal(typeof handler.onScroll, 'function')
    assert.equal(typeof handler.onScrollToUpper, 'function')
    assert.equal(root.getAttribute('data-anchor'), handler.scrollIntoView)
    assert.equal(content.scrollIntoView, undefined)
    assert.equal(content.onScroll, undefined)
  })
})

test('self-only native class mapping gives every content View its inset without viewport ancestry', () => {
  const css = fs.readFileSync(path.join(app, 'src/app.scss'), 'utf8'),
    rules = selfRules(css)
  for (const page of Object.keys(pages)) {
    const text = fs.readFileSync(path.join(app, 'src/pages', page, 'index.jsx'), 'utf8')
    const ast = parseSync(text, { babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } }).program
    let content
    walk(ast, (node) => {
      if (
        node.type === 'JSXElement' &&
        node.openingElement.name.name === 'ScrollView' &&
        node.openingElement.attributes.some((attr) => attr.name?.name === 'scrollY')
      )
        content = node.children.find((child) => !whitespace(child))
    })
    for (const view of page === 'credits' ? ['balance', 'ledger'] : ['balance']) {
      const classes = readClasses(content, text, view),
        inset = [0, 0, 0, 0]
      for (const rule of rules.filter((rule) => classes.includes(rule[1]))) {
        for (const declaration of rule[2].split(';').filter(Boolean)) {
          const [property, value] = declaration.split(':').map((part) => part.trim())
          const values = value.split(/\s+/).map((part) => Number.parseInt(part, 10))
          if (property === 'padding') {
            const [top, right = top, bottom = top, left = right] = values
            inset.splice(0, 4, top, right, bottom, left)
          } else if (property === 'padding-top') inset[0] = values[0]
          else assert.fail('unexpected content declaration')
        }
      }
      const top = page === 'credits' ? (view === 'ledger' ? 20 : 16) : page === 'credit-reservations' ? 16 : 12
      assert.deepEqual(
        inset,
        [top, 24, page === 'create' ? 16 : 24, 24],
        page + ':' + view + ' must match its own classes alone'
      )
    }
  }
})
