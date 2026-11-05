// 检验导出查看器的系统消息辅助：将本地JS片段装入VM，与pi-ai的文字规则比对，并检查初始/更新/压缩快照分类；不向模型发送系统提示词。
// 同步读取模板源码，下面一次读出后由同文件各例复用该字符串。
import { readFileSync } from "node:fs";
// VM执行本地可信片段并把helpers写回上下文；不提供真实浏览器DOM，也不把VM当安全隔离执行器。
import { runInNewContext } from "node:vm";
// 两个helper是运行时函数，SystemMessage前的type只参与编译期检查；混合导入不会创建SystemMessage构造器。
import { getSystemMessageText, renderSystemMessageUpdate, type SystemMessage } from "@earendil-works/pi-ai";
// 导入测试分组、精确比较/文本匹配断言和用例注册函数。
import { describe, expect, it } from "vitest";

// interface只声明本例将从VM取得的方法，不生成对象、实现或运行时校验。
interface SystemHelpers {
	// 输入单条系统消息并返回正文与非删除章节的完整文字，签名中的分号不是函数体。
	getSystemMessageText(message: SystemMessage): string;
	// 后续系统消息转为更新说明的函数契约，不执行工具增删。
	renderSystemMessageUpdate(message: SystemMessage): string;
	// 判断条目是否为分支上的首个系统状态；内联对象类型要求id和可为null的parentId，不等允许省略该字段。
	isLeadingSystemEntry(entry: { id: string; parentId: string | null }): boolean;
	// 把系统更新变化整理成短标签文字的方法契约。
	describeSystemUpdate(message: SystemMessage): string;
}

// 顶层按模块URL读template.js，加载测试文件时就会读盘，不等进入it才读取。
const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

// 输入历史条目数组，截取系统helper源码→建id索引→在VM声明函数→返回四个可调用helper。
// 例如含s1→u1→s2父链时可判断s2是更新；返回值依赖固定源码锚点，找不到/执行失败直接报错。unknown[]只是调用侧类型，不验证数组每项。
function loadSystemHelpers(entries: unknown[]): SystemHelpers {
	// 找系统正文抽取函数的第一次声明文本位置，找不到为-1。
	const start = templateJs.indexOf("function systemContentText(content)");
	// 用紧随helper区域的常量声明当结束锚点，不运行后面的完整页面初始化。
	const end = templateJs.indexOf("const hasSystemEntries");
	// 起点必须存在，不对任意JS文件使用这段提取器。
	expect(start).toBeGreaterThanOrEqual(0);
	// 终点须在起点后面，避免错误切片静默运行。
	expect(end).toBeGreaterThan(start);
	// 上下文对象用属性简写保存原entries引用，helpers?允许赋值前缺失；并未复制或冻结条目。
	const context: { entries: unknown[]; helpers?: SystemHelpers } = { entries };
	// 执行模板字符串里的三步：Map按id索引条目，插入真实helper源码，把四函数放入helpers；这里只声明/取函数，不渲染DOM。
	// 内部多行模板字面量是运行时代码文字，保持原样，不往其正文插入学习注释。
	runInNewContext(
		`const byId = new Map(entries.map(entry => [entry.id, entry]));
		${templateJs.slice(start, end)}
		helpers = { getSystemMessageText, renderSystemMessageUpdate, isLeadingSystemEntry, describeSystemUpdate };`,
		// 将这个上下文对象提供给VM，运行结束后从同一对象读取helpers。
		context,
	);
	// 末尾!是TS非空断言，擦除后直接返回context.helpers；它不在运行时检查VM确实写了该属性。
	return context.helpers!;
}

// 初始SystemMessage夹具：正文+两章节+read工具声明，TS检查形状；这里只描述数据，不安装或执行read。
const initial: SystemMessage = {
	// role字面量system让使用方按系统消息解释。
	role: "system",
	// 普通字符串正文，之后与章节值按helper规则拼接。
	content: "You are a helpful assistant.",
	// 规则与项目上下文按对象枚举次序列出；XML样式文字是内容，不在此作为文件路径或XML文档解析。
	sections: { rules: "<rules>\nbe concise\n</rules>", project_context: "<project_context>\nv1\n</project_context>" },
	// 添加read的工具元数据，空对象schema以as never跨过类型兼容；断言不生成合法schema/执行函数或运行时验证。
	toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } as never }],
	// 时间戳固定1，只作为夹具数据，不读取当前时间。
	timestamp: 1,
};

