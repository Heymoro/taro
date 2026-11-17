import { Button, Text, View } from '@tarojs/components'
import React from 'react'

import { Brand, Notice } from '../../components/primitives'
import { creditRowId, creditSources, ledgerGroups, reservationRow } from './credits-view'

export function CreditBalance({ account, onRetry, onReservations, opening }) {
  const value = account.value
  const sources = creditSources({ account: value })
  const emptyDescription = value?.reserved > 0 ? '积分处理中占用，待任务结算' : '暂无可用积分，作品和草稿仍保留'
  const description = value?.available === 0 ? emptyDescription : '出图成功才扣积分'
  return (
    <View className="credits-balance">
      {(account.error || sources.error) && <Notice onRetry={onRetry}>{account.error || sources.error}</Notice>}
      <View className="credits-balance-card">
        <View className="credits-balance-heading">
          <Text className="credits-balance-title">可用积分</Text>
          {account.loading && <Brand animated />}
        </View>
        <View className="credits-balance-total">
          <Text className="credits-balance-number">{value ? value.available : '—'}</Text>
          <Text className="credits-balance-unit">点</Text>
        </View>
        <Text className="credits-balance-description">{description}</Text>
      </View>
      {value?.reserved > 0 && (
        <Button className="credits-reserved-entry" onClick={onReservations}>
          <Text className="credits-reserved-label">处理中占用{opening ? ' · 正在打开…' : ''}</Text>
          <Text className="credits-reserved-amount">{value.reserved} 点 ›</Text>
        </Button>
      )}
      {!!sources.rows.length && (
        <View className="credits-sources">
          <Text className="credits-sources-title">积分来源</Text>
          {sources.rows.map((row) => (
            <View className="credits-source-row" key={row.kind}>
              <Text>{row.label}</Text>
              <Text className="credits-source-amount">{row.amount} 点</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

export function CreditListFooter({ state, onLoad, onRefresh, onContinue }) {
  const message = state.error || state.warning || (state.paused ? '记录较多，已暂停更新，请继续更新' : '')
  return (
    <View className="credits-footer">
      {message && (
        <Notice
          onRetry={state.paused ? onContinue : state.error ? onLoad : onRefresh}
          label={state.paused ? '继续更新' : '重试'}
        >
          {message}
        </Notice>
      )}
      {state.loading && (
        <View className="inline-loading">
          <Brand animated />
          <Text>{state.revalidating ? '正在更新记录' : '正在读取记录'}</Text>
        </View>
      )}
      {state.loaded && !state.loading && !state.error && !state.paused && state.hasMore && (
        <Button className="text-button" onClick={onLoad}>
          {state.items.length ? '继续读取' : '当前扫描未读到记录，继续读取'}
        </Button>
      )}
      {state.loaded && !state.loading && !state.error && !state.paused && !state.hasMore && (
        <Text className="list-status">{state.items.length ? '已经看到全部记录' : '暂无记录'}</Text>
      )}
    </View>
  )
}

export function CreditLedger({ state, onOpen, onLoad, onRefresh, onContinue, openingTarget }) {
  return (
    <View className="credits-ledger">
      {ledgerGroups({ items: state.items }).map((group) => (
        <View className="credits-day" key={group.date}>
          <Text className="credits-day-title">{group.date}</Text>
          {group.rows.map((row) => (
            <View
              id={creditRowId({ view: 'ledger', id: row.id })}
              className={`credits-row credits-ledger-row ${row.taskId ? 'credits-row--linked' : ''}`}
              key={row.id}
              onClick={row.taskId ? () => onOpen(row) : undefined}
            >
              <View className="credits-ledger-copy">
                <Text className="credits-ledger-title">{row.title}</Text>
                <Text className="credits-ledger-time">{row.time}</Text>
                {openingTarget === `ledger:${row.id}` && (
                  <View className="credits-opening">
                    <Brand animated />
                    <Text>正在打开…</Text>
                  </View>
                )}
                {row.detail && <Text className="credits-ledger-detail">{row.detail}</Text>}
              </View>
              <Text className={`credits-ledger-amount credits-ledger-amount--${row.tone}`}>
                {row.amount}
                {row.taskId ? ' ›' : ''}
              </Text>
            </View>
          ))}
        </View>
      ))}
      <CreditListFooter state={state} onLoad={onLoad} onRefresh={onRefresh} onContinue={onContinue} />
    </View>
  )
}

export function CreditReservations({ state, onOpen, onLoad, onRefresh, onContinue, openingTarget }) {
  return (
    <View className="credits-reservations">
      {state.items.map((item) => {
        const row = reservationRow({ row: item })
        return (
          <View
            id={creditRowId({ view: 'reservations', id: row.reservationId })}
            className="credits-row credits-reservation"
            key={row.reservationId}
            onClick={() => onOpen(row)}
          >
            <View className="credits-reservation-copy">
              <Text className="credits-reservation-title">{row.title}</Text>
              <Text className="credits-reservation-status">{row.status}</Text>
              {openingTarget === `reservation:${row.reservationId}` && (
                <View className="credits-opening">
                  <Brand animated />
                  <Text>正在打开…</Text>
                </View>
              )}
            </View>
            <Text className="credits-reservation-amount">{row.amount} ›</Text>
          </View>
        )
      })}
      <CreditListFooter state={state} onLoad={onLoad} onRefresh={onRefresh} onContinue={onContinue} />
    </View>
  )
}
