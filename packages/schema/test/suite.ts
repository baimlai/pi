// 读取已入仓的第三方JSON-Schema-Test-Suite与官方meta-schema，返回测试描述及URI资源表；只同步读本地JSON，不启动localhost服务、不下载schema，不修改第三方数据。
// Loads the vendored JSON-Schema-Test-Suite: its test files, the remote documents and the official meta-schemas.

// 同步文件API适用于测试登记阶段：列目录、读UTF-8与判断目录；文件缺失/权限/JSON错误直接向调用方抛。
import { readdirSync, readFileSync, statSync } from "node:fs";
// join组合平台路径，relative生成fixture内资源名；稍后仅URI键显式把反斜线换斜线。
import { join, relative } from "node:path";
// JsonSchema是TS类型，不替JSON.parse结果自动作元规则校验。
import type { JsonSchema } from "../src/index.ts";

/** One test file: its path below `tests/` and its groups. */
// 每个SuiteFile描述一份测试JSON；接口仅供静态约束，运行数据直接来自仓库fixture。
export interface SuiteFile {
	// name相对tests目录且去掉.json，报告名保留draft子目录。
	readonly name: string;
	// draft只有两个字面量，来自下面明确映射，不让目录名draft7直接充当编译选项值。
	readonly draft: "2020-12" | "7";
	// readonly数组视图防止通过此声明写groups，不深冻JSON对象。
	readonly groups: readonly SuiteGroup[];
}

/** A schema with values and whether each is valid. */
// SuiteGroup是一条schema配多组输入的描述，并非运行时类。
export interface SuiteGroup {
	// 分组可读说明用于Vitest报告与已知失败身份匹配。
	readonly description: string;
	// 同组输入采用这份JsonSchema，未在读取时编译。
	readonly schema: JsonSchema;
	// 每输入有说明/任意unknown数据/规范valid布尔值；只读类型不代替wire校验，此处信任入仓测试数据。
	readonly tests: readonly { readonly description: string; readonly data: unknown; readonly valid: boolean }[];
}

// import.meta.dirname按当前模块位置定位fixture，命令从其他cwd启动也能找对目录。
const fixtures = join(import.meta.dirname, "fixtures");
// 第三方测试套件根在fixtures/json-schema-test-suite，和meta-schemas目录分开。
const root = join(fixtures, "json-schema-test-suite");

/** Every test file of drafts 2020-12 and 7. */
// suiteFiles同步遍历两版测试JSON，返回新数组。例路径tests/draft7/type.json变报告名draft7/type；会读文件/解析JSON，错误不吞，未执行compile。
export function suiteFiles(): SuiteFile[] {
	// 空的SuiteFile[]收集本次结果，不缓存上次数组或深冻结内容。
	const files: SuiteFile[] = [];
	// for解构每个[目录名,draft值]元组，避免把目录名和选项值混淆。
	for (const [dir, draft] of [
		// draft2020-12目录映到选项"2020-12"。
		["draft2020-12", "2020-12"],
		// draft7目录映到"7"。
		["draft7", "7"],
		// as const保留只读元组与精确字面量类型，不在运行时冻结。
	] as const) {
		// jsonFiles递归返回目录下.json路径，包含optional子目录，不解析或过滤关键字语义。
		for (const path of jsonFiles(join(root, "tests", dir))) {
			// relative得到tests内相对路径，正则\.json$只去末尾扩展名；这里未像URI键那样统一路径分隔符。
			const name = relative(join(root, "tests"), path).replace(/\.json$/, "");
			// 同步读文本再JSON.parse为新对象放groups；上下文类型只约束使用，不会验证数据是否真符合SuiteGroup[]。
			files.push({ name, draft, groups: JSON.parse(readFileSync(path, "utf8")) });
		}
	}
	// 返回本次数组，后续编译/测试由conformance.test.ts负责。
	return files;
}

