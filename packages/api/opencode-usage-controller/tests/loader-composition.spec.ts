import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as controller from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
const realFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = realFetch
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Mount one test-only composition through the real Loader: config validation, service wiring, and fetch all run against real code. */
async function loadYaml(lines: readonly string[], fetchUsage: typeof fetch): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-opencode-usage-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-api-opencode-usage-controller', controller],
    ['@deepseek-ai/dsh-api-opencode-usage-controller/types', { OpenCodeUsageSnapshot: undefined }],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  globalThis.fetch = fetchUsage
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  await context.plugin(MemoryCredentials, { OPENCODE_GO_API_KEY: 'sk-go-live' })
  return context
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('mounts the plugin and answers the configured usage read through the wire-facing service', { timeout: 60_000 }, async () => {
    const reader = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toBe('https://opencode.ai/zen/go/v1/usage')
      expect(String(new Headers(init?.headers).get('Authorization'))).toBe('Bearer sk-go-live')
      return new Response(JSON.stringify({
        usage: {
          rolling: { status: 'ok', percent: 42, resetsAt: '2026-10-08T00:37:47.000Z' },
          weekly: { status: 'ok', percent: 0, resetsAt: '2026-10-12T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 3, resetsAt: '2026-11-07T18:10:04.000Z' },
        },
      }), { status: 200 })
    }
    const ctx = await loadYaml([
      '- name: \'@deepseek-ai/dsh-api-opencode-usage-controller\'',
      '  config:',
      '    apiKeyEnv: OPENCODE_GO_API_KEY',
    ], reader)
    expect(await ctx.opencodeUsageController.usage()).toMatchObject({
      providerId: 'opencode-go',
      available: true,
      rolling: { percent: 42, resetsAt: '2026-10-08T00:37:47.000Z', status: 'ok' },
    })
  })

  it('serves unavailable for a missing key through the wire-facing service', { timeout: 60_000 }, async () => {
    const reader = async (): Promise<Response> => new Response('', { status: 401 })
    const ctx = await loadYaml(['- name: \'@deepseek-ai/dsh-api-opencode-usage-controller\''], reader)
    expect(await ctx.opencodeUsageController.usage()).toMatchObject({ available: false })
  })
})
