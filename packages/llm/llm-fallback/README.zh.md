---
description: "面向用户与维护者的模型链回退执行器说明：在提供方路由过载或限流时保住 agent 轮次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-fallback

[English](README.md) | 中文

## 概述

挂载 `@deepseek-ai/dsh-llm-fallback`，可在请求因暂时性过载或限流失败时，把 agent 轮换到配置链中的下一个模型。本插件监听 agent loop 的 `agent/request-error` waterfall，安装 Agent 作用域的模型选择，并返回 `{ kind: 'retry' }`，因此 loop 会在同一个打开的轮次内、以回退路由重跑失败步骤，而不是结束该轮次。上下文窗口放不下当前请求的候选会被跳过，因此长会话不会轮换到立即被拒绝的上下文长度。每次轮换都是一条持久的 `model/selection` 记录，每次轮换都是一次额外计费的提供方请求；未配置 `chains` 的组合处于休眠状态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当提供方路由以 `503 Service temporarily overloaded` 或限流作答时，如果 agent 运行应改由同一提供方的另一个模型（或另一条提供方路由）继续，而不是让轮次失败，就挂载本插件。

### 何时选择

当组合运行 agent loop，且部署对同一工作有多条可接受路由时选择它。链是部署策略，因此完全是配置：本插件不硬编码任何模型、提供方或厂商。当轮换应优先于重试同一路由时，把它挂在 `@deepseek-ai/dsh-llm-retry` 之前；当同一路由应先耗尽自己的重试预算时挂在它之后——waterfall 会在第一个返回决定的监听器处短路。直接走 `ctx.llm.stream()` 的消费方跳过它：它们不进入 agent loop，因此没有可重跑的步骤。

### 最小配置

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

每条链是一份精确 `provider`/`model` 路由的有序列表。失败请求的路由出现在某条链中时，插件会轮换到该链中本步骤尚未使用的下一个条目。不出现在任何链中的路由、没有未使用后继的链、不合格的失败 code、已中止的轮次与已耗尽的逐步预算，都会原样委派。省略 `retryableCodes` 时对 `SERVER` 与 `RATE_LIMIT` 轮换；`QUOTA` 被刻意排除，因为它是终止性的且作用于整个账户，换模型也帮不上忙。省略 `respectContextWindow` 时会跳过声明上下文窗口小于当前请求的候选；只有当链中每个条目都确定能容纳整个会话时才把它设为 `false`。

### 你可以观察到什么

重试之前，插件会追加一条持久的 `model/selection` 记录并点名回退路由，使轮换对会话的模型选择投影与客户端可见。随后重试请求会记录自己的 `request/header` 变更，因此实际使用的路由与任何其他模型请求一样可以从日志重建。轮换对每次尝试只生效一次：插件在自己武装的那次请求之后即解除选择，后续步骤跟随持久请求头，因此 ACP 模型控制等显式选择方之后仍可改变路由。

### 失败与恢复

这里不替代提供方恢复：当没有链拥有当前路由、拥有的链没有未使用后继、或失败 code 不在 `retryableCodes` 内时，插件把事件委派给下一个 `agent/request-error` 监听器，loop 的表现与之前完全一致。元数据无法解析的候选路由会被记录并跳过，而不是被派发，因为未注册路由会在适配器解析处让轮次失败。`chains` 为空时插件是惰性的：不注册监听器、不注册投影、也不安装 Agent 作用域的选择。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释执行器背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

插件建立在一条规定之上：**轮换路由，重跑步骤。** agent loop 已经拥有唯一能在轮次中途改变路由的边界——`agent/request` waterfall 在每次尝试时重新解析请求配置，而 `agent/request-error` 返回的 `{ kind: 'retry' }` 会重新进入该解析。因此本插件不改变任何 loop 行为：它在活着的 Agent 上武装一次模型选择，返回 loop 本就理解的 retry 决定，让 `prepareRequest` 取用新路由。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 函数插件：waterfall 监听器、逐 agent 选择、窗口检查、持久追加 |
| [`src/chain.ts`](src/chain.ts) | 在配置链上查找后继的纯函数 |
| [`src/types.ts`](src/types.ts) | 路由与提示词大小类型，以及仅 Host 的投影状态键 |

### 轮换流程

