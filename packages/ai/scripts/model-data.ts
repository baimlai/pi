// 模型目录的离线分组、指纹与数据校验助手，供生成器、下载后本地水合脚本和校验测试调用；导入只定义函数，不自动读文件或联网。
// 这里的manifest把模型结构与JSON文本关联起来，不含脚本源码，也不是可信发布者的签名。
// Node内建SHA256工厂；调用update时才把传入文字按UTF8纳入摘要。
import { createHash } from "node:crypto";
// 同步文件API用于读取本地目录；错误通常直接抛出，只有readJsonObject特意把读取/解析错误写进errors数组。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
// join拼接宿主平台路径，不访问磁盘、不确认路径存在。
import { join } from "node:path";

// 数据清单格式的固定版本号，不是pi软件版本；只加源码注释不会改变它。
export const MODEL_DATA_SCHEMA_VERSION = 6;
// 每个data目录内清单的固定文件名；开头点是名称的一部分。
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

// 两层Record：外键是provider，内键是type:id，内值是API名，例如{p:{"chat:m":"openai-completions"}}；类型不会验证JSON。
export type ModelDataStructure = Record<string, Record<string, string>>;

// manifest的开发期形状；真正从磁盘读取的清单仍为unknown，要由后面的逻辑检查。
export interface ModelDataManifest {
	// 清单格式版本，在校验时与本文件的固定版本比较。
	schemaVersion: number;
	// 生成时刻文字；校验只要求Date.parse可解析，不强制ISO格式或足够新。
	generatedAt: string;
	// 排序后结构JSON的SHA256，不包含模型价格/名字等全部字段。
	structureHash: string;
	// 文件名到该JSON文件文字摘要的映射；文件正文中的空格、换行也影响摘要。
	files: Record<string, string>;
}

