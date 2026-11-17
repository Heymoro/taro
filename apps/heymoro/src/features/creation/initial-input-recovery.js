import { createDraftStorage, sameDraftFingerprint as same } from './draft-storage'
import { templateEntryKey } from './entry-draft'
import {
  overlayInitialFields,
  preserveDraftProvenanceOmission,
  resolveEntrySource,
  sessionDraftBase,
  sessionReceiptDesired
} from './entry-load'
import {
  decodeInitialInputIntent,
  encodeInitialInputIntent,
  fingerprintInitialInputValue,
  planInitialInputReplay,
  prepareInitialInputIntent,
  readCompleteOrdinaryRecord
} from './initial-input-intent'
import {
  hasRecoverablePhotoSlots,
  readRecoveryEntry,
  readUnsettledRecord
} from './recovery-contract'
import {
  classifyCreationTargets,
  proveSessionCreationOrigin,
  readSessionCreationCandidate,
  sessionCreationRecoveryKey
} from './session-creation-origin'

const copy = (v) => JSON.parse(JSON.stringify(v))
const fp = (value) => fingerprintInitialInputValue({ value })
const fields = ['description', 'userNotes', 'photos', 'carryBackSourceTaskId']
const keyFor = (b) => `unsettled:template:${b.mode === 'free' ? 'free' : b.templateId}`
const message = '本机输入尚未保存完成，请不要关闭页面；原记录已保留'

