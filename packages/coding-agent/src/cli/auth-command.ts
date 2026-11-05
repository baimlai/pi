// 解析 auth 子命令与共用参数约束，提取 API Key/Bearer 文字。实际认证由 ModelRuntime 负责，实际输出由命令调用方负责。
// 认证解析结果的类型，包含请求 apiKey/headers 等字段；import type 不产生运行时导入。
import type { AuthResult } from "@earendil-works/pi-ai";
// 使用配置中的应用名生成用法/错误文本，兼容 fork/rebrand 的应用名称。
import { APP_NAME } from "../config.ts";
// Args 是通用 CLI 参数解析后的结构，不是原始字符串数组。
import type { Args } from "./args.ts";

// 字面量联合表示三种认证子命令，内部名字和用户输入命令名不完全相同。
export type AuthCommandKind = "check" | "api_key" | "bearer_token";

// 第一层认证子命令解析结果：专用选项单独取出，剩余 args 再交给通用解析器。
export interface AuthCommand {
	// 最终识别的子命令种类。
	kind: AuthCommandKind;
	// 尚待通用参数解析器处理的 --provider/--model 等字符串。
	args: string[];
	// auth check 是否输出 JSON。
	json: boolean;
	// auth check 是否包含实际凭证值；只有用户显式指定才启用。
	credentials: boolean;
	// 是否禁止 check 刷新；与 checkProviderAuth 接收的正向 refresh 需要调用方转换。
	noRefresh: boolean;
	// 打印 Bearer 时要求的剩余有效期，统一换算为毫秒；未指定时由打印入口给默认值。
	minExpiryMs?: number;
}

// 用独立 Error 子类标记认证命令输入/选择错误，继承标准 message/stack，不另改运行时错误格式。
export class AuthCommandError extends Error {}

// Record<K,V> 约束三个 kind 都有用法字符串；以后新增 kind 漏写用法会被 TS 检查发现。
const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
};

/**
 * 把内部认证种类映射成用户输入的命令名，无副作用。例：bearer_token 变成 auth print-bearer-token，供错误提示复用。
 */
