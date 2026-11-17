import { Button, ScrollView, Text, View } from '@tarojs/components'
import React, { useRef } from 'react'

import { Brand, NavBar, Notice } from '../../components/primitives'
import { CreditBalance, CreditLedger } from '../../features/credits/credit-panels'
import { useCreditNavigation } from '../../features/credits/use-credit-navigation'
import { useCreditWallet } from '../../features/credits/use-credit-pages'
import { useCreditScroll } from '../../features/credits/use-credit-scroll'
import { useAccount } from '../../use-account'

export default function CreditsPage() {
  const account = useAccount()
  const { owner, controller, state } = useCreditWallet({ account })
  const scrollRef = useRef(null)
  const navigation = useCreditNavigation({
    account,
    beforeDispatch: async () => {
      const target = scrollRef.current
      const stamp = await target.capture()
      return Boolean(stamp && target.owns({ stamp }))
    },
  })
  const scroll = useCreditScroll({ owner, controller, state, onIntent: navigation.cancel })
  scrollRef.current = scroll
  const accountBlocked = !owner.identityCurrent()
  const select = async ({ tab }) => {
    navigation.cancel()
    if (tab === state.view) {
      scroll.cancel()
      return
    }
    const stamp = await scroll.capture()
    if (stamp && scroll.owns({ stamp })) controller.select({ tab })
  }
  return (
    <View className="screen credits-screen">
      <NavBar title="我的积分" canBack />
      <View className="tabs credits-tabs">
        {[
          ['balance', '余额'],
          ['ledger', '明细'],
        ].map(([tab, label]) => (
          <Button
            className={`tabs__item ${state.view === tab ? 'tabs__item--active' : ''}`}
            key={tab}
            onClick={() => select({ tab })}
          >
            {label}
          </Button>
        ))}
      </View>
      <ScrollView
        id="credits-scroll"
        className={`page-scroll credits-scroll credits-scroll--${state.view}`}
        scrollY
        scrollTop={scroll.scrollTop}
        onScroll={scroll.onScroll}
        onTouchStart={scroll.onTouchStart}
        onTouchMove={scroll.onTouchMove}
        onScrollToLower={state.view === 'ledger' && !state.paused && !state.error ? () => controller.load() : undefined}
        lowerThreshold={120}
      >
        <View className={`scroll-content scroll-content--credits${state.view === 'ledger' ? ' scroll-content--ledger' : ''}`}>
          {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
          {accountBlocked && account.loading && (
            <View className="inline-loading">
              <Brand animated />
              <Text>正在读取账号</Text>
            </View>
          )}
          {!accountBlocked &&
            (state.view === 'balance' ? (
              <CreditBalance
                opening={navigation.target === '/pages/credit-reservations/index'}
                account={state.account}
                onRetry={controller.refreshAccount}
                onReservations={navigation.openReservations}
              />
            ) : (
              <CreditLedger
                openingTarget={navigation.target}
                state={state}
                onOpen={(entry) => navigation.openLedger({ entry })}
                onLoad={() => controller.load()}
                onRefresh={() => controller.refresh()}
                onContinue={() => controller.continueUpdating()}
              />
            ))}
        </View>
      </ScrollView>
    </View>
  )
}
