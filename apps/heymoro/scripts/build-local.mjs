import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appPath = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

export function buildPlan({ home = os.homedir(), env = process.env } = {}) {
  const projectRoot = path.join(home, 'Library/Application Support/Heymoro/local/weapp')
  return {
    projectRoot,
    cwd: appPath.replace(/\/$/, ''),
    args: [require.resolve('@tarojs/cli/bin/taro'), 'build', '--type', 'weapp', '--disable-global-config', '--no-check'],
    env: {
      ...env,
      HOME: path.join(projectRoot, '.build-home'),
      TMPDIR: path.join(projectRoot, '.build-tmp'),
      XDG_CACHE_HOME: path.join(projectRoot, '.build-cache'),
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=4096',
      TARO_ENV: 'weapp',
      TARO_PLATFORM: 'mini',
      HEYMORO_LOCAL_WEAPP_ROOT: projectRoot,
      TARO_APP_API_BASE_URL: 'http://127.0.0.1:3001',
      COREPACK_ENABLE_NETWORK: '0',
      CI: '1',
    },
  }
}

export function localProjectConfig(source, { appid = source.appid, miniprogramRoot = './dist' } = {}) {
  return {
    ...source,
    appid,
    miniprogramRoot,
    projectname: 'heymoro-local-current-source',
    setting: { ...source.setting, urlCheck: false },
  }
}

function main() {
  assert.equal(process.version, 'v24.22.1', 'Use the pinned Heymoro Node v24.22.1 toolchain')
  const plan = buildPlan()
  for (const directory of [plan.projectRoot, plan.env.HOME, plan.env.TMPDIR, plan.env.XDG_CACHE_HOME]) {
    fs.mkdirSync(directory, { recursive: true })
    assert(!fs.lstatSync(directory).isSymbolicLink(), `Local build directory must not be a symlink: ${directory}`)
  }
  const result = spawnSync(process.execPath, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit' })
  if (result.error || result.signal || result.status !== 0) {
    throw result.error || new Error(`Local build failed: ${result.signal || result.status}`)
  }
  const output = path.join(plan.projectRoot, 'dist')
  for (const name of ['app.json', 'app.js', 'app.wxss']) {
    assert(fs.statSync(path.join(output, name)).size > 0, `Missing build output: ${name}`)
  }
  const source = JSON.parse(fs.readFileSync(path.join(appPath, 'project.config.json'), 'utf8'))
  const projectConfigPath = path.join(plan.projectRoot, 'project.config.json')
  // Keep an AppID explicitly selected for this dedicated local project only.
  const appid = fs.existsSync(projectConfigPath)
    ? JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')).appid || source.appid
    : source.appid
  fs.writeFileSync(projectConfigPath, JSON.stringify(localProjectConfig(source, { appid }), null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'project.config.json'), JSON.stringify(localProjectConfig(source, { appid, miniprogramRoot: './' }), null, 2) + '\n')
  console.log(`Local WeChat project: ${plan.projectRoot}\nAPI: ${plan.env.TARO_APP_API_BASE_URL}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
