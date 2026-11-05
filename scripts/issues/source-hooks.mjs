// 文件导读
// 所属：仓库根 scripts/issues/ 的 Node 模块解析钩子，由 register.mjs 通过 node:module register() 注册。
// 职责：把工作区包（packages/* 与 node_modules/@earendil-works/*）中 dist/*.js 的解析结果改到对应 src/*.ts，
//   使 issue triage 工具无需先构建 packages 就能直接运行。
// 能力：把工作区包 dist/*.js 的模块解析重定向到已存在的 src/*.ts。
// 上游：scripts/issues/register.mjs（run.sh 以 --import 预加载）。
// 下游：Node 的 ESM 解析器调用导出的 resolve 钩子；只做路径映射，不读取/编译源码内容。
// 输入：resolve(specifier, context, nextResolve) 由 Node 传入。输出：模块解析结果 {url, format, shortCircuit}。
// 副作用：只读文件系统（existsSync/realpathSync），无网络、无写文件。
// 失败：无法映射时保留 nextResolve 的原结果或原错误；不吞掉包解析问题。
// 示例：node --import ./scripts/issues/register.mjs scripts/issues/main.ts
// 建议阅读顺序：DIST_JS 正则 → toSource 的路径映射 → resolve 的正常/异常两条分支。
// 这是 Node 模块解析钩子，只改变工作区 dist/*.js 到现有 src/*.ts 的解析；不会编译源码或重写 import 字符串。
// Resolve workspace packages to their TypeScript sources, so the triage tool runs without building packages.
// A package without a "source" export condition (pi-ai) resolves to dist/*.js; this maps it to src/*.ts.
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// 正则捕获包根与 dist 下相对路径；仅匹配 packages 或指定组织 node_modules 的 .js 结尾 URL 路径。
const DIST_JS = /(\/(?:packages|node_modules\/@earendil-works)\/[^/]+)\/dist\/(.+)\.js$/;

// 输入可缺省的模块 URL，返回能找到的源码 file URL 或 undefined；只查文件，不读取执行源码。
// 例如 packages/pi-ai/dist/types.js 可映射到 src/types.ts；第三方普通 node_modules 路径保持原解析。
function toSource(url) {
	// ?. 可选链允许 url 缺失；非 file URL 直接跳过。
	if (!url?.startsWith("file:")) return undefined;
	// 把 file URL 转成本机路径以检查目录和文件存在性，非法 URL 仍可能抛错。
	const path = fileURLToPath(url);
	// 普通第三方依赖不映射；只放行指定组织的 node_modules 包路径。
	if (path.includes("/node_modules/") && !path.includes("/node_modules/@earendil-works/")) return undefined;
	// 不符合 dist JS 形状就没有可替换的源码路径。
	if (!DIST_JS.test(path)) return undefined;
	// $1/$2 引用正则捕获组，把 dist 目录与 .js 后缀替换为 src 与 .ts。
	const source = path.replace(DIST_JS, "$1/src/$2.ts");
	// 源码不存在时返回 undefined，交给原解析结果或原错误处理。
	if (!existsSync(source)) return undefined;
	// Real path: Node refuses to strip types under node_modules.
	// realpathSync 解开工作区软链接，避免实际仍在 node_modules 下而被 Node 拒绝剥离类型。
	return pathToFileURL(realpathSync(source)).href;
}

// Node 异步 resolve 钩子输入说明符、解析上下文和下一个钩子；返回模块解析结果，必要时改成 TS 源码。
// 正常路径：先让 nextResolve 解析；若结果指向可映射的 dist 文件则替换。异常路径：解析失败但错误带 url 且源码存在时短路。
export async function resolve(specifier, context, nextResolve) {
	// result 稍后接收下游解析结果，保持传回对象中的其他字段。
	let result;
	try {
		// 先遵守 Node/已有钩子的原始解析规则，await 其结果。
		result = await nextResolve(specifier, context);
	} catch (error) {
		// 失败时尝试使用错误对象上的 url 恢复；不是每种错误都有该字段。
		const source = toSource(error?.url);
		// shortCircuit 表示本钩子完成解析；module-typescript 要求 Node 以可剥离 TS 类型的模块加载。
		if (source) return { url: source, format: "module-typescript", shortCircuit: true };
		// 没有可恢复源码就保留真实原错误，不吞掉包解析问题。
		throw error;
	}
	// 成功解析后仍检查是否可以把 dist 文件换成源码。
	const source = toSource(result.url);
	// 存在源码返回新 TS 定位，否则直接返回下游原对象。
	return source ? { url: source, format: "module-typescript", shortCircuit: true } : result;
}
