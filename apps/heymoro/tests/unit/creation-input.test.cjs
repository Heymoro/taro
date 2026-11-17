const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')

const schema = {
  minImages: 0,
  maxImages: 2,
  allowedMimeTypes: ['image/png'],
  maxImageBytes: 20,
  maxTotalImageBytes: 30,
  maxDescriptionLength: 20,
  maxNotesLength: 0
}
test('free input preserves raw whitespace and image order; blank is invalid', () => {
  const { creationInput, validateInput } = load('src/creation-input.js')
  const input = creationInput({ description: '  cat  ', photos: [{ mediaId: 7 }, { mediaId: 3 }] })
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    description: '  cat  ',
    userNotes: '',
    inputMediaIds: [7, 3]
  })
  assert.equal(validateInput({ input, mode: 'free', schema }), '')
  assert.ok(validateInput({ input: { ...input, description: '  ' }, mode: 'free', schema }))
})
test('effect supports optional notes, not description; limits come from schema', () => {
  const { validateInput, validatePhotos } = load('src/creation-input.js')
  const effect = { ...schema, minImages: 1, maxDescriptionLength: 0, maxNotesLength: 4 }
  assert.equal(
    validateInput({
      input: { description: '', userNotes: ' x ', inputMediaIds: [1] },
      mode: 'effect',
      schema: effect
    }),
    ''
  )
  assert.ok(
    validateInput({
      input: { description: 'secret', userNotes: '', inputMediaIds: [1] },
      mode: 'effect',
      schema: effect
    })
  )
  assert.ok(validatePhotos({ photos: [{ size: 21, mimeType: 'image/png' }], schema }))
  assert.ok(
    validatePhotos({
      photos: [
        { size: 16, mimeType: 'image/png' },
        { size: 16, mimeType: 'image/png' }
      ],
      schema
    })
  )
  assert.ok(validatePhotos({ photos: [{ size: 1, mimeType: 'application/pdf' }], schema }))
})