// 只识别生成器约定的三常量import文字和固定顺序，不是通用TypeScript语法分析器；提取路径里的provider片段。
const MODEL_DATA_IMPORT_PATTERN =
	// g找全部匹配，m使^/$按各行边界判断；大写常量、空格、引号与分号均须符合该模式。
	/^import \{ [A-Z][A-Z0-9_]*_CLASSIFIER_MODELS, [A-Z][A-Z0-9_]*_IMAGE_MODELS, [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

// 计算输入字符串的SHA256十六进制摘要，返回新串，无文件写入。例：JSON末尾多一个LF也会改变结果。
// 参数已经是文字，默认按UTF8编码；若读取阶段把非法UTF8解成替换字符，这不是原始磁盘Buffer逐字节取证。
function sha256(value: string): string {
	// 创建独立hash→加入文字→输出hex；digest结束本次hash，后续不复用这个对象。
	return createHash("sha256").update(value).digest("hex");
}

// 把可迭代的键值对按字符串关系排序后变成新对象，不修改传入容器；例如b、a两对通常输出a、b。
// <T>保留每个值的类型，readonly元组限制经此参数改二元组；值对象仍共享引用，整数样式键最终枚举仍遵循JS规则。
function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	// Array.from物化迭代器，sort只改这份新数组；解构取键，三元给-1/1/0，再fromEntries建立自有属性，重名键以后值覆盖。
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// 按相同长度与逐位置严格相等比较两份只读字符串数组，返回boolean无修改；例如[a,b]与[b,a]为false，不作集合去重。
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	// &&短路：长度不等不遍历；every遇首个不等就停，空数组在长度相等时为true。
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

// 比较两份名称集合，返回缺少/多出项的诊断串、不抛错；例如预期a,b实际a,c得到missing:b和extra:c两部分。
function describeSetDifference(expected: readonly string[], actual: readonly string[]): string {
	// 建立预期Set供成员查询，避免每次都扫描原数组；不修改输入，也不承诺最坏情况为常数时间。
	const expectedSet = new Set(expected);
	// 建立实际Set，重复项折叠。
	const actualSet = new Set(actual);
	// 筛出实际集合没有的预期值，顺序沿用expected；此函数本身不删除输出中的重复项。
	const missing = expected.filter((value) => !actualSet.has(value));
	// 反向筛出预期集合没有的实际值。
	const extra = actual.filter((value) => !expectedSet.has(value));
	// 两种差异分别有内容才拼说明，否则先放空串；模板插入逗号连接的名称。
	return [missing.length > 0 ? `missing: ${missing.join(", ")}` : "", extra.length > 0 ? `extra: ${extra.join(", ")}` : ""]
		// Boolean作filter谓词，在这份字符串数组中去掉空串。
		.filter(Boolean)
		// 用分号空格连接非空部分，无差异时得到空串。
		.join("; ");
}

// 断言两组模型ID的集合完全相等，成功返回void，缺少或多出则抛Error；不比较重复次数或输入顺序。
// label只用于报错。例：预期a,b而实际a时抛missing:b；调用方可把它当生成目录的精确允许列表。
export function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	// Set先去重，再转数组并默认按字符串UTF16顺序排序；单次迭代器在这里被消费。
	const expectedIds = Array.from(new Set(expected)).sort();
	// 实际ID用相同方式归一化，不把API或模型字段也纳入比较。
	const actualIds = Array.from(new Set(actual)).sort();
	// 归一化后的数组逐位置相同就结束，不返回一个true值。
	if (sameStrings(expectedIds, actualIds)) return;
	// 集合不同则构造说明并抛错，调用方未catch时会中止其流程。
	throw new Error(`${label} model IDs do not match (${describeSetDifference(expectedIds, actualIds)})`);
}

// 把unknown缩窄为非null、非数组对象，返回类型谓词；例如{}通过，[]/null不通过。它不验证字段、原型或仅有自有属性。
function isRecord(value: unknown): value is Record<string, unknown> {
	// typeof null也是object所以额外排除；类实例等其他对象仍可能通过，不能称作严格普通JSON对象验证。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 判断是否非空的text/image数组，返回类型谓词无修改；例如[text,image]通过，[]或[audio]失败，重复text仍允许。
function isModalityList(value: unknown): value is ("text" | "image")[] {
	// 先Array.isArray与长度再every；在任意JS数组上every会跳空槽，真实JSON.parse得到的数组没有这种稀疏空槽。
	return Array.isArray(value) && value.length > 0 && value.every((entry) => entry === "text" || entry === "image");
}

// 同步读path并要求JSON顶层为对象；成功返回解析对象，失败返回undefined并追加description诊断，不写文件。
// 例：缺文件也被归入“not valid JSON”说明；errors是调用方共享数组，底层读取错误与JSON语法错误在同一个catch内。
function readJsonObject(path: string, description: string, errors: string[]): Record<string, unknown> | undefined {
	// 局部unknown迫使后面先检查，JSON.parse的宽泛返回类型不直接当可信对象。
	let parsed: unknown;
	// try只覆盖读取与解析，不把下面所有业务验证也吞掉。
	try {
		// 同步读UTF8文字再JSON.parse，解析JSON数据而不是执行里面的JavaScript。
		parsed = JSON.parse(readFileSync(path, "utf8"));
	// 任一读取/解析异常进入catch；error在TS中是unknown。
	} catch (error) {
		// Error实例取message，其余值String化；push修改外部errors，不立即输出console。
		errors.push(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		// 错误后返回undefined，让调用方决定跳过还是抛出汇总错误。
		return undefined;
	}
	// 解析成功还要检查顶层，数组、字符串和null不满足对象要求。
	if (!isRecord(parsed)) {
		// 顶层形状不符也记录诊断，和语法无效区分。
		errors.push(`${description} must contain a JSON object`);
		// 此分支也明确返回undefined，不把错误对象混进正常目录。
		return undefined;
	}
	// 经过类型谓词后TS允许作为Record返回；内部字段依旧unknown。
	return parsed;
}

// 读取某provider的API分组JSON，返回排序的type:id→api结构；重复跨组键、没有模型键或读取错误会抛。
// 例如{api:{"chat:m":{...}}}变为{"chat:m":"api"}；这里只看组与键，不校验每个模型值，也不写文件。
function readProviderStructure(path: string, providerId: string): Record<string, string> {
	// 新错误数组供读取助手积累，仅属于这次调用。
	const errors: string[] = [];
	// 读指定文件并给诊断冠上provider.json名称；路径由调用方提供。
	const groups = readJsonObject(path, `${providerId}.json`, errors);
	// 没有可用对象时把已记录消息用LF连成一个Error抛出，不返回空结构冒充成功。
	if (!groups) throw new Error(errors.join("\n"));

	// Map记录每个完整模型键对应的组，避免普通对象继承键干扰这一步查重。
	const models = new Map<string, string>();
	// Object.entries只遍历JSON顶层自有可枚举分组，解构得到API名与unknown组值。
	for (const [api, value] of Object.entries(groups)) {
		// 每组须为非数组对象，错误立即抛出；这里尚未检查组名是否为受支持API。
		if (!isRecord(value)) throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		// 只取组内键；模型内容在本函数完全没有被验证。
		for (const modelKey of Object.keys(value)) {
			// 同一个完整键在第二个组再次出现就抛错；不同type但同id具有不同完整键。
			if (models.has(modelKey)) throw new Error(`${path} contains ${modelKey} in more than one API group`);
			// 保存完整键到API映射，Map.set会修改本地收集器。
			models.set(modelKey, api);
		}
	}
	// 所有组都空时拒绝，不允许一个provider没有任何模型键。
	if (models.size === 0) throw new Error(`${path} contains no generated model data`);
	// Map本身可迭代二元组，交sortedRecord转成排序后的新对象。
	return sortedRecord(models);
}

// 从packageRoot下生成聚合TS的固定import文字提取provider列表，返回排序的新数组；读取失败、无匹配、重复provider都抛错。
// 例如路径providers/p.models.ts提取p；只读取源码文字，不import生成模块、不解析它依赖的JSON。
export function readModelDataProviderIds(packageRoot: string): string[] {
	// 组成聚合文件路径，不根据进程cwd猜包位置。
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	// 同步读完整聚合TS为文字，这一步不执行其中import。
	const aggregator = readFileSync(aggregatorPath, "utf8");
	// matchAll按正则找全部import，Array.from的映射取第一个捕获组provider，再排序；不哈希这份TS源码。
	const providerIds = Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1]).sort();
	// 一个匹配都没有就抛，不把不符合生成格式的文件当空供应商目录。
	if (providerIds.length === 0) throw new Error(`No generated provider imports found in ${aggregatorPath}`);
	// Set去重后的数量不等原数量说明provider在import中重复。
	if (new Set(providerIds).size !== providerIds.length) {
		// 重复时给出聚合文件路径并中止，不静默合并。
		throw new Error(`Generated model aggregator contains duplicate provider imports: ${aggregatorPath}`);
	}
	// 返回已排序provider数组；不验证这些名称在上游服务真实存在。
	return providerIds;
}

// 读取packageRoot的生成结构：先比聚合import与分片文件名，再从当前data JSON抽取每个type:id/API，返回两层对象。
// 例：import里有p而目录无p.models.ts会抛；同步读磁盘，不import分片、不写文件，字段值检查留validateModelDataDirectory。
// 模型ID预期来自当前JSON，并非从TS分片解出独立上游允许列表；协调修改数据与manifest可绕过“一致性”核对，不是签名验证。
export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	// 定位手写/生成分片同处的providers目录。
	const providersDir = join(packageRoot, "src", "providers");
	// 内部JSON data目录在providers下。
	const dataDir = join(providersDir, "data");
	// 读取聚合TS中排序的provider列表；异常直接向上抛。
	const providerIds = readModelDataProviderIds(packageRoot);
	// 把provider各映为应有的.models.ts文件名，再按同规则排序。
	const expectedShards = providerIds.map((providerId) => `${providerId}.models.ts`).sort();
	// 列出providers直接目录项名称，不递归、不在这里stat确认每一项为普通文件。
	const actualShards = readdirSync(providersDir)
		// 只留下.models.ts后缀名称，其他手写入口被忽略。
		.filter((entry) => entry.endsWith(".models.ts"))
		// 排序后才能与预期逐位置比较，不依赖文件系统枚举顺序。
		.sort();
	// 文件名集合不一致则进入报错；因为都排序且预期已查重复，这里可作精确名单核对。
	if (!sameStrings(expectedShards, actualShards)) {
		// 抛出一个Error，不继续从不配套的结构提取数据。
		throw new Error(
			// 诊断包含缺少/多出分片名，而不是比较分片实现源码。
			`Generated model aggregator and provider shards do not match (${describeSetDifference(expectedShards, actualShards)})`,
		);
	}

	// 以provider排序后的键值对构造返回对象。
	return sortedRecord(
		// 每个provider创建一对，回调里会同步读取其JSON，任一失败使整次调用抛出。
		providerIds.map((providerId) => [
			// 这对的第一项是provider键。
			providerId,
			// 第二项是从该provider JSON键抽出的type:id→api结构，不复制模型全部字段。
			readProviderStructure(join(dataDir, `${providerId}.json`), providerId),
		]),
	);
}