export function getAuthCommandName(kind: AuthCommandKind): string {
	// 嵌套三元表达式把内部 kind 映射回用户命令名；所有合法 kind 都由这三分支覆盖。
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

/**
 * 按子命令取一条用法文字，返回 string，不打印也不解析。例：check 取得包含 --json/--credentials 的提示。
 */
export function getAuthCommandUsage(kind: AuthCommandKind): string {
	// 按 kind 索引用法表，没有网络或存储副作用。
	return AUTH_COMMAND_USAGE[kind];
}

/**
 * 判断原始 argv 是否请求认证帮助；返回布尔值，不消费参数。例：["auth"]、["auth","check","--help"] 都为 true。
 */
export function isAuthCommandHelp(args: string[]): boolean {
	// 下面组合条件决定是否显示帮助；括号只是跨行表达同一个布尔结果。
	return (
		// 必须先确认是 auth 命令，避免普通聊天内容中的 --help 被这个助手接管。
		args[0] === "auth" &&
		// 没有子命令、显式 help、或任意位置出现帮助标志都算请求帮助；includes 只查是否包含，不删除参数。
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

/**
 * 把多行认证命令帮助打印到 stdout，无参数/返回值。这里只说明操作方式，不读凭证、不执行登录或模型调用。
 */
export function printAuthCommandHelp(): void {
	// 一次输出原始多行帮助文本；反引号中的换行和内容就是实际终端输出，不能把源码注释插进文本。
	console.log(`Usage:
  pi auth print-api-key [--provider <provider>] [--model <model>]
  pi auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  pi auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands require at least one of --provider or --model. Checks refresh expired OAuth credentials by default; --no-refresh prevents this. --credentials emits the credential, or includes it in JSON output.`);
}

/**
 * 先从 argv 识别认证子命令，取出专用开关，再返回剩余参数；不是 auth 则返回 undefined，让主命令继续处理。
 * 未知子命令或不允许的开关组合抛 AuthCommandError，不请求模型、不读取凭证。例：[auth,print-bearer-token,--min-expiry,30m,--provider,p] 返回毫秒值和剩余 --provider 参数。
 */
export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	// 不是 auth 开头则交回上层其他命令处理，不把它当无效认证子命令报错。
	if (args[0] !== "auth") return undefined;

	// 从第二个参数选子命令；没有识别到时保留 undefined，下面统一报未知子命令。
	const kind =
		// 用户命令 check 对应内部 kind check。
		args[1] === "check"
			? // 三元表达式条件成立时的结果。
				"check"
			: // 否则检查是否是打印 API Key 的子命令。
				args[1] === "print-api-key"
				? // 将用户可读命令名转换成内部下划线标识。
					"api_key"
				: // 继续检查 OAuth Bearer token 打印子命令。
					args[1] === "print-bearer-token"
					? // 匹配后使用内部 kind bearer_token。
						"bearer_token"
					: // 三个命令都不匹配，交给下方错误分支。
						undefined;
	// 这里只拒绝未知认证子命令；帮助请求由上层先调用 isAuthCommandHelp 分流。
	if (!kind) {
		// 向调用方抛出可识别的认证命令错误，不在解析器里直接退出整个进程。
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth print-api-key", "${APP_NAME} auth print-bearer-token", or "${APP_NAME} auth check".`,
		);
	}

	// 收集专用开关以外的参数，供通用 Args 解析器稍后处理。
	const commandArgs: string[] = [];
	// 默认不启用 JSON 输出。
	let json = false;
	// 默认不要求输出凭证秘密值。
	let credentials = false;
	// 默认没有 --no-refresh；调用方可据此让 check 走刷新路径。
	let noRefresh = false;
	// 有效期参数可缺省；这里不提前写死打印入口的默认 30 分钟。
	let minExpiryMs: number | undefined;
	// 前两个参数 auth/子命令已处理，从第 3 项向后扫描专用开关和通用参数。
	for (let index = 2; index < args.length; index++) {
		// 取当前位置的参数；处理带值选项时会额外推进 index 跳过其值。
		const arg = args[index];
		// 识别 Bearer token 打印专属的最小有效期选项。
		if (arg === "--min-expiry") {
			// API Key 和状态检查不能使用这个专属选项。单行 if 的下一条 throw 属于此分支。
			if (kind !== "bearer_token")
				// 错误组合直接拒绝，不把它误交给普通聊天模型参数。
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			// 先把 index 加一再取下个参数，因此循环末尾 index++ 会直接进入后续选项。
			const value = args[++index];
			// 按“数字+单位”匹配，如 30m；i 允许大小写，u 是 Unicode 模式。本代码后面仍按原单位文字比较，没有统一转小写。
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			// 没有值或格式不匹配就报错；这里校验形式，不是对数值范围/有限性的完整校验。
			if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
			// 捕获组 1 的数字文字转 number，例如 "30" 变成 30。
			const amount = Number(match[1]);
			// 捕获组 2 保留匹配到的原单位文字；示例建议使用小写 ms/s/m/h。
			const unit = match[2];
			// 小写 ms/s/m 分别乘 1/1000/60000，其余分支乘 3600000；数字中的下划线只提高源码可读性。
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			// 本专用选项已消费，直接扫描下一项，不再加入 commandArgs。
			continue;
		}
		// 三种布尔开关只允许 auth check，不带额外值。
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			// 打印凭证命令拿到 check 专属开关时明确报错。
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			// 启用结构化输出标志，实际打印由上层命令实现。
			if (arg === "--json") json = true;
			// 用户显式请求时才输出/包含秘密凭证。
			else if (arg === "--credentials") credentials = true;
			// 剩下只能是 --no-refresh，记录禁止刷新的要求。
			else noRefresh = true;
			// 本专用选项已消费，直接扫描下一项，不再加入 commandArgs。
			continue;
		}
		// 其他参数原样保留，让通用解析器处理 --provider/--model 等及未知项。
		commandArgs.push(arg);
	}

	// 缺省有效期与显式设置分开返回，缺省时不创建 minExpiryMs 字段。
	return minExpiryMs === undefined
		? // 对象字段简写保存三个开关及剩余参数。
			{ kind, args: commandArgs, json, credentials, noRefresh }
		: // 指定有效期时额外带上已换算毫秒值。
			{ kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

/**
 * 验证通用解析后的认证命令输入：拒绝未知标志、内联 key/聊天/文件输入，要求 provider/model 至少一个，返回归一化文字。
 * 它不在此验证账号或 token，也不独立遍历拒绝 Args 中所有其他已知字段。例：provider 是空白、model 未给时抛缺目标错误。
 */
export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	// 去掉供应商文字两端空白；空字符串经 || 归一化为 undefined。
	const provider = args.provider?.trim() || undefined;
	// 模型引用也做相同的轻量文字归一化，不在这里真正解析模型目录。
	const model = args.model?.trim() || undefined;
	// 发现通用 Args 未识别的选项时拒绝，不能无声忽略用户可能打错的 flag。
	if (args.unknownFlags.size > 0) {
		// Map 取键迭代器，再拿第一项，报告一个最先出现的未知选项。
		const option = args.unknownFlags.keys().next().value;
		// 错误里使用对应的用户命令名，帮助定位是哪条认证命令参数有误。
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	// 这条入口明确拒绝内联 API Key、聊天消息和文件参数；它不是一次普通编码提问。
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		// 将不适用输入作为认证命令错误交给上层，不自行记录这些输入内容。
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	// 检查子命令与打印子命令分别使用相应的缺参数提示。
	if (kind === "check") {
		// 至少要提供供应商或模型之一，才能知道检查/导出哪个对象。
		if (!provider && !model) {
			// 缺少检查目标时拒绝，不默认猜一个已登录账户。
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		// 只返回两个已归一化文字，下一层根据它们做模型/供应商解析。
		return { provider, model };
	}
	// 至少要提供供应商或模型之一，才能知道检查/导出哪个对象。
	if (!provider && !model) {
		// 打印凭证尤其需要明确目标，避免在无目标时选一个供应商。
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	// 只返回两个已归一化文字，下一层根据它们做模型/供应商解析。
	return { provider, model };
}

/**
 * 从已经解析的请求认证中提取可输出凭证：优先 apiKey，否则取不区分大小写的 Authorization: Bearer 后面的文字。
 * 纯转换，无网络/存储/打印副作用，也不验证凭证是否可登录。例：{headers:{Authorization:"Bearer abc"}} 得到 abc；缺失/其他认证形式得到 undefined。
 */
export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	// 优先提取非空 apiKey 字段；部分 OAuth 供应商也会把请求 token 放在这里，所以不能仅凭字段名认定存储类型。
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	// 没有 apiKey 时扫描请求头键值对；没有 headers 就当空对象，find 只取第一个匹配项。
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		// 解构键值对的第一个元素当作 header 名，并忽略大小写寻找 Authorization。
		([name]) => name.toLowerCase() === "authorization",
		// 可选链索引：找到键值对才取值（下标 1），没找到则 undefined。
	)?.[1];
	// 头值可能为空/删除标记，先收窄成字符串，再提取 Bearer 后面部分；不匹配就 undefined，不在这里额外 trim 或验证令牌有效性。
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
