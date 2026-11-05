/**
 * Model catalog protocol shared by pi and pi.dev.
 *
 * This file is copied verbatim into two repositories. Change both copies in
 * the same pair of pull requests and keep them byte for byte identical:
 *
 *   earendil-works/pi      scripts/model-catalog-protocol.ts
 *   earendil-works/pi.dev  src/shared/models/protocol.ts
 *
 * pi uses it to publish catalog revisions and to test clients against the
 * catalog selection pi.dev performs. pi.dev uses it to serve catalog requests.
 * Keep it free of imports and runtime specific APIs so it runs unchanged in
 * Node.js and Cloudflare Workers.
 *
 * Storage layout under `MODEL_CATALOG_PREFIX`:
 *
 *   index.json                                    revision index (`ModelCatalogIndex`)
 *   revisions/<revision>/models.json              chat models by provider and id
 *   revisions/<revision>/models.all.json          models of every type by provider
 *   revisions/<revision>/providers.json           sorted provider ids
 *   revisions/<revision>/providers/<id>.json      chat models of one provider by id
 *   revisions/<revision>/providers/<id>.all.json  models of every type of one provider
 *
 * Clients that send `?types=` receive the typed `.all.json` variant. Older
 * clients receive the legacy chat-only variant.
 *
 * 文件导读
 * 所属：仓库根 scripts/ 的模型目录协议模块（不是发布脚本），同时被 pi 与 pi.dev 使用。
 * 作用：定义云端存储键、模型目录索引结构、Pi 版本比较、HTTP 请求解析和目录选择规则。
 * 上游：publish-model-catalog.mjs（发布时构造并校验索引）、model-catalog-protocol.test.ts、
 *       check-model-catalog-compat.mjs；pi.dev 保存逐字节相同的副本用于服务端应答。
 * 下游：没有 import，只使用标准 URL 与正则，因此 Node.js 和 Cloudflare Workers 都能直接运行。
 * 能力清单：
 *   MODEL_CATALOG_SCHEMA_VERSION / PREFIX / INDEX_KEY / REVISION_RE - 存储布局与格式常量。
 *   getModelCatalogArtifactKey / getModelCatalogProviderKey - 生成 revision 下的对象键。
 *   isValidModelCatalogPiVersion / compareModelCatalogPiVersions - Pi 版本合法性检查与 semver 比较。
 *   parseModelCatalogRepresentation - 解析 ?types=，决定返回旧版 chat 还是带类型的完整目录。
 *   parseModelCatalogRequest - 从 URL 与 User-Agent 得出 catalog/invalid 决策。
 *   selectModelCatalog - 为某个客户端版本选最高的、最低版本不超过它的 revision。
 *   parseModelCatalogIndex - 校验从存储读出的索引并剥离发布元数据。
 * 组合顺序：请求先经 parseModelCatalogRequest 判断表示形式与版本，再用索引和版本调用 selectModelCatalog。
 * 示例（真实签名；假设 index 已是调用方读入的 ModelCatalogIndex）：
 *   const request = parseModelCatalogRequest("https://pi.dev/api/models?types=chat", "pi/1.2.1");
 *   const entry = selectModelCatalog(index, request.kind === "catalog" ? request.piVersion : undefined);
 * 阅读顺序：先看导出类型和常量，再看 parse/select 的决策逻辑，最后看底部的 semver 比较实现。
 */

// 存储格式版本；进入键前缀和索引校验，改变它等于换一套不兼容布局。
export const MODEL_CATALOG_SCHEMA_VERSION = 1;
// 所有模型目录对象的公共前缀；v1 来自上面的 schema 版本。
export const MODEL_CATALOG_PREFIX = `models/v${MODEL_CATALOG_SCHEMA_VERSION}`;
// 索引对象的固定键；发布器用它定位“当前有哪些 revision”。
export const MODEL_CATALOG_INDEX_KEY = `${MODEL_CATALOG_PREFIX}/index.json`;
// revision 是内容哈希：sha256- 加 64 位小写十六进制；索引和请求校验都依赖这个格式。
export const MODEL_CATALOG_REVISION_RE = /^sha256-[0-9a-f]{64}$/;

