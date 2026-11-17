const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withCabinet } = require('../fixtures/cabinet-pages.cjs')
const listReads = (h) => h.calls.filter((c) => c.path.startsWith('/artifacts?'))
const loadPages = async (h, count) => {
  for (let page = 1; page < count; page++) await h.act(async () => h.click('cabinet', '查看更多作品'))
}
const open = async (h, index = 0) => {
  await h.act(async () => h.click('cabinet', 'image', index))
  await h.flush()
  await h.act(async () => h.render('detail'))
}

test('A actual Cabinet native return preserves three-page prefix and numerical position', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await h.act(async () => h.fire('cabinet', 'show'))
    await loadPages(h, 3)
    assert.equal(h.count(), 6)
    await h.act(async () => h.scroll(130))
    await open(h, 4)
    await h.act(async () => {
      h.native.navigateBack()
      h.unmountDetail()
    })
    await h.flush()
    assert.equal(h.count(), 6, 'native back must revalidate all three committed pages, not reset to first batch')
    assert.equal(h.top(), 130)
    assert.equal(listReads(h).length, 6, 'mount + first show share one initial GET')
  })
})
test('B actual Cabinet keeps independent all/saved prefixes, cursors and top on fresh tab switches', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await loadPages(h, 2)
    await h.act(async () => h.scroll(70))
    await h.act(async () => h.click('cabinet', '已收藏'))
    await h.flush()
    await loadPages(h, 2)
    await h.act(async () => h.scroll(90))
    const reads = listReads(h).length
    await h.act(async () => h.click('cabinet', '全部作品'))
    await h.flush()
    assert.equal(h.count(), 4, 'all prefix must survive saved filter')
    assert.equal(h.top(), 70)
    await h.act(async () => h.click('cabinet', '已收藏'))
    await h.flush()
    assert.equal(h.count(), 4)
    assert.equal(h.top(), 90)
    assert.equal(listReads(h).length, reads, 'fresh internal switches have zero first GETs')
  })
})
test('C actual Cabinet DELETE on third saved page rereads N pages from null and fills hole with fresh cursor', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await h.act(async () => h.click('cabinet', '已收藏'))
    await h.flush()
    await loadPages(h, 3)
    await h.act(async () => h.scroll(140))
    await open(h, 4)
    await h.act(async () => h.click('detail', '已收藏'))
    const before = listReads(h).length
    await h.act(async () => {
      h.native.navigateBack()
      h.unmountDetail()
    })
    await h.flush()
    assert.equal(h.count(), 6, 'server prefix fills removed saved artifact, not local filter')
    assert.deepEqual(
      listReads(h)
        .slice(before)
        .map((c) => new URL(c.path, 'https://local').searchParams.get('cursor')),
      [null, 'v1:2', 'v1:4']
    )
    assert.deepEqual(h.ids(), [1, 2, 3, 4, 6, 7])
  })
})

test('new touch cancels delayed pre-navigation capture, including its outer navigation intent', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const geometryGate = gate()
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => h.click('cabinet', 'image'))
      await h.act(async () => h.touch())
      await h.act(async () => geometryGate.resolve())
      await h.flush()
      assert.deepEqual(h.nativeCalls, [], 'cancelled geometry must not subsequently navigate')
    },
    { geometryGate }
  )
})
test('two rapid detail clicks retain only the newest pre-navigation intent', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const geometryGate = gate()
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => {
        h.click('cabinet', 'image', 0)
        h.click('cabinet', 'image', 1)
      })
      await h.act(async () => geometryGate.resolve())
      await h.flush()
      assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=2'])
    },
    { geometryGate }
  )
})
test('native stack movement before hide delivery cancels delayed geometry and navigation', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const geometryGate = gate()
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await h.act(async () => h.click('cabinet', 'image'))
      h.setForeground('detail')
      await h.act(async () => geometryGate.resolve())
      await h.flush()
      assert.deepEqual(h.nativeCalls, [])
    },
    { geometryGate }
  )
})

