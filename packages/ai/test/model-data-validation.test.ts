// 用自建临时包目录测试模型JSON的结构、manifest、必要字段与离线水合；不请求模型/认证，不下载目录，不执行临时TS或改仓库生成文件。
// 第一组13项覆盖水合的成功替换、只验证与拒绝路径，第二组17项只写夹具并校验；注册测试本身不执行各用例的文件操作。
// 同步文件API只操作下面登记的临时根；断言/IO失败作为测试失败向运行器传播。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// os.tmpdir只提供临时目录位置；真正创建随机目录在createFixture中。
import { tmpdir } from "node:os";
// join按宿主路径规则拼接夹具目录，不展开URL或读取用户配置。
import { join } from "node:path";
// Vitest注册清理、测试组与用例并做断言，it.each会为每个参数行注册独立用例。
import { afterEach, describe, expect, it } from "vitest";
// 导入真实水合函数而不运行其CLI；此模块底部用import.meta.url与argv[1]判断直接运行。
import { hydrateModelCatalog } from "../scripts/hydrate-model-catalog.ts";
// 以下导入为真实离线助手，非镜像验证器；type项在JS执行时擦除。
import {
	// 精确ID集合比较，用于前两条无文件夹具的验证用例。
	assertExactModelIds,
	// 为夹具JSON正文建立配套结构hash/文件hash，避免无关陈旧摘要掩盖要测的字段错误。
	createModelDataManifest,
	// manifest文件名常量，不手写另一份名称。
	MODEL_DATA_MANIFEST_FILE,
	// 当前格式版本，部分用例故意改为不兼容数字。
	MODEL_DATA_SCHEMA_VERSION,
	// 两层provider→type:id→api的结构类型，不等于运行时验证。
	type ModelDataStructure,
	// 真实聚合import/分片名/JSON键读取函数，读取的是临时夹具，不执行其TS。
	readModelDataStructure,
	// 被测目录验证器，会同步读磁盘并对问题抛错，不联网。
	validateModelDataDirectory,
} from "../scripts/model-data.ts";

// 固定夹具生成时间，避免测试结果随系统时钟改变；它是测试值，不代表实际发布时刻。
const GENERATED_AT = "2026-07-23T10:00:00.000Z";
// 登记待清理根目录的共享数组；const禁止重绑变量，不禁止push/splice。
const temporaryRoots: string[] = [];