// 可选的 v 前缀、major.minor.patch、可选预发布段、可选构建元数据；不接受只有两段的版本。
const PI_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// 匹配 "pi/1.2.1" 以及带括号环境信息的 "pi/1.2.1 (linux; node/v22; x64)"；括号内最多三段。
const PI_USER_AGENT_RE = /^pi\/([^\s()]+)(?: \([^;()]+(?:;\s*[^;()]+(?:;\s*[^()]+)?)?\))?$/i;
// 模型类型名允许字母数字开头，后续可有 . _ -；用于 ?types= 的逐项校验。
const MODEL_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 解析后的版本是只读元组：[主, 次, 补丁, 预发布字符串]；预发布为空串表示正式版。
// 这是编译期类型；运行时由 parsePiVersion 实际校验。
type ParsedPiVersion = readonly [major: number, minor: number, patch: number, prerelease: string];

// 三个独立目录文件名；providers.json 是从 provider id 到对象的索引清单。
export type ModelCatalogArtifact = "models.json" | "models.all.json" | "providers.json";

// 两种表示：legacy 只有 chat 模型，typed 包含 chat/image/classifier。
export type ModelCatalogRepresentation = "legacy" | "typed";

// 索引条目：最低客户端版本 + 该版本线对应的不可变 revision。
export type ModelCatalogIndexEntry = {
	minimumPiVersion: string;
	revision: string;
};

// 索引根：schema 版本、默认 revision（无版本请求使用）、所有目录条目。
export type ModelCatalogIndex = {
	schemaVersion: number;
	defaultRevision: string;
	catalogs: ModelCatalogIndexEntry[];
};

// 请求解析结果的可辨识联合：
// kind="catalog" 表示可以继续选目录；kind="invalid" 表示参数非法，调用方应返回 4xx。
// 运行时不会自动校验外部对象，这个类型只约束本模块自己的返回值。
export type ModelCatalogRequest =
	| { kind: "catalog"; piVersion: string | undefined; representation: ModelCatalogRepresentation }
	| { kind: "invalid"; error: string };

// 生成 revision 下的完整目录对象键，例如 models/v1/revisions/sha256-.../models.json。
export function getModelCatalogArtifactKey(revision: string, artifact: ModelCatalogArtifact): string {
	return `${MODEL_CATALOG_PREFIX}/revisions/${revision}/${artifact}`;
}

// 生成单个 provider 分片的键；typed 使用 .all.json 后缀，legacy 使用 .json。
export function getModelCatalogProviderKey(
	revision: string,
	provider: string,
	representation: ModelCatalogRepresentation,
): string {
	const suffix = representation === "typed" ? ".all.json" : ".json";
	return `${MODEL_CATALOG_PREFIX}/revisions/${revision}/providers/${provider}${suffix}`;
}

// 判断字符串是否是协议接受的 Pi 版本；内部复用 parsePiVersion。
export function isValidModelCatalogPiVersion(version: string): boolean {
	return parsePiVersion(version) !== undefined;
}

/** Compare two Pi versions with semver precedence. Throws for invalid versions. */
// 比较两个版本，返回负数/0/正数；任一版本非法时 requirePiVersion 抛错（不是返回 undefined）。
// 例：compareModelCatalogPiVersions("0.85.0-rc.1", "0.85.0") 返回负数。
export function compareModelCatalogPiVersions(left: string, right: string): number {
	return comparePiVersions(requirePiVersion(left), requirePiVersion(right));
}

/**
 * Parse the `types` query parameter. Returns undefined when it is present but
 * invalid. Clients that do not send it predate model types.
 */
// 解析 ?types=：缺省（undefined/null）表示老客户端，返回 legacy；
// 空串或任一段不匹配 MODEL_TYPE_RE 时返回 undefined（表示参数非法）；否则 typed。
// 因此 undefined 只代表“参数存在但非法”，缺失参数会得到 legacy，两者可以区分。
// 例：parseModelCatalogRepresentation("chat,image") === "typed"。
export function parseModelCatalogRepresentation(
	types: string | null | undefined,
): ModelCatalogRepresentation | undefined {
	if (types === undefined || types === null) {
		return "legacy";
	}
	// split(",") 允许逗号分隔多个类型；空项会被正则拒绝，因此 "chat," 也非法。
	if (types === "" || types.split(",").some((type) => !MODEL_TYPE_RE.test(type))) {
		return undefined;
	}
	return "typed";
}