for (const favorite of [false, true])
  for (const header of [false, true])
    test(`actual shared API ${favorite ? 'DELETE' : 'PUT'} pending across ${
      header ? 'header' : 'native'
    } back fences Cabinet's two-page validation`, async () => {
      const { gate } = require('../fixtures/cabinet-pages.cjs')
      const writeGate = gate()
      await withCabinet(
        async (h) => {
          await h.act(async () => h.render())
          await loadPages(h, 2)
          await open(h, 3)
          await h.act(async () => h.click('detail', favorite ? '已收藏' : '收藏'))
          const before = listReads(h).length
          await h.act(async () => {
            if (header) h.click('detail', 'header-back')
            else h.native.navigateBack()
            h.unmountDetail()
          })
          assert.equal(
            listReads(h).length,
            before,
            'list GET waits for native write settlement, even after detail unmount'
          )
          assert.equal(h.count(), 4, 'old committed prefix remains visible while pending')
          await h.act(async () => writeGate.resolve())
          await h.flush()
          assert.equal(listReads(h).length, before + 2)
          assert.equal(h.count(), 4)
          assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 1)
          assert.equal(h.calls.find((call) => call.method !== 'GET').method, favorite ? 'DELETE' : 'PUT')
          assert.deepEqual(h.ids(), [1, 2, 3, 4])
          const again = listReads(h).length
          await h.act(async () => h.fire('cabinet', 'show'))
          assert.equal(listReads(h).length, again, 'repeated visible show causes no second GET churn')
        },
        { favorite, writeGate }
      )
    })
for (const outcome of ['unknown', 'reject'])
  test(`actual shared API ${outcome} write rereads server observation without favorite replay and with one Notice`, async () => {
    const { gate } = require('../fixtures/cabinet-pages.cjs')
    const writeGate = gate()
    await withCabinet(
      async (h) => {
        await h.act(async () => h.render())
        await h.act(async () => h.click('cabinet', '已收藏'))
        await h.flush()
        await loadPages(h, 2)
        await open(h, 3)
        await h.act(async () => h.click('detail', '已收藏'))
        await h.act(async () => {
          h.native.navigateBack()
          h.unmountDetail()
        })
        await h.act(async () => writeGate.resolve())
        await h.flush()
        assert.deepEqual(h.ids(), [1, 2, 3, 4], 'DTO remains server observation, not unconfirmed mutation')
        const notices = document.querySelectorAll('#cabinet aside')
        assert.equal(notices.length, outcome === 'unknown' ? 1 : 0)
        if (outcome === 'unknown') {
          assert.match(notices[0].textContent, /当前显示本次读取结果/)
          await h.act(async () => h.click('cabinet', '重试'))
          await h.flush()
          assert.equal(document.querySelectorAll('#cabinet aside').length, 1)
        }
        assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 1)
      },
      { writeGate, outcome }
    )
  })

test('actual list read begun before favorite waits after invalidation and only publishes second server GET', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const pendingRead = gate(),
    writeGate = gate()
  let hold = false,
    held = false
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 2)
      hold = true
      const before = listReads(h).length
      await h.act(async () => {
        h.fire('cabinet', 'hide')
        h.fire('cabinet', 'show')
      })
      assert.equal(listReads(h).length, before + 1)
      const write = h.api.favorite({ artifactId: 4, isFavorite: false })
      await h.act(async () => pendingRead.resolve())
      assert.equal(listReads(h).length, before + 1, 'invalidated GET must not publish or bypass pending favorite')
      await h.act(async () => writeGate.resolve())
      await write
      await h.flush()
      assert.equal(listReads(h).length, before + 3, 'fenced retry first page + second prefix page')
      assert.equal(h.count(), 4)
    },
    {
      writeGate,
      readGate: async () => {
        if (hold && !held) {
          held = true
          await pendingRead.promise
        }
      },
    }
  )
})

