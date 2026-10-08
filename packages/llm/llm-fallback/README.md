---
description: "The model-chain fallback executor for users and maintainers keeping agent turns alive when a provider route is overloaded or rate-limited."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

English | [中文](README.zh.md)

## Summary

Mount `@deepseek-ai/dsh-llm-fallback` to rotate an agent to the next model of a configured chain when a request fails with a transient overload or rate limit. The plugin listens on the agent loop's `agent/request-error` waterfall, installs an Agent-scoped model selection, and returns `{ kind: 'retry' }`, so the loop re-runs the failed step on the fallback route inside the same open turn. A candidate whose declared context window cannot hold the current request is skipped. Every rotation is a durable `model/selection` record and one more billed provider request; a composition without `chains` is dormant.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when agent runs should survive a provider route that answers `503 Service temporarily overloaded` or a rate limit by continuing on a different model of the same provider, or on another provider route, instead of failing the turn.

### When to choose it

Choose it when a composition runs the agent loop and the deployment has more than one acceptable route for the same work. The chain is deployment policy, so it is pure configuration: the plugin hardcodes no model, provider, or vendor. Mount it before `@deepseek-ai/dsh-llm-retry` when rotation should win over retrying the same route, and after it when the same route should exhaust its retry budget first — the waterfall short-circuits at the first listener that returns a decision. Skip it for direct `ctx.llm.stream()` consumers, which never enter the agent loop and therefore have no step to re-run.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    chains:
      - - provider: nvidia
          model: nvidia/nemotron-3-ultra-550b-a55b
        - provider: nvidia
          model: nvidia/nemotron-3-super-120b-a12b
        - provider: nvidia
          model: nvidia/nemotron-3.5-lightning-30b-a3b
