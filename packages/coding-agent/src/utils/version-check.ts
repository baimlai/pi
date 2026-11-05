// 查询Pi发布元数据及比较版本，供启动通知和显式自更新计划复用；本文件只查询/判断，不安装包或执行更新。
import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
// 默认查询给管理HTTP helper的总体信号预算，不是每次重试重新开始的10秒。
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

// 最新发布的元数据；?字段可缺省，类型不保证包名可信、版本符合semver或note是安全HTML。
export interface LatestPiRelease {
	version: string;
	// 服务端可建议活动npm包名，显式自更新调用方再据此构造安装计划。
	packageName?: string;
	// 文本/Markdown发布提示，是否展示由调用方决定。
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
// 输入任意抛出值，返回根消息及一层cause中的错误码/消息，无网络或日志副作用。
// 例如fetch failed的AggregateError子项有ETIMEDOUT/ENETUNREACH，就得到fetch failed (ETIMEDOUT, ENETUNREACH)；不递归走全部cause链。
export function formatVersionCheckError(error: unknown): string {
	// unknown先用instanceof收窄再读Error属性；根无非空message时用String显示，不强制外部抛错必须为Error。
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	// AggregateError展开直接errors；普通cause包成单项数组，缺cause为空数组，非递归树遍历。
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		// cause是异常边界上的未知值，确认非null对象、含code且code为string之后才使用。
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		// 类型谓词code is string使filter后数组不再包含undefined；空字符串code仍属于string。
		.filter((code): code is string => code !== undefined);

	// Set去重并保留首次出现顺序，...展开再join；只要有code便不再附加普通cause消息。
	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	// 没有错误码时取首个Error的非空message；任意字符串cause不在这一分支自动当消息。
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

// 输入两个版本文字，trim后交semver验证并比较，返回-1/0/1，任一无效则undefined，无副作用。
// 例如5.0.0-beta.20大于beta.9；semver比较忽略+构建标识，不是按字典序或拆三段Number比较。
export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	// valid返回规范化版本字符串或null；类型string不等于运行时必然是合法版本。
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	// 此时已通过semver验证，compare根据主/次/修订及预发布规则排序。
	return compare(left, right);
}

// 输入候选/当前版本，能按semver比较就判断>0，否则仅按trim后文本是否不同返回布尔，无I/O。
// 例如无效版本文字custom-a对custom-b也返回true；“更新”在无效版本降级规则中不代表已证明版本更大。
export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	// !==undefined不能换成if(comparison)，因为0也是一次有效比较，必须返回false而非走降级。
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

// 输入当前版本（用于User-Agent）及可选超时/重试，异步查询活动发布，返回元数据或undefined；不比较新旧。
// 例如{retry:true}最多初始+两次管理请求，默认只一次；HTTP非成功/空版本返回undefined，网络、JSON解析及异常数据访问错误会拒绝。
// PI_OFFLINE任何非空文字（包括"0"/"false"）都跳过；API对象只逐字段检查字符串，不验证semver、npm包名或note内容。
export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	// 这与tools-manager只接受1/true/yes的离线判断不同；PI_SKIP_VERSION_CHECK不拦此显式查询入口。
	if (process.env.PI_OFFLINE) return undefined;

	// helper负责请求级重试，返回Response后读取JSON失败不再回到重试循环。
	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				// 当前版本只进入管理请求标识，不附认证信息，也不发给模型提供商。
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			// retry真值开启额外两次；??保留显式0，helper按自身规则决定是否创建超时信号。
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	// fetch对HTTP错误通常不throw，这里把非2xx视作无结果，不读取其JSON。
	if (!response.ok) return undefined;

	// as只声明我们接下来关心的字段，不会验证JSON确为对象；例如null数据可在访问.version时抛错。
	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	// 这是远端JSON信任边界，检查version确实非空字符串再对外暴露，不仅依赖TS断言。
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	// 可选包名和提示只有非空字符串才保留，去掉首尾空白但不作语义验证。
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	// packageName键即使undefined也存在；note用条件展开，仅有非空值才加这个键。
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

// 输入与getLatestPiRelease相同，异步只取版本字符串，无结果undefined；例如显式更新查询不受自动通知关闭开关影响。
// 真实网络副作用和异常策略沿用下层，本函数不额外catch，也不确认返回版本比当前新。
export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	// 先await元数据，再?.读取version；没有结果时不访问属性。
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

// 输入当前版本，用于启动时静默检查，返回更“新”的发布元数据或undefined；显式禁用时不请求，普通查询异常也吞掉。
// 例如当前1.2.3服务端1.2.4会通知，相同/更旧不通知；非法semver仍遵循上面“文字不同算更新”的降级规则。
export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	// 任何非空PI_SKIP_VERSION_CHECK都启用跳过；只影响自动检查，不改变直接查询入口。
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		// 不传retry，所以启动自动检查仅发一次请求，避免网络故障放大启动工作。
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		// 自动提示失败不影响主会话；显式自更新调用者用另一入口展示实际错误。
		return undefined;
	}
}
