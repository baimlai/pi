// 给直接运行 TypeScript 源码的 Node 进程接上仓库别名：例如把包名导向 src，而不是误用旧 dist。
// 在 packages/coding-agent 目录运行 node --import ./src/experimental/source-resolver.ts ...；导入本文件就注册同步解析钩子，不必另调函数。
// existsSync 查候选是否存在，readFileSync 读根配置，statSync 确认候选为普通文件；这里是启动/模块解析阶段的同步 I/O。
import { existsSync, readFileSync, statSync } from "node:fs";
// registerHooks 是 Node 的进程内模块钩子 API；不是给 TypeScript 编译器安装插件。
import { registerHooks } from "node:module";
// extname 看后缀，resolve 得绝对路径，sep 是当前平台分隔符；不靠手写 '/' 拼 Windows 路径。
import { extname, resolve, sep } from "node:path";
// URL 与文件路径用专门函数转换，才能正确处理空格、百分号和平台路径。
import { fileURLToPath, pathToFileURL } from "node:url";

// Node strips TypeScript natively, but it does not apply the workspace source
// aliases from tsconfig.json. Internal source processes preload this resolver so
// they cannot silently fall through to stale package dist files.

// 这里只声明本文件会读取的配置字段；JSON.parse 后的 as 不会按此接口校验输入，也不支持 JSONC 注释。
interface TsConfig {
	// readonly 只限制 TS 中重赋值，? 表示可能没有 compilerOptions。
	readonly compilerOptions?: {
		// Record 把别名模式映射为候选路径数组；内外 readonly 都不是运行时冻结。
		readonly paths?: Readonly<Record<string, readonly string[]>>;
	};
}

// 预处理一个别名：例如 foo/* 对应 prefix='foo/'、suffix=''，替换项仍按配置次序尝试。
interface SourceAlias {
	// 保留完整模式用于精确匹配、排序和报错。
	readonly pattern: string;
	// '*' 之前固定不变的字符串；没有通配符时就是整个模式。
	readonly prefix: string;
	// '*' 之后固定不变的字符串；精确别名时为空串。
	readonly suffix: string;
	// 同一别名允许多个路径候选，这里复用配置数组，不复制/冻结。
	readonly replacements: readonly string[];
}

// 相对当前模块往上四层找到仓库，而非采用启动命令的 cwd；本入口因此依赖源码仓库布局。
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
// 只读这一份根配置，不合并 extends、其他 tsconfig 或包 exports。
const tsconfigPath = resolve(repositoryRoot, "tsconfig.json");
// 读文件/非法 JSON 会同步抛出；as TsConfig 只告诉 TS 如何使用结果，不验证 JSON 形状。
const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsConfig;
// ?. 在 compilerOptions 缺失时得到 undefined。
const paths = tsconfig.compilerOptions?.paths;
// 没有 paths 就立即终止预加载，避免本来要求源码的进程悄悄退回 dist。
if (!paths) throw new Error(`Source runtime requires compilerOptions.paths in ${tsconfigPath}`);

// 配置只处理一次；Object.entries 产生 [模式, 替换项]，链式 filter/map/sort 构造解析表。
const aliases: SourceAlias[] = Object.entries(paths)
	// 只接管此组织的包别名；例如根配置的 @acme/app/* 不进入本表。
	.filter(([pattern]) => pattern.startsWith("@earendil-works/"))
	// 解构每对键值；不从包名推断目录，始终使用 paths 写明的目标。
	.map(([pattern, replacements]) => {
		// indexOf 找不到返回 -1，0 则表示第一个字符就是 '*'。
		const wildcard = pattern.indexOf("*");
		// 本实现只替换一个通配片段，多 '*' 模式在启动时明确拒绝。
		if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
			// 配置错误的诊断保留原模式，便于定位。
			throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
		}
		// 对象字面量的同名字段可省略 ': pattern'；三元表达式区分精确和通配模式。
		return {
			// 完整模式不变。
			pattern,
			// slice 不包含结束索引，所以去掉 '*' 本身。
			prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
			// '*' 后一位起到结尾；无通配符时不再要求额外后缀。
			suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
			// 一个模式的候选顺序维持 tsconfig 原样。
			replacements,
		};
	})
	// 按整个模式字符串长度降序，不是完整复刻 TS 对各种路径模式的优先级规则。
	.sort((left, right) => right.pattern.length - left.pattern.length);