test('actual API pending timeout keeps committed prefix and retry remains read-only', async (t) => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writeGate = gate()
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 2)
      await open(h, 3)
      await h.act(async () => h.click('detail', '已收藏'))
      const before = listReads(h).length
      await h.act(async () => {
        h.native.navigateBack()
        h.unmountDetail()
      })
      await h.act(async () => t.mock.timers.tick(15000))
      assert.equal(h.count(), 4)
      assert.equal(listReads(h).length, before)
      assert.match(document.querySelector('#cabinet aside').textContent, /仍待核对/)
      await h.act(async () => writeGate.resolve())
      await h.act(async () => h.click('cabinet', '重试'))
      await h.flush()
      assert.equal(h.count(), 4)
      assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 1)
      assert.equal(document.querySelectorAll('#cabinet aside').length, 0)
    },
    { writeGate }
  )
})

test('full key rotation synchronously suppresses old prefix/warning and late response in same user', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const response = gate()
  let blocked = false
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 2)
      blocked = true
      await h.act(async () => {
        h.fire('cabinet', 'hide')
        h.fire('cabinet', 'show')
      })
      h.setCredential({ ...h.getCredential(), expiresAt: '2099-02-01T00:00:00.000Z' })
      await h.act(async () => h.render())
      assert.equal(h.count(), 0, 'no one-frame old owner prefix')
      assert.equal(document.querySelectorAll('#cabinet aside').length, 0)
      h.setRows([11, 12, 13, 14])
      await h.act(async () => response.resolve())
      await h.flush()
      assert.deepEqual(h.ids(), [11, 12])
      assert.equal(h.top(), 0)
    },
    {
      readGate: async () => {
        if (blocked) await response.promise
      },
    }
  )
})

test('fresh prefix restores stable first-visible artifact viewport offset after earlier rows disappear', async () => {
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 4)
      await h.act(async () => h.scroll(300))
      await open(h, 4)
      h.setRows([3, 4, 5, 6, 7, 8, 9, 10])
      await h.act(async () => {
        h.native.navigateBack()
        h.unmountDetail()
      })
      await h.flush()
      assert.equal(h.top(), 150, 'id5 moved from row3 to row2, preserving offset without hardcoded native row height')
    },
    { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
  )
})
test('removed anchor restores measured neighbor, and an entirely vanished prefix clamps numeric fallback', async () => {
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 4)
      await h.act(async () => h.scroll(300))
      await open(h, 4)
      h.setRows([3, 4, 6, 7, 8, 9, 10, 11])
      await h.act(async () => {
        h.native.navigateBack()
        h.unmountDetail()
      })
      await h.flush()
      assert.equal(h.top(), 150, 'anchor id5 gone: measured neighbor id3 retains its previous viewport offset')
      await open(h)
      h.setRows([80, 81])
      await h.act(async () => {
        h.native.navigateBack()
        h.unmountDetail()
      })
      await h.flush()
      assert.equal(h.top(), 0, 'no anchor or neighbor: clamp to measured native content bounds')
    },
    { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
  )
})
test('manual scroll supersedes queued nextTick restoration after native return', async () => {
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 4)
      await h.act(async () => h.scroll(300))
      await open(h, 4)
      h.setRows([3, 4, 5, 6, 7, 8, 9, 10])
      await h.act(async () => {
        h.native.navigateBack()
        h.unmountDetail()
      })
      await h.act(async () => h.scroll(60))
      await h.flush()
      assert.equal(h.top(), 60)
    },
    { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
  )
})
test('geometry failure retains numeric top and detail navigation; unmount cancels queued nextTick', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await loadPages(h, 3)
    await h.act(async () => h.scroll(120))
    h.native.createSelectorQuery = () => {
      throw Error('native geometry unavailable')
    }
    await open(h, 4)
    assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=5'])
    await h.act(async () => {
      h.native.navigateBack()
      h.unmountDetail()
    })
    await h.flush()
    assert.equal(h.top(), 120)
    await h.act(async () => h.unmountCabinet())
    await h.flush()
    assert.equal(h.nativeCalls.length, 2)
  })
})

