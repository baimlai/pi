// 这是 Node 模块解析钩子，只改变工作区 dist/*.js 到现有 src/*.ts 的解析；不会编译源码或重写 import 字符串。
// Resolve workspace packages to their TypeScript sources, so the triage tool runs without building packages.
// A package without a "source" export condition (pi-ai) resolves to dist/*.js; this maps it to src/*.ts.
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// 正则捕获包根与 dist 下相对路径；仅匹配 packages 或指定组织 node_modules 的 .js 结尾URL路径。
const DIST_JS = /(\/(?:packages|node_modules\/@earendil-works)\/[^/]+)\/dist\/(.+)\.js$/;

// 输入可缺省的模块URL，返回能找到的源码file URL或undefined；只查文件，不读取执行源码。
// 例如 packages/pi-ai/dist/types.js 可映射到 src/types.ts；第三方普通node_modules路径保持原解析。
function toSource(url) {
	// ?. 可选链允许url缺失；非file URL直接跳过。
	if (!url?.startsWith("file:")) return undefined;
	// 把file URL转成本机路径以检查目录和文件存在性，非法URL仍可能抛错。
	const path = fileURLToPath(url);
	// 普通第三方依赖不映射；只放行指定组织的node_modules包路径。
	if (path.includes("/node_modules/") && !path.includes("/node_modules/@earendil-works/")) return undefined;
	// 不符合dist JS形状就没有可替换的源码路径。
	if (!DIST_JS.test(path)) return undefined;
	// $1/$2引用正则捕获组，把dist目录与.js后缀替换为src与.ts。
	const source = path.replace(DIST_JS, "$1/src/$2.ts");
	// 源码不存在时返回undefined，交给原解析结果或原错误处理。
	if (!existsSync(source)) return undefined;
	// Real path: Node refuses to strip types under node_modules.
	// realpathSync解开工作区软链接，避免实际仍在node_modules下而被Node拒绝剥离类型。
	return pathToFileURL(realpathSync(source)).href;
}

// Node异步resolve钩子输入说明符、解析上下文和下一个钩子；返回模块解析结果，必要时改成TS源码。
// 例如原dist文件缺失但错误带url且对应src存在，就短路返回源文件；其他解析错误原样重抛。
export async function resolve(specifier, context, nextResolve) {
	// result稍后接收下游解析结果，保持传回对象中的其他字段。
	let result;
	try {
		// 先遵守Node/已有钩子的原始解析规则，await其结果。
		result = await nextResolve(specifier, context);
	} catch (error) {
		// 失败时尝试使用错误对象上的url恢复；不是每种错误都有该字段。
		const source = toSource(error?.url);
		// shortCircuit表示本钩子完成解析；module-typescript要求Node以可剥离TS类型的模块加载。
		if (source) return { url: source, format: "module-typescript", shortCircuit: true };
		// 没有可恢复源码就保留真实原错误，不吞掉包解析问题。
		throw error;
	}
	// 成功解析后仍检查是否可以把dist文件换成源码。
	const source = toSource(result.url);
	// 存在源码返回新TS定位，否则直接返回下游原对象。
	return source ? { url: source, format: "module-typescript", shortCircuit: true } : result;
}
