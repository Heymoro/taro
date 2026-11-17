const path = require('node:path')

const localRoot = process.env.HEYMORO_LOCAL_WEAPP_ROOT

const config = {
  projectName: 'heymoro-wechat',
  date: '2026-11-01',
  designWidth: 390,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    390: 750 / 390,
    828: 1.81 / 2,
  },
  sourceRoot: 'src',
  outputRoot: localRoot ? path.relative(path.resolve(__dirname, '..'), path.join(localRoot, 'dist')) : 'dist',
  ...(localRoot ? { cache: { enable: false } } : {}),
  plugins: [],
  defineConstants: {
    'process.env.TARO_APP_API_BASE_URL': JSON.stringify(localRoot ? 'http://127.0.0.1:3001' : (process.env.TARO_APP_API_BASE_URL || 'http://localhost:3001')),
  },
  framework: 'react',
  compiler: {
    type: 'webpack5',
    prebundle: {
      enable: false,
    },
  },
  mini: {
    webpackChain(chain) {
      // The workspace runtime's raf module references native globals. Providing
      // them from that same runtime creates a self-import before initialization.
      // This app uses no bare RAF globals; explicit Taro runtime imports remain intact.
      if (localRoot) {
        chain.cache(false)
        chain.parallelism(1)
        for (const name of ['terserPlugin', 'cssoWebpackPlugin']) {
          chain.optimization.minimizer(name).tap(args => {
            args[0] = { ...args[0], parallel: false }
            return args
          })
        }
      }
      chain.plugin('providerPlugin').tap(([providers]) => {
        const next = { ...providers }
        delete next.requestAnimationFrame
        delete next.cancelAnimationFrame
        return [next]
      })
    },
    ...(localRoot ? { cache: { enable: false } } : {}),
    enableSourceMap: false,
    postcss: {
      pxtransform: {
        enable: true,
        config: {},
      },
      url: {
        enable: true,
        config: {
          limit: false,
        },
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: 'module', // 转换模式，取值为 global/module
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        config: {
          namingPattern: 'module', // 转换模式，取值为 global/module
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
}

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'))
  }
  return merge({}, config, require('./prod'))
}
