// 为旧兼容入口保留16个供应商流函数名字；导入时创建8份延迟包装对象，不在这里加载各实际SDK或请求模型。
// compat.ts重导出这些值；真正调用别名才经lazyApi加载实现并转发，as只恢复API/选项的TS关联，不校验运行模型。
// 与compat.stream不同，这些直接别名不自行注入环境密钥、选择Provider或把旧Context规范成TranscriptContext。
// 导入Anthropic Messages延迟工厂，运行值负责建立包装器；实际anthropic-messages实现稍后才动态导入。
import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
// AnthropicOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
// 导入Azure Responses延迟工厂，运行值负责建立包装器；实际azure-openai-responses实现稍后才动态导入。
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
// AzureOpenAIResponsesOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
// 导入Google Generative AI延迟工厂，运行值负责建立包装器；实际google-generative-ai实现稍后才动态导入。
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
// GoogleOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { GoogleOptions } from "./api/google-generative-ai.ts";
// 导入Google Vertex延迟工厂，运行值负责建立包装器；实际google-vertex实现稍后才动态导入。
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
// GoogleVertexOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
// 导入Mistral Conversations延迟工厂，运行值负责建立包装器；实际mistral-conversations实现稍后才动态导入。
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
// MistralOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { MistralOptions } from "./api/mistral-conversations.ts";
// 导入Codex Responses延迟工厂，运行值负责建立包装器；实际openai-codex-responses实现稍后才动态导入。
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
// OpenAICodexResponsesOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
// 导入OpenAI Completions延迟工厂，运行值负责建立包装器；实际openai-completions实现稍后才动态导入。
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
// OpenAICompletionsOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
// 导入OpenAI Responses延迟工厂，运行值负责建立包装器；实际openai-responses实现稍后才动态导入。
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
// OpenAIResponsesOptions只作为旧别名的原生选项类型；import type擦除，不为了取类型先加载实际SDK。
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
// 统一简化参数与泛型流函数只作类型：同步返回可异步迭代事件流，参数为规范化TranscriptContext，不是Promise函数。
import type { SimpleStreamOptions, StreamFunction } from "./types.ts";

// 模块求值就调用Anthropic Messages工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const anthropicMessagesStreams = anthropicMessagesApi();
// 模块求值就调用Azure Responses工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const azureOpenAIResponsesStreams = azureOpenAIResponsesApi();
// 模块求值就调用Google Generative AI工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const googleGenerativeAIStreams = googleGenerativeAIApi();
// 模块求值就调用Google Vertex工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const googleVertexStreams = googleVertexApi();
// 模块求值就调用Mistral Conversations工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const mistralConversationsStreams = mistralConversationsApi();
// 模块求值就调用Codex Responses工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const openAICodexResponsesStreams = openAICodexResponsesApi();
// 模块求值就调用OpenAI Completions工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const openAICompletionsStreams = openAICompletionsApi();
// 模块求值就调用OpenAI Responses工厂创建stream/streamSimple包装，工厂此时不运行load；本文件两别名稍后复用同一对象的方法。
const openAIResponsesStreams = openAIResponsesApi();

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/anthropic-messages` or `anthropicMessagesApi().stream`. */
// 旧Anthropic Messages原生入口直接取stream引用，输入模型/规范上下文/可选AnthropicOptions。例const s=streamAnthropic(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamAnthropic = anthropicMessagesStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议anthropic-messages；这是类型文字，不生成if检查model.api。
	"anthropic-messages",
	// 第二泛型用AnthropicOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	AnthropicOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/anthropic-messages` or `anthropicMessagesApi().streamSimple`. */
// 旧Anthropic Messages简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleAnthropic(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleAnthropic = anthropicMessagesStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议anthropic-messages；这是类型文字，不生成if检查model.api。
	"anthropic-messages",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/azure-openai-responses` or `azureOpenAIResponsesApi().stream`. */
// 旧Azure Responses原生入口直接取stream引用，输入模型/规范上下文/可选AzureOpenAIResponsesOptions。例const s=streamAzureOpenAIResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamAzureOpenAIResponses = azureOpenAIResponsesStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议azure-openai-responses；这是类型文字，不生成if检查model.api。
	"azure-openai-responses",
	// 第二泛型用AzureOpenAIResponsesOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	AzureOpenAIResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/azure-openai-responses` or `azureOpenAIResponsesApi().streamSimple`. */
