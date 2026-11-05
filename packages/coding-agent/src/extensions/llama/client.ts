// 连接已配置的 llama.cpp 路由服务：查模型/属性，发加载、卸载、下载指令，并把SSE事件与定时查目录结合为进度。
// SSE是服务端通过一条长连接持续推送事件；轮询是隔一会儿主动再查状态，这里把两者并用。
// 这里只是管理客户端；实际模型加载/文件下载发生在远端服务。没有统一操作总超时，各普通HTTP请求设置15秒取消信号。
// 字符串字面量联合描述已知状态，不生成枚举对象，也不验证服务端一定只返回这些文字。
export type LlamaModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";

// 目录中一个模型的静态形状；?字段可缺省，真正收到网络数据后只经过下方的浅检查。
export interface LlamaModelInfo {
	// 路由器使用的模型标识，不一定是本地文件名。
	id: string;
	// 可选的别名列表；本客户端等待状态时仍按id精确匹配，不自动用别名查找。
	aliases?: string[];
	// 必需状态对象，包含当前阶段及可选进度/失败信息。
	status: {
		// 当前状态文字；TS联合限制调用者写法，不是对远端枚举值的运行时校验。
		value: LlamaModelStatus;
		// 可选服务启动参数列表，后续provider可用它推断上下文等配置。
		args?: string[];
		// 服务报告的失败标志，loadAndWait据此报错；不保证所有失败都有此字段。
		failed?: boolean;
		// 可选子模型进程退出码，用于失败提示，不是此Node进程的退出码。
		exit_code?: number;
		// Record按文件键保存已完成/总字节数，下载轮询可把它转成合计进度。
		progress?: Record<string, { done: number; total: number }>;
	};
	// 可选模型架构信息，用来区分输入/输出能力；接口本身不探测模型。
	architecture?: {
		// 例如text/image；这里只声明字符串数组，不验证已知模态名单。
		input_modalities?: string[];
		// 例如text/decisions；真正能否调用由provider进一步处理。
		output_modalities?: string[];
	};
	// 来源文字，如preset/cache/models_dir，帮助provider决定未加载模型是否可选。
	source?: string;
	// 可选元数据对象，不代表这些数值都已存在或已验证正数。
	meta?: {
		// 当前实际上下文容量，单位通常是token。
		n_ctx?: number;
		// 训练时上下文容量，与当前服务分配的n_ctx分开。
		n_ctx_train?: number;
		// 模型大小元数据；显示格式化另见formatBytes。
		size?: number;
		// 服务返回的模型文件类型文字，不在类型声明中解析。
		ftype?: string;
	};
}

// 模型目录响应的类型说明；list实际只检查对象/data数组与id/status.value，不完整核对每个可选字段。
export interface LlamaModelsResponse {
	// 模型条目数组；空数组也被every认为全部通过。
	data: LlamaModelInfo[];
	// 兼容响应可能带object标签，本客户端不据此验证router模式。
	object?: string;
}

// 服务属性查询的精简输出，网络中其他字段不保留。
export interface LlamaServerProps {
	// 路由服务是否允许按需加载模型；缺失不自动等于true。
	models_autoload?: boolean;
	// 聊天模板原文；这里不执行模板，provider会进一步据文字识别思考参数支持。
	chat_template?: string;
}

// SSE中使用的事件形状，具体载荷data保持unknown，事件类型也未缩成固定联合。
export interface LlamaModelEvent {
	// 事件属于哪个模型；加载/下载等待会忽略其他id。
	model: string;
	// 例如status_change/download_progress，本客户端按具体文字选择处理。
	event: string;
	// 可选未知载荷，须按事件用途再次检查，不能直接假定字段都正确。
	data?: unknown;
}

// 交给UI的进度数据；不自动渲染或写终端。
export interface LlamaProgress {
	// 人可读的阶段提示，例如Loading text model。
	message: string;
	// 可选比例；类型number不保证0..1，下载合计并没有夹限。
	ratio?: number;
	// 可选附加文字，例如512 B / 1.00 KiB。
	detail?: string;
}

// 从未知响应的error.message提取非空文字，否则返回fallback；例如{error:{message:"Denied"}}可提取Denied。
// 仅做浅字段检查，不打印、不脱敏；形状不对并不抛错，而是退回调用者给的错误文字。
function errorMessage(payload: unknown, fallback: string): string {
	// 信任边界是解码后的网络unknown；object还须排除null，数组未特别排除。
	if (typeof payload !== "object" || payload === null) return fallback;
	// 断言只提供可能有error字段的静态视图，值仍unknown，不会在运行时验证。
	const error = (payload as { error?: unknown }).error;
	// 第二层error也须为非null对象，否则直接用兜底消息。
	if (typeof error !== "object" || error === null) return fallback;
	// 再读message字段，下一句验证是否是非空字符串。
	const message = (error as { message?: unknown }).message;
	// 空串回退，空格字符串仍为真值原样返回；不清洗其中控制字符。
	return typeof message === "string" && message ? message : fallback;
}

