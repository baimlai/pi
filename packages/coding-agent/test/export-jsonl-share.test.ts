// 比较当前分支的普通JSONL导出与附加pi.share展示数据的导出，再重新打开分享文件检查树叶和模型上下文；测试不调用prompt或上传。
// 这里真实创建SDK会话并读写自建文件；默认运行时仍检查宿主认证配置、默认资源加载器仍可发现用户/祖先资源，显式临时cwd/agentDir不等于所有依赖都隔离。
// 同步文件操作负责创建临时目录、读取导出文件和递归清理；inMemory只约束会话日志后端，不免除这些导出I/O。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
// tmpdir只返回宿主临时目录路径，真正创建唯一目录的是下面mkdtempSync。
import { tmpdir } from "node:os";
// join按系统路径规则拼接文件名，不检查存在或执行写入。
import { join } from "node:path";
// import type只约束助手/工具结果夹具的TS结构，擦除后没有对应消息构造器或自动JSON校验。
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
// getModel是兼容入口的静态目录读取；导入compat会登记lazy能力和装配内置Models，但此读取不请求模型或验证认证。
import { getModel } from "@earendil-works/pi-ai/compat";
// Type提供运行时schema构造器；Type.Object/String生成参数描述，不在构造schema时执行share_tool。
import { Type } from "typebox";
// 测试器提供每例清理、分组和断言；async用例返回的Promise由Vitest等待。
import { afterEach, describe, expect, it } from "vitest";
// defineTool保留参数schema的泛型推导，运行时原样返回定义，不负责注册或校验参数。
import { defineTool } from "../src/core/extensions/types.ts";
// 真实SDK会装运行时/资源/AgentSession；即使传显式model，仍会走前面的模型缓存与认证可用性、资源发现初始化。
import { createAgentSession } from "../src/core/sdk.ts";
// SessionManager管理原始树条目及其模型上下文投影；两种视图不是同一数组。
import { SessionManager } from "../src/core/session-manager.ts";
// 本例采用内存设置，避免按文件后端读写设置；默认资源发现本身并不因此被关闭。
import { SettingsManager } from "../src/core/settings-manager.ts";
// 只调用本地分享导出助手，它同步写JSONL并附展示尾项；同模块的上传/Gist/UI流程没有在本例调用。
import { exportSessionForShare } from "../src/modes/interactive/session-share.ts";
// 两辅助函数创建带当前时间的用户/助手消息数据；不会让模型生成这段内容，也不调用utilities里的真实认证助手。
import { assistantMsg, userMsg } from "./utilities.ts";

