import type { Context } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type Models,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	type EntryRecord,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type ReportInfo,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "../src/env/index.ts";
import { context } from "./session-support.ts";

/** Models and registry that survive a close/reopen, like a host process's own objects. */
// 供聊天测试复用的宿主对象。readonly 只限制属性重新赋值，不冻结数组或 registry。
// settings 的映射类型用 -readonly 去掉每个设置的只读修饰；identity? 表示可省略。
export type ChatSetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
	readonly reports: unknown[];
	/** What each report was about, in the order of `reports`. */
	readonly infos: ReportInfo[];
	/** Live Harness settings; tests assign fields to change them between decisions. */
	readonly settings: { -readonly [K in keyof HarnessSettings]: HarnessSettings[K] };
	now: () => number;
	/** `HarnessOptions.identity`. */
	identity?: HarnessOptions["identity"];
};

// 创建纯本地假模型与空注册表，输入是 faux 的响应速率/模型等选项，返回可跨重开复用的配置。
// 例如 setup.faux.setResponses([...]) 预设回答；此函数不打开存储、不发送模型请求，注册失败直接抛出。
export function chatSetup(options: RegisterFauxProviderOptions = {}): ChatSetup {
	// 建立脚本化响应供应商；它用内存队列模拟模型。
	const faux = fauxProvider(options);
	// 建立模型路由对象，尚未配置真实供应商。
	const models = createModels();
	// 把假供应商装入路由，供 faux/faux-1 请求使用。
	models.setProvider(faux.provider);
	// 返回新数组、可变设置和默认实时时钟；now 是函数，调用时才读取时间。
	return { faux, models, registry: createRegistry(), reports: [], infos: [], settings: {}, now: () => Date.now() };
}

/** Open a Harness over `storage` and return its root, configured with the faux model on first creation. */
// 在传入存储上异步打开 Harness 并取得根对话，返回二者；底层打开/建根失败使 Promise 拒绝。
// setup 的模型、注册表、设置和报告数组被共享，关闭后可在同一存储上重开。
// 例如 openChat(new MemoryStorage(), chatSetup()) 新建 faux 根对话；已有根不会因此重写 agent。
export async function openChat(
	storage: Storage,
	setup: ChatSetup,
	/** One environment for every conversation, or an `env` function. */
	options: { readonly env?: ExecutionEnv | NonNullable<HarnessOptions["env"]> } = {},
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
	// 等待运行器打开；以下对象把测试提供的依赖传进去，而不是创建真实模型连接。
	const harness = await Harness.open(
		storage,
		{
			// 复用已装入 faux 的路由。
			models: setup.models,
			// 使用宿主注册表，测试随后可安装/卸载扩展。
			registry: setup.registry,
			// 保留设置引用，后续决策可读到测试修改的字段。
			settings: setup.settings,
			// 对象展开 ... 有条件加入 identity；未提供时不覆盖 Harness 默认值。
			...(setup.identity === undefined ? {} : { identity: setup.identity }),
			// 环境既可为工厂也可为实例；实例包装成返回同一实例的工厂。
			// as ExecutionEnv 是编译期断言，不校验运行时对象。
			...(options.env === undefined
				? {}
				: { env: typeof options.env === "function" ? options.env : () => options.env as ExecutionEnv }),
			// 每次通过 setup.now 间接取时，因此替换该函数也能生效。
			now: () => setup.now(),
			// 对象解构分离 error，剩余字段作为对应的报告元信息收集。
			onReport: ({ error, ...info }) => {
				// 追加原始错误，可能是任意 unknown 值。
				setup.reports.push(error);
				// 同一位置追加来源等字段；两个数组按下标对应。
				setup.infos.push(info);
			},
		},
		// 传入共享的不可取消背景上下文。
		context,
	);
	// 取得根对话；只在首次创建时用这里的 faux 模型配置。
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	// 返回句柄供测试提交输入；调用方负责关闭 harness。
	return { harness, root };
}

/** Raw entries of a conversation, oldest first. */
// 读取一次最多 1000 条记录并改成从旧到新顺序，输入对话和可选上下文，返回新数组。
// 例如两条倒序记录 [新,旧] 变成 [旧,新]；超过 1000 条不会继续翻页，读取失败向上传播。
export async function allEntries(conversation: Conversation, callContext: Context = context): Promise<EntryRecord[]> {
	// 空过滤器、1000 页大小、无游标：获取最新一页。
	const page = await conversation.entries({}, 1000, undefined, callContext);
	// 展开复制数组后原地反转副本，不修改分页返回的 items。
	return [...page.items].reverse();
}

