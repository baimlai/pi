// 用纯内存目录/注册与127.0.0.1假HTTP/SSE验证llama扩展的Provider、认证材料、HF目录和加载/下载客户端；不启动真实llama、不请求外网、不展示真实终端交互或保存用户凭证。
// 假服务只返回预设JSON/事件，断言证明固定输入下的投影和协议行为，不等于验证真实模型能力、性能、完整缓存持久性或远端取消保证。
// events.once把某次事件变成Promise，等待listening时也会因server的error事件拒绝，不是实例.once监听回调的返回值。
import { once } from "node:events";
// createServer是真正创建本机HTTP假服务，type成员仅供TS检查请求/响应/服务对象。
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
// AddressInfo描述TCP地址对象；后面as不执行运行时校验。
import type { AddressInfo } from "node:net";
// 四个type导入描述注入认证、假提示和内存目录发布协议，不在此访问真实认证存储。
import type { AuthContext, AuthPrompt, ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
// describe回调建立分组，it登记每例让框架随后执行；expect是运行时断言，afterEach负责各例清理。
import { afterEach, describe, expect, it } from "vitest";
// 给内联扩展加载器建立独立内存事件总线。
import { createEventBus } from "../src/core/event-bus.ts";
// 加载扩展工厂到未绑定会话的runtime，检查暂存注册，不启动真实Agent或模型请求。
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
// 被测管理客户端提供HTTP/轮询，LlamaProgress仅为进度对象的静态形状。
import { LlamaClient, type LlamaProgress, normalizeLlamaServerUrl } from "../src/extensions/llama/client.ts";
// HF客户端会注入假服务URL；token用例显式给HF_TOKEN字符串，避免读用户文件。
import { findHuggingFaceToken, HuggingFaceClient } from "../src/extensions/llama/huggingface.ts";
// 被测默认工厂注册Provider与/llama命令，这里不调用真实命令handler/TUI。
import llamaExtension from "../src/extensions/llama/index.ts";
// Provider控制器用于纯目录投影及网络刷新，固定ID用来验证注册归属。
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";

// 记录本测试文件创建的HTTP服务，afterEach只清理这些实例；这是可变数组，不含外部llama进程。
const servers: Server[] = [];

// 为一例创建127.0.0.1随机端口假服务，输入请求回调，返回服务及URL的Promise；例目录测试把url写入凭证。会监听本机端口，启动失败拒绝；不启动llama-server、不连外网，清理由afterEach统一处理。
async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	// 只创建Server并绑定request回调，还未开始监听；回调按请求到达时执行。
	const server = createServer(handler);
	// 先加入清理列表，之后listen失败时afterEach仍能尝试关闭此实例。
	servers.push(server);
	// 端口0让OS分配可用端口，显式127.0.0.1只绑回环地址，不用示例域名发外网请求。
	server.listen(0, "127.0.0.1");
	// 等listening再读地址；await不等于阻塞整个Node事件循环，error事件可使once Promise拒绝。
	await once(server, "listening");
	// TCP监听成功时预期地址对象；as AddressInfo仅告诉TS预期，不把null/字符串运行时变成对象。
	const address = server.address() as AddressInfo;
	// 返回原server引用与实际端口URL，新建结果对象不复制服务。
	return { server, url: `http://127.0.0.1:${address.port}` };
}

// 向本机请求回复200 JSON，输入响应和unknown数据，返回void；例json(res,{data:[]})结束响应。只序列化、不校验payload形状或处理循环对象异常，也不等待客户端读完。
function json(response: ServerResponse, value: unknown): void {
	// 明确状态200与JSON媒体类型，writeHead返回的响应仍由下一行写正文。
	response.writeHead(200, { "Content-Type": "application/json" });
	// JSON.stringify处理输入，end发送并结束当前响应，不是关闭整个监听服务；序列化/写入异常未在helper捕获。
	response.end(JSON.stringify(value));
}

// 每例后并发停止已登记服务并等close回调，返回Promise<void>；例SSE长连接通过closeAllConnections清掉。回调没接error参数，因此Promise兑现不证明没有关闭错误；不清理任意用户连接或真实模型。
afterEach(async () => {
	// Promise.all等所有服务清理Promise，空列表直接正常完成。
	await Promise.all(
		// splice(0)取走并清空登记数组，map为每个原服务创建一份清理工作，不修改Server对象身份。
		servers
			.splice(0)
			.map(
				// 箭头回调接一个被测Server，返回下方Promise供all等待。
				(server) =>
					// Promise<void>只表示清理完成信号，不返回关闭状态/错误。
					new Promise<void>((resolve) => {
						// 先停止接收新连接并登记回调；回调忽略可选err后resolve，不是断言关闭绝无异常。
						server.close(() => resolve());
						// 再关闭当前HTTP连接（含长SSE响应），让挂着的请求不拖住server.close；不是保证终止所有应用异步任务。
						server.closeAllConnections();
					}),
			),
	);
});