// 把一次完整导出/重新导入回归放同组；断言针对下面这条线性分支，不覆盖多分支重连、压缩或任意历史格式。
describe("JSONL share export", () => {
	// string[]只约束目录名单类型，初始为空；保存每次实际创建的目录以便失败后仍能清理。
	const tempDirs: string[] = [];

	// 每例结束后遍历本组目录并同步删除，无业务返回；例如断言抛错后测试器仍会调此钩子，但删除自身也可能抛错。
	afterEach(() => {
		// splice(0)先把所有目录从原数组移走并返回它们，for...of再逐个清理；中途删除失败不自动把剩余目录重新登记。
		for (const tempDir of tempDirs.splice(0)) {
			// 只递归删已记录的自建目录；force忽略不存在，不保证吞掉权限等I/O错误。
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// 流程创建会话/自定义工具→手工追加三条消息→普通导出无分享尾项→分享导出保留分支ID并附元数据→导入后投影仍是三条消息。
	// 输入是固定夹具而非真实模型回答，Promise失败交测试器；finally仅包住会话创建成功后的主体，创建阶段拒绝时不会调用下面的session.dispose。
	it("adds presentation data without changing conversation IDs or links", async () => {
		// 用固定前缀创建唯一临时目录并取得实际路径，不复用用户项目。
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-share-"));
		// 立即登记目录，即使后面SDK创建失败，afterEach仍能找到这份自建目录。
		tempDirs.push(tempDir);
		// 管理器绑定此cwd但不持久化日志；appendMessage等先修改内存，后面的显式导出才写文件。
		const sessionManager = SessionManager.inMemory(tempDir);
		// await真实SDK装配，解构结果中的session；没有传modelRuntime/resourceLoader，所以SDK会创建默认实现。
		const { session } = await createAgentSession({
			// 项目工作目录指向自建目录，用于相对工具路径和项目资源发现，不改变进程cwd。
			cwd: tempDir,
			// 显式agentDir把本运行时auth.json/models.json及常规用户资源根指向临时子目录；跨工具HOME技能/宿主认证环境不由这个字段统一替换。
			agentDir: join(tempDir, "agent"),
			// 从随包目录取一个具体模型；末尾!只让TS忽略缺失可能，运行时不会因此检查或生成模型，也不开始对话。
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			// 设置使用内存后端，reload仍走设置逻辑，但不读写用户settings.json。
			settingsManager: SettingsManager.inMemory(),
			// 属性简写传同一个内存会话管理器；SDK会为新会话追加初始模型/思考元数据，所以分支不只有下方三条消息。
			sessionManager,
			// 显式工具允许名单只启用share_tool；这限制工具选择，不是关闭默认资源发现或取消全部内置定义构造。
			tools: ["share_tool"],
			// customTools提供要注册的定义数组，与tools名字选择配合，不在声明数组时执行工具。
			customTools: [
				// 把工具对象交类型推导助手，保留schema→参数类型联系；实际注册由会话运行时随后完成。
				defineTool({
					// 工具匹配名，和下面历史toolCall.name及toolResult.toolName保持一致。
					name: "share_tool",
					// 展示标签不等于工具查找ID，也不会成为一条对话消息。
					label: "Share Tool",
					// 用途描述稍后应出现在分享工具元数据中，不是模型已读到这段说明的证据。
					description: "Render a value for sharing",
					// schema要求一个value字符串并附字段说明；这只是定义，本例手工追加历史，不走工具调用参数校验或执行。
					parameters: Type.Object({ value: Type.String({ description: "Value to render" }) }),
					// async无参箭头若被调用会给Promise结果，圆括号让箭头直接返回对象；本例的done结果稍后手工构造，未调用此execute。
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				}),
			],
		});

		// 会话已创建才进入try；正常结束或断言/导出失败都进入finally释放它，创建前异常由外层测试器处理。
		try {
			// 手工把hello用户消息追加到当前叶，返回新树条目ID；userMsg内部给当前时间，不调用session.prompt。
			const userId = sessionManager.appendMessage(userMsg("hello"));
			// 声明符合AssistantMessage的夹具对象，类型注解不会触发一次真实assistant回答。
			const assistant: AssistantMessage = {
				// 先浅展开通用助手夹具，带协议/供应商/用量等默认字段；后面同名字段覆盖空正文及stop原因。
				...assistantMsg(""),
				// 把content替成一个工具调用块，call-1是工具调用ID，和管理器为这条消息生成的树ID不是一回事。
				content: [{ type: "toolCall", id: "call-1", name: "share_tool", arguments: { value: "example" } }],
				// 用toolUse表示夹具提出工具调用；只保存状态，不自动续轮或执行share_tool。
				stopReason: "toolUse",
			};
			// 追加助手夹具并保存条目ID，新的parentId指向刚才的用户条目。
			const assistantId = sessionManager.appendMessage(assistant);
			// 用ToolResultMessage类型描述手工结果，和上面的工具定义execute返回值是不同对象。
			const result: ToolResultMessage = {
				// role标记工具结果，投影时仍是工具消息，不伪造成助手正文。
				role: "toolResult",
				// toolCallId关联助手声明的call-1，不用assistantId这个树条目ID做配对。
				toolCallId: "call-1",
				// 记录工具名称用于识别/展示，不在此查注册表再执行一次。
				toolName: "share_tool",
				// 固定文本块done作为已记录结果，未从真实工具或模型读取。
				content: [{ type: "text", text: "done" }],
				// 空details对象是不带额外结果详情的夹具，不是分享元数据data。
				details: {},
				// isError为false表示记录的工具结果成功，未验证外部操作是否真的发生。
				isError: false,
				// 读取当前毫秒时间作为消息时间；SessionManager追加时还会生成自己的条目ISO时间。
				timestamp: Date.now(),
			};
			// 追加工具结果推进当前叶，保存ID供分享尾项parentId断言使用。
			const resultId = sessionManager.appendMessage(result);
			// getBranch取当前根到叶的原始条目，再map只存ID；包括SDK元数据，不是buildSessionContext筛出的消息集合。
			const originalEntryIds = sessionManager.getBranch().map((entry) => entry.id);

			// 拼普通JSONL目标路径，位于本例临时目录。
			const normalPath = join(tempDir, "normal.jsonl");
			// 同步导出当前分支，新头后接原始条目；条目ID保留，parentId按导出次序重连，不应用模型压缩/上下文编辑投影。
			session.exportToJsonl(normalPath);
			// 同步读出刚生成的普通导出，UTF8字符串接到后面的链式解析。
			const normalRecords = readFileSync(normalPath, "utf8")
				// 去文件首尾空白便于按行拆；不是逐个消息内容trim，JSON字符串内部转义的换行仍保留。
				.trim()
				// 按LF拆为JSONL记录文字数组，不是把整个文件当单一JSON数组解析。
				.split("\n")
				// 逐行JSON.parse，语法错会抛；as Record<string,unknown>只给TS字典视图，不校验每条的字段形状。
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			// some查是否存在同时满足custom类型和pi.share标记的记录，后面的toBe严格比较布尔结果。
			expect(normalRecords.some((record) => record.type === "custom" && record.customType === "pi.share")).toBe(
				// 期待普通导出没有这种分享尾项；本断言不逐字段比较普通导出的全部消息。
				false,
			);

			// 另拼分享JSONL目标，和普通导出分两个文件，方便检查两条导出路径。
			const sharePath = join(tempDir, "share.jsonl");
			// 同步导当前分支并创建仅供导出使用的pi.share尾项，保存当前prompt与工具schema；不上传，也不把尾项追加回原sessionManager。
			exportSessionForShare(sharePath, session);
			// 把分享文件完整读为字符串，下面按相同JSONL规则解析。
			const records = readFileSync(sharePath, "utf8")
				// 移除整个文件首尾排版空白，不修改JSON编码的正文字符串值。
				.trim()
				// 拆每行作为独立记录解析输入。
				.split("\n")
				// 解析成普通JS值并断言为未知字段字典；类型断言不证明每行一定是标准SessionEntry。
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			// slice(1,-1)去掉第一条新会话头和最后一条分享尾项，得到待比对的原分支条目；本例通过后续断言检查这些位置约定。
			const conversationRecords = records.slice(1, -1);
			// 逐项比较分享中的原分支ID顺序与导出前快照，toEqual比较数组值，不要求两个数组是同一引用。
			expect(conversationRecords.map((record) => record.id)).toEqual(originalEntryIds);
			// 预期首条父为null，其余按前一条ID线性连接；...展开除末项外的原ID，不证明任意多分支的原父关系都原样不变。
			expect(conversationRecords.map((record) => record.parentId)).toEqual([null, ...originalEntryIds.slice(0, -1)]);
			// 确认末尾三个原条目确实是刚追加的用户/助手/工具结果，不把SDK前置元数据误当对话消息。
			expect(conversationRecords.slice(-3).map((record) => record.id)).toEqual([userId, assistantId, resultId]);

			// at(-1)取末条，越界可为undefined；as只把它视为下面的小结构，不运行检查或补齐不存在的data。
			const shareEntry = records.at(-1) as {
				// 静态声明尾项id是string，实际值仍来自JSON解析，不靠此类型断言证明合法或唯一。
				id: string;
				// data?表示展示数据可省，嵌套花括号只是TS对象类型，不是新建data对象。
				data?: {
					// 系统提示文字也声明为可选；后面的?.访问会在data缺失时短路。
					systemPrompt?: string;
					// 工具列表是未知字段字典数组，不带可执行函数类型；这里只声明后续断言要读取的形状。
					tools?: Array<Record<string, unknown>>;
				};
			};
			// toMatchObject按指定字段作局部匹配，允许实际对象有其他字段，不据此证明完整会话schema或唯一尾项ID。
			expect(shareEntry).toMatchObject({
				// 要求末项是custom原始条目，区别于会进入模型消息的custom_message。
				type: "custom",
				// customType必须精确等于pi.share，供分享查看器识别展示补充。
				customType: "pi.share",
				// 分享尾项接在工具结果条目后，保留当前导出路径末叶的连接。
				parentId: resultId,
				// expect.any(String)只要求字符串形状，不证明ISO格式、时间先后或精确当前时刻。
				timestamp: expect.any(String),
			});
			// 分享prompt应等于当前Agent状态文字，不由测试固定它的完整内容；资源发现结果可能参与这份prompt。
			expect(shareEntry.data?.systemPrompt).toBe(session.state.systemPrompt);
			// 工具数组应只有下面这一项，但该项用局部匹配器，因此不要求只含name/description两个字段。
			expect(shareEntry.data?.tools).toEqual([
				// objectContaining只匹配列出的字段，可允许parameters等额外元数据；本例没有逐字段验证导出的参数schema。
				expect.objectContaining({
					// 工具名称要与注册的share_tool一致。
					name: "share_tool",
					// 完整用途描述也要随分享数据保留。
					description: "Render a value for sharing",
				}),
			]);
			// 展示数据中不应有预渲染工具HTML字段；不等于所有其他字段都被白名单验证。
			expect(shareEntry.data).not.toHaveProperty("renderedTools");
			// data里不携带theme字段；不在这里验证查看器最终采用哪个主题。
			expect(shareEntry.data).not.toHaveProperty("theme");
			// data里不携带version字段，文件第一条会话头仍有自己的格式版本，不能混为一谈。
			expect(shareEntry.data).not.toHaveProperty("version");

			// 真实打开刚导出的分享文件，重建索引/叶子，必要时可迁移或补末尾换行；不恢复整个SDK或启动扩展。
			const imported = SessionManager.open(sharePath);
			// 文件最后custom条目也会成为树叶，和它不贡献模型正文是两回事。
			expect(imported.getLeafId()).toBe(shareEntry.id);
			// 构建导入分支的模型上下文并只比较角色顺序；普通custom及模型/思考元数据被投影过滤，不因此从原文件删除。
			expect(imported.buildSessionContext().messages.map((message) => message.role)).toEqual([
				// 期待第一条模型消息为用户；本例并未调用prompt写初始system消息到历史。
				"user",
				// 第二条仍是助手工具调用消息，不把它自动改成结果。
				"assistant",
				// 第三条为配对工具结果；这里不逐项比较完整消息文字、参数或用量。
				"toolResult",
			]);
			// finally在主体成功或抛错时均执行；不覆盖前面尚未取得session时的创建失败，也不替代afterEach文件清理。
		} finally {
			// 释放会话订阅、保温及会话资源并请求取消；dispose返回void，不等待所有异步任务结束，也不删除这两个导出文件。
			session.dispose();
		}
	});
});
