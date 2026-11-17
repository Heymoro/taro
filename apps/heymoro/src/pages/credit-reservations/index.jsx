import { ScrollView, Text, View } from '@tarojs/components'
import React, { useRef } from 'react'

import { Brand, NavBar, Notice } from '../../components/primitives'
import { CreditReservations } from '../../features/credits/credit-panels'
import { useCreditNavigation } from '../../features/credits/use-credit-navigation'
import { useCreditReservations } from '../../features/credits/use-credit-pages'
import { useCreditScroll } from '../../features/credits/use-credit-scroll'
import { useAccount } from '../../use-account'

export default function CreditReservationsPage() {
  const account = useAccount()
  const { owner, controller, state } = useCreditReservations({ account })
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
  return (
    <View className="screen credits-screen">
      <NavBar title="占用中的创作" canBack />
      <ScrollView
        id="credits-scroll"
        className="page-scroll credits-scroll credits-scroll--reservations"
        scrollY
        scrollTop={scroll.scrollTop}
        onScroll={scroll.onScroll}
        onTouchStart={scroll.onTouchStart}
        onTouchMove={scroll.onTouchMove}
        onScrollToLower={!state.paused && !state.error ? () => controller.load() : undefined}
        lowerThreshold={120}
      >
        <View className="scroll-content scroll-content--credits">
          {account.error && <Notice onRetry={account.refresh}>{account.error}</Notice>}
          {!owner.identityCurrent() && account.loading && (
            <View className="inline-loading">
              <Brand animated />
              <Text>正在读取账号</Text>
            </View>
          )}
          {owner.identityCurrent() && (
            <CreditReservations
              openingTarget={navigation.target}
              state={state}
              onOpen={(reservation) => navigation.openReservation({ reservation })}
              onLoad={() => controller.load()}
              onRefresh={() => controller.refresh()}
              onContinue={() => controller.continueUpdating()}
            />
          )}
        </View>
      </ScrollView>
    </View>
  )
}
