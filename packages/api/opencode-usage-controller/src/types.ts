/**
 * Wire vocabulary of the `opencodeUsage` Remote namespace. Types only; the
 * values are copied field by field by the controller before they cross.
 *
 * @module @deepseek-ai/dsh-api-opencode-usage-controller/src/types.ts
 */

/** One provider-consumption window the OpenCode Go account's API reports. */
export interface OpenCodeUsageWindow {
  /** Consumed share of the window's allowance, 0–100 integer. */
  readonly percent: number
  /** ISO-8601 instant at which the current provider allowance resets. */
  readonly resetsAt: string
  /** Provider-reported condition of the window (e.g. 'ok'). */
  readonly status: string
}

/**
 * One `usage()` answer: the three usage windows of the subscription, or the
 * fact that the source is unavailable right now. An unavailable snapshot
 * carries the configured provider id and a failure reason, but no window
 * facts — the client renders it as unavailable and never infers quota state
 * from a failed read.
 */
export interface OpenCodeUsageSnapshot {
  /** Provider registry id whose key backs this read (the plugin's `providerId`). */
  readonly providerId: string
  /** Whether the usage data was available for this read. */
  readonly available: boolean
  /** Optional failure reason when `available` is false; never a credential value. */
  readonly unavailableReason?: string
  /** ISO-8601 instant the Host completed the answering read. */
  readonly fetchedAt: string
  /** Rolling (5-hour) window; null when unavailable. */
  readonly rolling: OpenCodeUsageWindow | null
  /** Weekly window; null when unavailable. */
  readonly weekly: OpenCodeUsageWindow | null
  /** Monthly window; null when unavailable. */
  readonly monthly: OpenCodeUsageWindow | null
}