/** The remote documents and meta-schemas the tests reference, by URI (fresh copies). */
// suiteSchemas按测试所用URI登记本地remotes/meta文件，返回每次新解析资源表。例http://localhost:1234/integer.json→本地remotes/integer.json内容；不联网，坏路径/JSON直接抛错。
export function suiteSchemas(): Record<string, JsonSchema> {
	// 普通对象作URI→schema表，不是启动HTTP路由器。
	const schemas: Record<string, JsonSchema> = {};
	// remotes目录含测试引用资源，不是远程主机地址。
	const remotes = join(root, "remotes");
	// 递归取本地所有.json资源。
	for (const path of jsonFiles(remotes)) {
		// relative转资源相对名再把反斜线换/，拼测试约定localhost URI；readJson从本机读内容，不向1234端口请求。
		schemas[`http://localhost:1234/${relative(remotes, path).replaceAll("\\", "/")}`] = readJson(path);
	}
	// 官方meta-schema文件在旁边另一fixture目录；来源/许可见其README.md，正文保留原样。
	const meta = join(fixtures, "meta-schemas");
	// 为draft7规范URI登记本地官方meta-schema。
	schemas["http://json-schema.org/draft-07/schema"] = readJson(join(meta, "draft-07-schema.json"));
	// 为2020-12规范URI登记对应本地文件。
	schemas["https://json-schema.org/draft/2020-12/schema"] = readJson(join(meta, "draft2020-12-schema.json"));
	// 七个词汇文档逐项登记，不动态下载URI对应内容。
	for (const vocabulary of [
		// core描述基础资源/标识相关关键词。
		"core",
		// applicator描述组合和子schema应用关键词。
		"applicator",
		// unevaluated是尚未被其他规则覆盖的位置相关词汇。
		"unevaluated",
		// validation描述type/长度/范围等断言关键词。
		"validation",
		// meta-data描述标题/说明等元信息关键词。
		"meta-data",
		// format-annotation描述格式作为注解；登记文档不等于运行时启用全部格式断言。
		"format-annotation",
		// content描述内容类型/编码等关键词，当前校验器对这些主要作注解。
		"content",
	]) {
		// 模板字符串按词汇名造规范URI键，并读取对应本地文件。
		schemas[`https://json-schema.org/draft/2020-12/meta/${vocabulary}`] = readJson(
			// 本地文件名也按同一词汇名拼接，不从URI自动推请求或写文件。
			join(meta, `draft2020-12-meta-${vocabulary}.json`),
		);
	}
	// 返回完整新表；对象/JSON子内容可变，调用方自行遵守不修改的约定。
	return schemas;
}

// readJson读取指定本地路径的UTF-8 JSON并返回解析值；类型标注不验证规则有效性，IO/语法错误直接抛，例用于remotes和meta文件。
function readJson(path: string): JsonSchema {
	// 两层调用先readFileSync再JSON.parse，没有catch兜底成空schema。
	return JSON.parse(readFileSync(path, "utf8"));
}

// jsonFiles递归收集目录下小写.json文件，返回绝对/组合路径列表；每层排序稳定遍历，stat会跟随符号链接，无访问集防任意目录环，目标是受控fixture树。
function jsonFiles(dir: string): string[] {
	// 每次递归创建独立结果数组，子结果再合并，不修改磁盘。
	const out: string[] = [];
	// readdirSync列当前层名字，sort默认按JS字符串顺序排序，不是按文件修改时间。
	for (const entry of readdirSync(dir).sort()) {
		// join把当前目录和单个名字拼完整路径。
		const path = join(dir, entry);
		// statSync跟随链接读目标类型；目录则递归，...把子列表逐项追加，不把列表嵌套成二维数组。
		if (statSync(path).isDirectory()) out.push(...jsonFiles(path));
		// 非目录且名字以小写.json结尾才保留，LICENSE/README等跳过；未额外要求stat.isFile。
		else if (entry.endsWith(".json")) out.push(path);
	}
	// 返回按深度优先、各层名字有序的JSON路径，不先parse每个文件。
	return out;
}
