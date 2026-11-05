# M04 模型访问

<a id="m04-goals"></a>
## 学完能回答

1. 一条 `user` 消息从 `streamFn(model, context, options)` 到最终 `AssistantMessage` 要经过哪些函数？成功时的事件顺序是什么？
2. `streamSimple` 为什么同步返回流？认证、路由或供应商建连失败时，错误在哪里变成事件？`result()` 会 reject 吗？
3. `ModelRuntime.prepareRequest` 具体解析哪些东西？它明确不负责哪些事情？
4. `AgentLoop.config.prepareRequest` 和 `ModelRuntime.prepareRequest` 分别在哪一层、什么时候运行、返回什么？为什么同名却不是同一个函数？
5. 虚拟模型的 `api` 是什么？`resolveModel` 如何选出物理模型？路由状态由谁、以什么形式保存？直接调用 `streamSimple` 时为什么不写状态？
6. `normalizeContext` 对连续同角色消息、连续 `toolResult`、图片和空内容分别做什么？它不做的事情落在哪两个适配层？
7. `getAuth`、`checkAuth`、`hasConfiguredAuth` 各能证明什么？OAuth 刷新在哪个方法里发生？
8. 统一事件里的 `partial` 为什么不能当快照保存？`done` 和 `error` 的最终消息如何从流里取出？

<a id="m04-duty"></a>
## 一句话职责

把“统一消息 + 模型选择”翻译成一次供应商请求：解析认证、处理虚拟模型路由、应用代理和请求头，然后返回统一的 `AssistantMessageEventStream`。

<a id="m04-plain"></a>
## 大白话总览

会话里选择的 `anthropic/claude-sonnet-...` 只是一个名字。这个名字本身不包含请求所需的全部信息：请求发到哪个域名、路径是什么、用哪种 JSON 形状、带哪个 key、历史消息怎么排、工具怎么声明、返回的 SSE 片段怎么变成统一事件，都要由这一层补齐或转交。

一次真实请求至少需要下面几类信息：

| 需要什么 | 具体例子 | 谁提供 |
| --- | --- | --- |
| 供应商和端点 | `provider: "anthropic"`、`baseUrl: "https://api.anthropic.com"` | 模型目录，认证结果可以覆盖 `baseUrl` |
| 协议形状 | `api: "anthropic-messages"` | `Model` 元数据 |
| 凭证 | API key、OAuth token、显式授权头 | `AuthStorage`、环境变量、请求选项、运行期覆盖 |
| 模型参数 | `id`、`maxTokens`、`temperature`、思考档位 | `Model` 和本次 `options` |
| 消息与工具 | system、user、assistant、toolResult、工具声明 | `Context` / `TranscriptContext` |
| 流事件 | `text_delta`、`toolcall_delta`、`done` | 供应商适配器 |

M04 做的是双向翻译：

1. 进入时，把统一的 `Model`、`Context`、`options` 变成某个供应商能接受的 HTTP 请求。
2. 返回时，把供应商的 SSE/JSON 事件翻译成统一的 `AssistantMessageEvent`，最后汇成一条 `AssistantMessage`。

它不负责另外三件事：