// 后续系统消息表示补丁：加文字、替换项目章节、删规则、加bash并移除read，不是把initial原地修改。
const update: SystemMessage = {
	// 补丁仍用system角色，与普通用户提问不同。
	role: "system",
	// 正文改用text内容块数组，验证helper也支持这种合法表示。
	content: [{ type: "text", text: "Extra instructions" }],
	// project_context换v2，rules:null是删除标记；null与空字符串更新不同。
	sections: { project_context: "<project_context>\nv2\n</project_context>", rules: null },
	// 工具新增声明是数组，可放多个工具，本例只放一个。
	toolsAdded: [
		// 声明bash的名称/说明/schema；as never仅用于夹具类型绕过，没有启动shell。
		{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } as never },
	],
	// 移除列表只按read名称声明变化，不从测试进程卸载任何真实工具。
	toolsRemoved: [{ name: "read" }],
	// 时间戳固定2表示夹具后续记录；父链分类并不是靠比较1和2实现。
	timestamp: 2,
};

// 构造一条初始系统→用户→系统补丁的父链，id用于Map索引。
const entries = [
	// s1无父，保存initial引用，不复制消息对象。
	{ type: "message", id: "s1", parentId: null, message: initial },
	// u1的父是s1，说明系统补丁不必紧挨前一个系统条目。
	{ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "hi" } },
	// s2沿u1可回到s1，供isLeadingSystemEntry检查较早系统状态。
	{ type: "message", id: "s2", parentId: "u1", message: update },
];

// Regression tests for #11261: system messages were stored in the export but never rendered.
// 四项回归共用原issue背景；前三项执行helper，最后一项只做源码文本检查。
describe("export HTML system messages", () => {
	// 第一例比较浏览器helper与pi-ai helper的字符串结果，不是真的调用模型检查收到的网络payload。
	it("renders system message text the same way the model receives it", () => {
		// 为这例新建VM函数集，历史数据仍是上面相同entries引用。
		const helpers = loadSystemHelpers(entries);
		// 初始提示词文字两实现应完全相同；toBe比较最终字符串值。
		expect(helpers.getSystemMessageText(initial)).toBe(getSystemMessageText(initial));
		// 后续更新说明也应和pi-ai一致，包含章节更新/删除措辞。
		expect(helpers.renderSystemMessageUpdate(update)).toBe(renderSystemMessageUpdate(update));
	});

	// 第二例同时验证父链上的初始/补丁分类与短摘要顺序。
	it("renders the first system entry on a branch as the prompt and later ones as updates", () => {
		// 再次从实际源码加载helper，不用手写镜像代替待测函数。
		const helpers = loadSystemHelpers(entries);
		// s1之前没有系统状态，应是首个系统条目。
		expect(helpers.isLeadingSystemEntry(entries[0])).toBe(true);
		// s2父链上有s1，所以false表示作为更新展示。
		expect(helpers.isLeadingSystemEntry(entries[2])).toBe(false);
		// 正文记instructions，再按章节顺序列替换/删除，最后列工具+bash和-read；此处只验证摘要文字。
		expect(helpers.describeSystemUpdate(update)).toBe("instructions, project_context, -rules, tools +bash -read");
	});

	// 第三例验证压缩快照里存过system状态时，后续system仍算更新，不因压缩节点不是message就漏掉。
	it("treats a compaction snapshot as earlier system state", () => {
		// 直接给新VM两条内存历史，不调用真实压缩或摘要模型。
		const helpers = loadSystemHelpers([
			// 根压缩条目带initial作为systemMessage快照，不包含压缩执行过程。
			{ type: "compaction", id: "c1", parentId: null, systemMessage: initial },
			// 系统补丁s2直接挂压缩条目c1下。
			{ type: "message", id: "s2", parentId: "c1", message: update },
		]);
		// 只给id/parentId的查询对象也足够沿VM内Map查较早状态，期待false。
		expect(helpers.isLeadingSystemEntry({ id: "s2", parentId: "c1" })).toBe(false);
	});

	// 最后一例只查源码文本里有系统分支/提示/工具渲染调用，不执行renderEntry，也不证明真实页面已显示。
	it("renders system entries in the transcript", () => {
		// 正则匹配system角色分支及其紧随的空html变量；是固定源码结构约束，不是完整控制流验证。
		expect(templateJs).toMatch(/if \(msg\.role === 'system'\) \{\s*let html = '';/);
		// 要求源码包含初始系统提示块调用文字；toContain是子串匹配，不能单靠它证明该调用实际运行。
		expect(templateJs).toContain("renderSystemPromptBlock('System Prompt', text)");
		// 要求源码含Available Tools渲染调用文字，未验证DOM结果或实际工具可用性。
		expect(templateJs).toContain("renderToolsList('Available Tools', msg.toolsAdded)");
	});
});
