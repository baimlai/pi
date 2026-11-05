// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列中的虚拟模型示例。
// 作用：注册虚拟模型 jev/auto。首轮用 Jev 分类器判断任务复杂度，选择 GPT-5.6 Sol 或 Terra 规划；
//   规划模型完成第一次成功 edit/write 后，同一轮后续请求切到更便宜的 Luna，并保持到会话结束。
// 上游：`pi -e ./jev-router.ts --model jev/auto` 加载；用户在会话中选择 jev/auto 后，每次模型请求都会
//   调用 route() 选择真正的物理模型。需要 TYPESAFE_API_KEY 和 OpenAI Codex 登录。
// 下游：ctx.modelRegistry.find 查物理模型，findOfType/classify 调用分类器，request.messages 读取对话。
//   扩展不直接发 HTTP 请求；路由状态由宿主按会话分支持久化，失败时向调用方抛错。
// 能力：
//   PROVIDER/SOL/TERRA/LUNA   供应商与三个物理模型 ID 常量。
//   EDIT_TOOLS                表示“开始实现”的工具名集合。
//   JevState                  路由状态：阶段 + 该阶段模型 ID。
//   routeTo()                 按模型 ID 查目录并构造 ModelRoute。
//   lastUserText()            取最后一条用户消息的文字。
//   editedThisTurn()          判断最后一条用户消息之后是否有成功编辑。
//   choosePlanningModel()     选择规划模型（优先沿用，其次分类器，最后 Terra）。
//   默认导出函数               注册 jev/auto 虚拟模型及 route 回调。
// 典型顺序：首个请求 -> choosePlanningModel -> routeTo(planning)；同一轮后续请求 -> 沿用状态；
//   首次编辑成功后的下一请求 -> routeTo(Luna, implementation)；之后一直用 Luna。
// 示例：选择 jev/auto 后提出“重构认证模块”，分类器返回 complex 概率 >= 0.5 时首轮由 Sol 规划。
// 阅读顺序：先看常量和 JevState，再看 routeTo/lastUserText/editedThisTurn，最后看 route 的决策顺序。

/**
 * Jev router - a virtual model that plans on a strong model and implements on a cheap one.
 *
 * Registers `jev/auto`, which routes between three OpenAI Codex models:
 *
 * - Planning: GPT-5.6 Sol for complex work, GPT-5.6 Terra otherwise. The Jev classifier rates the
 *   first user message; planning stays on the chosen model.
 * - Implementation: GPT-5.6 Luna.
 *
 * The planning model explores, plans, and makes the first edit. After the first successful `edit`
 * or `write` tool call, the next request of the same turn goes to Luna, and the session stays
 * there. A session therefore switches models once and accepts a single prompt-cache miss.
 *
 * The phase is router state: Pi stores it on the session branch, so it follows the session tree
 * and survives compaction. The selected thinking level passes through as the reasoning effort of
 * the chosen model. Requests outside the agent loop, such as compaction summaries, go to Luna.
 *
 * Requires TypeSafe credentials (TYPESAFE_API_KEY) and an OpenAI Codex login.
 * Usage: pi -e ./jev-router.ts --model jev/auto
 */

// Message 是模型协议消息类型；路由只需要读取 role/content/toolName 等字段。
import type { Message } from "@earendil-works/pi-ai";
// ExtensionContext 提供 modelRegistry；ModelRoute/ModelRouteRequest 是 registerVirtualModel 的输入输出契约。
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

// 三者都是物理模型 ID，必须能在模型目录中找到；PROVIDER 是它们共同的提供商。
const PROVIDER = "openai-codex";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const LUNA = "gpt-5.6-luna";

/** Tools whose successful result means implementation has started. */
// Set 的 has 查询是 O(1)；这里只判断工具名，不检查工具参数或文件是否真的改变。
const EDIT_TOOLS = new Set(["edit", "write"]);

// 路由器状态。phase 是字符串字面量联合，只能取两个值；状态会随会话分支保存，
// 因此新分支从旧分支继承时也继承“正在规划/实现”的阶段。
interface JevState {
	phase: "planning" | "implementation";
	/** OpenAI Codex model for this phase. */
	model: string;
}

// 类型别名：为 ModelRouteRequest 绑定 JevState，后面函数签名更短，且 TS 会检查 state 的读写。
type JevRequest = ModelRouteRequest<JevState>;

// 把模型 ID 转成路由结果。输入：当前请求、扩展上下文、模型 ID、可选下一状态。
// 输出：{ model, thinkingLevel, state }。错误：目录中找不到模型时抛 Error，由宿主路由链处理。
// 副作用：只查目录，不发请求；thinkingLevel 原样透传，由运行时按物理模型能力钳制。
// 示例：routeTo(request, ctx, "gpt-5.6-luna") 返回 Luna 的路由。
function routeTo(request: JevRequest, ctx: ExtensionContext, id: string, state?: JevState): ModelRoute<JevState> {
	// find(provider, id) 同步查聊天模型；注册虚拟模型前应确保物理模型已在目录里。
	const model = ctx.modelRegistry.find(PROVIDER, id);
	// 找不到时没有可回退的模型，直接抛错；消息中带上供应商与 ID 便于诊断目录配置。
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	// 返回 ModelRoute；state 省略时为 undefined，宿主因此保留当前分支状态（direct 请求忽略状态）。
	return { model, thinkingLevel: request.thinkingLevel, state };
}