// 注册每个用例结束后的清理回调，无输入/业务结果；例如断言失败后运行器仍会调用它，但删除操作自身可能抛错。
afterEach(() => {
	// splice(0)先清登记数组再逐目录递归删除；若某次rm失败，循环可能中断且剩余根已不在数组中，不是事务式必达清理。
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

// 创建一个临时AI包夹具，返回路径、预期结构与可修改模型值；同步写TS文字、JSON及manifest，失败抛错。
// 例：createFixture()给test-provider/chat:model-a；临时聚合/分片只用于文本匹配与文件名核对，绝不import执行。
function createFixture(): {
	// 返回的dataDir是本夹具providers/data目录路径。
	dataDir: string;
	// packageRoot供读取助手模拟一个包根，而非真实仓库包路径。
	packageRoot: string;
	// structure作为独立期望的type:id/API映射传给校验器。
	structure: ModelDataStructure;
	// values按完整身份键存模型unknown对象，后续用例可故意制造错误。
	values: Record<string, unknown>;
} {
	// mkdtempSync按前缀创建本次随机目录，不复用固定共享目录。
	const packageRoot = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	// 创建后立即登记清理，之后写文件失败也仍保留已登记根供afterEach处理。
	temporaryRoots.push(packageRoot);
	// 在临时包内定位src/providers。
	const providersDir = join(packageRoot, "src", "providers");
	// 临时data目录位于providers下。
	const dataDir = join(providersDir, "data");
	// recursive:true一次创建缺失的全部祖先目录，尚未创建任何真实模型实例。
	mkdirSync(dataDir, { recursive: true });
	// 写临时聚合TS文字，供正则提取供应商名单。
	writeFileSync(
		// 输出路径在刚创建的临时包src中，文件名与产品约定相同。
		join(packageRoot, "src", "models.generated.ts"),
		// 这一完整import文字是测试数据，常量顺序/空格用于匹配固定正则；字符串内的LF转义不是现在执行import。
		'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	// 再写一份临时分片TS，以满足文件名配套要求。
	writeFileSync(
		// 分片名必须与聚合路径的test-provider对应。
		join(providersDir, "test-provider.models.ts"),
		// 分片中的JSON import也只是未执行文字，读取结构不会运行它。
		'import values from "./data/test-provider.json" with { type: "json" };\n',
	);

	// 构造独立期望映射；类型注解开发期检查层级，后续传给真实验证器。
	const structure: ModelDataStructure = {
		// 外层键为这份夹具唯一provider。
		"test-provider": {
			// 内层完整身份chat:model-a映到Completions API；并非只有裸model-a键。
			"chat:model-a": "openai-completions",
		},
	};
	// 新普通对象保存模型正文，值被声明unknown而不是全部当Model可信对象。
	const values: Record<string, unknown> = {
		// 当前模型键带type前缀，模型内部id仍是裸ID。
		"chat:model-a": {
			// 模型类型chat触发reasoning/contextWindow/maxTokens规则。
			type: "chat",
			// 模型自身id须与完整键第一个冒号后部分一致。
			id: "model-a",
			// 非空显示名满足必要字段，不用于发请求。
			name: "Model A",
			// 内部api须与JSON分组名一致。
			api: "openai-completions",
			// provider须与文件及期望结构的供应商一致。
			provider: "test-provider",
			// example.test地址只作为baseUrl字符串字段，测试不访问它。
			baseUrl: "https://example.test/v1",
			// 布尔false是合法不推理标记，不是字符串false。
			reasoning: false,
			// 声明文本输入，模态验证要求非空text/image数组。
			input: ["text"],
			// 四项有限成本样本，单位/实际账单不在这份校验里验证。
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			// 正数上下文窗口满足chat必要字段。
			contextWindow: 1000,
			// 正数最大输出满足chat规则，未因此代表模型实际能输出100token。
			maxTokens: 100,
		},
	};
	// 把这份模型值和配套manifest同步写到临时data，异常向外抛。
	writeFixtureData(dataDir, structure, values);
	// 属性简写返回路径和同一structure/values引用；调用方改values会影响自己的夹具数据，重写磁盘要另调写助手。
	return { dataDir, packageRoot, structure, values };
}

// 把给定模型值包进一个API组并写夹具JSON/manifest，返回void；可指定错误版本或错误组名制造测试材料。
// 例：apiGroup改anthropic而模型api仍Completions，会保持新的正文hash正确，再由业务规则发现分组问题；不会修复values。
function writeFixtureData(
	// 已存在的临时data路径，助手本身不mkdir。
	dataDir: string,
	// 期望结构用于生成structureHash，不从values自动重算。
	structure: ModelDataStructure,
	// 模型值对象按引用参与序列化，额外未知字段保留。
	values: Record<string, unknown>,
	// 缺省沿当前格式版本；显式传另一个数字可构造不兼容manifest。
	manifestSchemaVersion = MODEL_DATA_SCHEMA_VERSION,
	// 缺省Completions组名，后面图片/分类用例会覆盖此参数。
	apiGroup = "openai-completions",
): void {
	// 夹具唯一provider数据文件名。
	const filename = "test-provider.json";
	// 计算属性[apiGroup]把参数作为对象键，JSON.stringify再加LF；不是字面键apiGroup。
	const content = `${JSON.stringify({ [apiGroup]: values })}\n`;
	// 先覆写provider JSON，后面写manifest失败不会回滚前一写。
	writeFileSync(join(dataDir, filename), content);
	// 对这份实际正文与传入结构创建真实manifest，固定生成时间，不读自身测试源码。
	const manifest = createModelDataManifest(structure, { [filename]: content }, GENERATED_AT);
	// 再覆盖清单版本，专供错版本用例；不重新改变结构/文件hash。
	manifest.schemaVersion = manifestSchemaVersion;
	// 写清单JSON加LF，成功无返回值；目录不存在/权限等IO问题直接使测试失败。
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}

// 第一组注册13项临时目录水合测试：这里调用的是真实本地文件替换流程，没有网络源或生成器CLI。
describe("published model catalog hydration", () => {
	// 取夹具中的chat模型作可变Record视图，输入values/返回原对象；例如改返回值.api会改values对应项。没有运行时形状检查。
	function chatModel(values: Record<string, unknown>): Record<string, unknown> {
		// as只让TS允许按记录读写，未克隆、验证或把undefined自动变成对象。
		return values["chat:model-a"] as Record<string, unknown>;
	}

	// 从删除data的临时包重新水合两次，检查数据有效、结构一致、聚合TS文字不变和两份JSON确定性；不逐一比较所有分片TS。
	it("hydrates a clean checkout deterministically without changing generated TypeScript", () => {
		// 创建并解构本次夹具的路径、结构和模型值。
		const { dataDir, packageRoot, structure, values } = createFixture();
		// 定位临时聚合TS作为前后文字比较对象。
		const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
		// 保存聚合完整原文，而非只保存hash或mtime。
		const aggregator = readFileSync(aggregatorPath, "utf8");
		// 输入目录JSON也放同一临时根。
		const catalogPath = join(packageRoot, "catalog.json");
		// 模型数组引用夹具中的模型对象，JSON写入时才序列化。
		const models = [chatModel(values)];
		// 额外放extra-provider，用于确认本包名单之外的数据不会自动成为新生成分片；两个键写同数组。
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": models, "extra-provider": models }));
		// 只删除本夹具data，制造尚未水合状态，聚合/分片TS仍在。
		rmSync(dataDir, { recursive: true });

		// 运行真实水合函数，在本夹具暂存校验并替换data，不改实际仓库。
		hydrateModelCatalog(packageRoot, catalogPath);
		// 箭头延迟执行真实目录验证，not.toThrow要求本夹具数据成功通过，而不是把函数本身与空值比较。
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
		// 实际读取返回结构须深等原期望，确认只保留test-provider/chat:model-a。
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
		// 比较聚合TS完整字符串；这条不检查各个.models.ts文件内容或证明所有可能TS均不变。
		expect(readFileSync(aggregatorPath, "utf8")).toBe(aggregator);
		// 保存首次水合生成的清单完整文本，包含固定时刻与hash。
		const manifest = readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8");
		// 保存首次provider JSON完整文本，保留LF与字段顺序。
		const provider = readFileSync(join(dataDir, "test-provider.json"), "utf8");
		// 对相同输入再水合一次，仍只操作本夹具目录。
		hydrateModelCatalog(packageRoot, catalogPath);
		// 第二次清单文字须完全一致，不只深比较JSON值。
		expect(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8")).toBe(manifest);
		// provider正文也逐字一致，验证这份输入的确定性，不证明任意目录枚举或外部输入顺序都等价。
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toBe(provider);
	});

	// 同一临时provider放两个API不同的chat模型，水合后核完整键→API结构；不调用任一模型API。
	it("groups models by API and keys them by type and id", () => {
		// 创建独立夹具并保留模型值引用。
		const { packageRoot, values } = createFixture();
		// 本地输入文件路径在临时根下。
		const catalogPath = join(packageRoot, "catalog.json");
		// 取原chat模型，下面扩展对象只浅复制它。
		const model = chatModel(values);
		// 写包含两条模型的本地目录JSON。
		writeFileSync(
			// 写入目标是前面临时catalogPath。
			catalogPath,
			// 把下方普通对象序列化，不执行模型声明。
			JSON.stringify({
				// 保留model-a，浅展开另建model-b并覆API；其他嵌套字段在内存里共享，但序列化生成JSON值。
				"test-provider": [model, { ...model, id: "model-b", api: "anthropic-messages" }],
			}),
		);
		// 运行本地夹具水合，生成两个API组。
		hydrateModelCatalog(packageRoot, catalogPath);
		// 读取真实落盘结构并与下面完整预期深比较。
		expect(readModelDataStructure(packageRoot)).toEqual({
			// 两个chat身份键分别对应Completions和Messages组，裸ID不同。
			"test-provider": { "chat:model-a": "openai-completions", "chat:model-b": "anthropic-messages" },
		});
	});

	// 同裸ID的chat与image水合后应分两个完整身份键，核type前缀避免覆盖；不解码或生成图片。
	it("keys chat and image models with the same id separately", () => {
		// 新夹具提供原chat值与临时包根。
		const { packageRoot, values } = createFixture();
		// 构造一条图片模型对象，不用chat的reasoning或窗口字段。
		const image = {
			// type为image，决定输出模态必须含image。
			type: "image",
			// 刻意与chat模型同id=model-a。
			id: "model-a",
			// 图片显示名仍须非空字符串。
			name: "Model A Image",
			// 图片API名字仅作为分组文字，测试不调用OpenRouter。
			api: "openrouter-images",
			// 仍属于test-provider，不能错写为真实供应商名。
			provider: "test-provider",
			// 假baseUrl只作字段值，不触发fetch。
			baseUrl: "https://example.test/v1",
			// 输入为text。
			input: ["text"],
			// 输出image满足图片专用规则。
			output: ["image"],
			// 图片也要求四项有限成本字段，不用真实计费。
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		// 输入catalog文件位于临时包下。
		const catalogPath = join(packageRoot, "catalog.json");
		// 同时序列化chat原对象和image新对象，裸ID相同但type不同。
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": [chatModel(values), image] }));
		// 真实水合只在本夹具落盘。
		hydrateModelCatalog(packageRoot, catalogPath);
		// 读取并比较两个type身份键的结构。
		expect(readModelDataStructure(packageRoot)).toEqual({
			// chat:model-a与image:model-a均必须存在且各自API正确。
			"test-provider": { "chat:model-a": "openai-completions", "image:model-a": "openrouter-images" },
		});
	});

	// validateOnly仍会写暂存并验证，但这条仅比较旧provider正文未替换，再验证缺provider输入会拒绝；不把它称为完全无文件写入。
	it("validates without replacing existing data", () => {
		// 新夹具中已有旧data与模型值。
		const { dataDir, packageRoot, values } = createFixture();
		// 保存旧provider正文文字供前后比较。
		const original = readFileSync(join(dataDir, "test-provider.json"), "utf8");
		// 准备临时输入路径。
		const catalogPath = join(packageRoot, "catalog.json");
		// 取原chat对象作输入种子。
		const model = chatModel(values);
		// 输入多一个model-b，若错误替换旧data会产生可观察变化。
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": [model, { ...model, id: "model-b" }] }));
		// 只验证模式创建/校验/清理暂存，不走正式data的删除与重命名。
		hydrateModelCatalog(packageRoot, catalogPath, { validateOnly: true });
		// provider正文须原样，未额外比较manifest或其他磁盘条目。
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toBe(original);
		// 把输入改成只有不相关provider，故意缺本包要求的test-provider。
		writeFileSync(catalogPath, JSON.stringify({ "other-provider": [model] }));
		// 即使validateOnly也须报缺provider；正则只要求错误信息包含missing provider。
		expect(() => hydrateModelCatalog(packageRoot, catalogPath, { validateOnly: true })).toThrow(/missing provider/);
	});

	// it.each注册六个不完整输入：null、数组、空对象、空列表、非数组列表、缺type/api的条目；每个都新建夹具并比较旧manifest。
	it.each([null, [], {}, { "test-provider": [] }, { "test-provider": {} }, { "test-provider": [{ id: "x" }] }])(
		// %j把该次catalog以JSON显示在测试名中，不是被解析的输入模板。
		"rejects incomplete catalogs without replacing existing data: %j",
		// 参数化回调接本轮catalog值，无业务返回；实际文件操作在运行本例时发生。
		(catalog) => {
			// 解构新夹具，未使用的字段不复制。
			const { dataDir, packageRoot } = createFixture();
			// 目录输入文件路径在本例临时根。
			const catalogPath = join(packageRoot, "catalog.json");
			// 保存旧manifest原文，而不是只存其四字段对象。
			const original = readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8");
			// 把本轮坏值序列化写入临时输入文件。
			writeFileSync(catalogPath, JSON.stringify(catalog));
			// 只要求调用抛错，不限定是哪条错误或在哪一阶段失败。
			expect(() => hydrateModelCatalog(packageRoot, catalogPath)).toThrow();
			// 要求旧manifest保持原文；该断言没有逐个核旧provider文件或模拟rename失败。
			expect(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8")).toBe(original);
		},
	);

	// 参数化三例各把api/provider/cost改null，水合须在正式替换前拒绝；api在最小guard就失败，provider/cost可到暂存字段校验才失败。
	it.each(["api", "provider", "cost"])("validates model %s before replacing existing data", (field) => {
		// 新夹具保证三种错误不互相继承。
		const { dataDir, packageRoot, values } = createFixture();
		// 保存正式旧data正文，后面核未被替换。
		const original = readFileSync(join(dataDir, "test-provider.json"), "utf8");
		// 取本例模型对象引用。
		const model = chatModel(values);
		// 动态字段写null，在unknown记录上故意制造运行数据错误，不修改TS类型定义。
		model[field] = null;
		// 准备本例输入catalog路径。
		const catalogPath = join(packageRoot, "catalog.json");
		// 写包含这条坏模型的输入JSON。
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": [model] }));
		// 延迟调用真实hydrate并要求抛错，未限定错误消息。
		expect(() => hydrateModelCatalog(packageRoot, catalogPath)).toThrow();
		// 这三个错误样本调用后旧provider正文保持不变；该文字断言本身不追踪内部执行到了哪一步。
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toBe(original);
	});
});

// 第二组注册17项生成数据验证测试，材料由写助手构造，不调用hydrate，也不运行目录生成器或临时TS。
describe("generated model data validation", () => {
	// 无磁盘夹具的精确允许名单例：预期a,b而实际仅a，要求错误文字指出缺b；未向真正Qwen目录查询。
	it("rejects a missing upstream model from an exact generated allowlist", () => {
		// 箭头把同步抛错留给toThrow捕获；label只是错误前缀，模型名也都是固定样本。
		expect(() => assertExactModelIds("qwen-token-plan-individual", ["model-a", "model-b"], ["model-a"])).toThrow(
			// 只检查抛出的message包含这段期望文字，不对Error类型/stack作完整比较。
			"qwen-token-plan-individual model IDs do not match (missing: model-b)",
		);
	});

	// 反向检查额外ID：实际多b应抛extra:b，无文件或网络操作。
	it("rejects an unexpected model from an exact generated allowlist", () => {
		// 调用真实集合比较助手，两组都转去重排序后比较。
		expect(() => assertExactModelIds("test-provider", ["model-a"], ["model-a", "model-b"])).toThrow(
			// 期望错误片段明确额外的model-b，而非missing。
			"test-provider model IDs do not match (extra: model-b)",
		);
	});

	// 正常夹具应能抽出API分组结构并通过目录验证；这是本地小样本，不证明所有生成目录均有效。
	it("reads and validates API-grouped model data", () => {
		// 建立本例临时包，解构路径与独立期望结构。
		const { dataDir, packageRoot, structure } = createFixture();
		// 真实读取结构须深等期望，不只比较模型数量。
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
		// 对配套JSON/manifest运行真实校验，要求不抛错。
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
	});

	// 删除夹具data后验证必须报目录不存在，不让空目录或缺失目录被当成功。
	it("rejects a missing model data directory", () => {
		// 先建完整夹具，使缺失是这一步有意造成的。
		const { dataDir, structure } = createFixture();
		// 递归删除本例data，不删除真实仓库目录。
		rmSync(dataDir, { recursive: true });
		// 只要求错误信息包含does not exist，不检查平台特定错误码。
		expect(() => validateModelDataDirectory(structure, dataDir)).toThrow("does not exist");
	});

	// 三个只读字面量参数行分别改id/provider/api，检查身份字段错误；每行产生独立用例。
	it.each([
		// id错误应出现has id诊断。
		["id", "wrong-id", "has id"],
		// provider错误应出现has provider诊断。
		["provider", "wrong-provider", "has provider"],
		// api改成与原Completions分组不同的Messages，应出现has api。
		["api", "anthropic-messages", "has api"],
		// as const只收紧TS元组/字面量推断，不冻结值；回调解构本轮字段、新值和期望消息。
	] as const)("rejects a wrong model %s", (field, value, expectedMessage) => {
		// 创建全新夹具，避免上一轮坏字段残留。
		const fixture = createFixture();
		// as Record只让TS准许动态改模型，不执行schema验证或clone。
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		// 把本轮目标字段写坏，其他字段原样。
		model[field] = value;
		// 重写正文及相符manifest，排除旧hash不一致是唯一失败原因。
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		// 真实目录检查必须包含该身份字段错误；可能同时报其他问题，不要求只有一个错误。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(expectedMessage);
	});

	// 删模型type后必须拒绝未知类型；完整键仍chat:model-a，因此也可能出现键身份不符，断言只要求类型错误片段。
	it("rejects a model without a known type", () => {
		// 新夹具提供完整正常模型。
		const fixture = createFixture();
		// 断言为可变Record只影响编译期。
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		// delete真正删除自有type字段，不写字符串undefined。
		delete model.type;
		// 将坏值与新的配套摘要落入夹具data。
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		// 延迟执行验证并检查它抛出的消息。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			// 要求包含允许三类type的说明，不声称完整错误文本仅这一条。
			'expected "chat", "image", or "classifier"',
		);
	});

	// 图片不带chat窗口/输出上限也可通过；再删output或仅text分别失败。三次都重写配套hash，以专门观察模态规则。
	it("validates image models with output modalities and without chat limits", () => {
		// 先建临时路径和聚合/分片，用下面图片数据替换夹具data内容。
		const fixture = createFixture();
		// 独立预期结构改为image:image-a→test-images，不沿用原chat结构。
		const structure: ModelDataStructure = { "test-provider": { "image:image-a": "test-images" } };
		// 图片值放可变Record，使后面可以删除/替换output；类型本身不保证图片字段正确。
		const image: Record<string, unknown> = {
			// type设image，选择图片专用验证分支。
			type: "image",
			// id为image-a，与预期完整键后半一致。
			id: "image-a",
			// 非空图片名称满足必要字段。
			name: "Image A",
			// 内部API须与下面写助手指定的test-images组名相等。
			api: "test-images",
			// 供应商仍对应test-provider文件。
			provider: "test-provider",
			// 假URL文字不被请求或URL解析。
			baseUrl: "https://example.test/v1",
			// 图片输入声明text，是允许模态之一。
			input: ["text"],
			// 输出同时image/text仍合法，规则要求包含image而非只准image。
			output: ["image", "text"],
			// 图片也提供四项有限成本，不提供chat的窗口、reasoning与maxTokens。
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		};
		// 无参数validate闭包每次都重写同一个临时文件再同步验证，返回void或抛错；读取最新image引用，不缓存第一次JSON。
		const validate = () => {
			// 先写当前图片数据和新的配套manifest。
			writeFixtureData(
				// 写入本夹具data目录。
				fixture.dataDir,
				// 使用图片的独立预期结构。
				structure,
				// 以完整image身份键包当前同一image对象。
				{ "image:image-a": image },
				// 沿当前格式版本，避免错误版本掩盖输出模态。
				MODEL_DATA_SCHEMA_VERSION,
				// 显式改分组参数为test-images，与image.api一致。
				"test-images",
			);
			// 按同一图片结构调用真实目录校验，失败作为同步异常抛出。
			validateModelDataDirectory(structure, fixture.dataDir);
		};
		// 首次给函数引用，由not.toThrow实际调用；当前图片模态应通过。
		expect(validate).not.toThrow();

		// 删除输出字段，保留其他图片必要字段。
		delete image.output;
		// 再次调用闭包重新写盘并验证，必须报invalid output modalities。
		expect(validate).toThrow("invalid output modalities");
		// 把输出改为仅text，虽然数组元素合法但没有image仍不满足图片输出条件。
		image.output = ["text"];
		// 第三次独立验证相同模态错误，不只验证字段存在。
		expect(validate).toThrow("invalid output modalities");
	});

	// chat即使output为合法text模态也不允许带该字段；规则不同于image，测试不触发任何聊天请求。
	it("rejects output modalities on chat models", () => {
		// 建立正常chat夹具。
		const fixture = createFixture();
		// 取得模型的可变记录视图，实际仍同一对象。
		const model = fixture.values["chat:model-a"] as Record<string, unknown>;
		// 新增output:text数组制造chat的额外输出字段。
		model.output = ["text"];
		// 更新正文及配套hash，使模态规则成为可观察错误。
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		// 执行验证并要求对应错误片段。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(
			// unsupported output modalities表示非图片不许output，不是text字符串本身不合法。
			"unsupported output modalities",
		);
	});

	// classifier只需自身窗口，不要求chat的reasoning/maxTokens；给完整有限成本与text输入后应通过，不调用分类API。
	it("validates classifier models without chat output limits", () => {
		// 新建临时路径供改写为分类目录。
		const fixture = createFixture();
		// 建立独立分类预期结构。
		const structure: ModelDataStructure = {
			// 完整身份classifier:classifier-a归test-classifier组。
			"test-provider": { "classifier:classifier-a": "test-classifier" },
		};
		// 普通对象推断保存分类模型，未用as伪造运行验证。
		const classifier = {
			// 类型classifier选择对应必要字段规则。
			type: "classifier",
			// 内部ID与预期键后半相同。
			id: "classifier-a",
			// 非空分类名称。
			name: "Classifier A",
			// API名称用于本地组匹配，不要求在产品API注册表里真实存在。
			api: "test-classifier",
			// provider对应临时文件名。
			provider: "test-provider",
			// 假baseUrl仅供字段验证，未访问example.test。
			baseUrl: "https://example.test/v1",
			// 分类输入为text合法模态数组。
			input: ["text"],
			// 四项零价格均为有限数，验证器允许0。
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// 提供正上下文窗口，故意没有maxTokens/reasoning。
			contextWindow: 1000,
		};
		// 把分类模型与相符清单写到夹具。
		writeFixtureData(
			// 目标仍本例临时data目录。
			fixture.dataDir,
			// 传分类结构而非原chat结构。
			structure,
			// 模型对象按完整分类身份包一层。
			{ "classifier:classifier-a": classifier },
			// 使用当前schema版本。
			MODEL_DATA_SCHEMA_VERSION,
			// 分组参数与模型内部test-classifier API一致。
			"test-classifier",
		);
		// 真实校验不应抛错，证明这个固定分类样本不需要chat输出上限。
		expect(() => validateModelDataDirectory(structure, fixture.dataDir)).not.toThrow();
	});

	// 保留模型内部api与预期结构，故意把磁盘组名改错，验证最终分组映射检查；可能同时报has api。
	it("rejects a model in the wrong API group", () => {
		// 创建正常chat夹具。
		const fixture = createFixture();
		// 重新写相符摘要但错误分组的JSON。
		writeFixtureData(
			// 临时data路径。
			fixture.dataDir,
			// 期望结构仍Completions。
			fixture.structure,
			// 模型内部字段也保持原Completions。
			fixture.values,
			// 清单版本保持合法，排除无关版本失败。
			MODEL_DATA_SCHEMA_VERSION,
			// 只把外围API组改为Messages。
			"anthropic-messages",
		);
		// 要求错误汇总含grouped under API，不声称它是唯一问题。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("grouped under API");
	});

	// 同完整身份放进两个API组必须拒绝；为新正文重算hash，不能只靠文件变更hash错误通过这条用例。
	it("rejects duplicate model IDs across API groups", () => {
		// 新夹具含一条正常chat模型。
		const fixture = createFixture();
		// 指定被重写的provider JSON名称。
		const filename = "test-provider.json";
		// JSON.stringify的对象表达式在模板插值内；此处加JS注释不进入输出字符串字面内容。
		const content = `${JSON.stringify({
			// 第一组引用正常模型记录。
			"openai-completions": fixture.values,
			// 第二组再次放同一完整模型键，制造跨API重复。
			"anthropic-messages": fixture.values,
			// 结束JSON序列化插值并在正文末尾加LF。
		})}\n`;
		// 把两组内容同步写到临时provider文件。
		writeFileSync(join(fixture.dataDir, filename), content);
		// 为这份重复数据建立相符文件hash，结构仍只预期一次身份。
		const manifest = createModelDataManifest(fixture.structure, { [filename]: content }, GENERATED_AT);
		// 写配套manifest，无运行时模型调用。
		writeFileSync(join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		// 验证须报跨多个API组重复，不仅仅遇到摘要不匹配。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("more than one API group");
	});

	// 直接把provider正文清空为{}但不更新清单，产生缺模型和旧摘要；正则是二选一，只证明至少出现其中一种诊断。
	it("rejects missing model IDs and stale file hashes", () => {
		// 正常夹具先提供原manifest与预期模型。
		const fixture = createFixture();
		// 把临时JSON改为空对象文字及LF，不写新manifest。
		writeFileSync(join(fixture.dataDir, "test-provider.json"), "{}\n");
		// toThrow正则含|，允许manifest hash或model IDs任一匹配；不能据此说两条错误均由断言验证。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(/manifest hash|model IDs/);
	});

	// 先写错误schema并检查，再改structureHash检查生成印记；第二步旧schema错误仍存在，汇总中必须另含generation stamp。
	it("rejects incompatible schema and generation stamps", () => {
		// 新夹具避免继承上例空正文。
		const fixture = createFixture();
		// 用正常模型值和相符hash，但把manifest版本设当前值加1。
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values, MODEL_DATA_SCHEMA_VERSION + 1);
		// 只检查message中出现model data schema。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("model data schema");

		// 定位临时清单文件。
		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		// 读/解析后用as视作Record，未执行运行类型校验；这里依赖本测试刚写的清单。
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		// 把结构hash改成stale，同时保留前一步不兼容schema值。
		manifest.structureHash = "stale";
		// 序列化改过的manifest加LF写回，只改本例临时文件。
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		// 要求汇总还包含generation stamp，说明校验没有因版本错就跳过结构印记检查。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation stamp");
	});

	// 把合法时刻改成Date.parse无法解析的文字，验证时间格式检查；不测试时刻新旧、时区或签名。
	it("rejects an invalid generation timestamp", () => {
		// 新建正常夹具。
		const fixture = createFixture();
		// 定位其清单。
		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		// 把刚写的JSON断言为可修改Record，as不改变解析结果。
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		// 只把generatedAt字段改为不可解析文本。
		manifest.generatedAt = "invalid";
		// 写回坏时刻清单，不改provider正文。
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		// 要求包含generation timestamp诊断，不比完整错误文本。
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation timestamp");
	});

	// 临时聚合TS多声明一个missing供应商而无对应分片，读取结构应在文件名单核对阶段失败；不执行虚构import。
	it("rejects missing provider shards imported by the aggregator", () => {
		// 创建正常聚合/分片夹具并保留包根。
		const { packageRoot } = createFixture();
		// 覆盖聚合源码文字加入第二条import。
		writeFileSync(
			// 写的仍是临时src/models.generated.ts。
			join(packageRoot, "src", "models.generated.ts"),
			// 字符串中两条import以LF分隔，都符合提取正则；没有创建missing.models.ts或运行它。
			'import { TEST_PROVIDER_CLASSIFIER_MODELS, TEST_PROVIDER_IMAGE_MODELS, TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\nimport { MISSING_CLASSIFIER_MODELS, MISSING_IMAGE_MODELS, MISSING_MODELS } from "./providers/missing.models.ts";\n',
		);
		// 读取助手应报聚合/分片名单失配；这例不验证分片源码内容或真实上游模型列表。
		expect(() => readModelDataStructure(packageRoot)).toThrow("aggregator and provider shards do not match");
	});
});
