// 所属：packages/durable/src/harness，Durable Harness 的扩展注册表。
// 解决的问题：应用要把若干扩展（工具、提示词段、钩子、任务定义）组合成可被 Harness 读取的不可变快照，
// 同时保证内置任务不能被覆盖、同一次安装内的工具名与提示词段 key 合法且唯一。
// 职责边界：只管理内存中的扩展列表与索引；不执行工具/任务，不写 Session/Storage，不做网络或模型访问。
// 上游：应用调用 createRegistry()，再 install/uninstall；Harness 的 registry 选项接受 RegistryReader，
// 因此 Registry 既是写侧也是读侧。TaskScheduler 通过 snapshot().task(name) 解析任务定义。
// 下游：BUILTIN_TASKS 来自 generation/tool/compaction 的任务定义；INSTRUCTIONS_KEY 来自 agent.ts；
// 快照接口 RegistrySnapshot 定义在 harness/types.ts。
// 结果与错误：install 校验失败抛 Error/TypeError 且不发布新快照；任务名冲突在构造新 RegistryState 时抛出。
// 能力清单：
// - BUILTIN_TASKS：每个注册表都拥有的三个内置任务，不属于任何扩展，不能卸载或替换。
// - RegistryState：一次发布后的不可变索引（扩展、名称、任务），内部类，只暴露 RegistrySnapshot 方法。
// - RegistryImpl：可写注册表，维护当前快照并同步通知订阅者，内部类。
// - validateExtension：校验一份扩展自己的工具重名、提示词段 key 格式/保留名/重名，抛出既有错误类型。
// - createRegistry：应用侧入口，创建只含内置任务的独立注册表。
// 组合与顺序：createRegistry() → install(extension) 触发 validateExtension → 构造下一份 RegistryState →
// 替换 #current 并同步调用订阅者；读取方通过 snapshot() 拿稳定旧版本，或 task(name)/tools()/sections() 查询。
// 示例：const registry = createRegistry();
//   registry.install(defineExtension({ name: "files", tools: [readTool] }));
//   registry.snapshot().task("pi.generation"); // 内置任务仍可查到
//   registry.uninstall(defineExtension({ name: "files" })); // 按名称移除，对象可以不同
// 建议阅读顺序：先看 BUILTIN_TASKS 与 RegistryState 的构造索引，再看 RegistryImpl.install/uninstall 的发布流程，
// 最后看 validateExtension 的声明规则和 createRegistry 入口。
// 测试：test/harness-registry.test.ts 覆盖安装/原位替换/卸载、校验失败不发布、旧快照不变与监听顺序。
// INSTRUCTIONS_KEY 是 agent 自带提示词段的保留 key，扩展不能占用。
import { INSTRUCTIONS_KEY } from "./agent.ts";
// CompactionTask/GenerationTask/ToolTask 是内置任务定义；它们总是最先进入任务索引。
import { CompactionTask } from "./compaction.ts";
import { GenerationTask } from "./generation.ts";
import { ToolTask } from "./tool.ts";
// AnyTask 是擦除具体泛型后的任务形状；Extension/Registry 等是注册表公共接口；PromptSection 用于展平提示词段。
import type { AnyTask, Extension, PromptSection, Registry, RegistrySnapshot, ToolRegistration } from "./types.ts";

// 提示词段 key 只允许小写字母开头，后接小写字母、数字、下划线或连字符；运行时用 RegExp.test 校验。
const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;

/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
// readonly 只约束 TypeScript 写法；每个注册快照先放入这三个内置任务，再检查扩展任务是否重名。
// 数组本身是模块级常量，运行时不冻结；数组元素是已擦除泛型的 AnyTask。
export const BUILTIN_TASKS: readonly AnyTask[] = [GenerationTask, ToolTask, CompactionTask];

/** Immutable published registry state. */
// 一个已发布版本的索引；# 表示 JavaScript 私有字段。构造时建立索引，之后不再提供改写方法。
// 输入是扩展对象数组，构造会为扩展名与任务名建 Map；副作用仅限本对象内部，失败时不产生半成品快照。
class RegistryState<Tool extends ToolRegistration> implements RegistrySnapshot<Tool> {
	// 安装顺序的扩展列表；保存调用方数组的引用，不深复制扩展代码。
	readonly #extensions: readonly Extension<Tool>[];
	// 扩展名到扩展的索引；同名扩展在 install 时已原位替换，不会同时存在两份。
	readonly #byName: ReadonlyMap<string, Extension<Tool>>;
	// 任务名到任务定义的索引，包含三个内置任务和所有扩展任务。
	readonly #tasks: ReadonlyMap<string, AnyTask>;

