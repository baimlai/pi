// 从package.json里读取pi资源声明，供包管理器/扩展加载器发现入口；只解析文字与字段形状，不加载资源、不授予项目信任。
import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

// 可选路径/模式列表及变更日志路径；本接口只描述被接受字段，字段字符串是否存在、越过包根或可执行由后续消费者决定。
export interface PiManifest {
	// 扩展入口列表；读取本字段本身不会导入TypeScript/JavaScript代码。
	extensions?: string[];
	// 技能、提示词、主题分别由对应加载流程展开/解析，不在此解释glob或Markdown。
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	// 单独的日志路径，空字符串也属于本函数接受的字符串，实际可用性留给下游。
	changelogPath?: string;
}

// as const把数组推导为只读字面量元组，循环的field类型因此是这四个键的联合，而不是任意string。
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

// 输入未知JSON值，返回是否非null且非数组的对象；类型谓词使通过分支能按字符串读取未知字段。
// 例如{}通过、[]/null失败；只是浅层对象判断，不要求特定原型或任何资源字段存在，无I/O。
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 输入package.json路径，同步读取去BOM并解析pi对象，返回保留有效字段的新manifest；无pi/形状错误/读取解析异常返回null。
// 例如pi:{skills:"bad",prompts:["./prompts"]}忽略skills但保留prompts；pi:{}返回{}，不同于没有有效pi对象的null。
// 每个资源字段必须整组都是字符串才接受，不逐项过滤；无默认目录填充、不规范路径、不检查权限或验证包可信。
export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		// unknown要求在访问外部JSON属性前确认形状，as或接口本身不能代替运行时判断。
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		// &&/||短路保证pkg先是对象才读pkg.pi；pi字段本身也必须为对象。
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		// 创建结果对象，忽略package.json其余字段和pi中未列出的键，不修改解析出的pkg。
		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.pi[field];
			// Array.isArray及every是JSON信任边界校验；空数组every为true，因此可显式声明无该资源。
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				// 保留该数组引用，未深复制/冻结；整个pkg仅来自本次解析，不与磁盘内容自动同步。
				manifest[field] = entries;
			}
		}

		// 日志字段独立校验，资源列表无效不会连带丢弃有效日志路径。
		const changelogPath = pkg.pi.changelogPath;
		if (typeof changelogPath === "string") {
			manifest.changelogPath = changelogPath;
		}

		// 可为空对象，调用者还需决定是否用约定目录等回退规则。
		return manifest;
	} catch {
		// 捕获文件读取、JSON解析和本函数处理期间的异常，不把坏清单升级为启动崩溃。
		return null;
	}
}
