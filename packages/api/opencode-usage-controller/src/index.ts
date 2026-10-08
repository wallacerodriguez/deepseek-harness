/**
 * Host Remote owner for the `opencodeUsage` namespace: the subscription
 * (OpenCode Go) usage windows one web client session pill renders. The class
 * carries the credential seam lookup, the consumer-side cache, and the wire parse;
 * a failed read answers an `available: false` snapshot, never a thrown fetch.
 *
 * @module @deepseek-ai/dsh-api-opencode-usage-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z as zod } from 'zod'
import type { OpenCodeUsageSnapshot, OpenCodeUsageWindow } from './types.ts'

export type { OpenCodeUsageSnapshot, OpenCodeUsageWindow } from './types.ts'

/** The official OpenCode Go account-usage endpoint. */
const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

/** The Config keys the controller accepts and validates. */
const ACCEPTED_CONFIG_KEYS = ['providerId', 'apiKeyEnv', 'endpoint', 'cacheTtlMs'] as const
type AcceptedConfigKey = (typeof ACCEPTED_CONFIG_KEYS)[number]

/** Default settings.yaml-style provider id the billed routes report. */
const DEFAULT_PROVIDER_ID = 'opencode-go'

/** Default credential reference whose value authenticates the usage read. */
const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Default consumer-side freshness bound over the read cache. */
const DEFAULT_CACHE_TTL_MS = 60_000

/** Controller deployment policy. */
export interface Config {
  /** Provider registry id whose routes this usage data describes. */
  readonly providerId?: string
  /** Credential reference the read authenticates with (`Authorization: Bearer`). */
  readonly apiKeyEnv?: string
  /** Subscription usage read URL; https only. */
  readonly endpoint?: string
  /** How long one answer (including an unavailable one) serves before the next read. */
  readonly cacheTtlMs?: number
}

/** Host integrations replaceable by direct unit tests. */
export interface OpencodeUsageControllerInternals {
  /** Subscription usage HTTP read; defaults to the platform fetch. */
  readonly fetch?: typeof fetch
  /** Wall-clock source; defaults to `Date.now`. */
  readonly now?: () => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `opencodeUsage` Remote namespace. */
    opencodeUsageController: OpencodeUsageController
  }
}

const credentialRefPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const windowResponseSchema = zod.object({
  percent: zod.number().int().min(0).max(100),
  resetsAt: zod.string().refine(isParseableInstant, 'resetsAt must be an ISO-8601 instant'),
  status: zod.string().min(1),
})
const usageResponseSchema = zod.object({
  usage: zod.object({
    rolling: windowResponseSchema.optional(),
    weekly: windowResponseSchema.optional(),
    monthly: windowResponseSchema.optional(),
  }),
})

function isParseableInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

/**
 * Copy exactly the fields the wire vocabulary declares. The Gateway returns a
 * business result without decoding it, so an upstream window carrying extra
 * enumerable properties would otherwise serialize them to the caller.
 * @param window - one upstream window value.
 * @returns the same facts with nothing else attached.
 */
function projectWindow(window: OpenCodeUsageWindow): OpenCodeUsageWindow {
  return { percent: window.percent, resetsAt: window.resetsAt, status: window.status }
}

/**
 * Host service backing the generated `ctx.remote.opencodeUsage` namespace.
 * Reads state the OpenCode Go account; the read itself consumes no quota, but
 * every answer the cache serves keeps the subscription endpoint quiet for
 * `cacheTtlMs`. Answers carry quota state only: no credential value,
 * endpoint URL, or failure body crosses to the client.
 */
export class OpencodeUsageController extends TypertRemoteService {
  static inject = ['credentials']

