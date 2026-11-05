// 查非声明.ts源码里的相对.js导入，包含类型导入和字面量动态导入；借TypeScript AST准确定位，配合仓库直接使用.ts源码的约定，不自动改路径。
// Dirent目录读取用于收集待查TS源码，默认不跟随目录符号链接。
import { readdirSync } from "node:fs";
// join拼子路径，resolve统一绝对配置/源码名，relative生成便于阅读的诊断路径。
import { join, relative, resolve } from "node:path";
// SyntaxKind.ImportKeyword用来区分import("x")调用和普通函数调用。
import { SyntaxKind } from "typescript/unstable/ast";
// 导入AST节点判别器，检查的是语法结构，不执行任何被查模块。
import {
	// 识别调用表达式。
	isCallExpression,
	// 识别重导出语句。
	isExportDeclaration,
	// 识别静态import语句。
	isImportDeclaration,
	// 识别TS类型位置的import("x").T语法。
	isImportTypeNode,
	// 识别类型节点中的字符串字面量包装。
	isLiteralTypeNode,
	// 识别无${...}插值的反引号文字。
	isNoSubstitutionTemplateLiteral,
	// 识别单双引号字符串节点。
	isStringLiteral,
} from "typescript/unstable/ast/is";
// 同步TypeScript API提供项目/AST，后面只做语法遍历，不调用完整语义类型检查。
import { API } from "typescript/unstable/sync";

// 这些同名目录不递归；并非读取.gitignore或只扫描Git跟踪文件。
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
// 外层数组收集源码路径，const仍允许push/sort。
const files = [];

// 递归收directory下普通.ts且非.d.ts的文件，把路径追加外层files。例src/a.ts进入检查、src/a.d.ts不进；读目录失败会抛，无IO异常兜底/最大深度限制。
function collectTypescriptFiles(directory) {
	// withFileTypes给Dirent，for...of逐个访问目录项。
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		// 真实目录才走递归分支，不把符号链接目录当普通目录跟随。
		if (entry.isDirectory()) {
			// 精确目录名命中Set就不深入。
			if (!ignoredDirectories.has(entry.name)) {
				// 对组合后的子目录继续收集，递归完成才返回当前循环。
				collectTypescriptFiles(join(directory, entry.name));
			}
			// 目录项处理完直接下一项，不再走普通文件判断。
			continue;
		}

		// 只收真实普通.ts文件，排.d.ts；tsx/mts/cts不在本脚本的文件后缀条件里。
		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			// 追加文件路径，此阶段不读取AST或导入其中代码。
			files.push(join(directory, entry.name));
		}
	}
}

// 判断可直接取固定文本的节点，例单双引号或无插值模板都可；undefined安全返回false，包含插值的模板表达式不接受，无副作用。
function isStringLiteralLike(node) {
	// &&短路避免对undefined继续辨认节点，括号里的||允许两种字面量形状。
	return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node));
}