// 浅判一个未知目录条目，返回类型谓词供TS收窄；只核id和status.value是字符串。
// 例如{ id:"x", status:{value:"mystery"} }也能通过，并未核已知状态联合或其他字段，不等于完整schema校验。
function isModelInfo(value: unknown): value is LlamaModelInfo {
	// 先排除非对象/null；不排除数组对象，也不查字段是否为自有属性。
	if (typeof value !== "object" || value === null) return false;
	// as描述后面要读的字段，不制造status对象或运行时检查。
	const candidate = value as { id?: unknown; status?: { value?: unknown } };
	// ?.使缺status时得到undefined；任意字符串状态都过关，id也允许空串。
	return typeof candidate.id === "string" && typeof candidate.status?.value === "string";
}

// 把可选源signal的取消转发给目标控制器，返回解除监听函数；例如外部取消时同时请求停止SSE watcher。
// 源已取消就立即转发，没源就返回空函数；unlink只移除未来通知，不恢复已取消的目标，也不等远端任务结束。
function linkSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	// 没有源信号时无需安装监听，仍返回可统一调用的函数。
	if (!source) return () => {};
	// 先处理在安装监听前已取消的情况，避免漏掉历史abort事件。
	if (source.aborted) {
		// 转发原reason；控制器abort发通知，不表示远端进程已停止。
		target.abort(source.reason);
		// 本分支没安装监听，清理函数为空操作。
		return () => {};
	}
	// 箭头闭包在abort事件触发时取source.reason并取消target，不是此刻就调用。
	const abort = () => target.abort(source.reason);
	// once只让事件回调触发一次，未发生取消时仍需下面unlink移除。
	source.addEventListener("abort", abort, { once: true });
	// 返回箭头让调用方在finally解除同一个监听；返回函数本身不会立即remove。
	return () => source.removeEventListener("abort", abort);
}

// 可取消的延迟，接毫秒/可选signal，正常到时Promise<void>成功，取消则拒绝。
// 例如sleep(250,signal)用于轮询间歇；不是忙循环，不给外层整项加载操作设总期限。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	// Promise执行器同步安排计时与监听，resolve/reject只影响该Promise的首次结算。
	return new Promise((resolve, reject) => {
		// 若调用前已经取消，直接拒绝，不再安装计时器。
		if (signal?.aborted) {
			// ??只在reason为null/undefined时补Error，其他任意reason值都可作为拒绝原因。
			reject(signal.reason ?? new Error("Cancelled"));
			// 结束执行器，避免拒绝后还排后面的timer。
			return;
		}
		// 正常等待期间收到取消时执行的回调，闭包会取下面创建的timeout句柄。
		const abort = () => {
			// 取消延迟计时器，不再等待它正常触发。
			clearTimeout(timeout);
			// 让await sleep的上层收到拒绝，仍不代表其他HTTP/远端任务自动全部停止。
			reject(signal?.reason ?? new Error("Cancelled"));
		};
		// setTimeout安排一次回调，返回Node计时器句柄。
		const timeout = setTimeout(() => {
			// 正常到时先移除abort监听，避免已完成的延迟继续持有闭包。
			signal?.removeEventListener("abort", abort);
			// 不带结果值兑现Promise，await后继续下一次轮询。
			resolve();
			// ms原样交给Node计时规则，没有额外检查负数/NaN。
		}, ms);
		// 存在信号才安装一次性监听；未传则仅有计时器。
		signal?.addEventListener("abort", abort, { once: true });
	});
}

