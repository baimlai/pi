// 为 CLI 和设置层配置全局 HTTP 连接调度器，统一超时、代理、客户端工厂及 fetch 的 undici 实现。
// 本模块不决定发给模型的消息，也不把 HTTP 连接错误改写成聊天回答。
// EventEmitter 对无人监听的 error 事件有特殊行为，下面为 undici 客户端提供兜底监听。
import { EventEmitter } from "node:events";
// import * as 收集模块公开导出，后续通过 undici.Client 等名称访问。
import * as undici from "undici";

// 毫秒单位：300_000 等于 300000，即 5 分钟；数字下划线只用于源码可读性。
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
// 自动选择 IPv4/IPv6 连接候选时，给每次地址尝试更长的等待时间，区别于整个响应超时。
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

// 设置界面可选择的时间档位；as const 让类型保留具体值和只读形状，不冻结运行时对象。
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	// 半分钟，以毫秒写入配置。
	{ label: "30 sec", timeoutMs: 30_000 },
	// 一分钟。
	{ label: "1 min", timeoutMs: 60_000 },
	// 两分钟。
	{ label: "2 min", timeoutMs: 120_000 },
	// 默认五分钟。
	{ label: "5 min", timeoutMs: 300_000 },
	// undici 用 0 表示不设置对应的超时上限。
	{ label: "disabled", timeoutMs: 0 },
] as const;

// 捕获模块首次加载时的 fetch 引用，以后据此判断宿主是否主动替换过它。
const originalGlobalFetch = globalThis.fetch;
// 保存本模块上次安装的 fetch；typeof 在类型位置表示复用 fetch 的函数签名。
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * 将配置边界传来的未知值解析为非负整数毫秒；非法值返回 undefined，不抛异常。
 * 先处理字符串 disabled/空白/数字，再验证有限非负数并向下取整。
 * 例：" 30000 " → 30000，"disabled" → 0，-1/Infinity/"bad" → undefined，1.9 → 1。
 * unknown 要在运行时检查后才能按字符串或数字操作；这是真实配置输入边界。
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	// 只有字符串才可以调用 trim；typeof 同时帮助 TypeScript 收窄类型。
	if (typeof value === "string") {
		// 去掉配置文字两端空白，内部字符保持原样。
		const trimmed = value.trim();
		// 不区分大小写识别禁用文字，返回 undici 使用的数值 0。
		if (trimmed.toLowerCase() === "disabled") {
			// 数值 0 是明确的禁用，不是缺少配置。
			return 0;
		}
		// 空字符串不能按 Number("")=0 误解释为用户要求禁用。
		if (trimmed.length === 0) {
			// undefined 让调用方决定采用默认值还是报告错误。
			return undefined;
		}
		// 非空数字字符串转换后递归走同一套数值校验，不复制验证逻辑。
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	// 同时拒绝非数字、NaN/Infinity 和负值；|| 表示任何一项不合法都拒绝。
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		// 不静默把非法配置变成一个看似合法的时间。
		return undefined;
	}
	// 通过校验后确定是有限非负数，取整使超时单位保持整数毫秒。
	return Math.floor(value);
}

/** 根据已知时间档位生成展示文字，不修改设置；例如 60000 → "1 min"，1500 → "1.5 sec"，0 → "disabled"。 */
export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	// find 返回第一个匹配档位；查不到为 undefined。
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	// 常用值采用界面已有标签，保持不同设置入口显示一致。
	if (choice) {
		// 直接取对应档位的文字。
		return choice.label;
	}
	// 自定义值转换为秒，模板字符串把计算结果放进展示文字。
	return `${timeoutMs / 1000} sec`;
}

/** 将显式代理填入尚未设置的 HTTP_PROXY/HTTPS_PROXY 环境变量；输入为空则无动作，已有环境值优先。 */
export function applyHttpProxySettings(httpProxy: string | undefined): void {
	// 可选链允许不传；有字符串时去掉首尾空白。
	const proxy = httpProxy?.trim();
	// undefined 或空白代理不应该抹掉已经存在的代理配置。
	if (!proxy) return;
	// ??= 仅在 null/undefined 时赋值；已有字符串甚至空字符串都保持原值。
	process.env.HTTP_PROXY ??= proxy;
	// HTTPS 独立处理，允许用户事先配置不同的代理。
	process.env.HTTPS_PROXY ??= proxy;
}