// 一组15个用例覆盖注册、URL、目录/缓存/分类、注入登录和本机HTTP/SSE；它不是和真实模型服务的端到端测试。
describe("llama.cpp extension", () => {
	// 纯内存验证工厂注册结果：创建runtime→加载工厂→查看命令/原生Provider待注册列表。无HTTP/登录/TUI；不证明命令handler真实交互已可用。
	it("registers a native provider and /llama command", async () => {
		// 未绑定会话的运行时允许暂存Provider注册，动作桩不在本例调用。
		const runtime = createExtensionRuntime();
		// await内联工厂初始化，不从磁盘动态导入一个外部扩展文件。
		const extension = await loadExtensionFromFactory(
			// 传实际llamaExtension函数引用，加载时仅执行其注册流程。
			llamaExtension,
			// process.cwd提供解析/扩展上下文基准，不在本例遍历用户模型文件。
			process.cwd(),
			// 新事件总线隔离本例扩展订阅状态。
			createEventBus(),
			// 共享此runtime以便最后查看暂存列表。
			runtime,
			// 合成来源名用于归属，不是要读取的真实文件路径。
			"builtin:llama.cpp",
		);

		// 可选链缺命令会得到undefined而断言失败；只比较description文字，不调用handler。
		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		// map只取待注册Provider的ID，期望精确单元素数组，不声称已绑定到Models或完成远端刷新。
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	// 纯字符串验证两个URL归一化例和非法协议拒绝，没有HTTP；仅覆盖所列输入，不保证任意重复/v1都被清空。
	it("normalizes management and inference URLs", () => {
		// 该单层/v1/输入去尾斜杠及一层/v1得到管理根，8080只是字符串未监听。
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		// 保留/prefix，删除其末尾一层/v1；example.com不被访问。
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		// 把调用包在函数里交toThrow，断言同步错误消息含http or https；不是await拒绝断言。
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	// 纯内存目录投影：提供4种状态，核loaded/sleeping进入聊天、未加载/加载中不进入，并核选定元数据。setCatalog不发HTTP，不证明模型实际加载或图像推理成功。
	it("exposes loaded and sleeping models with router metadata", () => {
		// 独立控制器初始目录空，分类器只是延迟能力对象。
		const controller = createLlamaProvider();
		// 同步替换输入目录，未传routerAutoload/props，因此不自动探服务开关或thinking。
		controller.setCatalog(
			// 数组顺序决定此处正常filter/map后的模型顺序。
			[
				// 第一条fixture把运行容量与训练容量设成不同数，便于确认优先级。
				{
					// id同时是目录展示/请求标识，不是被启动的模型文件。
					id: "loaded",
					// loaded状态允许选取；args里的GPU参数仅是元数据，本例不执行llama-server。
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					// 显式image输入声明用于验证聊天投影保留看图能力标记，不发送图片。
					architecture: { input_modalities: ["text", "image"] },
					// 运行65536应优先训练131072，两者均是手写测试数据。
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
				// sleeping按可被请求唤醒的目录约定列出，本例没有真唤醒动作。
				{ id: "sleeping", status: { value: "sleeping" } },
				// 未指定preset/开autoload的unloaded项不应出现。
				{ id: "unloaded", status: { value: "unloaded" } },
				// loading也不应被视为已经可选。
				{ id: "loading", status: { value: "loading" } },
			],
			// 管理地址仅用于拼模型baseUrl，纯投影不连接localhost。
			"http://localhost:8080",
		);

		// toEqual检查数组长度/顺序，但成员用objectContaining只比列出字段，其他字段未在此逐项验证。
		expect(controller.provider.getModels()).toEqual([
			// 首模型用部分对象匹配，允许cost等额外字段存在。
			expect.objectContaining({
				// 第一项应保留loaded ID。
				id: "loaded",
				// 推理URL应在这个管理根后加/v1。
				baseUrl: "http://localhost:8080/v1",
				// 运行上下文容量获优先，不被更大的训练容量覆盖。
				contextWindow: 65536,
				// 当前实现把目录maxTokens设成同一容量，本断言不验证真实输出上限。
				maxTokens: 65536,
				// 输入模态数组应精确text/image顺序。
				input: ["text", "image"],
			}),
			// 第二项只检查睡眠ID和地址，未断言它的默认容量等字段。
			expect.objectContaining({
				// 证明sleeping项仍列于聊天目录，不代表服务器此刻正占GPU。
				id: "sleeping",
				// 睡眠项同样用该根的/v1推理地址。
				baseUrl: "http://localhost:8080/v1",
			}),
		]);
	});

	// Regression test for #9528.
	// 回归#9528：本机/models给loaded项，/props模板含enable_thinking，刷新后核thinking映射。只验证目录能力发现及请求参数，不生成思考内容，不执行模板。
	it("discovers chat-template thinking support for loaded models", async () => {
		// 计数器仅统计本例/props请求，后面要求恰一次。
		let propsRequests = 0;
		// 请求回调闭包保存计数，listen仅创建本机假HTTP。
		const { url } = await listen((request, response) => {
			// /models分支返回目录，不需要请求体。
			if (request.url === "/models") {
				// 用统一200 JSON helper回复。
				json(response, {
					// 模型是loaded，确保刷新会读它的模板；32768是fixture容量。
					data: [{ id: "qwen", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
				});
				// 回复目录后return，避免继续落到404或props分支。
				return;
			}
			// 相对请求URL用localhost占位基准解析查询；这里只创建URL对象，不访问该基准域名。
			const requestUrl = new URL(request.url ?? "", "http://localhost");
			// 按pathname识别props，不把查询参数文字当路径本体。
			if (requestUrl.pathname === "/props") {
				// 本回调每进props分支计数一次。
				propsRequests++;
				// 核查目标model查询参数，未验证任意模型名的编码。
				expect(requestUrl.searchParams.get("model")).toBe("qwen");
				// 要求autoload=false，避免模板探测主动要求服务加载模型；是否服务真遵守不由假服务证明。
				expect(requestUrl.searchParams.get("autoload")).toBe("false");
				// 返回含关键字的字符串就足以触发当前includes检测，不需要真的Jinja渲染器。
				json(response, { chat_template: "{% if enable_thinking %}think{% endif %}" });
				// props响应完成后退出回调。
				return;
			}
			// 未知请求404使意外端点不静默成功。
			response.writeHead(404).end();
		});

		// 新Provider不继承前例目录，刷新后读自己的闭包状态。
		const controller = createLlamaProvider();
		// 可选方法存在才调用并await；若缺方法后面的目录断言仍会失败。
		await controller.provider.refreshModels?.({
			// 凭证URL固定指向本机假服务，local只是测试Bearer材料，不是真实令牌。
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			// 无存储条目，本次不先恢复缓存。
			stored: undefined,
			// 假publish输入publication，调用同步update并返回true；不实现真实存储/代次取消保障。
			publish: async (publication) => {
				// ?.仅有回调才执行，把新目录真正写回Provider闭包。
				publication.update?.();
				// 一律允许发布，故本例不覆盖publish=false/持久失败路径。
				return true;
			},
			// 允许调用本机服务；不是开启真实外部模型访问。
			allowNetwork: true,
			// 新未取消signal，不验证超时/取消场景。
			signal: new AbortController().signal,
		});

		// 断言仅查一次模板，不对所有HTTP总数作断言。
		expect(propsRequests).toBe(1);
		// 目录应为一个模型，内部objectContaining只核思考相关关键字段。
		expect(controller.provider.getModels()).toEqual([
			// 部分对象匹配，不要求对象没有其他属性。
			expect.objectContaining({
				// 模型身份仍为qwen。
				id: "qwen",
				// 模板关键字使reasoning目录标记true，不代表本次已发生思考推理。
				reasoning: true,
				// 映射对象逐项核对当前六档定义。
				thinkingLevelMap: {
					// off标记下游关闭值。
					off: "off",
					// minimal被目录声明为不支持。
					minimal: null,
					// low同样不支持。
					low: null,
					// medium为此目录支持的开启档位。
					medium: "medium",
					// high不支持，不自动映射到medium。
					high: null,
					// xhigh也不支持。
					xhigh: null,
				},
				// 兼容对象仅核thinkingFormat，其他兼容字段不在此用例逐项列出。
				compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
			}),
		]);
	});

	// 本机首次刷新把可选聊天/分类投影保存到内存变量，第二个Provider以allowNetwork=false恢复；验证目录与选定容量/API。假publish不写磁盘，也没统计离线阶段所有fetch次数，不声称证明真实存储锁/代次行为。
	it("persists and restores selectable models for cache-only startup refreshes", async () => {
		// let保留可缺目录快照，作为两次不同Provider之间的模拟存储。
		let cachedEntry: ModelsStoreEntry | undefined;
		// 假服务只处理本机目录和loaded模板查询。
		const { url } = await listen((request, response) => {
			// 目录端点分支。
			if (request.url === "/models") {
				// 200 JSON结构符合客户端期望的data数组。
				json(response, {
					// 三条不同状态用于验证选择资格。
					data: [
						// loaded提供正运行容量，刷新会额外读其模板。
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						// sleeping仍可选且容量同32768，但不应为它查询模板。
						{ id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx: 32768 } },
						// 普通unloaded未声明preset/开autoload，不进入新投影。
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				// 目录已回复，退出请求回调。
				return;
			}
			// 只有loaded的精确props URL接受，睡眠项若被错误探模板会落404。
			if (request.url === "/props?model=loaded&autoload=false") {
				// 空props使reasoning false，不改变目录容量。
				json(response, {});
				// 该请求完成后不继续404。
				return;
			}
			// 其他路径404便于暴露不期望请求。
			response.writeHead(404).end();
		});

		// 假发布器接ModelsPublication返回Promise<boolean>；支持删除/替换/不改缓存三态，再运行update。例恢复只传update时保留cachedEntry；没有真实I/O或代次校验。
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			// persist=null清空模拟目录，不等于本例实际执行了删除分支。
			if (publication.persist === null) cachedEntry = undefined;
			// 非undefined持久对象用structuredClone脱开对象引用；不是JSON序列化或实际写磁盘。
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			// 可选同步update应用Provider内存状态，回调异常会使这个async发布器拒绝。
			publication.update?.();
			// 假定发布始终允许，不测试返回false。
			return true;
		};
		// 第一次Provider负责联网发现目录。
		const first = createLlamaProvider();
		// 直接调用Provider刷新，不走完整Models.refresh的缓存/认证两阶段协调器。
		await first.provider.refreshModels?.({
			// 本机地址显式放env，避免环境变量读取。
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			// 起初cachedEntry为undefined，第一次没有恢复项。
			stored: cachedEntry,
			// 传前面建立的内存发布器引用。
			publish,
			// 允许本机HTTP刷新。
			allowNetwork: true,
			// 未取消signal，不测中途取消。
			signal: new AbortController().signal,
		});
		// 映射ID后精确比较聊天列表，证明此样本中只保留loaded/sleeping及顺序。
		expect(first.provider.getModels().map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		// 模拟持久条目应先聊天后分类，普通模型分类走标签概率回退。
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			// loaded的聊天投影。
			["loaded", "openai-completions"],
			// sleeping的聊天投影。
			["sleeping", "openai-completions"],
			// 同loaded ID的分类投影，种类/API不同可并存。
			["loaded", "llama-cpp-classify"],
			// 同sleeping ID也提供分类能力描述，不在此真正分类。
			["sleeping", "llama-cpp-classify"],
		]);

		// 全新控制器没有第一次实例的闭包目录，用来验证传存储快照确实恢复。
		const second = createLlamaProvider();
		// 第二次直接调用只缓存刷新。
		await second.provider.refreshModels?.({
			// 仍用同一份显式本机凭证，但allowNetwork=false应只走恢复分支。
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			// 传首次模拟保存的完整投影，不传原上游catalog。
			stored: cachedEntry,
			// 发布器仍只改内存，恢复publication没persist时保持快照。
			publish,
			// 本调用要求cache-only，不主动请求网络阶段；本例没有另装fetch计数器。
			allowNetwork: false,
			// 信号仍未取消。
			signal: new AbortController().signal,
		});
		// 数组长度/顺序严格，成员字段部分匹配。
		expect(second.provider.getModels()).toEqual([
			// loaded恢复原/v1地址与容量。
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
			// sleeping恢复同样的地址/容量，不从缺失meta重置默认。
			expect.objectContaining({ id: "sleeping", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
		// 全种类目录筛classifier后比较两项，type直接检查因分类模型标签必填。
		expect(second.provider.getAllModels?.().filter((model) => model.type === "classifier")).toEqual([
			// loaded分类仍保留根地址（非/v1），用于原生tokenize等回退端点。
			expect.objectContaining({ id: "loaded", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
			// sleeping分类也保留相同回退API/容量。
			expect.objectContaining({ id: "sleeping", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
		]);
	});

	// 分三次刷新核容量优先级：loaded保存65536→新实例恢复且unloaded preset继续65536→明确--ctx-size改32768。全靠本机假目录，非真实模型内存配置测量，也没覆盖所有flag/坏值组合。
	it("preserves cached llama.cpp context for unloaded autoload presets", async () => {
		// 跨阶段保存投影快照，非真实磁盘存储。
		let cachedEntry: ModelsStoreEntry | undefined;
		// 控制假服务器当前返回loaded还是unloaded的一块共享状态。
		let loaded = true;
		// 可选args随后设置，用于最后一轮覆盖旧缓存容量。
		let unloadedArgs: string[] | undefined;
		// 请求回调每次读取最新loaded/args变量，故同一假服务可模拟三阶段。
		const { url } = await listen((request, response) => {
			// /models返回随变量变化的目录。
			if (request.url === "/models") {
				// JSON helper把当下对象序列化，后面变量变化不会回改已发送正文。
				json(response, {
					// 只有同一ID一项，便于验证跨种类同ID容量缓存。
					data: [
						// 三元表达式根据当前loaded布尔选两份fixture之一。
						loaded
							? // 首次loaded分支的对象起点。
								{
									// 固定qwen ID保证缓存键相同。
									id: "qwen",
									// 首次是loaded，允许探模板。
									status: { value: "loaded" },
									// 标preset，为以后unloaded+autoload时保留可路由资格。
									source: "preset",
									// 65536运行值优先于128000训练值。
									meta: { n_ctx: 65536, n_ctx_train: 128000 },
								}
							: // 后续unloaded分支不含n_ctx。
								{
									// 保留同一ID，没有把卸载变成另一模型。
									id: "qwen",
									// 只有unloadedArgs真值时展开args字段，空/缺省时不添加；原args数组只作为测试数据，不执行命令。
									status: { value: "unloaded", ...(unloadedArgs && { args: unloadedArgs }) },
									// 来源仍preset，区别于普通cache/models_dir未加载项。
									source: "preset",
									// 仅训练容量128000，第二轮应被已存65536覆盖。
									meta: { n_ctx_train: 128000 },
								},
					],
				});
				// 目录请求响应后退出。
				return;
			}
			// 只接受loaded项的模板查询，不给未加载模型模拟模板加载副作用。
			if (request.url === "/props?model=qwen&autoload=false") {
				// 模板空，thinking未启用。
				json(response, {});
				// props完成返回。
				return;
			}
			// 没有model参数的props用于全局autoload探测。
			if (request.url === "/props") {
				// models_autoload=true让unloaded preset进入投影，role只是额外fixture字段，客户端不消费。
				json(response, { role: "router", models_autoload: true });
				// 全局props响应后退出。
				return;
			}
			// 未知路径404，不把测试遗漏端点当成功。
			response.writeHead(404).end();
		});

		// 内存发布器支持persist的删除/替换与可选update，返回true；本例主要执行保存/恢复，不证明真实存储原子性。
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			// 删除分支清空变量，保留接口三态含义。
			if (publication.persist === null) cachedEntry = undefined;
			// 非undefined条目深复制为模拟快照，避免同引用误充“存储恢复”。
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			// 运行同步update真正替换控制器列表。
			publication.update?.();
			// 返回true允许本次发布，不含代次闸门。
			return true;
		};
		// 无参数查询闭包返回模拟存储里所有模型的容量数组，不读文件；例聊天/分类各一条得到两个数。
		const storedContextWindows = () =>
			// ?.没缓存返回undefined；in用来从AnyModel联合收窄有contextWindow的种类，不假定图片模型也有该字段。
			cachedEntry?.models.map((model) => ("contextWindow" in model ? model.contextWindow : undefined));
		// as const只把type推导为字面量api_key，不在运行时冻结凭证对象/嵌套env。
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: url } };

		// 首次Provider初始目录空。
		const first = createLlamaProvider();
		// 第一轮从本机loaded目录刷新并保存。
		await first.provider.refreshModels?.({
			// 属性简写传显式本机凭证。
			credential,
			// 首次存储undefined。
			stored: cachedEntry,
			// 传同一内存发布器。
			publish,
			// 允许访问假服务。
			allowNetwork: true,
			// 独立未取消信号。
			signal: new AbortController().signal,
		});
		// 持久结果聊天/分类两份容量都应为运行n_ctx=65536。
		expect(storedContextWindows()).toEqual([65536, 65536]);

		// 切换假目录为unloaded状态，不是调用实际服务卸载API。
		loaded = false;
		// 第二个Provider没有上一次内存状态，只能从cachedEntry恢复容量。
		const second = createLlamaProvider();
		// 第二轮执行恢复再本机刷新。
		await second.provider.refreshModels?.({
			// 同URL/key凭证不变。
			credential,
			// 已保存的两份投影作为缓存输入。
			stored: cachedEntry,
			// 继续保存在同一内存变量。
			publish,
			// 仍允许联网，故本例不是只缓存恢复用例。
			allowNetwork: true,
			// 未取消信号，不验证超时。
			signal: new AbortController().signal,
		});
		// unloaded preset因autoload仍在聊天目录，容量应沿缓存65536，而非训练128000。
		expect(second.provider.getModels()).toEqual([expect.objectContaining({ id: "qwen", contextWindow: 65536 })]);
		// 新持久的聊天/分类容量也保持65536，不只检查可见聊天列表。
		expect(storedContextWindows()).toEqual([65536, 65536]);

		// 加入实际可解析--ctx-size参数作为第三轮fixture；llama-server只是args文字，不启动进程。
		unloadedArgs = ["llama-server", "--ctx-size", "32768"];
		// 复用第二Provider进行第三轮刷新。
		await second.provider.refreshModels?.({
			// 凭证仍是固定本机地址。
			credential,
			// 此时保存的容量仍为65536，供验证显式args有更高优先级。
			stored: cachedEntry,
			// 继续用内存发布器。
			publish,
			// 允许请求同一假服务。
			allowNetwork: true,
			// 另建未取消signal。
			signal: new AbortController().signal,
		});
		// 两种投影都应改为明确参数32768，证明这个样本中args优先缓存；未断言其他运行属性。
		expect(storedContextWindows()).toEqual([32768, 32768]);
	});

	// 本机目录含四类未加载项且autoload=true，验证仅健康preset可路由，并只探一次全局props。真实服务器是否可自动加载不在本例执行。
	it("exposes unloaded presets only when router autoload is enabled", async () => {
		// 只统计props端点次数，模型列表请求另行发生。
		let propsRequests = 0;
		// 本机服务处理固定数据，传入请求头可供断言。
		const { url } = await listen((request, response) => {
			// 所有本例管理请求应带Bearer local；只核头文字，不验证真实令牌。
			expect(request.headers.authorization).toBe("Bearer local");
			// /models路径返回候选状态集合。
			if (request.url === "/models") {
				// 回复200目录。
				json(response, {
					// 四项把preset资格与失败/来源区分开。
					data: [
						// 非失败preset且运行meta容量明确，应最终可选。
						{ id: "preset", status: { value: "unloaded" }, source: "preset", meta: { n_ctx: 65536 } },
						// 同为preset但failed=true，必须排除。
						{ id: "failed-preset", status: { value: "unloaded", failed: true }, source: "preset" },
						// 普通cache来源未加载，不因autoload开就允许。
						{ id: "cache", status: { value: "unloaded" }, source: "cache" },
						// models_dir来源未加载也不等同preset。
						{ id: "models-dir", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				// 目录响应结束。
				return;
			}
			// 仅全局props分支提供自动加载开关。
			if (request.url === "/props") {
				// 统计这次探测，不逐模型增加计数。
				propsRequests++;
				// models_autoload严格true，role不参与被测客户端输出。
				json(response, { role: "router", models_autoload: true });
				// props正常退出。
				return;
			}
			// 其他请求404，本例预期无需逐模型props。
			response.writeHead(404).end();
		});

		// 存储仅为当前用例内存变量，起初undefined。
		let cachedEntry: ModelsStoreEntry | undefined;
		// 建立独立Provider控制器。
		const controller = createLlamaProvider();
		// 直接进入Provider网络刷新接口。
		await controller.provider.refreshModels?.({
			// 显式url和local key，不查真实服务环境。
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			// 无缓存恢复项。
			stored: undefined,
			// 假publish只保存非空persist对象并执行update，不支持真实持久错误/代次取消。
			publish: async (publication) => {
				// 排除undefined（不改）和null（删除），本回调未实现删除动作。
				if (publication.persist !== undefined && publication.persist !== null) {
					// 深复制持久对象供后面检查，不写磁盘。
					cachedEntry = structuredClone(publication.persist);
				}
				// 应用内存更新回调。
				publication.update?.();
				// 始终true，不测试过期发布。
				return true;
			},
			// 允许本机请求。
			allowNetwork: true,
			// 新未取消signal。
			signal: new AbortController().signal,
		});

		// 一轮全局props即可确定autoload，未对未加载模型逐个取模板。
		expect(propsRequests).toBe(1);
		// 聊天列表只剩健康preset，其余三项被过滤。
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["preset"]);
		// 保存列表包含同preset的聊天与回退分类投影。
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			// 聊天协议为openai-completions。
			["preset", "openai-completions"],
			// 同ID分类使用llama-cpp-classify，而非原生决策协议。
			["preset", "llama-cpp-classify"],
		]);
	});

	// 用本机tokenize/apply-template/completion假响应跑真实回退分类适配流程，期望B高于A映成ci。核答案与端点，不测真实模型质量/分词词表，也没逐项断言所有请求负载。
	it("classifies with selectable models through llama-server", async () => {
		// 收集本例完整收到正文的请求路径，后面检查至少含/completion。
		const paths: string[] = [];
		// 固定本机假HTTP处理器，不调用llama推理进程。
		const { url } = await listen((request, response) => {
			// 每个请求单独累积正文字符串，没有在fixture加大小上限。
			let body = "";
			// 监听data取得若干Buffer/块，不假定一次就收到完整JSON。
			request.on("data", (chunk) => {
				// 字符串+=会把块转文字，此简单fixture未用StringDecoder处理任意UTF-8分块边界。
				body += chunk;
			});
			// end表示请求正文读完，随后才JSON.parse；回调异常不是通过Promise返回给请求方。
			request.on("end", () => {
				// 保存请求URL，缺少时空串；该列表不做去重。
				paths.push(request.url ?? "");
				// as仅提供fixture期望字段类型，不校验JSON实际形状；坏JSON会同步抛出。
				const payload = JSON.parse(body) as { model: string; content?: string };
				// 所有分类辅助请求都应带qwen模型ID。
				expect(payload.model).toBe("qwen");
				// 分词端点按输入文本生成确定性的假token数组。
				if (request.url === "/tokenize") {
					// 展开字符串按Unicode码点迭代，codePointAt(0)模拟token ID；不是llama词表，也没有真的加载分词器。
					json(response, { tokens: [...(payload.content ?? "")].map((char) => char.codePointAt(0)) });
					// 应用模板端点返回固定prompt，不真正渲染收到的messages。
				} else if (request.url === "/apply-template") {
					// 固定assistant前缀供下一token读取，模板字符串内容没有被执行为代码。
					json(response, { prompt: "<|im_start|>assistant\n" });
					// 最终completion端点给概率表，不返回真实生成文本。
				} else if (request.url === "/completion") {
					// 200 JSON回复概率结构。
					json(response, {
						// completion_probabilities首位置结构符合回退适配器读取路径。
						completion_probabilities: [
							{
								// top_logprobs列出两枚目标标签对应的数值。
								top_logprobs: [
									// B的logprob=-0.1高于A，归一化后选择第二个业务候选ci。
									{ id: 66, token: "B", logprob: -0.1 },
									// A的logprob=-2.4较低，保留以满足“所有标签都入榜”的要求。
									{ id: 65, token: "A", logprob: -2.4 },
								],
							},
						],
					});
					// 未知端点走失败分支，不提供空成功兜底。
				} else {
					// 结束404响应，便于发现适配器用了别的路径。
					response.writeHead(404).end();
				}
			});
		});

		// 控制器提供当前可选模型的分类投影。
		const controller = createLlamaProvider();
		// 目录同步纯内存，loaded普通模型同时得到回退classifier。
		controller.setCatalog([{ id: "qwen", status: { value: "loaded" } }], url);
		// 从全种类列表找第一条显式classifier类型，不从getModels聊天数组里取。
		const classifier = controller.provider.getAllModels?.().find((model) => model.type === "classifier");
		// 真实运行守卫既防缺项又让TS收窄classifier，非空断言并不能代替这条判断。
		if (classifier?.type !== "classifier") throw new Error("missing classifier model");

		// Provider auth resolves the OpenAI-compatible /v1 URL, which replaces the model's base URL.
		// !仅断言classify方法存在，调用其延迟适配器；返回Promise结果仍需查error/答案。
		const result = await controller.provider.classify!(
			// 浅展开分类模型并模拟认证层把baseUrl覆盖成/v1，回退适配器应剥该尾段再用原生根端点。
			{ ...classifier, baseUrl: `${url}/v1` },
			// 分类上下文对象，包含状态与问题而不是聊天消息数组。
			{
				// 固定用户状态文字，测试不向外部模型发送。
				state: { message: "The build is red again." },
				// 以问题键kind组织待分类问题。
				questions: {
					// 两个业务候选按对象枚举顺序对应A/B标签；固定表应使ci获选，不是从字面句意推导结果。
					kind: { type: "choice", instructions: "What is this about?", criteria: { billing: "", ci: "" } },
				},
			},
			// 显式测试key用于本机认证头，不读真实凭证。
			{ apiKey: "local" },
		);

		// 先核结果没有errorMessage；单有Promise兑现不能保证分类成功。
		expect(result.errorMessage).toBeUndefined();
		// 部分匹配type和choice，不在本例精确比较confidence或完整概率分布。
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "ci" });
		// 只证明路径列表包含一次或多次/completion，不断言恰一次或其他端点调用总数。
		expect(paths).toContain("/completion");
	});

	// 本机目录报告text/decisions/旧模型，刷新时区分聊天与原生分类，再执行一次bool→noul协议并恢复缓存。验证所列请求/目录/答案，不探真实模型或证明服务完整能力。
	it("exposes decision models reported by the catalog as native System One classifiers", async () => {
		// 记录读取了哪些模型的模板，后面不依并发完成顺序比较。
		const propsModels: string[] = [];
		// 收集System One请求体，刷新前应空，真正classify后应一项。
		const systemOneRequests: unknown[] = [];
		// 本机HTTP回调同时服务目录、模板与原生分类端点。
		const { url } = await listen((request, response) => {
			// 每次请求独立的正文累积器。
			let body = "";
			// 监听输入正文块。
			request.on("data", (chunk) => {
				// 追加块到字符串；这里是固定ASCII测试JSON，不模拟任意大正文/多字节边界。
				body += chunk;
			});
			// 读完正文再分派/解析，GET也会触发end且body为空。
			request.on("end", () => {
				// 用URL解析路径/查询；localhost只作相对解析基准，没有网络访问。
				const requestUrl = new URL(request.url ?? "", "http://localhost");
				// 目录GET分支不解析空body。
				if (requestUrl.pathname === "/models") {
					// 返回200 JSON目录。
					json(response, {
						// 混合四项用来区分普通聊天、纯decisions、睡眠decisions和缺architecture旧项。
						data: [
							// 第一条为明确text聊天样本。
							{
								// qwen保留普通模型ID。
								id: "qwen",
								// loaded意味着刷新会取它的模板。
								status: { value: "loaded" },
								// text输入/text输出，非decisions，分类使用回退协议。
								architecture: { input_modalities: ["text"], output_modalities: ["text"] },
								// 手写运行容量32768，不实际分配上下文内存。
								meta: { n_ctx: 32768 },
							},
							// 第二条为纯原生决策样本。
							{
								// kev是后面真正调用分类时使用的ID。
								id: "kev",
								// loaded也不该因为状态就自动按聊天列出。
								status: { value: "loaded" },
								// 只输出decisions、不含text，因此排出聊天但列原生classifier。
								architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
								// 8192容量用于后面原生分类目录断言。
								meta: { n_ctx: 8192 },
							},
							// 第三条原生决策模型模拟睡眠状态。
							{
								// laya ID用于缓存列表检查，不在本例实际执行其分类。
								id: "laya",
								// sleeping仍可选，不主动唤醒以探模板。
								status: { value: "sleeping" },
								// decisions-only明确分类能力，不作为聊天项。
								architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
							},
							// Servers before llama.cpp 0.6.0 may omit architecture.
							// 旧服务缺architecture，当前兼容策略按普通聊天模型并提供回退分类；这只是样本，不运行旧服务器。
							{ id: "legacy", status: { value: "loaded" } },
						],
					});
					// 已回复目录，退出当前请求回调。
					return;
				}
				// 模板查询只记目标模型，不提供实际模板正文。
				if (requestUrl.pathname === "/props") {
					// 取model查询值，缺失记空串，后面应只含legacy/qwen。
					propsModels.push(requestUrl.searchParams.get("model") ?? "");
					// 空props让两个聊天项reasoning=false，和原生分类无关。
					json(response, {});
					// props响应完成后退出。
					return;
				}
				// 原生分类请求走/v1/systemone，不应在目录刷新时探测此端点。
				if (requestUrl.pathname === "/v1/systemone") {
					// 把固定JSON断言成含model/questions的形状；as不验证外部输入，适用这里受控fixture。
					const payload = JSON.parse(body) as { model: string; questions: Record<string, unknown> };
					// 保存收到的原请求体，后面精确核bool已转换为wire noul。
					systemOneRequests.push(payload);
					// 根据本次请求问题键构造假响应，不使用真实模型推理。
					json(response, {
						// 响应model回显请求ID。
						model: payload.model,
						// Object.fromEntries把问题键/固定答案元组变成对象，不在这里输出数组。
						answers: Object.fromEntries(
							// 每个问题都回noul=0.82；字面值代表公共bool概率，不是二元true/false结论。
							Object.keys(payload.questions).map((id) => [id, { type: "noul", noul: 0.82 }]),
						),
						// 伪造42输入/0输出用量，仅用于验证字段映射，不是测得真实token数。
						usage: { input_tokens: 42, output_tokens: 0 },
					});
					// 原生分类响应完成返回。
					return;
				}
				// 未识别端点404，不自动代理到外网。
				response.writeHead(404).end();
			});
		});

		// 内存变量接收发布条目，没有真实缓存文件。
		let cachedEntry: ModelsStoreEntry | undefined;
		// 模拟publication保存对象/执行同步update并返回true；省略真实存储/代次闸门，不覆盖删除persist=null动作。
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			// 仅非undefined且非null时替换模拟缓存，其他情况不变。
			if (publication.persist !== undefined && publication.persist !== null) {
				// structuredClone脱开模型对象引用，后面恢复读的是快照而非第一实例私有数组。
				cachedEntry = structuredClone(publication.persist);
			}
			// 存在update时同步应用本Provider目录。
			publication.update?.();
			// 一律接受发布，本例不测试false/取消发布。
			return true;
		};
		// as const收窄type字面量，仍是普通可变对象，不是运行时冻结。
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: url } };
		// 独立控制器初始目录为空。
		const controller = createLlamaProvider();
		// 直接Provider刷新，跳过Models.refresh完整认证/代次装配层。
		await controller.provider.refreshModels?.({
			// 显式本机凭证，所有HTTP由该地址构造。
			credential,
			// 首次无存储快照，未先恢复旧目录。
			stored: undefined,
			// 用假发布器捕获混合种类投影。
			publish,
			// 允许访问本机假服务。
			allowNetwork: true,
			// 未取消signal，不测试超时。
			signal: new AbortController().signal,
		});

		// The catalog identifies decision models, so a refresh neither probes them nor reads their chat template.
		// 到刷新完成时还没有System One请求，证明本样本没有主动探分类端点。
		expect(systemOneRequests).toEqual([]);
		// sort就地排序记录数组，再精确比较完整数组，避免依赖Promise.all中props请求到达顺序；重复项也会让断言失败，只应取两聊天模板。
		expect(propsModels.sort()).toEqual(["legacy", "qwen"]);
		// 聊天目录按原catalog过滤顺序为qwen/legacy，不包含纯decisions项。
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["qwen", "legacy"]);
		// 持久快照逐条映成ID/API/baseUrl三元数组比较，未逐字段断言全部模型元数据。
		expect(cachedEntry?.models.map((model) => [model.id, model.api, model.baseUrl])).toEqual([
			// qwen聊天走/v1的Completions协议。
			["qwen", "openai-completions", `${url}/v1`],
			// legacy同样按兼容聊天处理。
			["legacy", "openai-completions", `${url}/v1`],
			// 普通qwen的分类投影走管理根原生端点，不是System One。
			["qwen", "llama-cpp-classify", url],
			// kev原生决策投影用typesafe-system-one和/v1。
			["kev", "typesafe-system-one", `${url}/v1`],
			// 睡眠laya也以原生分类协议保留，无模板查询。
			["laya", "typesafe-system-one", `${url}/v1`],
			// legacy缺decisions信息所以只提供回退分类协议。
			["legacy", "llama-cpp-classify", url],
		]);

		// 从全目录按ID取kev；纯decisions项没有同ID聊天投影。
		const kev = controller.provider.getAllModels?.().find((model) => model.id === "kev");
		// 缺项/错误种类立即失败并让TS在后文收窄，不是用as跳过判断。
		if (kev?.type !== "classifier") throw new Error("missing decision classifier model");
		// 明确比较kev运行上下文8192，未检验服务实际接受这么大输入。
		expect(kev.contextWindow).toBe(8192);
		// 非空断言classify方法后执行真正适配函数，但目的地仍是假本机HTTP。
		const result = await controller.provider.classify!(
			// 传原生分类模型目录，包含/v1基础地址。
			kev,
			// 上下文是state/questions，非聊天messages。
			{
				// 固定输入状态字符串仅供请求体序列化断言。
				state: { message: "I was charged twice." },
				// 问题键保留angry，后续请求/答案都应同键。
				questions: {
					// 公共bool问题的完整定义。
					angry: {
						// 公共API写bool，共享层将wire改为noul。
						type: "bool",
						// 问题说明应在转换后原样保留。
						instructions: "Is the customer angry?",
						// true/false两个标准键为分类标准说明，不是已经计算出的答案。
						criteria: { true: "angry", false: "calm" },
					},
				},
			},
			// 测试apiKey显式local，不执行真实认证。
			{ apiKey: "local" },
		);
		// 检查无错误消息；Promise正常返回仍可能带错误结果，不能只依await判断成功。
		expect(result.errorMessage).toBeUndefined();
		// wire noul=0.82应转公共{type:bool,probability:0.82}，不产生布尔true字段。
		expect(result.answers.angry).toEqual({ type: "bool", probability: 0.82 });
		// toMatchObject只核usage两个计数字段，其他成本/总量字段允许存在。
		expect(result.usage).toMatchObject({ input: 42, output: 0 });
		// 精确检查只收到一份请求体及其内容，不把它误作模型回答本身。
		expect(systemOneRequests).toEqual([
			// 预期原生请求外壳对象。
			{
				// 请求model必须为kev。
				model: "kev",
				// 状态字段保持原文字，不被替换成chat消息。
				state: { message: "I was charged twice." },
				// 请求问题字典应保留原键。
				questions: {
					// angry问题的wire结构。
					angry: {
						// 公共bool已转换为noul，而不是直接发bool。
						type: "noul",
						// instructions原样透传。
						instructions: "Is the customer angry?",
						// criteria的true/false说明原样保留，不在此改成概率数字。
						criteria: { true: "angry", false: "calm" },
					},
				},
			},
		]);

		// A cache-only startup restores decision models with their native API.
		// 新控制器证明不是依赖前一个实例的内存目录。
		const restored = createLlamaProvider();
		// 只缓存刷新，不再执行原生分类。
		await restored.provider.refreshModels?.({
			// 同一本机凭证，仍明确禁止网络阶段。
			credential,
			// 使用已保存的混合模型投影。
			stored: cachedEntry,
			// 继续用假publish应用恢复回调，不写磁盘。
			publish,
			// allowNetwork=false使本次仅恢复目录；此处未再断言网络请求计数。
			allowNetwork: false,
			// 未取消信号，使恢复可正常运行。
			signal: new AbortController().signal,
		});
		// 恢复后聊天仍仅qwen/legacy，纯决策模型不被混进聊天目录。
		expect(restored.provider.getModels().map((model) => model.id)).toEqual(["qwen", "legacy"]);
		// 多行expect的实参由下方方法链计算，最终只比较分类ID/API。
		expect(
			// 使用新控制器自己的Provider。
			restored.provider
				// 可选全种类方法调用，存在时取得聊天+分类列表。
				.getAllModels?.()
				// 筛出classifier，省略chat的type不影响此分支。
				.filter((model) => model.type === "classifier")
				// 映射为二维数组便于精确比较顺序/协议。
				.map((model) => [model.id, model.api]),
		).toEqual([
			// 普通qwen分类仍是回退协议。
			["qwen", "llama-cpp-classify"],
			// kev缓存保留原生API。
			["kev", "typesafe-system-one"],
			// sleeping laya缓存也保留原生API，不需要重新探测。
			["laya", "typesafe-system-one"],
			// legacy仍按旧目录兼容策略走回退分类。
			["legacy", "llama-cpp-classify"],
		]);
	});

	// 纯内存核hybrid输出text+decisions可同时聊天/原生分类，decisions-only只能分类；不发HTTP或运行模型，覆盖这两样本的模态分流。
	it("lists decision models that also output text for chat", () => {
		// 新控制器与其他用例状态独立。
		const controller = createLlamaProvider();
		// 同步setCatalog，无props探测/缓存持久化。
		controller.setCatalog(
			// 两条fixture保留输入顺序。
			[
				// decide是睡眠的纯decisions项，只能出现在分类列表。
				{ id: "decide", status: { value: "sleeping" }, architecture: { output_modalities: ["decisions"] } },
				// 第二条hybrid同时提供两种输出能力。
				{
					// hybrid ID用于聊天与分类双投影。
					id: "hybrid",
					// loaded状态使该项具可选资格，但本函数未取模板所以不推thinking。
					status: { value: "loaded" },
					// text使它能聊天，decisions使分类走原生而非回退。
					architecture: { output_modalities: ["text", "decisions"] },
				},
			],
			// localhost地址只作目录字符串，不连接端口。
			"http://localhost:8080",
		);
		// 聊天只剩hybrid，数组顺序/长度精确比较。
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["hybrid"]);
		// 对全种类列表取分类视图再检查两项API。
		expect(
			// 读取当前Provider对象。
			controller.provider
				// 同步getAllModels返回新数组，非HTTP目录请求。
				.getAllModels?.()
				// 过滤显式classifier标签。
				.filter((model) => model.type === "classifier")
				// 只比ID/API，不在本例比较上下文/成本等字段。
				.map((model) => [model.id, model.api]),
		).toEqual([
			// decisions-only项仍提供原生分类。
			["decide", "typesafe-system-one"],
			// hybrid的分类也走原生System One，而聊天同时走Completions。
			["hybrid", "typesafe-system-one"],
		]);
	});

	// 本机props关闭autoload，未加载preset不应进入聊天；核目录空，不测试服务真的拒绝加载，也不在此调用classify。
	it("hides unloaded presets when router autoload is disabled", async () => {
		// 监听固定127.0.0.1随机端口假服务。
		const { url } = await listen((request, response) => {
			// 目录分支给一个未加载preset。
			if (request.url === "/models") {
				// data数组的status/source足够触发全局autoload探测，无运行容量。
				json(response, { data: [{ id: "preset", status: { value: "unloaded" }, source: "preset" }] });
				// 回复后退出，避免404。
				return;
			}
			// 全局props明确返回false。
			if (request.url === "/props") {
				// 严格false应使preset不可选，role字段不参与客户端逻辑。
				json(response, { role: "router", models_autoload: false });
				// props响应完成返回。
				return;
			}
			// 其他端点404，若错误探单模型props会导致刷新失败。
			response.writeHead(404).end();
		});

		// 独立控制器初始无目录。
		const controller = createLlamaProvider();
		// 直接刷新Provider，不经过完整Models集合流程。
		await controller.provider.refreshModels?.({
			// 显式本机地址和测试key，不查外部认证。
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			// 无存储目录可恢复。
			stored: undefined,
			// 假发布器仅调用update返回true，不保留持久对象用于断言。
			publish: async (publication) => {
				// 可选update应用得到的空模型列表。
				publication.update?.();
				// 假定发布始终有效，不测试代次闸门。
				return true;
			},
			// 允许假HTTP读取开关。
			allowNetwork: true,
			// 未取消signal。
			signal: new AbortController().signal,
		});

		// 聊天列表必须空；本例没有另断言分类列表/请求总数。
		expect(controller.provider.getModels()).toEqual([]);
	});

	// 先用注入空环境确认无配置，再用假prompt输入本机URL/key，核login返回凭证及resolve装配。没有真实登录UI、凭证写盘、外网认证或用户token；“optional key”标题在本例只覆盖非空secret，空key另不验证。
	it("stays dormant until configured and stores URL plus optional key", async () => {
		// 取新控制器里的Provider对象。
		const { provider } = createLlamaProvider();
		// !是非空断言，因为此实现提供apiKey方法；运行时不会额外校验它存在。
		const auth = provider.auth.apiKey!;
		// AuthContext对象由本例实现，代替真实环境/文件探测。
		const emptyContext: AuthContext = {
			// 任何环境名都返回undefined，所以check/resolve不读process.env实际key。
			env: async () => undefined,
			// 任何文件探测都返回false；llama认证本身也不需要该方法读文件。
			fileExists: async () => false,
		};
		// 同一个未取消signal贯穿下列认证调用。
		const signal = new AbortController().signal;
		// 无配置时check应undefined；可选方法缺失也可使这条断言通过，因此它单独不证明check必然被实现。
		expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined();
		// resolve是必需方法，空环境无凭证应返回undefined，不自动采用默认8080。
		expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined();

		// 假登录验证请求仍只到本机服务。
		const { url } = await listen((request, response) => {
			// 服务断言请求带Bearer secret，不真实校验令牌权限。
			expect(request.headers.authorization).toBe("Bearer secret");
			// data空数组仍是有效路由目录形状，没有加载任何模型。
			json(response, { data: [] });
		});
		// 有序答案先URL再secret，代替两个真实输入框。
		const answers = [url, "secret"];
		// 调用真实login流程但交互完全注入，它只查此假服务目录后返回材料，不通过Models.login写存储。
		const credential = await auth.login!({
			// 传未取消signal到客户端GET。
			signal,
			// _prompt类型为AuthPrompt但故意不检查提示内容；shift取下一答案，!只静态消除undefined，两题数量靠fixture约定。
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			// 空通知函数避免界面副作用，不创建TTY组件。
			notify: () => {},
		});
		// 精确比较返回凭证对象，不证明已保存到auth.json。
		expect(credential).toEqual({
			// 凭证类别是api_key，不是OAuth。
			type: "api_key",
			// key保留非空测试secret。
			key: "secret",
			// env保存规范管理根url，不写宿主环境。
			env: { LLAMA_BASE_URL: url },
		});
		// 给同一空环境加凭证后应可解析，验证存储配置优先而非环境发现。
		expect(await auth.resolve({ ctx: emptyContext, credential, signal })).toEqual({
			// 请求认证保留secret，并把本机管理URL变/v1推理地址。
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			// 供应商env继续保存管理根。
			env: { LLAMA_BASE_URL: url },
			// 来源标签为stored credential；本例不测试凭证仅有key但URL回退环境时的标签细节。
			source: "stored credential",
		});
	});

	// 注入本机HF假服务测试搜索参数、分片大小汇总/推荐排序、访问限制以及显式环境token trim。无真实HF HTTP/模型文件/用户token；只验证这组固定响应，不证明任意GGUF仓库分片完整或访问已获准。
	it("searches Hugging Face and reads quantizations plus access requirements", async () => {
		// 本机服务处理/api/models搜索与仓库详情两条路径。
		const { url } = await listen((request, response) => {
			// 两种请求都应带测试hf-secret头，不是验证真实HF账号。
			expect(request.headers.authorization).toBe("Bearer hf-secret");
			// 可选url以搜索前缀开头才进入参数检查。
			if (request.url?.startsWith("/api/models?")) {
				// URL对象解析请求参数，localhost只是基准不访问。
				const requestUrl = new URL(request.url, "http://localhost");
				// 带空格的search应经URLSearchParams编码/解码后还原qwen coder。
				expect(requestUrl.searchParams.get("search")).toBe("qwen coder");
				// 请求gguf筛选参数，不等于返回仓库实际文件一定有效。
				expect(requestUrl.searchParams.get("filter")).toBe("gguf");
				// 核按downloads排序请求；本例没断言direction/limit参数。
				expect(requestUrl.searchParams.get("sort")).toBe("downloads");
				// 假搜索只返回一条确定结果及下载次数。
				json(response, [{ id: "owner/model-GGUF", downloads: 1200 }]);
				// 搜索响应后退出。
				return;
			}
			// 详情URL含blobs=true，固定路径避免真实远程仓库查找。
			if (request.url === "/api/models/owner/model-GGUF?blobs=true") {
				// 返回仓库文件元数据，不发送模型文件字节。
				json(response, {
					// 详情ID保持owner/model-GGUF。
					id: "owner/model-GGUF",
					// manual只用于权限提示，不在此执行网页审批。
					gated: "manual",
					// siblings是文件列表，供量化名识别与大小累加。
					siblings: [
						// 单片Q5_K_M大小6000，用来比较推荐项和大小顺序。
						{ rfilename: "model-Q5_K_M.gguf", size: 6000 },
						// Q4_K_M第一分片2000。
						{ rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2000 },
						// 同名量化第二分片3000，汇总应5000；测试未模拟缺片/重复条目。
						{ rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3000 },
						// mmproj投影文件即使带F16也应被排除，不作为单独量化。
						{ rfilename: "mmproj-F16.gguf", size: 1000 },
					],
				});
				// 详情响应结束。
				return;
			}
			// 其他请求404，不代理真实HF。
			response.writeHead(404).end();
		});
		// 第二构造参数注入本机URL，令默认官方域名不参与这些请求。
		const client = new HuggingFaceClient("hf-secret", url);

		// search实际HTTP后结果精确比对ID/下载次数，无额外分页或真实下载。
		expect(await client.search("qwen coder")).toEqual([{ id: "owner/model-GGUF", downloads: 1200 }]);
		// details返回转换后的精简对象，精确检查指定字段/数组顺序。
		expect(await client.details("owner/model-GGUF")).toEqual({
			// 详情ID沿响应值保留。
			id: "owner/model-GGUF",
			// manual访问类型被识别，不等于本地token已经获准。
			gated: "manual",
			// 量化输出不含mmproj项。
			quantizations: [
				// 推荐Q4_K_M优先，两个分片累计5000。
				{ name: "Q4_K_M", size: 5000 },
				// Q5_K_M保留6000，排在推荐项后面。
				{ name: "Q5_K_M", size: 6000 },
			],
		});
		// 显式HF_TOKEN非空后立即返回trim值，不访问HF_TOKEN_PATH或用户默认缓存文件。
		expect(await findHuggingFaceToken({ HF_TOKEN: " hf-secret " })).toBe("hf-secret");
	});

	// 本机假POST把状态从unloaded变loading，再20ms后发SSE进度/loaded并让目录也loaded，核返回状态和至少一条进度。未证明纯SSE缺目录分支、取消或20ms性能界限；不是启动真实模型。
	it("loads with SSE progress and waits for the loaded catalog state", async () => {
		// 字面量联合限制fixture变量三种状态，初始unloaded，不是真实服务状态枚举全集。
		let status: "unloaded" | "loading" | "loaded" = "unloaded";
		// Set保存已建立SSE响应引用，去掉相同对象重复，不是事件历史缓存。
		const streams = new Set<ServerResponse>();
		// 发送闭包输入unknown事件返回void，对当前每条SSE响应写一帧；例status_change含progress。没有背压等待/事件重试，Set空就不写。
		const send = (event: unknown) => {
			// JSON序列化后包data行和空行分隔，response.write布尔未检查；模板仅运行字符串插值不执行JSON内容。
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		// 本机服务同时接受SSE订阅、加载POST和目录GET。
		const { url } = await listen((request, response) => {
			// 客户端watch请求此SSE端点，保持响应不end。
			if (request.url === "/models/sse") {
				// 200加text/event-stream表示连续事件响应，不是单个JSON对象。
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				// 把该响应放活跃订阅集合，后面send向它写。
				streams.add(response);
				// 请求发close事件时删响应引用；这不是加载工作完成信号，也不单独证明SSE响应或远端进程已结束。
				request.on("close", () => streams.delete(response));
				// return只结束回调，不关闭长响应。
				return;
			}
			// 路径和POST方法都满足才开始模拟加载，GET不会触发状态转换。
			if (request.url === "/models/load" && request.method === "POST") {
				// 立即设loading，让后续目录轮询看见中间状态。
				status = "loading";
				// POST受理先返回success:true，它本身不代表加载完成。
				json(response, { success: true });
				// 排一个20ms计时器稍后改状态/发事件，不保证精确20ms执行或测试证明加载时延。
				setTimeout(() => {
					// 先发加载中进度，订阅若尚未建立就可能收不到这帧，fixture未实现事件缓冲。
					send({
						// 事件model须匹配客户端关注的test-model。
						model: "test-model",
						// status_change是客户端认可的状态事件名字。
						event: "status_change",
						// 事件data包含状态与可解析进度结构。
						data: {
							// 此帧仍loading，还不能作为最终成功。
							status: "loading",
							// 两个stage中的第一个进度0.5供转换出Loading text model；本例不精确断言合成ratio。
							progress: { stages: ["text_model", "mmproj_model"], current: "text_model", value: 0.5 },
						},
					});
					// 同一计时器接着把目录状态改loaded，轮询也能确认成功。
					status = "loaded";
					// 再发loaded事件，客户端可同时记录事件标记；不是只依POST success完成。
					send({ model: "test-model", event: "status_change", data: { status: "loaded" } });
					// 20是调度延迟，不是HTTP超时或性能上限断言。
				}, 20);
				// POST分支退出，不再404。
				return;
			}
			// 目录GET每次反映共享status当时值。
			if (request.url === "/models") {
				// 把固定ID和当前状态作为data数组返回，不需要真实模型数据。
				json(response, { data: [{ id: "test-model", status: { value: status } }] });
				// 目录已响应后返回。
				return;
			}
			// 未知请求404，不访问外部地址。
			response.writeHead(404).end();
		});

		// 进度仅收集message字符串，未保留所有ratio/detail以便断言。
		const progress: string[] = [];
		// 客户端真实执行本机POST/watch/轮询；回调每次push消息，loadAndWait返回自己的结果项。
		const model = await new LlamaClient(url).loadAndWait("test-model", (entry) => progress.push(entry.message));
		// 最终返回条目应loaded，未检查本机文件/实际推理能力。
		expect(model.status.value).toBe("loaded");
		// 只要求至少出现一次Loading text model，不断言事件完整顺序、数量或所有进度阶段。
		expect(progress).toContain("Loading text model");
	});

	// 本机POST后模拟字节进度/完成事件与unloaded目录，核返回刷新目录和一条0.5进度。没有实际模型下载，也没验证取消、网络重试或reload查询是否恰一次；example文件URL只是事件键，不被fetch。
	it("downloads with byte progress and returns the refreshed catalog", async () => {
		// missing只属fixture“目录没有项”的状态，发送目录时会转空数组，未把missing伪造成客户端支持的LlamaModelStatus。
		let status: "missing" | "downloading" | "unloaded" = "missing";
		// 活跃SSE响应Set，每个请求单独持有响应对象。
		const streams = new Set<ServerResponse>();
		// 广播闭包输入unknown返回void，给当前SSE响应写JSON帧，无背压/缓冲保障；例download_progress带字节累计值。
		const send = (event: unknown) => {
			// data:和双LF形成SSE帧边界，模板内容保持原样，write结果不参与重试。
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		// 本机服务处理SSE订阅、下载POST及各种/models前缀目录查询。
		const { url } = await listen((request, response) => {
			// SSE订阅分支保持长连接。
			if (request.url === "/models/sse") {
				// 明确连续事件媒体类型，不结束响应正文。
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				// 登记活跃流供send使用。
				streams.add(response);
				// 请求close从Set移除引用，不是对下载工作的取消确认。
				request.on("close", () => streams.delete(response));
				// 只退出handler，响应继续等待事件。
				return;
			}
			// 精确/models且POST才模拟下载受理。
			if (request.url === "/models" && request.method === "POST") {
				// 先置downloading，使轮询可能看见进度中状态。
				status = "downloading";
				// 先发success响应，之后才由计时器模拟完成。
				json(response, { success: true });
				// 20ms后发送事件并改目录，不表示真实下载速度或严格调度期限。
				setTimeout(() => {
					// 广播一条字节进度事件，不读取远程文件。
					send({
						// 事件模型标识必须匹配downloadAndWait参数。
						model: "owner/repo:Q4_K_M",
						// download_progress让客户端按此事件各文件的字节值汇总进度，不跨历史事件重复相加。
						event: "download_progress",
						// example URL是progress对象的键，512/1024应算ratio0.5；程序不fetch此URL。
						data: { progress: { "https://example/model.gguf": { done: 512, total: 1024 } } },
					});
					// 下载完成后模型仍unloaded，下载成功不等于已经加载可推理。
					status = "unloaded";
					// download_finished通知事件标记，客户端还会结合目录轮询并请求reload目录。
					send({ model: "owner/repo:Q4_K_M", event: "download_finished", data: {} });
					// 计时器只延后动作，不在此等待其执行或作为完成Promise。
				}, 20);
				// POST分支已回复，退出回调。
				return;
			}
			// /models及带reload等查询前缀都走目录分支，本fixture不精确核reload=1是否发送。
			if (request.url?.startsWith("/models")) {
				// JSON helper返回当下模型集合。
				json(response, {
					// missing时空数组，其余状态生成同ID条目；这里只给downloading/unloaded两类可发送状态。
					data: status === "missing" ? [] : [{ id: "owner/repo:Q4_K_M", status: { value: status } }],
				});
				// 目录已响应就返回。
				return;
			}
			// 其他端点404，不转发真实下载。
			response.writeHead(404).end();
		});

		// 收完整LlamaProgress对象数组，以便比较message/ratio/detail三个字段。
		const progress: LlamaProgress[] = [];
		// 真实客户端执行的是本机假下载和目录/SSE，不创建文件；回调保存进度对象引用，不自行做深快照。
		const models = await new LlamaClient(url).downloadAndWait("owner/repo:Q4_K_M", (entry) => progress.push(entry));
		// 最终应返回unloaded项，证明接口报告目录完成而非自动将模型load。
		expect(models).toEqual([{ id: "owner/repo:Q4_K_M", status: { value: "unloaded" } }]);
		// toContainEqual只需至少一条深相等进度，不保证完整事件序列或只有这一条。
		expect(progress).toContainEqual({
			// 字节下载进度的固定显示消息。
			message: "Downloading model",
			// 512除1024得0.5，未模拟未知总大小/超过总量等情况。
			ratio: 0.5,
			// 1024字节按formatBytes显示1.00 KiB，512仍显示B；这只核固定样本格式。
			detail: "512 B / 1.00 KiB",
		});
	});
});
