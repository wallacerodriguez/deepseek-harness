// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { OpenCodeUsageSnapshot } from '@deepseek-ai/dsh-api-opencode-usage-controller/types'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { StatsPills } from '../src/client/chat/StatsPills.tsx'
import type { StatsPillsProps } from '../src/client/chat/StatsPills.tsx'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { OpenCodeUsagePill } from '../src/client/chat/OpenCodeUsagePill.tsx'
import { currentSessionRoute } from '../src/client/chat/opencode-usage.ts'
import type { AssistantMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { en, zh } from '../src/client/locale.ts'

const tEn = makeTranslate(en, commonEn)
const tZh = makeTranslate(zh, commonZh)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const TURN_USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }
const TOKEN_PROJECTION: TokenUsageProjection = TURN_USAGE

const assistant = (seq: number, turn: number): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: seq, blocks: [{ kind: 'text', text: `t${seq}` }],
})

/** A full example answer naming all three windows. */
const AVAILABLE: OpenCodeUsageSnapshot = {
  providerId: 'opencode-go',
  available: true,
  fetchedAt: '2026-10-07T18:00:00.000Z',
  rolling: { percent: 42, resetsAt: '2026-10-07T23:37:47.000Z', status: 'ok' },
  weekly: { percent: 0, resetsAt: '2026-10-12T00:00:00.000Z', status: 'ok' },
  monthly: { percent: 3, resetsAt: '2026-11-07T18:10:04.000Z', status: 'ok' },
}

const UNAVAILABLE: OpenCodeUsageSnapshot = {
  ...AVAILABLE,
  available: false,
  unavailableReason: 'subscription usage endpoint answered 401',
  rolling: null,
  weekly: null,
  monthly: null,
}

function pillProps(fetch: () => Promise<OpenCodeUsageSnapshot | null>, currentRoute = 'opencode-go', open = false) {
  return {
    currentRoute,
    fetchOpencodeUsage: fetch,
    t: tEn,
    dialog: { open, setOpen: () => {} },
  }
}

function renderPill(fetch: () => Promise<OpenCodeUsageSnapshot | null>, currentRoute = 'opencode-go') {
  return render(<OpenCodeUsagePill {...pillProps(fetch, currentRoute)} />)
}

describe('currentSessionRoute', () => {
  it('answers the latest billed turn provider and none before usage', () => {
    type AttributedTurn = {
      readonly uncachedInputTokens: number
      readonly outputTokens: number
      readonly totalTokens: number
      readonly routes: readonly [{ provider: string; model: string }]
    }
    const routesOf = (provider: string): AttributedTurn => ({
      uncachedInputTokens: 10, outputTokens: 5, totalTokens: 105,
      routes: [{ provider, model: 'deepseek-flash' }],
    })
    const snapshot = chatSnapshotFixture({
      nodes: [assistant(1, 1), assistant(2, 2)],
      turnEnds: new Map([[1, 99], [2, 199]]),
      turnUsages: new Map([
        [1, routesOf('opencode-go')],
        [2, routesOf('deepseek-official')],
      ]),
    })
    expect(currentSessionRoute(snapshot)).toBe('deepseek-official')
    expect(currentSessionRoute(chatSnapshotFixture({ nodes: [assistant(1, 1)] }))).toBeNull()
  })
})

describe('OpenCodeUsagePill', () => {
  it('renders nothing until one answer is held, then leads with the rolling percent', async () => {
    const view = renderPill(async () => AVAILABLE)
    expect(view.container.textContent).toBe('')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getByText('OpenCode Go 42%')).toBeTruthy()
  })

  it('hides itself for another current provider and on a null wire answer', async () => {
    const otherProvider = renderPill(async () => AVAILABLE, 'deepseek-official')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(otherProvider.container.textContent).toBe('')

    const wireNull = renderPill(async () => null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(wireNull.container.textContent).toBe('')
  })

  it('shows the unavailable reading when the Host reports unavailable state', async () => {
    const view = renderPill(async () => UNAVAILABLE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getByText('OpenCode Go unavailable')).toBeTruthy()
  })

  it('opens the dialog with the three windows, percents, and reset instants', async () => {
    const view = renderPill(async () => AVAILABLE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    view.rerender(<OpenCodeUsagePill {...pillProps(async () => AVAILABLE, 'opencode-go', true)} />)
    expect(document.querySelector('[data-opencode-usage-details]')).toBeTruthy()
    expect(view.getByText('42%')).toBeTruthy()
    expect(view.getAllByText('42%')).toHaveLength(1)
    expect(view.getAllByText('0%')).toHaveLength(1)
    expect(view.getAllByText('3%')).toHaveLength(1)
    expect(view.getAllByText('Wk').length).toBe(1)
    expect(document.body.textContent).toContain('Resets')
  })

  it('shows the unavailable reason inside the dialog', async () => {
    const view = renderPill(async () => UNAVAILABLE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    view.rerender(<OpenCodeUsagePill {...pillProps(async () => UNAVAILABLE, 'opencode-go', true)} />)
    expect(document.body.textContent).toContain('Unavailable: subscription usage endpoint answered 401')
  })

  it('revalidates at the read cadence and skips hidden-document intervals', async () => {
    const fetchUsage = vi.fn(async () => AVAILABLE)
    renderPill(fetchUsage)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchUsage).toHaveBeenCalledTimes(2)
  })
})

describe('StatsPills third pill', () => {
  it('renders the subscription pill beside the two stats pills while the current route is the subscription', async () => {
    const snapshot = chatSnapshotFixture({
      nodes: [assistant(1, 1)],
      turnEnds: new Map([[1, 99]]),
      turnUsages: new Map<number, never>([
        [1, { ...TURN_USAGE, totalTokens: 105, routes: [{ provider: 'opencode-go', model: 'grok-code' }] } as never],
      ]),
    })
    const view = render(<StatsPills
      useChat={bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: () => () => {} })}
      useProjection={(() => TOKEN_PROJECTION) as StatsPillsProps['useProjection']}
      t={tZh}
      fetchOpencodeUsage={async () => AVAILABLE}
    />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.getAllByRole('button').map(pill => pill.textContent?.includes('OpenCode Go'))
      .filter(Boolean)).toHaveLength(1)
  })

  it('renders no subscription pill while the current route is another provider', () => {
    const snapshot = chatSnapshotFixture({
      nodes: [assistant(1, 1)],
      turnEnds: new Map([[1, 99]]),
      turnUsages: new Map<number, never>([
        [1, { ...TURN_USAGE, totalTokens: 105, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] } as never],
      ]),
    })
    const props = {
      useChat: bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: () => () => {} }),
      useProjection: (() => TOKEN_PROJECTION),
      t: tEn,
      fetchOpencodeUsage: async () => AVAILABLE,
    } as unknown as StatsPillsProps
    const view = render(<StatsPills {...props} />)
    expect(view.getAllByRole('button').map(pill => pill.textContent?.includes('OpenCode Go'))).toEqual([false])
  })
})
