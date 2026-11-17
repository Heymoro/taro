const assert = require('node:assert/strict')
const { test } = require('node:test')

const { load } = require('../source.cjs')

test('photo upload uses only the native file part and leaves its boundary to the host', async () => {
  const token = 'owned-upload-contract-token'
  const filePath = '/owned-fixture/pet.png'
  const data = { id: 37, filesize: 81, width: 3, height: 2, mimeType: 'image/png' }
  let uploaded
  const media = load('src/media.js', {
    '@tarojs/taro': {
      uploadFile: async (options) => {
        uploaded = options
        return { statusCode: 201, data: JSON.stringify({ data, requestId: 'owned-upload-contract' }) }
      },
    },
    './auth': { getStoredToken: () => token },
  })

  const result = await media.uploadMedia(filePath, 'not-a-multipart-field')

  assert.equal(new URL(uploaded.url).pathname, '/api/v1/media')
  assert.equal(uploaded.filePath, filePath)
  assert.equal(uploaded.name, 'file')
  assert.equal(uploaded.header.Authorization, `Bearer ${token}`)
  assert.equal(Object.keys(uploaded.formData || {}).length, 0, 'the endpoint accepts no extra form fields')
  assert.equal(Object.keys(uploaded.header).some((name) => name.toLowerCase() === 'content-type'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), data)
})
