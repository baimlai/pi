// 为 /llama 下载界面查 Hugging Face 的 GGUF 仓库、量化名称/大小和访问限制，并按约定位置寻找 token。
// 这里只读目录信息，不下载模型文件；真正下载由 index.ts 交给配置的 llama.cpp 服务执行。
// 异步文件 API 返回 Promise；import 只取得函数引用，此处不会立即读用户的 token 文件。
import { readFile } from "node:fs/promises";
// homedir() 按宿主 HOME（POSIX）/USERPROFILE（Windows）等规则找用户目录；独立传入的 env 对象不会替换它读取的宿主环境。
import { homedir } from "node:os";
// join 按当前操作系统规则拼接文件路径，不能拿来拼 HTTP URL。
import { join } from "node:path";

// 未提供第二个构造参数时使用的公开服务地址；可传本机假服务器 URL 做测试。
const DEFAULT_HUGGING_FACE_URL = "https://huggingface.co";
// 量化用较少位表示模型数值以减小体积；这里按名字分类，不读取模型数值或判断质量。
// 名称必须在去掉分片尾缀后的文件名末尾，如 model-Q4_K_M → Q4_K_M；不是扫描文件内容。
const QUANTIZATION_PATTERN =
	// 非捕获组 (?:...) 只分组；第1捕获组保留名称。i 忽略大小写、u 按 Unicode 正则解析；IQ/Q 后需下划线分段，MXFP 的分段可省。
	/(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$/iu;
// 只去形如 -00001-of-00002 的末尾文字，两边都恰5位；不检查编号范围、实际片数或重复分片。
const SHARD_SUFFIX_PATTERN = /-\d{5}-of-\d{5}$/u;

// 搜索结果的静态形状；interface 在执行 JS 中被擦除，真正的外部数据检查在 search 中。
export interface HuggingFaceModel {
	// 仓库标识，例如 owner/model-GGUF；不是本地路径或已下载模型。
	id: string;
	// 展示用下载次数；当前实现只检查 number，未额外检查非负或有限数。
	downloads: number;
}

// 一个归类后的量化版本；同名分片甚至不同前缀的文件都会累加到同一项。
export interface HuggingFaceQuantization {
	// 规范成大写的名字，例如 Q4_K_M、F16。
	name: string;
	// ? 表示可缺省；size=undefined 表示至少一个被归类文件没有数字大小，不等于0字节。
	size?: number;
}

// 详情返回给下载界面，让用户选择量化版本、了解访问要求；它不是完整仓库 API 响应。
export interface HuggingFaceModelDetails {
	// 优先采用响应中的字符串 id，否则保留传入查询 id；不验证 owner/repository 格式。
	id: string;
	// 字面量联合仅允许这3种静态值：false 无已识别限制，auto/manual 为两类访问提示；不表示本地 token 已获准。
	gated: false | "auto" | "manual";
	// 数组每项为量化名称和可选大小；空数组也可能来自响应缺少 siblings。
	quantizations: HuggingFaceQuantization[];
}

// 从未知响应中提取非空 error 字符串，否则用调用方的兜底文字；不写日志、不脱敏。
// 例如 {error:"Denied"} 返回 Denied，{error:123} 返回 fallback；数组也可过第一层 object 检查。
function payloadError(payload: unknown, fallback: string): string {
	// 信任边界是网络解码后的 unknown；typeof null 也为 object，所以须单独排除 null。
	if (typeof payload !== "object" || payload === null) return fallback;
	// as 只告诉 TS 这里可能有 error 字段，不验证/克隆对象；读取结果仍为 unknown，下一句再判断。
	const error = (payload as { error?: unknown }).error;
	// && 使用真值判断，空字符串回退，纯空格字符串仍会原样返回。
	return typeof error === "string" && error ? error : fallback;
}

// 从 ratelimit 头提取 t= 的十进制数字用于报错提示，没有等待/重试副作用。
// 例如 r=0;t=30 → 30；r=0; t=30 因分号后有空格而不匹配；缺头时返回 undefined。
function parseRateLimitDelay(value: string | null): number | undefined {
	// ?. 在值为 null 时不调用 match；只认开头或紧接分号的 t=，数字后并未要求分隔边界。
	const match = value?.match(/(?:^|;)t=(\d+)/u);
	// match[1] 是数字捕获组，Number 转成数值；0也可返回，但调用方会按假值省略提示。
	return match ? Number(match[1]) : undefined;
}

// 读一个 token 文件并 trim；返回非空字符串或 undefined。文件不存在、权限/读取等异常都被吞成 undefined。
// 例如文件内容是空格加 hf_x 再换行，会得到 hf_x；不缓存、不检查 token 格式或实际访问权限。
async function readToken(path: string): Promise<string | undefined> {
	// try 覆盖异步读取和后续 trim；被 await 的 Promise 拒绝也会进 catch。
	try {
		// utf8 指定文本解码；await 等到读完，不是让整个 Node 线程同步阻塞；trim 去两端空白。
		const token = (await readFile(path, "utf8")).trim();
		// || 在空串时返回 undefined，其他字符串原样保留。
		return token || undefined;
		// 不接收错误参数，表示这里不区分不存在、权限失败等原因；也没有输出敏感 token。
	} catch {
		// 读取失败与空文件在返回值上都表现为“没找到”，调用方可继续尝试下一位置。
		return undefined;
	}
}

// 按优先级找第一个非空 token：HF_TOKEN → HF_TOKEN_PATH → HF_HOME/token → XDG 缓存 → 用户默认缓存。
// 例如传 {HF_TOKEN:" hf_x "} 立即返回 hf_x，不读文件；若传空对象，仍可能读真实 homedir 默认文件。
// 参数缺省才使用 process.env；重复的路径字符串去重，按顺序串行读，失败/空内容继续，不修改 env 或文件。
export async function findHuggingFaceToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	// NodeJS.ProcessEnv 是 Node 声明的环境映射类型；?.trim() 在字段不为 undefined/null 时调用，空串也会 trim，再被下一句跳过。
	const fromEnvironment = env.HF_TOKEN?.trim();
	// 有效的环境 token 优先，早返回意味着下面的路径计算与读文件都不会执行。
	if (fromEnvironment) return fromEnvironment;

	// 建立候选数组；某些环境值不存在时先放 undefined，再由 filter 去掉。
	const paths = [
		// 显式 HF_TOKEN_PATH 优先于其他文件位置；路径字符串本身不 trim，相对路径按进程 cwd 解释。
		env.HF_TOKEN_PATH,
		// 只有 HF_HOME 为真值才拼 token；空串跳过，空格字符串仍会参与拼接。
		env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
		// 其次按 XDG_CACHE_HOME/huggingface/token 约定寻找，不创建目录。
		env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "huggingface", "token") : undefined,
		// 最后总有 homedir() 下的默认候选；独立 env.HOME 不影响它，真正修改宿主 process.env.HOME 等则可能影响。
		join(homedir(), ".cache", "huggingface", "token"),
		// path is string 是类型谓词，向 TS 声明过滤后为字符串；实际 Boolean 仅排除 undefined/空串，不验证文件存在或路径安全。
	].filter((path): path is string => Boolean(path));
	// Set 按首次出现顺序去掉相同路径文字；不解析软链/绝对路径，因此同一真实文件仍可能用不同拼法读多次。
	for (const path of new Set(paths)) {
		// for...of 配合 await 串行读取；前一个读完才试后一个，避免同时读所有候选。
		const token = await readToken(path);
		// 第一个非空结果就返回，后续候选不再读取。
		if (token) return token;
	}
	// 所有候选都失败/为空才返回 undefined；Promise 成功返回 undefined 不表示找到了凭据。
	return undefined;
}

