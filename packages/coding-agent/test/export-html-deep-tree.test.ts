// 创建两万条父子相连的临时会话，导出后在VM执行真实树辅助，验证建树/展平/找叶/取路径能处理这份深链；不启动完整浏览器或模型。
// 同步文件接口负责自己的tmp目录/JSONL/HTML读写与清理，测试确实落盘，不是全内存测试。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// tmpdir只返回宿主临时目录位置，唯一目录由mkdtempSync创建。
import { tmpdir } from "node:os";
// join按本机规则拼路径，不检查存在或创建父目录。
import { join } from "node:path";
// VM提供独立JS上下文，执行可信本地查看器的一段初始化；它不是不可信代码的安全边界。
import { createContext, runInContext } from "node:vm";
// 测试器注册一次性准备/清理和用例，并提供长度/值断言。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 使用真实HTML导出器，读取本测试生成的会话，不向模型请求数据。
import { exportFromFile } from "../src/core/export-html/index.ts";
// 会话版本是运行时常量；两项type只给TS检查会话头/消息条目形状，不自动校验磁盘JSON。
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionMessageEntry } from "../src/core/session-manager.ts";
// 初始化主题以便实际导出生成颜色，未传true开启主题watch。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// 树节点的最小接口，仅描述断言需要的字段；实际查看器节点还有别的字段，此接口不删掉它们。
interface TreeNode {
	// entry是带id的对象类型，分号是类型成员分隔符，不是赋值。
	entry: { id: string };
	// children: TreeNode[]是递归类型，允许节点继续含同类孩子；声明本身不创建树或检查环。
	children: TreeNode[];
}

// 描述VM返回的五个函数，箭头写在类型里只规定参数/结果，不生成函数实现。
interface TreeApi {
	// 无参数建树函数返回根节点数组。
	buildTree: () => TreeNode[];
	// 以目标id回溯父链，结果Set<string>按id去重；这里是类型，不是new Set。
	buildActivePathIds: (targetId: string) => Set<string>;
	// 展平函数收根数组和活跃路径集合，返回节点包装数组；Array<{node: TreeNode}>等价于对应对象类型后加[]。
	flattenTree: (roots: TreeNode[], activePathIds: Set<string>) => Array<{ node: TreeNode }>;
	// 从某节点沿每层最新孩子找到叶id；这份单子链没有多分支时间竞争。
	findNewestLeaf: (nodeId: string) => string;
	// 从目标回溯再正序返回路径条目，本例只需每项id，不声明所有实际字段。
	getPath: (targetId: string) => Array<{ id: string }>;
}

// 输入HTML，提取Base64会话数据/查看器脚本，建立最小DOM替身并在树缓存初始化后提前返回五个函数。
// 例如后续api.buildTree()才真正建树；缺数据/脚本主动抛错，VM异常也传播。返回TreeApi只是TS契约，无运行时形状验证。
function loadTreeApi(html: string): TreeApi {
	// 正则捕获固定script标签里的Base64文字；?.[1]在没匹配时得到undefined，不把Base64直接当JSON解析。
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	// matchAll配g跨行取无属性script体，展开/映射成数组；这是固定模板提取法，不是通用HTML解析器。
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	// pop取最后查看器并从数组移除；剩余vendor脚本在本测试里没有执行，与CJK测试的处理不同。
	const viewer = scripts.pop();
	// 空结果立即报错，避免继续调用undefined.replace；判断也帮助TS收窄viewer为string。
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	// 建上下文，仅提供早期会话解码/查询解析需要的少量对象，不模拟完整浏览器。
	const context = createContext({
		// 属性简写注入atob，供Base64还原字节值文字。
		atob,
		// 注入TextDecoder，把字节恢复成UTF8消息文字。
		TextDecoder,
		// 注入URLSearchParams，供查看器读取空查询参数。
		URLSearchParams,
		// 任意id查询都返回同一sessionData，meta查询总null；这里只够提前返回前的代码，不能验证真实DOM查找。
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		// 用空location.search代替真实页面URL，避免依赖浏览器环境。
		window: { location: { search: "" } },
	});
	// 执行修改后的查看器IIFE并返回它的对象；还没调用这五个树方法，不执行后续DOM/marked初始化。
	return runInContext(
		// 仅改本地字符串的第一次锚点匹配，不修改磁盘中的template.js。
		viewer.replace(
			// 锚点选在树缓存let赋null的位置，让缓存变量先完成初始化。
			"let treeNodeMap = null;",
			// 先保留let初始化再return函数对象；后置function声明会提升，方法能用，且findNewestLeaf稍后访问treeNodeMap不会落入尚未初始化的暂时死区。
			"let treeNodeMap = null; return { buildTree, buildActivePathIds, flattenTree, findNewestLeaf, getPath };",
		),
		// 复用注入了解码工具和DOM替身的context，不加载真实网页。
		context,
	);
}