- 工具循环。模型返回 `toolUse` 后，M04 只把 `toolCall` 放进 `AssistantMessage` 并结束这次流；真正执行工具、把 `toolResult` 放回历史、再发下一次请求，是 [M02 Agent 循环](../02-agent-loop/README.md#m02-walk-tools)。
- 会话持久化。消息从会话树投影、压缩、虚拟路由状态保存，是 [M03 会话与上下文](../03-session-and-context/README.md#m03-store)。
- 交互界面。什么时候显示文本、什么时候弹出工具审批，是 M05 的事。

可以把它想成跨境寄件：用户给的是收件人和包裹（统一的模型和消息），这一层换成本地承运商的运单格式（供应商请求），再把轨迹翻译回统一状态（统一事件）。包裹里装什么、后续怎么处理，不是这一层的职责。

<a id="m04-position"></a>
## 在链路中的位置

### 上游

- [M02 Agent 循环](../02-agent-loop/README.md#m02-walk-stream)：`streamAssistantResponse()` 调用注入的 `streamFn`。这一步只负责发起请求和消费事件；工具循环仍由 M02 决定。
- [M03 会话与上下文](../03-session-and-context/README.md#m03-store)：压缩摘要、重试、模型切换也会调用这里。虚拟模型的路由状态由会话分支保存，不在 `ModelRuntime` 里落盘。
- [M01 入口与装配](../01-entry-and-config/README.md#m01-routes)：`ModelRuntime` 作为服务创建，认证存储在 `AuthStorage`。

### 下游

- `packages/ai/src/api/*`：每个 API 协议的 `streamSimple` 实现。
- 供应商 HTTP/SSE 接口。这里只负责发请求和读响应，不执行模型提出的工具。
- `packages/ai/src/utils/event-stream.ts`：统一事件流。调用方既可以逐事件迭代，也可以等 `result()` 拿最终消息。

对应全链路：[S9](../00-full-chain/README.md#m00-s9)、[S10](../00-full-chain/README.md#m00-s10)。工具往返在 [S11](../00-full-chain/README.md#m00-s11)。

<a id="m04-terms"></a>
## 关键概念

| 概念 | 具体值或例子 | 在本模块中的作用 |
| --- | --- | --- |
| `Model` | `{ provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-...", baseUrl: "https://api.anthropic.com", maxTokens: 8192 }` | 目录元数据；决定找哪个 provider、走哪种协议、默认端点和能力上限 |
| provider | `anthropic`、`github-copilot`、`openrouter` | 注册表中的实现键；决定用哪份凭证、哪个网关和哪套请求头 |
| api | `anthropic-messages`、`openai-responses` | 协议实现键；决定请求体和事件解析方式 |
| model id | `claude-sonnet-...` | 供应商标识的具体模型；同一个 id 在不同 provider 下可能是不同部署 |
| `Provider` | 实现 `getModels()`、`stream()`、`streamSimple()`、`auth` 的对象 | 真正持有协议适配器和认证能力 |
| `ModelRuntime` | `packages/coding-agent/src/core/model-runtime.ts` 中的类 | 编码代理侧的运行时门面：组合 provider、认证、目录快照和虚拟路由 |
| `StreamFunction` | `(model, context, options) => AssistantMessageEventStream` | Agent 注入的流函数签名；同步返回流对象 |
| `Context` | `{ systemPrompt?: string, messages: Message[], tools?: Tool[] }` | 调用方可以传顶层 system 和 tools 的原始上下文 |
| `TranscriptContext` | `{ messages: Message[] }`（带编译期品牌） | 规范化后的上下文；system 和 tools 已经折进消息 |
| 统一流事件 | `start`、`text_delta`、`thinking_delta`、`toolcall_delta`、`done`、`error` 等 | 所有 provider 都必须说同一种“流语言” |
| 虚拟模型 | `{ provider: "p", id: "smart", api: "pi-virtual" }` | 不是供应商模型，而是一个路由入口；请求前要换成物理模型 |
| 认证结果 `AuthResult` | `{ auth: { apiKey, baseUrl?, headers? }, env?, source? }` | 真正可用于请求的认证；可能已经刷新过 OAuth |
| 认证检查 `AuthCheck` | `{ source?: string, type: "api_key" \| "oauth" }` | 只表示“配置上有没有”，不包含可直接发送的 token |
| `normalizeContext` | 把 `systemPrompt`、`tools` 折进首条 system 消息 | 产出 `TranscriptContext`，统一 provider 的输入形状 |
| `lazyStream` | 同步返回外层流，立即执行异步 setup | 把认证/建连错误变成 `error` 事件，而不是调用方同步异常 |

这几个概念不是同义词。`ModelRuntime` 是编码代理的运行期门面；pi-ai 里的 `Models`/`Provider` 是可复用的库层抽象；`StreamFunction` 只是 Agent 注入的一个函数形状。读代码时先确认当前处在哪一层，再看它拿的是 `Context` 还是 `TranscriptContext`。

另有一对同名函数必须分开：`AgentLoop.config.prepareRequest` 是每次模型请求前的钩子（类型 `PrepareRequest`，位于 `packages/agent/src/types.ts:240`，由 `agent-loop.ts:377` 调用并允许返回新的 `context`/`model`/`thinkingLevel`），负责会话投影和虚拟路由；`ModelRuntime.prepareRequest` 是 `model-runtime.ts:1198` 的私有方法，只解析 provider、认证、baseURL、headers 和 env。前者决定“这次请求发什么历史和模型”，后者决定“用哪份凭证和端点发”。

<a id="m04-example"></a>
## 运行示例

下面跟踪一条用户消息，从 `streamFn` 一路走到 `AssistantMessage`。模型 id 和数值是示意，字段形状来自实际代码。

起点：

```ts
model = {
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-sonnet-...",
  baseUrl: "https://api.anthropic.com",
  maxTokens: 8192,
  // 其余目录字段省略
}

context = {
  systemPrompt: "你是一个代码助手。",
  messages: [
    { role: "user", content: [{ type: "text", text: "读取 README.md 前 20 行并总结" }] },
  ],
  tools: [
    { name: "read", description: "读取文件", parameters: { /* JSON Schema */ } },
  ],
}

options = { signal, maxTokens: 4096, reasoning: "medium" }
```

### 第一步：`normalizeContext`

`ModelRuntime.streamSimple` 先调用 `normalizeContext(context)`。它把顶层 `systemPrompt` 和 `tools` 折进一条新的首条 system 消息：

```ts
transcript.messages = [
  {
    role: "system",
    content: "你是一个代码助手。",
    toolsAdded: [{ name: "read", description: "读取文件", parameters: { /* ... */ } }],
    timestamp: 0,
  },
  { role: "user", content: [{ type: "text", text: "读取 README.md 前 20 行并总结" }] },
]
```

注意几点：

- 原来的 `context.messages` 没有被修改；需要前插时创建新数组。
- 顶层 `systemPrompt`、`tools` 不再作为单独字段存在。后面所有 provider 都只从 `messages` 里读。
- 这一步不做摘要、不合并同角色消息、不清理空内容、不转换图片。那些工作分别在供应商适配器里完成，见下文“`normalizeContext`”。

### 第二步：`lazyStream` 与 `prepareRequest`

`api` 不是 `pi-virtual`，所以走物理模型分支：

```ts
return lazyStream(model, async () => {
  assertChatModel(model);
  const prepared = await this.prepareRequest(model, options);
  return prepared.provider.streamSimple(prepared.model, transcript, prepared.options);
});
```

`streamSimple` 本身不是 `async`，调用方立刻拿到一个 `AssistantMessageEventStream`。异步 setup 已经开始，但还没有发出 HTTP 请求，也还没有 `start` 事件。

`prepareRequest` 依次做：

1. 按 `model.provider` 找到 `anthropic` 的 `Provider`。找不到就抛 `ModelsError("provider", ...)`。
2. 调用 `getAuth(model, { apiKey, env, signal })`。这里可能读取 `auth.json`、刷新 OAuth、执行配置里的 key 命令。没有认证就抛 `ModelsError("auth", ...)`。
3. 如果认证结果带 `baseUrl`，浅复制模型并覆盖 `baseUrl`。
4. 合并请求头，优先级从低到高：OpenCode 会话头、认证和模型配置头、本次请求显式头。然后执行 `transformHeaders`。
5. 合并环境变量：认证环境在前，本次请求环境在后，同名键由请求覆盖。
6. 返回 `{ provider, model, options }`，其中 `apiKey` 优先用本次请求显式值，否则用认证结果。

这些错误都发生在 `lazyStream` 的 setup 里，所以最终会变成 `error` 事件，而不是直接抛给 Agent 的事件循环。

### 第三步：供应商组装请求

`prepared.provider.streamSimple(...)` 进入 Anthropic Messages 实现。该实现先做认证形状检查，再根据 `options.reasoning` 决定思考参数，最后进入真实的 `stream`。

`buildParams` 产出的请求体核心字段大致是：

```ts
{
  model: "claude-sonnet-...",
  messages: [
    { role: "user", content: [{ type: "text", text: "读取 README.md 前 20 行并总结" }] },
  ],
  max_tokens: 4096,
  stream: true,
  system: [
    { type: "text", text: "你是一个代码助手。" },
  ],
  tools: [
    { name: "read", description: "读取文件", input_schema: { /* JSON Schema */ } },
  ],
}
```

这里只列出实际会由代码写出的字段。条件字段还有：

- `thinking`：没有请求思考档位时可能显式 `{ type: "disabled" }`；旧式预算模型是 `{ type: "enabled", budget_tokens, display }`；支持 adaptive 的模型可能是 `{ type: "adaptive", display }`，并另带 `output_config.effort`。
- `temperature`：只有当调用方提供、没有开启思考、模型没有管理 effort、且声明支持温度时才会发送。
- `betas`、`metadata`、`tool_choice`、`fallbacks`：只有对应配置存在时才出现。

初始 system 消息不会留在 `messages` 里，而是被提到顶层 `system`。这是 Anthropic 协议的要求；OpenAI Responses、Bedrock 等适配器会按各自协议处理。

### 第四步：HTTP 和 SSE

真实请求由类似下面的调用建立：

```ts
client.beta.messages.create(params, { signal, maxRetries: 0 }).asResponse()
```

外层包了 `retryProviderRequest`，但它只负责“建立 HTTP 请求”这一段的失败重试。SSE 开始输出之后的错误不会回到这里重试。

拿到响应后，provider 先推统一 `start`，然后用自己的 SSE 解码器逐条读取 Anthropic 事件：

```text
message_start
content_block_start   (text)
content_block_delta   (text_delta)
content_block_delta   (text_delta)
content_block_stop
content_block_start   (tool_use)
content_block_delta   (input_json_delta)
content_block_stop
message_delta         (stop_reason: "tool_use")
message_stop
```

翻译成统一事件后，调用方看到的是：

```text
start        { partial }
text_start   { contentIndex: 0 }
text_delta   { contentIndex: 0, delta: "我先" }
text_delta   { contentIndex: 0, delta: "读取文件。" }
text_end     { contentIndex: 0, content: "我先读取文件。" }
toolcall_start { contentIndex: 1 }
toolcall_delta { contentIndex: 1, delta: "{\"path\":" }
toolcall_delta { contentIndex: 1, delta: "\"README.md\",\"limit\":20}" }
toolcall_end   { contentIndex: 1, toolCall: { ... } }
done           { reason: "toolUse", message: { ... } }
```

`toolcall_delta.delta` 是原始 JSON 文本片段，单独一段通常不能 `JSON.parse`。Anthropic 适配器内部用 `ToolCallArgumentsStream` 维护一个可容错的参数预览；完整参数在 `toolcall_end.toolCall.arguments` 里。

### 第五步：最终 `AssistantMessage`

`done.message` 就是完整回复。字段关系如下，数值省略：

```ts
{
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-...",
  content: [
    { type: "text", text: "我先读取文件。" },
    {
      type: "toolCall",
      id: "toolu_...",
      name: "read",
      arguments: { path: "README.md", limit: 20 },
    },
  ],
  usage: {
    input: /* ... */,
    output: /* ... */,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: /* input + output + cacheRead + cacheWrite */,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  rawStopReason: "tool_use",
  timestamp: /* ... */,
}
```

Agent 收到 `done` 后：

1. 把这条 `AssistantMessage` 写进历史。
2. 看到 `stopReason === "toolUse"`，执行 `read` 工具。
3. 把工具结果作为新的消息，发起下一次请求。

第 2、3 步不在 M04 里，见 [M02 的工具执行](../02-agent-loop/README.md#m02-walk-tools) 和 [S11](../00-full-chain/README.md#m00-s11)。

如果认证失败，调用方看到的则是：

```text
error { reason: "error", error: {
  role: "assistant",
  content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ... } },
  stopReason: "error",
  errorMessage: "Provider is not configured: anthropic",
  ...
} }
```

这时没有 `start`，也没有任何文本块。

<a id="m04-files"></a>
## 文件路由

| 文件 | 职责 |
| --- | --- |
| [core/model-runtime.ts](../../../../../packages/coding-agent/src/core/model-runtime.ts "model-runtime.ts") | 运行时门面：注册表、认证、路由、请求装配 |
| [core/model-registry.ts](../../../../../packages/coding-agent/src/core/model-registry.ts "model-registry.ts") | 模型目录和 provider 注册 |
| [core/model-resolver.ts](../../../../../packages/coding-agent/src/core/model-resolver.ts "model-resolver.ts") | 模型字符串/默认值/历史选择的解析 |
| [core/auth-storage.ts](../../../../../packages/coding-agent/src/core/auth-storage.ts "auth-storage.ts") | 凭证存储与刷新 |
| [core/runtime-credentials.ts](../../../../../packages/coding-agent/src/core/runtime-credentials.ts "runtime-credentials.ts") | 进程内临时 API key 覆盖层 |
| [core/virtual-models.ts](../../../../../packages/coding-agent/src/core/virtual-models.ts "virtual-models.ts") | 虚拟模型注册、路由输入/输出、分支状态读取 |
| [core/agent-session.ts](../../../../../packages/coding-agent/src/core/agent-session.ts "agent-session.ts") | 会话侧虚拟路由调用和状态条目持久化 |
| [ai/src/models.ts](../../../../../packages/ai/src/models.ts "models.ts") | pi-ai 的 `Models`、`Provider` 契约和底层认证检查 |
| [ai/src/auth/resolve.ts](../../../../../packages/ai/src/auth/resolve.ts "resolve.ts") | 认证优先级、OAuth 刷新 |
| [ai/src/types.ts](../../../../../packages/ai/src/types.ts "types.ts") | `Model`、`Provider`、`AssistantMessageEvent` |
| [ai/src/utils/transcript.ts](../../../../../packages/ai/src/utils/transcript.ts "transcript.ts") | `normalizeContext` 和会话轨迹辅助函数 |
| [ai/src/utils/event-stream.ts](../../../../../packages/ai/src/utils/event-stream.ts "event-stream.ts") | `AssistantMessageEventStream` |
| [ai/src/api/lazy.ts](../../../../../packages/ai/src/api/lazy.ts "lazy.ts") | 同步返回流、异步建立请求 |
| [ai/src/api/transform-messages.ts](../../../../../packages/ai/src/api/transform-messages.ts "transform-messages.ts") | 跨模型历史转换、图片降级、工具调用 id 规范 |
| [ai/src/api/anthropic-messages.ts](../../../../../packages/ai/src/api/anthropic-messages.ts "anthropic-messages.ts") | Anthropic Messages 实现 |
| [ai/src/api/openai-responses.ts](../../../../../packages/ai/src/api/openai-responses.ts "openai-responses.ts") | OpenAI Responses 实现 |
| [ai/src/utils/provider-retry.ts](../../../../../packages/ai/src/utils/provider-retry.ts "provider-retry.ts") | 建立 HTTP 请求阶段的重试 |
| [ai/src/providers/faux.ts](../../../../../packages/ai/src/providers/faux.ts "faux.ts") | 测试用 faux provider，可读性最好的实现参考 |

<a id="m04-routes"></a>
## 函数路由

### ModelRuntime

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M04.runtime.class` | `ModelRuntime` | [model-runtime.ts:325](../../../../../packages/coding-agent/src/core/model-runtime.ts#L325 "export class ModelRuntime") | 运行时门面 |
| `M04.runtime.stream` | `stream` | [model-runtime.ts:1289](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1289 "stream<TApi extends Api>(") | API 专属流入口 |
| `M04.runtime.simple` | `streamSimple` | [model-runtime.ts:1333](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1333 "streamSimple(model: Model<Api>") | 通用流入口；处理虚拟路由 |
| `M04.runtime.provider` | `provider.streamSimple` | [model-runtime.ts:1374](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1374 "prepared.provider.streamSimple(") | 真正进入供应商实现 |
| `M04.runtime.complete` | `completeSimple` | [model-runtime.ts:1380](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1380 "completeSimple(model: Model<Api>") | 等完整结果，不逐 delta |
| `M04.runtime.prepare` | `prepareRequest` | [model-runtime.ts:1198](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1198 "private async prepareRequest") | 认证、baseURL、headers、env |
| `M04.runtime.route` | `resolveModel` | [model-runtime.ts:1816](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1816 "async resolveModel(") | 虚拟模型 -> 物理模型 |
| `M04.runtime.apiKey` | `setRuntimeApiKey` | [model-runtime.ts:1132](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1132 "setRuntimeApiKey(providerId: string, apiKey: string") | 仅当前进程的 key 覆盖 |
| `M04.runtime.auth` | `getAuth` | [model-runtime.ts:1013](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1013 "async getAuth(") | 真实认证解析；模型输入时合并配置头 |
| `M04.runtime.checkAuth` | `checkAuth` | [model-runtime.ts:888](../../../../../packages/coding-agent/src/core/model-runtime.ts#L888 "async checkAuth(providerId") | 只查认证配置类型，不刷新 token |
| `M04.runtime.configured` | `hasConfiguredAuth` | [model-runtime.ts:1002](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1002 "hasConfiguredAuth(providerId: string): boolean") | 同步查最近认证快照 |
| `M04.runtime.physical` | `getPhysicalModel` | [model-runtime.ts:1879](../../../../../packages/coding-agent/src/core/model-runtime.ts#L1879 "getPhysicalModel(providerId: string") | 目录中的物理聊天模型 |

### 协议与事件

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M04.types.model` | `Model` | [ai/src/types.ts:1225](../../../../../packages/ai/src/types.ts#L1225 "export interface Model<TApi extends Api>") | 模型元数据 |
| `M04.types.event` | `AssistantMessageEvent` | [ai/src/types.ts:1167](../../../../../packages/ai/src/types.ts#L1167 "export type AssistantMessageEvent") | 统一流事件联合 |
| `M04.types.streamFn` | `StreamFunction` | [ai/src/types.ts:503](../../../../../packages/ai/src/types.ts#L503 "export type StreamFunction") | Agent 注入的函数签名 |
| `M04.types.provider` | `ProviderStreams` | [ai/src/types.ts:393](../../../../../packages/ai/src/types.ts#L393 "export interface ProviderStreams") | API 实现统一契约 |
| `M04.types.context` | `Context` | [ai/src/types.ts:1124](../../../../../packages/ai/src/types.ts#L1124 "export interface Context") | 顶层 system/tools 的原始输入 |
| `M04.types.transcript` | `TranscriptContext` | [ai/src/types.ts:1143](../../../../../packages/ai/src/types.ts#L1143 "export type TranscriptContext") | 只含 messages 的规范上下文 |
| `M04.types.usage` | `Usage` | [ai/src/types.ts:604](../../../../../packages/ai/src/types.ts#L604 "export interface Usage") | token 和费用 |
| `M04.types.assistant` | `AssistantMessage` | [ai/src/types.ts:809](../../../../../packages/ai/src/types.ts#L809 "export interface AssistantMessage") | 最终回复结构 |
| `M04.types.eventStream` | `AssistantMessageEventStream` | [ai/src/utils/event-stream.ts:152](../../../../../packages/ai/src/utils/event-stream.ts#L152 "export class AssistantMessageEventStream") | 事件流与 `result()` |
| `M04.transcript.normalize` | `normalizeContext` | [ai/src/utils/transcript.ts:46](../../../../../packages/ai/src/utils/transcript.ts#L46 "export function normalizeContext(") | 把 system/tools 收进消息 |
| `M04.lazy.stream` | `lazyStream` | [ai/src/api/lazy.ts:117](../../../../../packages/ai/src/api/lazy.ts#L117 "export function lazyStream(") | 同步返回、异步 setup、错误转事件 |

### 供应商实现

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M04.provider.anthropic` | `anthropic streamSimple` | [anthropic-messages.ts:1633](../../../../../packages/ai/src/api/anthropic-messages.ts#L1633 "export const streamSimple: StreamFunction") | Anthropic Messages 协议 |
| `M04.provider.openai` | `openai streamSimple` | [openai-responses.ts:502](../../../../../packages/ai/src/api/openai-responses.ts#L502 "export const streamSimple: StreamFunction") | OpenAI Responses 协议 |
| `M04.provider.faux` | `faux streamSimple` | [faux.ts:1057](../../../../../packages/ai/src/providers/faux.ts#L1057 "const streamSimple: StreamFunction") | 测试实现，适合学习事件流 |
| `M04.provider.anthropic.stream` | `anthropic stream` | [anthropic-messages.ts:955](../../../../../packages/ai/src/api/anthropic-messages.ts#L955 "export const stream: StreamFunction<\"anthropic-messages\"") | 真实请求入口 |
| `M04.provider.anthropic.params` | `buildParams` | [anthropic-messages.ts:1994](../../../../../packages/ai/src/api/anthropic-messages.ts#L1994 "function buildParams(") | 请求体组装、工具声明、思考参数 |
| `M04.provider.anthropic.messages` | `convertMessages` | [anthropic-messages.ts:2327](../../../../../packages/ai/src/api/anthropic-messages.ts#L2327 "function convertMessages(") | 统一消息转 Anthropic 消息 |
| `M04.provider.anthropic.sse` | `iterateAnthropicEvents` | [anthropic-messages.ts:883](../../../../../packages/ai/src/api/anthropic-messages.ts#L883 "async function* iterateAnthropicEvents(") | 自有 SSE 解码器 |
| `M04.provider.anthropic.client` | `createClient` | [anthropic-messages.ts:1732](../../../../../packages/ai/src/api/anthropic-messages.ts#L1732 "function createClient(") | SDK client 和认证请求形状 |
| `M04.provider.anthropic.stop` | `mapStopReason` | [anthropic-messages.ts:2909](../../../../../packages/ai/src/api/anthropic-messages.ts#L2909 "function mapStopReason(") | 供应商停止原因映射 |
| `M04.provider.openai.stream` | `openai stream` | [openai-responses.ts:279](../../../../../packages/ai/src/api/openai-responses.ts#L279 "export const stream: StreamFunction<\"openai-responses\"") | Responses 真实请求入口 |
| `M04.provider.transform` | `transformMessages` | [transform-messages.ts:155](../../../../../packages/ai/src/api/transform-messages.ts#L155 "export function transformMessages<TApi extends Api>(") | 跨模型历史转换 |

### 认证与虚拟路由

| 路由 | 符号 | 位置 | 作用 |
| --- | --- | --- | --- |
| `M04.auth.resolve` | `resolveProviderAuth` | [resolve.ts:47](../../../../../packages/ai/src/auth/resolve.ts#L47 "export function resolveProviderAuth(") | 认证优先级和 OAuth 刷新 |
| `M04.auth.storage` | `AuthStorage` | [auth-storage.ts:549](../../../../../packages/coding-agent/src/core/auth-storage.ts#L549 "export class AuthStorage implements CredentialStore") | `auth.json` 持久化和文件锁 |
| `M04.auth.runtime` | `RuntimeCredentials.read` | [runtime-credentials.ts:40](../../../../../packages/coding-agent/src/core/runtime-credentials.ts#L40 "async read(providerId: string") | 进程内临时 key 覆盖 |
| `M04.virtual.api` | `VIRTUAL_MODEL_API` | [virtual-models.ts:45](../../../../../packages/coding-agent/src/core/virtual-models.ts#L45 "export const VIRTUAL_MODEL_API") | `pi-virtual` 标记 |
| `M04.virtual.request` | `ModelRouteRequest` | [virtual-models.ts:76](../../../../../packages/coding-agent/src/core/virtual-models.ts#L76 "export interface ModelRouteRequest") | 路由输入 |
| `M04.virtual.state` | `getVirtualModelState` | [virtual-models.ts:235](../../../../../packages/coding-agent/src/core/virtual-models.ts#L235 "export function getVirtualModelState(") | 读分支上保存的路由状态 |
| `M04.virtual.latest` | `findLatestResponse` | [virtual-models.ts:158](../../../../../packages/coding-agent/src/core/virtual-models.ts#L158 "export function findLatestResponse(") | 最近一次成功回复 |
| `M04.session.projection` | `_installAgentRequestProjection` | [agent-session.ts:1270](../../../../../packages/coding-agent/src/core/agent-session.ts#L1270 "private _installAgentRequestProjection(): void") | 会话侧路由调用和状态条目持久化 |

<a id="m04-walk"></a>
## 函数拆解

<a id="m04-walk-simple"></a>
### `ModelRuntime.streamSimple`

**职责**：统一的聊天流入口。输入一个 `Model`、一个 `Context` 和可选 `options`，同步返回 `AssistantMessageEventStream`；如果模型是虚拟模型，先路由到物理模型。

**输入**：

- `model`：目录模型；`api` 可能是真实协议，也可能是 `pi-virtual`。
- `context`：可以带顶层 `systemPrompt`、`tools` 的 `Context`。
- `options`：`apiKey`、`signal`、`headers`、`env`、`maxTokens`、`reasoning`、`sessionId`、请求钩子等。

**输出**：事件流。成功以 `done` 结束，失败以 `error` 结束；`completeSimple` 只是在这个流上等 `result()`。

**涉及的主要子函数**：`normalizeContext`、`isVirtualModel`、`resolveModel`、`lazyStream`、`prepareRequest`、`provider.streamSimple`。

**内部步骤**：

1. `const transcript = normalizeContext(context)`。先规范化，虚拟路由也能看到完整 system 消息。
2. 如果 `isVirtualModel(model)`：
   - 用 `lazyStream` 包住异步路由。
   - 调用 `resolveModel(model, transcript.messages, { reason: "direct", thinkingLevel: options?.reasoning ?? "off", signal })`。
   - 按路由到的物理模型限制 `maxTokens`：只有调用方显式给了预算且物理模型上限大于 0 时才取较小值。
   - `route.thinkingLevel === "off"` 时把 `reasoning` 设为 `undefined`，否则用路由后的档位。
   - 跨供应商时丢掉原供应商的 `apiKey`、`headers`、`env`；同供应商才保留。
   - 递归调用 `this.streamSimple(route.model, context, ...)`，进入物理模型路径。
3. 物理模型分支：
   - `lazyStream(model, async () => { ... })`。
   - `assertChatModel(model)`，防止图片模型误入聊天入口。
   - `prepareRequest` 解析 provider 和认证。
   - `prepared.provider.streamSimple(prepared.model, transcript, prepared.options)`。

**错误与取消**：

- 未知 provider、缺少认证、路由失败、provider 构造失败，都会在异步 setup 中抛出，被 `lazyStream` 转成 `error` 事件。
- `signal` 会传给认证和 provider。Anthropic 在流结束后检查 `signal.aborted`，若已取消则把 `stopReason` 标为 `aborted`。
- 这一层不重试。重试分层见[关键设计第 7 节](#m04-design-retry)。

**一个跨供应商路由的例子**：

```ts
// 用户选择的是 provider "p" 下的虚拟模型
// router 返回 provider "q" 下的物理模型
const { apiKey, headers, env, ...rest } = options ?? {};
const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
return this.streamSimple(route.model, context, { ...rest, ...auth, maxTokens, reasoning });
```

如果保留 `p` 的 key 发给 `q`，就是把 A 公司的凭证发给 B 公司。代码用 provider 相等判断显式阻止这件事。

<a id="m04-walk-prepare"></a>
### `prepareRequest`

**职责**：在一次模型请求前，把“模型 + 请求选项”装配成“provider + 最终模型 + 最终选项”。它解决的是认证、端点、请求头和环境变量，不负责消息格式。

**输入**：`model`、`options`。`options` 可以包含 `apiKey`、`env`、`signal`、`headers`、`sessionId`、`transformHeaders`，以及具体协议自己的字段。

**输出**：

```ts
{
  provider,   // 已找到的 Provider
  model,      // 可能被认证 baseUrl 覆盖过的模型
  options,    // 去掉了 transformHeaders，apiKey/headers/env 已合并
}
```

**内部步骤**：

1. `this.models.getProvider(model.provider)`。未知 provider 抛 `ModelsError("provider", ...)`。
2. `getAuth(model, { apiKey, env, signal })`。没有认证结果抛 `ModelsError("auth", ...)`。
3. 从 `options` 中拆掉 `transformHeaders`，剩余字段交给 provider。
4. 如果 `resolution.auth.baseUrl` 存在，浅复制模型并覆盖 `baseUrl`。
5. 取出可选的 `sessionId`，合并请求头：
   - `getOpenCodeSessionHeaders(requestModel, sessionId)`；
   - 认证和模型配置头；
   - 本次请求显式 `headers`。
6. 如果有 `transformHeaders`，在合并后的头上执行，并等待结果。
7. 合并环境变量：`{ ...resolution.env, ...providerOptions.env }`，请求环境优先。
8. `apiKey` 取 `providerOptions.apiKey ?? resolution.auth.apiKey`。

**它不做什么**：

- 不合并同角色消息、不删空内容、不转换图片。`normalizeContext` 只折 system/tools，其余在 `transformMessages` 和供应商的 `convertMessages` 里。
- 不声明工具、不映射思考档位。Anthropic 的 `buildParams` 才做这些。
- 不发 HTTP、不重试、不解析 SSE。
- 不直接处理代理。代理通常通过 `env`（例如 `HTTPS_PROXY`）或自定义 `fetch` 传到 SDK；`prepareRequest` 只负责把 `env` 合并好。

**错误与取消**：认证解析可能刷新 OAuth、执行配置命令，`signal` 会传下去。这里抛出的错误最终由 `lazyStream` 变成 `error` 事件。

**请求头合并的具体例子**：

```text
OpenCode 会话头:   { "x-opencode-session": "s1" }
认证/模型配置头:   { "x-region": "us" }
本次请求头:        { "x-region": "eu", "x-trace": "t1" }
```

最终头是 `{ "x-opencode-session": "s1", "x-region": "eu", "x-trace": "t1" }`。`transformHeaders` 看到的是这个最终对象；它返回的内容不会再经过一次同样的变换，因为 `transformHeaders` 已从交给 provider 的选项里移除。

<a id="m04-walk-route"></a>
### `resolveModel` 与虚拟路由

**虚拟模型是什么**：目录里 `api === "pi-virtual"` 的条目。它不是任何供应商的模型，不能直接发请求；注册时提供一个 `route` 回调，由它决定这次用哪个物理模型。

**输入**：

- `model`：用户选中的虚拟模型。
- `messages`：本次请求的完整消息（包含 system）。
- `options`：
  - `reason`: `"user"`、`"continuation"`、`"retry"`、`"direct"`；
  - `thinkingLevel`：用户或上层选的档位；
  - `signal?`；
  - `failed?`：失败的那条 assistant 回复；
  - `state?`：上次保存的路由状态。

**输出**：`{ model, thinkingLevel, state }`。`model` 是通过校验的物理目录模型；`thinkingLevel` 已按目标模型能力收窄。

**内部步骤**：

1. 从 `virtualModels` 按 `provider/id` 找注册项。找不到直接报 “not registered”。
2. `findLatestResponse(messages)` 从后往前找最近一条 `stopReason` 不是 `error`/`aborted` 的 assistant 回复。只有它仍对应当前目录里的物理模型时，才作为 `previous` 传给 router。
3. `failed` 也一样：只有它指向物理模型时才作为 `failed` 传入。路由失败留下的消息可能仍带虚拟模型名，这种情况查不到物理模型，不会伪装成物理请求失败。
4. 调用 `virtual.route({ ...request, model, previous, failed, messages })`。选择策略在这里，不在 `resolveModel` 里。
5. 不信任 router 返回的整个模型对象，按 `provider/id` 重新调用 `getPhysicalModel`。目标不存在，或目标本身还是虚拟模型，直接报错，禁止虚拟链式跳转。
6. 要求目标 provider 在最近认证快照里已配置：`hasConfiguredAuth(target.provider)`。这只是一次快速检查，真正请求前还会走 `getAuth`。
7. 返回 `clampThinkingLevel(target, route.thinkingLevel)` 和 `route.state`。

**路由状态由谁保存**：

- `resolveModel` 本身不落盘。它只把 `route.state` 原样返回。
- Agent 循环内的虚拟路由由 `AgentSession._installAgentRequestProjection` 调用：
  - 从当前分支读 `getVirtualModelState(branch, provider, id)`；
  - 用 `reason: failed ? "retry" : userTurn ? "user" : "continuation"` 调 `resolveModel`；
  - 如果返回的 `state` 已定义、且与传入的不是同一个引用，追加一条 `pi.virtual-model-state` 自定义会话条目，并发出 `entry_appended` 事件；返回 `undefined` 表示沿用当前状态，不落条目。
- `ModelRuntime.streamSimple` 的直接虚拟路径用 `reason: "direct"`，不传 `state`，也不保存返回的 `state`。按 `ModelRoute` 的约定，`direct` 请求忽略状态。

**失败与重试选择**：

- “这次用哪个模型”由 router 决定；它可以根据 `reason === "retry"`、`failed` 的 `stopReason`/`errorMessage`、消息长度等选择另一个已配置的物理模型。
- `resolveModel` 只做校验：目标必须是物理模型，且其 provider 有认证配置。
- router 抛错会让本次请求失败；AgentSession 的注释说明，这会以错误回复结束本次运行，而不是自动换一个默认模型。

**一个具体 trace**：

```text
用户选择 p/smart（虚拟）
  -> AgentSession 读分支状态 state=v1
  -> resolveModel(..., { reason: "user", thinkingLevel: "medium", state: v1 })
  -> router 返回 q/fast, thinkingLevel: "low", state: v2
  -> getPhysicalModel("q", "fast") 通过
  -> hasConfiguredAuth("q") 通过
  -> 返回 { model: q/fast, thinkingLevel: "low", state: v2 }
  -> AgentSession 追加 pi.virtual-model-state { provider: "p", modelId: "smart", state: v2 }
  -> 本次请求使用 q/fast
```

下一次请求仍从 `p/smart` 开始，但会带上 `v2`，而不是把 `q/fast` 写死到 Agent 状态里。

<a id="m04-walk-normalize"></a>
### `normalizeContext`

**职责**：把调用方可能使用的顶层 `systemPrompt`、`tools` 折进首条 system 消息，产出只含 `messages` 的 `TranscriptContext`。

**实现**：

```ts
export function normalizeContext(context: Context): TranscriptContext {
  const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
  const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
  return { messages } as TranscriptContext;
}
```

`createInitialSystemMessage` 的规则：

- `systemPrompt` 是 `undefined` 或空字符串，且没有工具：返回 `undefined`，空对话保持空。
- 否则创建 `{ role: "system", content: systemPrompt ?? "", toolsAdded?: tools, timestamp: 0 }`。
- 只有工具没有提示词时，`content` 是空字符串，`toolsAdded` 仍然存在。
- `timestamp: 0` 表示这是合成消息，不是某次用户输入的时间。

**它不做什么**（这是最容易误解的地方）：

- 不合并连续的同角色消息。
- 不删除空白文本块或空 assistant 消息。
- 不转换图片，也不按模型输入能力降级图片。
- 不把连续 `toolResult` 合成一条消息。
- 不修复缺失的工具结果，不规范化工具调用 id。
- 不做摘要或压缩。

这些工作分在两层：

1. **跨模型历史转换**：`transformMessages` 会处理空内容、图片降级、跨模型思考块、工具调用 id 规范、缺失工具结果补齐。它比较 `provider`、`api`、`model` 三个字段来判断“是否同一个模型”。
2. **具体协议转换**：Anthropic 的 `convertMessages` 会把连续 `toolResult` 合并进同一条 user 消息，过滤空白文本，保留图片，跳过没有有效块的 assistant 消息，并把后续 system 消息暂存到下一个有效 assistant 之前或末尾。

**为什么这样分层**：

- `TranscriptContext` 带一个编译期品牌，只有 `normalizeContext` 能产出它。provider 代码只接收这个类型，因此不可能“忘记”顶层 `systemPrompt` 或 `tools`。
- 但“连续工具结果怎么排”“图片能不能发”“空文本块是否合法”是供应商协议细节，不是通用会话结构。把它们放进 `normalizeContext` 会让这个函数依赖每个供应商的规则。
- 一个具体差异：Anthropic 要求 `tool_result` 紧跟对应的 `tool_use`，所以中间的 system 更新必须延后；OpenAI Responses 对中途 system 消息的支持又不同。`normalizeContext` 不知道目标协议，不能替它们做决定。

**一个具体 trace**：

```text
输入:
{
  systemPrompt: "S",
  messages: [user1, user2],
  tools: [read],
}

normalizeContext 输出:
[
  system("S", toolsAdded: [read], timestamp: 0),
  user1,
  user2,
]
```

它不会把 `user1` 和 `user2` 合并。如果消息是 `assistant(toolCall) + toolResult1 + toolResult2`，`normalizeContext` 原样保留；Anthropic 的 `convertMessages` 才会把两个 `toolResult` 合成一条 user 消息里的两个 `tool_result` 块。

<a id="m04-walk-lazy"></a>
### `lazyStream`

**职责**：同步返回一个外层 `AssistantMessageEventStream`，同时立即执行异步 `setup`，把内部流的事件转发到外层流。

**为什么需要它**：

- `StreamFunction` 的契约是同步返回流。调用方（Agent）希望马上拿到可迭代对象，随后再消费。
- 认证、OAuth 刷新、动态导入 provider、建立 HTTP 请求都是异步的。如果 `streamSimple` 写成 `async`，调用方拿到的会是 `Promise<Stream>`，错误也会变成 Promise rejection，消费端要同时处理两种形态。
- `lazyStream` 把这些异步错误统一成 `error` 事件，让 Agent 只需要处理事件。

**名字里的 “lazy”**：它指“相对方法调用延迟加载/建立”，不是“等到 `for await` 才开始”。`setup()` 在 `lazyStream` 返回前就已经被调用，认证和请求会立刻开始。

**第一个事件之前发生什么**：

1. 记录 `startedAt`。
2. 创建外层流。
3. 调用 `setup()`。
4. `setup()` 成功返回内部异步流后，`forwardStream` 逐事件转发：
   - `target.push(event)`；
   - 调用观察器的 `onEvent`；
   - 记住最后一条 `done.message` 或 `error.error`。
5. 如果内部流还提供 `result()`，用它覆盖最终结果。
6. `target.end(result)`，结束外层流。

**错误怎么变成事件**：

```ts
setup()
  .then((inner) => forwardStream(...))
  .catch((error) => {
    const message = createSetupErrorMessage(model, error, startedAt);
    const event = { type: "error", reason: "error", error: message };
    outer.push(event);
    outer.end(message);
  });
```

`createSetupErrorMessage` 生成一条 `content: []`、零用量、`stopReason: "error"` 的 `AssistantMessage`，并写入 `errorMessage` 和开始时间。

**边界情况**：

- 如果 `setup` 在返回 Promise 之前同步抛出，`lazyStream` 自己不会捕获，因为 `setup()` 调用不在 `try` 里。实际调用方都传 `async () => ...`，同步抛出会变成 rejected Promise。
- 观察器抛错没有隔离，可能打断转发。
- 内部流已经输出部分内容后失败，外层已经收到的事件不会回滚；最终 `error.error` 里可能保留部分 `content` 和 `usage`。
- `result()` 对失败流也会解析成那条错误消息，而不是自动 reject。调用方要检查 `stopReason`。

<a id="m04-walk-anthropic"></a>
### 代表实现：Anthropic Messages

选择 Anthropic Messages 作为代表，是因为它把“请求组装、HTTP、SSE、统一事件、用量、错误”都放在一个文件里，且没有把解析工作藏进 SDK 的高层封装。

#### 入口和认证

- `streamSimple` 是统一简单选项到原生选项的适配层：
  - 没有联邦配置时，同步检查 `apiKey` 或显式授权头；不满足就抛错。
  - 没有 `reasoning` 时，向 `stream` 传 `thinkingEnabled: false`。这是“关闭意图”；是否真的关闭由 `buildParams` 结合模型能力决定。
  - `forceAdaptiveThinking === true` 时，把统一档位映射成 Anthropic effort，传 `thinkingEnabled: true` 和 `effort`。
  - 其他情况用 `adjustMaxTokensForThinking` 计算预算，用 `clampMaxTokensToContext` 估算上下文余量，预算上限取 `maxTokens - 1024`。
- `stream` 是真实入口：
  - 同步返回事件流，`resolveTranscript` 和 `getCurrentTools` 在 `try` 之外执行。
  - 异步闭包里创建可变的 `output: AssistantMessage`，初始 `content: []`、零用量、`stopReason: "pending"`。
  - 如果调用方注入 `options.client`，直接使用；否则根据 `apiKey`、显式头、联邦配置创建 SDK client。
  - `createClient` 区分 Copilot Bearer、`sk-ant-oat` 子串命中的 OAuth 形状、普通 key/头/联邦路径。

#### 请求体组装

`buildParams` 的顺序大致是：

1. 取缓存控制配置和模型兼容设置。
2. 取首条 system 消息，单独保存其文本和初始工具。
3. 调用 `transformMessages`，处理跨模型思考、图片降级、工具调用 id 和缺失结果。
4. 从转换后的消息中去掉首条 system，剩下的是对话消息。
5. 决定工具策略：原生工具变更模式保留初始工具加 deferred 占位；否则发送当前活动工具。
6. `convertMessages` 把统一消息转成 Anthropic 的 `MessageParam`。
7. 组装核心参数：

```ts
{
  model: model.id,
  messages: converted.messages,
  max_tokens: options?.maxTokens ?? model.maxTokens,
  stream: true,
  // betas 仅在非空时加入
}
```

8. 写 `system`：OAuth 形状先放固定的 Claude Code 身份段，再放用户初始 system；非 OAuth 只放用户初始 system。
9. 按条件写 `temperature`、`tools`、`thinking`、`output_config`、`metadata`、`tool_choice`、`fallbacks`。

工具声明在这里完成，不在 `prepareRequest`。思考档位到协议字段的映射也在这里：`disabled`、`adaptive`、`enabled + budget_tokens` 是三条不同路径。

#### 消息转换

`convertMessages` 的关键行为：

- 后续 system 消息先暂存，等下一个实际发出的非空 assistant 之前，或会话末尾，才释放。原因是 Anthropic 要求 `tool_result` 紧跟 `tool_use`，中间插 system 会被拒绝。
- 用户字符串如果全是空白，整条跳过；块数组里的空白文本块被过滤，图片保留。
- assistant 的文本块、思考块、工具调用块分别转换；整条没有有效块就跳过。
- 连续的 `toolResult` 合并到同一条 user 消息里，每个结果一个 `tool_result` 块。
- 错误工具结果里的图片会拆出来，放到所有工具结果之后，避免 Anthropic 拒绝“错误结果包含非文本内容”。
- 最后一个合格的 user/system 块可以带 `cache_control`。

#### HTTP 和 SSE

- SDK 请求设置 `maxRetries: 0`，重试由 `retryProviderRequest` 控制，避免两层重试叠加。
- `retryProviderRequest(() => client.beta.messages.create(params, requestOptions).asResponse(), { maxRetries, maxRetryDelayMs, signal })` 只包住“建立请求并拿到响应”这一段。
- 特殊的 strict 工具降级：只有 SDK 抛出 `Anthropic.APIError`、状态 400、类型 `invalid_request_error`、错误文字匹配已知 strict 工具限额模式，且本轮还没降级过，才关闭 prefer strict 并重建一次请求。其他 400 不降级。
- 拿到响应后先执行 `onResponse` 钩子，再推 `start`。
- SSE 由 `iterateAnthropicEvents` 自己解析，不使用 SDK 的事件流解析器：
  - 忽略未知事件名；
  - `error` 事件抛错；
  - JSON 解析带修复；
  - 一旦开始，要求出现 `message_start` 和 `message_stop`。

#### 事件映射和用量

| Anthropic 事件 | 统一处理 |
| --- | --- |
| `message_start` | 记录 `responseId`、`responseModel`，初始化 input/output/cacheRead/cacheWrite/cacheWrite1h，计算 totalTokens 和 cost |
| `content_block_start` (text) | 新增 `text` 块，发 `text_start` |
| `content_block_start` (thinking) | 新增 `thinking` 块，保留初始文字和签名，发 `thinking_start` |
| `content_block_start` (redacted_thinking) | 新增 `redacted: true` 的 thinking 块，发 `thinking_start` |
| `content_block_start` (tool_use) | 新增 `toolCall` 块，启动 `ToolCallArgumentsStream`，发 `toolcall_start` |
| `content_block_delta` (text_delta) | 追加文本，发 `text_delta` |
| `content_block_delta` (thinking_delta) | 追加思考文字，发 `thinking_delta` |
| `content_block_delta` (input_json_delta) | 追加 JSON 片段，更新参数预览，发 `toolcall_delta` |
| `content_block_delta` (signature_delta) | 只追加 `thinkingSignature`，不发独立统一事件 |
| `content_block_stop` (text) | 发 `text_end` |
| `content_block_stop` (thinking) | 发 `thinking_end` |
| `content_block_stop` (tool_use) | 完成 JSON 解析，可能写入 `argumentsError`，发 `toolcall_end` |
| `message_delta` | 记录 `rawStopReason`，`mapStopReason` 映射终态，覆盖 usage，重算 totalTokens 和 cost |
| `message_stop` | 循环结束，后面统一检查终态并发 `done` |

`mapStopReason` 的映射：

| Anthropic 原因 | 统一 `stopReason` |
| --- | --- |
| `end_turn` | `stop` |
| `max_tokens` | `length` |
| `tool_use` | `toolUse` |
| `pause_turn` | `stop` |
| `stop_sequence` | `stop` |
| `refusal` | `error`，`errorMessage` 取拒绝说明或固定文字 |
| `sensitive` | `error` |
| 其他未知值 | 抛出 `Unhandled stop reason: ...` |

#### 错误、取消和重试

- 流处理完后先检查 `signal.aborted`，再检查 `stopReason === "pending"`，最后检查 `aborted`/`error`。
- 正常才推 `done` 并 `end()`。
- `catch` 里把 `stopReason` 设为 `aborted`（如果信号已取消）或 `error`，写入 `errorMessage`，推 `error`，再 `end()`。
- 已经收到的部分内容、用量、已结束的块都会保留；不会为仍打开的块补 `end`。
- 不会在 SSE 中途重新发请求。`retryProviderRequest` 只重试建立 HTTP 请求；更高层的重试在 AgentSession。

#### 其他 provider 的差异

OpenAI Responses 的骨架相同：

- `stream` 同步返回流，异步闭包里 `resolveTranscript`、创建 client、`buildParams`、`onPayload`、`retryProviderRequest(...withResponse())`。
- 拿到响应后推 `start`，再由 `processResponsesStream` 推进 `output`。
- 结束后检查 `pending`，推 `done` 或 `error`。
- 差异主要在请求字段、SSE 事件名、工具语法、缓存保留策略、service tier 计价和停止原因映射。

`faux` provider 不发网络请求，但发出的统一事件形状相同，适合先读事件流，再看真实 provider 的解析代码。其他协议实现还有各自的签名和流格式，不在本文展开。

<a id="m04-walk-auth"></a>
### 认证：`getAuth`、`checkAuth`、`hasConfiguredAuth`

认证有三个容易混淆的层次。

#### `resolveProviderAuth` 的优先级

底层解析顺序是：

1. **本次请求显式 `apiKey`**：如果存在且 provider 有 API key 能力，直接走 API key 解析。它可以覆盖已存储的 OAuth。
2. **存储凭证**：通过 credential store 读取。编码代理的 store 是 `RuntimeCredentials`，它先看进程内临时覆盖，再读 `AuthStorage` 的 `auth.json`。
   - `oauth` 且有 OAuth handler：走 OAuth 路径，可能刷新。
   - `api_key` 且有 API key handler：走 API key 路径。
   - 存储类型没有对应 handler：返回 `undefined`，不会偷偷回退到环境变量。
3. **环境认证**：只有完全没有存储凭证时，才让 API key handler 去查环境变量、AWS profile、ADC 等来源。

这条规则避免“账号已经登录，却因为环境里有个 key 就悄悄换账号”。也避免 OAuth 刷新失败后静默使用另一个身份。

#### OAuth 刷新

- 默认在 token 剩余有效期不超过 5 分钟时触发刷新（恰好 5 分钟也算）；调用方可以传 `minOAuthValidityMs` 把窗口扩大到 5 分钟以上，实际窗口取两者较大值。
- 刷新在 credential store 的锁内进行；拿到锁后会重新检查是否仍需要刷新，避免并发调用重复刷新。
- 刷新和写回在锁释放前完成。刷新一旦开始，忽略调用方的取消信号，只用 15 秒超时兜底；否则调用方取消可能丢掉已经轮换的 refresh token。
- 调用方的 `signal` 只取消“等待锁”这一段。

#### `getAuth`、`checkAuth`、`hasConfiguredAuth` 的区别

| 方法 | 读 token | 刷新 OAuth | 可能 I/O | 典型用途 |
| --- | --- | --- | --- | --- |
| `getAuth` | 是 | 是 | 是 | 真正发请求前解析可用认证 |
| `checkAuth` | 读取存储凭证（不返回 key） | 否（OAuth 只检查有没有 handler） | 可能（读存储、`apiKey.check`/`resolve`） | 判断配置上是否可用 |
| `hasConfiguredAuth` | 否 | 否 | 否 | 同步查最近认证快照的成员关系 |

具体差异：

- `getAuth(providerId)` 直接委托底层 `Models.getAuth`。
- `getAuth(model)` 在底层解析后，再合并模型配置头；模型自己的 `X-Region` 等头可以覆盖认证头同名项。
- `checkAuth` 返回 `AuthCheck`，只有 `source` 和 `type`，没有可直接发送的 key。
- `hasConfiguredAuth` 只读 `snapshot.configuredProviders`。快照可能滞后；它适合恢复历史模型、路由前快速过滤，不适合当作“token 现在一定有效”的证明。
- `setRuntimeApiKey` 把 key 写进 `RuntimeCredentials`，只影响当前进程，不写 `auth.json`；`RuntimeCredentials.read` 先返回非空临时覆盖，否则回退到底层存储。

**一个具体例子**：

```text
auth.json 里 anthropic 是 OAuth，但 token 已过期
hasConfiguredAuth("anthropic") -> true       // 快照里存在
checkAuth("anthropic")       -> { source: "OAuth", type: "oauth" }  // 不刷新
getAuth("anthropic")         -> 刷新后返回可用 token；刷新失败则返回错误
```

如果用户用 `--api-key` 设置了运行期 key，`RuntimeCredentials.read` 会优先返回它，`getAuth` 就不会再用已存储的 OAuth。移除运行期覆盖后，才会回到 `auth.json`。

<a id="m04-map"></a>
## 统一事件到 `AssistantMessage` 的映射

所有 provider 都把供应商事件翻译成同一组事件。调用方通常只需要 `done`/`error` 的最终消息，但 UI 和流式输出会消费中间事件。

| 事件 | 携带字段 | 对 `AssistantMessage` 的影响 | 注意 |
| --- | --- | --- | --- |
| `start` | `partial` | 宣告一条回复开始；`partial` 是随后持续变化的实时累计对象 | 不是事件时刻的快照；provider 可能复用外层对象，也可能每次给浅拷贝；不同 provider 的初始块也可能不同 |
| `text_start` | `contentIndex`、`partial` | 在 `content[contentIndex]` 建立文本块 | 块可能带初始文本，Anthropic 就不强制从空串开始 |
| `text_delta` | `contentIndex`、`delta`、`partial` | 把 `delta` 追加到该文本块 | `partial` 已包含累计文本；`delta` 只是本次片段 |
| `text_end` | `contentIndex`、`content`、`partial` | 文本块结束，给出完整文本 | 只表示块结束，不是整条回复结束 |
| `thinking_start` | `contentIndex`、`partial` | 建立思考块 | 被遮蔽的思考可能一开始就完整，没有后续 delta |
| `thinking_delta` | `contentIndex`、`delta`、`partial` | 追加思考文本 | 签名增量通常不单独发统一事件 |
| `thinking_end` | `contentIndex`、`content`、`partial` | 思考块结束 | `content` 是累计思考文本 |
| `toolcall_start` | `contentIndex`、`partial` | 建立 `toolCall` 块 | 初始 `arguments` 可能是对象，也可能为空 |
| `toolcall_delta` | `contentIndex`、`delta`、`partial` | 追加参数 JSON 文本；provider 可同时更新容错预览 | 单个 `delta` 通常不能独立 `JSON.parse` |
| `toolcall_end` | `contentIndex`、`toolCall`、`partial` | 参数流结束，给出完整 `toolCall` | 可能带 `argumentsError`；这里仍不执行工具 |
| `done` | `reason`、`message` | 最终消息；`message` 是完整 `AssistantMessage` | `reason` 只能是 `stop`/`length`/`toolUse`/`deferred`；一条回复结束，不代表 Agent 任务结束 |
| `error` | `reason`、`error` | 失败/取消的完整 `AssistantMessage` | `reason` 是 `error`/`aborted`；可能有部分 `content` 和 `usage`；setup 失败时 `content` 为空 |

一个重要的消费约定：`partial` 是共享的实时累计对象，不是事件时刻的深快照。Anthropic 会把同一个 `AssistantMessage` 对象放进多个事件；faux provider 每次给外层浅拷贝，但共享 `content` 数组和块对象，后续增量仍可能改变已经收到的事件里的内容。要保存某个事件做回放或对比，必须自己深拷贝；不能假定 `start.partial` 永远保持开始时的内容。

`AssistantMessageEventStream.result()` 返回最终消息。成功时是 `done.message`，失败时是 `error.error`。它不会因为流里出现 `error` 而自动 reject；调用方必须看 `stopReason` 和 `errorMessage`。

<a id="m04-names"></a>
## 三个名字不要混

| 名字 | 例子 | 决定什么 |
| --- | --- | --- |
| provider | `anthropic` | 哪家公司/网关、用哪份凭证 |
| api | `anthropic-messages` | 哪种请求/响应协议 |
| model id | `claude-sonnet-...` | 具体模型和上下文窗口 |

一个 provider 可以实现多种 api；一个 api 也可以被多个 provider 复用。`ModelRuntime` 按 `model.provider` 找 provider，provider 再按自己的实现处理 `model.api`。

两个具体例子：

- `github-copilot` 可以作为 provider 使用 `anthropic-messages` 协议。Anthropic 适配器里专门有 Copilot 分支，把 key 当作 Bearer token，并合并 Copilot 自己的请求头。
- `openrouter` 也可以作为 provider 使用 `anthropic-messages` 协议。适配器里有 OpenRouter 的费用字段处理，说明协议实现并不绑定 Anthropic 官方端点。

所以看到 `api: "anthropic-messages"` 不能推断 `provider` 一定是 `anthropic`；看到 `provider: "openrouter"` 也不能推断它一定走 OpenAI 协议。model id 同理：`claude-sonnet-...` 在不同网关下可能对应不同部署、价格和上下文窗口。

<a id="m04-design"></a>
## 关键设计

### 1. 同步返回流，异步建立请求

`streamSimple` 不是 `async` 函数，它立即返回一个 `AssistantMessageEventStream`。真正的认证和网络设置放进 `lazyStream` 的异步 setup：

```ts
return lazyStream(model, async () => {
  const prepared = await this.prepareRequest(model, options);
  return prepared.provider.streamSimple(prepared.model, transcript, prepared.options as SimpleStreamOptions);
});
```

好处是调用方可以立刻拿到流，也可以先挂取消信号再消费；认证失败会变成 `error` 事件，而不是同步抛异常。Agent 的 `streamAssistantResponse` 因此只需要处理事件，不用同时处理 `try/catch` 和 `error` 事件两种错误形态。见 [M02 的流消费](../02-agent-loop/README.md#m02-walk-stream)。

### 2. 虚拟模型与路由

某些模型选择不是物理模型，而是“路由器”。`ModelRuntime.resolveModel` 负责调用 router、校验返回值、收窄思考级别；真正“选哪个物理模型”的策略在 router 回调里。

```text
用户选择 p/smart
  -> router 根据 reason/failed/messages/state 选择 q/fast
  -> resolveModel 校验 q/fast 是物理模型且 q 有认证
  -> 返回 { model: q/fast, thinkingLevel, state }
```

跨供应商路由时会丢掉原供应商的 `apiKey`、`headers`、`env`，让目标供应商重新解析自己的凭证。否则会把 A 公司的 key 发给 B 公司。路由状态由会话分支保存，`resolveModel` 本身不落盘。

### 3. 认证每次请求前解析

`prepareRequest` 在每次请求时调用，不是构造 `ModelRuntime` 时固定。原因：

- OAuth token 可能过期，需要刷新；
- `--api-key` 可能在运行中设置或移除；
- 路由器可能切到另一个 provider；
- 代理/环境变量可能变化；
- 模型配置头可能来自用户配置或扩展注册。

优先级是：显式请求选项 -> 运行期临时覆盖 -> `AuthStorage` 存储凭证 -> 环境变量（仅当没有存储凭证）。底层细节由 `resolveProviderAuth` 决定，`prepareRequest` 只消费 `AuthResult`。

### 4. 统一事件协议

所有 provider 都必须发出同一组事件：

| 事件 | 含义 |
| --- | --- |
| `start` | 开始生成，给出草稿 |
| `text_start` / `text_delta` / `text_end` | 文本块 |
| `thinking_start` / `thinking_delta` / `thinking_end` | 思考块 |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 工具调用块 |
| `done` | 正常结束，带完整消息和 stopReason |
| `error` | 错误/取消，带完整失败消息 |

`toolcall_delta` 只是 JSON 参数字符串的片段，不保证每个片段可独立解析。完整参数在 `toolcall_end` 或最终消息里。

`done.reason` 和 `error.reason` 是分开的联合：`done` 只允许 `stop`/`length`/`toolUse`/`deferred`，`error` 只允许 `error`/`aborted`。调用方不需要也不应该从 `errorMessage` 是否存在来猜成功失败。

### 5. headers/env 变换

`prepareRequest` 支持 `transformHeaders` 和 env 合并，用于代理、网关、企业请求头。变换器在运行时层消费掉，不会原样传给 provider 再执行一次。返回的 `options` 类型也去掉了 `transformHeaders`，防止重复应用。

头合并顺序是：会话头 -> 认证/模型配置头 -> 本次请求头 -> `transformHeaders`。后面的覆盖前面的，名称比较忽略大小写。`null` 头值有“抑制默认头”的语义，会继续传给下游处理。

代理没有独立字段。它通常体现为 `env` 里的代理变量，或调用方传入的自定义 `fetch`；具体是否生效由 provider/SDK 决定。

<a id="m04-design-layers"></a>
### 6. 上下文规范化与供应商适配分层

`normalizeContext` 只做一件与供应商无关的事：把顶层 system/tools 折进消息，产出带品牌的 `TranscriptContext`。所有供应商看到的输入形状因此一致。

供应商相关的清洗放在适配器：

- `transformMessages` 处理跨模型思考块、图片能力、工具调用 id、缺失工具结果。
- Anthropic `convertMessages` 处理连续工具结果、空白文本、空 assistant、错误工具结果图片、后续 system 延迟释放。
- OpenAI Responses 交给自己的 `buildParams` 和共享解析器。

这样 `normalizeContext` 不需要知道 Anthropic 的 `tool_result` 配对规则，也不会因为新增一个供应商而修改通用会话结构。

<a id="m04-design-retry"></a>
### 7. 重试分三层

| 层 | 做什么 | 不做什么 |
| --- | --- | --- |
| `ModelRuntime.streamSimple` | 解析认证、路由、调用 provider | 不重试 |
| provider（如 Anthropic/OpenAI） | `retryProviderRequest` 重试建立 HTTP 请求；SDK 自身 `maxRetries: 0` | 不重试已经开始的 SSE；不重试流中途错误 |
| `AgentSession` | 失败后决定是否继续、压缩、换模型或提示用户 | 不负责单次 HTTP 连接的退避 |

这三层不能混在一起说“重试发生在 Agent 循环”。一次请求内部的连接重试由 provider 完成；一次回答失败后的恢复由 AgentSession 完成。虚拟模型的 `reason: "retry"` 属于第三层，不是 HTTP 重试。

<a id="m04-design-state"></a>
### 8. 路由状态属于会话，不属于 `ModelRuntime`

`ModelRuntime.resolveModel` 是相对无状态的：它读取传入的 `state`，把 `route.state` 返回，但不写会话。状态由 `AgentSession._installAgentRequestProjection` 保存为 `pi.virtual-model-state` 自定义条目；这样状态随分支保存，撤销或切换分支时不会串到另一条历史。

直接调用 `streamSimple` 的虚拟路径用 `reason: "direct"`，按 `ModelRoute` 约定忽略状态。因此“循环外的摘要请求”不会改变下一次用户请求的路由状态。

<a id="m04-selfcheck"></a>
## 自测

**1. 从 `streamFn` 到 `AssistantMessage`，成功路径经过哪些函数？事件顺序是什么？**

物理模型路径是 `streamSimple` -> `lazyStream` -> `assertChatModel` -> `prepareRequest` -> `provider.streamSimple`。provider 内部再由 `buildParams` 组装请求、发 HTTP、解析 SSE，并把厂商事件翻译成统一事件。成功时通常先收到 `start`，然后每个内容块依次出现 `text_start`/`text_delta`/`text_end`（思考块和工具调用同理），最后是 `done`；`done.message` 就是完整 `AssistantMessage`。源码：`packages/coding-agent/src/core/model-runtime.ts:1333`、`packages/ai/src/api/lazy.ts:117`、`packages/ai/src/api/anthropic-messages.ts:955`。

**2. 认证或路由失败时，错误以什么形式到达调用方？`result()` 会 reject 吗？**

`prepareRequest` 在异步 setup 中抛出 `ModelsError`，`lazyStream` 的 `.catch` 把它变成 `error` 事件；`error.error` 是一条 `stopReason: "error"` 的 `AssistantMessage`，`errorMessage` 例如 `Provider is not configured: anthropic`。`result()` 从终止事件取出 `done.message` 或 `error.error`，所以失败时也是 resolve 一条错误消息，不会自动 reject。源码：`model-runtime.ts:1233`、`model-runtime.ts:1372`、`lazy.ts:117`、`packages/ai/src/utils/event-stream.ts:158`。

**3. `ModelRuntime.prepareRequest` 具体做什么？不做什么？**

它按 `model.provider` 找 `Provider`（找不到抛 `ModelsError("provider")`），调用 `getAuth` 解析认证（没有认证抛 `ModelsError("auth")`），用认证的 `baseUrl` 覆盖模型，按“OpenCode 会话头 -> 认证/模型配置头 -> 本次请求头 -> `transformHeaders`”合并头，合并 env（请求优先），最后按“请求显式 `apiKey` ?? 认证 key”确定 key。它不合并消息、不声明工具、不映射思考档位、不发 HTTP、不重试、不解析 SSE；这些分别在 `normalizeContext`/`transformMessages`、`buildParams` 和 provider 里完成。源码：`model-runtime.ts:1198`、`packages/ai/src/api/anthropic-messages.ts:1994`。

**4. 两个 `prepareRequest` 有什么区别？**

`AgentLoop.config.prepareRequest` 的类型是 `PrepareRequest`（`packages/agent/src/types.ts:240`），在每次 provider 请求前由 `agent-loop.ts:377` 调用，输入当前 `context`/`model`/`thinkingLevel`，可以返回替换后的字段。`AgentSession._installAgentRequestProjection`（`agent-session.ts:1270`）包装这个钩子，用会话树投影覆盖消息和工具，并处理虚拟路由。`ModelRuntime.prepareRequest` 是 `model-runtime.ts:1198` 的私有方法，在 `lazyStream` 的 setup 里调用，只返回 `provider`/`model`/`options`，不发起请求。前者决定“请求发什么历史和模型”，后者决定“用哪份凭证和端点发”。

**5. 虚拟模型如何路由？路由状态由谁保存？**

虚拟模型的 `api` 是 `pi-virtual`（`packages/coding-agent/src/core/virtual-models.ts:45`）。`resolveModel` 调用已注册的 `virtual.route`，再按 `provider`/`id` 从当前目录取物理模型；目标不存在、仍是虚拟模型或没有配置凭证都会被拒绝，最后返回 `{ model, thinkingLevel, state }`（`model-runtime.ts:1816`）。它本身不写会话。`AgentSession._installAgentRequestProjection` 在每次 loop 请求前读取 `getVirtualModelState`（`virtual-models.ts:235`），路由返回已定义的新 `state` 且与旧引用不同时，追加 `pi.virtual-model-state` 自定义条目；返回 `undefined` 或原引用表示沿用（`virtual-models.ts:112`、`agent-session.ts:1343`）。直接调用 `streamSimple` 的虚拟路径使用 `reason: "direct"`，不传也不保存状态（`model-runtime.ts:1345`）。

**6. `normalizeContext` 对连续同角色消息、连续 `toolResult`、图片和空内容分别做什么？**

都不处理。它只把顶层 `systemPrompt` 和 `tools` 折成首条 system 消息，其余消息原样保留（`packages/ai/src/utils/transcript.ts:46`）。跨模型清洗由 `transformMessages` 负责：空内容、图片能力降级、跨模型思考块、工具调用 id、缺失工具结果（`packages/ai/src/api/transform-messages.ts:155`）。协议清洗由 Anthropic `convertMessages` 负责：连续 `tool_result` 合并、空白文本、空 assistant、后续 system 延迟释放（`packages/ai/src/api/anthropic-messages.ts:2327`）。

**7. `getAuth`、`checkAuth`、`hasConfiguredAuth` 各能证明什么？**

`getAuth` 解析真正可用的认证，可能刷新 OAuth（`model-runtime.ts:1013`、`packages/ai/src/models.ts:1263`）。`checkAuth` 只返回 `AuthCheck` 的 `source`/`type`，不返回 key，也不刷新 OAuth（`model-runtime.ts:888`、`models.ts:1130`；`checkProviderAuth` 在 `models.ts:1082`）。`hasConfiguredAuth` 只查最近认证快照的成员关系，可能滞后（`model-runtime.ts:1002`）。OAuth 刷新发生在 `resolveProviderAuth`（`packages/ai/src/auth/resolve.ts:47`）。

**8. 为什么 `partial` 不能当快照保存？最终消息怎么取？**

`partial` 是共享的实时累计对象，不是事件时刻的深快照：provider 可能复用同一个 `AssistantMessage`，也可能每次给浅拷贝，但共享的内容数组和块仍会继续变化。保存引用看到的是最终状态，不是事件发生时的状态；要留档必须自己深拷贝（`packages/ai/src/utils/event-stream.ts:152`、`packages/ai/src/types.ts:1159`）。最终消息用 `result()` 取：成功是 `done.message`，失败是 `error.error`（`event-stream.ts:158`）。

<a id="m04-exercises"></a>
## 练习

下面四个练习都不需要真实 API key：faux provider 和注入的 fake client 在进程内构造响应。命令都从对应包的根目录运行；不要用 `npm test`。临时加的日志或断言在练习结束后恢复，不要提交。

**练习 1：用 faux provider 观察统一事件顺序。** 打开 `packages/ai/test/faux-provider.test.ts`，看 `streams an exact event order for fixed-size chunks`（当前第 404 行）。在 `for await` 里打印 `event.type`，同时打印 `event.partial.content.length` 和 `event.partial.stopReason`。预期：`start` 的 `stopReason` 是 `pending`，随后是 thinking、text、toolcall 三组 `start`/`delta`/`end`，最后 `done`；`partial` 不是深快照，观察后续事件是否继续修改已经收到的事件里的内容数组或块。把这条顺序画成时间线，标出 `toolCall` 第一次出现的步骤。命令：

```bash
cd packages/ai
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/faux-provider.test.ts
```

**练习 2：观察 Anthropic SSE 到统一事件的字段映射。** 打开 `packages/ai/test/anthropic-sse-parsing.test.ts`，看 `preserves content from content_block_start events`（当前第 481 行）。这个测试用 `createFakeAnthropicClient` 注入 `Response`，不发网络请求。把 `streamAnthropic(...).result()` 改成 `for await` 收集统一事件，打印每个事件的 `type` 和 `contentIndex`；同时在 `onProviderStreamEvent` 里打印厂商事件的 `type` 和 `index`。对照 `content_block_start` 的 `index` 与 `text_start`/`thinking_start` 的 `contentIndex`，确认初始文本、初始思考和 `signature_delta` 分别落到最终消息的哪个字段。命令：

```bash
cd packages/ai
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/anthropic-sse-parsing.test.ts
```

**练习 3：验证 headers 合并顺序和 `transformHeaders` 只执行一次。** 打开 `packages/coding-agent/test/model-runtime-auth-options.test.ts`，看 `transforms fully assembled headers once without forwarding the transform`（当前第 218 行）。在 `transformHeaders` 和 provider 的 `streamSimple` 里各加一行日志，打印收到的 headers，以及 `options` 是否还带 `transformHeaders`。预期：变换器只调用一次，看到的合并顺序是 `Authorization`、`x-provider`、`x-model`、`x-explicit`；provider 收到带 `x-transformed` 的最终头，且没有 `transformHeaders` 字段。命令：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/model-runtime-auth-options.test.ts
```

**练习 4：观察虚拟路由的原因、预算收窄和凭证隔离。** 打开 `packages/coding-agent/test/virtual-models.test.ts`，看 `routes direct streamSimple calls within the routed model's limits`（当前第 210 行）和 `does not forward caller credentials to a routed model of another provider`（当前第 233 行）。在 `route(request)` 里打印 `reason`、`thinkingLevel`、`previous`；在 faux provider 的响应工厂里打印收到的 `maxTokens`、`apiKey`、`headers`。预期：直接 `completeSimple` 的 `reason` 是 `direct`；`maxTokens` 从 20000 被压到物理模型的 5000；跨 provider 时调用方的 key 和 `x-caller` 不会出现。再运行同文件的 `createAgentSession with virtual models` 组，检查会话分支里的 `pi.virtual-model-state` 自定义条目：它只在 loop 的请求投影里写入，`direct` 路径不写。命令：

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/virtual-models.test.ts
```

<a id="m04-misread"></a>
## 常见误解

- **“model id 就是 provider”**：不是。`claude-sonnet-...` 是模型名，`anthropic` 是 provider，`anthropic-messages` 是协议。同一个模型名可以通过不同 provider/协议访问。
- **“`streamSimple` 是 `async`，会等请求建立”**：不是。它同步返回流；认证和请求在 `lazyStream` 的异步 setup 里进行，而 setup 在流对象创建时就已经启动。调用返回时通常还没有 `start` 事件。
- **“`streamSimple` 返回字符串或完整消息”**：不是。它返回 `AssistantMessageEventStream`；要完整消息用 `completeSimple` 或 `stream.result()`。
- **“虚拟模型是另一家供应商的模型”**：不是。虚拟模型的 `api` 是 `pi-virtual`，它只是路由入口；`resolveModel` 才会选出物理模型。
- **“重试都发生在 Agent 循环”**：不是。provider 只重试建立 HTTP 请求；`ModelRuntime` 不重试；AgentSession 负责回答失败后的恢复和压缩。
- **“`normalizeContext` 会合并连续同角色消息、清理空内容、转换图片”**：不会。它只折 system/tools。其余在 `transformMessages` 和供应商的 `convertMessages` 里。
- **“两个 `prepareRequest` 是同一个函数”**：不是。`AgentLoop.config.prepareRequest`（`packages/agent/src/types.ts:240`，由 `agent-loop.ts:377` 调用）是请求前钩子，返回可替换的 `context`/`model`/`thinkingLevel`，由 `agent-session.ts:1270` 包装成会话投影和虚拟路由；`ModelRuntime.prepareRequest`（`model-runtime.ts:1198`）是运行时私有方法，只解析 provider、认证、baseURL、headers、env。前者决定“发什么历史和模型”，后者决定“用哪份凭证和端点发”。
- **“API Key 在启动时固定”**：不是。每次请求前解析，支持 OAuth 刷新、运行期覆盖和 provider 切换。
- **“`toolcall_delta` 可以直接 `JSON.parse`”**：不能。它只是参数 JSON 的片段；完整参数在 `toolcall_end` 或最终消息里。
- **“`done` 表示 Agent 任务完成”**：不是。`done` 只表示一条模型回复结束。`reason: "toolUse"` 时 Agent 还要执行工具并继续请求。
- **“`error` 表示什么都没有产生”**：不是。流中途失败时，`error.error` 可能保留已经收到的文本、工具调用和用量。要看 `stopReason` 和 `content`，不能只看事件类型。
- **“`hasConfiguredAuth` 为 true 就代表 token 可用”**：不是。它只查最近认证快照的成员关系；token 是否过期、能否刷新，要 `getAuth` 才知道。

<a id="m04-next"></a>
## 继续阅读

- Agent 如何消费事件：[M02 Agent 循环](../02-agent-loop/README.md#m02-walk-stream)，以及[事件到历史](../02-agent-loop/README.md#m02-events)。
- 请求前上下文如何投影、压缩和保存：[M03 会话与上下文](../03-session-and-context/README.md#m03-store)。
- 凭证如何存储和选择：[M01 入口与装配](../01-entry-and-config/README.md#m01-routes)。
- 回到全链路：[S10 模型访问](../00-full-chain/README.md#m00-s10)、[S11 工具往返](../00-full-chain/README.md#m00-s11)。
- 供应商实现对照：[OpenAI Responses](../../../../../packages/ai/src/api/openai-responses.ts "openai-responses.ts")、[faux provider](../../../../../packages/ai/src/providers/faux.ts "faux.ts")。
