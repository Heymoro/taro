const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load } = require('../source.cjs')
const contract = fs.existsSync(path.resolve(__dirname, '../../src/features/credits/credits-contract.js'))
  ? load('src/features/credits/credits-contract.js')
  : {}
const stamp = '2026-11-14T00:00:00.000Z'
const ledger = (extra = {}) => ({
  id: 1,
  operation: 'reserve',
  ledgerDelta: 0,
  statusCredits: 3,
  sourceType: 'trial',
  createdAt: stamp,
  reservationId: 2,
  taskId: 3,
  availableDelta: -3,
  reservedDelta: 3,
  expiredDelta: 0,
  ...extra,
})
const reservation = (extra = {}) => ({
  reservationId: 2,
  taskId: 3,
  sessionId: 4,
  roundNo: 1,
  reservedCredits: 3,
  taskStatus: 'queued',
  reviewHint: null,
  ...extra,
})
const plain = (value) => JSON.parse(JSON.stringify(value))

test('credits contract exposes only its two locked DTO readers', () => {
  assert.deepEqual(Object.keys(contract).sort(), ['readCreditLedgerEntry', 'readCreditReservation'])
  for (const read of Object.values(contract)) assert.equal(typeof read, 'function')
})
test('ledger projects precisely eleven public fields without mutating or retaining secrets', () => {
  const value = Object.freeze(
    ledger({
      secret: 'private',
      eventKey: 'internal',
      grantKey: 'hidden',
      consumedDelta: 99,
      revokedDelta: 99,
    })
  )
  const before = plain(value)
  const got = contract.readCreditLedgerEntry({ value })
  assert.deepEqual(plain(got), ledger())
  assert.notEqual(got, value)
  assert.deepEqual(plain(value), before)
})
test('reservation projects precisely seven public fields without mutation', () => {
  const value = Object.freeze(
    reservation({ title: 'private', url: 'private', input: { secret: true }, receipt: 'hidden' })
  )
  const before = plain(value)
  const got = contract.readCreditReservation({ value })
  assert.deepEqual(plain(got), reservation())
  assert.notEqual(got, value)
  assert.deepEqual(plain(value), before)
})

const operations = {
  grant: {
    ledgerDelta: 3,
    statusCredits: null,
    reservationId: null,
    taskId: null,
    availableDelta: 3,
    reservedDelta: 0,
    expiredDelta: 0,
  },
  compensate: {
    ledgerDelta: 3,
    statusCredits: null,
    reservationId: null,
    taskId: null,
    availableDelta: 3,
    reservedDelta: 0,
    expiredDelta: 0,
  },
  reserve: {},
  capture: { ledgerDelta: -3, statusCredits: null, availableDelta: 0, reservedDelta: -3 },
  release: { ledgerDelta: -1, availableDelta: 2, reservedDelta: -3, expiredDelta: 1 },
  expire: {
    ledgerDelta: -3,
    statusCredits: null,
    reservationId: null,
    taskId: null,
    availableDelta: -3,
    reservedDelta: 0,
    expiredDelta: 3,
  },
}
const sources = ['trial', 'subscription', 'topup', 'compensation']
const invalid = (read, value) =>
  assert.throws(
    () => read({ value }),
    (error) => error.message === 'INVALID_RESPONSE'
  )
