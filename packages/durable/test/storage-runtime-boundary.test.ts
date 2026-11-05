// 静态扫描源码的相对导入，防止可移植存储入口意外依赖 Node 专属实现；不是实际打包器解析测试。
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// import.meta.url 是当前模块 URL；先相对定位 src，再转成供文件系统读取的本地路径。
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

// 输入 src 下的入口路径，沿正则识别出的相对 import/export 做深度遍历，返回访问过的路径集合。
// 例如 sourceGraph("index.ts") 检查根入口及其相对依赖；只读本地文件，不执行被读模块。
// 读文件失败或检测到 node: 导入会拒绝 Promise；非相对包引用、动态计算路径不是这张图的覆盖范围。
async function sourceGraph(entry: string): Promise<Set<string>> {
	// Set<string> 去重，既记录结果，也阻止循环依赖导致无限遍历。
	const visited = new Set<string>();
	// pending 用作栈，入口先转换为绝对路径。
	const pending = [resolve(sourceRoot, entry)];
	// 栈为空表示所有识别出的相对依赖都处理完毕。
	while (pending.length > 0) {
		// pop 取出最后一个待读路径；! 是类型非空断言，依据上面的长度条件。
		const path = pending.pop()!;
		// 同一路径只读取一次，重复引用立即跳过。
		if (visited.has(path)) continue;
		visited.add(path);
		// await 取得 UTF-8 源码；这里只检查文本，不运行依赖或访问真实模型。
		const source = await readFile(path, "utf8");
		// 识别 from "node:…" 或 import "node:…"；失败消息包含当前文件路径。
		// 正则扫描也会看到注释文本，不等同于 TypeScript 的语法树分析。
		expect(source, `${path} imports a Node built-in`).not.toMatch(/(?:from\s+|import\s*)["']node:/);
		// Type-only imports are erased and load nothing.
		// 全局 g 标志让 matchAll 遍历所有相对导入/导出；第 2 组标记整句 type，第 3 组提取路径。
		for (const match of source.matchAll(/\b(import|export)(\s+type\b)?[^;"']*?(?:from\s*)?["'](\.[^"']+)["']/g)) {
			// 整句 import type / export type 没有运行时依赖；其余匹配按当前文件所在目录解析再入栈。
			// 这不是完整的模块解析器，例如命名导入中的 type 修饰符仍随整句扫描。
			if (match[2] === undefined) pending.push(resolve(dirname(path), match[3]));
		}
	}
	// 返回去重后的绝对路径，供调用者检查是否越过平台边界。
	return visited;
}

// 同步分组回调只注册用例；四个 async 用例实际执行文件读取并在断言不符时失败。
describe("durable storage runtime boundaries", () => {
	// 根入口只能到达通用核心；三项断言分别排除环境、JSONL、SQLite 子系统。
	it("keeps the package root limited to portable core storage", async () => {
		const graph = await sourceGraph("index.ts");
		// 展开 Set 后用 some 查找任意违规路径；false 要求一个都没有。
		expect([...graph].some((path) => path.includes("/env/"))).toBe(false);
		expect([...graph].some((path) => path.includes("/storage/jsonl/"))).toBe(false);
		expect([...graph].some((path) => path.includes("/storage/sqlite/"))).toBe(false);
	});

	// 可移植 SQLite 接口可以依赖通用实现，但不能引入 node.ts 的数据库适配器。
	it("keeps the portable SQLite subpath free of Node imports", async () => {
		const graph = await sourceGraph("storage/sqlite/index.ts");
		expect([...graph].some((path) => path.endsWith("/storage/sqlite/node.ts"))).toBe(false);
	});

	// 环境抽象的入口不能把 Node 环境实现一起加载；sourceGraph 还会检查所有访问源码中的 node: 文本。
	it("keeps the portable environment subpath free of Node imports", async () => {
		const graph = await sourceGraph("env/index.ts");
		expect([...graph].some((path) => path.endsWith("/env/node.ts"))).toBe(false);
	});

	// JSONL 通过可移植文件系统能力工作，因此同时排除 JSONL 和环境的 Node 适配器。
	it("keeps the portable JSONL subpath free of Node imports", async () => {
		const graph = await sourceGraph("storage/jsonl/index.ts");
		expect([...graph].some((path) => path.endsWith("/storage/jsonl/node.ts"))).toBe(false);
		expect([...graph].some((path) => path.endsWith("/env/node.ts"))).toBe(false);
	});
});
