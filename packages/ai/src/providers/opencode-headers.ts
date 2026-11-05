// 给OpenCode聊天流补会话路由头，Zen/Go工厂都用它；只改转交下层的options，不在这里发送HTTP或校验服务端会话。
// ProviderHeaders允许string/null，null是上层抑制默认头的标记；type导入仅检查签名，实际HTTP实现后续才处理头。
import type { ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";

// OpenCode会话路由头的标准小写名字，与通用session_id等其它协议字段分开。
const OPENCODE_SESSION_HEADER = "x-opencode-session";

// 不分大小写判断headers是否已有某名字，输入可缺头字典与目标名，返回boolean；例X-OpenCode-Session:null也算已提供。
// 只遍历自有可枚举字符串键，不看值真假或验证HTTP合法性，不检查继承键；Object.keys/属性访问异常直接传播，无I/O。
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	// 把目标文字转小写一次，不trim空格或改原name。
	const expected = name.toLowerCase();
	// 缺字典用空对象，some逐键转小写比较，首个命中短路；即使对应值null/空串也true。
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

// 按sessionId补头，输入可缺通用流选项，返回原对象或浅复制；例{sessionId:"s"}得到headers含x-opencode-session:s。
// 无真值sessionId或已有同名头就原样返回；其余复制options/headers并添加一项，不改原对象，也不受cacheRetention影响。泛型保留额外选项类型，异常不在此捕获。
function withSessionHeader<TOptions extends StreamOptions>(options: TOptions | undefined): TOptions | undefined {
	// 可选链容忍undefined；空sessionId不注入、空白字符串仍是真值；||短路使没会话时无需再扫描headers。
	if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return options;
	// 只有需要补头才分配新选项外层对象。
	return {
		// 浅复制原options的自有可枚举字段，嵌套其它对象仍共享。
		...options,
		// 再浅复制原headers并以计算属性名加会话值；headers缺省也可展开，原字典不被写入。
		headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: options.sessionId },
	};
}

/** Adds OpenCode's required per-conversation routing header before API dispatch. */
// 包装ProviderStreams，接原实现并返回新能力对象，无即时请求；例包装后streamSimple(m,c,{sessionId:"s"})先补会话头再调原方法。
// 只替换stream/streamSimple，模型和上下文原样透传，返回原方法的流；其它自有可枚举能力浅复制但不额外补头。下层同步异常仍直接抛出，包装器不重试/吞错/消费事件。
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	// 创建新的实现外层对象，而不是修改传入streams。
	return {
		// 保留原对象可枚举能力及其它字段引用；继承或非枚举方法不会因展开自动复制。
		...streams,
		// 原始流箭头捕获streams，每次读取其当前stream方法，再求补头选项并以原streams为接收者调用；不是构造时bind固定方法值。
		stream: (model, context, options) => streams.stream(model, context, withSessionHeader(options)),
		// 简化流同样先补头并调用原streamSimple，保留通用reasoning等选项，不因cacheRetention:none取消会话路由。
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withSessionHeader(options)),
	};
}