// 把未知加载事件转成阶段文字/比例，不能识别外层progress就undefined。
// 例如stages=[text_model,mmproj_model]、current=text_model、value=0.5，整体比例为(0+0.5)/2=0.25。
// 阶段名未知则保留单阶段比例；数字值只用min/max处理，NaN仍可能为NaN，不是完整数值校验。
function parseLoadProgress(data: unknown): LlamaProgress | undefined {
	// 检查外层网络载荷是非null对象，数组仍可进入后续字段读取。
	if (typeof data !== "object" || data === null) return undefined;
	// 读取progress，仍保持unknown，不因as就假定它是进度对象。
	const progress = (data as { progress?: unknown }).progress;
	// 没有非null对象progress就不生成进度提示。
	if (typeof progress !== "object" || progress === null) return undefined;
	// 把将读取的四字段显式保留unknown，分别判断字符串/数组/数字。
	const value = progress as { stages?: unknown; current?: unknown; stage?: unknown; value?: unknown };
	// 先选current字符串，否则选stage字符串，否则没有具体阶段名。
	const stage =
		// 嵌套三元从左到右表达上述优先级，空字符串也会被选为string，但后面按假值不给阶段标题。
		typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
	// stages真是数组才保留其中的字符串项。
	const stages = Array.isArray(value.stages)
		? // 类型谓词entry is string让filter结果成为string[]；实际typeof承担外部数据过滤。
			value.stages.filter((entry): entry is string => typeof entry === "string")
		: // 没有数组就用空列表，后面不按阶段数量换算。
			[];
	// 数字压到0..1，缺值则undefined；min/max对NaN仍给NaN，不检验有限数。
	const stageRatio = typeof value.value === "number" ? Math.max(0, Math.min(1, value.value)) : undefined;
	// 先把单阶段比例作默认值，let允许之后换算整体比例。
	let ratio = stageRatio;
	// 有真值阶段名且阶段列表非空时才尝试换算。
	if (stage && stages.length > 0) {
		// indexOf找第一次同名阶段，不在列表时返回-1。
		const index = stages.indexOf(stage);
		// 找到时用已完成阶段数加本阶段进度后除总阶段数；缺进度按0，重复阶段名按首次位置。
		if (index >= 0) ratio = (index + (stageRatio ?? 0)) / stages.length;
	}
	// 生成新进度对象，不改变原始事件内容。
	return {
		// 阶段名下划线换空格用于显示；没名字给通用文字，未自动翻译名称。
		message: stage ? `Loading ${stage.replaceAll("_", " ")}` : "Loading model",
		// 属性简写保留ratio，允许undefined而不是强制从0开始。
		ratio,
	};
}

// 汇总未知下载载荷各文件的done/total，返回文字、比例和大小，合计total<=0时不报进度。
// 既可接{progress:{url:{done,total}}}也可接直接文件字典；例512/1024得到0.5与512 B / 1.00 KiB。
// 只收数字字段，没检查非负/有限/完成量不超过总量，所以比例不承诺0..1，也不据此判下载完成。
function parseDownloadProgress(data: unknown): LlamaProgress | undefined {
	// 信任边界先排除非对象/null，数组未单独排除。
	if (typeof data !== "object" || data === null) return undefined;
	// 尝试取嵌套progress字段，读取本身不验证。
	const nested = (data as { progress?: unknown }).progress;
	// progress为非null对象就优先用它，否则把原data当文件字典；不是递归任意层查找。
	const files = typeof nested === "object" && nested !== null ? nested : data;
	// 累计所有合格条目的完成字节，从0开始。
	let done = 0;
	// 累计合格条目总字节，缺数字的条目整体跳过。
	let total = 0;
	// Object.values只遍历自有可枚举值；Record断言不保证值形状，下面仍检查。
	for (const value of Object.values(files as Record<string, unknown>)) {
		// 原始值/null不是文件统计对象，continue跳过当前项。
		if (typeof value !== "object" || value === null) continue;
		// 只声明将读取done/total两个未知字段。
		const entry = value as { done?: unknown; total?: unknown };
		// 两个都必须是number，否则这一项连部分done都不计入。
		if (typeof entry.done !== "number" || typeof entry.total !== "number") continue;
		// 累计完成量，没有去重文件或限制溢出。
		done += entry.done;
		// 累计总量，负数/NaN也可能进入，因为前面只做typeof检查。
		total += entry.total;
	}
	// 非正总量不给提示；NaN<=0为false，不能由此推断输出一定是有效比例。
	if (total <= 0) return undefined;
	return {
		// 下载阶段统一显示这一条文字。
		message: "Downloading model",
		// 直接相除，不夹限为0..1，不等于服务端下载完成信号。
		ratio: done / total,
		// 把两个合计交给1024进制格式化函数，用模板串拼成附加说明。
		detail: `${formatBytes(done)} / ${formatBytes(total)}`,
	};
}

