#!/usr/bin/env node
// 检查公开包发布源码的运行时导入是否声明依赖，并拦住被构建排除却又导入的源码；只读项目/AST、汇总诊断，不安装依赖或执行被查模块。

// 同步读取包清单/检测src和构建配置，脚本只检查声明，不安装依赖或改锁文件。
import { existsSync, readFileSync } from "node:fs";
// isBuiltin识别fs、node:fs等当前Node内置模块，避免把它们当npm依赖。
import { isBuiltin } from "node:module";
// resolve做绝对路径，relative判所属src，join组合清单路径，isAbsolute识别跨根的相对结果。
import { isAbsolute, join, relative, resolve } from "node:path";
// SyntaxKind是TypeScript语法节点种类常量，后面识别type声明和import调用关键字。
import { SyntaxKind } from "typescript/unstable/ast";
// 导入AST节点判别函数；它们辨认语法形状，不执行被检查文件中的代码。
import {
	// 识别调用表达式，如require("x")或import("x")。
	isCallExpression,
	// 识别export ... from等导出语句。
	isExportDeclaration,
	// 识别require这类标识符，不在此分析它是否被局部变量遮蔽。
	isIdentifier,
	// 识别静态import语句。
	isImportDeclaration,
	// 识别export {a,type B}的具名列表。
	isNamedExports,
	// 识别import {a,type B}的具名列表。
	isNamedImports,
	// 识别不含${...}插值的反引号字面量，可直接取得固定说明符。
	isNoSubstitutionTemplateLiteral,
	// 识别require.resolve这类点属性访问语法。
	isPropertyAccessExpression,
	// 识别单双引号字符串字面量，避免猜运行时拼接/插值的结果。
	isStringLiteral,
} from "typescript/unstable/ast/is";
// 同步TypeScript API向本机编译器服务读取项目/AST，后面finally关闭；不发模型请求，也不执行被查模块。
import { API } from "typescript/unstable/sync";
// 枚举packages目录下非private的包，包含其中嵌套包；不是根workspaces配置的所有apps，具体目录遍历看该helper。
import { getPublicWorkspacePackages } from "./release-packages.mjs";

// Packages without tsconfig.build.json are checked against a synthetic config.
// 没有tsconfig.build.json时给同步API提供这个虚拟配置名，不往磁盘创建文件。
const fallbackConfigName = "tsconfig.runtime-deps-fallback.json";
// 虚拟配置只包含src/**/*，相对每个虚拟配置所在包目录解释；未另注入所有根tsconfig编译选项。
const fallbackConfig = JSON.stringify({ include: ["src/**/*"] });
// 跨包汇总不合规项，最后统一报告，不发现首项就退出。
const failures = [];

