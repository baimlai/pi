// 验证导出HTML里中文标点旁的Markdown强调：创建自己的临时会话，导出后只在VM取解析函数，不启动浏览器或调用模型。
// 导入同步文件操作：建临时目录、读写自建文件、最终递归删除该目录；这些操作确实访问本机磁盘。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// tmpdir返回宿主临时目录位置，不自行创建目录。
import { tmpdir } from "node:os";
// join按当前系统路径规则拼接，不检查文件存在。
import { join } from "node:path";
// VM提供独立JS上下文和执行入口；这里运行可信的本地导出脚本，不把VM当不可信代码的安全边界。
import { createContext, runInContext } from "node:vm";
// Vitest提供一次性准备/清理、分组/用例与断言，导入不等已经执行这些回调。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 实际导出器会读会话和模板并写HTML，测试没有替换它；只对自建tmp文件使用。
import { exportFromFile } from "../src/core/export-html/index.ts";
// 版本常量在运行时使用；type SessionHeader仅编译期约束会话头，擦除后不会验证JSON。
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.ts";
// 导入主题初始化函数，为真实导出器准备颜色；本测试不传true开启watch。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// 输入导出HTML，提取本地脚本→建立最小DOM替身→执行vendor→提前返回查看器的Markdown函数。
// 返回类型(text: string) => string表示返回可调用函数；例如parse中文Markdown得到HTML片段。
// 缺数据/脚本主动抛错，VM语法或执行异常也直接传播；这只测解析，不覆盖完整查看器交互。
function loadMarkdownParser(html: string): (text: string) => string {
	// 正则取固定script标签中的非小于号文字，捕获组[1]是Base64数据；?.在match为null时给undefined，不把它自动解析为JSON。
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	// matchAll配g遍历无属性script标签；展开为数组，再map取第1捕获组脚本体。[\s\S]*?跨换行且尽早停在结束标签，不是通用HTML解析器。
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	// pop移除并返回最后一个脚本作为查看器；空数组返回undefined，剩余顺序仍是前置vendor。
	const viewer = scripts.pop();
	// 两个提取结果都要为真值，否则立即抛错，之后TS也据此把viewer收窄为string。
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	// 新建上下文并注入查看器初始化所需的少量全局值；未提供真实浏览器document。
	const context = createContext({
		// 对象属性简写把当前atob函数作为同名字段传入，用于Base64解码。
		atob,
		// 注入TextDecoder，把解码后的UTF8字节恢复为中文字符串。
		TextDecoder,
		// 注入查询参数解析器，匹配查看器读取leafId/targetId的早期代码。
		URLSearchParams,
		// DOM替身对任意id都返回同一textContent，querySelector总返回null；只足够这条取解析器路径，不能证明真实DOM查询正确。
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		// 用嵌套对象提供空URL查询，避免实际读取浏览器地址。
		window: { location: { search: "" } },
	});
	// 按HTML顺序遍历除最后查看器外的脚本；不是并行执行。
	for (const script of scripts) {
		// 在同一上下文执行marked/CJK/高亮等内嵌vendor，使全局依赖可供随后查看器使用；错误不吞。
		runInContext(script, context);
	}
	// 最后执行修改后的查看器并返回其IIFE的结果；VM返回值本身没有运行时按TS函数签名校验。
	return runInContext(
		// 只在临时字符串首次出现的函数声明前加return；函数声明提升让safeMarkedParse在该处可返回，后续完整页面初始化不再执行。原文件不改。
		viewer.replace("function safeMarkedParse(", "return safeMarkedParse; function safeMarkedParse("),
		// 复用前面已装好vendor的上下文，而非再新建一份丢掉全局依赖。
		context,
	);
}

// #10154
// 将两项CJK回归放同一组，保留上方原issue编号定位问题来源。
describe("HTML export CJK emphasis", () => {
	// let声明稍后准备回调赋值的目录字符串；类型注解不是自动创建或运行时非空检查。
	let tempDir: string;
	// 保存返回的解析函数供两用例复用；冒号后是函数类型，不是在这里声明函数实现。
	let parse: (text: string) => string;

	// 整组前执行一次异步准备；Vitest等待其Promise，准备失败会影响后续用例。
	beforeAll(async () => {
		// 设置全局dark主题，默认不启动watcher；不是每个用例独立主题实例。
		initTheme("dark");
		// 以固定前缀创建唯一临时目录并保存实际路径，后面文件仅写在这目录内。
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-cjk-"));
		// 构造真实会话头对象，无消息条目也足够生成导出页面。
		// 末尾satisfies检查对象符合SessionHeader又保留表达式推断；不强制转换字段、不在运行时检查磁盘JSON。
		const header = {
			// 字面量type标记这条JSONL记录是session头，不是用户消息。
			type: "session",
			// 使用当前文件格式版本，避免刻意测试旧版迁移。
			version: CURRENT_SESSION_VERSION,
			// 会话ID使用固定夹具值，不生成随机业务会话。
			id: "cjk-test",
			// Date(0)是Unix纪元的固定时刻；toISOString生成稳定UTC文字，不读取当前时间。
			timestamp: new Date(0).toISOString(),
			// 把会话工作目录设为自己的临时目录，不指向用户项目。
			cwd: tempDir,
		} satisfies SessionHeader;
		// 拼出自建JSONL文件路径，join本身还没写文件。
		const sessionPath = join(tempDir, "session.jsonl");
		// JSON.stringify把对象编码为一行文字，模板末尾补换行；writeFileSync实际同步写入。
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);
		// 先await导出器返回HTML路径，再UTF8读文件并取VM解析函数；await只等待Promise，不把同步磁盘操作移到后台。
		parse = loadMarkdownParser(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	// 整组结束后清理；测试没有在此恢复先前全局主题。
	afterAll(() => {
		// 只递归删本测试保存的tmp目录；force忽略不存在，不保证所有权限或I/O错误都被吞。
		rmSync(tempDir, { recursive: true, force: true });
	});

	// 一例检查五种中文标点邻接场景，全部比较精确HTML和末尾换行，不测视觉字体。
	it("renders emphasis delimited next to CJK punctuation", () => {
		// 中文句号位于双星号内，后面紧接汉字，仍应生成strong而不是保留星号。
		expect(parse("**这是测试。**后面")).toBe("<p><strong>这是测试。</strong>后面</p>\n");
		// 中文冒号位于强调末尾，后面紧接中文，断言strong范围正确。
		expect(parse("**一句话说清：**一台机器")).toBe("<p><strong>一句话说清：</strong>一台机器</p>\n");
		// 强调后紧接数字和空格，断言仍识别结束双星号且保留后文。
		expect(parse("**要点到此为止。**20 小时")).toBe("<p><strong>要点到此为止。</strong>20 小时</p>\n");
		// 强调里的中文引号左右都紧邻汉字，断言引号被包在strong里。
		expect(parse("字**「引用」**字")).toBe("<p>字<strong>「引用」</strong>字</p>\n");
		// 单星号场景生成em，说明本例也覆盖斜体，不只双星号加粗。
		expect(parse("*斜体。*后面")).toBe("<p><em>斜体。</em>后面</p>\n");
	});

	// 另一例约束非CJK场景沿用CommonMark的强调边界规则，避免一律放宽。
	it("keeps CommonMark flanking rules for non-CJK text", () => {
		// 英文句点后紧接Then时，原双星号应留作文字；toBe精确比较字符串，不接受近似HTML。
		expect(parse("**end.**Then next")).toBe("<p>**end.**Then next</p>\n");
	});
});
