---
description: "Host Remote owner for the OpenCode Go subscription usage windows behind the web session stats."
kind: "package-reference"
---
# OpenCode Usage Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-opencode-usage-controller` exposes the generated `ctx.remote.opencodeUsage` namespace for web session stats. `usage()` reads the subscription's account usage — rolling (5-hour), weekly, and monthly windows, each a 0–100 `percent` plus a reset instant — through the credential seam, and answers an unavailable state instead of throwing when the source cannot answer. A failed or missing credential read appears to the client as `available: false` with the failure reason; transport errors, HTTP 401/403, and unrecognized payloads present exactly the same way.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves the web client. The entry registers the namespace independently of the credential provider so a missing provider becomes reportable state at invocation. Its generated descriptors enter the strict Typert registry.

`usage()` serves one answer per `cacheTtlMs` and deduplicates concurrent calls into the in-flight read, so a periodically revalidating client never exercises the subscription endpoint more than once per window. The read itself is account state and consumes no subscription quota. An unavailable answer caches the same way, so an unresolvable or failing source answers at most once per TTL — and a 401 read answers again once the key is stored.

Answers carry quota state only: percent, status, reset instant, and the failure reason. Credential values never cross; the reason never embeds the credential, the endpoint URL, or a failure body.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerId` | `opencode-go` | Provider registry id whose routes this usage data describes |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Credential reference the read authenticates with |
| `endpoint` | `https://opencode.ai/zen/go/v1/usage` | Subscription usage read URL (https) |
| `cacheTtlMs` | `60_000` | How long one answer (including an unavailable one) serves |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for accepted fields and their JSDoc.

An unknown config key fails loud at load, so a typo that tries to inline a credential cannot pass silently; resolve the key through the credential seam instead.

<a id="model-experience"></a>
## Model Experience

None, as subscription usage is browser-facing account state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; usage reads do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The dollar value, remaining quota, and token-limit facts the subscription API does not report are absent by design; a future richer source would change `OpenCodeUsageSnapshot`, not this package's config.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The controller owns only its wire projection; the credential seam owns storage and resolution, and the client pill owns its own poll cadence.
