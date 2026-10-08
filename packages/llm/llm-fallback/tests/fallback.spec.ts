import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import type { Config } from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk>

/** Adapter whose stream results are scripted and whose routes declare fixed context windows. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly entries: ScriptEntry[],
    private readonly windows: Readonly<Record<string, number>> = {},
  ) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('fallback test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[model]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
    })
  }
}

function textResponse(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    ...(usage === undefined ? [] : [{ type: 'usage' as const, usage }]),
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function route(provider: string, model: string): { provider: string; model: string } {
  return { provider, model }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function harness(
  adapter: ScriptedAdapter,
  config: Config,
): Promise<{ ctx: Context; pluginFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const pluginFiber = await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  context = ctx
  return { ctx, pluginFiber }
}

function prompts(adapter: ScriptedAdapter): string[] {
  return adapter.requests.map(request => `${request.provider}/${request.model}`)
}

function selectionEvents(agent: Agent): unknown[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'model/selection')
    .map(event => event.data)
}

describe('automatic model fallback', () => {
  it('rotates to the next chain route and re-runs the failed step', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('Service temporarily overloaded', 'SERVER', { status: 503 }),
      textResponse('recovered'),
    ])
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'nvidia/nemotron-3-ultra-550b-a55b'), route('mock', 'nvidia/nemotron-3-super-120b-a12b')]],
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-rotates'), {
      provider: 'mock',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual([
      'mock/nvidia/nemotron-3-ultra-550b-a55b',
      'mock/nvidia/nemotron-3-super-120b-a12b',
    ])
    expect(selectionEvents(agent)).toEqual([{
      provider: 'mock',
      model: 'nvidia/nemotron-3-super-120b-a12b',
    }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      source: { kind: 'model', provider: 'mock', model: 'nvidia/nemotron-3-super-120b-a12b' },
    })
  })

  it('leaves a failure code outside retryableCodes terminal', async () => {
    const adapter = new ScriptedAdapter([new LlmError('account quota exhausted', 'QUOTA')])
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'primary'), route('mock', 'backup')]],
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-ineligible'), { provider: 'mock', model: 'primary' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/primary'])
    expect(selectionEvents(agent)).toEqual([])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'QUOTA' } } },
    })
  })

  it('stops rotating once maxRotationsPerStep is reached', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('overloaded one', 'SERVER'),
      new LlmError('overloaded two', 'SERVER'),
    ])
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'a'), route('mock', 'b'), route('mock', 'c')]],
      maxRotationsPerStep: 1,
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-capped'), { provider: 'mock', model: 'a' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/a', 'mock/b'])
    expect(selectionEvents(agent)).toEqual([{ provider: 'mock', model: 'b' }])
  })

  it('walks the whole chain under the default per-step cap', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('overloaded one', 'SERVER'),
      new LlmError('overloaded two', 'SERVER'),
      textResponse('recovered'),
    ])
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'a'), route('mock', 'b'), route('mock', 'c')]],
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-chain'), { provider: 'mock', model: 'a' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/a', 'mock/b', 'mock/c'])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })

  it('skips a candidate whose context window cannot hold the current request', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('first turn', { inputTokens: 300_000, outputTokens: 12 }),
      new LlmError('overloaded', 'SERVER'),
      textResponse('second turn'),
    ], { a: 1_000_000, tiny: 262_144, big: 1_000_000 })
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'a'), route('mock', 'tiny'), route('mock', 'big')]],
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-window'), { provider: 'mock', model: 'a' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/a', 'mock/a', 'mock/big'])
    expect(selectionEvents(agent)).toEqual([{ provider: 'mock', model: 'big' }])
  })

  it('uses a small candidate when the context-window check is disabled', async () => {
    const adapter = new ScriptedAdapter([
      textResponse('first turn', { inputTokens: 300_000, outputTokens: 12 }),
      new LlmError('overloaded', 'SERVER'),
      textResponse('second turn'),
    ], { a: 1_000_000, tiny: 262_144, big: 1_000_000 })
    const { ctx } = await harness(adapter, {
      chains: [[route('mock', 'a'), route('mock', 'tiny'), route('mock', 'big')]],
      respectContextWindow: false,
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-window-off'), { provider: 'mock', model: 'a' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/a', 'mock/a', 'mock/tiny'])
  })

  it('stays dormant without configured chains', async () => {
    const adapter = new ScriptedAdapter([new LlmError('overloaded', 'SERVER')])
    const { ctx } = await harness(adapter, {})
    const agent = await ctx.agentLoop.create(SessionId('fallback-dormant'), { provider: 'mock', model: 'a' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(prompts(adapter)).toEqual(['mock/a'])
    expect(selectionEvents(agent)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmFallback')).toBeUndefined()
  })

  it('removes the prompt-size projection when its fiber is disposed', async () => {
    const adapter = new ScriptedAdapter([])
    const { ctx, pluginFiber } = await harness(adapter, {
      chains: [[route('mock', 'a'), route('mock', 'b')]],
    })
    const agent = await ctx.agentLoop.create(SessionId('fallback-dispose'), { provider: 'mock', model: 'a' })
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmFallback')).toEqual({ tokens: null })

    await pluginFiber.dispose()

    expect(ctx.sessionProjections.stateOf(agent.session, 'llmFallback')).toBeUndefined()
  })

  it('rejects an empty or repeating chain at load', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const mount = (config: Config) => ctx.plugin(Object.assign((inner: Context) => {
      fallback.apply(inner, config)
    }, { inject: fallback.inject }))

    await expect(mount({ chains: [[]] })).rejects.toThrow('chains[0] is empty')
    await expect(mount({
      chains: [[route('mock', 'a'), route('mock', 'a')]],
    })).rejects.toThrow('repeats route "mock/a"')
    await ctx.fiber.dispose()
  })
})
