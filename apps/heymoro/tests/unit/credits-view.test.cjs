const { test } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../source.cjs')
const view = () => load('src/features/credits/credits-view.js')
test('successful omitted sources are zero; compensation is its own row and malformed totals are controlled', () => {
  const { creditSources } = view()
  assert.equal(creditSources({ account: null }).rows.length, 0)
  const result = creditSources({ account: { available: 9, sources: [{ sourceType: 'compensation', available: 9 }] } })
  assert.deepEqual(
    Array.from(result.rows, (row) => [row.label, row.amount]),
    [
      ['体验积分', 0],
      ['月度积分', 0],
      ['加购积分', 0],
      ['补偿积分', 9],
    ]
  )
  assert.ok(creditSources({ account: { available: 8, sources: [{ sourceType: 'trial', available: 9 }] } }).error)
  assert.ok(
    creditSources({
      account: {
        available: 2,
        sources: [
          { sourceType: 'trial', available: 1 },
          { sourceType: 'trial', available: 1 },
        ],
      },
    }).error
  )
})
test('ledger preserves server order and groups by local full year day without UTC slicing', () => {
  const { ledgerGroups } = view()
  const rows = [
    { id: 2, createdAt: '2026-01-01T01:00:00.000Z', operation: 'grant', sourceType: 'trial', ledgerDelta: 2 },
    { id: 1, createdAt: '2025-12-31T23:00:00.000Z', operation: 'grant', sourceType: 'trial', ledgerDelta: 0 },
  ]
  const result = ledgerGroups({ items: rows })
  assert.deepEqual(
    Array.from(
      result.flatMap((g) => g.rows),
      (row) => row.id
    ),
    [2, 1]
  )
  const date = new Date(rows[0].createdAt)
  assert.equal(result[0].date, `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`)
  assert.match(result[0].rows[0].time, /^\d{2}:\d{2}$/)
})
test('operation amounts use ledgerDelta only; release status is not refunded income', () => {
  const { ledgerRow, reservationRow } = view()
  assert.equal(
    ledgerRow({ entry: { operation: 'release', ledgerDelta: 0, statusCredits: 7, availableDelta: 7, expiredDelta: 0 } })
      .amount,
    '0 点'
  )
  const release = ledgerRow({
    entry: {
      operation: 'release',
      ledgerDelta: -2,
      statusCredits: 7,
      availableDelta: 5,
      expiredDelta: 2,
    },
  })
  assert.equal(release.amount, '−2 点')
  assert.equal(release.detail, '返可用5点 · 到期2点')
  assert.equal(ledgerRow({ entry: { operation: 'reserve', ledgerDelta: 0, statusCredits: 7 } }).title, '占用7点')
  assert.equal(
    ledgerRow({ entry: { operation: 'compensate', sourceType: 'compensation', ledgerDelta: Number.MAX_SAFE_INTEGER } })
      .amount,
    '+9007199254740991 点'
  )
  assert.equal(
    reservationRow({ row: { roundNo: 4, reservedCredits: 0, taskStatus: 'running', reviewHint: 'PENDING_REVIEW' } })
      .status,
    '待核对'
  )
})

test('local day/year and DST boundaries remain unambiguous without sorting server rows', () => {
  const before = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const { ledgerGroups } = view()
    const make = (id, createdAt) => ({ id, createdAt, operation: 'grant', sourceType: 'trial', ledgerDelta: 0 })
    const groups = ledgerGroups({
      items: [
        make(3, '2026-01-01T02:00:00.000Z'),
        make(2, '2025-12-31T20:00:00.000Z'),
        make(1, '2025-12-30T20:00:00.000Z'),
      ],
    })
    assert.equal(groups[0].date, '2025年12月31日')
    assert.equal(groups[0].rows.length, 2)
    const dst = ledgerGroups({ items: [make(2, '2026-11-01T06:30:00.000Z'), make(1, '2026-11-01T05:30:00.000Z')] })
    assert.deepEqual(
      Array.from(dst[0].rows, (r) => r.time),
      ['01:30', '01:30']
    )
    assert.deepEqual(
      Array.from(dst[0].rows, (r) => r.id),
      [2, 1]
    )
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})