// 把数字字节量转成显示文字，无I/O；例512→512 B、1024→1.00 KiB、10240→10.0 KiB。
// 最多升到TiB，大值仍用TiB；不验证负数/有限性，也不按十进制GB显示。
export function formatBytes(bytes: number): string {
	// 小于1024直接插入原数字，包括负数，不强制整数或保留小数位。
	if (bytes < 1024) return `${bytes} B`;
	// 数组按从小到大列1024进制单位，KiB表示1024字节。
	const units = ["KiB", "MiB", "GiB", "TiB"];
	// 先除一次，初始单位为KiB。
	let value = bytes / 1024;
	// !非空断言只消除TS可能undefined，依据是上面固定数组确有首项。
	let unit = units[0]!;
	// 从下一个单位开始，仍至少1024且没用完单位时继续升级。
	for (let index = 1; index < units.length && value >= 1024; index++) {
		// 每次再缩小1024倍，不创建新数组。
		value /= 1024;
		// 按当前索引更新单位；循环边界给出该项存在的依据。
		unit = units[index]!;
	}
	// 当前数值>=10用1位小数，否则2位；toFixed返回文字，不改变原数值。
	return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

// 规范管理地址：trim→解析绝对URL→限http/https→清查询/片段→去尾斜杠和一个末尾/v1。
// 例https://host/prefix/v1/?x=1#top→https://host/prefix；无效/非HTTP URL抛错，不做连接或主机可信验证。
export function normalizeLlamaServerUrl(value: string): string {
	// new URL接一个参数要求可解析的绝对URL；trim只去输入两端空白，解析器还会按URL规则规范文字。
	const url = new URL(value.trim());
	// 协议须严格为解析器给出的http:或https:，file等会报错。
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		// 同步throw拒绝该地址，未发网络请求。
		throw new Error("Server URL must use http or https");
	}
	// 清掉#片段，不把它带到后续请求地址。
	url.hash = "";
	// 清掉?查询，不保留输入服务URL中的认证/其他查询参数。
	url.search = "";
	// 先去路径尾部/再去末尾/v1，大小写敏感；空路径用/，不删除路径中间的/v1。
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	// URL序列化后再去末尾一个/；不清username/password，也不证明地址对应llama服务。
	return url.toString().replace(/\/$/u, "");
}

// 从管理根得到OpenAI兼容推理地址，返回字符串，不请求服务；例如http://host/v1先规范再补/v1，不重复两遍。
export function llamaInferenceUrl(serverUrl: string): string {
	// 先复用同一验证/去尾规则，错误会同步传播，再附固定后缀。
	return `${normalizeLlamaServerUrl(serverUrl)}/v1`;
}

// 管理客户端保存规范地址和可选key，构造不联网；普通请求设15秒取消信号，SSE watch直接用传入signal，没有同样默认超时。
export class LlamaClient {
	// readonly限制TS中后续重赋值，不冻结实例；保存规范后的管理根，管理路径另行拼接，原路径嵌套/v1/v1仍会留一个/v1。
	readonly serverUrl: string;
	// private仅TS访问限制，保存可选key，不自动加载环境或刷新认证。
	private readonly apiKey: string | undefined;

	// 接管理/推理URL与可选key，规范化失败会在new时抛出；不探测服务是否在线。
	constructor(serverUrl: string, apiKey?: string) {
		// 删除一个末尾/v1，所有管理路径随后拼到所得根地址，不循环剥除多层后缀。
		this.serverUrl = normalizeLlamaServerUrl(serverUrl);
		// key原样保存，空串后面不加认证头。
		this.apiKey = apiKey;
	}

