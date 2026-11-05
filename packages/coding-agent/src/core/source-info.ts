// 给扩展、技能、模板、主题记录来源，并生成去重键；资源加载器/UI 用它区分用户、项目和临时输入。
// 真实文件路径可尽可能 realpath，builtin: 与 <inline:...> 这类合成标识不当作磁盘文件解析。
// 导入真实路径归一化和平台比较键辅助；后者在 Windows 折叠路径大小写。
import { canonicalizePath, getPathComparisonKey } from "../utils/paths.ts";
// 来源元数据只用作 TypeScript 类型，不因本行执行包管理器。
import type { PathMetadata } from "./package-manager.ts";

// 字面量联合描述用户范围、项目范围和临时输入范围，不直接代表资源是否已经获得信任。
export type SourceScope = "user" | "project" | "temporary";
// 来源形式区分包内资源和顶层配置/路径；它与 scope 是两个不同维度。
export type SourceOrigin = "package" | "top-level";

// 展示/诊断共用的来源信息，类型定义本身不验证磁盘文件或外部 JSON。
export interface SourceInfo {
	// 资源路径，可以是真实路径也可以是合成标识。
	path: string;
	// 来源字符串，例如 npm/git 包说明或配置来源名。
	source: string;
	// 在用户、项目或临时哪个范围引入。
	scope: SourceScope;
	// 资源来自包还是顶层入口。
	origin: SourceOrigin;
	// 可选基准目录，供相对路径展示/定位；? 表示允许没有这个属性。
	baseDir?: string;
	// 包更新日志的可选路径，缺失时不强行推算。
	changelogPath?: string;
}

// 包身份只取 source+scope；相同包在不同范围可有不同身份。
export interface SourcePackageIdentity {
	// 包来源表达式。
	source: string;
	// 包所在范围；不包括资源文件名。
	scope: SourceScope;
}

/**
 * 把 source 和 scope 序列化成稳定字段顺序的键，不读写文件。
 * 例：同一个 npm 包分别在 user 和 project 范围会得到不同 JSON 字符串；额外元数据不参与身份。
 */
export function getSourcePackageKey(identity: SourcePackageIdentity): string {
	// JSON.stringify 避免用简单分隔符拼接时来源字符串本身包含分隔符产生歧义。
	return JSON.stringify({
		// 显式列出 source，控制键的组成和插入顺序。
		source: identity.source,
		// scope 与 source 一起构成完整包身份。
		scope: identity.scope,
	});
}

/** Prefix of built-in tool and extension paths, such as `builtin:read` or `builtin:mcp`. */
// 内置资源前缀是运行时常量；如 builtin:read，不是磁盘路径。
export const BUILTIN_PATH_PREFIX = "builtin:";

/**
 * Source of a path that names no file: `builtin` for `builtin:<name>`, or the prefix of an
 * angle-bracket path such as `inline` for `<inline:name>`. Undefined for file paths.
 */
/**
 * 从合成路径提取来源名；普通文件路径返回 undefined，纯字符串处理无 I/O。
 * 例：builtin:mcp→builtin，<inline:name>→inline，<>→temporary；只有尖括号同时完整闭合时才提取其内部来源。
 */
export function getSyntheticPathSource(path: string): string | undefined {
	// 内置前缀优先，统一归入 builtin。
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	// slice 去掉首尾尖括号，split 取冒号前片段；空片段用 || 回退 temporary。
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
	// 没有识别的合成来源，交给文件路径处理者。
	return undefined;
}

/**
 * 判断是否按合成标识对待；此处仅看 builtin: 或开头 <，不会校验尖括号必须闭合。
 * 例：<unfinished 也返回 true，而 getSyntheticPathSource 对它仍返回 undefined；两个函数承担的规则不同。
 */
export function isSyntheticPath(path: string): boolean {
	// || 短路求布尔值；这里没有文件系统探测。
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

/** Key for deduplicating resource paths: synthetic paths as-is, file paths via realpath and platform casing. */
/**
 * 为资源路径生成去重键；合成标识原样返回，文件尽可能解析真实路径后按平台比较。
 * 例：Windows 大小写不同的同一文件可去重，但 builtin:MCP 和 builtin:mcp 保持不同。不存在文件仍可得到比较键，不保证资源有效。
 */
export function getResourcePathKey(path: string): string {
	// 三元表达式只计算被选中的分支，所以合成标识不会调用 realpath。
	return isSyntheticPath(path) ? path : getPathComparisonKey(canonicalizePath(path));
}

/**
 * 从包管理器已提供的元数据复制成资源来源信息，返回新对象，不检查资源存在性。
 * 例：给 path=/repo/skill.md 和 project 范围元数据，得到同样范围的新 SourceInfo。字段多为字符串浅复制，不深拷贝或修改 metadata。
 */
export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	// 对象字面量创建资源自身的一份来源记录。
	return {
		// 属性简写 path 等价于 path:path。
		path,
		// 保留上游给出的 source，不在此重新解析 npm/git 来源。
		source: metadata.source,
		// 保留范围分类。
		scope: metadata.scope,
		// 保留包内/顶层分类。
		origin: metadata.origin,
		// baseDir 即使 undefined 也会作为对象字段写入；JSON 序列化时才可能省略。
		baseDir: metadata.baseDir,
		// 条件对象展开：changelogPath 为真值才添加属性；空字符串也被省略。
		...(metadata.changelogPath ? { changelogPath: metadata.changelogPath } : {}),
	};
}

/**
 * 为内置/内联等资源构造来源对象，scope 缺省 temporary、origin 缺省 top-level。
 * 例：createSyntheticSourceInfo("<inline:x>",{source:"inline"}) 返回临时顶层来源。函数不验证 path 必须是合成格式，也不访问磁盘。
 */
export function createSyntheticSourceInfo(
	// 第一个必填参数为资源标识；名称约定不构成运行时格式校验。
	path: string,
	// 第二参数是对象类型，source 必填，其余元数据可选。
	options: {
		// 必填来源名由调用者决定。
		source: string;
		// 可选范围可覆盖 temporary 默认值。
		scope?: SourceScope;
		// 可选来源形式可覆盖 top-level 默认值。
		origin?: SourceOrigin;
		// 可选基准目录，不做路径归一化。
		baseDir?: string;
		// 可选更新日志路径，使用和真实资源相同的条件展开规则。
		changelogPath?: string;
	},
): SourceInfo {
	// 创建新结果对象。
	return {
		// 保留传入标识。
		path,
		// 从 options 读取必填来源。
		source: options.source,
		// ?? 只在 null/undefined 时选 temporary，不按一般真值回退。
		scope: options.scope ?? "temporary",
		// origin 缺省选择顶层来源形式。
		origin: options.origin ?? "top-level",
		// 基准目录直接传递，可为 undefined。
		baseDir: options.baseDir,
		// 仅真值日志路径才加字段，其他输入元数据没有被整体展开进结果。
		...(options.changelogPath ? { changelogPath: options.changelogPath } : {}),
	};
}