失败步骤连同其提供方与归一化失败一起到达 waterfall。只有 code 合格、轮次仍在进行、且 Agent 已安装选择时，插件才处理该事件。它从最新的持久 `request/header` 读取失败请求的模型——loop 在开始流式传输之前立即记录该头，因此它点名的正是失败的那次尝试。插件随后从当前路由出发，沿所拥有链的未使用后继前进：解析出的 `context.contextWindow` 小于最新 `assistant/message` 用量估算的候选会被标记为已用并跳过。第一个被接受的候选记录为 `model/selection`，武装到 Agent 的选择引用上，并以 `{ kind: 'retry' }` 作答。

### Waterfall 组合

本插件是 `agent/request-error` waterfall 中的一个监听器，并在每条委派路径上调用 `next()`，因此下游恢复仍然有效。注册顺序由组合决定：不调用 `next()` 就返回 `{ kind: 'retry' }` 的监听器会阻止其后所有监听器运行——这正是 `dsh-llm-retry` 先挂载时消耗其重试预算的方式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从服务约定逐步进入本插件所组合的重试执行器。

- [dsh-llm 服务](../llm/README.zh.md)——其 `resolveModelInfo` 提供候选上下文窗口的提供方无关服务。
- [llm-retry](../llm-retry/README.zh.md)——在轮换之前或之后重试同一路由的 request-error 监听器。
- [路由化模型上下文](../../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.zh.md)——loop 如何路由模型请求，以及请求头来自哪里。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——触发轮换的失败背后的 `StreamChunk` 协议与适配器约定。

-----

<a id="model-experience"></a>
## 模型体验

### 模型链轮换

#### 模型看到什么

模型看到的是另一条提供方／模型路由上的普通请求；失败尝试上方的对话历史不变，因为失败尝试不提交任何 assistant 消息或工具调用。轮换事件、失败 code 或候选拒绝都不会进入派生历史，插件也不添加系统提示词通知：被切换的路由由请求头与持久选择记录承载。

#### Token 影响

每次轮换都是一次新的提供方请求，会为整个提示词重复输入 token 计费。轮换按步骤受 `maxRotationsPerStep` 与单条链的未使用后继双重限制，因此一个步骤最多为每个链条目发出一次请求。`model/selection` 与 `request/header` 记录本身不贡献 token。

#### KV Cache 影响

轮换后的请求发送相同前缀，但不同模型或提供方路由拥有各自的缓存，因此回退尝试通常要为整个提示词支付未缓存输入。窗口检查避免这份成本以上下文长度拒绝收场：放不下当前请求的候选会在发出任何请求之前被跳过。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明插件在哪里停止、由未来工作接续。它们是当前包约束，不是通用路由对比或任务积压。

- **轮换遵循链顺序，而非容量**——插件选取下一个未使用条目，因此需要按负载或成本选择的部署要通过链的排序来表达。
- **请求大小估算滞后一步**——它读取最新的 `assistant/message` 用量，而会话在一次成功尝试后才上报该值；新会话中第一次失败的请求会在没有窗口检查的情况下轮换。
- **`model/selection` 记录所选路由，而非实际服务的路由**——重试请求的 `request/header` 才确立提供方实际作答的路由。
- **每条路由只由一条链拥有**——第一条点名当前路由的链决定其后继，因此跨链重复的路由只有一个有效后继。
- **轮换不会持久化为用户意图**——Agent 作用域的选择在自己武装的那次请求之后即解除，因此后续步骤会回到其他选择方的路由；若没有其他选择方，则回到持久请求头。
- **上下文窗口检查信任适配器元数据**——未声明 `context` 的路由会被接受，元数据无法解析的路由会被警告后跳过。
- 不发布 invariant 伴生插件，因为本插件只拥有一条关系——被武装的轮换必须由本插件自己的选择监听器应用——没有独立观察可以与之分歧。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：维护者备注与开放问题。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 提示词大小投影键 `llmFallback` 仅属于 Host，因此永远不会进入客户端快照；轮换时通过 `ctx.sessionProjections.stateOf` 读取。
- 持久 `model/selection` 事件类型由 `@deepseek-ai/dsh-api-session-controller/types` 声明；本包仅以类型方式导入该模块，因此该 API 包只是开发依赖，产出的声明文件从不引用它。
- Agent 作用域的选择在 `agent/created` 时安装，也会为挂载时已注册的每个 agent 安装；其监听器在 `agent/disposed` 与插件释放时移除。

</details>