// 空监听只接收 EventEmitter 的 error 事件；它不会把 fetch body 的读取失败变成成功。
const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
/** 给实际支持 EventEmitter 的 dispatcher 接上 error 监听并返回原对象；泛型 T 保留具体客户端类型。 */
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	// 此处沿用既有适配逻辑，只对实际 EventEmitter 实例装这个监听，不额外包装 dispatcher。
	if (dispatcher instanceof EventEmitter) {
		// call 显式把 dispatcher 当 this 调用基类 on，避免依赖适配对象可能覆盖的同名方法。
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	// 原引用返回，调用方仍拿到 Client/Pool 原来的能力。
	return dispatcher;
}

/** 创建单连接 undici Client 并装 error 监听；输入为 origin 与内部传下来的连接选项，返回 dispatcher，不在此构造聊天请求。 */
function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	// as 是开发期断言，不在运行时逐字段验证选项；实际构造仍由 undici.Client 处理。
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

/** 为一个 origin 创建调度器：connections=1 使用 Client，其余使用 Pool；例如同一模型服务可由连接池复用连接。 */
function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	// 将内部工厂选项按 Pool.Options 的已约定形状读取。
	const dispatcherOptions = options as undici.Pool.Options;
	// 单连接时不额外建 Pool，直接走一致的 Client 工厂。
	if (dispatcherOptions.connections === 1) {
		// 返回已装 error 监听的 Client。
		return createUndiciClient(origin, dispatcherOptions);
	}
	// 其他情况给连接池本身也装监听。
	return withUndiciErrorListener(
		// Pool 管理同一 origin 的客户端；构造选项不包含用户聊天历史。
		new undici.Pool(origin, {
			// 浅复制传入选项，下面覆盖客户端创建工厂。
			...dispatcherOptions,
			// 池内创建的每个 Client 也经过同样的 error 监听设置。
			factory: createUndiciClient,
		}),
	);
}

/**
 * 安装 Pi 的全局 HTTP dispatcher，供 CLI 初始准备和设置加载后调用。
 * 输入 timeoutMs 默认为 5 分钟；非法值抛错。返回 void，副作用是更新 undici 全局调度器及条件性安装 fetch。
 * 流程：解析时间 → 建环境代理调度器 → 设置全局 dispatcher → 若 fetch 未被宿主替换，使用匹配的 undici fetch。
 * 例：configureHttpDispatcher(0) 禁用对应空闲超时；不等于把单次任务、重试或全部网络超时一起禁用。
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	// 即使参数类型是 number，也要验证配置允许的取值范围；负数和 Infinity 仍是 number。
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	// 解析失败时明确拒绝，不能装一份不受控的连接配置。
	if (normalizedTimeoutMs === undefined) {
		// String 让错误显示实际输入，不在这里自动更改用户配置。
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	// 顶层环境代理 Agent 本身同样需要 error 监听。
	const dispatcher = withUndiciErrorListener(
		// EnvHttpProxyAgent 按环境变量选择代理，并通过下面两个工厂创建连接。
		new undici.EnvHttpProxyAgent({
			// 此配置明确禁用 HTTP/2。
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			// 保持 HTTP origin 也采用 CONNECT 隧道的既有代理行为。
			proxyTunnel: true,
			// 响应正文空闲时间上限，与生成 token 的总时长不是同一指标。
			bodyTimeout: normalizedTimeoutMs,
			// 连接阶段的单独配置对象。
			connect: {
				// 调整地址族候选尝试的等待，避免高延迟线路过早切换/失败。
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			// 等待响应头的上限采用同一配置时间。
			headersTimeout: normalizedTimeoutMs,
			// 代理调度器需要直接客户端时采用这个工厂。
			clientFactory: createUndiciClient,
			// origin 调度器需要连接池时采用这个工厂。
			factory: createUndiciOriginDispatcher,
		}),
	);
	// 更新 undici 的全局默认调度器；不在此向任何服务发送具体请求。
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	// 只覆盖仍是初始值或本模块上次安装值的 fetch，保留调用方后续刻意替换的实现。
	const shouldInstallGlobals =
		// 尚未安装过时，与模块加载时捕获的 fetch 比较。
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: // 已安装过时，确认当前 fetch 仍由本模块拥有。
				globalThis.fetch === installedGlobalFetch;
	// 宿主没有主动替换时，才让 fetch 与 dispatcher 来自同一 undici，避免解压等实现不匹配。
	if (shouldInstallGlobals) {
		// 可选调用：当前 undici 导出 install 才执行；不需要动态 import。
		undici.install?.();
		// 保存安装后的引用，下次配置时可判断中途有没有被其他代码替换。
		installedGlobalFetch = globalThis.fetch;
	}
}