  static Config: z<Config> = z.object({
    providerId: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default(DEFAULT_PROVIDER_ID),
    apiKeyEnv: z.string().pattern(credentialRefPattern).default(DEFAULT_API_KEY_ENV),
    endpoint: z.string().pattern(/^https:\/\//).default(DEFAULT_ENDPOINT),
    cacheTtlMs: z.number().step(1).min(1).default(DEFAULT_CACHE_TTL_MS),
  })

  private readonly providerId: string
  private readonly apiKeyEnv: string
  private readonly endpoint: string
  private readonly cacheTtlMs: number
  private readonly fetchUsage: typeof fetch
  private readonly now: () => number

  /**
   * The last answer and the wall-clock millisecond the read that produced it
   * completed. An unavailable answer caches the same way, so an unresolvable
   * or failing source answers at most once per TTL.
   */
  private cache: { readonly snapshot: OpenCodeUsageSnapshot; readonly completedAt: number } | undefined
  private inFlight: Promise<OpenCodeUsageSnapshot> | undefined

  /**
   * @param ctx - Host context whose credential seam resolves `apiKeyEnv`.
   * @param config - deployment policy validated by {@link OpencodeUsageController.Config}.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config = {}, internals: OpencodeUsageControllerInternals = {}) {
    super(ctx, 'opencodeUsageController', { namespace: 'opencodeUsage' })
    this.providerId = config.providerId ?? DEFAULT_PROVIDER_ID
    this.apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    // Schemastery carries unknown keys through untouched, so the noisy-key case
    // (a typo like `apiKey` inlining a credential into the profile document)
    // fails loud here instead of hiding behind the typed defaults.
    for (const key of Object.keys(config)) {
      if (!ACCEPTED_CONFIG_KEYS.includes(key as AcceptedConfigKey)) {
        throw new Error(`opencode-usage: unknown config key "${key}"`)
      }
    }
    this.fetchUsage = internals.fetch ?? fetch
    this.now = internals.now ?? Date.now
  }

  /**
   * Read the subscription's usage windows, serving the cached answer within
   * the TTL and deduplicating concurrent reads. Failures — no credential
   * provider, unresolvable key, transport failure, HTTP error, or an
   * unrecognized payload — answer an unavailable snapshot instead of throwing,
   * and cache for the same TTL as a success.
   * @returns the current usage answer.
   */
  @Remote
  async usage(): Promise<OpenCodeUsageSnapshot> {
    const completedAt = this.now()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.cache !== undefined && completedAt - this.cache.completedAt < this.cacheTtlMs) {
      return this.cache.snapshot
    }
    const read = this.refresh()
    this.inFlight = read
    // An in-flight read is the freshness contract for this call: a caller that
    // arrived at the exact moment one completed either awaited it or started
    // with fresh cache, both within one TTL of the source.
    return read.finally(() => {
      if (this.inFlight === read) this.inFlight = undefined
    })
  }

  /** Answer what the client renders — one fresh read cached for next callers. */
  private async refresh(): Promise<OpenCodeUsageSnapshot> {
    const snapshot = await this.readOnce()
    this.cache = { snapshot, completedAt: this.now() }
    return snapshot
  }

  private async readOnce(): Promise<OpenCodeUsageSnapshot> {
    const unavailable = (reason: string): OpenCodeUsageSnapshot => ({
      providerId: this.providerId,
      available: false,
      ...(reason === '' ? {} : { unavailableReason: reason }),
      fetchedAt: new Date(this.now()).toISOString(),
      rolling: null,
      weekly: null,
      monthly: null,
    })

    // Per read, the seam decides: an absent provider or an unresolvable
    // reference is a real condition of this deployment's composition, so it is
    // reportable state, not a silent skip.
    const credentials: CredentialProvider | undefined = this.ctx.get('credentials')
    if (credentials === undefined) {
      return unavailable(
        'no credential provider is mounted: this deployment does not mount a credential provider'
        + ' (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
      )
    }

    let key: string | undefined
    try {
      key = (await credentials.resolve(credentialRef(this.apiKeyEnv)))?.value
    } catch (_unreadableCredential) {
      // The credential seam may refuse an unreadable source; the reason names
      // the failed step without retrying it.
      return unavailable('credential resolution failed')
    }
    if (key === undefined || key.length === 0) {
      return unavailable(`credential ${this.apiKeyEnv} is not set: store it through the credentials service or export it`)
    }

    let response: Response
    try {
      response = await this.fetchUsage(this.endpoint, {
        headers: { Authorization: `Bearer ${key}` },
      })
    } catch (_transportError) {
      // The transport error's text can carry the endpoint URL and proxy
      // details; the reason stays generic while the fetch failure remains the
      // reported state.
      return unavailable('subscription usage endpoint could not be reached')
    }
    if (!response.ok) {
      return unavailable(`subscription usage endpoint answered ${response.status}`)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (_unreadableBody) {
      // Body parse failures can quote or embed the unreadable body itself.
      return unavailable('subscription usage endpoint answered an unreadable body')
    }
    const parsed = usageResponseSchema.safeParse(payload)
    if (!parsed.success) {
      return unavailable('subscription usage endpoint answered an unrecognized payload')
    }
    return {
      providerId: this.providerId,
      available: true,
      fetchedAt: new Date(this.now()).toISOString(),
      rolling: parsed.data.usage.rolling === undefined ? null : projectWindow(parsed.data.usage.rolling),
      weekly: parsed.data.usage.weekly === undefined ? null : projectWindow(parsed.data.usage.weekly),
      monthly: parsed.data.usage.monthly === undefined ? null : projectWindow(parsed.data.usage.monthly),
    }
  }
}

export default OpencodeUsageController
