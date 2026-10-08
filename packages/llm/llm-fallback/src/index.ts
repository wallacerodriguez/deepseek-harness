/**
 * Automatic rotation to the next configured model when a provider route fails
 * with an overload or rate-limit failure. The plugin installs per-agent model
 * selection on top of `installModelSelection`, so the agent loop's retry of the
 * failed step leaves on the fallback route without ending the turn.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import {
  installModelSelection,
  type Agent,
  type ModelSelection,
  type ModelSelectionRef,
  type RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: declares the durable `model/selection` event this plugin appends.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { fallbackRouteKey, nextFallbackRoute } from './chain.ts'
import type { FallbackPromptState, FallbackRoute } from './types.ts'

export type { FallbackPromptState, FallbackRoute } from './types.ts'
export { fallbackRouteKey, nextFallbackRoute } from './chain.ts'
export type { FallbackCandidate } from './chain.ts'

export const name = 'llm-fallback'
export const inject = ['agents', 'llm', 'sessionProjections']

/** Failure codes rotated by default: a transient overload or a rate limit. */
export const DEFAULT_FALLBACK_RETRYABLE_CODES: readonly string[] = ['SERVER', 'RATE_LIMIT']

/** Automatic model-fallback policy for one composition. */
export interface Config {
  /**
   * Ordered fallback chains, each an ordered list of exact routes. The plugin
   * rotates from the current route to the next unused entry of the first chain
   * that names it (default: none, which leaves the plugin dormant).
   */
  chains?: FallbackRoute[][]
  /**
   * Failure codes that start a rotation. `QUOTA` is deliberately absent by
   * default: it is terminal and account-wide, so another model cannot help
   * (default: `SERVER`, `RATE_LIMIT`).
   */
  retryableCodes?: string[]
  /**
   * Whether a candidate whose declared context window cannot hold the current
   * request is skipped instead of used. A candidate route whose metadata cannot
   * be resolved is skipped regardless of this setting (default: true).
   */
  respectContextWindow?: boolean
  /**
   * Rotation ceiling for one agent step. The owning chain length is the default,
   * which the per-step used-route set already bounds (default: owning chain length).
   */
  maxRotationsPerStep?: number
}

const fallbackRouteSchema: z<FallbackRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  chains: z.array(z.array(fallbackRouteSchema)).default([]),
  retryableCodes: z.array(z.string()).default([...DEFAULT_FALLBACK_RETRYABLE_CODES]),
  respectContextWindow: z.boolean().default(true),
  maxRotationsPerStep: z.number().step(1).min(1),
})

/** Configuration after schema defaults and chain validation. */
interface ResolvedConfig {
  readonly chains: readonly (readonly FallbackRoute[])[]
  readonly retryableCodes: ReadonlySet<string>
  readonly respectContextWindow: boolean
  readonly maxRotationsPerStep: number | undefined
}

/** Per-agent rotation bookkeeping, reset whenever the observed step changes. */
interface AgentFallbackState {
  readonly ref: ModelSelectionRef
  turn: number
  step: number
  used: Set<string>
  rotations: number
  dispose: () => void
}

const llmFallbackStateSchema: zod.ZodType<FallbackPromptState> = zod.object({
  tokens: zod.number().nullable(),
})

/**
 * Fold the newest provider-reported request size from the session log.
 * @param state - prompt-size state before the event.
 * @param event - next committed session event.
 * @returns the original state, or the newest reported size.
 */
function applyFallbackPrompt(
  state: FallbackPromptState,
  event: SessionEvent,
): FallbackPromptState {
  if (event.type !== 'assistant/message') return state
  const usage = event.data.usage
  if (usage === undefined) return state
  const tokens = usage.totalTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0)
  return tokens === state.tokens ? state : { tokens }
}