/**
 * Decide how to answer a catalog request from its URL and User-Agent.
 *
 * Released clients do not send `pi-version`, so clients that identify as Pi
 * are served the catalog for the version in their User-Agent. The response
 * therefore varies on the User-Agent, and the server must say so with `Vary`.
 * An explicit `pi-version` takes precedence. Requests without a Pi User-Agent
 * receive the default catalog.
 */
// 把 HTTP 请求映射为目录选择所需的参数。
// 优先级：显式 pi-version > User-Agent 中的 pi/x.y.z > 无版本（默认目录）。
// 非法 types 先返回 invalid；非法 pi-version 返回 invalid；User-Agent 里的版本非法时
// 不报错，而是退回“无版本”，因为 UA 不是客户端可控的显式参数。
// 注意：new URL 遇到非法 URL 会抛 TypeError，本函数不捕获，由调用方处理。
// 例：parseModelCatalogRequest("https://pi.dev/api/models", "pi/1.2.1") 得到 piVersion "1.2.1"、legacy。
export function parseModelCatalogRequest(url: string | URL, userAgent: string | null | undefined): ModelCatalogRequest {
	const requestUrl = new URL(url);
	const representation = parseModelCatalogRepresentation(requestUrl.searchParams.get("types"));
	// 参数存在但非法时返回 4xx 信息；此处不继续看版本。
	if (representation === undefined) {
		return { kind: "invalid", error: "Invalid model types." };
	}

	const piVersion = requestUrl.searchParams.get("pi-version");
	// 没有显式版本时，尝试从 User-Agent 提取；?? "" 把 null/undefined 统一成空串。
	if (piVersion === null) {
		const userAgentVersion = PI_USER_AGENT_RE.exec(userAgent ?? "")?.[1];
		// 只有 UA 版本通过语义校验才采用；否则按无版本请求处理。
		if (userAgentVersion !== undefined && isValidModelCatalogPiVersion(userAgentVersion)) {
			return { kind: "catalog", piVersion: userAgentVersion, representation };
		}
		return { kind: "catalog", piVersion: undefined, representation };
	}
	// 显式参数优先，但非法时必须报错，让客户端知道请求写错了。
	if (!isValidModelCatalogPiVersion(piVersion)) {
		return { kind: "invalid", error: "Invalid Pi version." };
	}
	return { kind: "catalog", piVersion, representation };
}

/**
 * Select the catalog revision for a Pi version: the entry with the highest
 * minimum version that does not exceed it. Requests without a version receive
 * the default revision. Returns undefined when no entry is compatible.
 */
// 为客户端版本选目录：在所有 minimumPiVersion <= 请求版本 的条目里取最低版本最高的那条。
// 没有版本时返回 defaultRevision 对应条目；版本非法或低于所有条目时返回 undefined。
// 例：index 有 0.80.7 与 0.85.0 两条，请求 0.84.4 选中 0.80.7。
export function selectModelCatalog(
	index: ModelCatalogIndex,
	piVersion: string | undefined,
): ModelCatalogIndexEntry | undefined {
	// 无版本请求走默认 revision；find 找不到（索引损坏）时返回 undefined。
	if (piVersion === undefined) {
		return index.catalogs.find((catalog) => catalog.revision === index.defaultRevision);
	}

	const requestedVersion = parsePiVersion(piVersion);
	// 调用方可能绕过 parseModelCatalogRequest；这里再次拒绝非法版本。
	if (!requestedVersion) {
		return undefined;
	}

	let selected: ModelCatalogIndexEntry | undefined;
	let selectedVersion: ParsedPiVersion | undefined;
	for (const catalog of index.catalogs) {
		// 索引条目来自存储，minimumPiVersion 非法属于损坏数据，requirePiVersion 直接抛错。
		const minimumVersion = requirePiVersion(catalog.minimumPiVersion);
		// 条件一：最低版本不超过客户端；条件二：比当前选中项的最低版本更高（或尚未选中）。
		if (
			comparePiVersions(minimumVersion, requestedVersion) <= 0 &&
			(!selectedVersion || comparePiVersions(minimumVersion, selectedVersion) > 0)
		) {
			selected = catalog;
			selectedVersion = minimumVersion;
		}
	}
	return selected;
}

