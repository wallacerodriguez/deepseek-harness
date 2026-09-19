/**
 * ai-memory capture bridge for DeepSeek Harness.
 *
 * DSH is not in ai-memory's support matrix, so there is no shipped hook
 * integration. This plugin closes that gap natively: instead of translating an
 * external shell-hook protocol, it subscribes to the canonical interception
 * events (`agent/created`, `agent/pre-step`, `tools/pre-execute`,
 * `tools/post-execute`, `agent/turn-stopping`, `session/disposed`) and forwards
 * them to the local ai-memory server's hook ingest endpoint.
 *
 * Wire format (mirrors ai-memory's own hook scripts):
 *   POST {url}/hook?event=<event>&agent=<agent>   body = event JSON
 *   GET  {url}/handoff?agent=<agent>&cwd=<cwd>    body = pending handoff text
 *
 * This file is plain ESM JavaScript on purpose: the `dsh-web` service runs
 * `node apps/cli/lib/bin.js` with no TypeScript loader, so a path-referenced
 * plugin has to execute as-is. It deliberately imports nothing at module scope,
 * and every failure is contained — a memory backend that is down must never
 * break a turn.
 *
 * @module dsh-hooks-ai-memory
 */

/** Cordis plugin name. */
export const name = 'hooks-ai-memory'

/** Text blocks of a DSH message/content array, joined. */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Small stable hash so a repeat failure warns once per distinct cause. */
function warnOnce(state, key, logger, message) {
  if (state.warned.has(key)) return
  state.warned.add(key)
  logger.warn(message)
}

/**
 * Bridge ai-memory capture into one harness profile.
 *
 * @param {object} ctx - Cordis context supplied by the loader.
 * @param {object} [config] - Overlay config from the profile patch.
 * @param {string} [config.url] - ai-memory server base URL.
 * @param {string} [config.agent] - Agent label ai-memory records.
 * @param {boolean} [config.capture] - Master switch for hook capture.
 * @param {boolean} [config.capturePrompts] - Capture user prompts.
 * @param {boolean} [config.captureTools] - Capture tool call edges.
 * @param {boolean} [config.injectHandoff] - Inject the pending handoff at session start.
 * @param {number} [config.timeoutMs] - Per-request timeout.
 */
