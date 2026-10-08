// OpenCode Go subscription-usage seat: the route fact the pill gates on, the
// read face the apply world injects, and the poll cadence the pill keeps.

import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
// Type-only: materializes the 'turn-tail' entry in ChatNodeDataMap.
import type {} from '../conversation-nodes/turn-tail.ts'

/** Interval one visible pill serves a Host answer before revalidating. The Host
 * cache TTL (60 s by default) stays under this, so reads never pile up. */
export const OPENCODE_USAGE_POLL_MS = 120_000

/**
 * The provider of the latest billed turn with attributed usage, from the
 * completed-turn footnotes the `turn-tail` fold publishes: the last route of
 * the highest turn's token usage. A session mixing providers shows the
 * provider its most recent billed turn used, not one an old turn touched.
 * @param snapshot - the current Chat target projection.
 * @returns the provider id, or null while no turn carried attributed usage.
 */
export function currentSessionRoute(snapshot: ChatSnapshot): string | null {
  let latestTurn = Number.NEGATIVE_INFINITY
  let provider: string | null = null
  for (const node of snapshot.nodes.values()) {
    // The keyed store's kinds merge across the whole Chat graph, so the
    // footnotes reach this reader as `ChatNode<'turn-tail'>`.
    const tail = node as ChatNode<'turn-tail'>
    if (tail.kind !== 'turn-tail') continue
    const route = tail.data.tokenUsage?.routes?.at(-1)
    if (route === undefined) continue
    if (tail.data.turn <= latestTurn) continue
    latestTurn = tail.data.turn
    provider = route.provider
  }
  return latestTurn === Number.NEGATIVE_INFINITY ? null : provider
}
