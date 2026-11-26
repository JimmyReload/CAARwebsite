// Bounded snapshot polling for optional Hunt completion labels.
// The poller continues from its own timer even when React state remains `pending=true`.
export function startCompletionPolling({
  isCurrent,
  request,
  onResult,
  onError = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  // 40 profiles / 8 concurrent × 2.5s deadline can require 12.5s on cold cache.
  // Twelve capped backoff polls cover the worst-case bounded 40-profile refresh
  // (40 / 8 concurrency × 2.5s timeout) without polling indefinitely.
  maxAttempts = 12,
  baseDelayMs = 1200,
  maxDelayMs = 5000
}) {
  let active = true
  let timer = null
  let attempts = 0

  const poll = async () => {
    if (!active || !isCurrent()) return
    attempts += 1
    try {
      const result = await request()
      if (!active || !isCurrent()) return
      const pending = result && result.pending === true && attempts < maxAttempts
      onResult({ ...(result || {}), pending })
      if (pending) {
        timer = schedule(poll, Math.min(baseDelayMs * attempts, maxDelayMs))
      }
    } catch (error) {
      if (active && isCurrent()) onError(error)
    }
  }

  timer = schedule(poll, baseDelayMs)
  return () => {
    active = false
    if (timer !== null) cancel(timer)
  }
}
