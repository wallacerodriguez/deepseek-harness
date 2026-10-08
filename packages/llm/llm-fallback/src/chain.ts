/**
 * Pure fallback-chain lookup shared by the plugin's rotation decision.
 *
 * @module @deepseek-ai/dsh-llm-fallback/chain
 */

import type { FallbackRoute } from './types.ts'

/**
 * Stable identity for one exact provider/model route.
 * @param route - exact route to name.
 * @returns an opaque key that compares two routes without provider vocabulary.
 */
export function fallbackRouteKey(route: FallbackRoute): string {
  return `${route.provider}\0${route.model}`
}

/** One unused successor route plus the chain that owns it. */
export interface FallbackCandidate {
  /** Exact route to rotate to. */
  readonly route: FallbackRoute
  /** Length of the owning chain; the default per-step rotation cap. */
  readonly chainLength: number
}

/**
 * Find the first unused route after the current one inside the first chain that
 * contains the current route. Later chains are only consulted when no earlier
 * chain names the current route, so one route has exactly one successor.
 *
 * @param chains - configured chains in priority order.
 * @param current - exact route of the failed request.
 * @param used - route keys already attempted in this step.
 * @returns the candidate and its chain length, or undefined when the owning chain has no unused successor.
 */
export function nextFallbackRoute(
  chains: readonly (readonly FallbackRoute[])[],
  current: FallbackRoute,
  used: ReadonlySet<string>,
): FallbackCandidate | undefined {
  const currentKey = fallbackRouteKey(current)
  for (const chain of chains) {
    const index = chain.findIndex(route => fallbackRouteKey(route) === currentKey)
    if (index < 0) continue
    for (let successor = index + 1; successor < chain.length; successor++) {
      const route = chain[successor]
      if (route === undefined || used.has(fallbackRouteKey(route))) continue
      return { route, chainLength: chain.length }
    }
    return undefined
  }
  return undefined
}
