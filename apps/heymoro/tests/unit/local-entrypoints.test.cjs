const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const app = path.resolve(__dirname, '../..')
const entry = pathToFileURL(path.join(app, 'scripts/verify-local.mjs')).href
const reportMarker = 'LOCAL_ENTRYPOINT_REPORT='
const originalTests =
  'node --test client.test.cjs migration.test.cjs creation.test.cjs pending-submission.test.cjs tests/unit/*.test.cjs'

// Import the real entry in a disposable process. No pnpm commands or HTTP requests run.
function runEntry({ outcome = 'success', stage = 0, inheritedHttp = 'false' } = {}) {
  const source = `
    const assert = require('node:assert/strict')
    const childProcess = require('node:child_process')
    const { syncBuiltinESMExports } = require('node:module')
    const report = { boundaryPatched: false, calls: [], fetches: [] }
    process.on('exit', () => {
      process.stdout.write('\\n' + ${JSON.stringify(reportMarker)} + JSON.stringify(report) + '\\n')
    })
    const replacement = (command, args, options) => {
      const index = report.calls.length
      report.calls.push({
        command, args, cwd: options.cwd, shell: options.shell ?? false,
        stdio: options.stdio,
        http: options.env?.LOCAL_MVP_HTTP,
        corepack: options.env?.COREPACK_ENABLE_NETWORK
      })
      if (index !== ${stage}) return { status: 0, signal: null }
      switch (${JSON.stringify(outcome)}) {
        case 'nonzero': return { status: 7, signal: null }
        case 'error': return { status: 0, error: new Error('spawn unavailable') }
        case 'signal': return { status: 0, signal: 'SIGTERM' }
        case 'null-status': return { status: null, signal: null }
        case 'throw': throw new Error('synchronous spawn failure')
        default: return { status: 0, signal: null }
      }
    }
    childProcess.spawnSync = replacement
    syncBuiltinESMExports()
    globalThis.fetch = async (url) => {
      report.fetches.push(String(url))
      return { ok: true, status: 200 }
    }
    ;(async () => {
      const named = await import('node:child_process')
      assert.strictEqual(named.spawnSync, replacement, 'ESM spawnSync replacement must be active')
      report.boundaryPatched = true
      await import(${JSON.stringify(entry)})
    })().catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  `
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: tmpdir(),
    env: { ...process.env, LOCAL_MVP_HTTP: inheritedHttp, COREPACK_ENABLE_NETWORK: '1' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024
  })
  assert.ifError(child.error)
  assert.equal(child.signal, null, 'entry subprocess must finish within its deadline')
  const reportLine = child.stdout.split('\n').find((line) => line.startsWith(reportMarker))
  assert.ok(reportLine, 'entry subprocess must report its intercepted boundaries')
  const report = JSON.parse(reportLine.slice(reportMarker.length))
  assert.equal(report.boundaryPatched, true)
  return { ...child, report }
}

function expectedCalls({ count }) {
  return ['test', 'lint'].slice(0, count).map((command) => ({
    command: 'pnpm',
    args: ['run', command],
    cwd: app + path.sep,
    shell: false,
    stdio: 'inherit',
    http: 'false',
    corepack: '0'
  }))
}

function assertLocalBoundaries({ result, count }) {
  assert.deepEqual(result.report.calls, expectedCalls({ count }))
  assert.deepEqual(result.report.fetches, [], 'default verification must not probe HTTP')
}

test('package test disables HTTP and Corepack networking without removing any existing tests', () => {
  const { scripts } = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'))
  assert.equal(scripts.test, `LOCAL_MVP_HTTP=false COREPACK_ENABLE_NETWORK=0 ${originalTests}`)
})

test('package removes the missing test:flow alias rather than inventing a legacy test', () => {
  const { scripts } = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(scripts, 'test:flow'), false)
  assert.equal(scripts['verify:local'], 'node scripts/verify-local.mjs')
})

test('real verify entry runs only app unit then lint from an external cwd', () => {
  const result = runEntry()
  assert.equal(result.status, 0)
  assertLocalBoundaries({ result, count: 2 })
  assert.match(result.stdout, /PASS client unit \+ lint\./)
  assert.doesNotMatch(result.stdout, /MVP acceptance|WeChat.*acceptance/)
})

test('real verify entry never probes a backend', () => {
  const result = runEntry()
  assert.deepEqual(result.report.fetches, [])
})

test('real verify entry overrides inherited HTTP=true and Corepack networking', () => {
  const result = runEntry({ inheritedHttp: 'true' })
  assert.equal(result.status, 0)
  assertLocalBoundaries({ result, count: 2 })
})

for (const [stage, command] of ['unit', 'lint'].entries()) {
  for (const outcome of ['nonzero', 'error', 'signal', 'null-status', 'throw']) {
    test(`real verify entry stops on ${command} ${outcome} without claiming success`, () => {
      const result = runEntry({ outcome, stage, inheritedHttp: 'true' })
      if (outcome === 'nonzero') assert.equal(result.status, 7, 'preserve command exit status')
      else assert.notEqual(result.status, 0)
      assertLocalBoundaries({ result, count: stage + 1 })
      assert.doesNotMatch(result.stdout, /PASS/)
    })
  }
}