// 旧Azure Responses简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleAzureOpenAIResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleAzureOpenAIResponses = azureOpenAIResponsesStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议azure-openai-responses；这是类型文字，不生成if检查model.api。
	"azure-openai-responses",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/google-generative-ai` or `googleGenerativeAIApi().stream`. */
// 旧Google Generative AI原生入口直接取stream引用，输入模型/规范上下文/可选GoogleOptions。例const s=streamGoogle(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamGoogle = googleGenerativeAIStreams.stream as StreamFunction<"google-generative-ai", GoogleOptions>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/google-generative-ai` or `googleGenerativeAIApi().streamSimple`. */
// 旧Google Generative AI简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleGoogle(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleGoogle = googleGenerativeAIStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议google-generative-ai；这是类型文字，不生成if检查model.api。
	"google-generative-ai",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/google-vertex` or `googleVertexApi().stream`. */
// 旧Google Vertex原生入口直接取stream引用，输入模型/规范上下文/可选GoogleVertexOptions。例const s=streamGoogleVertex(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamGoogleVertex = googleVertexStreams.stream as StreamFunction<"google-vertex", GoogleVertexOptions>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/google-vertex` or `googleVertexApi().streamSimple`. */
// 旧Google Vertex简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleGoogleVertex(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleGoogleVertex = googleVertexStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议google-vertex；这是类型文字，不生成if检查model.api。
	"google-vertex",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/mistral-conversations` or `mistralConversationsApi().stream`. */
// 旧Mistral Conversations原生入口直接取stream引用，输入模型/规范上下文/可选MistralOptions。例const s=streamMistral(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamMistral = mistralConversationsStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议mistral-conversations；这是类型文字，不生成if检查model.api。
	"mistral-conversations",
	// 第二泛型用MistralOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	MistralOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/mistral-conversations` or `mistralConversationsApi().streamSimple`. */
// 旧Mistral Conversations简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleMistral(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleMistral = mistralConversationsStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议mistral-conversations；这是类型文字，不生成if检查model.api。
	"mistral-conversations",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-codex-responses` or `openAICodexResponsesApi().stream`. */
// 旧Codex Responses原生入口直接取stream引用，输入模型/规范上下文/可选OpenAICodexResponsesOptions。例const s=streamOpenAICodexResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamOpenAICodexResponses = openAICodexResponsesStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议openai-codex-responses；这是类型文字，不生成if检查model.api。
	"openai-codex-responses",
	// 第二泛型用OpenAICodexResponsesOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	OpenAICodexResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-codex-responses` or `openAICodexResponsesApi().streamSimple`. */
// 旧Codex Responses简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleOpenAICodexResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleOpenAICodexResponses = openAICodexResponsesStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议openai-codex-responses；这是类型文字，不生成if检查model.api。
	"openai-codex-responses",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-completions` or `openAICompletionsApi().stream`. */
// 旧OpenAI Completions原生入口直接取stream引用，输入模型/规范上下文/可选OpenAICompletionsOptions。例const s=streamOpenAICompletions(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamOpenAICompletions = openAICompletionsStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议openai-completions；这是类型文字，不生成if检查model.api。
	"openai-completions",
	// 第二泛型用OpenAICompletionsOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	OpenAICompletionsOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-completions` or `openAICompletionsApi().streamSimple`. */
// 旧OpenAI Completions简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleOpenAICompletions(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleOpenAICompletions = openAICompletionsStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议openai-completions；这是类型文字，不生成if检查model.api。
	"openai-completions",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;

/** @deprecated Use `stream` from `@earendil-works/pi-ai/api/openai-responses` or `openAIResponsesApi().stream`. */
// 旧OpenAI Responses原生入口直接取stream引用，输入模型/规范上下文/可选OpenAIResponsesOptions。例const s=streamOpenAIResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamOpenAIResponses = openAIResponsesStreams.stream as StreamFunction<
	// StreamFunction第一泛型固定协议openai-responses；这是类型文字，不生成if检查model.api。
	"openai-responses",
	// 第二泛型用OpenAIResponsesOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	OpenAIResponsesOptions
>;
/** @deprecated Use `streamSimple` from `@earendil-works/pi-ai/api/openai-responses` or `openAIResponsesApi().streamSimple`. */
// 旧OpenAI Responses简化入口直接取streamSimple引用，输入模型/规范上下文/可选SimpleStreamOptions。例const s=streamSimpleOpenAIResponses(model,transcript,{maxTokens:64})才开始加载实现；同步返回流，await s.result()后仍需检查stopReason，失败可在流中。此赋值不调用、不改参数。
export const streamSimpleOpenAIResponses = openAIResponsesStreams.streamSimple as StreamFunction<
	// StreamFunction第一泛型固定协议openai-responses；这是类型文字，不生成if检查model.api。
	"openai-responses",
	// 第二泛型用SimpleStreamOptions约束可选请求参数；as不会转换这些参数或添加默认认证。
	SimpleStreamOptions
>;
