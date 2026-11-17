const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('../source.cjs')

function nativeStorage(entries = [], overrides = {}) {
  const saved = new Map(entries)
  const reads = []
  const writes = []
  const metadataReads = []
  const host = {
    getStorageInfoSync: () => {
      metadataReads.push(true)
      return { keys: [...saved.keys()], currentSize: 1, limitSize: 10240 }
    },
    // WeChat returns an empty string for a missing key as well as a stored empty string.
    getStorageSync: (key) => {
      reads.push(key)
      return saved.has(key) ? saved.get(key) : ''
    },
    setStorageSync: (key, value) => {
      writes.push({ key, value })
      saved.set(key, value)
    },
    ...overrides,
  }
  const { accountStorage } = load('src/creation-platform.js', {
    '@tarojs/taro': host,
    './creation-api': { privateImage: () => {} },
    './media': { uploadMedia: () => {} },
  })
  return { accountStorage, saved, reads, writes, metadataReads }
}

test('accountStorage returns undefined for missing native keys without reading or writing a value', () => {
  const { accountStorage, reads, writes } = nativeStorage([['heymoro.user.token', 'fixture-token']])

  assert.equal(accountStorage(1).get('unsettled'), undefined)
  assert.deepEqual(reads, [])
  assert.deepEqual(writes, [])
})

test('accountStorage enumerates only the exact account and requested alias prefix without reading values', () => {
  const prefix = 'template:free:entry:free:1:'
  const { accountStorage, reads, writes } = nativeStorage([
    [`heymoro.creation.v1:1:${prefix}2`, 'own'],
    [`heymoro.creation.v1:12:${prefix}2`, 'other account'],
    [`heymoro.creation.v1:2:${prefix}2`, 'other account'],
    ['heymoro.creation.v1:1:template:free:entry:free:11:2', 'other template']
  ])
  assert.deepEqual(Array.from(accountStorage(1).listKeys({ prefix })), [prefix + '2'])
  assert.deepEqual(reads, [])
  assert.deepEqual(writes, [])
})

for (const [label, value] of [
  ['valid recovery object', { protocol: 2, draftKey: 'session:4', record: { sessionId: 4 } }],
  ['empty string', ''],
  ['false', false],
  ['zero', 0],
  ['null', null],
  ['undefined', undefined],
]) {
  test(`accountStorage preserves a persisted ${label} verbatim`, () => {
    const key = 'heymoro.creation.v1:1:unsettled'
    const { accountStorage, reads, writes } = nativeStorage([[key, value]])

    assert.equal(accountStorage(1).get('unsettled'), value)
    assert.deepEqual(reads, [key])
    assert.deepEqual(writes, [])
  })
}

test('accountStorage isolates exact keys by account and refreshes native metadata for every get', () => {
  const key = 'heymoro.creation.v1:1:unsettled'
  const value = { protocol: 2 }
  const { accountStorage, saved, reads, writes, metadataReads } = nativeStorage([
    [key, value],
    ['heymoro.creation.v1:2:unsettled:extra', 'not-the-requested-key'],
    ['heymoro.creation.v1:12:unsettled', 'not-the-requested-account'],
  ])
  const secondAccount = accountStorage(2)

  assert.equal(accountStorage(1).get('unsettled'), value)
  assert.equal(secondAccount.get('unsettled'), undefined)
  saved.set('heymoro.creation.v1:2:unsettled', false)
  assert.equal(secondAccount.get('unsettled'), false)
  saved.delete(key)
  assert.equal(accountStorage(1).get('unsettled'), undefined)
  assert.deepEqual(reads, [key, 'heymoro.creation.v1:2:unsettled'])
  assert.equal(metadataReads.length, 4)
  assert.deepEqual(writes, [])
})

test('accountStorage propagates the original native metadata error without reading or writing values', () => {
  const error = Error('metadata read failed')
  const { accountStorage, reads, writes } = nativeStorage([], {
    getStorageInfoSync: () => {
      throw error
    },
  })

  assert.throws(
    () => accountStorage(1).get('unsettled'),
    (actual) => actual === error
  )
  assert.deepEqual(reads, [])
  assert.deepEqual(writes, [])
})

for (const [label, metadata] of [
  ['undefined result', undefined],
  ['null result', null],
  ['missing keys', {}],
  ['null keys', { keys: null }],
  ['string keys', { keys: 'heymoro.creation.v1:1:unsettled' }],
  ['object keys', { keys: {} }],
  ['non-string key', { keys: ['heymoro.user.token', 1] }],
  ['sparse keys', { keys: Array(1) }],
]) {
  test(`accountStorage rejects malformed metadata (${label}) without treating it as an absent key`, () => {
    const { accountStorage, reads, writes } = nativeStorage([], {
      getStorageInfoSync: () => metadata,
    })

    assert.throws(() => accountStorage(1).get('unsettled'), /STORAGE_METADATA_INVALID/)
    assert.deepEqual(reads, [])
    assert.deepEqual(writes, [])
  })
}

test('accountStorage propagates the original native value-read error without writing', () => {
  const error = Error('value read failed')
  const { accountStorage, writes } = nativeStorage([['heymoro.creation.v1:1:unsettled', 'preserved']], {
    getStorageSync: () => {
      throw error
    },
  })

  assert.throws(
    () => accountStorage(1).get('unsettled'),
    (actual) => actual === error
  )
  assert.deepEqual(writes, [])
})

test('accountStorage set forwards the namespaced key, original value and native return value unchanged', () => {
  const value = { protocol: 2 }
  const result = { native: 'result' }
  const calls = []
  const { accountStorage, metadataReads, reads } = nativeStorage([], {
    setStorageSync: (key, input) => {
      calls.push({ key, value: input })
      return result
    },
  })

  assert.equal(accountStorage(2).set('session:4', value), result)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, 'heymoro.creation.v1:2:session:4')
  assert.equal(calls[0].value, value)
  assert.deepEqual(metadataReads, [])
  assert.deepEqual(reads, [])
})

test('accountStorage set propagates the original native write error', () => {
  const error = Error('storage full')
  const { accountStorage, metadataReads, reads } = nativeStorage([], {
    setStorageSync: () => {
      throw error
    },
  })

  assert.throws(
    () => accountStorage(1).set('unsettled', ''),
    (actual) => actual === error
  )
  assert.deepEqual(metadataReads, [])
  assert.deepEqual(reads, [])
})