// 提取最后一条用户消息的纯文字。输入：只读消息数组；输出：文字（没有内容时为空串）。
// 副作用：无。流程：过滤 user -> at(-1) 取最后一条 -> 内容是字符串就直接用，否则拼接文本块。
// 示例：消息 content 为 [{type:"text",text:"hi"}] 时返回 "hi"；图片块被忽略。
function lastUserText(messages: readonly Message[]): string {
	// filter 产生新数组；.at(-1) 取倒数第一个元素（空数组返回 undefined）；?.content 与 ?? "" 处理缺失。
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	// typeof 收窄：content 的联合类型里包含字符串和内容块数组，这里先处理简单字符串。
	if (typeof content === "string") return content;
	// flatMap 把每个文本块映射成单元素数组、其他块映射成空数组，再展平；join 用换行连接。
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

// 判断最后一条用户消息之后是否发生过成功的 edit/write。输入：消息数组；输出：布尔值。
// 副作用：无。注意它看的是 toolResult 记录，不解析 edit 的 diff 内容。
// 示例：最后一条用户消息后出现 {role:"toolResult", toolName:"edit", isError:false} 返回 true。
/** Whether a tool call since the last user message edited a file successfully. */
function editedThisTurn(messages: readonly Message[]): boolean {
	// findLastIndex 从后往前找最后一条用户消息；-1 表示本轮还没有用户消息。
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	// slice(lastUser + 1) 只看该用户消息之后的消息；some 遇到第一个满足条件的工具结果即返回 true。
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

// 为新会话/首次请求选择规划模型。输入：路由请求与扩展上下文；输出：模型 ID 的 Promise。
// 副作用：可能调用一次分类器（网络请求，可能产生费用）；失败时 classify 不 reject，而是用 stopReason
//   表示错误，因此这里按 stopReason 判断。流程：沿用已有规划模型 -> 找分类器 -> 分类 -> 阈值选 Sol/Terra。
// 示例：会话原本用 gpt-5.6-sol 时直接返回 Sol，不产生分类调用；没有分类器时返回 Terra。
/** Planning model for a new session: Sol for complex work, Terra otherwise or when Jev is unavailable. */
async function choosePlanningModel(request: JevRequest, ctx: ExtensionContext): Promise<string> {
	// Keep a planning model the session already uses, so switching to jev/auto costs no cache miss.
	// previous 记录最近一次成功回复的物理模型；?. 防止首次请求没有 previous。
	const previous = request.previous?.model;
	// 只有提供商匹配且模型是 Sol/Terra 时才复用；Luna 不属于规划阶段。
	if (previous?.provider === PROVIDER && (previous.id === SOL || previous.id === TERRA)) return previous.id;

	// 分类器是模型目录里的非聊天模型；findOfType 的泛型让返回值自动是分类器类型。
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	// 未配置分类器时降级到 Terra，而不是让整个请求失败。
	if (!jev) return TERRA;
	// classify 的上下文是一个 JSON 对象：state 传待判断数据，questions 声明问题结构与判据。
	// slice(0, 16_000) 限制提示长度，避免超长输入；信号让分类请求可随本次路由一起取消。
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
			questions: {
				complexity: {
					type: "choice",
					instructions: "How demanding is the software engineering work requested in `prompt`?",
					criteria: {
						standard: "Ordinary features, fixes, reviews, or questions",
						complex: "Subtle design, cross-cutting changes, or hard debugging",
					},
				},
			},
		},
		{ signal: request.signal },
	);
	// 只有 stopReason === "stop" 才读答案；错误/中止时视为没有分类结果。
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	// 类型收窄：answer 是三种答案的联合，先确认 type 为 "choice" 再访问 probabilities。
	// ?? 0 处理分类器没给 complex 概率的情况；>= 0.5 才选较贵的 Sol。
	return answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5 ? SOL : TERRA;
}

// 扩展入口。输入：宿主 ExtensionAPI；输出：无；副作用是注册虚拟模型（不立即发请求）。
// 泛型 JevState 让 route 的 request.state 与返回的 state 使用同一类型。
// 示例：注册后用户在 /model 里能看到 "jev/auto"；只有真正请求时才执行 route。
export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<JevState>({
		// 虚拟模型挂在专用 provider "jev" 下，id "auto" 必须不与物理模型冲突。
		provider: "jev",
		id: "auto",
		name: "Auto (Jev)",
		// thinkingLevels 是用户可选择的档位，不是物理模型的全部能力；选中级别会原样传给 routeTo。
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Shared by all three models; shown before the first response.
		// 首次回复前只能展示虚拟模型自己的限制；回复后宿主改用实际物理模型的限制。
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			// direct 是 Agent 循环之外的请求（例如压缩摘要），不读取/保存会话路由状态，统一用 Luna。
			if (request.reason === "direct") return routeTo(request, ctx, LUNA);
			// state 是该会话分支上此前的路由状态；首次请求为 undefined。
			const state = request.state;
			if (!state) {
				// 首次请求：选规划模型，并把状态记为 planning，后续请求据此沿用。
				const model = await choosePlanningModel(request, ctx);
				return routeTo(request, ctx, model, { phase: "planning", model });
			}
			// The planning model made the first edit: hand the rest of the work to Luna.
			// 只有处于 planning 且本轮已有成功编辑时才切换；返回新状态后宿主会持久化到分支。
			if (state.phase === "planning" && editedThisTurn(request.messages)) {
				return routeTo(request, ctx, LUNA, { phase: "implementation", model: LUNA });
			}
			// 其他情况沿用状态里的模型；不传新 state，宿主保留当前状态。
			return routeTo(request, ctx, state.model);
		},
	});
}
