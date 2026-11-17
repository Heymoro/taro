const warning = '收藏状态仍待核对，当前显示本次读取结果，请稍后重试读取'

function sameOwner({ left, right }) {
  return Boolean(
    left &&
      right &&
      left.userId === right.userId &&
      left.token === right.token &&
      left.expiresAt === right.expiresAt
  )
}
function slot() {
  return { epoch: 0, readers: 0, pending: new Set(), uncertain: false }
}

/** Transport fences, not favorite facts. Idle uncertainty retains only user/resource ids. */
export function createFavoriteSettlement({
  getOwner,
  now = () => Date.now(),
  setTimer = ({ callback, delay }) => setTimeout(callback, delay),
  clearTimer = ({ timer }) => clearTimeout(timer)
}) {
  const users = new Map()
  const requireOwner = ({ owner }) => {
    if (!sameOwner({ left: owner, right: getOwner() })) throw Error('AUTH_REQUIRED')
  }
  const userSlot = ({ userId }) => {
    if (!users.has(userId)) users.set(userId, { list: slot(), resources: new Map() })
    return users.get(userId)
  }
  const resourceSlot = ({ user, artifactId }) => {
    if (!user.resources.has(artifactId)) user.resources.set(artifactId, slot())
    return user.resources.get(artifactId)
  }
  const release = ({ user, userId }) => {
    for (const [id, resource] of user.resources) {
      if (!resource.pending.size && !resource.readers && !resource.uncertain) {
        user.resources.delete(id)
      }
    }
    if (!user.resources.size && !user.list.pending.size && !user.list.readers) users.delete(userId)
  }
  const write = ({ owner, artifactId, execute }) => {
    try {
      requireOwner({ owner })
    } catch (error) {
      return Promise.reject(error)
    }
    const userId = owner.userId
    const user = userSlot({ userId })
    const resource = resourceSlot({ user, artifactId })
    let settle
    // Register an always-fulfilled signal BEFORE executing native IO (which may reenter).
    const settlement = new Promise((resolve) => {
      settle = resolve
    })
    resource.pending.add(settlement)
    user.list.pending.add(settlement)
    resource.epoch++
    user.list.epoch++
    const finish = ({ uncertain }) => {
      if (uncertain) resource.uncertain = true
      resource.pending.delete(settlement)
      user.list.pending.delete(settlement)
      settle()
      release({ user, userId })
    }
    let output
    try {
      requireOwner({ owner })
      output = execute()
    } catch (error) {
      output = Promise.reject(error)
    }
    return Promise.resolve(output).then(
      (result) => {
        let current = false
        try {
          try {
            current = sameOwner({ left: owner, right: getOwner() })
          } catch {
            throw Error('AUTH_REQUIRED')
          }
          if (!current) throw Error('AUTH_REQUIRED')
          return result
        } finally {
          // Storage failure after native settlement must never strand the transport fence.
          finish({ uncertain: !current })
        }
      },
      (error) => {
        // A validated rejection remains a rejection even when its owned 401 cleared auth.
        // The request layer turns stale responses into an unconfirmed AUTH_REQUIRED instead.
        try {
          throw error
        } finally {
          finish({ uncertain: error?.isOutcomeUnknown !== false })
        }
      }
    )
  }
  const read = async ({ owner, artifactId, execute, isInterested = () => true, onWarning }) => {
    requireOwner({ owner })
    if (!isInterested()) throw Error('READ_CANCELLED')
    const userId = owner.userId
    const user = userSlot({ userId })
    const resource = artifactId === undefined ? user.list : resourceSlot({ user, artifactId })
    resource.readers++ // Keeps epoch identity alive across a complete intervening write (ABA).
    const deadline = now() + 15000
    let timer
    const expired = new Promise((resolve, reject) => {
      timer = setTimer({ callback: () => reject(Error('FAVORITE_PENDING')), delay: 15000 })
    })
    const check = () => {
      requireOwner({ owner })
      if (!isInterested()) throw Error('READ_CANCELLED')
      if (now() >= deadline) throw Error('FAVORITE_PENDING')
    }
    const wait = async ({ promise }) => {
      const result = await Promise.race([promise, expired])
      check()
      return result
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        check()
        while (resource.pending.size) {
          await wait({ promise: Promise.all([...resource.pending]) })
          check()
        }
        check()
        const epoch = resource.epoch
        const candidate = await wait({ promise: execute() })
        check()
        if (resource.epoch !== epoch) continue
        const uncertain =
          artifactId === undefined
            ? [...user.resources.values()].some((entry) => entry.uncertain)
            : resource.uncertain
        if (uncertain && onWarning) onWarning(warning)
        check()
        return candidate
      }
      throw Error('FAVORITE_PENDING')
    } finally {
      clearTimer({ timer })
      resource.readers--
      release({ user, userId })
    }
  }
  return { write, read }
}
