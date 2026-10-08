import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OpencodeUsageController from '../src/index.ts'
import type { OpenCodeUsageSnapshot } from '../src/types.ts'

const FIXTURE_RESPONSE = (): unknown => ({
  usage: {
    rolling: { status: 'ok', percent: 1, resetsAt: '2026-10-08T00:37:47.000Z' },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 0, resetsAt: '2026-11-07T18:10:04.000Z' },
  },
})

type FetchReplacement = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** A fetch double whose calls are counted and whose answer is scriptable. */
function recordCalls(answer: FetchReplacement): FetchReplacement & { calls: { url: string; headers: HeadersInit | undefined }[] } {
  const calls: { url: string; headers: HeadersInit | undefined }[] = []
  return Object.assign(((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: init?.headers })
    return answer(url, init)
  }) satisfies FetchReplacement, { calls })
}

function okJson(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
}

function responseOf(status: number): Response {
  return new Response('', { status })
}

let clock = 0

async function boot(
  options: {
    seed?: Record<string, string>
    fetch?: FetchReplacement
    config?: ConstructorParameters<typeof OpencodeUsageController>[1]
  } = {},
): Promise<OpencodeUsageController> {
  const ctx = new Context()
  if (options.seed !== undefined) await ctx.plugin(MemoryCredentials, options.seed)
  const internals = { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), now: () => ++clock }
  return new OpencodeUsageController(ctx, options.config ?? {}, internals)
}

function unavailableOf(snapshot: OpenCodeUsageSnapshot, reason: RegExp): void {
  expect(snapshot).toMatchObject({ available: false, rolling: null, weekly: null, monthly: null })
  expect(snapshot.unavailableReason).toMatch(reason)
}

describe('the opencodeUsage Remote namespace the web pill calls', () => {
  afterEach(() => {
    clock = 0
  })

  it('publishes the dedicated namespace from its own service key', async () => {
    const controller = await boot({ fetch: recordCalls(async () => okJson(FIXTURE_RESPONSE())), seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
    expect(controller.typertRemote).toMatchObject({ serviceKey: 'opencodeUsageController', namespace: 'opencodeUsage' })
    expect(remoteMethods(controller)).toEqual([{ method: 'usage', invocation: { kind: 'direct' } }])
  })

  it('answers the three windows fields by field and never the credential', async () => {
    const fetchUsage = recordCalls(async () => okJson(FIXTURE_RESPONSE()))
    const controller = await boot({ fetch: fetchUsage, seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
    const snapshot = await controller.usage()
    expect(fetchUsage.calls).toHaveLength(1)
    expect(fetchUsage.calls[0]!).toMatchObject({ url: 'https://opencode.ai/zen/go/v1/usage' })
    const headers = new Headers(fetchUsage.calls[0]!.headers)
    expect(headers.get('Authorization')).toBe('Bearer sk-live')
    expect(snapshot).toEqual({
      providerId: 'opencode-go',
      available: true,
      fetchedAt: expect.any(String),
      rolling: { percent: 1, resetsAt: '2026-10-08T00:37:47.000Z', status: 'ok' },
      weekly: { percent: 0, resetsAt: '2026-10-12T00:00:00.000Z', status: 'ok' },
      monthly: { percent: 0, resetsAt: '2026-11-07T18:10:04.000Z', status: 'ok' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('sk-live')
  })

  it('serves one read per TTL and revalidates after it expires', async () => {
    const fetchUsage = recordCalls(async () => okJson(FIXTURE_RESPONSE()))
    const controller = await boot({ fetch: fetchUsage, seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
    const first = await controller.usage()
    expect(await controller.usage()).toBe(first)
    expect(fetchUsage.calls).toHaveLength(1)
    clock += 60_000
    await controller.usage()
    expect(fetchUsage.calls).toHaveLength(2)
  })

  it('answers the same read for concurrent callers without a second request', async () => {
    let settled = false
    const fetchUsage = recordCalls(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          settled = true
          resolve()
        })
      })
      expect(settled).toBe(true)
      return okJson(FIXTURE_RESPONSE())
    })
    const controller = await boot({ fetch: fetchUsage, seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
    const [left, right] = await Promise.all([controller.usage(), controller.usage()])
    expect(left).toBe(right)
    expect(fetchUsage.calls).toHaveLength(1)
  })

  it('renders missing subscription state as unavailable, not a thrown failure', async () => {
    const noProvider = await boot({ fetch: recordCalls(async () => okJson(FIXTURE_RESPONSE())) })
    unavailableOf(await noProvider.usage(), /no credential provider is mounted/)

    const unresolvable = await boot({ fetch: recordCalls(async () => okJson(FIXTURE_RESPONSE())), seed: {} })
    unavailableOf(await unresolvable.usage(), /credential OPENCODE_GO_API_KEY is not set/)
  })

  it('reports every failing read as an unavailable answer', async () => {
    for (const answer of [
      recordCalls(async () => { throw new Error('dns outage') }),
      recordCalls(async () => responseOf(401)),
      recordCalls(async () => responseOf(403)),
      recordCalls(async () => okJson({ usage: { rolling: 7 } })),
      recordCalls(async () => okJson({ usage: { rolling: { percent: 101, resetsAt: 'x', status: 'ok' } } })),
    ]) {
      const controller = await boot({ fetch: answer, seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
      unavailableOf(await controller.usage(), /unavailable|could not be reached|answered/)
    }
  })

  it('caches an unavailable answer the same as a success', async () => {
    const fetchUsage = recordCalls(async () => responseOf(401))
    const controller = await boot({ fetch: fetchUsage, seed: { OPENCODE_GO_API_KEY: 'sk-live' } })
    await controller.usage()
    await controller.usage()
    expect(fetchUsage.calls).toHaveLength(1)
  })

  it('fails loud on an unknown config key whose value would ship a credential', () => {
    const config = { apiKey: 'sk-inline-secret' } as ConstructorParameters<typeof OpencodeUsageController>[1]
    expect(() => new OpencodeUsageController(new Context(), config)).toThrow(/unknown config key "apiKey"/)
  })
})
