/** Only the GET transport contract signals disconnection, not unknown write outcomes. */
export const isReadTransportError = (error) =>
  error?.code === 'REQUEST_OUTCOME_UNKNOWN' &&
  error?.status == null &&
  error?.isOutcomeUnknown === true

export function readPollDelay({ failureCount, random = Math.random }) {
  if (failureCount <= 0) return 2000
  const base = [2000, 4000, 8000, 16000, 30000][Math.min(failureCount - 1, 4)]
  return Math.round(base * (0.8 + 0.4 * Math.min(1, Math.max(0, random()))))
}