for (const [operation, deltas] of Object.entries(operations)) {
  for (const sourceType of sources) {
    const valid =
      !['grant', 'compensate'].includes(operation) || (operation === 'compensate') === (sourceType === 'compensation')
    test(`ledger ${operation}/${sourceType} ${
      valid ? 'accepts public facts' : 'rejects mismatched grant source'
    }`, () => {
      const value = ledger({ operation, sourceType, ...deltas })
      if (valid) assert.deepEqual(plain(contract.readCreditLedgerEntry({ value })), plain(value))
      else invalid(contract.readCreditLedgerEntry, value)
    })
  }
  test(`ledger ${operation} preserves legal zero amounts`, () => {
    const value = ledger({
      operation,
      ...deltas,
      sourceType: operation === 'compensate' ? 'compensation' : 'trial',
      ledgerDelta: 0,
      availableDelta: 0,
      reservedDelta: 0,
      expiredDelta: 0,
      statusCredits: ['reserve', 'release'].includes(operation) ? 0 : null,
    })
    assert.deepEqual(plain(contract.readCreditLedgerEntry({ value })), plain(value))
  })
}
for (const expiredDelta of [0, 1, 3]) {
  test(`release preserves returned/expired split ${expiredDelta}`, () => {
    const value = ledger({
      operation: 'release',
      ledgerDelta: -expiredDelta,
      reservedDelta: -3,
      availableDelta: 3 - expiredDelta,
      expiredDelta,
    })
    assert.deepEqual(plain(contract.readCreditLedgerEntry({ value })), plain(value))
  })
}
for (const amount of [Number.MAX_SAFE_INTEGER, 0]) {
  test(`safe boundary reserve/release/capture/grant/expire amount ${amount}`, () => {
    const rows = [
      ledger({ statusCredits: amount, availableDelta: -amount, reservedDelta: amount }),
      ledger({
        operation: 'release',
        statusCredits: amount,
        availableDelta: 0,
        reservedDelta: -amount,
        expiredDelta: amount,
        ledgerDelta: -amount,
      }),
      ledger({
        operation: 'capture',
        statusCredits: null,
        availableDelta: 0,
        reservedDelta: -amount,
        ledgerDelta: -amount,
      }),
      ledger({
        operation: 'grant',
        statusCredits: null,
        taskId: null,
        reservationId: null,
        availableDelta: amount,
        reservedDelta: 0,
        ledgerDelta: amount,
      }),
      ledger({
        operation: 'expire',
        statusCredits: null,
        taskId: null,
        reservationId: null,
        availableDelta: -amount,
        reservedDelta: 0,
        expiredDelta: amount,
        ledgerDelta: -amount,
      }),
    ]
    for (const value of rows) assert.deepEqual(plain(contract.readCreditLedgerEntry({ value })), plain(value))
  })
}
const badIntegers = [
  undefined,
  null,
  '3',
  true,
  NaN,
  Infinity,
  -Infinity,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER - 1,
]
for (const field of [
  'id',
  'taskId',
  'reservationId',
  'ledgerDelta',
  'availableDelta',
  'reservedDelta',
  'expiredDelta',
  'statusCredits',
]) {
  for (const value of [
    ...badIntegers,
    ...(['id', 'taskId', 'reservationId'].includes(field) ? [0, -1] : []),
    ...(['expiredDelta', 'statusCredits'].includes(field) ? [-1] : []),
  ]) {
    test(`ledger rejects ${field} invalid primitive ${String(value)}`, () =>
      invalid(contract.readCreditLedgerEntry, ledger({ [field]: value })))
  }
}
for (const field of Object.keys(ledger())) {
  test(`ledger rejects missing required ${field}`, () => {
    const value = ledger()
    delete value[field]
    invalid(contract.readCreditLedgerEntry, value)
  })
}
for (const value of [null, undefined, [], 'row', 3, true]) {
  test(`both readers reject non-record ${String(value)}`, () => {
    invalid(contract.readCreditLedgerEntry, value)
    invalid(contract.readCreditReservation, value)
  })
}
for (const createdAt of [
  '12',
  '2026-02-30T00:00:00.000Z',
  '2026-11-14',
  '2026-11-14T00:00:00Z',
  '2026-11-14T00:00:00.000+00:00',
  '2026-11-14T24:00:00.000Z',
  '2026-13-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  123,
  null,
  '',
  'not a date',
]) {
  test(`ledger rejects noncanonical UTC timestamp ${String(createdAt)}`, () =>
    invalid(contract.readCreditLedgerEntry, ledger({ createdAt })))
}
for (const createdAt of ['0000-01-01T00:00:00.000Z', '2024-02-29T23:59:59.999Z', '9999-12-31T23:59:59.999Z']) {
  test(`ledger accepts canonical UTC timestamp ${createdAt}`, () =>
    assert.equal(contract.readCreditLedgerEntry({ value: ledger({ createdAt }) }).createdAt, createdAt))
}
for (const patch of [
  { operation: 'revoke' },
  { operation: null },
  { sourceType: 'refund' },
  { sourceType: null },
  { ledgerDelta: 1 },
  { availableDelta: -2 },
  { reservedDelta: 2 },
  { expiredDelta: 1 },
  { availableDelta: 3, reservedDelta: -3 },
  { statusCredits: 2 },
  {
    availableDelta: Number.MAX_SAFE_INTEGER,
    reservedDelta: 1,
    ledgerDelta: Number.MAX_SAFE_INTEGER,
  },
  { operation: 'grant', ...operations.grant, taskId: 3 },
  { operation: 'expire', ...operations.expire, reservationId: 2 },
  { operation: 'capture', ...operations.capture, statusCredits: 3 },
  { operation: 'capture', ...operations.capture, availableDelta: 1, ledgerDelta: -2 },
  { operation: 'capture', ...operations.capture, expiredDelta: 1 },
  { operation: 'capture', ...operations.capture, reservedDelta: 3, ledgerDelta: 3 },
  { operation: 'release', ...operations.release, availableDelta: 3, ledgerDelta: 0 },
  { operation: 'release', ...operations.release, reservedDelta: -2, ledgerDelta: 0 },
  {
    operation: 'release',
    ...operations.release,
    availableDelta: -1,
    expiredDelta: 4,
    ledgerDelta: -4,
  },
  {
    operation: 'release',
    ...operations.release,
    availableDelta: Number.MAX_SAFE_INTEGER,
    expiredDelta: 1,
    reservedDelta: -1,
    ledgerDelta: Number.MAX_SAFE_INTEGER - 1,
  },
  { operation: 'grant', ...operations.grant, availableDelta: -3, ledgerDelta: -3 },
  { operation: 'grant', ...operations.grant, expiredDelta: 1 },
  { operation: 'grant', ...operations.grant, availableDelta: 2, reservedDelta: 1 },
  { operation: 'expire', ...operations.expire, ledgerDelta: 3, availableDelta: 3 },
  { operation: 'expire', ...operations.expire, expiredDelta: 2 },
  { operation: 'expire', ...operations.expire, availableDelta: -2, reservedDelta: -1 },
]) {
  test(`ledger rejects inconsistent public fields ${JSON.stringify(patch)}`, () =>
    invalid(contract.readCreditLedgerEntry, ledger(patch)))
}
for (const taskStatus of ['queued', 'running', 'unknown']) {
  for (const reviewHint of [null, 'PENDING_REVIEW']) {
    test(`reservation status/hint ${taskStatus}/${reviewHint}`, () => {
      const value = reservation({ taskStatus, reviewHint })
      if (taskStatus === 'unknown' && reviewHint === null) invalid(contract.readCreditReservation, value)
      else assert.deepEqual(plain(contract.readCreditReservation({ value })), value)
    })
  }
}
for (const field of ['reservationId', 'taskId', 'sessionId', 'roundNo', 'reservedCredits']) {
  for (const value of [...badIntegers, -1, ...(field === 'reservedCredits' ? [] : [0])]) {
    test(`reservation rejects ${field} invalid ${String(value)}`, () =>
      invalid(contract.readCreditReservation, reservation({ [field]: value })))
  }
  test(`reservation accepts safe boundary ${field}`, () =>
    assert.equal(
      contract.readCreditReservation({ value: reservation({ [field]: Number.MAX_SAFE_INTEGER }) })[field],
      Number.MAX_SAFE_INTEGER
    ))
}
test('zero-cost reservation remains zero', () =>
  assert.equal(contract.readCreditReservation({ value: reservation({ reservedCredits: 0 }) }).reservedCredits, 0))
for (const field of Object.keys(reservation())) {
  test(`reservation rejects missing required ${field}`, () => {
    const value = reservation()
    delete value[field]
    invalid(contract.readCreditReservation, value)
  })
}
for (const patch of [
  { taskStatus: 'failed' },
  { taskStatus: 'released' },
  { taskStatus: 'succeeded' },
  { taskStatus: null },
  { taskStatus: 1 },
  { reviewHint: 'REFUNDED' },
  { reviewHint: false },
]) {
  test(`reservation rejects unknown primitive ${JSON.stringify(patch)}`, () =>
    invalid(contract.readCreditReservation, reservation(patch)))
}