export function apply(ctx, config = {}) {
  const url = String(config.url ?? 'http://127.0.0.1:49374').replace(/\/+$/, '')
  const agent = String(config.agent ?? 'deepseek-harness')
  const capture = config.capture !== false
  const capturePrompts = capture && config.capturePrompts !== false
  const captureTools = capture && config.captureTools !== false
  const injectHandoff = config.injectHandoff !== false
  const timeoutMs = Number(config.timeoutMs ?? 5000)

  const state = { warned: new Set(), pending: new Set(), disposed: false }
  const unregister = []
  ctx.effect(() => () => {
    state.disposed = true
    for (const stop of unregister) stop()
  }, 'hooks-ai-memory: lifecycle')

  /** Run a fetch without ever letting it reject into the harness. */
  function request(path, init, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const task = (async () => {
      try {
        const response = await fetch(`${url}${path}`, { ...init, signal: controller.signal })
        if (!response.ok) {
          warnOnce(state, `http:${response.status}`, ctx.logger, `hooks-ai-memory: ${path} returned HTTP ${response.status}`)
          return undefined
        }
        return options.text ? await response.text() : undefined
      } catch (error) {
        // A down server, a refused connection, or an abort is expected whenever
        // ai-memory is not running; capture is best-effort by contract.
        warnOnce(state, `net:${String(error?.cause?.code ?? error?.name ?? error)}`, ctx.logger, `hooks-ai-memory: cannot reach ${url} (${String(error?.cause?.code ?? error?.name ?? error)}) — capture skipped`)
        return undefined
      } finally {
        clearTimeout(timer)
      }
    })()
    state.pending.add(task)
    void task.finally(() => state.pending.delete(task))
    return task
  }

  /** Forward one lifecycle event to ai-memory's ingest endpoint. */
  function captureEvent(event, payload) {
    if (!capture || state.disposed) return
    void request(`/hook?event=${encodeURIComponent(event)}&agent=${encodeURIComponent(agent)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  /** The shared identity fields every ai-memory hook payload carries. */
  function base(session, event) {
    return {
      session_id: session?.id ?? '',
      cwd: session?.header?.cwd ?? process.cwd(),
      hook_event_name: event,
    }
  }

  const sessionOf = (payload) => payload?.agent?.session

  // --- SessionStart -------------------------------------------------------
  ctx.on('agent/created', async ({ agent: subject, source }) => {
    const session = subject?.session
    captureEvent('session-start', { ...base(session, 'SessionStart'), source: source ?? 'startup' })

    if (!injectHandoff || state.disposed) return
    try {
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      const query = `agent=${encodeURIComponent(agent)}&cwd=${encodeURIComponent(cwd)}`
      const handoff = await request(`/handoff?${query}`, { method: 'GET' }, { text: true })
      if (typeof handoff !== 'string' || handoff.trim() === '') return
      await inject(subject, handoff)
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: handoff injection failed: ${String(error)}`)
    }
  })

  /**
   * Deliver recalled context as a sourced user message. The message factory
   * lives in a workspace package; resolve it lazily so a resolution failure
   * degrades to capture-only instead of failing the plugin load.
   */
  async function inject(subject, text) {
    let createUserMessage
    try {
      ;({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
    } catch (error) {
      warnOnce(state, 'inject:resolve', ctx.logger, `hooks-ai-memory: cannot resolve @deepseek-ai/dsh-llm (${String(error)}) — handoff injection disabled, capture still active`)
      return
    }
    try {
      subject.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'hooks-ai-memory' },
      }))
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: agent.inject failed: ${String(error)}`)
    }
  }

  // --- UserPromptSubmit ---------------------------------------------------
  // Observe-only: delegate to the next listener and return its decision, so
  // this bridge never changes what the agent does.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (capturePrompts && Array.isArray(payload?.messages) && payload.messages.length > 0) {
        const prompt = blocksToText(payload.messages.flatMap((message) => message?.content ?? []))
        if (prompt !== '') {
          captureEvent('user-prompt', { ...base(sessionOf(payload), 'UserPromptSubmit'), prompt })
        }
      }
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: prompt capture failed: ${String(error)}`)
    }
    return next()
  })

  // --- PreToolUse / PostToolUse -------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (captureTools) {
        captureEvent('pre-tool-use', {
          ...base(exec?.agent?.session, 'PreToolUse'),
          tool_name: exec?.name ?? '',
          tool_use_id: exec?.callId ?? '',
        })
      }
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: pre-tool capture failed: ${String(error)}`)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (captureTools) {
        captureEvent('post-tool-use', {
          ...base(exec?.agent?.session, 'PostToolUse'),
          tool_name: exec?.name ?? '',
          tool_use_id: exec?.callId ?? '',
          tool_response: blocksToText(result?.content),
        })
      }
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: post-tool capture failed: ${String(error)}`)
    }
    return next()
  })

  // --- Stop ---------------------------------------------------------------
  ctx.on('agent/turn-stopping', ({ agent: subject, turn }) => {
    try {
      captureEvent('stop', { ...base(subject?.session, 'Stop'), stop_hook_active: false, turn: turn ?? 0 })
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: stop capture failed: ${String(error)}`)
    }
  })

  // --- SessionEnd ---------------------------------------------------------
  // ai-memory closes the session record here, which is what lets the session
  // become eligible for consolidation into wiki pages.
  ctx.on('session/disposed', (session) => {
    try {
      captureEvent('session-end', { ...base(session, 'SessionEnd'), reason: 'disposed' })
    } catch (error) {
      ctx.logger.warn(`hooks-ai-memory: session-end capture failed: ${String(error)}`)
    }
  })
}