test('actual Cabinet pauses large prefix at 20 reads and requires explicit Continue instead of scroll auto-loop', async () => {
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 25)
      assert.equal(h.count(), 50)
      const before = listReads(h).length
      await h.act(async () => {
        h.fire('cabinet', 'hide')
        h.fire('cabinet', 'show')
      })
      assert.equal(listReads(h).length, before + 20)
      assert.equal(document.querySelectorAll('#cabinet aside').length, 1)
      assert.match(document.querySelector('#cabinet aside').textContent, /继续更新/)
      assert.equal(h.handlers.get('cabinet:page-scroll').onScrollToLower, undefined)
      await h.act(async () => h.click('cabinet', '继续更新'))
      await h.flush()
      assert.equal(listReads(h).length, before + 25)
      assert.equal(h.count(), 50)
      assert.equal(document.querySelectorAll('#cabinet aside').length, 0)
    },
    { rows: Array.from({ length: 60 }, (_, index) => index + 1) }
  )
})
for (const interruption of ['touch', 'hide', 'dispose', 'account', 'stack'])
  test(`late post-commit geometry is inert after ${interruption}`, async () => {
    const { gate } = require('../fixtures/cabinet-pages.cjs')
    const geometry = gate()
    await withCabinet(
      async (h) => {
        await h.act(async () => h.render())
        await loadPages(h, 4)
        await h.act(async () => h.scroll(300))
        await open(h, 4)
        h.setRows([3, 4, 5, 6, 7, 8, 9, 10])
        const query = h.native.createSelectorQuery
        h.native.createSelectorQuery = () => {
          const q = query(),
            exec = q.exec
          q.exec = (cb) => exec((result) => geometry.promise.then(() => cb(result)))
          return q
        }
        await h.act(async () => {
          h.native.navigateBack()
          h.unmountDetail()
        })
        await h.flush()
        assert.equal(h.top(), 300, 'numeric top is available before delayed native query')
        await h.act(async () => {
          if (interruption === 'touch') {
            h.touch()
            h.scroll(60)
          }
          if (interruption === 'hide') h.fire('cabinet', 'hide')
          if (interruption === 'dispose') h.unmountCabinet()
          if (interruption === 'account') {
            h.setCredential({ ...h.getCredential(), token: 'B'.repeat(42) + 'A' })
            h.render()
          }
          if (interruption === 'stack') h.setForeground('detail')
        })
        await h.act(async () => geometry.resolve())
        await h.flush()
        assert.equal(h.top(), interruption === 'touch' ? 60 : interruption === 'account' ? 0 : 300)
        assert.equal(h.nativeCalls.length, 2, 'geometry does not produce extra navigation')
      },
      { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }
    )
  })

test('rapid saved then all tab intent cancels unpublished saved switch without an extra GET', async () => {
  const { gate } = require('../fixtures/cabinet-pages.cjs')
  const geometryGate = gate()
  await withCabinet(
    async (h) => {
      await h.act(async () => h.render())
      const reads = listReads(h).length
      await h.act(async () => {
        h.click('cabinet', '已收藏')
        h.click('cabinet', '全部作品')
      })
      await h.act(async () => geometryGate.resolve())
      await h.flush()
      assert.equal(listReads(h).length, reads)
      assert.match(document.querySelector('#cabinet .tabs__item--active').textContent, /全部作品/)
    },
    { geometryGate }
  )
})
test('late native scroll callback from previous view does not overwrite current view position', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await loadPages(h, 3)
    const oldScroll = h.handlers.get('cabinet:page-scroll').onScroll
    await h.act(async () => h.click('cabinet', '已收藏'))
    await h.flush()
    await loadPages(h, 3)
    await h.act(async () => h.scroll(90))
    await h.act(async () => oldScroll({ detail: { scrollTop: 200 } }))
    assert.equal(h.top(), 90)
  })
})
test('native query without callback times out to numeric capture and does not block detail navigation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await loadPages(h, 3)
    await h.act(async () => h.scroll(120))
    h.native.createSelectorQuery = () => {
      const q = { select: () => q, selectAll: () => q, boundingClientRect: () => q, scrollOffset: () => q, exec() {} }
      return q
    }
    await h.act(async () => h.click('cabinet', 'image', 4))
    assert.equal(h.nativeCalls.length, 0)
    await h.act(async () => t.mock.timers.tick(120))
    assert.deepEqual(h.nativeCalls, ['/pages/artifact/index?id=5'])
    await h.act(async () => {
      h.native.navigateBack()
      h.unmountDetail()
    })
    assert.equal(h.top(), 120)
  })
})

