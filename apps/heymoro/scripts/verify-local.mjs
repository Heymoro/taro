import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const client = fileURLToPath(new URL('../', import.meta.url))
const env = { ...process.env, LOCAL_MVP_HTTP: 'false', COREPACK_ENABLE_NETWORK: '0' }

for (const command of ['test', 'lint']) {
  console.log(`\n=== Client: pnpm run ${command} ===`)
  let result
  try {
    result = spawnSync('pnpm', ['run', command], {
      cwd: client,
      stdio: 'inherit',
      shell: false,
      env
    })
  } catch (error) {
    console.error(`FAIL ${command}: ${error.message}`)
    process.exit(1)
  }
  if (result.error || result.signal || result.status !== 0) {
    console.error(`FAIL ${command}: ${result.error?.message || result.signal || result.status}`)
    process.exit(Number.isInteger(result.status) && result.status !== 0 ? result.status : 1)
  }
}
console.log('\nPASS client unit + lint.')