	// 输入按安装顺序排列的扩展，建立扩展名和任务名索引；任务名冲突会抛错，旧已发布快照仍可使用。
	// 例如两个扩展都声明 "index" 任务会在构造阶段失败；这里不执行任务或工具。
	constructor(extensions: readonly Extension<Tool>[]) {
		// 保留当前版本的扩展列表引用，不深复制扩展代码。
		this.#extensions = extensions;
		// map 产生 [名称, 对象] 键值对，Map 供 extension(name) 查询。
		this.#byName = new Map(extensions.map((extension) => [extension.name, extension]));
		// 任务索引统一包含内置任务和全部已安装扩展的任务。
		const tasks = new Map<string, AnyTask>();
		// 内置任务总是先占用名称，扩展不能覆盖它们。
		for (const task of BUILTIN_TASKS) tasks.set(task.definition.name, task);
		// 扩展顺序不影响冲突规则；即使扩展没有被会话选中，其任务也被安装。
		for (const extension of extensions) {
			// ?? [] 让省略 tasks 等同于没有附加任务。
			for (const task of extension.tasks ?? []) {
				// definition.name 是任务在运行时的身份；同版本号无关。
				const name = task.definition.name;
				// 名称唯一是声明政策，不是 TypeScript 结构类型能保证的条件。
				if (tasks.has(name)) throw new Error(`Task ${name} of extension ${extension.name} is already installed`);
				tasks.set(name, task);
			}
		}
		this.#tasks = tasks;
	}

	// 返回本快照的安装顺序列表；无副作用。例如空注册表得到 []。
	// 返回值标为 readonly 只是编译期约束；调用方仍可能把同一个数组当可变数组使用，因此不要修改它。
	installed(): readonly Extension<Tool>[] {
		return this.#extensions;
	}

	// 按名称取扩展，未找到返回 undefined；不改变安装状态，例如 extension("files")。
	// Map.get 是运行时查找，返回 undefined 时调用方需要自行处理。
	extension(name: string): Extension<Tool> | undefined {
		return this.#byName.get(name);
	}

	// 展平所有扩展工具，同时保留来源扩展；新建结果数组但复用工具对象，不执行工具。
	tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[] {
		// flatMap 将每个扩展的一组工具拼为一个列表，省略 tools 时贡献空列表。
		// 映射产生新对象 { extension, tool }，但 extension/tool 本身仍是原引用。
		return this.#extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })));
	}

	// 展平提示词段并附带其来源；不调用 render，例如一个扩展两段会得到两项。
	sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[] {
		// 与 tools() 同样是 flatMap，保证段顺序等于扩展安装顺序与扩展内声明顺序。
		return this.#extensions.flatMap((extension) =>
			(extension.sections ?? []).map((section) => ({ extension, section })),
		);
	}

	// 返回任务索引值的新数组，包含内置任务；数组修改不会改动 Map 本身。
	tasks(): readonly AnyTask[] {
		// values() 是迭代器，[...] 展开成新数组；浅复制，元素引用不变。
		return [...this.#tasks.values()];
	}

	// 按任务名查定义，未安装返回 undefined；不运行定义中的阶段。
	task(name: string): AnyTask | undefined {
		return this.#tasks.get(name);
	}
}

// 可写注册表实现；#current 是当前已发布快照，监听器集合只保存同步回调。
// 该类不返回给调用方具体类型，而是通过 createRegistry 以 Registry<Tool> 接口暴露。
class RegistryImpl<Tool extends ToolRegistration> implements Registry<Tool> {
	// 最初只有内置任务；每次修改都替换整个状态对象，让此前 snapshot 保持原版本。
	#current = new RegistryState<Tool>([]);
	// 订阅者集合；Set 自动去重，同一个函数重复 subscribe 仍只通知一次。
	readonly #listeners = new Set<() => void>();

	// 读取已发布快照；无复制和副作用，旧快照可在下一次 install 后继续读取。
	// 返回的是内部对象引用，调用方按接口约定视为只读。
	snapshot(): RegistrySnapshot<Tool> {
		return this.#current;
	}