/** Sole owner of source roles, durable intent phases and observational ownership. */
export function createInitialInputRecovery({
  storage,
  entry,
  originStorageKey = entry.key,
  isInterested
}) {
  let actionGuard = null
  const io = createDraftStorage({
    storage,
    isInterested: ({ epoch }) =>
      isInterested({ epoch }) && (!actionGuard || actionGuard())
  })
  const journalKey = `initial-input:${entry.key}`
  const observations = new Map()
  let initialized = false
  // A source candidate is not usable until its required F/target ownership reads finish.
  let sourceResolutionComplete = false
  let transientSourceBlock = false
  let busy = false
  let binding = null
  let server = null
  let decision = { status: 'pending' }
  let phase = 'uninspected'
  let journal = null
  let journalFingerprint = null
  let overlay = {}
  const overlayVersions = new Map()
  let revision = 0
  let durableRevision = 0
  let journalRevision = 0
  let sourceRevision = 0
  let localTicket = null
  let actionAnchor = null
  let feedbackRevision = 0
  let feedback = null
  let attempt = null
  let frozen = null
  let frozenConflict = false
  let creationPending = false
  let creationOriginKey = null
  let blockedProjection = null
  let recoveryKey =
    entry.kind === 'session' ? `unsettled:session:${entry.sessionId}` : keyFor(entry)
  let primaryKey = entry.key
  let normalTargets = []
  const context = () => ({ entry, binding })
  const interested = (epoch) => {
    try {
      return !!isInterested({ epoch })
    } catch {
      return false
    }
  }
  function fail(status = 'blocked', owner = 'initial-input') {
    if (status !== 'cancelled') feedback = { owner, revision: ++feedbackRevision, message }
    if (status === 'conflict') phase = 'conflict'
    return result(status === 'conflict' ? 'blocked' : status)
  }
  function getFacts() {
    const activeIntent =
      !!journal || phase === 'invalid-intent' || attempt?.owner === 'initial-input'
    const sourceReady = sourceResolutionComplete && !frozenConflict && decision.status === 'ready'
    let lane = 'pending'
    if (frozenConflict) lane = 'conflict'
    else if (frozen) lane = activeIntent ? 'frozen-initial' : 'frozen'
    else if (activeIntent) lane = 'initial'
    else if (sourceReady) lane = 'normal'
    let phaseMessage = ''
    if (frozenConflict) phaseMessage = '原未结记录存在冲突，所有原记录已保留；当前输入未保存'
    else if (frozen && activeIntent) {
      phaseMessage = '仅可核对原请求；本机初始输入记录和当前新输入仍待处理'
    } else if (phase === 'invalid-intent') {
      phaseMessage = '本机初始输入记录未通过校验，原记录已保留；当前新输入尚未保存'
    } else if (phase === 'conflict') {
      phaseMessage = '本机输入来源发生冲突，原记录已保留；当前新输入尚未保存'
    }
    return {
      phase,
      sourceReady,
      knownCreationSessionId: frozen?.originProof?.knownSessionId ?? null,
      creationPending,
      activeIntent,
      frozen: frozenConflict ? 'conflict' : sourceResolutionComplete && frozen ? 'valid' : 'none',
      lane,
      primaryKey,
      recoveryKey,
      preserved: !!decision.preserved,
      canRetryLocalSave:
        sourceReady &&
        activeIntent &&
        !frozen &&
        !frozenConflict &&
        ['pending-ready', 'prepared', 'unconfirmed'].includes(phase),
      hasUnsavedOverlay: revision > durableRevision,
      message:
        phaseMessage ||
        (feedback?.owner === 'initial-input' ? feedback.message : '') ||
        (activeIntent
          ? sourceReady
            ? '原输入已加载，请保存本机输入后再获取报价'
            : '早期输入已暂存，正在等待原输入加载'
          : revision > durableRevision
            ? '最新编辑尚未保存到本机，请不要关闭页面'
            : sourceReady
              ? ''
              : '原输入尚未确认，当前编辑未保存')
    }
  }
  function project({ overlay: additional = {} } = {}) {
    const base = sourceResolutionComplete ? frozen?.record || decision.base : null
    if (!base) {
      return {
        ...(entry.kind === 'session' ? { sessionId: entry.sessionId } : {}),
        ...(blockedProjection || {}),
        ...copy(journal?.patch || {}),
        ...copy(overlay),
        ...copy(additional)
      }
    }
    return {
      ...(blockedProjection || {}),
      ...overlayInitialFields({
        base,
        patch: { ...(journal?.patch || {}), ...overlay, ...additional }
      }),
      ...(entry.kind === 'session' ? { sessionId: entry.sessionId } : {})
    }
  }
  function result(status) {
    return {
      status,
      projection: project(),
      facts: getFacts(),
      ...(feedback ? { error: { ...feedback } } : {})
    }
  }
  function read(epoch, key) {
    const out = io.read({ epoch, key })
    if (out.status !== 'read') return null
    if (!observations.has(key)) observations.set(key, out)
    return out
  }
  function write(epoch, key, expected, desired, owner = 'initial-input') {
    const out = io.compareAndSet({ epoch, key, expected, desired })
    if (out.status === 'written') {
      observations.set(key, { value: copy(desired), fingerprint: out.fingerprint })
      return true
    }
    if (out.attempt) {
      attempt = { ...out.attempt, value: copy(desired), owner }
      phase = 'unconfirmed'
    } else if (out.status === 'conflict') phase = 'conflict'
    fail(out.status === 'cancelled' ? 'cancelled' : out.attempt ? 'unconfirmed' : 'blocked', owner)
    return false
  }
  function frozenAt(epoch) {
    const envelope = read(epoch, recoveryKey)
    if (!envelope) return false
    if (envelope.value != null) {
      const checked = readRecoveryEntry({
        value: envelope.value,
        recoveryKey,
        storageKey: originStorageKey
      })
      if (!checked) {
        frozenConflict = true
        return false
      }
      // A shared template generation journal belongs only to its bound session.
      if (entry.kind === 'session' && checked.record.sessionId !== null &&
        checked.record.sessionId !== entry.sessionId) return true
      const source = read(epoch, checked.draftKey)
      if (!source) return false
      if (checked.record.sessionRequest) {
        const candidate = readSessionCreationCandidate({ value: envelope.value, recoveryKey, originStorageKey })
        const receipt = {
          id: Number.isSafeInteger(source.value?.sessionId) && source.value.sessionId > 0 ? source.value.sessionId : 1,
          mode: checked.record.mode,
          templateId: checked.record.templateId,
        }
        const classification = classifyCreationTargets({ record: checked.record, receipt, source: source.value })
        if (candidate.status !== 'candidate' || classification.status !== 'ready') {
          frozenConflict = true
          return false
        }
        const aliases = []
        if (classification.sourceStage === 'desired') {
          const key = `session:${receipt.id}`
          const alias = read(epoch, key)
          if (!alias) return false
          if (classifyCreationTargets({
            record: checked.record,
            receipt,
            source: source.value,
            alias: alias.value
          }).status !== 'ready') {
            frozenConflict = true
            return false
          }
          aliases.push({ key, fingerprint: alias.fingerprint })
        }
        frozen = {
          ...checked,
          envelopeFingerprint: envelope.fingerprint,
          primaryFingerprint: source.fingerprint,
          aliases
        }
        primaryKey = checked.draftKey
        return true
      }
      const sourcePending = readUnsettledRecord({ record: source.value })
      // The envelope is crash authority even after one target has reached deterministic settlement.
      const frozenBinding = {
        mode: checked.record.mode,
        templateId: checked.record.templateId,
        sessionId: checked.record.sessionId
      }
      const ordinary =
        source.value === undefined ||
        readCompleteOrdinaryRecord({
          context: { entry, binding: frozenBinding },
          record: source.value
        }).ok
      const receiptPrior =
        checked.record.sessionRequest &&
        source.value &&
        source.value.sessionRequest === null &&
        same(
          fp(
            sessionReceiptDesired({
              frozenRecord: checked.record,
              receipt: {
                id: source.value.sessionId,
                templateId: checked.record.templateId,
              }
            })
          ).value,
          source.fingerprint
        )
      if (
        sourcePending ? sourcePending.identity !== checked.identity : !ordinary && !receiptPrior
      ) {
        frozenConflict = true
        return false
      }
      frozen = {
        ...checked,
        envelopeFingerprint: envelope.fingerprint,
        primaryFingerprint: source.fingerprint
      }
      primaryKey = checked.draftKey
      return true
    }
    return true
  }
  function retainedBoundKeys() {
    const key = templateEntryKey({ key: entry.key, binding })
    return Object.prototype.hasOwnProperty.call(binding, 'templateVersionId')
      ? [`${key}:${binding.templateVersionId}`, key]
      : [key]
  }
  function observeBoundKeys(epoch) {
    if (!binding || entry.kind !== 'template') return true
    const currentKey = templateEntryKey({ key: entry.key, binding })
    const keys = retainedBoundKeys()
    try {
      if (!interested(epoch)) return false
      if (storage.listKeys) {
        const prefix = `${currentKey}:`
        const aliases = storage.listKeys({ prefix })
        if (!interested(epoch)) return false
        if (!Array.isArray(aliases) || aliases.some((key) => typeof key !== 'string')) return false
        for (const key of aliases) {
          const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : ''
          if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(Number(suffix))) keys.push(key)
        }
      }
    } catch { return false }
    for (const key of new Set(keys)) {
      if (!observations.has(key) && !read(epoch, key)) return false
      const value = observations.get(key).value
      if (key !== currentKey && value !== undefined &&
        (!value || value.mode !== binding.mode || value.templateId !== binding.templateId ||
          (Object.prototype.hasOwnProperty.call(value, 'templateVersionId') &&
            value.templateVersionId !== Number(key.slice(currentKey.length + 1))))) {
        phase = 'conflict'
        return false
      }
    }
    return interested(epoch)
  }
  function observeOrdinarySource(epoch, origin) {
    const generic = readCompleteOrdinaryRecord({
      context: { entry, binding: null },
      record: origin.value
    })
    if (generic.ok) binding = generic.value.binding
    if (!observeBoundKeys(epoch)) return false
    const candidates = [...observations]
      .filter(([key]) => !key.startsWith('unsettled:') && key !== journalKey)
      .map(([key, value]) => ({ key, value: value.value }))
    for (const candidate of candidates) {
      const raw = candidate.value
      if (
        raw &&
        typeof raw === 'object' &&
        (raw.sessionRequest != null || raw.submission != null) &&
        !readUnsettledRecord({ record: raw })
      ) {
        frozenConflict = true
        blockedProjection = { corruptPending: true }
        return false
      }
    }
    const references = candidates
      .map((c) =>
        readCompleteOrdinaryRecord({ context: { entry, binding: null }, record: c.value })
      )
      .filter(
        (r) =>
          r.ok &&
          (!binding ||
            ['mode', 'templateId'].every(
              (key) => r.value.binding[key] === binding[key]
            ))
      )
    if (
      references.length &&
      references.every(
        (r) => JSON.stringify(r.value.binding) === JSON.stringify(references[0].value.binding)
      )
    ) {
      binding = references[0].value.binding
    }
    const ids = [
      ...new Set(references.map((r) => r.value.binding.sessionId).filter((id) => id !== null))
    ]
    if (ids.length > 1) {
      phase = 'conflict'
      return false
    }
    if (ids.length) {
      const aliasKey = `session:${ids[0]}`
      if (!observations.has(aliasKey) && !read(epoch, aliasKey)) return false
      const alias = observations.get(aliasKey)
      const pending = readUnsettledRecord({ record: alias.value })
      if (pending) {
        // Only this independently validated ordinary reference may nominate the alias.
        if (
          ['mode', 'templateId', 'sessionId'].some(
            (key) => alias.value[key] !== binding[key]
          ) || (Object.prototype.hasOwnProperty.call(alias.value, 'templateVersionId') &&
            Object.prototype.hasOwnProperty.call(binding, 'templateVersionId') &&
            alias.value.templateVersionId !== binding.templateVersionId)
        ) {
          frozenConflict = true
          return false
        }
        // The alias was not present during the earlier frozen scan. Resolve its
        // original authority now, before the ordinary chooser can reject a valid F.
        return select(epoch)
      }
    }
    decision = resolveEntrySource({
      entry,
      binding,
      candidates: [...observations]
        .filter(([k]) => k !== journalKey && !k.startsWith('unsettled:'))
        .map(([key, value]) => ({ key, value: value.value })),
      server
    })
    if (decision.status === 'ready') {
      binding = decision.binding
      primaryKey = decision.primaryKey
      const previousRecoveryKey = recoveryKey
      recoveryKey = decision.base.recoveryKey
      if (recoveryKey !== previousRecoveryKey) {
        if (!frozenAt(epoch)) return false
        if (frozen) return select(epoch)
      }
    }
    if (decision.status === 'conflict') phase = 'conflict'
    return true
  }
  function selectCreationOrigin(epoch) {
    if (entry.kind !== 'session') return 'ordinary'
    if (frozen?.originProof && attempt?.owner === 'frozen' && !readKnownCreationFrozen(epoch)) return 'pending'
    const alias = read(epoch, entry.key)
    if (!alias) return 'pending'
    // Only an independently complete own-session ordinary record may bypass
    // another template creation. Shared receipt stages still require nonce proof.
    const ownKey = `unsettled:session:${entry.sessionId}`
    if (!creationOriginKey && !frozen && alias.value?.recoveryKey === ownKey &&
      readCompleteOrdinaryRecord({ context: context(), record: alias.value }).ok) {
      const ownEnvelope = read(epoch, ownKey)
      if (!ownEnvelope) return 'pending'
      if (ownEnvelope.value == null &&
        same(ownEnvelope.fingerprint, observations.get(ownKey)?.fingerprint) &&
        same(alias.fingerprint, observations.get(entry.key)?.fingerprint)) return 'ordinary'
    }
    // A valid session-bound generation F remains independently readable offline.
    const localPending = readUnsettledRecord({ record: alias.value })
    if (!creationOriginKey && localPending && alias.value.sessionId === entry.sessionId) return 'ordinary'
    const key = creationOriginKey || sessionCreationRecoveryKey({ session: server || alias.value })
    if (!key) return 'ordinary'
    const envelope = read(epoch, key)
    if (!envelope) return 'pending'
    // A held creation observation cannot become ordinary authority merely by
    // disappearing or changing operation while GET was pending.
    if (creationOriginKey && !same(envelope.fingerprint, observations.get(key)?.fingerprint)) {
      frozenConflict = true
      return 'pending'
    }
    const candidate = frozen?.originProof && frozen.envelopeCleared && envelope.value === null
      ? { ...frozen, status: 'candidate' }
      : readSessionCreationCandidate({ value: envelope.value, recoveryKey: key, originStorageKey })
    if (['absent', 'other'].includes(candidate.status)) return 'ordinary'
    if (candidate.status === 'conflict') {
      frozenConflict = true
      return 'pending'
    }
    creationPending = true
    creationOriginKey = key
    if (!server) return 'pending'
    const source = read(epoch, candidate.draftKey)
    if (!source) return 'pending'
    for (const [target, actual] of [[key, envelope], [candidate.draftKey, source], [entry.key, alias]]) {
      if (!same(observations.get(target)?.fingerprint, actual.fingerprint)) {
        frozenConflict = true
        return 'pending'
      }
    }
    const proof = proveSessionCreationOrigin({
      entry,
      session: server,
      candidate,
      source: source.value,
      alias: alias.value
    })
    if (proof.status !== 'ready') {
      if (proof.status === 'conflict') frozenConflict = true
      return 'pending'
    }
    recoveryKey = key
    primaryKey = candidate.draftKey
    frozen = {
      ...candidate,
      primaryFingerprint: source.fingerprint,
      originProof: proof,
      envelopeCleared: !!candidate.envelopeCleared,
      aliases: [{ key: entry.key, fingerprint: alias.fingerprint }]
    }
    binding = {
      mode: server.mode,
      templateId: server.templateId,
      sessionId: entry.sessionId
    }
    decision = { status: 'ready', base: frozen.record, binding, primaryKey }
    normalTargets = [primaryKey, entry.key]
    sourceResolutionComplete = true
    creationPending = false
    if (!['invalid-intent', 'conflict', 'unconfirmed'].includes(phase)) phase = journal ? 'pending-ready' : 'normal'
    return 'ready'
  }
  function select(epoch) {
    sourceResolutionComplete = false
    if (!interested(epoch)) return false
    // A canonical generation envelope stays authoritative even after its target
    // became ordinary; an unrelated shared creation must not hide it offline.
    if (!creationOriginKey && entry.kind === 'session' && recoveryKey === `unsettled:session:${entry.sessionId}` &&
      !frozenAt(epoch)) return false
    const creation = !creationOriginKey && frozen?.record.submission ? 'ordinary' : selectCreationOrigin(epoch)
    if (creation !== 'ordinary') return creation === 'ready'
    if (!frozenAt(epoch)) return false
    let origin = observations.get(entry.key)
    if (!origin) origin = read(epoch, entry.key)
    if (!origin) return false
    if (!observeBoundKeys(epoch)) return false
    if (!frozen) {
      for (const [key, value] of observations) {
        const checked = readUnsettledRecord({ record: value.value })
        if (checked) {
          const record = value.value
          if (
            (entry.sessionId !== null && record.sessionId !== entry.sessionId) ||
            ['mode', 'templateId'].some(
              (k) => entry[k] !== null && entry[k] !== record[k]
            )
          ) {
            frozenConflict = true
            return false
          }
          recoveryKey = record.recoveryKey
          const envelope = observations.get(recoveryKey) || read(epoch, recoveryKey)
          if (!envelope) return false
          if (envelope.value != null) {
            const authority = readRecoveryEntry({
              value: envelope.value,
              recoveryKey,
              storageKey: originStorageKey
            })
            if (!authority || authority.identity !== checked.identity) {
              frozenConflict = true
              return false
            }
            frozen = { ...authority, envelopeFingerprint: envelope.fingerprint }
          } else {
            frozen = {
              ...checked,
              draftKey: key,
              record: copy(record),
              envelopeFingerprint: envelope.fingerprint
            }
          }
          primaryKey = frozen.draftKey
          break
        }
      }
    }
    if (frozen) {
      const record = frozen.record
      binding = {
        mode: record.mode,
        templateId: record.templateId,
        sessionId: record.sessionId
      }
      decision = { status: 'ready', base: record, binding, primaryKey: frozen.draftKey }
      if (record.sessionId) {
        const aliasKey = `session:${record.sessionId}`
        const alias = read(epoch, aliasKey)
        if (!alias) return false
        const aliasPending = readUnsettledRecord({ record: alias.value })
        if (
          alias.value !== undefined &&
          !same(alias.fingerprint, fp(record).value) &&
          (aliasPending
            ? aliasPending.identity !== frozen.identity
            : !readCompleteOrdinaryRecord({ context: { entry, binding }, record: alias.value }).ok)
        ) {
          frozenConflict = true
          return false
        }
        frozen.aliases = [{ key: aliasKey, fingerprint: alias.fingerprint }]
      }
    } else if (!observeOrdinarySource(epoch, origin)) return false
    if (decision.status === 'protected' && !feedback) {
      feedback = {
        owner: 'protected-entry',
        revision: ++feedbackRevision,
        message: '旧入口输入已保留；当前草稿暂停本机保存，请重新进入核对'
      }
    }
    if (decision.status === 'ready' && feedback?.owner === 'protected-entry') feedback = null
    if (!['conflict', 'invalid-intent', 'unconfirmed'].includes(phase)) {
      phase = journal
        ? journal.prepared
          ? 'prepared'
          : decision.status === 'ready'
            ? 'pending-ready'
            : 'pending-source'
        : decision.status === 'ready'
          ? 'normal'
          : 'source-pending'
    }
    normalTargets = frozen
      ? [
        ...new Set([
          frozen.draftKey,
          ...(binding?.sessionId ? [`session:${binding.sessionId}`] : [])
        ])
      ]
      : [...new Set([primaryKey, ...(binding?.sessionId ? [`session:${binding.sessionId}`] : [])])]
    if (!interested(epoch)) return false
    sourceResolutionComplete = true
    return true
  }
  function resolveSource(epoch) {
    if (frozenConflict || blockedProjection?.legacyRecord) return result('blocked')
    if (!select(epoch)) {
      if (frozenConflict) blockedProjection = { ...(blockedProjection || {}), corruptPending: true }
      else if (entry.kind === 'session') {
        transientSourceBlock = true
        blockedProjection = { ...(blockedProjection || {}), corruptPending: true }
      }
      return fail(interested(epoch) ? 'pending' : 'cancelled')
    }
    if (transientSourceBlock) {
      blockedProjection = { ...(blockedProjection || {}), corruptPending: false }
      transientSourceBlock = false
    }
    return result('ready')
  }
  function inspect({ epoch }) {
    if (busy) return result('pending')
    if (initialized && sourceResolutionComplete) return result('ready')
    if (initialized && (frozenConflict || blockedProjection?.legacyRecord)) return result('blocked')
    busy = true
    try {
      // Entry/journal observations remain owned across a failed source-resolution
      // attempt. Retry the unfinished resolver, not a fresh unowned journal.
      if (initialized) return resolveSource(epoch)
      const origin = read(epoch, entry.key)
      if (origin?.value && typeof origin.value === 'object') {
        const raw = origin.value
        if (raw.protocol !== 2) blockedProjection = { legacyRecord: raw }
        else if (
          (raw.sessionRequest != null || raw.submission != null) &&
          !readUnsettledRecord({ record: raw })
        ) {
          blockedProjection = {
            corruptPending: true,
            sessionRequest: raw.sessionRequest ?? null,
            submission: raw.submission ?? null
          }
          frozenConflict = true
        }
      }
      const j = read(epoch, journalKey)
      if (!origin || !j) return fail('pending')
      journalFingerprint = j.fingerprint
      if (j.value !== undefined && j.value !== null) {
        const decoded = decodeInitialInputIntent({
          context: { entry, binding: null },
          json: j.fingerprint.json
        })
        if (!decoded.ok) phase = 'invalid-intent'
        else journal = decoded.value.intent
      }
      if (frozenConflict || blockedProjection?.legacyRecord) {
        initialized = true
        phase = 'conflict'
        return fail()
      }
      initialized = true
      return resolveSource(epoch)
    } finally {
      busy = false
    }
  }
  function resolveConfiguration({ epoch, config: next }) {
    inspect({ epoch })
    if (busy || !interested(epoch)) return result('cancelled')
    busy = true
    try {
      const pin = binding || decision.pin || entry
      if (
        ['mode', 'templateId'].some(
          (k) => pin[k] !== null && pin[k] !== next[k]
        )
      ) {
        return fail()
      }
      sourceRevision++
      binding = {
        mode: next.mode,
        templateId: next.templateId,
        sessionId: binding?.sessionId ?? entry.sessionId
      }
      return resolveSource(epoch)
    } finally {
      busy = false
    }
  }
  function resolveSession({ epoch, session }) {
    inspect({ epoch })
    if (busy || !interested(epoch)) return result('cancelled')
    busy = true
    try {
      sourceResolutionComplete = false
      server = null
      if (entry.kind === 'session' && session.id !== entry.sessionId) return fail()
      if (
        ['mode', 'templateId'].some(
          (k) => (binding || entry)[k] !== null && (binding || entry)[k] !== session[k]
        )
      ) {
        return fail()
      }
      sourceRevision++
      server = session
      binding = {
        mode: session.mode,
        templateId: session.templateId,
        sessionId: session.id
      }
      return resolveSource(epoch)
    } finally {
      busy = false
    }
  }
  function all(epoch, keys) {
    const current = []
    for (const key of [...new Set(keys)].sort()) {
      const item = read(epoch, key)
      if (!item) return null
      current.push({ key, fingerprint: item.fingerprint })
    }
    return current
  }
  function mayRetryAttempt(epoch) {
    if (attempt.owner === 'initial-input' && journal?.prepared) {
      const current = all(
        epoch,
        journal.observed.map((item) => item.key)
      )
      const actualJournal = io.read({ epoch, key: journalKey })
      if (!current || actualJournal.status !== 'read') return false
      const ownJournal =
        attempt.key === journalKey &&
        (same(actualJournal.fingerprint, attempt.prior) ||
          same(actualJournal.fingerprint, attempt.desired))
      const plan = planInitialInputReplay({
        context: context(),
        intent: journal,
        currentJournal: ownJournal ? fp(journal).value : actualJournal.fingerprint,
        current,
        serverAnchor: journal.prepared.source.kind === 'server' ? actionAnchor : null
      })
      if (
        !plan.ok ||
        (attempt.key === journalKey &&
          attempt.value === null &&
          plan.value.classification !== 'cleanup-only')
      ) {
        phase = 'conflict'
        return false
      }
    } else if (attempt.owner !== 'initial-input') {
      for (const key of [
        ...new Set([...normalTargets, ...(attempt.owner === 'frozen' ? [recoveryKey] : [])])
      ]) {
        const actual = io.read({ epoch, key })
        if (
          actual.status !== 'read' ||
          !same(actual.fingerprint, observations.get(key)?.fingerprint)
        ) {
          return false
        }
      }
    }
    return true
  }
  function reconcile(epoch) {
    if (!attempt) return true
    const actual = read(epoch, attempt.key)
    if (!actual) return false
    if (!same(actual.fingerprint, attempt.desired) && !same(actual.fingerprint, attempt.prior)) {
      phase = 'conflict'
      return false
    }
    if (same(actual.fingerprint, attempt.prior) && !mayRetryAttempt(epoch)) return false
    if (
      same(actual.fingerprint, attempt.prior) &&
      !write(epoch, attempt.key, attempt.prior, attempt.value, attempt.owner)
    ) {
      return false
    }
    if (same(actual.fingerprint, attempt.desired)) observations.set(attempt.key, actual)
    if (attempt.key === journalKey) journalFingerprint = observations.get(journalKey).fingerprint
    attempt = null
    phase = journal?.prepared ? 'prepared' : journal ? 'pending-ready' : 'normal'
    return true
  }
  // This classifies retained work without retrying an uncertain write.
  function classifyLocalWork(epoch) {
    if (attempt) {
      const actual = io.read({ epoch, key: attempt.key })
      if (actual.status !== 'read') return { status: 'blocked' }
      if (!same(actual.fingerprint, attempt.prior) && !same(actual.fingerprint, attempt.desired)) {
        phase = 'conflict'
        return { status: 'blocked' }
      }
    }
    if (!journal) {
      return { status: getFacts().activeIntent ? 'blocked' : 'ready', needsServerSession: false }
    }
    if (!journal.prepared) {
      const currentJournal = io.read({ epoch, key: journalKey })
      if (currentJournal.status !== 'read') return { status: 'blocked' }
      const ownAttempt =
        attempt?.key === journalKey &&
        (same(currentJournal.fingerprint, attempt.prior) ||
          same(currentJournal.fingerprint, attempt.desired))
      if (!ownAttempt && !same(currentJournal.fingerprint, fp(journal).value)) {
        phase = 'conflict'
        return { status: 'blocked' }
      }
      return { status: 'ready', needsServerSession: decision.source?.kind === 'server' }
    }
    const current = all(
      epoch,
      journal.observed.map((item) => item.key)
    )
    const actualJournal = io.read({ epoch, key: journalKey })
    if (!current || actualJournal.status !== 'read') return { status: 'blocked' }
    let currentJournal = actualJournal.fingerprint
    const ownJournalAttempt =
      attempt?.key === journalKey &&
      (same(actualJournal.fingerprint, attempt.prior) ||
        same(actualJournal.fingerprint, attempt.desired))
    if (ownJournalAttempt) currentJournal = fp(journal).value
    const plan = planInitialInputReplay({
      context: context(),
      intent: journal,
      currentJournal,
      current,
      serverAnchor: null
    })
    if (!plan.ok) {
      if (plan.error.code === 'SERVER_ANCHOR_REQUIRED') {
        return { status: 'ready', needsServerSession: true }
      }
      phase = 'conflict'
      return { status: 'blocked' }
    }
    if (actualJournal.value === null && plan.value.classification !== 'cleanup-only') {
      return { status: 'blocked' }
    }
    return { status: 'ready', needsServerSession: false }
  }
  function beginLocalResume({ epoch }) {
    if (busy || !interested(epoch)) return result('cancelled')
    const overlayRevision = revision
    const capturedSourceRevision = sourceRevision
    inspect({ epoch })
    if (
      busy ||
      !interested(epoch) ||
      revision !== overlayRevision ||
      sourceRevision !== capturedSourceRevision
    ) {
      return result('cancelled')
    }
    if (!sourceResolutionComplete) return result('pending')
    busy = true
    let work
    try {
      work = classifyLocalWork(epoch)
    } finally {
      busy = false
    }
    if (
      !interested(epoch) ||
      revision !== overlayRevision ||
      sourceRevision !== capturedSourceRevision
    ) {
      return result('cancelled')
    }
    if (work.status !== 'ready' || frozen || frozenConflict || phase === 'invalid-intent') {
      return result('blocked')
    }
    const ticket = {}
    localTicket = {
      ticket,
      epoch,
      revision,
      sourceRevision,
      journal,
      attempt,
      needsServerSession: !!work.needsServerSession
    }
    return {
      ...result('pending'),
      ticket,
      needsServerSession: !!work.needsServerSession,
      sessionId: binding?.sessionId ?? entry.sessionId
    }
  }
  function drain(epoch) {
    if (!getFacts().sourceReady || frozen || ['invalid-intent', 'conflict'].includes(phase)) {
      return result('blocked')
    }
    const source = journal?.prepared?.source || decision.source
    if (source?.kind === 'server' && !actionAnchor) {
      const work = classifyLocalWork(epoch)
      if (work.status !== 'ready') return fail('blocked')
      if (work.needsServerSession) return result('pending')
    }
    if (attempt && !reconcile(epoch)) return fail('unconfirmed')
    if (
      !journal ||
      frozen ||
      frozenConflict ||
      !getFacts().sourceReady ||
      ['invalid-intent', 'conflict'].includes(phase)
    ) {
      return result('blocked')
    }
    const committedRevision = journalRevision
    const ownedFeedback = feedback
    if (!journal.prepared) {
      const expected = observations.get(journalKey).fingerprint
      const latest = read(epoch, journalKey)
      if (!latest || !same(latest.fingerprint, expected)) {
        phase = 'conflict'
        return fail()
      }
      let primary = primaryKey
      if (entry.kind === 'template' && primary.startsWith('session:')) {
        primary = [
          entry.key,
          ...retainedBoundKeys()
        ].find((key) => {
          const observed = observations.get(key)
          return (
            observed &&
            (observed.value === undefined || same(observed.fingerprint, fp(decision.base).value))
          )
        })
      }
      if (!primary || !decision.source) {
        phase = 'conflict'
        return fail()
      }
      const keys = [
        ...new Set([
          primary,
          ...(entry.kind === 'template' && binding.sessionId
            ? [`session:${binding.sessionId}`]
            : []),
          ...(decision.source.kind === 'local' ? [decision.source.key] : []),
          ...journal.observed.map((o) => o.key)
        ])
      ]
      const owned = new Map(keys.map((key) => [key, observations.get(key)?.fingerprint]))
      const current = all(epoch, keys)
      if (current && current.some((item) => !same(item.fingerprint, owned.get(item.key)))) {
        phase = 'conflict'
        return fail()
      }
      if (!current) return fail('pending')
      const desired = overlayInitialFields({ base: decision.base, patch: journal.patch })
      const proposal = {
        binding,
        primaryKey: primary,
        source: decision.source,
        targets: [
          ...new Set([
            primary,
            ...(entry.kind === 'template' && binding.sessionId
              ? [`session:${binding.sessionId}`]
              : [])
          ])
        ]
          .sort()
          .map((key) => ({
            key,
            expected: current.find((o) => o.key === key).fingerprint,
            desired
          }))
      }
      const prepared = prepareInitialInputIntent({
        context: context(),
        pending: journal,
        proposal,
        currentJournal: latest.fingerprint,
        current
      })
      if (!prepared.ok) {
        phase = 'conflict'
        return fail()
      }
      const next = prepared.value.intent
      // Keep exact attempted prepared intent even when acknowledgement is uncertain.
      journal = next
      if (!write(epoch, journalKey, latest.fingerprint, next)) return result('unconfirmed')
      journalFingerprint = observations.get(journalKey).fingerprint
      phase = 'prepared'
    }
    for (;;) {
      const current = all(
        epoch,
        journal.observed.map((o) => o.key)
      )
      const actualJournal = read(epoch, journalKey)
      if (!current || !actualJournal) return fail('pending')
      const tombstone = actualJournal.value === null
      const plan = planInitialInputReplay({
        context: context(),
        intent: journal,
        currentJournal: tombstone ? fp(journal).value : actualJournal.fingerprint,
        current,
        serverAnchor: journal.prepared.source.kind === 'server' ? actionAnchor : null
      })
      if (!plan.ok || (tombstone && plan.value.classification !== 'cleanup-only')) {
        phase = 'conflict'
        return fail()
      }
      if (plan.value.pendingTargetKeys.length) {
        const target = journal.prepared.targets.find(
          (t) => t.key === plan.value.pendingTargetKeys[0]
        )
        if (!write(epoch, target.key, target.expected, target.desired)) return result('unconfirmed')
        continue
      }
      if (!tombstone && !write(epoch, journalKey, actualJournal.fingerprint, null)) {
        return result('unconfirmed')
      }
      const desired = journal.prepared.targets[0].desired
      decision = {
        status: 'ready',
        base: copy(desired),
        binding,
        primaryKey: binding.sessionId
          ? `session:${binding.sessionId}`
          : journal.prepared.primaryKey,
        source: {
          kind: 'local',
          key: binding.sessionId ? `session:${binding.sessionId}` : journal.prepared.primaryKey,
          fingerprint: fp(desired).value
        }
      }
      primaryKey = decision.primaryKey
      normalTargets = [primaryKey]
      journal = null
      journalFingerprint = fp(null).value
      phase = 'normal'
      durableRevision = committedRevision
      for (const key of Object.keys(overlay)) {
        if (overlayVersions.get(key) <= committedRevision) {
          delete overlay[key]
          overlayVersions.delete(key)
        }
      }
      if (feedback === ownedFeedback) feedback = null
      return result('saved')
    }
  }
  function runLocalAction(epoch, action) {
    busy = true
    let outcome
    try {
      outcome = action()
    } finally {
      busy = false
    }
    if (phase === 'normal' && Object.keys(overlay).length && interested(epoch)) {
      return saveNormal({
        epoch,
        record: overlayInitialFields({ base: decision.base, patch: overlay })
      })
    }
    return outcome
  }
  function noteEdit({ epoch, patch }) {
    inspect({ epoch })
    revision++
    for (const key of Object.keys(patch)) overlayVersions.set(key, revision)
    overlay = { ...overlay, ...copy(patch) }
    if (busy) return result('pending')
    if (!initialized || !sourceResolutionComplete) return fail('pending')
    if (!interested(epoch)) return result('cancelled')
    if (!journal && getFacts().sourceReady && !frozenConflict) return result('ready')
    if (
      frozen ||
      frozenConflict ||
      decision.status === 'protected' ||
      ['conflict', 'invalid-intent'].includes(phase)
    ) {
      return fail('blocked', decision.status === 'protected' ? 'protected-entry' : 'initial-input')
    }
    return runLocalAction(epoch, () => {
      if (journal?.prepared || attempt) return drain(epoch)
      const pending = {
        protocol: 1,
        kind: 'ordinary-initial-input',
        entry,
        fields: fields.filter((key) =>
          Object.prototype.hasOwnProperty.call({ ...(journal?.patch || {}), ...overlay }, key)
        ),
        patch: { ...(journal?.patch || {}), ...overlay },
        observed: journal?.observed || [
          { key: entry.key, fingerprint: observations.get(entry.key).fingerprint }
        ],
        prepared: null
      }
      const encoded = encodeInitialInputIntent({ context: context(), intent: pending })
      if (!encoded.ok) return fail()
      journal = encoded.value.intent
      journalRevision = revision
      if (!write(epoch, journalKey, journalFingerprint, encoded.value.intent)) {
        return result('unconfirmed')
      }
      journal = encoded.value.intent
      journalFingerprint = observations.get(journalKey).fingerprint
      durableRevision = journalRevision
      phase = decision.status === 'ready' ? 'pending-ready' : 'pending-source'
      return decision.status === 'ready' ? drain(epoch) : result('pending')
    })
  }
  function resumeLocal({ epoch, ticket, session } = {}) {
    if (ticket !== undefined) {
      const frame = localTicket
      if (!frame || frame.ticket !== ticket) return result('blocked')
      localTicket = null
      if (
        !interested(epoch) ||
        frame.epoch !== epoch ||
        frame.revision !== revision ||
        frame.sourceRevision !== sourceRevision ||
        frame.journal !== journal ||
        frame.attempt !== attempt
      ) {
        return result('cancelled')
      }
      if (frame.needsServerSession) {
        const fresh = sessionDraftBase({ entry, session })
        if (
          !fresh ||
          !binding ||
          ['mode', 'templateId', 'sessionId'].some(
            (key) => fresh.binding[key] !== binding[key]
          )
        ) {
          return fail('blocked')
        }
        if (!journal?.prepared && !same(fp(fresh.source).value, fp(decision.source).value)) {
          // A changed unprepared source must be displayed before another explicit confirmation.
          resolveSession({ epoch, session })
          return result('pending')
        }
        actionAnchor = {
          sessionId: fresh.source.sessionId,
          updatedAt: fresh.source.updatedAt,
          inputFingerprint: fresh.source.inputFingerprint
        }
      }
      try {
        return resumeLocal({ epoch })
      } finally {
        actionAnchor = null
      }
    }
    inspect({ epoch })
    if (busy || !interested(epoch)) return result('cancelled')
    if (!sourceResolutionComplete) return result('pending')
    if (!journal && !attempt) {
      if (Object.keys(overlay).length && decision.base) {
        return saveNormal({
          epoch,
          record: overlayInitialFields({ base: decision.base, patch: overlay })
        })
      }
      return result('ready')
    }
    return runLocalAction(epoch, () => drain(epoch))
  }
  function verifySet(epoch, targets, desired, owner) {
    const guards = [...new Set([...targets, ...(owner === 'frozen' ? [recoveryKey] : [])])]
    const owned = new Map(guards.map((key) => [key, observations.get(key)?.fingerprint]))
    if ([...owned.values()].some((v) => !v)) return false
    for (const target of targets) {
      for (const key of guards) {
        const actual = read(epoch, key)
        if (!actual || !same(actual.fingerprint, owned.get(key))) return false
      }
      const value = typeof desired === 'function' ? desired(target) : desired
      if ((owner !== 'frozen' || frozen?.originProof) && same(owned.get(target), fp(value).value)) continue
      if (!write(epoch, target, owned.get(target), value, owner)) return false
      owned.set(target, observations.get(target).fingerprint)
    }
    for (const key of guards) {
      const actual = read(epoch, key)
      if (!actual || !same(actual.fingerprint, owned.get(key))) return false
    }
    return true
  }
  function admit({ epoch, operation }, internal = false) {
    inspect({ epoch })
    if (
      (busy && !internal) ||
      !interested(epoch) ||
      !getFacts().sourceReady ||
      getFacts().activeIntent ||
      frozenConflict
    ) {
      return result('blocked')
    }
    if (frozen?.originProof) return result('blocked')
    if (frozen && !['normal-save', 'upload'].includes(operation)) return result('blocked')
    for (const key of normalTargets) {
      const expected = observations.get(key)?.fingerprint
      const actual = io.read({ epoch, key })
      if (!expected || actual.status !== 'read' || !same(expected, actual.fingerprint)) {
        return fail('blocked', 'normal-save')
      }
    }
    return result('ready')
  }
  function saveNormal({ epoch, record }) {
    record = preserveDraftProvenanceOmission({ record, base: decision.base || {}, patch: overlay })
    if (busy || !sourceResolutionComplete) return result('blocked')
    const committedRevision = revision
    const ownedFeedback = feedback
    busy = true
    try {
      if (attempt && attempt.owner !== 'initial-input' && !reconcile(epoch)) {
        return fail('unconfirmed', attempt?.owner || 'normal-save')
      }
      const allowed = admit({ epoch, operation: 'normal-save' }, true)
      if (allowed.status !== 'ready') return allowed
      if (!hasRecoverablePhotoSlots(record)) return fail('blocked', 'normal-save')
      const pending = readUnsettledRecord({ record })
      if ((record.sessionRequest != null || record.submission != null) && !pending) {
        return fail('blocked', 'frozen')
      }
      if (pending || frozen) {
        const expectedRecovery = observations.get(recoveryKey)?.fingerprint
        const existing = read(epoch, recoveryKey)
        if (!existing || !same(expectedRecovery, existing.fingerprint)) {
          return fail('blocked', 'frozen')
        }
        if (existing.value != null) {
          const checked = readRecoveryEntry({
            value: existing.value,
            recoveryKey,
            storageKey: originStorageKey
          })
          if (
            !checked ||
            !frozen ||
            checked.identity !== frozen.identity ||
            !same(fp(checked.record).value, fp(frozen.record).value)
          ) {
            return fail('blocked', 'frozen')
          }
        }
        if (!existing) return fail('blocked', 'frozen')
        if (frozen && pending && pending.identity !== frozen.identity) {
          return fail('blocked', 'frozen')
        }
        const targets = [
          ...new Set([
            ...(frozen ? [frozen.draftKey] : [primaryKey]),
            ...(record.sessionId ? [`session:${record.sessionId}`] : [])
          ])
        ]
        for (const key of targets) {
          if (!observations.has(key) && !read(epoch, key)) return fail('blocked', 'frozen')
        }
        if (pending) {
          const envelope = { protocol: 2, draftKey: frozen?.draftKey || primaryKey, record }
          frozen = {
            ...pending,
            draftKey: envelope.draftKey,
            record: copy(record),
            envelopeFingerprint: fp(envelope).value
          }
          if (!write(epoch, recoveryKey, existing.fingerprint, envelope, 'frozen')) {
            return result('unconfirmed')
          }
          frozen.envelopeFingerprint = observations.get(recoveryKey).fingerprint
        }
        if (!verifySet(epoch, targets, record, 'frozen')) return fail('blocked', 'frozen')
        if (!pending) {
          if (
            !write(epoch, recoveryKey, observations.get(recoveryKey).fingerprint, null, 'frozen')
          ) {
            return result('unconfirmed')
          }
          frozen = null
          primaryKey = record.sessionId ? `session:${record.sessionId}` : primaryKey
        }
      } else {
        if (!readCompleteOrdinaryRecord({ context: context(), record }).ok) {
          return fail('blocked', 'normal-save')
        }
        if (!verifySet(epoch, normalTargets, record, 'normal-save')) {
          return fail('blocked', 'normal-save')
        }
      }
      if (!frozen && record.sessionId) primaryKey = `session:${record.sessionId}`
      binding = {
        mode: record.mode,
        templateId: record.templateId,
        sessionId: record.sessionId
      }
      decision = {
        status: 'ready',
        base: copy(record),
        binding,
        primaryKey,
        source: { kind: 'local', key: primaryKey, fingerprint: fp(record).value }
      }
      normalTargets = frozen
        ? [
          ...new Set([
            frozen.draftKey,
            ...(record.sessionId ? [`session:${record.sessionId}`] : [])
          ])
        ]
        : [primaryKey]
      for (const key of Object.keys(overlay)) {
        if (
          overlayVersions.get(key) <= committedRevision &&
          JSON.stringify(overlay[key]) === JSON.stringify(record[key])
        ) {
          delete overlay[key]
          overlayVersions.delete(key)
        }
      }
      durableRevision = Object.keys(overlay).length
        ? Math.min(durableRevision, committedRevision)
        : committedRevision
      if (feedback === ownedFeedback) feedback = null
      return result('saved')
    } finally {
      busy = false
    }
  }
  function readKnownCreationFrozen(epoch) {
    const keys = [recoveryKey, frozen.draftKey, ...frozen.aliases.map((alias) => alias.key)]
    const current = new Map()
    for (const key of keys) {
      const actual = io.read({ epoch, key })
      if (actual.status !== 'read') return false
      const expected = observations.get(key)?.fingerprint
      const ownedAttempt = attempt?.owner === 'frozen' && attempt.key === key &&
        same(expected, attempt.prior) && same(actual.fingerprint, attempt.desired)
      if (!same(actual.fingerprint, expected) && !ownedAttempt) {
        frozenConflict = true
        return false
      }
      current.set(key, actual)
    }
    if (!interested(epoch)) return false
    for (const [key, actual] of current) observations.set(key, actual)
    frozen.primaryFingerprint = current.get(frozen.draftKey).fingerprint
    frozen.envelopeFingerprint = current.get(recoveryKey).fingerprint
    frozen.envelopeCleared = current.get(recoveryKey).value === null
    frozen.aliases = frozen.aliases.map((alias) => ({ key: alias.key, fingerprint: current.get(alias.key).fingerprint }))
    return true
  }
  function readFrozen({ epoch }) {
    inspect({ epoch })
    if (busy || !interested(epoch) || !sourceResolutionComplete || frozenConflict || !frozen) {
      return result('blocked')
    }
    if (frozen.originProof) {
      if (!readKnownCreationFrozen(epoch)) return fail('blocked', 'frozen')
      return { ...result('ready'), record: copy(frozen.record) }
    }
    const expected = frozen.primaryFingerprint || observations.get(frozen.draftKey)?.fingerprint
    const source = io.read({ epoch, key: frozen.draftKey })
    const envelope = io.read({ epoch, key: recoveryKey })
    if (
      source.status !== 'read' ||
      envelope.status !== 'read' ||
      !same(source.fingerprint, expected) ||
      !same(envelope.fingerprint, frozen.envelopeFingerprint)
    ) {
      const ownSource =
        attempt?.key === frozen.draftKey && same(source.fingerprint, attempt.desired)
      const ownEnvelope =
        attempt?.key === recoveryKey && same(envelope.fingerprint, attempt.desired)
      if (
        (source.status === 'read' && !same(source.fingerprint, expected) && !ownSource) ||
        (envelope.status === 'read' &&
          !same(envelope.fingerprint, frozen.envelopeFingerprint) &&
          !ownEnvelope)
      ) {
        frozenConflict = true
      }
      return fail('blocked', 'frozen')
    }
    for (const alias of frozen.aliases || []) {
      const actual = io.read({ epoch, key: alias.key })
      if (actual.status !== 'read' || !same(actual.fingerprint, alias.fingerprint)) {
        if (
          actual.status === 'read' &&
          !(attempt?.key === alias.key && same(actual.fingerprint, attempt.desired))
        ) {
          frozenConflict = true
        }
        return fail('blocked', 'frozen')
      }
    }
    return { ...result('ready'), record: copy(frozen.record), needsEnvelope: !!frozen.record.sessionRequest && envelope.value == null }
  }
  function settleSession({ epoch, receipt }) {
    const f = readFrozen({ epoch })
    if (!f.record || getFacts().activeIntent) return result('blocked')
    if (frozen.originProof) {
      if (getFacts().hasUnsavedOverlay || receipt.id !== frozen.originProof.knownSessionId ||
        receipt.mode !== f.record.mode) return fail('blocked', 'frozen')
      const desired = sessionReceiptDesired({ frozenRecord: f.record, receipt })
      if (!desired) return fail('blocked', 'frozen')
      busy = true
      const capturedRevision = revision
      actionGuard = () => revision === capturedRevision && !getFacts().activeIntent
      try {
        const targets = [frozen.draftKey, `session:${receipt.id}`]
        if (!verifySet(epoch, targets, desired, 'frozen')) return fail('blocked', 'frozen')
        if (!frozen.envelopeCleared && !write(epoch, recoveryKey, frozen.envelopeFingerprint, null, 'frozen')) return result('unconfirmed')
        if (!interested(epoch) || !actionGuard()) return result('cancelled')
        frozen = null
        creationPending = false
        primaryKey = `session:${receipt.id}`
        binding = {
          mode: desired.mode,
          templateId: desired.templateId,
          sessionId: receipt.id
        }
        decision = {
          status: 'ready',
          base: desired,
          binding,
          primaryKey,
          source: { kind: 'local', key: primaryKey, fingerprint: fp(desired).value }
        }
        normalTargets = [primaryKey]
        phase = 'normal'
        attempt = null
        feedback = null
        return result('saved')
      } finally { actionGuard = null; busy = false }
    }
    const desired = sessionReceiptDesired({ frozenRecord: f.record, receipt })
    if (!desired) return fail('blocked', 'frozen')
    const legacyDesired = Object.prototype.hasOwnProperty.call(f.record, 'templateVersionId')
      ? { ...desired, templateVersionId: f.record.templateVersionId }
      : desired
    const alias = `session:${receipt.id}`
    const actual = read(epoch, alias)
    if (
      !actual ||
      (actual.value !== undefined &&
        !same(actual.fingerprint, fp(desired).value) &&
        !same(actual.fingerprint, fp(legacyDesired).value) &&
        !same(actual.fingerprint, fp(f.record).value))
    ) {
      return fail('blocked', 'frozen')
    }
    normalTargets = [...new Set([frozen.draftKey, alias])]
    // saveNormal settles the original primary and alias, then clears envelope last.
    return saveNormal({ epoch, record: desired })
  }
  return {
    inspect,
    beginLocalResume,
    resolveConfiguration,
    resolveSession,
    project,
    noteEdit,
    resumeLocal,
    admit,
    saveNormal,
    readFrozen,
    settleSession,
    settleSubmission: saveNormal,
    getFacts
  }
}