// #11225
// 保留原issue编号，以下单例针对长父子链，不覆盖任意损坏图/多节点环。
describe("HTML export deep session tree", () => {
	// 20_000中的下划线只是数字分组，值为两万；不是数组长度的运行时校验。
	const depth = 20_000;
	// let保存稍后创建的目录，TS注解不自动给它初值。
	let tempDir: string;
	// api稍后由准备回调赋值，接口本身不会实现这些方法。
	let api: TreeApi;

	// 整组前执行一次异步准备，测试器等待Promise后才运行断言。
	beforeAll(async () => {
		// 设置dark全局主题，默认无watch；本文件清理不恢复此前主题。
		initTheme("dark");
		// 在宿主tmp下创建唯一目录并保存真实路径，之后只操作自己目录中的文件。
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-deep-"));
		// 构造固定会话头，不生成真实用户会话。
		// 结尾satisfies检查SessionHeader兼容性并保留表达式推断，不转换数据或产生运行时验证。
		const header = {
			// type固定session，区别于下面message历史条目。
			type: "session",
			// 使用当前格式版本，避免故意触发旧格式迁移。
			version: CURRENT_SESSION_VERSION,
			// 固定id作为测试夹具标识，不影响下面e0起的消息id。
			id: "deep-test",
			// 固定Unix纪元转ISO UTC文字，输出稳定，不取当前时间。
			timestamp: new Date(0).toISOString(),
			// 会话cwd使用自己的临时目录，不指向用户工作目录。
			cwd: tempDir,
		} satisfies SessionHeader;
		// lines先放JSON编码的头字符串，随后逐条加消息；是string数组，不是SessionEntry对象数组。
		const lines = [JSON.stringify(header)];
		// 从0到19999共两万次同步循环，生成单子链，不创建两万个异步任务。
		for (let i = 0; i < depth; i++) {
			// 局部entry按SessionMessageEntry检查字段；每轮创建独立对象，类型不会自动补id或parent。
			const entry: SessionMessageEntry = {
				// message是会话条目类型，内部还有role区分用户/助手。
				type: "message",
				// 模板字符串生成e0、e1等唯一id。
				id: `e${i}`,
				// 三元表达式使首条父为null，其余指向紧前id，形成e0→e1→…长链。
				parentId: i === 0 ? null : `e${i - 1}`,
				// 条目时间每次递增一秒并转ISO文字，日期排序输入明确。
				timestamp: new Date(i * 1000).toISOString(),
				// 消息为固定用户文字x，内部timestamp用毫秒数字，与外层ISO表示分开。
				message: { role: "user", content: "x", timestamp: i * 1000 },
			};
			// 把当前对象序列化追加到lines，后续JSONL写入不直接写对象引用。
			lines.push(JSON.stringify(entry));
		}
		// 拼出自建会话文件路径，尚未在这一步写盘。
		const sessionPath = join(tempDir, "session.jsonl");
		// 按LF合并头/两万条记录，再补末尾换行同步写入；当前文件符合JSONL逐行形式。
		writeFileSync(sessionPath, `${lines.join("\n")}\n`);
		// await真实导出器写HTML并返回路径，随后UTF8读出交VM取树API；不向真实浏览器打开输出。
		api = loadTreeApi(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	// 整组结束清理自己目录，不按会话cwd删除其它目录。
	afterAll(() => {
		// recursive删除子文件，force忽略不存在；权限等I/O错误仍可能抛出。
		rmSync(tempDir, { recursive: true, force: true });
	});

	// 单例实际执行树算法检查两万深链；能处理此深度不等任意大小/环/多分支性能保证。
	it("builds and flattens a single-child chain deeper than the call stack", () => {
		// 现在才调用真实buildTree构造VM内节点，函数采用迭代连边/排序。
		const tree = api.buildTree();
		// 单子链应只产生一个根，不是整棵树只有一个节点。
		expect(tree).toHaveLength(1);
		// 计算末叶id e19999，模板插值把数字转文字。
		const leafId = `e${depth - 1}`;
		// 先回溯活跃路径集合，再展平树，后续迭代算法避免按深度递归调用。
		const flat = api.flattenTree(tree, api.buildActivePathIds(leafId));
		// 展平长度必须等于两万，检查节点总数；仅这个长度断言不独立证明每个id均唯一或无遗漏。
		expect(flat).toHaveLength(depth);
		// 末项应为目标叶，检查链的展平顺序尾部。
		expect(flat[depth - 1].node.entry.id).toBe(leafId);
		// 从根找最新叶在单子链只能得到末项，不据此推断多分支全局最新时间选择。
		expect(api.findNewestLeaf("e0")).toBe(leafId);
		// 沿父链取根到叶的新路径数组，不返回全部分叉历史。
		const path = api.getPath(leafId);
		// 路径同样应含两万个条目。
		expect(path).toHaveLength(depth);
		// 路径首项必须根e0，检查回溯结果已反转为正序。
		expect(path[0].id).toBe("e0");
		// 路径末项应是e19999，结束位置与展平/找叶一致。
		expect(path[depth - 1].id).toBe(leafId);
	});
});
