const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { transformSync } = require('@babel/core')

const fromPreset = createRequire(require.resolve('babel-preset-taro'))
exports.load = (file, mocks = {}) => {
  const cache = new Map()
  function read(filename) {
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename,
      babelrc: false,
      configFile: false,
      presets: [
        [fromPreset.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }],
        fromPreset.resolve('@babel/preset-react')
      ]
    })
    const requireLocal = (id) => {
      if (id in mocks) return mocks[id]
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(filename), id)
        if (/\.(png|jpg|svg)$/.test(id)) return base
        const resolved = [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.jsx')].find(
          (p) => fs.existsSync(p) && fs.statSync(p).isFile()
        )
        if (!resolved) throw Error(`Missing source ${base}`)
        return read(resolved)
      }
      if (id === 'react' || id === 'react-dom/server') return require(id)
      throw Error(`Unexpected dependency ${id}`)
    }
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
      process,
      Date,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      console,
      AbortController
    })(requireLocal, module, module.exports)
    return module.exports
  }
  return read(path.resolve(__dirname, '..', file))
}
