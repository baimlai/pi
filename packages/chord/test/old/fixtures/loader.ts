// Runs the node loader outside vitest: its module runner bypasses the Node resolve hooks the loader installs.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bool, obj, str } from "@earendil-works/pi-schema";
import { createHost, local, method } from "../../../src/old/index.ts";
import { nodeLoader } from "../../../src/old/loader.ts";

// Plugin modules live under the package so bare imports (pi-schema) resolve; removed afterwards.
// 用进程 PID 隔离测试临时目录；new URL 相对本文件定位，fileURLToPath 转为文件系统路径。
const dir = fileURLToPath(new URL(`../.tmp-plugins-${process.pid}/`, import.meta.url));
// Separate from `dir`, which becomes a reload root once its facet loads.
// 第二组独立根目录验证跨 facet 的相对导入共享，避免与第一组重载根混淆。
const plugins = fileURLToPath(new URL(`../.tmp-plugins-${process.pid}-order/`, import.meta.url));
// 生成可直接写入测试模块 import 的 file URL；这里只保存字符串，不加载模块。
const chord = new URL("../../../src/old/index.ts", import.meta.url).href;

// The test's own copy of the plugin's contract: binding is by description, not object identity.
// 测试端自建契约，名字/版本/schema 与临时模块一致。它们并非同一对象，绑定按描述判定。
const Hello = local("t.hello", {
	// 固定第一版契约，测试改变代码而不是改变接口版本。
	version: 1,
	// 没有声明业务输入字段，测试用空对象取得同一个本地实例。
	input: obj({}, { open: true }),
	// greet 接受并返回字符串；只是声明签名，实现在下面临时 facet 模块里。
	members: { greet: method(str(), str()) },
});

// 以下模板内容是要写入磁盘的真实 TypeScript 源码，保持原样。
// 它相对导入 greeting.ts 并注册 Hello；greet("x") 将返回 greeting 加空格再加 x。
const facetSource = `
import { obj, str } from "@earendil-works/pi-schema";
import { defineFacet, local, method } from ${JSON.stringify(chord)};
import { greeting } from "./greeting.ts";

const Hello = local("t.hello", {
	version: 1,
	input: obj({}, { open: true }),
	members: { greet: method(str(), str()) },
});

export default defineFacet((host) => {
	host.serve(Hello, () => ({ greet: (name) => greeting + " " + name }));
});
`;

// 接收可信测试字符串，覆盖 greeting.ts 的导出；例如 "v2" 生成导出 v2 的模块。
// JSON.stringify 转义值为 JS 字符串字面量，writeFileSync 会同步写磁盘并可能抛出文件系统错误。
const writeGreeting = (text: string) =>
	// 结尾换行属于生成模块正文；此处不修改模板文本，以免改变加载器测试输入。
	writeFileSync(`${dir}greeting.ts`, `export const greeting = ${JSON.stringify(text)};\n`);

// 不管中途断言或 I/O 是否失败，finally 都会删除本夹具创建的两个目录。
try {
	// 递归创建临时插件根目录；不覆盖仓库中的已有插件。
	mkdirSync(dir, { recursive: true });
	// 把上面保留的模块源码写到 facet.ts。
	writeFileSync(`${dir}facet.ts`, facetSource);
	// 准备第一版依赖内容。
	writeGreeting("v1");
	// 注入 nodeLoader，让 host.load 能以模块路径加载 facet；错误报告在本夹具中忽略。
	const host = createHost({ self: { kind: "host" }, loader: nodeLoader, onError: () => {} });
	// 等待模块被解析、加载、注册后继续，不直接执行 greet。
	await host.load([`${dir}facet.ts`]);
	// hold 立即返回 Hello 引用；方法调用会等待就绪。
	const ref = host.hold(Hello, {});
	// 验证第一版相对导入被实际用于方法结果。
	assert.equal(await ref.greet("x"), "v1 x");
	// 只改依赖文件，不改 facet 源码或契约。
	writeGreeting("v2");
	// 重载同一路径，Node 加载器应重新求值它的相对依赖，产生新实现。
	const report = await host.reload([`${dir}facet.ts`]);
	// 重载报告应指出 Hello 类型发生变化。
	assert.deepEqual(report.changed, ["t.hello"]);
	// 原引用读到新依赖，证明重载没有复用旧 greeting 模块缓存。
	assert.equal(await ref.greet("x"), "v2 x");
	// 先结束第一组主机，释放加载器持有的运行资源。
	await host.close();

	// A facet listed first that imports a later facet's directory shares that facet's copy of the module.
	// 第二组契约只暴露 same():boolean，用来检测导入对象是否严格相同。
	const Shared = local("t.shared", {
		// 契约版本固定，不把模块共享问题混入接口兼容测试。
		version: 1,
		// 同样使用无业务输入的本地对象。
		input: obj({}, { open: true }),
		// method(undefined,bool()) 表示无业务参数、返回布尔结果。
		members: { same: method(undefined, bool()) },
	});
	// 创建先加载的 facet a 的根目录。
	mkdirSync(`${plugins}a`, { recursive: true });
	// 创建后加载的 facet b 的根目录。
	mkdirSync(`${plugins}b`, { recursive: true });
	// b 的 state 导出一个对象；本测试比较这个对象引用，而不是比较其字段。
	writeFileSync(`${plugins}b/state.ts`, "export const state = {};\n");
	// 写 b 模块：导出 own=state，并声明一个空 facet。下方字符串保持真实测试输入。
	writeFileSync(
		`${plugins}b/facet.ts`,
		`import { defineFacet } from ${JSON.stringify(chord)};\nimport { state } from "./state.ts";\nexport const own = state;\nexport default defineFacet(() => {});\n`,
	);
	// 写 a 模块：静态导入 b/state；same 调用时再动态导入 b/facet 并比较 own===state。
	// 这段动态 import 是原夹具字符串内容，不能改写成外层代码或插入注释改变输入。
	writeFileSync(
		`${plugins}a/facet.ts`,
		`import { bool, obj } from "@earendil-works/pi-schema";\nimport { defineFacet, local, method } from ${JSON.stringify(chord)};\nimport { state } from "../b/state.ts";\n` +
			`const Shared = local("t.shared", { version: 1, input: obj({}, { open: true }), members: { same: method(undefined, bool()) } });\n` +
			`export default defineFacet((host) => host.serve(Shared, () => ({ same: async () => (await import(new URL("../b/facet.ts", import.meta.url).href)).own === state })));\n`,
	);
	// 为导入顺序场景新建主机及加载器，不复用第一组运行代。
	const ordered = createHost({ self: { kind: "host" }, loader: nodeLoader, onError: () => {} });
	// 一次声明 a、b 两个根，a 虽排在前面，其跨目录导入仍应使用 b 根的同一份模块。
	await ordered.load([`${plugins}a/facet.ts`, `${plugins}b/facet.ts`]);
	// 实际执行 same；返回 true 才证明静态与动态路径拿到同一个 state 对象。
	assert.equal(await ordered.hold(Shared, {}).same(), true);
	// 结束第二组主机。
	await ordered.close();
} finally {
	// 递归删除第一组临时文件；force 容忍目录尚未创建或已不存在。
	rmSync(dir, { recursive: true, force: true });
	// 同样清理第二组目录；finally 清理异常仍会向外抛出。
	rmSync(plugins, { recursive: true, force: true });
}
