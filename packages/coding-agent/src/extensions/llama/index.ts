// llama.cpp内置扩展入口：注册原生Provider和/llama命令，交互界面可看目录、加载/卸载服务模型，并从Hugging Face选仓库交给配置的llama.cpp服务下载。
// 工厂调用只注册闭包，不启动llama-server、不立即登录或下载；命令阶段才解析认证/展示TUI/发管理HTTP。provider.ts维护模型投影，client.ts处理HTTP/轮询，ui.ts管理面板和取消交互。
// 只导入扩展API与用户命令上下文类型，编译后不会留下这两个interface值。
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
// 管理客户端发送服务请求；formatBytes只生成显示大小文字，URL规范与条目类型也复用客户端模块。
import { formatBytes, LlamaClient, type LlamaModelInfo, normalizeLlamaServerUrl } from "./client.ts";
// HF客户端负责搜索/详情，findHuggingFaceToken可能读环境及用户token候选文件；只导入并不开始读取。
import { findHuggingFaceToken, HuggingFaceClient } from "./huggingface.ts";
// Provider控制器维护聊天/分类目录，固定ID用于注册与认证查询。
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "./provider.ts";
// type LlamaUi编译期擦除；两个运行值分别承接进度取消与自定义TUI生命周期。
import { type LlamaUi, runWithProgress, showLlamaUi } from "./ui.ts";

// 把loaded/sleeping都视为管理界面可卸载的已加载模型，输入目录条目返回布尔，无网络；例sleeping会参加替换前的卸载/恢复集合，不代表此时正在生成。
function modelIsLoaded(model: LlamaModelInfo): boolean {
	// 两个精确状态用||连接，loading/downloading/unloaded均false。
	return model.status.value === "loaded" || model.status.value === "sleeping";
}

// 按Error的名字/消息文字粗略判断连接故障，输入unknown返回boolean，无副作用；例TimeoutError命中，不是网络错误的完整分类器，普通抛出字符串不识别。
function isConnectionError(error: unknown): boolean {
	// unknown是错误边界，只有Error实例才继续读name/message；跨realm对象/普通错误形状未必通过instanceof。
	if (!(error instanceof Error)) return false;
	// 模板插值把名字和消息合成一个字符串，再转小写用于不区分大小写的包含判断。
	const message = `${error.name} ${error.message}`.toLowerCase();
	// 三个子串任一出现就true，可能误判包含这些文字的业务错误，也可能漏掉其他网络故障。
	return message.includes("fetch failed") || message.includes("timeout") || message.includes("network");
}

// 把未知错误变成连接弹窗文字，输入error返回字符串；例命中网络启发式统一提示，否则Error.message或String(value)。无日志/脱敏，字符串化自定义值本身也可能抛错。
function connectionErrorMessage(error: unknown): string {
	// 被粗分类为连接故障才用统一英文，不保留原详细原因给这个弹窗。
	if (isConnectionError(error)) return "Could not connect to the server.";
	// 其余保留消息或一般JS字符串表示，不把unknown强制断言为Error。
	return error instanceof Error ? error.message : String(error);
}

// 从选择文字拆仓库和可选量化名，返回新对象，无I/O；例owner/repo:Q4_K_M拆成两字段。只找第一个/之后的第一个冒号，不校验仓库格式、空量化或多冒号。
function parseHuggingFaceModel(value: string): { repository: string; quantization?: string } {
	// 内层indexOf找首个/，+1作为外层冒号搜索起点；没/时从0找冒号，不自动补owner。
	const colon = value.indexOf(":", value.indexOf("/") + 1);
	// 三元表达式以colon是否小于0区分“未找到”。
	return colon < 0
		? // 没冒号时整个原串作repository，不trim/规范大小写。
			{ repository: value }
		: // 有冒号时左右slice，不含冒号本身；后面更多冒号仍留在quantization文字中。
			{ repository: value.slice(0, colon), quantization: value.slice(colon + 1) };
}