// Cabinet's own native transition, not a generic navigation queue. Stack/hide
// delivery is deliberately independent of both callback and Promise settlement.
function pendingNavigation({ h, callbacksOnly = false }) {
  const attempts = [],
    feedback = []
  h.native.showToast = (options) => {
    feedback.push(options)
    return Promise.resolve({})
  }
  h.native.navigateTo = (options) => {
    let resolve, reject
    const promise = new Promise((yes, no) => {
      resolve = yes
      reject = no
    })
    attempts.push({ options, resolve, reject })
    return callbacksOnly ? undefined : promise
  }
  return { attempts, feedback }
}

test('native navigateTo pending after capture permits only one dispatch despite second tap, touch, rerender or elapsed time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const { attempts, feedback } = pendingNavigation({ h })
    await h.act(async () => h.click('cabinet', 'image', 0))
    assert.equal(attempts.length, 1)
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 1, 'root review repro: native pending is later than capture completion')
    await h.act(async () => {
      h.touch()
      h.render()
      t.mock.timers.tick(60000)
    })
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 1, 'no timeout or geometry cancellation unlocks an unsettled native operation')
    assert.equal(feedback.length, 0)
    await h.act(async () => attempts[0].resolve({}))
  })
})

test('rejected native navigateTo Promise is consumed, emits controlled feedback, and permits only a manual retry', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const feedback = [],
      attempts = []
    h.native.showToast = (options) => {
      feedback.push(options)
      return Promise.resolve({})
    }
    h.native.navigateTo = (options) => {
      attempts.push(options)
      return Promise.reject(Error('NATIVE_NAV_FAILED'))
    }
    await h.act(async () => h.click('cabinet', 'image', 0))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(attempts.length, 1, 'failure must not replay navigation')
    assert.equal(feedback.length, 1, 'spec review repro: consume rejection with current-owner feedback')
    assert.match(feedback[0].title, /未打开.*重试/)
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 2)
    assert.equal(feedback.length, 2)
    assert.equal(h.count(), 2, 'navigation failure does not reset list DTOs')
  })
})

for (const kind of ['callback', 'throw'])
  test(`native ${kind} failure is controlled and a stale duplicate failure cannot release the next navigation`, async () => {
    await withCabinet(async (h) => {
      await h.act(async () => h.render())
      const { attempts, feedback } = pendingNavigation({ h, callbacksOnly: true })
      const queued = h.native.navigateTo
      if (kind === 'throw')
        h.native.navigateTo = (options) => {
          queued(options)
          throw Error('NATIVE_NAV_FAILED')
        }
      await h.act(async () => h.click('cabinet', 'image', 0))
      if (kind === 'callback') await h.act(async () => attempts[0].options.fail?.({ errMsg: 'failed' }))
      assert.equal(attempts.length, 1)
      assert.equal(feedback.length, 1)
      h.native.navigateTo = queued
      await h.act(async () => h.click('cabinet', 'image', 1))
      assert.equal(attempts.length, 2)
      await h.act(async () => {
        attempts[0].options.fail?.({ errMsg: 'duplicate late fail' })
        attempts[0].options.success?.({})
      })
      await h.act(async () => h.click('cabinet', 'image', 0))
      assert.equal(attempts.length, 2, 'old settlement cannot unlock the new pending transition')
      assert.equal(feedback.length, 1)
      await h.act(async () => attempts[1].options.success?.({}))
    })
  })

