---
description: "Web 会话统计背后 OpenCode Go 订阅用量窗口的 Host Remote owner。"
kind: "package-reference"
---
# OpenCode Usage Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-opencode-usage-controller` 为 Web 会话统计提供生成的 `ctx.remote.opencodeUsage` namespace。`usage()` 通过凭据 seam 读取订阅账户用量——滚动（5 小时）、每周、每月三个窗口，各为 0–100 的 `percent` 加重置时刻——并在来源无法应答时回答不可用状态而非抛出。失败或缺失凭据的读取对客户端表现为 `available: false` 及失败原因；传输错误、HTTP 401/403 与无法识别的载荷呈现方式完全相同。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包作为 Loader entry 挂载到提供 Web 客户端的 profile 中。本 entry 不依赖凭据提供方是否存在而注册该 namespace，因此缺失提供方会在调用时成为可报告状态。它生成的 descriptor 进入严格 Typert 注册表。

`usage()` 在每个 `cacheTtlMs` 内只应答一次，并把并发调用合并到同一在途读取，因此周期性重验证的客户端每个时间窗最多触碰订阅端点一次。读取本身是账户状态，不消耗订阅配额。不可用答案照常缓存，因此无法解析或失败的来源每个 TTL 至多应答一次——而 401 读取在密钥存入后会再次应答。

答案只携带配额状态：percent、status、重置时刻与失败原因。凭据值永不跨越 wire；原因不会内嵌凭据、端点 URL 或失败响应体。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerId` | `opencode-go` | 该用量数据所描述的提供方注册表 id |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 读取进行鉴权所用的凭据引用 |
| `endpoint` | `https://opencode.ai/zen/go/v1/usage` | 订阅用量读取 URL（https） |
| `cacheTtlMs` | `60_000` | 单个答案（含不可用答案）的存续时长 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是受接受字段及其 JSDoc 的详尽来源。

未知配置键在加载时大声失败，因此内联凭据的笔误无法静默通过；请改为通过凭据 seam 解析密钥。

<a id="model-experience"></a>
## 模型体验

无：订阅用量是浏览器侧账户状态，不注册任何提示词、工具或会话事件。

#### KV Cache 效果

无直接影响；用量读取不改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 订阅 API 不报告的美元数值、余量与 token 上限事实在设计上缺失；未来更丰富的来源会改变 `OpenCodeUsageSnapshot`，而非本包的 config。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**运行时不变量：** 不发布伴随 invariant。控制器只拥有其 wire 投影；凭据 seam 拥有存储与解析，客户端 pill 拥有自己的轮询节奏。