/**
 * Validate an index read from storage. Returns only the protocol fields;
 * publishers may store additional metadata on each entry.
 */
// 校验从存储读出的索引，返回只含协议字段的新对象。
// 这是运行时信任边界：value 来自 JSON，类型系统无法保证形状，因此逐字段检查。
// 发布器在条目上附加的 sourceCommit/modelCount 等字段会被丢弃（但发布器自己保留原对象）。
// 校验失败抛 Error，而不是返回 undefined。
export function parseModelCatalogIndex(value: unknown): ModelCatalogIndex {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION ||
		!("defaultRevision" in value) ||
		typeof value.defaultRevision !== "string" ||
		!MODEL_CATALOG_REVISION_RE.test(value.defaultRevision) ||
		!("catalogs" in value) ||
		!Array.isArray(value.catalogs) ||
		value.catalogs.length === 0 ||
		value.catalogs.some(
			(catalog) =>
				typeof catalog !== "object" ||
				catalog === null ||
				typeof catalog.minimumPiVersion !== "string" ||
				!parsePiVersion(catalog.minimumPiVersion) ||
				typeof catalog.revision !== "string" ||
				!MODEL_CATALOG_REVISION_RE.test(catalog.revision),
		) ||
		!value.catalogs.some((catalog) => catalog.revision === value.defaultRevision)
	) {
		throw new Error(`Model catalog index is invalid: ${MODEL_CATALOG_INDEX_KEY}`);
	}

	// 重新构造纯协议对象，避免把发布元数据带进服务端响应。
	return {
		schemaVersion: value.schemaVersion,
		defaultRevision: value.defaultRevision,
		catalogs: value.catalogs.map(({ minimumPiVersion, revision }) => ({
			minimumPiVersion,
			revision,
		})),
	};
}

// 要求版本合法并返回解析结果；供比较函数使用，非法输入是调用错误而非可忽略情况。
function requirePiVersion(version: string): ParsedPiVersion {
	const parsed = parsePiVersion(version);
	if (!parsed) {
		throw new Error(`Invalid Pi version: ${version}`);
	}
	return parsed;
}

// 解析版本字符串：先 trim，再匹配正则；数字必须是安全整数，否则视为非法。
function parsePiVersion(version: string): ParsedPiVersion | undefined {
	const match = PI_VERSION_RE.exec(version.trim());
	if (!match) {
		return undefined;
	}
	// 捕获组是字符串；Number 转换后检查安全整数，避免超出 2^53 的版本号被静默截断。
	const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
	if (parsed.some((part) => !Number.isSafeInteger(part))) {
		return undefined;
	}
	// 第 4 组是预发布标识；缺失时用空串表示正式版。
	return [parsed[0], parsed[1], parsed[2], match[4] ?? ""];
}

// 按 semver 优先级比较两个已解析版本。
function comparePiVersions(left: ParsedPiVersion, right: ParsedPiVersion): number {
	// 先逐段比较主/次/补丁；任一不同立即返回差值。
	for (const index of [0, 1, 2] as const) {
		const difference = left[index] - right[index];
		if (difference !== 0) {
			return difference;
		}
	}

	const leftPrerelease = left[3];
	const rightPrerelease = right[3];
	// 预发布字符串完全相同，版本相等。
	if (leftPrerelease === rightPrerelease) {
		return 0;
	}
	// 正式版优先级高于同版本号的预发布版。
	if (!leftPrerelease) {
		return 1;
	}
	if (!rightPrerelease) {
		return -1;
	}

	// 逐段比较预发布标识；按 semver，数字段按数值、字母段按字典序。
	const leftParts = leftPrerelease.split(".");
	const rightParts = rightPrerelease.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		// 共同前缀相同时，段数更少的预发布版本优先级更低。
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;

		// 纯数字串转换成数字比较，否则为 undefined；注意前导零不影响数值比较。
		const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
		const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
		if (leftNumber !== undefined && rightNumber !== undefined) {
			return leftNumber - rightNumber;
		}
		// 数字标识符优先级低于字母标识符。
		if (leftNumber !== undefined) return -1;
		if (rightNumber !== undefined) return 1;
		// 两者都是字母时按本地化字符串顺序比较；semver 规定 ASCII 顺序，这里沿用现有实现。
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}