test('callback success plus rejected Promise settles once and holds native transition until actual hide and return', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const { attempts, feedback } = pendingNavigation({ h })
    await h.act(async () => h.click('cabinet', 'image', 0))
    await h.act(async () => {
      attempts[0].options.success?.({})
      attempts[0].reject(Error('late contradictory native rejection'))
    })
    await new Promise((resolve) => setImmediate(resolve))
    await h.act(async () => {
      h.touch()
      h.click('cabinet', 'image', 1)
    })
    assert.equal(
      attempts.length,
      1,
      'success receipt before lifecycle delivery is not an invitation to enqueue another page'
    )
    assert.equal(feedback.length, 0)
    await h.act(async () => {
      h.fire('cabinet', 'hide')
      h.fire('cabinet', 'show')
    })
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 2, 'normal native return permits the next explicit visit')
    await h.act(async () => attempts[1].resolve({}))
  })
})

test('Promise success without callback is accepted once and normal return permits another explicit visit', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const { attempts, feedback } = pendingNavigation({ h })
    await h.act(async () => h.click('cabinet', 'image', 0))
    await h.act(async () => attempts[0].resolve({}))
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 1)
    await h.act(async () => {
      h.fire('cabinet', 'hide')
      h.fire('cabinet', 'show')
    })
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 2)
    assert.equal(feedback.length, 0)
    await h.act(async () => attempts[1].resolve({}))
  })
})

for (const interruption of ['hide', 'return', 'dispose', 'account'])
  test(`late native failure after ${interruption} is consumed without stale feedback or automatic navigation`, async () => {
    await withCabinet(async (h) => {
      await h.act(async () => h.render())
      const { attempts, feedback } = pendingNavigation({ h })
      await h.act(async () => h.click('cabinet', 'image', 0))
      await h.act(async () => {
        if (interruption === 'hide' || interruption === 'return') h.fire('cabinet', 'hide')
        if (interruption === 'return') h.fire('cabinet', 'show')
        if (interruption === 'dispose') h.unmountCabinet()
        if (interruption === 'account') {
          h.setCredential({ ...h.getCredential(), expiresAt: '2099-03-01T00:00:00.000Z' })
          h.render()
        }
      })
      if (interruption === 'return') {
        await h.act(async () => h.click('cabinet', 'image', 1))
        assert.equal(attempts.length, 1, 'hide/show alone must not release a still-unsettled operation')
      }
      await h.act(async () => attempts[0].reject(Error('late native failure')))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(feedback.length, 0)
      assert.equal(attempts.length, 1)
      if (interruption === 'return' || interruption === 'account') {
        await h.act(async () => h.click('cabinet', 'image', 1))
        assert.equal(attempts.length, 2, 'manual visit after old terminal settlement is separate')
        await h.act(async () => attempts[0].options.fail?.({ errMsg: 'old duplicate failure' }))
        await h.act(async () => h.click('cabinet', 'image', 0))
        assert.equal(attempts.length, 2, 'late old callback cannot release replacement navigation')
        await h.act(async () => attempts[1].resolve({}))
      }
    })
  })

test('native call with neither result nor callback remains pending across time and hide/show until explicit settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    const { attempts, feedback } = pendingNavigation({ h, callbacksOnly: true })
    await h.act(async () => h.click('cabinet', 'image', 0))
    await h.act(async () => {
      h.fire('cabinet', 'hide')
      h.fire('cabinet', 'show')
      t.mock.timers.tick(60000)
    })
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 1)
    assert.equal(feedback.length, 0)
    await h.act(async () => attempts[0].options.fail({ errMsg: 'late explicit failure' }))
    assert.equal(feedback.length, 0, 'old visit after return does not emit stale failure feedback')
    await h.act(async () => h.click('cabinet', 'image', 1))
    assert.equal(attempts.length, 2)
    await h.act(async () => attempts[1].options.success({}))
  })
})