// 解析已配置llama认证并创建管理客户端，输入命令ctx，返回客户端或undefined的Promise；无配置提示/login后结束。认证解析可读存储/环境或由运行时执行解析动作，new客户端本身不连服务；非法URL/解析失败仍拒绝。
async function configuredClient(ctx: ExtensionCommandContext): Promise<LlamaClient | undefined> {
	// 按供应商ID请求完整认证结果，不只取key；Models不在这个调用里主动弹登录输入。
	const result = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
	// undefined表示目前无可用配置，不能以默认8080当已配置。
	if (!result) {
		// 只通知用户该用的登录命令，不在本函数自动执行/login。
		ctx.ui.notify(`Configure llama.cpp with /login ${LLAMA_PROVIDER_ID}`, "warning");
		// 返回undefined让handler不再打开管理面板。
		return undefined;
	}
	// 优先取解析结果供应商env中的管理地址。
	const configuredUrl = result.env?.LLAMA_BASE_URL;
	// 对选出的地址清查询/片段，本次只剥一层末尾/v1；后面客户端构造还会另行规范一次，URL非法时抛错。
	const serverUrl = normalizeLlamaServerUrl(
		// 字符串且非空env优先，否则auth.baseUrl，再空串；纯空白env仍优先且规范失败，不继续回退。
		typeof configuredUrl === "string" && configuredUrl ? configuredUrl : (result.auth.baseUrl ?? ""),
	);
	// 管理客户端保存规范地址和请求key，之后的list/load等才开始HTTP。
	return new LlamaClient(serverUrl, result.auth.apiKey);
}