// 封装带可选Bearer认证的 GET 和两种响应转换；new 实例本身不读 token、不发 HTTP。
// 通常由 index.ts 先调用 findHuggingFaceToken，再传给构造器；本类不自动刷新/重新查找 token。
export class HuggingFaceClient {
	// private/readonly 是 TS 的访问/赋值限制，不是 JS #私有字段或运行时冻结；实例保存传入字符串。
	private readonly token: string | undefined;
	// 保存去尾斜杠后的服务地址，后续直接与 API 路径相接。
	private readonly baseUrl: string;

	// token? 可不传，baseUrl 默认官方站点；例如 new HuggingFaceClient("hf_x", "http://127.0.0.1:1234/")。
	constructor(token?: string, baseUrl = DEFAULT_HUGGING_FACE_URL) {
		// 不 trim、不验证 token；空串后面不设认证头，空格字符串为真值仍会尝试构造头。
		this.token = token;
		// 仅删除整个字符串末尾的一个或多个 /；不解析 URL、不检查协议/可信主机，不自动补 https。
		this.baseUrl = baseUrl.replace(/\/+$/u, "");
	}

	// 发送一次 GET，合并调用方取消与15秒超时，尽量解析JSON，非2xx抛错，成功返回 unknown。
	// 例如 /api/models?... 返回数组供 search 再核对；无重试、无分页循环，fetch/头构造错误直接拒绝。
	// JSON读取异常被吞掉：2xx时可能返回 undefined，HTTP错误时继续产生状态报错，不保证取消错误原样传播。
	private async request(path: string, signal?: AbortSignal): Promise<unknown> {
		// 为本次请求新建 Headers，不与上一次请求共用可变头。
		const headers = new Headers();
		// 仅 token 为真值时设置 Authorization；模板字符串插入令牌，不能把它误认为在这里刷新认证。
		if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
		// 数字下划线提高可读性，15_000 就是15000毫秒；timeout 创建到时发取消信号的对象。
		const timeout = AbortSignal.timeout(15_000);
		// 字符串直接拼接URL；未给 method 默认GET，无body，await 等响应头后继续，正文下一段读取。
		const response = await fetch(`${this.baseUrl}${path}`, {
			// 属性简写等价 headers: headers，把刚建立的头交给 fetch。
			headers,
			// any 在两个信号中任一取消时取消组合信号；没有调用方signal就只用超时，不等于所有外部任务已停止。
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		// let 允许后面赋值；unknown 要求使用方检查实际形状，避免直接假定网络内容符合 TS 接口。
		let payload: unknown;
		// 这里只捕获JSON正文读取/解析错误，前面的 fetch 失败不在此 try 内。
		try {
			// 等待整个正文并解析JSON；不先检查Content-Type，也没有设置正文大小上限。
			payload = await response.json();
			// 畸形JSON或读取被取消等都走这里，未保存原始异常。
		} catch {
			// 用 undefined 表示未得到JSON，成功状态也会继续返回它供上层判断。
			payload = undefined;
		}
		// Response.ok 为200–299；其他状态不当作可用搜索/详情结果。
		if (!response.ok) {
			// 错误体没提供非空字符串 error 时，兜底文字只含HTTP状态码。
			const fallback = `Hugging Face returned HTTP ${response.status}`;
			// 429单独给限流提示，不发起重试，也不等待指定秒数。
			if (response.status === 429) {
				// 先把 retry-after 按数字解释；该表达式不支持HTTP日期形式，也未额外拒绝负数/Infinity。
				const delay =
					// || 让0/NaN回退到ratelimit的t值；头缺失时 Number(null)=0，同样回退。
					Number(response.headers.get("retry-after")) || parseRateLimitDelay(response.headers.get("ratelimit"));
				// throw 使 async Promise 拒绝；调用方必须捕获或继续向上抛。
				throw new Error(
					// 只在 delay 为真值时附数字秒数；这是提示字符串，不是定时器或自动重试策略。
					delay ? `Hugging Face rate limit reached; retry in ${delay}s` : "Hugging Face rate limit reached",
				);
			}
			// 其他错误优先用响应的 error 字符串，否则用状态兜底；字符串内容没有再清洗/脱敏。
			throw new Error(payloadError(payload, fallback));
		}
		// 2xx返回已解析值或 undefined，没有这里统一强制成对象/数组。
		return payload;
	}

	// 查GGUF仓库：编码查询参数→GET→验证顶层数组→过滤坏条目，返回模型id和下载次数。
	// 例如 search("qwen coder") 请求服务器最多给20项；不保证服务端真限20，也不自己二次排序/分页。
	async search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
		// URLSearchParams 负责编码参数，空格等特殊字符不会直接成为手写查询分隔符。
		const params = new URLSearchParams({
			// 保留原query，不自动trim、不设最少长度；UI另按UTF-16长度设2码元门槛，某些汉字占2码元，这不是本方法的限制。
			search: query,
			// 要求远端按gguf过滤，只约定查询参数，不在返回结果中再次验证模型一定含GGUF。
			filter: "gguf",
			// 请服务器按下载次数排序。
			sort: "downloads",
			// 字符串-1请求降序；URL查询参数都以文字形式发送。
			direction: "-1",
			// 只请求20项，未跟随分页链接继续请求。
			limit: "20",
		});
		// 模板插值会调用 params.toString；signal 继续交给底层组合超时信号。
		const payload = await this.request(`/api/models?${params}`, signal);
		// 网络数据是unknown，顶层非数组直接抛错；此处不是对已类型保证的参数做重复检查。
		if (!Array.isArray(payload)) throw new Error("Hugging Face returned invalid search results");
		// flatMap 每条返回[]删掉或[一项]保留，最后合成一层数组；不是修改原响应数组。
		return payload.flatMap((value) => {
			// 逐项的网络边界检查：非null对象且id为字符串才保留；未排除数组、空id或继承属性。
			if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string")
				// 空数组使这条坏记录被过滤，而不是让整次搜索报错。
				return [];
			// as 声明已检查id、仍未知downloads的视图；不把远端所有字段复制进输出。
			const model = value as { id: string; downloads?: unknown };
			// 只检查downloads是number，否则用0；不验证有限/非负，不去重仓库id。
			return [{ id: model.id, downloads: typeof model.downloads === "number" ? model.downloads : 0 }];
		});
	}

	// 取仓库详情并汇总GGUF量化：按路径段编码id→读siblings→按量化名累加→优先Q4_K_M、再大小/名字排序。
	// 例如Q4_K_M两片2000和3000得到5000；这里只算返回列表，未验证真的有全部分片、片号连续或文件可下载。
	// 缺任一归类文件大小则该量化size为undefined；缺siblings返回空列表，gated仅识别auto/manual，不代表当前token获准。
	async details(id: string, signal?: AbortSignal): Promise<HuggingFaceModelDetails> {
		// 按 / 拆段再各自 encodeURIComponent，保留owner/repo分隔符；不会用URL解析器验证仓库结构。
		const encodedId = id.split("/").map(encodeURIComponent).join("/");
		// blobs=true请求包含文件大小等元数据；await结束后仍需检查返回值。
		const payload = await this.request(`/api/models/${encodedId}?blobs=true`, signal);
		// 未知响应先排除原始值/null；数组也属于object，所以此守卫不排除数组或强制三个字段齐备。
		if (typeof payload !== "object" || payload === null) {
			// 不满足顶层条件则给具体详情错误，而不是返回空模型。
			throw new Error("Hugging Face returned invalid model details");
		}
		// 把未知字段显式标unknown，后续逐项收窄；as本身没有执行JSON schema验证。
		const model = payload as { id?: unknown; gated?: unknown; siblings?: unknown };
		// Map泛型写明key为量化名称、value为累计大小和已知大小标志；complete只指已归类文件大小全有，不指分片完整。
		const sizes = new Map<string, { total: number; complete: boolean }>();
		// 仅siblings实际为数组才遍历，缺失/其他类型直接保留空Map。
		if (Array.isArray(model.siblings)) {
			// 逐一处理服务器列出的条目，不另外请求仓库目录/文件。
			for (const value of model.siblings) {
				// 网络边界先排除原始值/null；continue只跳过当前文件，数组条目仍可进入后续字段检查。
				if (typeof value !== "object" || value === null) continue;
				// 文件名/大小保持unknown，不能只靠类型断言当作可信字符串/数字。
				const file = value as { rfilename?: unknown; size?: unknown };
				// 只保留字符串路径且不区分大小写以.gguf结尾的条目，未验证内容真是GGUF。
				if (typeof file.rfilename !== "string" || !file.rfilename.toLowerCase().endsWith(".gguf")) continue;
				// 用正斜杠取最后一段；! 是非空断言，split至少产生一项是这里的依据，!不执行检查。
				const filename = file.rfilename.split("/").at(-1)!;
				// 忽略文件名以mmproj开头的投影模型，即使其后含合法量化名也不计入。
				if (filename.toLowerCase().startsWith("mmproj")) continue;
				// slice(0,-5)去扩展名，再用固定分片正则去编号；不检查文件数量与-of-数字相符。
				const stem = filename.slice(0, -5).replace(SHARD_SUFFIX_PATTERN, "");
				// ?.[1]安全取捕获名称，?.toUpperCase()规范大小写；不匹配就得到undefined。
				const quantization = stem.match(QUANTIZATION_PATTERN)?.[1]?.toUpperCase();
				// 无法识别量化的文件不进入汇总，没有放到“其他”一类。
				if (!quantization) continue;
				// ?? 仅在Map没记录时新建对象；已有记录直接复用同一可变对象，名称相同但文件前缀不同也合并。
				const current = sizes.get(quantization) ?? { total: 0, complete: true };
				// 数字大小直接累加，没有有限/非负校验；同一文件若重复出现在列表中也会重复计数。
				if (typeof file.size === "number") current.total += file.size;
				// 有一个大小缺失/非数字就永久置false，之后即使出现数字也不会恢复true。
				else current.complete = false;
				// 保存累计对象；已有对象本就同引用，这里同时让首次量化加入Map。
				sizes.set(quantization, current);
			}
		}
		// 展开Map得到[名称,累计对象]数组，后面的map生成独立输出对象；不改变原Map顺序。
		const quantizations = [...sizes]
			// 参数解构取name和统计对象；complete为false时输出size:undefined而不是当前部分总量。
			.map(([name, size]) => ({ name, size: size.complete ? size.total : undefined }))
			// sort就地排序刚生成的数组；比较器负数代表left排前面。
			.sort((left, right) => {
				// 优先把Q4_K_M放最前，名称是代码推荐规则，不是运行测出质量更好。
				if (left.name === "Q4_K_M") return -1;
				// 左边不优先但右边是Q4_K_M，则左边排后；Map按名称合并后不会有两条Q4_K_M。
				if (right.name === "Q4_K_M") return 1;
				return (
					// 缺大小暂按MAX_SAFE_INTEGER比较，通常排在已知小值之后；并非所有可能数值下都保证未知最后。
					(left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER) ||
					// 大小差为0或NaN等假值时，||改用名称localeCompare作比较，不是额外HTTP排序请求。
					left.name.localeCompare(right.name)
				);
			});
		// 返回UI需要的新对象，不把token、完整原始响应或Map暴露出去。
		return {
			// 响应id为字符串就采用（含空串）；否则用原请求id，未核验两者指向同一仓库。
			id: typeof model.id === "string" ? model.id : id,
			// 严格只认auto/manual两种文字，其他值（包括true或未知文字）都归false。
			gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
			// 属性简写把已排序数组作为quantizations字段返回。
			quantizations,
		};
	}
}
