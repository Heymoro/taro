const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
test('original migration inventory is retained during MVP development', () => {
  for (const item of require('./migration-manifest.json')) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/)
    assert.ok(readFileSync(path.join(__dirname, item.file)).length > 0)
  }
})
test('product workspace does not depend on starter or example runtime', () => {
  const pkg = require('./package.json')
  assert.equal(pkg.private, true)
  assert.equal(pkg.name, '@heymoro/wechat')
  assert.doesNotMatch(JSON.stringify(pkg), /starter|examples\//)
  assert.equal(require('./project.config.json').setting.urlCheck, true)
})

test('user application has no admin login, staff dashboard or cleanup entry', () => {
  const loaded = require('./src/app.config.js')
  const config = loaded.default || loaded
  assert.deepEqual(config.tabBar.list.map(item => item.text), ['首页', '特效', '我的'])
  assert.ok(config.pages.includes('pages/create/index'))
  assert.ok(config.pages.includes('pages/cabinet/index'))
  assert.ok(config.pages.every((page) => !/admin|staff|cleanup/i.test(page)))
  for (const file of ['src/auth.js', 'src/pages/index/index.jsx', 'src/pages/sub1/index.jsx', 'src/pages/sub2/index.jsx']) {
    const source = readFileSync(path.join(__dirname, file), 'utf8')
    assert.doesNotMatch(source, /\/admins\/(?:login|first-register)|\/media\/cleanup|\/auditLogs/)
  }
})