	// 记录同步监听器，返回取消闭包；例如取消后下次 install 不再通知它。重复同一函数由 Set 去重。
	// 例：const stop = registry.subscribe(refresh); ...; stop();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		// 只有调用返回函数时才删除监听器。
		return () => this.#listeners.delete(listener);
	}

	// 安装或按名字原位替换扩展，先验证声明再发布并同步通知；失败保留旧快照。
	// 例如再次 install({ name: "files", ... }) 替换原来的 files，而非追加第二份。
	// 流程：validateExtension → 在已安装列表中找同名项 → 生成下一版列表 → #publish 构造并发布。
	install(extension: Extension<Tool>): void {
		// 检查本扩展内部重名和段 key 规则。
		validateExtension(extension);
		const current = this.#current.installed();
		// findIndex 返回 -1 表示此前未安装；同名扩展不依赖对象引用相等。
		const index = current.findIndex((installed) => installed.name === extension.name);
		// map 回调里的 at 是当前下标；只在命中位置替换，其他位置保留原对象。
		const next =
			// 新名字追加，旧名字保留原安装位置并替换对象。
			index < 0 ? [...current, extension] : current.map((installed, at) => (at === index ? extension : installed));
		this.#publish(next);
	}

	// 按 extension.name 卸载；未安装直接返回。成功会同步通知，任务定义也随新快照移除。
	// 参数只使用 name，传入同名但不同引用的扩展也能卸载。
	uninstall(extension: Extension): void {
		const current = this.#current.installed();
		// some 确认存在，避免不存在的卸载仍发布新版本。
		if (!current.some((installed) => installed.name === extension.name)) return;
		// filter 生成新数组；原 #current 仍然有效，直到 #publish 赋值。
		this.#publish(current.filter((installed) => installed.name !== extension.name));
	}

	/** Build and validate the next state, which throws on a task name collision, then publish it synchronously. */
	// 输入下一版扩展列表，先完整构造再替换当前快照；监听器同步运行，监听器自己抛错会从调用处传播。
	// 例如任务重名导致 new RegistryState 失败时，赋值尚未发生，调用者仍读到旧版本。
	// 通知期间遍历监听器快照，避免某个监听器新增/删除订阅影响本轮遍历。
	#publish(extensions: readonly Extension<Tool>[]): void {
		this.#current = new RegistryState(extensions);
		// 复制监听列表后迭代，避免通知期间订阅集合变化影响本轮遍历。
		for (const listener of [...this.#listeners]) listener();
	}
}

/** Unique tool names and section keys within one extension; valid, unreserved section keys. */
// 校验扩展声明中的唯一名称与 key 政策，无返回值；工具重名、段重名/保留名抛 Error，非法段格式抛 TypeError。
// 例如同扩展两个 read 工具失败，跨扩展同名工具在这里允许；不检查 execute 的实现或工具参数值。
// 输入只是一份待安装扩展；它不读注册表，因此“跨扩展工具重名”留给 agent 解析阶段按后装覆盖处理。
function validateExtension(extension: Extension): void {
	// Set 记录已见名称；每次只校验这一份扩展。
	const tools = new Set<string>();
	for (const tool of extension.tools ?? []) {
		// 先查再加入，第二次遇到同名时报错。
		if (tools.has(tool.name)) throw new Error(`Extension ${extension.name} has two tools named ${tool.name}`);
		tools.add(tool.name);
	}
	const sections = new Set<string>();
	// 解构只取 section.key，render 不执行。
	for (const { key } of extension.sections ?? []) {
		// 格式不合法是声明错误，用 TypeError 区别于配置冲突的 Error。
		if (!SECTION_KEY.test(key)) throw new TypeError(`Section key ${JSON.stringify(key)} must match ${SECTION_KEY}`);
		// instructions 由 agent 自带，扩展不能占用。
		if (key === INSTRUCTIONS_KEY) throw new Error(`Section key ${key} is reserved for the agent's instructions`);
		if (sections.has(key)) throw new Error(`Extension ${extension.name} has two sections with key ${key}`);
		sections.add(key);
	}
}

/** Create an application-owned registry holding only the built-in tasks. */
// 无参数创建独立可写注册表，返回 Registry 接口；初始扩展为空但内置任务可查。
// 例如 const registry = createRegistry(); registry.install(files) 才发生安装；本函数不访问存储。
// 每次调用得到独立实例，互不共享扩展或监听器。
export function createRegistry<Tool extends ToolRegistration = ToolRegistration>(): Registry<Tool> {
	// 泛型 Tool 延续到后续工具、段与快照的类型约束。
	return new RegistryImpl<Tool>();
}
