const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { createRequire } = require('node:module')
const app = path.resolve(__dirname, '../..')
const modulePath = path.join(app, 'scripts/build-local.mjs')
const serviceRequire = createRequire(require.resolve('@tarojs/service', { paths: [path.dirname(require.resolve('@tarojs/cli/package.json'))] }))
const { merge } = serviceRequire('webpack-merge')
const implementation = () => fs.existsSync(modulePath) ? import(pathToFileURL(modulePath)) : Promise.resolve({})

function config(env) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(app, 'config/index.js'), 'utf8'), {
    module, process: { env }, __dirname: path.join(app, 'config'), require: (name) => name.startsWith('.') ? require(path.resolve(app, 'config', name)) : require(name),
  })
  return module.exports(merge)
}

test('local build has a durable package command', () => {
  assert.equal(require('../../package.json').scripts['build:local'], 'node scripts/build-local.mjs')
})

test('local build plan pins loopback and confines output, home and cache to its dedicated project', async () => {
  const { buildPlan } = await implementation()
  assert.equal(typeof buildPlan, 'function', 'missing durable local build entry')
  const plan = buildPlan({ home: '/fixture/home', env: { TARO_APP_API_BASE_URL: 'https://other.invalid', HOME: '/elsewhere' } })
  assert.equal(plan.projectRoot, '/fixture/home/Library/Application Support/Heymoro/local/weapp')
  assert.equal(plan.env.TARO_APP_API_BASE_URL, 'http://127.0.0.1:3001')
  assert.equal(plan.env.HEYMORO_LOCAL_WEAPP_ROOT, plan.projectRoot)
  assert.equal(plan.env.HOME, path.join(plan.projectRoot, '.build-home'))
  assert.equal(plan.env.XDG_CACHE_HOME, path.join(plan.projectRoot, '.build-cache'))
  assert.ok(plan.args.includes('--disable-global-config'))
  assert.ok(plan.args.includes('--no-check'))
  assert.equal(plan.cwd, app)
})

test('only the new local project disables domain validation', async () => {
  const { localProjectConfig } = await implementation()
  assert.equal(typeof localProjectConfig, 'function')
  const source = JSON.parse(fs.readFileSync(path.join(app, 'project.config.json')))
  const generated = localProjectConfig(source)
  assert.equal(generated.setting.urlCheck, false)
  assert.equal(generated.miniprogramRoot, './dist')
  assert.equal(generated.appid, 'touristappid')
  assert.equal(source.setting.urlCheck, true)
  assert.notEqual(generated.projectname, source.projectname)
})

test('local profile compiles current source into dedicated dist with pinned API', () => {
  const localRoot = '/fixture/home/Library/Application Support/Heymoro/local/weapp'
  const result = config({ NODE_ENV: 'production', HEYMORO_LOCAL_WEAPP_ROOT: localRoot, TARO_APP_API_BASE_URL: 'https://other.invalid' })
  assert.equal(path.resolve(app, result.outputRoot), path.join(localRoot, 'dist'))
  assert.equal(result.defineConstants['process.env.TARO_APP_API_BASE_URL'], '"http://127.0.0.1:3001"')
})

test('regular build retains its original output and endpoint behavior', () => {
  const result = config({ NODE_ENV: 'production', TARO_APP_API_BASE_URL: 'https://release.invalid' })
  assert.equal(result.outputRoot, 'dist')
  assert.equal(result.defineConstants['process.env.TARO_APP_API_BASE_URL'], '"https://release.invalid"')
})

test('an explicitly selected local AppID is shared by root and standalone dist project configs', async () => {
  const { localProjectConfig } = await implementation()
  const source = JSON.parse(fs.readFileSync(path.join(app, 'project.config.json')))
  const root = localProjectConfig(source, { appid: 'LOCAL_SELECTED_APPID' })
  const dist = localProjectConfig(source, { appid: 'LOCAL_SELECTED_APPID', miniprogramRoot: './' })
  assert.equal(root.appid, 'LOCAL_SELECTED_APPID')
  assert.equal(dist.appid, root.appid)
  assert.equal(dist.miniprogramRoot, './')
  assert.equal(root.setting.urlCheck, false)
  assert.equal(dist.setting.urlCheck, false)
  assert.equal(source.appid, 'touristappid')
  assert.equal(source.setting.urlCheck, true)
})