// 判断./或../开头且以.js（可跟?/#后缀）结束的说明符，例../a.js?raw命中，包名pkg/a.js不命中；只做文本匹配，不确认目标存在或自动改为.ts。
function isRelativeJavaScriptSpecifier(specifier) {
	// 两份正则都需通过；区分相对前缀和.js后缀，不把所有包含.js的文字都当违规。
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

// 从ImportTypeNode取固定模块文字，例type T=import("./a.js").T返回字符串节点。不是执行动态import，不支持任意非字面量参数，不会调用运行时模块加载。
function getImportTypeSpecifier(node) {
	// 类型参数先要为LiteralTypeNode，否则直接undefined，防把其他类型语法强当字符串。
	if (!isLiteralTypeNode(node.argument)) return undefined;
	// 其中literal还需是可取固定文本的两种节点。
	if (!isStringLiteralLike(node.argument.literal)) return undefined;
	// 返回AST子节点供定位，非返回模块实例/文本解析结果。
	return node.argument.literal;
}

// 跨文件汇总违规项，一份文件多处引用会记录多条，不按包/路径去重。
const failures = [];

// 从调用者cwd的.开始扫，不自动把根设为脚本所在目录。
collectTypescriptFiles(".");

// Parse every file through one synthetic project. noResolve keeps the program to exactly these files.
// 给虚拟项目一个绝对配置路径作为API识别键，不在磁盘写tsconfig文件。
const configPath = resolve("tsconfig.check-ts-relative-imports.json");
// 把合成配置序列化成JSON文字供虚拟FS读取。
const config = JSON.stringify({
	// noResolve不继续沿import扩展程序文件集，noLib和types:[]不主动载标准库/全局类型；本检查只关心已收文件的语法。
	compilerOptions: { noResolve: true, noLib: true, types: [] },
	// 明确files列表用绝对路径，让程序源码范围对应前面收集的.ts文件。
	files: files.map((file) => resolve(file)),
});
// 创建同步API客户端，不是tsc命令行编译输出，没有生成dist。
const api = new API({
	// 当前工作目录采用调用者cwd，虚拟配置路径和扫描根保持一致。
	cwd: process.cwd(),
	// FS只覆盖这一个虚拟配置，源码仍由真实文件系统读取，不是完全隔离内存盘。
	fs: {
		// 仅配置路径回答存在true，其他undefined表示回默认FS，不是回答文件不存在。
		fileExists: (fileName) => (resolve(fileName) === configPath ? true : undefined),
		// 仅配置路径提供JSON内容，其他undefined仍回真实FS，避免把源码也误变成空文件。
		readFile: (fileName) => (resolve(fileName) === configPath ? config : undefined),
	},
});

// 快照/遍历放try里，finally关闭API；构造API本身失败不在这段finally范围。
try {
	// 一次打开虚拟项目并取program；代码假定getProject成功，没有检查undefined或把失败装成通过。
	const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
	// 按路径排序后逐个检查，sort会改files数组本身，不改变源码。
	for (const file of files.sort()) {
		// 按绝对路径从program拿SourceFile，后面用它取节点位置和递归子节点。
		const sourceFile = program.getSourceFile(resolve(file));

		// 对固定说明符检查文本规则并追加位置；例./tool.js报文件:行:列。闭包使用本轮sourceFile/file，没有IO或自动替换import路径。
		function checkSpecifier(node) {
			// 非目标相对.js直接返回，不要求其他所有导入都使用.ts。
			if (!isRelativeJavaScriptSpecifier(node.text)) return;
			// node.getStart略过节点前空白/注释，取0基行列，诊断再各加一。
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			// relative让文件路径相对cwd，模板附原说明符；一个节点命中就一条记录。
			failures.push(`${relative(".", file)}:${line + 1}:${character + 1}: ${node.text}`);
		}

		// 深度优先走AST，涵盖值导入、重导出、字面量动态import和类型import；不分析require/拼接目标，也不执行任何源码。
		function visit(node) {
			// 静态import的moduleSpecifier为固定字符串才检查，import type同样会检查，因为本规则同时约束类型引用路径。
			if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
				// 交助手检查这条import的模块文字及定位。
				checkSpecifier(node.moduleSpecifier);
			// export ... from的固定说明符同样检查，包含export type重导出。
			} else if (isExportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
				// 把导出模块节点交助手，不查询导出的符号是否实际使用。
				checkSpecifier(node.moduleSpecifier);
			// 其余节点尝试识别字面量动态import调用。
			} else if (
				// 先是调用表达式才能读expression/arguments。
				isCallExpression(node) &&
				// 调用目标必须ImportKeyword，require("./x.js")不在这个分支里。
				node.expression.kind === SyntaxKind.ImportKeyword &&
				// 只接第一个实参为固定字面量的调用；import(`./${name}.js`)不会猜它的可能值。
				isStringLiteralLike(node.arguments[0])
			) {
				// 检查该固定动态导入文字，不执行请求/模块加载。
				checkSpecifier(node.arguments[0]);
			// 类型位置的import("x").T有不同节点种类，需要单独识别。
			} else if (isImportTypeNode(node)) {
				// 用助手从类型字面量参数中取说明符节点。
				const specifier = getImportTypeSpecifier(node);
				// 找到才继续检查，缺失/非字面量类型参数不作违规记录。
				if (specifier) checkSpecifier(specifier);
			}

			// 递归所有语法子节点，函数内部的导入也不会因为不是顶层就漏过。
			node.forEachChild(visit);
		}

		// 从完整文件根节点开始遍历，不只检查imports字符串列表。
		visit(sourceFile);
	}
// 无论查完还是抛错，都进入API清理。
} finally {
	// 关闭快照/同步编译器客户端资源，不更改源码或虚拟配置对应的磁盘文件。
	api.close();
}

// 有违规才输出并失败退出，没有违规时此脚本默认静默成功。
if (failures.length > 0) {
	// 标题说明仅针对非声明.ts里的相对.js引用，别把它当任意JS模块禁用规则。
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	// 逐条输出位置和说明符，不做自动修复。
	for (const failure of failures) console.error(`  ${failure}`);
	// 立即退出码1供npm run check的&&链判定失败。
	process.exit(1);
}