// 检查一份AST的运行时依赖：建声明集合→遍历import/export/字面量加载→汇总缺声明。例源码import "only-dev"只在devDependencies会报错；不检查版本/实际包文件是否可解析，不运行源码。
function checkSource(source, manifest) {
	// 取TypeScript给的文件名用于诊断，保持其原拼写。
	const file = source.fileName;
	// Set便于按包根名查是否声明，不要求声明在唯一某一区。
	const declared = new Set([
		// 包自己的name允许自导入，例如example/subpath不用再声明自己。
		manifest.name,
		// dependencies的键允许运行时导入；??{}让缺省段按空表处理。
		...Object.keys(manifest.dependencies ?? {}),
		// optionalDependencies也算声明，即使当前平台未实际安装，不在此验证可用性。
		...Object.keys(manifest.optionalDependencies ?? {}),
		// peerDependencies由使用方提供，也算合法运行时声明；devDependencies没有加入。
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	// 检查一个固定模块名节点，缺节点/动态表达式忽略；例@scope/lib/sub先取@scope/lib再查声明。它只追加诊断，无模块加载或自动补依赖。
	function checkSpecifier(node) {
		// 仅字符串或无插值模板有固定text，import(prefix+name)等无法静态取得的目标不在此检查。
		if (!node || !(isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))) return;
		// node.text拿解析后的文字，不包含源文件两侧引号。
		const specifier = node.text;
		// `cloudflare:` modules are built into the Workers runtime, like `node:` modules are into Node.
		// 以下明确豁免相对/根斜杠/Workers内置/Node内置，不对所有路径做通用URL或平台解析。
		if (
			// 原样以.开头就跳过，包括./和../；不是验证每个这样的名字真为可解析相对导入。
			specifier.startsWith(".") ||
			// 以/开头当路径跳过，这里没有调用isAbsolute识别C:\这样的Windows说明符。
			specifier.startsWith("/") ||
			// cloudflare:由Workers运行时提供，无需npm包声明，不代表Node也能加载它。
			specifier.startsWith("cloudflare:") ||
			// 委托Node判断内置模块，包括部分不带node:前缀的写法。
			isBuiltin(specifier)
		) {
			// 命中豁免直接返回，不增加失败数组。
			return;
		}
		// 按/拆说明符，作用域包取前两段、普通包取第一段；例@scope/a/b→@scope/a，a/b→a。
		const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		// 声明集合已含包根名就通过，不核对子路径是否存在/对外导出。
		if (declared.has(name)) return;
		// 从节点起点取0基行号，依赖AST的source定位，不用字符串搜索猜第几行。
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		// 输出时+1成人类行号，保完整说明符和所属包名供定位。
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	// 递归访问AST：区分会留下运行时加载的import/export/调用，只把相应说明符交助手；例import type {T}会跳过依赖要求，但不阻止外层另查被排除源码是否被引入。
	function visit(node) {
		// 先处理静态import，包括只有副作用的import "x"。
		if (isImportDeclaration(node)) {
			// 有导入绑定时取得clause，副作用import没有clause。
			const clause = node.importClause;
			// ?.让缺clause时bindings也是undefined，具名/命名空间导入后面再分辨。
			const bindings = clause?.namedBindings;
			// 下面条件确定当前import是否需运行时依赖，||/&&短路按顺序保护字段访问。
			if (
				// 无clause的副作用导入必须查依赖，尽管没有局部变量。
				!clause ||
				// 整句import type则不需运行时依赖；phaseModifier读当前TypeScript AST表示，不是执行typeof判断。
				(clause.phaseModifier !== SyntaxKind.TypeKeyword &&
					// 有默认导入名则属于需要运行时加载的形状，例如import x from "x"。
					(clause.name ||
						// 没绑定列表也按运行时导入检查，不凭“未使用变量”推断会被擦除。
						!bindings ||
						// 命名空间导入等非NamedImports形状按运行时检查。
						!isNamedImports(bindings) ||
						// 空具名import {}仍执行模块加载，因此也检查声明。
						bindings.elements.length === 0 ||
						// 具名列表只要有一个非type成员就检查；import {type T}全type才免，some回调返回boolean。
						bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				// 把实际moduleSpecifier节点交助手，不在此执行或解析依赖包正文。
				checkSpecifier(node.moduleSpecifier);
			}
		// 整句export type跳过；普通export即使含type成员还需看下面列表。
		} else if (isExportDeclaration(node) && !node.isTypeOnly) {
			// 具名导出列表、export *等形状在后续条件区分。
			const clause = node.exportClause;
			if (
				// 无exportClause的export * from按运行时导出检查。
				!clause ||
				// export * as ns等非NamedExports也检查。
				!isNamedExports(clause) ||
				// export {} from虽空列表仍要求模块运行时可用。
				clause.elements.length === 0 ||
				// 列表里任一个值导出就需要依赖，全type成员才豁免。
				clause.elements.some((element) => !element.isTypeOnly)
			) {
				// 本地export {value}没有moduleSpecifier，助手会直接忽略，不虚构外部包。
				checkSpecifier(node.moduleSpecifier);
			}
		// 其他语法分支尝试识别字面量运行时加载，而不是查所有普通函数参数字符串。
		} else if (
			// 必须先是CallExpression，之后才能读expression/arguments。
			isCallExpression(node) &&
			// import("pkg")使用ImportKeyword调用节点，不同于上面的静态ImportDeclaration。
			(node.expression.kind === SyntaxKind.ImportKeyword ||
				// 标识符拼写require就匹配，不查其是否来自Node或被同名局部函数遮蔽。
				(isIdentifier(node.expression) && node.expression.text === "require") ||
				// 点访问必须完整源码文字严格require.resolve；有空格/注释的其他拼写或别名不保证匹配，不做符号解析。
				(isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			// 仅查第一个实参，固定字面量才进入助手；没有实参或运行时拼接目标跳过。
			checkSpecifier(node.arguments[0]);
		}
		// 继续递归所有语法子节点，嵌套函数里的懒加载也会查，不只扫文件顶层。
		node.forEachChild(visit);
	}
	// 从整个SourceFile开始递归，不执行它的顶层表达式。
	visit(source);
}

// 枚举非private包，为后面每包构建项目数据；helper默认根是packages，并非遍历所有Git文件。
const packages = getPublicWorkspacePackages()
	// 对象解构取directory，生成包路径和绝对src目录的新包装对象。
	.map(({ directory }) => ({ directory, sourceDirectory: resolve(directory, "src") }))
	// 没有src路径的包不进入运行时源码检查，存在性不保证它一定是正常目录结构。
	.filter(({ sourceDirectory }) => existsSync(sourceDirectory))
	// 再逐包读取manifest并选择构建配置。
	.map(({ directory, sourceDirectory }) => {
		// 以包为根找到tsconfig.build.json绝对路径。
		const configPath = resolve(directory, "tsconfig.build.json");
		return {
			// 保存src边界，后面过滤编译器因跨包依赖带入的其他源码。
			sourceDirectory,
			// UTF-8读包清单并JSON.parse，坏JSON直接抛，不改清单字段。
			manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
			// 真实构建配置存在就使用，否则使用合成配置路径，只供虚拟FS回调识别。
			configPath: existsSync(configPath) ? configPath : resolve(directory, fallbackConfigName),
		};
	});

// 汇总所有合成配置路径集合，用于API只覆盖这些文件的存在/内容。
const fallbackConfigs = new Set(
	// endsWith按约定名字筛合成配置，不遍历磁盘去创建对应文件。
	packages.map(({ configPath }) => configPath).filter((path) => path.endsWith(fallbackConfigName)),
);
// 建同步编译器API客户端，配置FS回调只覆盖虚拟配置，其他文件仍交真实FS。
const api = new API({
	// 编译器的工作目录采用调用者当前目录，不固定为此脚本所在仓库。
	cwd: process.cwd(),
	// 自定义文件系统回调是覆盖层，不是完整隔离的纯内存文件系统。
	fs: {
		// 合成配置回答存在true，其他回答undefined表示回到真实FS，而不是不存在false。
		fileExists: (fileName) => (fallbackConfigs.has(resolve(fileName)) ? true : undefined),
		// 合成配置返回JSON文字；undefined仍回真实FS，null才是明确不存在，三者含义不同。
		readFile: (fileName) => (fallbackConfigs.has(resolve(fileName)) ? fallbackConfig : undefined),
	},
});
// try保护项目快照/遍历，后面关闭API；构造API本身若抛错不在此finally内。
try {
	// 一次更新打开所有包项目的快照，再按configPath取每份项目，减少反复初始化。
	const snapshot = api.updateSnapshot({ openProjects: packages.map(({ configPath }) => configPath) });
	// 解构每包的src/manifest/config，仍保持三者属于同一包。
	for (const { sourceDirectory, manifest, configPath } of packages) {
		// 按绝对配置路径取项目；此脚本假定API成功建了项目，没有缺失分支兜底。
		const project = snapshot.getProject(configPath);
		// 这里只取构建配置解析诊断，不执行完整类型检查的所有semantic diagnostics。
		const diagnostics = project.program.getConfigFileParsingDiagnostics();
		// 配置有任意诊断就合并文字抛错，防在不完整构建集合上继续给出“通过”。
		if (diagnostics.length > 0) throw new Error(diagnostics.map((diagnostic) => diagnostic.text).join("\n"));
		// rootFiles是include/exclude等配置得到的起点文件集合，路径resolve用于和后面名字统一比较。
		const roots = new Set(project.rootFiles.map((file) => resolve(file)));
		// program的全部源文件还包含从root导入带进来的文件，所以不能只遍历roots就断言exclude有效。
		for (const fileName of project.program.getSourceFileNames()) {
			// 声明文件和JSON资产不检查运行时导入/排除重新带入，JSON允许在TS include外随导入进入。
			if (fileName.endsWith(".d.ts") || fileName.endsWith(".json")) continue;
			// 算文件相对本包src的路径；不把跨包编译器依赖当本包待发布源码。
			const path = relative(sourceDirectory, resolve(fileName));
			// 原样前缀..或相对结果为绝对路径就跳过；不是精确按第一个目录组件判..，例如..foo.ts也会命中前缀。
			if (path.startsWith("..") || isAbsolute(path)) continue;
			// TypeScript's exclude only filters roots: imports can pull excluded files
			// back into the build. Reject that too, including type-only imports.
			// 在本包src却不是root的源码可能被import重新带入，既有type-only import也会触发这个构建边界检查。
			if (!roots.has(resolve(fileName))) {
				// 记录“排除但可达”，随后仍继续查它的运行时依赖，不因为已经有一个错误就漏查。
				failures.push(`${fileName} is excluded from ${manifest.name}'s build but imported by it`);
			}
			// 取此文件AST走checkSource；假定getSourceFile对已枚举文件能返回对象，不验证任意损坏API结果。
			checkSource(project.program.getSourceFile(fileName), manifest);
		}
	}
// 成功或异常都走清理，不把异常吞成成功。
} finally {
	// 关闭同步API及其快照/客户端资源，不删除源文件或更改依赖。
	api.close();
}

// 有汇总失败项才进入非零退出，配置解析等直接throw错误另走Node异常退出。
if (failures.length > 0) {
	// 错误标题写stderr。
	console.error("Undeclared runtime imports in public packages:");
	// 逐条输出位置/说明符等，未自动增依赖或修构建配置。
	for (const failure of failures) console.error(`  ${failure}`);
	// 立即exit1，让npm run check的&&链停止后续步骤。
	process.exit(1);
}
// 没有失败才输出成功信息，仅说明本检查通过，不等同完整编译/测试通过。
console.log("Public package runtime imports have declared dependencies.");