// 计算结构指纹，输入两层映射、输出hex串，不读磁盘；先固定两层键序，再JSON序列化取SHA256。
// 例如仅改模型name不影响结构hash，改type:id或API通常会影响；价格等正文变化另由manifest.files检查。
export function modelDataStructureHash(structure: ModelDataStructure): string {
	// 为归一化结构创建新外层对象，不改原structure。
	const normalized = sortedRecord(
		// 遍历外层自有键值，回调返回provider与内层排序对象。
		Object.entries(structure).map(
			// 内层也用sortedRecord固定枚举；as const只让TS把返回数组视为只读二元组，不运行freeze。
			([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
		),
	);
	// JSON.stringify当前规范化映射，再对文字UTF8哈希；不包含generatedAt或本文件源码。
	return sha256(JSON.stringify(normalized));
}

// 从结构、文件文字与时刻创建新manifest对象，无读写磁盘；不验证时刻格式或文件名列表是否匹配结构。
// 例：fileContents给p.json的含LF正文，就记录该正文hash；调用者需自己把结果写入.manifest.json。
export function createModelDataManifest(
	// 输入模型结构用于structureHash，类型不自动校验内容。
	structure: ModelDataStructure,
	// Readonly只限制经此参数重赋文件内容字段，正文是string，不冻结传入对象。
	fileContents: Readonly<Record<string, string>>,
	// 调用方给定时刻字符串，水合脚本使用固定1970值保持确定性。
	generatedAt: string,
// 返回类型约束产出的四字段，不是对外部输入执行schema校验。
): ModelDataManifest {
	// 构造全新的清单外壳。
	return {
		// 写当前数据格式版本。
		schemaVersion: MODEL_DATA_SCHEMA_VERSION,
		// 属性简写原样放入时刻，不用当前时间自动替换。
		generatedAt,
		// 只对结构映射求hash。
		structureHash: modelDataStructureHash(structure),
		// 每份文件文字独立SHA256，按文件名排序后存新对象；不把manifest自身或脚本TS纳入这张表。
		files: sortedRecord(Object.entries(fileContents).map(([file, content]) => [file, sha256(content)] as const)),
	};
}

// 检查一条unknown模型的必要字段，返回void并把所有发现的问题追加errors；不会修正值、填默认或抛出字段错误。
// providerId/modelId/expectedApi是期望身份。例：chat模型缺maxTokens会记错，空baseUrl字符串或负价格仍可能通过这些有限规则。
function validateModelValue(
	// 磁盘JSON边界上的未知模型值，先不信任其字段。
	value: unknown,
	// 当前文件对应的供应商身份。
	providerId: string,
	// 从type:id键第一个冒号后拆出的模型ID，ID中后续冒号保留。
	modelId: string,
	// 当前分组名作为应有API，不在此检查该API是否已注册。
	expectedApi: string,
	// 共享可变错误数组，调用方最终决定是否汇总抛出。
	errors: string[],
): void {
	// 拼出provider/modelId诊断前缀，不是URL或磁盘路径。
	const label = `${providerId}/${modelId}`;
	// 先要求非null非数组对象，后续才安全读属性。
	if (!isRecord(value)) {
		// 记录对象形状错误，保留同批其他模型继续检查的机会。
		errors.push(`${label} must be an object`);
		// 该条模型已不能读字段，立即结束它的检查。
		return;
	}
	// 模型id必须严格等预期；JSON.stringify让诊断能区分引号字符串、null等值。
	if (value.id !== modelId) errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
	// provider也严格比较，不因字段存在就接受。
	if (value.provider !== providerId) {
		// 供应商身份不匹配只记错，不立即中断后续字段检查。
		errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`);
	}
	// 模型内部api必须与所在JSON组名一致。
	if (value.api !== expectedApi) {
		// 记录字段API错误，不在这里移动模型到另一个组。
		errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
	}
	// name须非空string，但没有trim，所以仅空格的名字仍可通过。
	if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
	// baseUrl仅要求string，允许空串，不执行URL解析/协议检查。
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	// input须为至少一个text/image元素的数组，不检查API实际是否支持这套组合。
	if (!isModalityList(value.input)) errors.push(`${label} has invalid input modalities`);
	// image类型额外要求输出模态包含image。
	if (value.type === "image") {
		// ||短路：模态数组验证失败时左边已true，不再调用includes；验证通过才检查是否含image。
		if (!isModalityList(value.output) || !value.output.includes("image")) {
			// 图片缺输出/仅text等都记为无效输出模态。
			errors.push(`${label} has invalid output modalities`);
		}
	// 非image类型只要output不是undefined就拒绝，null也算已提供。
	} else if (value.output !== undefined) {
		// chat或classifier不允许自带output模态字段。
		errors.push(`${label} has unsupported output modalities`);
	}
	// chat类型检查推理开关和上下文/最大输出限制。
	if (value.type === "chat") {
		// reasoning必须实际boolean，字符串false不等于false。
		if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
		// 下列三个条件任一成立都说明chat上下文窗口无效。
		if (
			// 首先须为number，数字字符串不会转换。
			typeof value.contextWindow !== "number" ||
			// Number.isFinite拒绝NaN与正负Infinity。
			!Number.isFinite(value.contextWindow) ||
			// 须严格大于0；不要求整数，正小数仍可通过。
			value.contextWindow <= 0
		) {
			// 把无效contextWindow记录进共享列表。
			errors.push(`${label} has invalid contextWindow`);
		}
		// maxTokens同样要求有限正数，不检查是否小于contextWindow或是否整数。
		if (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0) {
			// 记录chat最大输出限制错误。
			errors.push(`${label} has invalid maxTokens`);
		}
	// classifier只检查上下文窗口，不要求chat的reasoning/maxTokens。
	} else if (value.type === "classifier") {
		// 下面仍用三个条件联合判无效窗口。
		if (
			// classifier窗口先要求number。
			typeof value.contextWindow !== "number" ||
			// 再排除非有限数值。
			!Number.isFinite(value.contextWindow) ||
			// 最后要求大于0，不另取整。
			value.contextWindow <= 0
		) {
			// 记录分类模型窗口错误。
			errors.push(`${label} has invalid contextWindow`);
		}
	// 既非chat/classifier、也非image时，type不在允许三类中。
	} else if (value.type !== "image") {
		// 记录未知type，后面的成本检查仍会继续执行。
		errors.push(`${label} has type ${JSON.stringify(value.type)}, expected "chat", "image", or "classifier"`);
	}
	// cost须为非null非数组对象，未要求只含四个字段。
	if (!isRecord(value.cost)) {
		// 形状错误就记录，不继续从该cost读取数字。
		errors.push(`${label} has invalid cost metadata`);
	// cost对象通过后检查四项定价。
	} else {
		// as const把四个键保为字面量元组，逐项读取；不冻结数组，也不防模型有额外成本字段。
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			// 用动态字段名取该价格，值仍为unknown。
			const cost = value.cost[field];
			// 只要求有限number，未要求非负；真实JSON不能表示NaN，但其他JS调用仍可能传入。
			if (typeof cost !== "number" || !Number.isFinite(cost)) {
				// 记录具体cost字段名，允许一条模型累积多项错误。
				errors.push(`${label} has invalid cost.${field}`);
			}
		}
	}
}

// 把错误数组的前30条整理成一个Error并始终抛出，返回never表示不会正常返回；例如31条会显示30条及剩1条说明，不改变原数组。
function throwValidationErrors(errors: string[]): never {
	// slice复制前30个字符串，不删除errors中后续信息。
	const visible = errors.slice(0, 30);
	// 超过可见条数才追加“还有多少”后缀，否则空串。
	const suffix = errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
	// 给可见错误加项目符号并用LF拼接后抛出，不直接调用console。
	throw new Error(`Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`);
}

// 按给定预期结构检查dataDir：核文件名/manifest版本与hash，再逐provider检查模型键、API与必要字段；成功void，失败抛错，不写文件。
// 例：正文改价而manifest未更新会报hash；更新两者后仍须符合字段规则。它检查局部一致性，不认证上游身份或模型可调用性。
// 部分I/O错误会直接逸出，JSON读取错误会汇总；不是所有错误都能继续，也不是并发文件变化下的原子快照。
export function validateModelDataDirectory(structure: ModelDataStructure, dataDir: string): void {
	// 先确认路径存在且stat跟随符号链接后是目录；两次调用之间仍可能被外部修改。
	if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
		// 缺失或非目录立即抛，不进入错误汇总阶段。
		throw new Error(`Generated model data directory does not exist: ${dataDir}`);
	}

	// 收集本次可继续发现的数据问题，不与其他验证调用共享。
	const errors: string[] = [];
	// 从预期结构自有provider键计算应有的JSON文件名。
	const expectedFiles = Object.keys(structure)
		// 每provider映成provider.json，不在此检查路径字符策略。
		.map((providerId) => `${providerId}.json`)
		// 排序让后面比较不依赖对象插入顺序。
		.sort();
	// 同步枚举目录直接条目；未递归或逐项stat确认文件类型。
	const actualFiles = readdirSync(dataDir)
		// 仅检查.json后缀并排除manifest自身，非JSON杂项不在这张名单里。
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		// 实际文件名单也排序。
		.sort();
	// 预期与实际名称不同就记录差异，仍继续尝试读manifest和已有文件。
	if (!sameStrings(expectedFiles, actualFiles)) {
		// 缺少/多出provider数据文件作为一条诊断，不在此自动删除多余文件。
		errors.push(`provider data files do not match the generated catalog (${describeSetDifference(expectedFiles, actualFiles)})`);
	}

	// 拼清单路径。
	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	// 读清单unknown对象；失败会进errors，manifest取undefined后下面还会记录其他缺项。
	const manifest = readJsonObject(manifestPath, "model data manifest", errors);
	// 可选链让缺清单也按版本不符处理，严格比较当前数字版本。
	if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) {
		// 把版本错误消息追加列表。
		errors.push(
			// 显示实际值（可undefined）及应有版本，不自动迁移旧格式。
			`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
		);
	}
	// 时刻须string且Date.parse非NaN；没有规定ISO、时区、先后或有效期。
	if (typeof manifest?.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) {
		// 记录无法解析的时刻，不把它改为现在。
		errors.push("model data manifest has an invalid generation timestamp");
	}
	// 从调用方提供的结构计算独立于正文价格/名字的预期结构hash。
	const expectedStructureHash = modelDataStructureHash(structure);
	// 清单结构hash须严格等于本次计算值。
	if (manifest?.structureHash !== expectedStructureHash) {
		// 不一致记为生成结构印记失配，不声称已证明是哪一份文件被恶意修改。
		errors.push("model data generation stamp does not match the generated catalog");
	}
	// files字段通过非数组对象检查才采用原引用；这不是验证每个摘要值的hex格式。
	const manifestFiles = isRecord(manifest?.files) ? manifest.files : undefined;
	// 缺少可用文件hash表先记错。
	if (!manifestFiles) errors.push("model data manifest has no file hashes");
	// 存在hash表时进一步比键名。
	else {
		// 获取hash表自有文件名并排序，不看继承字段。
		const manifestFileNames = Object.keys(manifestFiles).sort();
		// 清单hash键名单须精确等provider JSON预期文件名。
		if (!sameStrings(expectedFiles, manifestFileNames)) {
			// 记录hash表中的缺失/额外条目，后面仍核现有正文摘要。
			errors.push(`manifest file hashes do not match provider data files (${describeSetDifference(expectedFiles, manifestFileNames)})`);
		}
	}

	// 逐个预期provider检查对应文件；expectedModels是其type:id→api映射。
	for (const [providerId, expectedModels] of Object.entries(structure)) {
		// 构造此provider的JSON名称。
		const filename = `${providerId}.json`;
		// 将它放到指定dataDir下。
		const path = join(dataDir, filename);
		// 文件不存在就跳过本provider正文；前面实际/预期名单差异通常已记缺少，非在这里再补模型错误。
		if (!existsSync(path)) continue;
		// 先同步读UTF8完整正文供hash；这次读失败直接抛，不经过readJsonObject的catch。
		const content = readFileSync(path, "utf8");
		// 有清单hash表时要求该文件摘要与正文文字hash相等；缺字段也会因undefined不等而报错。
		if (manifestFiles && manifestFiles[filename] !== sha256(content)) {
			// 记录正文与清单不一致，不立即拒绝继续解析。
			errors.push(`${filename} does not match its manifest hash`);
		}
		// 再次从磁盘读/解析同一路径；不是解析上面content，外部并发修改可能让两次读不同。
		const groups = readJsonObject(path, filename, errors);
		// JSON不可用时跳过这份provider的内部结构检查，保留已积累错误。
		if (!groups) continue;

		// 本地Map按完整type:id键记录实际所在API，供跨组查重与末尾比结构。
		const actualModels = new Map<string, string>();
		// 遍历JSON自有API分组，而不是遍历TypeScript声明中的API联合。
		for (const [api, value] of Object.entries(groups)) {
			// 每组值必须是非数组对象。
			if (!isRecord(value)) {
				// 组形状错误只记错，便于继续检查其他组。
				errors.push(`${filename} API group ${JSON.stringify(api)} must be an object`);
				// 跳过该无效组，不在非对象上Object.entries。
				continue;
			}
			// 逐组遍历完整模型键和unknown模型内容。
			for (const [modelKey, model] of Object.entries(value)) {
				// 相同完整键跨组重复时进入此分支。
				if (actualModels.has(modelKey)) {
					// 记录重复键，不静默把后一个当唯一模型。
					errors.push(`${providerId}/${modelKey} appears in more than one API group`);
					// 跳过该重复值的字段检查，Map仍保留第一组位置。
					continue;
				}
				// 先登记首次遇到的键/组，即使模型值后面校验失败也会计入实际键列表。
				actualModels.set(modelKey, api);
				// 只找第一个冒号的位置，-1表示键没有类型前缀分隔。
				const separator = modelKey.indexOf(":");
				// 有冒号取后续全部文字为modelId（可继续含冒号），无冒号沿用全键。
				const modelId = separator >= 0 ? modelKey.slice(separator + 1) : modelKey;
				// 按当前键/组检查模型值，把问题加同一errors数组，不转换或补默认。
				validateModelValue(model, providerId, modelId, api, errors);
				// 对象模型还须完整键严格等String(type):String(id)；这条同时防止无类型前缀或前缀不符。
				if (isRecord(model) && modelKey !== `${String(model.type)}:${String(model.id)}`) {
					// 记录键与模型身份不一致；String只为比较，不改原字段。
					errors.push(`${providerId}/${modelKey} has mismatched type/id identity`);
				}
			}
		}

		// 预期模型名单取完整type:id键并排序，名称虽叫Ids也包含type前缀。
		const expectedModelIds = Object.keys(expectedModels).sort();
		// 实际Map键同样排序供精确比较。
		const actualModelIds = Array.from(actualModels.keys()).sort();
		// 完整键集合不等进入差异记录。
		if (!sameStrings(expectedModelIds, actualModelIds)) {
			// 记录模型键缺失/额外，字段错误不会被等量键数掩盖。
			errors.push(`${filename} model IDs do not match the generated catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`);
		}
		// 再逐个预期完整键检查它实际分在哪个API组。
		for (const [modelId, expectedApi] of Object.entries(expectedModels)) {
			// Map.get找首个遇到的分组，缺键得到undefined。
			const actualApi = actualModels.get(modelId);
			// 存在且组不同才记此类错误；缺键已经由名单差异覆盖。
			if (actualApi !== undefined && actualApi !== expectedApi) {
				// 追加API位置差异诊断。
				errors.push(
					// 模板展示实际/预期API文字，JSON.stringify清楚呈现引号。
					`${providerId}/${modelId} is grouped under API ${JSON.stringify(actualApi)}, expected ${JSON.stringify(expectedApi)}`,
				);
			}
		}
	}

	// 有任何汇总问题才调用never助手抛出；零错误自然返回undefined，未生成一个验证通过对象。
	if (errors.length > 0) throwValidationErrors(errors);
}

// 校验一个包当前落地的生成数据，输入packageRoot、成功void；先读其当前结构，再核data目录，读盘/字段异常向外抛。
// 例如check-model-data CLI委托这里；聚合TS只提供provider名单，模型键结构仍从同份JSON抽出，不能当独立版本库模型快照比对。
export function validateGeneratedModelData(packageRoot: string): void {
	// 读取当前聚合名单、分片名称与JSON结构，无写入。
	const structure = readModelDataStructure(packageRoot);
	// 用该结构检查JSON正文和manifest，不执行任何模型请求。
	validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}

// 分组函数要求的最少类型字段；type为普通string，并不由此保证仅chat/image/classifier，运行JSON另须验证。
export interface ModelCatalogEntry {
	// 用于完整身份键前缀的类型名。
	type: string;
	// 同一上游id可在不同type下分别出现。
	id: string;
	// 决定落入哪个API分组，字符串类型不会校验API已实现。
	api: string;
}

/**
 * Group one provider's typed catalog entries by API and key them by `type:id`,
 * the layout of `src/providers/data/<provider>.json`.
 */
// 把一组模型按API分组，以type:id作键，返回groups正文与structure映射；不读写文件，模型对象保留原引用。
// 例：同id的chat与image分开；同API重复相同完整键会抛，不同API的同完整键在这里会覆盖structure，后续目录验证再拒绝跨组重复。
// <T extends ModelCatalogEntry>保留额外模型字段并约束最少三键，readonly只禁经models参数改数组，不冻结对象。普通{}分组不构成任意特殊API键的消毒器。
export function groupProviderModelData<T extends ModelCatalogEntry>(
	// providerId只用于重复诊断，不在本函数改每条模型的provider字段。
	providerId: string,
	// 按只读视图接模型数组，内部只遍历、不推入或排序这个数组。
	models: readonly T[],
// 返回对象内groups按api→type:id→T，structure按type:id→api；类型声明本身不运行校验。
): { groups: Record<string, Record<string, T>>; structure: Record<string, string> } {
	// 新普通对象收集API组，不是Map或无原型字典。
	const groups: Record<string, Record<string, T>> = {};
	// 新对象收集身份到API的结构。
	const structure: Record<string, string> = {};
	// 先map取API、Set去重、转新数组并排序，再逐个API遍历；只有分组顺序排序，不按模型ID重排组内输入。
	for (const api of Array.from(new Set(models.map((model) => model.api))).sort()) {
		// 为当前API建一个新组对象，值仍将引用原模型。
		const group: Record<string, T> = {};
		// 每个API都重新遍历整份模型数组，不是一次扫描建所有组。
		for (const model of models) {
			// 不是当前API就continue，既不复制也不写该模型。
			if (model.api !== api) continue;
			// 模板把类型和ID用冒号拼为完整身份；ID自己的冒号不转义。
			const identity = `${model.type}:${model.id}`;
			// 按普通对象属性真值查重复，正常已放模型对象为真即抛；不是运行时字段schema验证，也非hasOwn专查。
			if (group[identity]) throw new Error(`${providerId}/${identity} has duplicate ${api} catalog entries`);
			// 把模型对象原引用放入当前组，额外字段和嵌套引用都保留。
			group[identity] = model;
			// 记录此身份的API；跨API同身份会在这里以后值覆盖，此函数没有跨组Map查重。
			structure[identity] = api;
		}
		// 把整组赋入groups；普通对象赋值遇__proto__等特殊API名有原型语义，并非任意输入都能成为JSON自有键。
		groups[api] = group;
	}
	// 返回两个新外层收集对象；没有深拷贝、冻结、写盘或计算manifest。
	return { groups, structure };
}