for (const replacement of ['account', 'remount'])
  test(`old pending native callback and Promise cannot unlock a new ${replacement} owner's navigation`, async () => {
    await withCabinet(async (h) => {
      await h.act(async () => h.render())
      const { attempts, feedback } = pendingNavigation({ h })
      await h.act(async () => h.click('cabinet', 'image', 0))
      await h.act(async () => {
        if (replacement === 'account') {
          h.setCredential({ ...h.getCredential(), expiresAt: '2099-04-01T00:00:00.000Z' })
        } else h.unmountCabinet()
      })
      await h.act(async () => h.render())
      await h.act(async () => h.click('cabinet', 'image', 1))
      assert.equal(attempts.length, 2)
      await h.act(async () => {
        attempts[0].options.fail({ errMsg: 'old owner failed' })
        attempts[0].reject(Error('old owner native rejection'))
      })
      await new Promise((resolve) => setImmediate(resolve))
      await h.act(async () => h.click('cabinet', 'image', 0))
      assert.equal(attempts.length, 2, 'late old settlement cannot release new owner single-flight')
      assert.equal(feedback.length, 0)
      await h.act(async () => attempts[1].resolve({}))
    })
  })

test('Cabinet previous committed revision scroll callback cannot overwrite a newly restored same-view position', async () => {
  await withCabinet(async (h) => {
    await h.act(async () => h.render())
    await h.flush()
    const oldScroll = h.handlers.get('cabinet:page-scroll').onScroll
    await h.act(async () => h.fire('cabinet', 'hide'))
    await h.act(async () => h.fire('cabinet', 'show'))
    await h.flush()
    const expected = h.top()
    await h.act(async () => oldScroll({ detail: { scrollTop: 999 } }))
    assert.equal(h.top(), expected, 'old same-view revision callback must not publish a new scroll position')
    await h.act(async () => h.scroll(31))
    assert.equal(h.top(), 31, 'current-revision manual scrolling retains priority')
  })
})

for (const event of ['onTouchStart', 'onTouchMove'])
  test(`Cabinet previous-revision ${event} cannot cancel current same-view geometry restoration`, async () => {
    await withCabinet(async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 3)
      await h.flush()
      await h.act(async () => h.scroll(130))
      await h.act(async () => h.click('cabinet', 'image', 2))
      const old = h.handlers.get('cabinet:page-scroll')
      await h.act(async () => h.fire('cabinet', 'show'))
      h.setRows([3, 4, 5, 6, 7, 8])
      await h.act(async () => {
        h.fire('cabinet', 'hide')
        h.fire('cabinet', 'show')
      })
      await h.act(async () => old[event]())
      await h.flush()
      assert.equal(h.top(), 0, 'a previous committed revision touch must not cancel the fresh anchor restore')
      await h.act(async () => h.scroll(29))
      assert.equal(h.top(), 29)
    })
  })

for (const intent of ['programmatic', 'manual', 'onTouchStart', 'onTouchMove'])
  test(`Cabinet current revision ${intent} retains native restoration priority`, async () => {
    await withCabinet(async (h) => {
      await h.act(async () => h.render())
      await loadPages(h, 3)
      await h.flush()
      await h.act(async () => h.scroll(130))
      await h.act(async () => h.click('cabinet', 'image', 2))
      h.setRows([3, 4, 5, 6, 7, 8])
      await h.act(async () => h.fire('cabinet', 'show'))
      await h.act(async () => {
        const handler = h.handlers.get('cabinet:page-scroll')
        if (intent.startsWith('onTouch')) handler[intent]()
        else handler.onScroll({ detail: { scrollTop: intent === 'programmatic' ? 130 : 44 } })
      })
      await h.flush()
      assert.equal(h.top(), intent === 'programmatic' ? 0 : intent === 'manual' ? 44 : 130)
    })
  })