```

Each chain is an ordered list of exact `provider`/`model` routes. When the route of the failed request appears in a chain, the plugin rotates to the next entry of that chain that this step has not used yet. A route that appears in no chain, a chain with no unused successor, an ineligible failure code, an aborted turn, and an exhausted per-step budget all delegate unchanged. Omission of `retryableCodes` rotates on `SERVER` and `RATE_LIMIT`; `QUOTA` is deliberately absent because it is terminal and account-wide, so another model cannot help. Omission of `respectContextWindow` skips candidates whose declared context window is smaller than the current request; set it to `false` only when every chain entry is known to hold the whole session.

### What you can observe

Before the retry, the plugin appends a durable `model/selection` record naming the fallback route, which makes the rotation visible to the session's model-selection projection and to the client. The retried request then logs its own `request/header` change, so the route actually used is reconstructable from the log exactly like any other model request. The rotation is one-shot per attempt: the plugin's selection is disarmed after the request it armed, and later steps follow the durable request header, so an explicit selection owner such as the ACP model control can still change the route afterwards.

### Failures and recovery

Nothing here replaces provider recovery: when no chain owns the current route, or the owning chain has no unused successor, or the failure code is outside `retryableCodes`, the plugin delegates to the next `agent/request-error` listener and the loop behaves exactly as before. A candidate route whose metadata cannot be resolved is logged and skipped rather than dispatched, because an unregistered route would fail the turn at adapter resolution. The plugin is inert when `chains` is empty: it registers no listener, no projection, and no Agent-scoped selection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the executor; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The plugin is built on one rule: **rotate the route, re-run the step.** The agent loop already owns the only boundary that can change a route mid-turn — the `agent/request` waterfall re-resolves the request config on every attempt, and `{ kind: 'retry' }` from `agent/request-error` re-enters that resolution. The plugin therefore changes no loop behavior: it arms a model selection on the live Agent, returns the retry decision the loop already understands, and lets `prepareRequest` pick up the new route.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The function plugin: waterfall listener, per-agent selection, window check, durable appends |
| [`src/chain.ts`](src/chain.ts) | Pure successor lookup over the configured chains |
| [`src/types.ts`](src/types.ts) | Route and prompt-size types, plus the host-only projection state key |

### Rotation flow

A failed step arrives on the waterfall with its provider and normalized failure. The plugin ignores the event unless the code is eligible, the turn is live, and the Agent already carries an installed selection. It reads the failed request's model from the latest durable `request/header` — the loop logs that header immediately before streaming, so it names the attempt that failed. It then walks from the current route through the unused successors of the owning chain: a candidate whose resolved `context.contextWindow` is smaller than the estimate from the newest `assistant/message` usage is marked used and skipped. The first accepted candidate is recorded as `model/selection`, armed on the Agent's selection reference, and answered with `{ kind: 'retry' }`.

### Waterfall composition

The plugin is one listener in the `agent/request-error` waterfall, and it always calls `next()` on every delegation path, so downstream recovery keeps working. Registration order is the composition's choice: a listener that returns `{ kind: 'retry' }` without calling `next()` prevents every later listener from running, which is exactly how `dsh-llm-retry` consumes its retry budget when it is mounted first.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to the retry executor this plugin composes with.

- [dsh-llm service](../llm/README.md) — the provider-neutral service whose `resolveModelInfo` supplies candidate context windows.
- [llm-retry](../llm-retry/README.md) — the request-error listener that retries the same route before or after rotation.
- [Routed model context](../../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) — how the loop routes model requests and where the request header comes from.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract behind the failures that trigger rotation.

-----

<a id="model-experience"></a>
## Model Experience

### Model-chain rotation

#### What the model sees

The model sees an ordinary request on a different provider/model route; the conversation history above the failed attempt is unchanged, because a failed attempt commits no assistant message and no tool call. No rotation event, failure code, or candidate rejection reaches derived history, and the plugin adds no system-prompt notice: the switched route is carried by the request header and the durable selection record instead.

#### Token effect

Each rotation is a new provider request and repeats input-token billing for the whole prompt. Rotation is bounded per step by `maxRotationsPerStep` and by the unused successors of one chain, so a step issues at most one request per chain entry. The `model/selection` and `request/header` records contribute no tokens.

#### KV Cache effect

The rotated request sends the same prefix, but a different model or provider route has its own cache, so the fallback attempt normally pays uncached input for the full prompt. The window check keeps that cost from ending in a context-length rejection: a candidate that cannot hold the current request is skipped before any request is sent.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the plugin stops and future work begins. They are current package constraints, not a general routing comparison or a task backlog.

- **Rotation follows chain order, not capacity** — the plugin picks the next unused entry, so a deployment that wants load- or cost-aware selection has to express it by ordering chains.
- **The request-size estimate lags one step** — it reads the newest `assistant/message` usage, which the session reports after a successful attempt; a first failed request in a fresh session rotates without a window check.
- **`model/selection` records the chosen route, not the served one** — the retried request's `request/header` establishes which route the provider actually answered.
- **One chain owns each route** — the first chain that names the current route decides its successor, so a route repeated across chains has one effective successor.
- **Rotation does not persist as user intent** — the Agent-scoped selection is disarmed after the request it armed, so a later step returns to another selection owner's route, or to the durable request header when none exists.
- **The context-window check trusts adapter metadata** — a route that declares no `context` is accepted, and a route whose metadata cannot be resolved is skipped with a warning.
- No invariant companion is published because the plugin owns one relation — an armed rotation must be applied by this plugin's own selection listener — that no independent observation can diverge on.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The prompt-size projection key `llmFallback` is host-only, so it never reaches a client snapshot; it is read at rotation time through `ctx.sessionProjections.stateOf`.
- The durable `model/selection` event type is declared by `@deepseek-ai/dsh-api-session-controller/types`; this package imports that module for types only, so the API package is a development dependency and the emitted declarations never reference it.
- The Agent-scoped selection is installed on `agent/created` and for every agent already registered at mount, and its listeners are removed on `agent/disposed` and on plugin disposal.

</details>
