const labels = { trial: '体验积分', subscription: '月度积分', topup: '加购积分', compensation: '补偿积分' }

/** sources describe only the positive currently available buckets, not history. */
export function creditSources({ account }) {
  if (!account) return { rows: [], error: '' }
  const amounts = new Map()
  let total = 0
  for (const source of account.sources || []) {
    if (
      !labels[source.sourceType] ||
      amounts.has(source.sourceType) ||
      !Number.isSafeInteger(source.available) ||
      source.available <= 0
    ) {
      return { rows: [], error: '积分来源暂时无法读取，请重试' }
    }
    amounts.set(source.sourceType, source.available)
    total += source.available
  }
  if (!Number.isSafeInteger(total) || total !== account.available) {
    return { rows: [], error: '积分来源暂时无法读取，请重试' }
  }
  const kinds = ['trial', 'subscription', 'topup']
  if (amounts.has('compensation')) kinds.push('compensation')
  return { error: '', rows: kinds.map((kind) => ({ kind, label: labels[kind], amount: amounts.get(kind) || 0 })) }
}

export function ledgerRow({ entry }) {
  const delta = entry.ledgerDelta
  const title = {
    grant: labels[entry.sourceType],
    compensate: '补偿积分',
    reserve: `占用${entry.statusCredits}点`,
    capture: '创作扣除',
    release: `已解除${entry.statusCredits}点占用`,
    expire: '积分到期',
  }[entry.operation]
  return {
    ...entry,
    title,
    amount: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)} 点`,
    tone: delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral',
    detail:
      entry.operation === 'release' && entry.expiredDelta > 0
        ? `返可用${entry.availableDelta}点 · 到期${entry.expiredDelta}点`
        : '',
  }
}

export function ledgerGroups({ items }) {
  const groups = []
  for (const entry of items) {
    const local = new Date(entry.createdAt)
    const date = `${local.getFullYear()}年${local.getMonth() + 1}月${local.getDate()}日`
    if (groups.at(-1)?.date !== date) {
      const group = { date, rows: [] }
      groups.push(group)
    }
    groups.at(-1).rows.push({
      ...ledgerRow({ entry }),
      time: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`,
    })
  }
  return groups
}

export function reservationRow({ row }) {
  const observed = row.taskStatus === 'queued' ? '排队中' : '生成中'
  const status = row.reviewHint === 'PENDING_REVIEW' || row.taskStatus === 'unknown' ? '待核对' : observed
  return {
    ...row,
    title: `第${row.roundNo}轮创作`,
    status,
    amount: `${row.reservedCredits} 点`,
  }
}

export const creditRowId = ({ view, id }) => `credit-${view}-${id}`
