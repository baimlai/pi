// 验证宿主动态提供 models/settings 时，每次使用都会读取新值，无须重开 Harness。
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Models,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	MemoryStorage,
	type Registry,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { allEntries, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";

/** A `Models` whose only provider is a faux one answering every request with `text`. */
// 输入回答文本，返回仅安装 faux 的模型路由；预装十个应答，没有外部 I/O。
// 例：answering("first") 让接下来这些脚本化请求回答 first；并不提供无限队列。
function answering(text: string): Models {
	// 新建独立的假提供器，避免不同 Models 共享应答进度。
	const faux = fauxProvider();
	// Array.from 的回调逐次创建消息，十个条目具有相同文本而非同一消息引用。
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText(text)])));
	// 创建空路由并安装假提供器；调用者可把这个路由作为对象或函数返回值。
	const models = createModels();
	models.setProvider(faux.provider);
	// 不打开 Harness，单纯返回已配置的 Models。
	return models;
}

// options 只取 HarnessOptions 的 models/settings 两字段，registry 默认新建。
// 在内存存储上打开运行器并创建 faux 根会话，返回两个句柄；失败直接拒绝 Promise。
// 例：open({models: () => current}) 保存回调，读取模型时才得到 current；调用者负责 close。
async function open(
	options: Pick<HarnessOptions, "models" | "settings">,
	registry: Registry = createRegistry(),
): Promise<{ harness: Harness; root: Conversation }> {
	// ...options 展开动态输入，再加入这次测试的注册表。
	const harness = await Harness.open(new MemoryStorage(), { ...options, registry }, context);
	// 根会话首次创建时指定模型身份；实际提供器从上面的 models 解析。
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	// 不替调用者关闭资源，以便同一会话连续提交多轮。
	return { harness, root };
}

// 对 root 提交一轮 content，等终态 done 后返回最新原始条目的第一块文本，可能 undefined。
// 例：turn(root,"one") 得到 first；断言和异步调用错误会令本 helper 拒绝，不吞错。
async function turn(root: Conversation, content: string): Promise<string | undefined> {
	// submit 先返回接纳凭据，wait 再等待模型回答。
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	// 真实运行时断言成功终态，区别于 TS 返回类型的静态检查。
	expect(settled.status).toBe("done");
	// allEntries 在此小夹具中足以读完整历史，按旧到新排序。
	const entries = await allEntries(root);
	// at(-1) 取最后一条；?. 允许缺条目或 model，不强行做类型断言。
	return textOf(entries.at(-1)?.model?.[0]);
}

// 每个 it 的无参回调独占内存环境；异常由 Vitest 报告。
describe("HarnessOptions.models and settings as functions", () => {
	// 同一回调闭包中的 current 先后指向两个 Models；两次请求须看到各自的回答。
	it("generation uses the current return value of a models function at each request", async () => {
		// let 允许宿主稍后替换引用，而不是修改原 Models。
		let current = answering("first");
		const { harness, root } = await open({ models: () => current });
		// 第一轮解析函数时得到 first。
		expect(await turn(root, "one")).toBe("first");
		// 不重开 Harness，只切换外部变量。
		current = answering("second");
		expect(await turn(root, "two")).toBe("second");
		// 正常关闭运行器，结束本夹具。
		await harness.close(context);
	});

	// 对象形式与回调形式都是合法 API；此例只发一次请求并验证文本。
	it("still accepts a plain Models object", async () => {
		// 直接传 Models，没有 () => 包装。
		const { harness, root } = await open({ models: answering("plain") });
		expect(await turn(root, "one")).toBe("plain");
		await harness.close(context);
	});

	// 在同一次工具执行中两次读 api.models，中途替换宿主路由，第二次必须看到标记提供器。
	// 例：first 没有 second-only，second 有；只比较路由可见性，不向它发请求。
	it("tools read the current models at each access of api.models", async () => {
		// 两份路由使用同一 faux 脚本，区别是稍后只给 second 加一个标记。
		const first = createModels();
		const second = createModels();
		const faux = fauxProvider();
		// 第一答调用 probe，第二答正常结束，确保工具 getter 实际被运行到。
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		// 两路都能继续消费同一个 faux 应答队列。
		first.setProvider(faux.provider);
		second.setProvider(faux.provider);
		// Marks the second Models: tools see views of the host's Models that add the Harness identity.
		// 只作为区分路由的标记，不用于生成文本。
		second.setProvider(fauxProvider({ provider: "second-only" }).provider);
		// 工具与 models 回调共享此变量；seen 保存每次 getter 返回的视图。
		let current = first;
		const seen: Models[] = [];
		const registry = createRegistry();
		// 安装可被模型调用的 probe 工具；空 schema 也会走正常工具调用路径。
		registry.install(
			defineExtension({
				name: "probe",
				tools: [
					defineTool({
						// 名称与 fauxToolCall 对应，说明和参数保持普通工具契约。
						name: "probe",
						description: "Records api.models before and after the host swaps it",
						parameters: obj({}),
						// 参数不使用；副作用是保存两次模型视图并改 current，返回空输出成功结果。
						execute: async (_args, api) => {
							// 第一次读取时宿主仍返回 first。
							seen.push(api.models);
							// 同一调用内切换，不依赖下一轮重新创建工具 api。
							current = second;
							seen.push(api.models);
							// 无文本输出；faux 下一答会结束工具轮。
							return { output: [] };
						},
					}),
				],
			}),
		);
		// 把回调本身交给 Harness，不在 open 调用前求值。
		const { harness, root } = await open({ models: () => current }, registry);
		expect(await turn(root, "go")).toBe("done");
		// ! 是本夹具已执行两次 push 的静态假设；实际差异通过运行时断言验证。
		expect(seen[0]!.getProvider("second-only")).toBeUndefined();
		expect(seen[1]!.getProvider("second-only")).toBeDefined();
		await harness.close(context);
	});

	// 两轮请求之间换 settings；观察提供器收到的 timeoutMs，而不实际等待超时。
	it("generation reads the current return value of a settings function", async () => {
		// 括号使 [] 修饰整个 number|undefined 联合，每次回调追加一个观测值。
		const timeouts: (number | undefined)[] = [];
		const faux = fauxProvider();
		// 请求体故意视为 unknown 且不用；SimpleStreamOptions? 允许省略选项。
		// 返回固定 ok 应答并记录 timeout；不会启动计时器或访问真实网络。
		const reply = (_request: unknown, options?: SimpleStreamOptions) => {
			// ?. 若无 options 就记录 undefined，使缺传也能被后面的断言发现。
			timeouts.push(options?.timeoutMs);
			return fauxAssistantMessage([fauxText("ok")]);
		};
		// 两次使用同一观察回调；请求路由仍是唯一的 faux。
		faux.setResponses([reply, reply]);
		const models = createModels();
		models.setProvider(faux.provider);
		// HarnessSettings 检查字段拼写与类型；本地 let 可以整体换成另一设置对象。
		let settings: HarnessSettings = { stream: { timeoutMs: 1000 } };
		const { harness, root } = await open({ models, settings: () => settings });
		// 第一轮取 1000，再替换对象令第二轮取 2000。
		await turn(root, "one");
		settings = { stream: { timeoutMs: 2000 } };
		await turn(root, "two");
		// 比较实际传入 faux 的请求选项，证明没有缓存首次设置。
		expect(timeouts).toEqual([1000, 2000]);
		await harness.close(context);
	});
});