	// 发送一条管理HTTP请求，返回未知JSON或undefined；合并15秒超时，非2xx抛带状态/错误体文字的Error。
	// 例load传POST和JSON body；这里只验证HTTP状态，不判断响应中success字段。正文JSON读取失败被吞掉，2xx也可视为已完成。
	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		// 复制init.headers进新Headers，下面覆盖本方法拥有的类型/认证字段，不直接改调用者的Headers对象。
		const headers = new Headers(init.headers);
		// 只要body不为undefined就写JSON内容类型，即使body为null；不自动把任意body序列化。
		if (init.body !== undefined) headers.set("Content-Type", "application/json");
		// 真值key覆盖已有Authorization，不是认证流程；Headers设置本身的错误会向外传播。
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		// 每次请求新建15000毫秒取消信号，非整个加载/下载循环共享的截止时间。
		const timeout = AbortSignal.timeout(15_000);
		// 有init.signal就与超时组合，任一个取消即可；null/undefined时只有超时信号。
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		// 先展开init，再以新headers/signal覆盖同名项；await只先等响应可用，正文还要下一段读取。
		const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
		// unknown避免把任意JSON直接当目录/属性，交各上层方法检查。
		let payload: unknown;
		// try仅包正文解析，fetch阶段的拒绝不在这个catch内。
		try {
			// 完整消费并解析JSON，不先检查Content-Type或限制正文大小。
			payload = await response.json();
			// 畸形JSON/正文取消等都被吞掉，不保留这次原异常。
		} catch {
			// 未得JSON就用undefined，上层某些void方法依旧可在2xx时完成。
			payload = undefined;
		}
		// HTTP非200..299才在这里拒绝，优先用嵌套error.message；不脱敏服务文字。
		if (!response.ok) throw new Error(errorMessage(payload, `llama.cpp returned HTTP ${response.status}`));
		// 返回未知数据，无统一schema验证或深拷贝。
		return payload;
	}

	// 查/models目录，可选reload要求服务重扫，返回通过浅检查的模型数组，网络/顶层无效/坏条目会拒绝。
	// 例list({reload:true})请求/models?reload=1；整个数组须通过isModelInfo，但它并未核状态枚举或全部字段。
	async list(options: { reload?: boolean; signal?: AbortSignal } = {}): Promise<LlamaModelInfo[]> {
		// reload按真值决定是否附固定参数；signal交普通请求的组合取消。
		const payload = await this.request(`/models${options.reload ? "?reload=1" : ""}`, { signal: options.signal });
		// 网络边界要求非null对象且data确实是数组，数组顶层本身未被单独排除。
		if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
			// 顶层不满足就报目录无效，未返回空数组掩盖错误。
			throw new Error("llama.cpp returned an invalid model catalog");
		}
		// 断言把已检查data读成unknown[]，每项仍需检查。
		const data = (payload as { data: unknown[] }).data;
		// every遇一条不通过就报router模式错误；空数组直接通过，这不是额外请求探测服务版本。
		if (!data.every(isModelInfo)) throw new Error("Server is not running in llama.cpp router mode");
		// 返回原数组引用，没有复制或逐条补默认值。
		return data;
	}

	// 查服务/指定模型属性，只保留boolean models_autoload与string chat_template，其他字段忽略。
	// 例props({model:"qwen"})附autoload=false以避免为探测模板自动加载模型；未给model就查路由器全局属性。
	async props(options: { model?: string; signal?: AbortSignal } = {}): Promise<LlamaServerProps> {
		// model空串按无指定处理；URLSearchParams编码名称，autoload固定文字false。
		const query = options.model ? `?${new URLSearchParams({ model: options.model, autoload: "false" })}` : "";
		// 拼路径GET，signal仍经15秒组合超时。
		const payload = await this.request(`/props${query}`, { signal: options.signal });
		// 非对象/null返回空对象而不是报schema错误；HTTP请求失败已在request拒绝。
		if (typeof payload !== "object" || payload === null) return {};
		// 解构并重命名字段，冒号右侧是本地变量名，不是TS类型注解。
		const { models_autoload: modelsAutoload, chat_template: chatTemplate } = payload as Record<string, unknown>;
		return {
			// 条件对象展开：真是boolean才放字段，false也会保留，不是按真值丢掉false。
			...(typeof modelsAutoload === "boolean" ? { models_autoload: modelsAutoload } : {}),
			// 真是string才放模板，空串也保留；不验证模板语法或执行它。
			...(typeof chatTemplate === "string" ? { chat_template: chatTemplate } : {}),
		};
	}

	// POST请求加载一个模型，返回Promise<void>只说明HTTP层完成，不等目录已loaded；例load("qwen")只发指令。
	async load(model: string, signal?: AbortSignal): Promise<void> {
		// JSON.stringify把{model}变正文文字，方法为POST；await等待request，未检查payload.success。
		await this.request("/models/load", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	// POST请求卸载，等待HTTP完成但不轮询；例unload("qwen")返回时远端仍可能卸载中。
	async unload(model: string, signal?: AbortSignal): Promise<void> {
		// 路径与load不同，其余请求/错误处理共用，不在此取消其他watcher。
		await this.request("/models/unload", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	// 先发卸载，再查目录，未完成就等100ms后再查，直到模型消失或状态unloaded；返回Promise<void>，错误/取消拒绝。
	// 没有总轮询时限，持续sleeping/loading等状态可一直等，HTTP每次另有15秒超时；不等待任意其他模型退出。
	async unloadAndWait(model: string, signal?: AbortSignal): Promise<void> {
		// 卸载请求失败就不进入轮询，错误向上传播。
		await this.unload(model, signal);
		// 无限循环只靠下面返回/抛错结束，while(true)不是后台线程。
		while (true) {
			// 每轮重新查目录，再按id找第一条目标，不用aliases匹配。
			const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
			// 目录没目标或已unloaded都可完成，不另外核文件/服务子进程是否真正清理。
			if (!entry || entry.status.value === "unloaded") return;
			// 尚未完成就可取消地等100ms，下一轮再查。
			await sleep(100, signal);
		}
	}

	// POST让服务下载指定模型，Promise<void>只等请求完成，不等文件下载完成。
	// 例如owner/repo:Q4_K_M交服务解释，此方法不访问Hugging Face或写本地模型文件。
	async download(model: string, signal?: AbortSignal): Promise<void> {
		// 发到/models而非/models/load，JSON正文仍只有model。
		await this.request("/models", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	// 消费/models/sse事件流：读字节→UTF-8流式解码→按空行拆帧→拼data行→解析JSON→通知回调。
	// 例如两块拼成一帧JSON后才回调；本方法无默认15秒超时、重连/事件ID/完整SSE语法支持。
	// 只有完整空行帧才消费，末尾残帧/解码尾部未flush；未在finally cancel/releaseLock，靠外部信号/流结束，回调抛错也会被同一catch吞掉。
	async watch(onEvent: (event: LlamaModelEvent) => void, signal?: AbortSignal): Promise<void> {
		// SSE另建头，不走上面的request，以便正文长期保持可读流。
		const headers = new Headers();
		// 可选Bearer认证；没有key则不设置该头。
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		// 直接fetch长连接，只用调用方signal；不先等待握手完成再让外层发load/download，因此可能有启动竞态。
		const response = await fetch(`${this.serverUrl}/models/sse`, { headers, signal });
		// 非2xx或没正文都报错；没有单独验证Content-Type必须为text/event-stream。
		if (!response.ok || !response.body) throw new Error(`llama.cpp SSE returned HTTP ${response.status}`);
		// getReader锁定响应流供逐块读取，后面没有显式releaseLock。
		const reader = response.body.getReader();
		// 默认UTF-8 TextDecoder，stream模式可保留跨块未完整的多字节字符。
		const decoder = new TextDecoder();
		// 累计尚未形成完整事件帧的文字，没有设置最大缓冲长度。
		let buffer = "";
		// 持续读取直到done或read拒绝；拒绝会使watch的Promise失败。
		while (true) {
			// await下一块，不忙等；chunk含done和值。
			const chunk = await reader.read();
			// 流结束立即break，未对decoder做最终flush或消费buffer残余。
			if (chunk.done) break;
			// 流式解码可拼UTF-8字符，但CRLF替换逐块做：若CR和LF分在两块，此处不保证规范成单个LF。
			buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
			// 仅把两个LF当帧边界，SSE的其他行尾/完整语法并未统一实现。
			let boundary = buffer.indexOf("\n\n");
			// 同一块可能含多帧，因此内层循环直到再无空行。
			while (boundary >= 0) {
				// 取边界前文字作这一帧，slice返回新字符串。
				const frame = buffer.slice(0, boundary);
				// 移走整帧和两个LF，剩下文字继续留给下一帧。
				buffer = buffer.slice(boundary + 2);
				// 只把本帧的data行拼成一个JSON文本，其余event/id/retry等行不参与。
				const data = frame
					// 先按LF拆成各行。
					.split("\n")
					// 只接受从行首开始的data:，不把前导空格行当data。
					.filter((line) => line.startsWith("data:"))
					// 去前5字符data:再trimStart所有开头空白，比仅去一个空格更宽；不trim末尾。
					.map((line) => line.slice(5).trimStart())
					// 多条data行以LF连接，组成待解析JSON文本。
					.join("\n");
				// 空data不解析、不回调，其他真值字符串进入try。
				if (data) {
					// 这个try同时覆盖JSON.parse和用户回调，不仅保护解析器。
					try {
						// as LlamaModelEvent不验证结构，下一句只核两个字符串字段。
						const event = JSON.parse(data) as LlamaModelEvent;
						// 真值且model/event为string就调用，可为空串；载荷data仍unknown，回调同步抛错也被catch吞掉。
						if (event && typeof event.model === "string" && typeof event.event === "string") onEvent(event);
						// 坏JSON/回调异常均安静略过，英文只提坏事件而实际范围更宽。
					} catch {
						// Ignore malformed events; catalog polling remains authoritative.
					}
				}
				// 继续找剩余buffer的第一帧边界，避免漏同一块中的后续事件。
				boundary = buffer.indexOf("\n\n");
			}
		}
	}

	// 开始加载并等待：并行启动SSE记录进度/终态，再发load，查目录后未完成就等250ms再查。成功返回目标条目，错误/取消拒绝。
	// 目录loaded优先；若SSE曾报loaded而目录没目标，则合成最小loaded条目返回，因此并非所有成功都经目录确认。
	// finally解除监听并请求取消watch，但不await它退出，也不卸载远端模型；外部未取消且一直无终态时可无限轮询。
	async loadAndWait(
		// 精确匹配的目标id。
		model: string,
		// 同步进度回调，Promise返回值不在此等待；初始回调抛错会拒绝整个操作，事件回调抛错却会被watch吞掉。
		onProgress: (progress: LlamaProgress) => void,
		// 可选协作取消信号，不在类型层面强制提供截止时间。
		signal?: AbortSignal,
	): Promise<LlamaModelInfo> {
		// 为SSE单独建控制器，正常结束时可停止自己的长连接。
		const watcher = new AbortController();
		// 把外部取消转发给watcher，并保存解除监听函数。
		const unlink = linkSignal(signal, watcher);
		// 是否收到目标模型loaded事件，初始没有。
		let eventLoaded = false;
		// 收到unloaded事件时记录失败消息，后面轮询决定是否抛出。
		let eventError: string | undefined;
		// void表示不等待这个Promise；仍显式catch避免watch失败未处理，加载操作继续靠轮询。
		void this.watch((event) => {
			// 别的模型事件直接略过，不更新本次标志。
			if (event.model !== model) return;
			// 只处理两类状态通知，其他下载等事件忽略。
			if (event.event !== "model_status" && event.event !== "status_change") return;
			// 断言只描述可能的status字段，原值仍可能不是该对象；可选链使null/undefined不解引用。
			const data = event.data as { status?: unknown } | undefined;
			// 只要曾收到loaded就置true，之后不在其他事件中清回false。
			if (data?.status === "loaded") eventLoaded = true;
			// unloaded记失败，后来的成功轮询返回顺序仍优先于此错误。
			if (data?.status === "unloaded") eventError = "Model failed to load";
			// 用实际data做浅进度解析，缺progress则undefined。
			const progress = parseLoadProgress(event.data);
			// 有进度才调同步回调，此处抛错被watch帧try捕获。
			if (progress) onProgress(progress);
			// SSE异常被吞掉，不直接使loadAndWait失败；watcher.signal另控制长连接。
		}, watcher.signal).catch(() => {});
		// 实际load/初始回调/轮询都在try中，以便finally请求关闭SSE。
		try {
			// 等HTTP加载指令完成，不是等模型已经loaded。
			await this.load(model, signal);
			// 先报告通用加载文字，事件可能已更早到来；这个直接回调异常会传播。
			onProgress({ message: "Loading model" });
			// 开始无限查目录，每次请求与sleep都可被传入signal取消。
			while (true) {
				// 每轮先检查已取消，原reason为null/undefined才补Cancelled错误。
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				// 取最新目录里第一条同id模型，未缓存上轮目录。
				const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
				// 目录已经loaded立即返回整条entry，即使之前SSE曾报错误也先成功。
				if (entry?.status.value === "loaded") return entry;
				// 目录暂时无目标但SSE曾报loaded时合成最小结果；没有meta/架构等附加字段。
				if (eventLoaded && !entry) return { id: model, status: { value: "loaded" } };
				// 目录报告failed或SSE记录错误才进失败分支；普通unloaded且没有事件错误时仍会继续等。
				if (entry?.status.failed || eventError) {
					throw new Error(
						// 有没有exit_code决定错误文字来源，0同样属于已提供退出码，不按假值忽略。
						entry?.status.exit_code === undefined
							? // 没退出码时优先SSE错误，缺失才用通用失败消息。
								(eventError ?? "Model failed to load")
							: // 有退出码就插入具体数字，不同时附前面的eventError。
								`Model exited with code ${entry.status.exit_code}`,
					);
				}
				// 本轮未结束就等待250ms，等待期间取消会拒绝并进入finally。
				await sleep(250, signal);
			}
			// 成功return/失败throw都会进入清理；不是事务回滚。
		} finally {
			// 先解除外部到watcher的监听，避免操作后继续保留闭包。
			unlink();
			// 请求中止SSE，未await watch Promise，也没调用远端unload。
			watcher.abort();
		}
	}

	// 开始下载并等待：SSE收完成/失败/字节进度，POST后查目录，未完成就等500ms再查，满足启发条件后要求reload再返回目录。
	// 例事件报download_finished且当前不在downloading时可结束；没事件时目标出现且看过downloading或已查至少两轮也可结束。
	// 这不校验文件内容/全部分片；finally只请求停止SSE，不停止远端下载，整项没有统一时限。
	async downloadAndWait(
		// 模型仓库/量化标识，由服务解析，例如owner/repo:Q4_K_M。
		model: string,
		// 同步进度回调，执行抛错的传播范围同上：事件内被吞，直接调用会拒绝本操作。
		onProgress: (progress: LlamaProgress) => void,
		// 可选取消信号也传最终reload请求，不能保证服务端文件下载已停止。
		signal?: AbortSignal,
	): Promise<LlamaModelInfo[]> {
		// 单独控制本操作的SSE连接，不直接控制远端模型任务。
		const watcher = new AbortController();
		// 转发已有/未来外部取消，返回清理闭包。
		const unlink = linkSignal(signal, watcher);
		// 是否看过完成事件，初始false，置true后不重置。
		let finished = false;
		// 可选失败文字，后面在下一轮HTTP前检查。
		let failure: string | undefined;
		// 是否从事件或目录看过下载中，帮助判断已从下载转为其他状态。
		let sawDownloading = false;
		// 已成功获得目录的轮数；不是经过秒数或服务重试次数。
		let polls = 0;
		// 不等SSE连接建立就继续POST，监听失败由catch吞掉，仍可用轮询。
		void this.watch((event) => {
			// 过滤其他模型事件，必须精确相同model文字。
			if (event.model !== model) return;
			// 完成事件只改标志，不立即在回调里resolve外层Promise。
			if (event.event === "download_finished") finished = true;
			// 失败事件从嵌套error.message提取信息，缺则通用Download failed。
			if (event.event === "download_failed") failure = errorMessage(event.data, "Download failed");
			// 下载进度事件才解析字节量。
			if (event.event === "download_progress") {
				// 即使解析器不给有效进度，此事件也记为看过下载中。
				sawDownloading = true;
				// 把事件data归一成累计字节进度，失败返回undefined。
				const progress = parseDownloadProgress(event.data);
				// 解析有结果才回调，抛错由watch捕获而非直接传播本循环。
				if (progress) onProgress(progress);
			}
			// 这个catch不保存SSE失败原因，下载仍靠目录启发条件推进。
		}, watcher.signal).catch(() => {});
		// 把POST、初始回调和所有轮询纳入finally清理范围。
		try {
			// 先等发下载指令的HTTP结束，不等GGUF文件完成。
			await this.download(model, signal);
			// 立即通知通用下载阶段，回调同步错误会向上传播。
			onProgress({ message: "Downloading model" });
			// 无限循环直到返回或拒绝，未按polls设置总轮数上限。
			while (true) {
				// 外部已取消则抛reason/缺省Cancelled，不再请求下一目录。
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				// 已记录下载失败就拒绝；若失败在这句之后才来，仍可能与当前轮返回竞争。
				if (failure) throw new Error(failure);
				// 每轮查一次当前目录，HTTP失败直接拒绝操作。
				const models = await this.list({ signal });
				// 只有list成功返回才加1。
				polls++;
				// 在目录里按id找目标，不用aliases或去除量化后缀。
				const entry = models.find((candidate) => candidate.id === model);
				// 只要目录仍为downloading，即使完成事件已来，也先继续这一分支，不立刻返回。
				if (entry?.status.value === "downloading") {
					// 轮询也可建立看过下载中的标志，不依赖SSE一定收到了。
					sawDownloading = true;
					// 把目录status.progress的直接文件字典交解析器。
					const progress = parseDownloadProgress(entry.status.progress);
					// 目录进度回调在外层try中，异常会拒绝并清理watcher。
					if (progress) onProgress(progress);
					// 仅在“不处于downloading”时判断：完成事件，或目标存在且看过下载中/至少第二轮，任一可触发收尾。
				} else if (finished || (entry && (sawDownloading || polls >= 2))) {
					// return Promise不await：先启动reload查询并立即进入finally取消SSE，再让外层Promise跟随最终目录请求结果。
					return this.list({ reload: true, signal });
				}
				// 还没满足就可取消地等待500ms再试；完成事件本身不会主动唤醒这个sleep。
				await sleep(500, signal);
			}
			// 所有try退出路径都尝试清理连接通知关系，不删除下载文件或撤销POST。
		} finally {
			// 移除外部信号监听，已取消状态不会因此被恢复。
			unlink();
			// 仅abort自己的SSE请求，不await读取器关闭，不另发unload。
			watcher.abort();
		}
	}
}