/**
 * Apply schema defaults for direct construction and reject unusable chains
 * before any agent can rotate.
 *
 * @param config - raw plugin configuration.
 * @returns the resolved policy.
 * @throws when a chain is empty, repeats a route, or carries an empty route id.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const chains = (config.chains ?? []).map(chain => chain.map(route => ({
    provider: route.provider,
    model: route.model,
  })))
  for (const [index, chain] of chains.entries()) {
    const label = `llm-fallback: chains[${index}]`
    if (chain.length === 0) throw new Error(`${label} is empty; omit the chain instead`)
    const seen = new Set<string>()
    for (const route of chain) {
      if (route.provider.length === 0 || route.model.length === 0) {
        throw new Error(`${label} requires non-empty provider and model ids`)
      }
      const key = fallbackRouteKey(route)
      if (seen.has(key)) throw new Error(`${label} repeats route "${route.provider}/${route.model}"`)
      seen.add(key)
    }
  }
  const maxRotationsPerStep = config.maxRotationsPerStep
  if (maxRotationsPerStep !== undefined
    && (!Number.isSafeInteger(maxRotationsPerStep) || maxRotationsPerStep < 1)) {
    throw new Error('llm-fallback: maxRotationsPerStep must be a positive safe integer')
  }
  return {
    chains,
    retryableCodes: new Set(config.retryableCodes ?? DEFAULT_FALLBACK_RETRYABLE_CODES),
    respectContextWindow: config.respectContextWindow ?? true,
    maxRotationsPerStep,
  }
}

/**
 * Rotate the live Agent to the next usable route of its chain whenever an
 * eligible model request fails, and let the agent loop re-run the failed step.
 *
 * @param ctx - plugin context that owns the listeners and projection.
 * @param config - fallback policy; an empty `chains` leaves the plugin dormant.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.chains.length === 0) return

  ctx.sessionProjections.register({
    key: 'llmFallback',
    stateVersion: 1,
    stateSchema: llmFallbackStateSchema,
    init: () => ({ tokens: null }),
    apply: applyFallbackPrompt,
  })

  const lifetime = new AbortController()
  const agents = new Map<Agent, AgentFallbackState>()

  const installAgent = (agent: Agent): void => {
    if (agents.has(agent)) return
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    const state: AgentFallbackState = {
      ref,
      turn: -1,
      step: -1,
      used: new Set<string>(),
      rotations: 0,
      dispose: () => {},
    }
    // Registered before the capture listener so `await next()` returns the route
    // that listener produced; disarming afterwards keeps this one-shot rotation
    // from shadowing another selection owner on later requests.
    const disposeGuard = agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      ref.current = undefined
      ref.assembled = undefined
      return request
    })
    const disposeSelection = installModelSelection(agent.ctx, ref)
    state.dispose = () => {
      disposeGuard()
      disposeSelection()
    }
    agents.set(agent, state)
  }

  for (const agent of ctx.agents.list()) installAgent(agent)
  ctx.on('agent/created', ({ agent }) => { installAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = agents.get(agent)
    if (state === undefined) return
    agents.delete(agent)
    state.dispose()
  })

  async function rotate(
    { agent, turn, step, provider, failure, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const state = agents.get(agent)
    if (state === undefined) return next()
    if (signal.aborted || lifetime.signal.aborted) return next()
    if (!resolved.retryableCodes.has(failure.code)) return next()
    const header = agent.session.requestHeader()
    if (header === undefined) return next()
    const current: FallbackRoute = { provider, model: header.config.model }
    if (state.turn !== turn || state.step !== step) {
      state.turn = turn
      state.step = step
      state.used = new Set<string>()
      state.rotations = 0
    }
    state.used.add(fallbackRouteKey(current))
    const projected = ctx.sessionProjections.stateOf(agent.session, 'llmFallback')?.tokens
    const estimatedTokens = projected === undefined || projected === null || projected <= 0
      ? undefined
      : projected
    const fused = AbortSignal.any([signal, lifetime.signal])
    while (true) {
      const candidate = nextFallbackRoute(resolved.chains, current, state.used)
      if (candidate === undefined) return next()
      if (state.rotations >= (resolved.maxRotationsPerStep ?? candidate.chainLength)) return next()
      if (resolved.respectContextWindow) {
        const target = `${candidate.route.provider}/${candidate.route.model}`
        let contextWindow: number | undefined
        try {
          contextWindow = (await ctx.llm.resolveModelInfo(candidate.route.provider, candidate.route.model, fused))
            .context?.contextWindow
        } catch (error: unknown) {
          if (fused.aborted) return next()
          ctx.logger.warn(`llm-fallback: skipping unresolvable fallback route "${target}": ${error instanceof Error ? error.message : String(error)}`)
          state.used.add(fallbackRouteKey(candidate.route))
          continue
        }
        if (fused.aborted) return next()
        if (estimatedTokens !== undefined && contextWindow !== undefined && estimatedTokens > contextWindow) {
          state.used.add(fallbackRouteKey(candidate.route))
          continue
        }
      }
      const selection: ModelSelection = {
        provider: candidate.route.provider,
        model: candidate.route.model,
      }
      state.rotations += 1
      state.used.add(fallbackRouteKey(candidate.route))
      state.ref.current = selection
      state.ref.assembled = selection
      agent.session.append('model/selection', { provider: selection.provider, model: selection.model })
      ctx.logger.warn(`llm-fallback: ${current.provider}/${current.model} failed with ${failure.code}; rotating step ${turn}.${step} to ${selection.provider}/${selection.model}`)
      return { kind: 'retry' }
    }
  }

  const disposeRecovery = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return next()
    return rotate(payload, next)
  })

  ctx.effect(() => () => {
    disposeRecovery()
    lifetime.abort(new Error('llm-fallback plugin disposed'))
    for (const state of agents.values()) state.dispose()
    agents.clear()
  }, 'llm-fallback: detach rotation and per-agent selection')
}
