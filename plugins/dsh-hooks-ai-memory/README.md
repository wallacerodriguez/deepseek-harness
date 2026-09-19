# dsh-hooks-ai-memory

Native DeepSeek Harness plugin that forwards harness lifecycle events to a local
[ai-memory](https://github.com/akitaonrails/ai-memory) server, giving DSH the
automatic session capture that every agent in ai-memory's support matrix gets
from lifecycle hooks.

DSH is **not** in ai-memory's support matrix: `ai-memory install-hooks --agent`
accepts `claude-code`, `codex`, `cursor`, `gemini-cli`, `open-code`, `opencode2`,
`pi`, `omp`, `openclaw`, `antigravity-cli`, `grok`, `zero`, `devin`, `kimi-code`,
`kiro-cli`, `kiro-cli-v3`, `command-code`, `pool` and `zcode` — but no DSH row.
This plugin closes that gap without waiting for either project to ship an
integration.

## Why a plugin and not a hooks.json bridge

ai-memory ships a `hooks.json` bridge for Claude Code, and DSH already has
`dsh-hooks-claude-code` to run those hooks on its interception seams. Reusing
that pair needs no new code at all — but it reports every session to ai-memory
as `agent=claude-code`, and it cannot see session disposal.

A native Cordis plugin subscribes to the same canonical events directly with no
serialization boundary, so it reports the truthful agent label and can cover the
session-end edge that closes the session record.

## Event mapping

| DSH event | ai-memory event | Notes |
|---|---|---|
| `agent/created` | `session-start` | Also fetches `/handoff` and injects it into the session |
| `agent/pre-step` | `user-prompt` | Prompt text; observe-only, always delegates |
| `tools/pre-execute` | `pre-tool-use` | Observe-only, always delegates |
| `tools/post-execute` | `post-tool-use` | Observe-only, always delegates |
| `agent/turn-stopping` | `stop` | Turn boundary |
| `session/event` (`compaction/start`) | `pre-compact` | Consolidation trigger mid-session |
| `session/disposed` | `session-end` | Closes the session record for consolidation |

## Wire format

Identical to ai-memory's own hook scripts, so the server needs no changes:

```
POST {url}/hook?event=<event>&agent=<agent>   body = event JSON
GET  {url}/handoff?agent=<agent>&cwd=<cwd>    body = pending handoff text
```

Payload field names follow the Claude Code dialect (`session_id`, `cwd`,
`hook_event_name`, `prompt`, `tool_name`, `tool_use_id`, `tool_response`), which
is the best-tested shape the server parses.

## Install

The plugin is plain ESM JavaScript, deliberately. The `dsh-web` Windows service
launches `node apps/cli/lib/bin.js` with no TypeScript loader, so a
path-referenced plugin must execute as-is — hence the `.mjs` extension, which
keeps Node from reparsing it as CommonJS. It imports nothing at module scope.

Add one row to your profile patch (`$DSH_HOME/profiles/<name>/cordis.patch.yml`):

```yaml
- insert:
    - id: memory-ai-memory-hooks
      name: 'C:/path/to/deepseek-harness/plugins/dsh-hooks-ai-memory/plugin.mjs'
      config:
        url: http://127.0.0.1:49374
        agent: deepseek-harness
```

The path must be **absolute**: DSH anchors a relative `name` beside the patch
file, not beside the checkout. The profile patch is read by HMR, so saving it
reloads the plugin live — no harness restart.

The ai-memory server must already be running (`ai-memory serve --transport http
--bind 127.0.0.1:49374`). If it is not, this plugin degrades to a no-op and logs
one warning per distinct cause; capture resumes when the server returns.

## Making sessions become pages

Capturing events is only half the pipeline. ai-memory stores raw observations
first and compiles them into wiki pages on a **consolidation trigger**, so
without a trigger a session accumulates rows that never become searchable pages.

Two triggers are relevant, and neither is on by default:

- **Compaction.** Handled by this plugin through the `session/event` feed.
  Note that `compaction/*` are session *log* events appended by
  `compaction-basic`, not interception points, so `ctx.on` never sees them
  directly — the post-commit append feed is the only observation channel.
- **Session end.** Opt in on the **server**, not here:

  ```
  AI_MEMORY_CONSOLIDATE_ON_SESSION_END
  ```

  This is a server-side value and applies to every agent using that server, not
  just DSH.

  Set it to a **boolean spelling** (`true`). `1` fails at startup:

  ```
  Error: loading configuration
  Caused by: invalid type: found unsigned int `1`, expected a boolean
    for key "CONSOLIDATE_ON_SESSION_END" in `AI_MEMORY_` environment variable(s)
  ```

  The failure is loud and the server refuses to start, so verify the server came
  back up after restarting it.

With an LLM provider disabled you still get mechanical session pages; the
distilled concept/gotcha/rule pages need `AI_MEMORY_LLM_PROVIDER` configured.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:49374` | ai-memory server base URL |
| `agent` | `deepseek-harness` | Agent label ai-memory records |
| `capture` | `true` | Master switch for all hook capture |
| `capturePrompts` | `true` | Capture user prompts |
| `captureTools` | `true` | Capture tool call edges |
| `injectHandoff` | `true` | Inject the pending handoff at session start |
| `timeoutMs` | `5000` | Per-request timeout |

## Failure behavior

Every request is fire-and-forget and every handler is wrapped, because a memory
backend that is down must never break a turn. The three waterfall handlers
(`agent/pre-step`, `tools/pre-execute`, `tools/post-execute`) always call
`next()` and return its decision unchanged, so this bridge cannot alter what the
agent does. Pending requests are tracked through `ctx.effect` so disposal
reaches quiescence.

## Known limitations

- **Capture requires the server to be running.** DSH starts at boot as a service;
  the ai-memory server has no shipped installer for Windows, so its own startup
  is the operator's responsibility.
- **Tool classification is generic.** The server maps tool names to canonical
  families for agents it knows; for an unrecognized agent the tool event records
  the event type rather than a family. Prompt text is unaffected.
- **No `.ai-memory.toml` marker support.** Routing uses the server's default
  `workspace = "default"` / `project = basename(cwd)`. Declaring a project with a
  marker whose name differs only by case would split an existing `default`
  project, so this plugin intentionally leaves routing alone.
- **No tests.** The repository's test harness is not wired up for a package-less
  plugin; verification is manual and behavioral (inspect the ai-memory wiki log
  after generating traffic).