// 注册影响本进程后续解析的同步钩子；返回的注销句柄未保存，本文件没有提供解除入口。
registerHooks({
	/** 解析一次 import/require 的说明符；命中别名却没有源文件就抛错，完全不命中才交给 Node。例：@earendil-works/pi-ai → paths 候选 → file: URL。 */
	resolve(specifier, context, nextResolve) {
		// string | undefined 是联合类型；记录第一个命中的模式，之后用于解释失败原因。
		let matchedPattern: string | undefined;
		// 依排序逐一匹配；一个模式找不到文件仍可尝试后面的匹配模式。
		for (const alias of aliases) {
			// undefined 表示不匹配；空串却可以是成功的精确匹配或空通配内容。
			const wildcard = matchAlias(alias, specifier);
			// 严格比较保留空串这种合法结果，不能写成 if (!wildcard)。
			if (wildcard === undefined) continue;
			// ??= 仅在尚为 undefined/null 时赋值，不覆盖第一次命中的模式名。
			matchedPattern ??= alias.pattern;
			// 同一别名的路径候选按数组次序查找，找到首个普通文件即返回。
			for (const replacement of alias.replacements) {
				// 字符串 replace 在这里替换第一个 '*'；精确模式的 wildcard 是空串。
				const resolved = resolveSourcePath(replacement.replace("*", wildcard));
				// shortCircuit 表明本钩子已完成解析，不再要求调用下一级；返回的是 URL 而不是裸路径。
				if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
			}
		}
		// 有匹配别名就必须走源码；缺文件时不让 Node 退回已安装包的旧 dist。
		if (matchedPattern) {
			// 说明符和第一命中模式同时出现在错误里，不把缺文件假装为成功。
			throw new Error(`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`);
		}
		// node:fs、相对文件及未接管包继续使用其余解析链，context 原样转交。
		return nextResolve(specifier, context);
	},
});

/** 匹配一个模式并取出 '*' 对应文本；成功的精确匹配返回空串，失败返回 undefined，不读文件。例：foo/* + foo/a → 'a'。 */
function matchAlias(alias: SourceAlias, specifier: string): string | undefined {
	// 无 '*' 就做完整字符串相等比较；模式中的其他字符没有额外正则含义。
	if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
	// 通配只要求固定头尾匹配，没有另加头尾长度和检查，不是一般 glob 引擎。
	if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
	// slice 使用 UTF-16 索引取中间部分；允许空片段，不要求恰好一个目录层级。
	return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

/** 把配置替换项变成首个存在的普通文件绝对路径；无候选返回 undefined，stat 等 I/O 错误可抛。例：x.js 不存在时再试 x.ts。 */
function resolveSourcePath(replacement: string): string | undefined {
	// 相对目标基于仓库根；resolve 会消去 '..'，绝对目标则覆盖前面的根路径。
	const basePath = resolve(repositoryRoot, replacement);
	// 补末尾分隔符，防止 /repo-other 被误判为 /repo 内的路径。
	const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
	// 仅做路径字符串范围限制，根目录自身不匹配；没有 realpath，不能当作禁止软链逃出的沙箱。
	if (!basePath.startsWith(rootPrefix)) return undefined;
	// 后缀决定有限候选表；不遍历任意扩展名或 package.json 目录入口。
	const extension = extname(basePath);
	// .js/.mjs/.cjs 可分别补试 .ts/.mts/.cts；这里声明候选后缀，还没读取文件。
	const sourceExtension =
		// 嵌套三元从左到右选择一个结果，不匹配则 undefined。
		extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : undefined;
	// 注意原路径总在前；若 x.js 也存在，会优先用它而不是 x.ts。
	const candidates = sourceExtension
		? // slice 去掉旧后缀后拼源码后缀；不是把路径所有 '.js' 都替换。
			[basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`]
		: // 已明确写这四种后缀时，只尝试原文件。
			extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".json"
			? [basePath]
			: // 其他情况尝试本身、加 .ts、子目录 index.ts；并不补试 .tsx 或 index.mts。
				[basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
	// for...of 可提前返回，避免首候选成功后还做后面的同步 stat。
	for (const candidate of candidates) {
		// statSync 会跟随软链；exists 与 stat 之间仍可能文件变化，未用 try/catch 吞掉所有错误。
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	// 所有有限候选失败，由上层决定继续其他匹配模式还是报错。
	return undefined;
}
