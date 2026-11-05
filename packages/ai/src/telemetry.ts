// 文件导读：packages/ai 的模型请求 telemetry 观察层。
//
// 所属模块：AI 可观测性适配，位于 Models 的 lazyStream 与 @earendil-works/pi-telemetry 之间。Models 在发起普通流
// （stream / streamSimple，poll=false）或延迟结果拉取（streamDeferred，poll=true）时调用 observeModelRequest，
// 把返回的 LazyStreamObserver 交给 lazyStream；lazyStream 在转发供应商事件和最终结果时同步调用观察器钩子。
//
// 职责边界：本文件不发起模型请求、不改写事件或消息、不保存正文/工具参数、不上传数据。它只把已有事件归一化成
// span 事件和低基数指标，并交给调用方传入的 telemetry 适配器；没有父 span 时使用 NOOP 上下文和空 metrics，
// 请求照常运行。span 名称固定为 pi.ai.request / pi.ai.poll；错误状态只对 stopReason="error" 设置，aborted 仍为 ok。
// 错误流向：适配器的 span/metrics 工厂或记录方法若抛错，本文件不捕获，异常沿 lazyStream 的现有转发路径传播；
// onResult 必须到达才会 resolve span 等待器，本文件没有超时或 finally 兜底。
//
// 能力清单（导出项）：
//   - AI_TELEMETRY_SCHEMA：公开的 telemetry schema，声明两个 span、首事件/内容块事件、耗时直方图、token/费用计数器
//     及其属性类型；defineTelemetrySchema 只返回原对象，不执行隐私政策或字段校验。
//   - observeModelRequest：为一个请求创建 LazyStreamObserver，捕获起始时间、取得/复用指标仪器、启动 span，并返回
//     onEvent（首事件与块事件）和 onResult（结果属性、耗时、token/cost、错误状态、释放等待器）。
//   - 内部辅助（不导出）：provider/model/stop/request 是共享 schema 片段；RequestSpan 是 span 的类型视图；
//     createInstruments 按适配器创建四个仪器；instrumentCache 是按适配器对象身份复用的 WeakMap。
//
// 组合与典型调用顺序：Models 调用 observeModelRequest(model, options, poll) → 立即取起始时间并启动 span（异步 run
// 同步拿到 span，等待完成 Promise）→ 返回观察器 → lazyStream 每转发一个事件调用 onEvent → 最终消息调用 onResult
// 写属性/指标并 finish() → span 结束。多个请求共用同一 metrics 适配器时复用 WeakMap 中的仪器句柄。
//
// 示例（真实签名）：
//   const observer = observeModelRequest(model, { telemetry: parentSpan, reasoning: "high" }, false);
//   // 调用方随后把 observer 交给 lazyStream；示例只创建观察器，不启动模型请求。
//   // 真实运行时 onEvent/onResult 由 lazyStream 调用；没有 parentSpan 时使用 NOOP 上下文。
//
// 建议阅读顺序：先看 AI_TELEMETRY_SCHEMA 里的 provider/model/stop/request 片段，理解字段含义与隐私边界；
// 再看 observeModelRequest 的签名和主体；随后看 createInstruments / instrumentCache；最后按 onEvent、onResult
// 的顺序理解事件与最终结果如何落到 span 和指标。
import {
	// typed指标助手关联名称和属性类型，运行时仍会调用适配器的仪器工厂。
	createTypedMetrics,
	// typed span启动器把父上下文与schema词汇绑定；同步进入callback依赖适配器契约。
	createTypedSpanStarter,
	// schema定义助手原样返回对象，保留TS字面量推断，不执行声明中的政策或验证。
	defineTelemetrySchema,
	// 未提供父span时使用共享空上下文：仍同步执行callback，但不保存追踪记录。
	NOOP_TELEMETRY_CONTEXT,
	// 缺少metrics能力时使用空仪器，允许只有追踪而没有指标的适配器。
	NOOP_TELEMETRY_METRICS,
	// SchemaTelemetrySpan用schema限制可记录的事件和字段，是类型视图而非另一个运行对象。
	type SchemaTelemetrySpan,
	// TelemetryMetrics描述counter/histogram等仪器工厂能力。
	type TelemetryMetrics,
	// TelemetrySpan同时提供记录方法和创建子span的上下文能力。
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
// 观察器的onEvent/onResult在lazyStream现有转发路径中同步调用，钩子异常不会被这个接口自动吞掉。
import type { LazyStreamObserver } from "./api/lazy.ts";
// Api/Model是类型；请求模型提供身份元数据，不在此选择真实供应商。
import type { Api, Model } from "./types.ts";
// 截取错误片段并促使V8只保留片段存储，避免500码元摘录长期牵住巨大原字符串。
import { ownedSlice } from "./utils/text.ts";

// 公共provider字段定义；as const保留string/true字面类型并给属性只读视图，不是Object.freeze或供应商ID校验。
const provider = { type: "string", description: "Provider identifier.", required: true } as const;
// 公共model字段定义，后面span和指标复用同一对象；model取请求ID而非服务端实际模型名。
const model = { type: "string", description: "Requested model identifier.", required: true } as const;
// 停止原因的共享声明，values会参与TS联合类型推导；不是运行时白名单检查。
const stop = {
	// 声明停止原因是字符串属性。
	type: "string",
	// 英文description是schema元数据，不是实际消息或执行条件。
	description: "Normalized stop reason.",
	// 列举七种归一化停止原因；pending/deferred仍可表示后台任务尚未完成。
	values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
} as const;
// 普通请求的公共schema，轮询稍后浅展开复用；只声明词汇，实际采集逻辑在observeModelRequest。
const request = {
	// 描述覆盖逻辑请求的认证/准备阶段，不仅是供应商生成文字的时间。
	description: "One logical model request, including authentication and provider setup.",
	// 声明允许任意父span；typed starter不会在运行时自动核验父级政策。
	parents: { kind: "any" },
	// 开始时记录的字段定义，与结果到达时追加的endAttributes分开。
	startAttributes: {
		// 属性简写复用上面的供应商定义。
		provider,
		// api为必需协议字符串，例如openai-responses；它和provider不是同一个概念。
		api: { type: "string", description: "API identifier.", required: true },
		// 复用请求模型ID定义。
		model,
		// 推理级别可省略；实际只记录string，原生对象形式不会序列化进此字段。
		reasoning: { type: "string", description: "Scalar requested reasoning level.", required: false },
	},
	// 完成结果的字段定义；这些点号键是普通字符串键，不会自动创建嵌套usage对象。
	endAttributes: {
		// 复用停止原因声明，此处未加required:true。
		stop,
		// 声明未缓存输入token，不在schema里现场估算。
		"usage.input": { type: "number", description: "Uncached input tokens." },
		// 声明输出token；若含reasoning子集，也不在这里再相加。
		"usage.output": { type: "number", description: "Output tokens." },
		// 声明缓存读取token，和普通输入独立。
		"usage.cache_read": { type: "number", description: "Cache-read tokens." },
		// 声明缓存写入token；这里不细分1h写入。
		"usage.cache_write": { type: "number", description: "Cache-write tokens." },
		// 记录message.usage.cost.total，不在此重新按目录价格计费。
		"cost.total": { type: "number", description: "Total request cost in USD." },
		// response.id允许高基数字符串，实际会保留该标识；正文不记录不代表所有元数据都已脱敏。
		"response.id": { type: "string", description: "Provider response identifier.", cardinality: "high" },
	},
	// span内部的瞬时事件定义，不是新模型请求。
	events: {
		// 首个归一化事件到达就计first_chunk；它可能是start或error，不必已经产生首个正文token。
		"pi.ai.first_chunk": { description: "First normalized stream event delivered.", attributes: {} },
		// 内容块完成时记录类型/索引/长度，避免把文字或参数正文写进span。
		"pi.ai.block": {
			// 声明不记录块内容；真实实现只读取所需长度及工具名，不序列化arguments。
			description: "A completed content block; content is never recorded.",
			// 每个block事件的属性定义。
			attributes: {
				// 事件里的type字段描述块种类，内层type又描述该字段的数据类型。
				type: {
					// 块种类属性是字符串。
					type: "string",
					// 对块种类的文字说明。
					description: "Block kind.",
					// 三种事件标签；工具事件写tool_call，和内容对象的toolCall拼法不同。
					values: ["text", "thinking", "tool_call"],
					// 必需属性的类型约束，不是自动运行检查。
					required: true,
				},
				// contentIndex是回复content数组索引，允许交错工具块分别计数。
				index: { type: "number", description: "Content block index.", required: true },
				// chars按JS字符串.length统计UTF-16码元，不是UTF-8字节或字素数。
				chars: { type: "number", description: "UTF-16 character count.", required: true },
				// tool字段只用于工具块名字，工具参数和调用ID不在这个事件里记录。
				tool: { type: "string", description: "Tool name, for tool-call blocks only.", required: false },
			},
		},
	},
	// 状态规则是说明元数据，后面的onResult才实际调用setStatus。
	status: {
		// 默认状态声明为ok；取消结果没有被本文件额外设成error。
		default: "ok",
		// 说明error时最多保留500码元错误文字，既不是敏感信息过滤器，也不是限制整个span大小。
		errorWhen: "Stop reason is error: provider_error with at most 500 error-message characters. Aborted stays ok.",
	},
} as const;

/** Pi-owned request metadata, bounded error status, events, and low-cardinality metrics. */
// 公开schema原引用，供外部组装追踪词汇；defineTelemetrySchema不会复制、冻结或自动实施隐私政策。
export const AI_TELEMETRY_SCHEMA = defineTelemetrySchema({
	// schema版本元数据，不在本文件执行升级迁移。
	version: 1,
	// span名到定义的映射。
	spans: {
		// 普通逻辑请求复用request定义。
		"pi.ai.request": request,
		// poll只浅改description，其他嵌套定义共享；一次poll的持续时间不是整个后台任务寿命。
		"pi.ai.poll": { ...request, description: "One deferred-response poll, not the deferred request's lifetime." },
	},
	// 低维指标词汇；本代码固定使用provider/model/stop/kind标签，不附正文或response.id。
	metrics: {
		// 记录每次逻辑请求或一次poll的耗时分布。
		"pi.ai.request.duration": {
			// histogram是分布仪器类型，不是在此求平均值。
			kind: "histogram",
			// 指标描述文字，真实时长由performance.now差值给出。
			description: "Logical request or poll duration.",
			// 耗时单位为毫秒。
			unit: "ms",
			// stop通过浅展开新增必需约束；provider/model沿共享定义，不含api标签。
			attributes: { provider, model, stop: { ...stop, required: true } },
		},
		// 首个归一化事件延迟的独立分布。
		"pi.ai.first_chunk.duration": {
			// 使用histogram记录每次观测值。
			kind: "histogram",
			// 首事件延迟说明，不承诺等同首正文token延迟。
			description: "Time to the first normalized stream event.",
			// 同样用毫秒。
			unit: "ms",
			// 只有供应商和模型标签，span上下文另作为record参数传递。
			attributes: { provider, model },
		},
		// 用counter累加结果已报告的四类token。
		"pi.ai.tokens": {
			// counter.add累计传入数值，不在这里对数值有效性或账单唯一性作检查。
			kind: "counter",
			// 只排除尚未完成的poll；普通请求若报告pending/deferred仍会进入计数，实际门禁见onResult。
			description: "Reported model token usage; pending and deferred polls are excluded.",
			// 单位是token，不是本文件blocks统计的码元。
			unit: "token",
			// token指标的维度定义。
			attributes: {
				// 供应商维度。
				provider,
				// 请求模型维度。
				model,
				// kind让一个counter区分四种用量。
				kind: {
					// kind字段的数据类型是字符串。
					type: "string",
					// kind的说明文字。
					description: "Token usage category.",
					// 四种标签分别对应input/output/cacheRead/cacheWrite字段。
					values: ["input", "output", "cache_read", "cache_write"],
					// TS要求测量时提供kind，运行时仍靠调用方按契约传参。
					required: true,
				},
			},
		},
		// 费用总额counter，与四项token counter分开。
		"pi.ai.cost": {
			// 把每次允许计入的cost.total累加。
			kind: "counter",
			// 排除pending/deferred poll的说明；重复获取同一终态结果没有跨poll去重。
			description: "Reported model cost; pending and deferred polls are excluded.",
			// 费用单位美元，不在此换算汇率。
			unit: "USD",
			// 费用只按供应商和请求模型分组。
			attributes: { provider, model },
		},
	},
});

// typeof取schema类型、字符串选择请求定义，SchemaTelemetrySpan据此限制属性/事件；poll定义结构相同所以共用此类型视图。
type RequestSpan = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, "pi.ai.request">;

// 为一个metrics适配器创建两分布、两counter句柄并返回；例输入内存适配器后可record请求耗时。
// 流程绑定schema再逐个取仪器；工厂可有适配器副作用或同步抛错，不在本函数发送模型请求。
function createInstruments(adapter: TelemetryMetrics) {
	// 读取schema指标定义并绑定实际adapter；名称和属性的精确约束来自TS。
	const metrics = createTypedMetrics(adapter, [AI_TELEMETRY_SCHEMA]);
	// 返回本组仪器对象，调用方会按adapter对象身份缓存它。
	return {
		// 取得请求/轮询耗时histogram句柄。
		requestDuration: metrics.histogram("pi.ai.request.duration"),
		// 取得首事件延迟histogram句柄。
		firstChunkDuration: metrics.histogram("pi.ai.first_chunk.duration"),
		// 取得四种token共用的counter句柄。
		tokens: metrics.counter("pi.ai.tokens"),
		// 取得费用总额counter句柄。
		cost: metrics.counter("pi.ai.cost"),
	};
}

// WeakMap按metrics对象身份缓存仪器，避免每请求重复创建；ReturnType推导返回形状，弱键不单独阻止该适配器被回收，不缓存请求span/正文。
const instrumentCache = new WeakMap<TelemetryMetrics, ReturnType<typeof createInstruments>>();

// 建立一次请求的只读观察器，输入请求模型、可省父span/未知推理参数、poll标志，返回onEvent/onResult；Models普通流或轮询在setup前调用。
// 例start事件先记first_chunk，text_end记录长度，最终stop结果追加用量再释放span等待器；poll=true且pending时只记耗时/结果属性，不加token和费用。
// 依赖TelemetryContext同步进入run一次；适配器工厂/记录方法可抛错，void启动不自动处理拒绝。最终结果回调必须到达才能释放等待；本函数不注册超时或finally兜底，调用方lazyStream负责正常路径最多通知一次。
export function observeModelRequest(
	// 身份取原请求模型，实际认证覆盖的模型端点/服务端responseModel不改变这里的标签。
	requestedModel: Model<Api>,
	// 整个options可undefined；reasoning是unknown，因此typeof是这个允许原生任意参数边界的筛选，而非重复校验已知string。
	options: { telemetry?: TelemetrySpan; reasoning?: unknown } | undefined,
	// true表示一次延迟结果poll；false表示普通逻辑请求，决定span名称及用量门禁。
	poll: boolean,
): LazyStreamObserver {
	// 先捕获单调时钟，包含仪器准备、认证和供应商setup至结果通知的时间，不是墙上Unix时间。
	const started = performance.now();
	// 只取供应商和请求ID，供多个指标复用同一标签对象。
	const attributes = { provider: requestedModel.provider, model: requestedModel.id };
	// 父span没有metrics时回空适配器；??只处理null/undefined，不加载全局追踪后端。
	const adapter = options?.telemetry?.metrics ?? NOOP_TELEMETRY_METRICS;
	// 按实际adapter引用查仪器，两个span共享同一metrics对象可复用。
	let instruments = instrumentCache.get(adapter);
	// 首次使用该对象才创建句柄，缓存不按请求model细分。
	if (!instruments) {
		// 调用上面的四仪器工厂，若失败本函数此刻同步抛出。
		instruments = createInstruments(adapter);
		// 只有创建成功后才放入弱缓存，失败不会缓存半套结果。
		instrumentCache.set(adapter, instruments);
	}
	// 对象解构取四个已创建/复用的仪器引用。
	const { requestDuration, firstChunkDuration, tokens, cost } = instruments;
	// !是确定赋值断言，不会初始化span；它靠下面start同步调用run来赋值。
	let span!: RequestSpan;
	// 保存完成Promise的resolve函数；!本身无运行检查。
	let finish!: () => void;
	// 每次请求只有首个事件触发延迟记录，不依赖事件是否为正文。
	let first = true;
	// Map用contentIndex分别累计工具delta码元数，交错工具不会合并成一条。
	const toolChars = new Map<number, number>();
	// 建立尚未完成的Promise；executor同步运行，void表示只等待结束信号不传业务结果。
	const finished = new Promise<void>((resolve) => {
		// 同步保存resolve，稍后onResult可释放等待器。
		finish = resolve;
	});
	// span业务回调接活动句柄，返回等待Promise；它不执行模型，只让span寿命跟随最终通知。
	const run = (activeSpan: RequestSpan): Promise<void> => {
		// 赋给外层闭包，onEvent/onResult随后使用同一span。
		span = activeSpan;
		// Promise未完成前adapter按契约保持span活动。
		return finished;
	};
	// 构造开始属性，不把整个options或请求上下文交给telemetry。
	const startAttributes = {
		// 展开provider/model两个标签。
		...attributes,
		// 另加请求协议api。
		api: requestedModel.api,
		// 只有string推理选项才展开该键；对象形式被省略，字符串内容本身不裁剪或去敏。
		...(typeof options?.reasoning === "string" ? { reasoning: options.reasoning } : {}),
	};
	// 把显式父span或空上下文绑定为typed starter；schema在这个helper里只参与推断，不执行声明验证。
	const start = createTypedSpanStarter(options?.telemetry ?? NOOP_TELEMETRY_CONTEXT, [AI_TELEMETRY_SCHEMA]);
	// poll启动pi.ai.poll，void丢弃返回Promise而非取消操作；同步run完成赋span，等待器稍后控制结束。
	if (poll) void start("pi.ai.poll", startAttributes, run);
	// 普通分支启动pi.ai.request；没有在此await，否则会等到观察器尚未返回时所需的onResult，形成无法推进的等待。
	else void start("pi.ai.request", startAttributes, run);

	// 交回两个同步钩子，不复制、消费或改写模型事件。
	return {
		// 接收lazyStream已推入外层的同一事件，返回void；先处理首事件，再按块标签记录长度/工具名，不修改消息。
		// 例text_end的content="你好"只记录chars=2；toolcall_delta按索引累加，待toolcall_end写事件并清掉计数。记录异常沿原转发路径传播。
		onEvent(event) {
			// 只对第一条事件执行首事件记录。
			if (first) {
				// 先清标志，即使记录方法抛错也不会在后续事件重试first_chunk。
				first = false;
				// 追加空属性首事件，不记录它的partial内容。
				span.addEvent("pi.ai.first_chunk");
				// 记录单调差值并用span关联测量；不是调用Date.now估计。
				firstChunkDuration.record(performance.now() - started, attributes, span);
			}
			// 工具参数增量分支先累计，不读取toolCall.arguments。
			if (event.type === "toolcall_delta") {
				// 索引旧值缺省0再加delta.length；按UTF-16码元累计原JSON增量，和最终序列化参数长度可能不同。
				toolChars.set(event.contentIndex, (toolChars.get(event.contentIndex) ?? 0) + event.delta.length);
				// 文字和思考只在结束事件统计最终content长度，避免把每次delta重复计入。
			} else if (event.type === "text_end" || event.type === "thinking_end") {
				// 追加一个块完成事件。
				span.addEvent("pi.ai.block", {
					// 按结束事件标签选择text或thinking。
					type: event.type === "text_end" ? "text" : "thinking",
					// 保留该块在content中的位置。
					index: event.contentIndex,
					// 读取完整结束文字的.length，不保存这份文字本身。
					chars: event.content.length,
				});
				// 工具块结束时取此前累计的增量长度，而不是重新JSON.stringify参数。
			} else if (event.type === "toolcall_end") {
				// 未见对应delta时长度为0，不能据此断言最终参数为空。
				const chars = toolChars.get(event.contentIndex) ?? 0;
				// 删除该索引累计，避免结束后一直保留数字状态。
				toolChars.delete(event.contentIndex);
				// 追加工具块元数据。
				span.addEvent("pi.ai.block", {
					// 事件种类采用schema的tool_call标签。
					type: "tool_call",
					// 记录工具块索引。
					index: event.contentIndex,
					// chars简写引用上面累计值。
					chars,
					// 只读工具名，不取arguments或调用ID；工具名仍会进入追踪记录。
					tool: event.toolCall.name,
				});
			}
		},
		// 结果回调接最终消息或undefined；有消息才补属性/指标，随后resolve结束span。它不更改原消息，也不校验供应商报告的数字。
		// 例错误消息只把错误文字前500码元放status；如果适配器在记录过程中抛错，finish不会被finally保证执行。
		onResult(message) {
			// 无结果仍会走后面的finish，但不虚构stop或用量。
			if (message) {
				// 把结果字段合并到活动span属性，不是新建另一span。
				span.setAttributes({
					// 停止原因按原消息记录，不能只凭Promise成功认为回答成功。
					stop: message.stopReason,
					// 复制未缓存输入数值。
					"usage.input": message.usage.input,
					// 复制输出数值，包含其中原报告的reasoning子集。
					"usage.output": message.usage.output,
					// 复制缓存读取数值。
					"usage.cache_read": message.usage.cacheRead,
					// 复制缓存写入数值，不另加cacheWrite1h子集。
					"usage.cache_write": message.usage.cacheWrite,
					// 使用报告的总费用，不重算分项或判断它是否来自真实账单。
					"cost.total": message.usage.cost.total,
					// 可选responseId原样交适配器；undefined按适配器契约忽略。
					"response.id": message.responseId,
				});
				// 只有error显式设错误状态；aborted/pending等不在本层改为error。
				if (message.stopReason === "error") {
					// 设置有界provider_error状态而非把错误信息混入普通属性。
					span.setStatus({
						// 错误状态标签。
						status: "error",
						// 缺错误文字回空串，再截取0到500个UTF-16码元并拥有片段；可能切开代理对，无敏感内容过滤。
						error: { name: "provider_error", message: ownedSlice(message.errorMessage ?? "", 0, 500) },
					});
				}
				// 所有有结果的请求/poll都记耗时，标签增加stop，并关联当前span。
				requestDuration.record(performance.now() - started, { ...attributes, stop: message.stopReason }, span);
				// 普通请求总能计用量；poll仅当stop既非pending也非deferred才计，error/aborted终态也可计，无跨轮询去重。
				if (!poll || (message.stopReason !== "pending" && message.stopReason !== "deferred")) {
					// 累加input并带kind=input，不传span作为额外指标上下文。
					tokens.add(message.usage.input, { ...attributes, kind: "input" });
					// 独立累加output。
					tokens.add(message.usage.output, { ...attributes, kind: "output" });
					// 独立累加cacheRead。
					tokens.add(message.usage.cacheRead, { ...attributes, kind: "cache_read" });
					// 独立累加cacheWrite。
					tokens.add(message.usage.cacheWrite, { ...attributes, kind: "cache_write" });
					// 累加原cost.total，仅用provider/model标签。
					cost.add(message.usage.cost.total, attributes);
				}
			}
			// 即使message缺省也释放finished；Promise resolve多次无效，但上方指标没有本地重复调用门禁，正常一次性通知依赖lazyStream。
			finish();
		},
	};
}
