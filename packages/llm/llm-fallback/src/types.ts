/**
 * Route, configuration, and projection-state types for automatic model fallback.
 *
 * @module @deepseek-ai/dsh-llm-fallback/types
 */

import type {} from '@deepseek-ai/dsh-session-projection/types'

/** One exact provider/model route in a configured fallback chain. */
export interface FallbackRoute {
  /** Registered provider route that owns the model. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/**
 * Host-only request-size estimate folded from the newest `assistant/message`
 * usage. Rotation compares it with a candidate's context window.
 */
export interface FallbackPromptState {
  /** Tokens charged by the latest assistant message, or null before the session reports usage. */
  readonly tokens: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Newest provider-reported request size, folded from the latest `assistant/message`. */
    llmFallback: FallbackPromptState
  }
}