// 扩展工厂接宿主ExtensionAPI，返回void，创建并注册Provider、定义管理流程、注册/llama命令；例宿主加载内置扩展后命令表有llama。调用工厂本身不连服务、不读HF token或显示界面，注册异常直接传播。
export default function llamaExtension(pi: ExtensionAPI): void {
	// 每次加载工厂创建独立目录状态，初始聊天/分类列表空。
	const provider = createLlamaProvider();
	// 注册完整原生Provider；加载期API可先暂存，绑定后由宿主装入模型运行时，不直接发模型请求。
	pi.registerProvider(provider.provider);

	// 同步管理目录与运行时模型投影：可复用传入catalog，否则GET，然后setCatalog，再刷新仅本Provider，成功返回最初current。输入ctx/client/可缺目录返回Promise数组；例下载结束的catalog可省去首个GET，但后续refresh仍可再次请求。已改内存后失败不自动回滚。
	const syncCatalog = async (
		// 命令上下文提供模型注册表和通知界面。
		ctx: ExtensionCommandContext,
		// 已经带服务URL/key的管理客户端。
		client: LlamaClient,
		// 可选目录快照；空数组也是真正传入的值，不触发??右侧请求。
		catalog?: LlamaModelInfo[],
		// 返回的是current上游目录，不是refresh后重新查询到的最新raw目录。
	): Promise<LlamaModelInfo[]> => {
		// 为这一轮首个list和注册表刷新共用15秒取消信号，signal到时通知取消，不保证远端动作已停止。
		const signal = AbortSignal.timeout(15_000);
		// ??仅缺catalog时才await客户端list；复用数组不克隆，且首个list自身也有客户端超时。
		const current = catalog ?? (await client.list({ signal }));
		// 立即替换控制器目录，不探thinking/不持久化；未传routerAutoload，因此未加载preset暂不加入投影，后面refresh可先恢复缓存再联网覆盖此临时列表。
		provider.setCatalog(current, client.serverUrl);
		// 要求Models刷新已注册供应商，并等待结果；不是把current直接写进存储。
		const result = await ctx.modelRegistry.refresh({
			// 限制供应商ID范围，未知/静态项会由运行时忽略，不刷新所有提供商。
			providers: [LLAMA_PROVIDER_ID],
			// /llama already contacted the configured llama.cpp server, so keep this refresh live even in PI_OFFLINE.
			// 显式允许网络阶段，即使PI_OFFLINE开启；这属于主动管理命令的既定策略，不修改全局离线环境。
			allowNetwork: true,
			// 共享signal把前面list花掉的时间也算入这轮刷新信号有效时间。
			signal,
		});
		// 运行时结果aborted才抛固定超时文案；Provider内部超时若未取消此共享signal，可能以errors里的真实错误出现。
		if (result.aborted) throw new Error("Model catalog refresh timed out.");
		// 按llama ID取本家刷新错误，不以其他家的状态代替。
		const refreshError = result.errors.get(LLAMA_PROVIDER_ID);
		// 有该Error则原样抛出，之前setCatalog/缓存恢复可能已经发生。
		if (refreshError) throw refreshError;
		// 正常返回最初取得的上游条目，用来更新管理列表/提示，不是返回Provider模型投影。
		return current;
	};

	// 按用户选择加载目标，可保留已有模型或先卸载再加载，输入ctx/ui/client/当前目录/target返回Promise<void>；例已有A加载B时可选择替换。会发送管理请求并更新目录，取消/失败时尽力恢复旧loaded/sleeping集合，不提供事务；替换的卸载循环在try外，失败不会进入下面恢复catch。
	const loadModel = async (
		// ctx用于注册表刷新和通知，不把当前Agent聊天信号自动带进整个管理流程。
		ctx: ExtensionCommandContext,
		// UI接口提供选择/取消进度交互，实际TUI由外层showLlamaUi建立。
		ui: LlamaUi,
		// 配置好的服务客户端，不在本流程启动本地服务进程。
		client: LlamaClient,
		// 当前目录快照用于选择“其他已加载”集合，可能与随后服务器状态有时间差。
		catalog: LlamaModelInfo[],
		// 目标目录条目，主要使用id；只由命令上层对unloaded调用本函数。
		target: LlamaModelInfo,
		// async返回void Promise，通知/HTTP/UI异常可以拒绝。
	): Promise<void> => {
		// 排除目标同ID，loaded和sleeping都收入旧集合；不是重查服务器现状。
		const loaded = catalog.filter((model) => model.id !== target.id && modelIsLoaded(model));
		// 默认不替换，let允许在选择后设true。
		let replace = false;
		// 只有存在其他已加载条目时才询问保留/替换。
		if (loaded.length > 0) {
			// 按数量拼单复数标题并等待选项结果，取消UI可返回undefined。
			const choice = await ui.select(`${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`, [
				// 该选项意味着后面串行卸载旧集合，不意味着原子替换服务进程。
				"Unload all and load",
				// 保留旧模型同时尝试加载新目标，实际容量由服务决定。
				"Keep loaded and load",
				// 明确的取消文字，与UI返回undefined一起处理。
				"Cancel",
			]);
			// 空选项或Cancel都立即结束，没有执行下面卸载/加载。
			if (!choice || choice === "Cancel") return;
			// 只有精确选择首项才设置replace，其余非空选择按保留处理。
			replace = choice === "Unload all and load";
		}

		// 恢复闭包无参数，串行重新load旧集合后同步目录，返回Promise<void>；例A曾被替换卸载，B失败后尝试重载A。不是恢复原sleeping状态/内存内容，不提供总超时、外层取消信号或失败回滚。
		const restoreLoaded = async (): Promise<void> => {
			// 先发普通恢复通知；notify异常本身也会让恢复拒绝。
			ctx.ui.notify("Restoring previously loaded models");
			// for...of逐个await加载等待结果，空回调主动不展示这些恢复进度；其中一个失败后不会继续剩余项。
			for (const model of loaded) await client.loadAndWait(model.id, () => {});
			// 全部恢复调用正常后同步运行时目录；同步失败也属于恢复失败。
			await syncCatalog(ctx, client);
		};
		// 只有用户选择替换时执行这段卸载。
		if (replace) {
			// 逐个等服务报告unloaded/条目消失，未传统一signal；此循环在try外，失败不触发下面恢复旧集合的catch。
			for (const model of loaded) await client.unloadAndWait(model.id);
		}

		// try从进度加载开始，涵盖取消恢复、同步目录与成功通知等后续步骤。
		try {
			// 交给进度助手把run/cancel和面板关联；helper确认停止后先调cancel，再abort本地信号并等run结算。
			const result = await runWithProgress(ui, {
				// 进度面板标题，不是实际加载协议字段。
				title: "Loading model",
				// 展示目标id并用于取消消息。
				model: target.id,
				// 初始进度文字，后面客户端事件/轮询回调可更新。
				initialMessage: "Starting…",
				// 停止确认标题，取消键不是无条件立刻卸载。
				cancelTitle: "Stop loading?",
				// 停止确认正文显示目标id。
				cancelMessage: target.id,
				// 真正执行目标load+SSE/轮询等待，signal来自进度助手，update把进度送UI。
				run: (signal, update) => client.loadAndWait(target.id, update, signal),
				// 确认停止时请求卸载目标，仅等unload请求返回，不在此等unloadAndWait确认状态；失败仍可能被helper抛出。
				cancel: () => client.unload(target.id),
			});
			// 取消结果是可分辨联合的一支，先检查标签后无需读取value。
			if (result.cancelled) {
				// 替换模式取消后尝试重载旧集合；若这里失败会进入catch，可能再次尝试恢复。
				if (replace) await restoreLoaded();
				// 结束当前加载流程，不发Loaded通知。
				return;
			}
			// 加载run成功后重新读上游目录并刷新Provider；之后失败也进入恢复catch。
			const refreshed = await syncCatalog(ctx, client);
			// 在这份目录中找目标同ID，没找到给undefined。
			const loadedModel = refreshed.find((model) => model.id === target.id);
			// 通知当前观测结果，不直接把run成功当作目录必含目标。
			ctx.ui.notify(
				// 只有确实loaded才说Loaded，sleeping/未找到/其他状态用Load started兜底。
				loadedModel?.status.value === "loaded" ? `Loaded ${target.id}` : `Load started for ${target.id}`,
			);
			// 捕获try里的任意抛出值，不保证必定是Error或纯加载错误。
		} catch (error) {
			// 选择保留模式时不尝试恢复旧集合，原模型本就没在本函数主动卸载。
			if (replace) {
				// 恢复另套try，避免它的失败覆盖当前捕获的原异常。
				try {
					// 尝试串行重新加载先前集合并同步目录，不会主动在此卸载失败的新目标。
					await restoreLoaded();
					// 恢复错误丢弃，旧集合可能只恢复了一部分。
				} catch {
					// Preserve the original load error.
				}
			}
			// 重抛最初try失败值，外层命令循环可继续刷新目录/提示。
			throw error;
		}
	};

	// 确认后卸载一个已加载/睡眠模型，输入ctx/ui/client/model，成功Promise<void>；例选sleeping项也请求卸载。先询问→请求并轮询→同步目录→通知；中途失败拒绝，无回滚、未传统一取消信号。
	const unloadModel = async (
		// 上下文供同步运行时和发提示。
		ctx: ExtensionCommandContext,
		// UI确认返回boolean，取消/No按false处理。
		ui: LlamaUi,
		// 管理服务客户端。
		client: LlamaClient,
		// 目标目录条目，使用其id发送请求。
		model: LlamaModelInfo,
	): Promise<void> => {
		// 括号内await完成再!判断；不确认时早返，不发卸载请求。
		if (!(await ui.confirm("Unload model?", model.id))) return;
		// 等服务目录中该项消失或unloaded，客户端内部轮询，不只等POST受理。
		await client.unloadAndWait(model.id);
		// 再同步Provider投影/缓存，失败时实际卸载可能已经完成。
		await syncCatalog(ctx, client);
		// 上面两步骤都正常后通知Unloaded，不承诺模型以后不会被其他请求自动加载。
		ctx.ui.notify(`Unloaded ${model.id}`);
	};

	// 搜索HF仓库、确认访问提示/量化，再让已配置llama服务下载，输入ctx/ui/client返回Promise<void>；例owner/repo:Q4_K_M可直接采用量化后缀。HF搜索/详情用本机找到的token，真正下载由服务自身权限执行；会读token候选、发HTTP及改变服务目录，无文件下载/授权成功保证。
	const downloadModel = async (ctx: ExtensionCommandContext, ui: LlamaUi, client: LlamaClient): Promise<void> => {
		// 先异步找本机HF token再构造默认官方HF客户端；没token也能匿名查询，找到的token不直接传给llama服务。
		const huggingFace = new HuggingFaceClient(await findHuggingFaceToken());
		// UI驱动查询回调，信号从搜索组件传给HF客户端；用户可选仓库或输入精确仓库/量化文字。
		const selected = await ui.searchModels((query, signal) => huggingFace.search(query, signal));
		// 退出搜索/空结果无选择时结束，不查详情/下载。
		if (!selected) return;
		// 拆仓库与可选量化后缀，不在此验证仓库是否真存在。
		const parsed = parseHuggingFaceModel(selected);
		// 切换状态文字，随后等待详情请求；showStatus返回void不等用户确认。
		ui.showStatus("Loading model details", parsed.repository);
		// 查仓库元数据/量化/访问类型，此调用未传搜索signal，客户端仍有自身15秒信号。
		const details = await huggingFace.details(parsed.repository);
		// 只要识别出auto/manual访问限制就提示，未识别值由HF客户端归false。
		if (details.gated) {
			// manual说明需审批，auto说明需接受条款；这些文字不执行任何授权操作。
			const approval = details.gated === "manual" ? "Manual approval is required" : "Accept the access terms";
			// 显示仓库ID、审批链接与服务HF_TOKEN要求，等待Continue/Back选择。
			const choice = await ui.select(
				// 原模板文字插入details.id，提示去网页处理；这里不打开链接、不自动替用户同意条款。
				`Hugging Face access required\n${details.id}\n\n${approval} at:\nhttps://huggingface.co/${details.id}\n\nThe llama.cpp server needs HF_TOKEN with access.`,
				// Continue只表示用户选择继续尝试，Back返回，不代表token已拥有权限。
				["Continue", "Back"],
			);
			// 其他返回值含undefined都结束，不发下载请求。
			if (choice !== "Continue") return;
		}
		// let允许后续量化选择替换parsed中的可选值，已有后缀不会被强制校验为详情列出的量化。
		let quantization = parsed.quantization;
		// 仅未提供真值量化且详情有候选时打开量化列表；无候选仍可继续下载仓库默认形式。
		if (!quantization && details.quantizations.length > 0) {
			// map为每个量化构造一个显示字符串，返回新options数组，不修改详情列表。
			const options = details.quantizations.map((entry) => {
				// 先组合可选大小文字和推荐标签，数组可暂含undefined。
				const detail = [
					// 大小缺失不显示，0等已知值仍调用formatBytes；它只是格式化数值。
					entry.size === undefined ? undefined : formatBytes(entry.size),
					// Q4_K_M精确名字加recommended，属于预设建议而非现场性能测试。
					entry.name === "Q4_K_M" ? "recommended" : undefined,
				]
					// Boolean去掉undefined/空串；value is string是类型谓词，不对其余内容执行验证。
					.filter((value): value is string => Boolean(value))
					// 把存在的细节用中点连接，空细节得到空串。
					.join(" · ");
				// 有细节返回名称加说明，否则只有量化名；三元表达式只选一支。
				return detail ? `${entry.name} · ${detail}` : entry.name;
			});
			// 展示这组显示字符串并等待选择，仓库id加入标题。
			const choice = await ui.select(`Select quantization\n${details.id}`, options);
			// 取消/空选择直接结束，不发送下载。
			if (!choice) return;
			// 用显示字符串在options中的首索引映回详情名称，可选链防越界得到undefined；不是解析显示文字的大小标签。
			quantization = details.quantizations[options.indexOf(choice)]?.name;
			// 映射失败不继续，避免把没有选中名称当已选量化。
			if (!quantization) return;
		}
		// 量化真值才拼repository:quant，否则只用详情id；服务收到的是模型标识而非HF token/本机文件路径。
		const model = quantization ? `${details.id}:${quantization}` : details.id;
		// 启动可取消下载进度，run使用管理客户端而不是HF客户端直接拉模型文件。
		const result = await runWithProgress(ui, {
			// 下载面板标题。
			title: "Downloading model",
			// 属性简写传刚拼出的完整模型标识。
			model,
			// 初始状态文字，后续字节进度可更新。
			initialMessage: "Starting…",
			// 取消确认标题。
			cancelTitle: "Stop download?",
			// 取消确认正文显示完整模型标识。
			cancelMessage: model,
			// 客户端POST下载并SSE/轮询等待，完成后返回reload过的目录；signal/update来自进度助手。
			run: (signal, update) => client.downloadAndWait(model, update, signal),
			// 确认停止时请求服务unload该标识，是现有取消协议，不保证所有远端下载工作已彻底停止。
			cancel: () => client.unload(model),
		});
		// 取消联合分支早返，不同步成功目录或发Downloaded。
		if (result.cancelled) return;
		// 非取消分支TS可访问value；复用run返回目录省首个list，但syncCatalog里的Provider刷新仍可联网。
		await syncCatalog(ctx, client, result.value);
		// 全部同步正常后发下载完成通知，不验证本机文件或实际推理可用。
		ctx.ui.notify(`Downloaded ${model}`);
	};

	// 注册llama斜杠命令，注册本身不调用handler；输入参数由宿主稍后提供。
	pi.registerCommand("llama", {
		// 命令菜单说明，实际支持动作由下面handler的UI分派决定。
		description: "Manage llama.cpp router models",
		// 异步handler输入命令原参数和ctx，返回void Promise；_args刻意不使用。先守TUI模式/认证，再显示列表循环，动作失败先存后重读目录，不一定立即报错；例非TUI只提示就结束。
		handler: async (_args, ctx) => {
			// 仅tui模式允许自定义终端管理面板，不把RPC hasUI=true等同终端组件能力。
			if (ctx.mode !== "tui") {
				// 非TUI给warning，无自动打开其他客户端的副作用。
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				// 结束handler，避免非终端环境触发认证解析或TUI。
				return;
			}
			// 解析当前配置创建客户端，未配置可提示并undefined，错误在showLlamaUi调用前仍会向宿主拒绝。
			const client = await configuredClient(ctx);
			// 没有客户端就结束，不使用默认8080强行尝试管理。
			if (!client) return;
			// 自定义面板驱动异步回调；callee成功调用done，失败先notify再done，因此通常不继续抛run原异常；若notify自身抛错则会阻止该done调用。
			await showLlamaUi(ctx, async (ui) => {
				// 局部读取闭包不断同步目录，输入无、返回目录或用户关闭的undefined；例连接失败选Retry再次请求。所有sync错误都可显示连接弹窗，不限isConnectionError=true，不设次数上限。
				const readCatalog = async (): Promise<LlamaModelInfo[] | undefined> => {
					// 无限重试循环依赖成功return或用户close来结束，不是固定轮数重试。
					while (true) {
						// 捕获每次完整syncCatalog的错误（含URL/网络/目录刷新等）。
						try {
							// return await让异步拒绝也进入本try的catch，成功返回这次上游目录。
							return await syncCatalog(ctx, client);
							// 捕获未知抛出值，用统一提示函数生成弹窗文字。
						} catch (error) {
							// 向用户提供重试/关闭；connectionErrorMessage只做文本分类，ui.connectionError自身拒绝仍会向外传播。
							if ((await ui.connectionError(client.serverUrl, connectionErrorMessage(error))) === "close") {
								// 选择close返回undefined，结束当前管理回调的后续读取。
								return undefined;
							}
						}
					}
				};

				// 首次读目录成功后保存为后续动作选择的快照，let允许刷新后整体换数组。
				let catalog = await readCatalog();
				// undefined表示用户关闭；空数组是真值，仍进入列表显示下载项。
				if (!catalog) return;
				// 只要用户未关闭就反复显示列表并处理一个动作，串行await避免本循环主动并发管理动作。
				while (true) {
					// 把当前URL/目录交UI，返回带type标签的动作联合。
					const action = await ui.showModels(client.serverUrl, catalog);
					// close动作直接结束回调，showLlamaUi接着收起面板。
					if (action.type === "close") return;
					// unknown临时保存动作失败；未赋值时undefined，可能也保存非Error的假值抛出物。
					let actionError: unknown;
					// 只捕获这次动作及其通知/刷新内部抛错，列表本身和后面的重读不在此try。
					try {
						// download分支执行HF选择和服务下载；此分支没有model字段，因此先按type收窄。
						if (action.type === "download") await downloadModel(ctx, ui, client);
						// 剩余model动作若loaded/sleeping则询问卸载，和Provider可选状态判定用途不同。
						else if (modelIsLoaded(action.model)) await unloadModel(ctx, ui, client, action.model);
						// 只有明确unloaded才进入加载流程，loading/downloading不再次发加载。
						else if (action.model.status.value === "unloaded")
							// 把当时catalog快照传进去用于旧模型替换/恢复决策。
							await loadModel(ctx, ui, client, catalog, action.model);
						// 其余状态仅warning提示，不强行切换服务器状态。
						else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, "warning");
						// 动作异常先捕获保留，不让管理循环立即退出。
					} catch (error) {
						// 直接保存原抛出值，没在此包装/脱敏或立即notify。
						actionError = error;
					}
					// 不论动作成功、取消或失败，都再次读目录；读失败会进入读函数的重试/关闭交互。
					const refreshed = await readCatalog();
					// 用户在重读时关闭则直接返回，之前的动作错误也不再另通知。
					if (!refreshed) return;
					// 用新目录替换旧快照，下一次列表使用实际观测状态。
					catalog = refreshed;
					// 仅真值且未被连接错误启发式归类的失败才另发error；throw undefined/0等假值不会在这里通知，网络类留给重读目录流程处理。
					if (actionError && !isConnectionError(actionError)) {
						// Error显示message，其他值String化，消息未额外脱敏；notify再抛会由showLlamaUi的run错误边界处理。
						ctx.ui.notify(actionError instanceof Error ? actionError.message : String(actionError), "error");
					}
				}
			});
		},
	});
}