/** Text of the first text content of a message. */
// 从消息取第一块文本；未传消息、系统消息或没有文本块时返回 undefined。
// 输入是联合类型 Message | undefined；例如 user 的字符串内容直接返回，不拼接多块，也无外部副作用。
export function textOf(message: Message | undefined): string | undefined {
	// 先排除缺失值，让 TypeScript 后续知道 message 存在。
	if (message === undefined) return undefined;
	// 按 role 标签缩窄类型，本辅助函数特意不读取系统内容。
	if (message.role === "system") return undefined;
	// 用户内容可能直接是字符串；这是对真实联合类型分支的选择。
	if (typeof message.content === "string") return message.content;
	// 数组形式只查第一个 type 为 text 的内容块。
	const text = message.content.find((content) => content.type === "text");
	// ?. 避免访问缺失结果；条件分支确定 text 字段存在再返回。
	return text?.type === "text" ? text.text : undefined;
}

/** Poll `check` in real time until it holds; for waits that span throttle windows and timers. */
// 反复等待 check 返回真，默认最多约 5 秒；返回 Promise<void>，超时抛错。
// 例如 waitFor(() => reports.length > 0) 等异步报告；使用真实时钟和 5ms 定时器，不推进假时钟。
// check 自身抛错/拒绝会直接传出；单次 check 卡住时此超时不会打断它。
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	// 计算真实时间截止点，与 setup.now 的模拟时间无关。
	const deadline = Date.now() + timeoutMs;
	// 每轮允许同步或异步谓词；满足即结束，只有不满足才检查超时。
	while (!(await check())) {
		// 严格超过截止点才报错；并非精确计时保证。
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		// 让出事件循环约 5ms，避免同步忙等。
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Faux response that never answers; the run stays busy until its generation is cancelled. `reached` resolves once the
 * request was sent, after the generation's preparation and request commits.
 */
// 制作一个永不主动回答的 faux 响应与请求到达信号，返回 step、reached。
// 例如把 step 放入响应队列后 await reached，能确定模型调用已到达这里，再测试取消。
// 仅收到 abort 事件时拒绝；非空断言 ! 依赖 Harness 传 signal，不是运行时校验。
export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	// 确定赋值断言 ! 告诉 TS：下面 Promise 的同步执行器会给 reach 赋值。
	let reach!: () => void;
	// 创建到达信号；执行器立刻运行，不是在 await 时运行。
	const reached = new Promise<void>((resolve) => {
		// 保存 resolve，等假请求实际执行再通知测试。
		reach = resolve;
	});
	// 定义假供应商回调；_context 仅表示这个参数此处不用。
	const step: FauxResponseStep = (_context, options) =>
		// 忽略成功函数，只保留拒绝路径，因此不会自己产生回答。
		new Promise((_, reject) => {
			// 先标记请求已到达。
			reach();
			// 取 Harness 提供的取消信号；! 被 TS 擦除，不会补造 signal。
			const signal = options!.signal!;
			// 取消时以 signal.reason 拒绝，并在触发一次后移除该监听。这里不补查已经取消的状态。
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	// 返回一对共享同一闭包的测试控制点。
	return { step, reached };
}

/** The installed tools with these names, as `configure()` takes them. */
// 从注册表当前快照按名字选出工具，返回与输入名字同序的数组；缺任意一个即抛错。
// ...names 是剩余参数，例如 toolsNamed(setup, "read", "write")；只查安装，不执行工具。
export function toolsNamed(setup: ChatSetup, ...names: string[]): ToolRegistration[] {
	// 取本次固定快照内所有扩展的工具，不限制某个对话是否启用它们。
	const installed = setup.registry.snapshot().tools();
	// 逐名查找并组成结果，重复名字可得到重复工具引用。
	return names.map((name) => {
		// 解构每个安装项的 tool，按名称取第一个匹配项。
		const found = installed.find(({ tool }) => tool.name === name);
		// 显式报出缺失名字，同时让 TS 在下一行确定 found 存在。
		if (found === undefined) throw new Error(`Tool ${name} is not installed`);
		// 返回注册的工具对象，不克隆也不调用 execute。
		return found.tool;
	});
}
