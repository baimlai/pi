/**
 * schema引用的地址簿：把根/预注册文档中的资源$id、锚点和JSON Pointer解析到具体规则节点及其基准URI。
 * Compiler编译$ref/$dynamicRef、Explainer解释错误时进入；URI只是查表标识，不触发HTTP/磁盘读取。
 * 例根含$defs:{Name:{type:"string"}}，resolve("#/$defs/Name",rootBase)返回该对象和其基准地址。
 * 缓存按schema对象身份/URI保存，索引只走已知子schema关键字，不把enum里的业务数据当规则；动态lookup可使相关编译状态在校验阶段继续存活。
 */
// Reference resolution of one compile: schema resources, anchors and JSON Pointers over the root schema and the
// registered documents. A Resolver lives only while a schema compiles (or while its errors are explained).

// type导入只给TS约束选项/schema形状，不实际校验加载的文档。
import type { CompileOptions, JsonSchema, SchemaObject } from "./types.ts";

/** A schema and the base URI its references resolve against. */
// Resolved成对返回目标节点和它的地址基准；node保留unknown，之后由Compiler判规则是否真是对象/布尔。
export interface Resolved {
	// 节点可能是true/false或尚未验证的其他值，不能从接口名推断已合法。
	readonly node: unknown;
	// base通常不含fragment，用来解析目标规则内部相对引用；readonly不复制字符串以外的对象。
	readonly base: string;
}

/** The base URI of a root schema without `$id`; relative references resolve against it. */
// 没有$id的根用这个固定虚拟URL作相对基准，不需要该域名可访问或真的存在服务器。
export const DEFAULT_BASE = "https://json-schema.invalid/root.json";

/**
 * Resolves references in the root schema and the registered documents. The schema is indexed on the first
 * reference, so a schema without references is never walked for identifiers.
 */
// 每次编译使用一个Resolver：构造只读根$id，首次需要索引才走规则图，注册外部文档按需加载到内存资源表。无联网、没有自动去重等价schema或跨实例全局缓存。
export class Resolver {
	// 明确的两个draft字面量联合，决定$id/$ref/anchor语义。
	readonly draft: "2020-12" | "7";
	// 根的初始基准，构造时计算；不等于工作目录文件路径。
	readonly rootBase: string;
	/** Schema object to the base URI it was indexed under. */
	// 强Map按对象身份记首次索引基准，不是WeakMap；同一实例的同一个对象不会在别的base重复索引。
	readonly baseOf = new Map<object, string>();
	/** URI (with a `#name` fragment) of every `$dynamicAnchor`, to its schema. */
	// 记录带资源地址#名字的动态锚点；运行时scope选择由Compiler负责，此处只是登记。
	readonly dynamicAnchors = new Map<string, SchemaObject>();
	// 原根引用，readonly不保证它内部不可改。
	private readonly root: JsonSchema;
	// 保留编译选项，包括预注册schemas原引用。
	private readonly options: CompileOptions;
	// URI→预注册文档；登记URI时尚未递归索引文档内容，load按需处理。
	private readonly registry = new Map<string, JsonSchema>();
	// 固定这次解析失败是throw还是reject策略，运行中不反复读取选项字段。
	private readonly rejectUnresolved: boolean;
	/** The references that named nothing and resolved to `false` (with `unresolvedRefs: "reject"`). */
	// reject策略下记录曾失败的完整引用URI，用于错误解释区分显式false与缺失引用。
	private readonly unresolved = new Set<string>();
	// 资源文档URI→节点，除根/加载文档，还包含子schema用$id声明的独立资源。
	private readonly resources = new Map<string, unknown>();
	// 静态锚点地址→规则对象；动态锚点也同时登记静态查表入口。
	private readonly anchors = new Map<string, SchemaObject>();
	// 延迟索引标志，不是“所有预注册文档都已索引完”的保证。
	private indexed = false;

	// 构造保存根/选项并定draft、失败策略、rootBase，不遍历全树。例布尔根用DEFAULT_BASE；根$id读取/URI处理可抛来自对象的异常，无IO。
	constructor(root: JsonSchema, options: CompileOptions) {
		// 只有确切"7"选draft7，其余正常可选值/缺失走2020-12。
		this.draft = options.draft === "7" ? "7" : "2020-12";
		// 保存根原对象/布尔值。
		this.root = root;
		// 保存选项供首次ensureIndexed读取schemas。
		this.options = options;
		// 只在选项严格为reject时采用拒绝当前位置的false schema回退。
		this.rejectUnresolved = options.unresolvedRefs === "reject";
		// 对象根可用$id改变初始地址，布尔根直接用虚拟默认基准。
		this.rootBase = isSchemaObject(root) ? this.baseFor(root, DEFAULT_BASE) : DEFAULT_BASE;
	}

	/**
	 * The base URI of `node`, whose parent has `base`: its `$id` changes it, unless draft 7 makes the `$id` inert. Once
	 * the schema is indexed, the indexed base (a resolved reference target already has its own).
	 */
	// baseFor先用已索引地址，再看节点$id；draft7带$ref或片段$id时沿父基准。例$id="child.json"相对base生成子资源URI，不下载任何文档。
	baseFor(node: SchemaObject, base: string): string {
		// 按对象身份取已索引基准，避免解析引用目标时把它$id再相对新父级拼一遍。
		const indexed = this.baseOf.get(node);
		// 已有地址直接复用，包括空字符串等可存字符串值，不用truthy判断。
		if (indexed !== undefined) return indexed;
		// schema信任边界：$id值仍unknown，下面只采用字符串。
		const id = node.$id;
		// 非字符串$id被这里忽略，沿原base，而非在此全面检验schema合法性。
		if (typeof id !== "string") return base;
		// draft7的$ref使同级$id失效；其#片段$id作为锚点处理，不改文档基准。
		if (this.draft === "7" && (typeof node.$ref === "string" || id.startsWith("#"))) return base;
		// 解析相对$id并去fragment，得到资源地址；URI具体解析/回退看resolveUri。
		return documentOf(resolveUri(id, base));
	}

	/** Indexes the root schema and the registered documents' URIs (once). */
	// ensureIndexed首次登记外部文档URI并索引根，后续立刻返回；例无引用的普通规则可能根本不调用它。索引中异常不回滚标志或已写表。
	ensureIndexed(): void {
		// 已经开始过索引就不重复扫描。
		if (this.indexed) return;
		// 先置true再遍历，避免重入重复启动；若后续失败，也不会自动恢复false重试。
		this.indexed = true;
		// schemas缺失视空对象；Object.entries只取自有可枚举字符串键。
		for (const [uri, schema] of Object.entries(this.options.schemas ?? {})) {
			// 预注册地址统一相对DEFAULT_BASE解析并去fragment，同地址后写覆盖先写；仅登记，不加载网络内容。
			this.registry.set(documentOf(resolveUri(uri, DEFAULT_BASE)), schema);
		}
		// 默认根地址先指向原根，即使根本身之后用$id另起资源也保留此入口。
		this.resources.set(DEFAULT_BASE, this.root);
		// 从默认地址递归索引根，index遇$id再调整，已知子schema以外字段不走。
		this.index(this.root, DEFAULT_BASE);
	}

	/**
	 * The schema a reference names, with the base URI it compiles under. Throws if it names nothing, or, with
	 * `unresolvedRefs: "reject"`, resolves to `false`, the schema no value passes.
	 */
	// resolve入口：先索引，再查找；默认抛错，reject把find阶段异常映成false并留痕。例缺$defs项只拒绝该处值；此catch不只捕获“找不到”一种Error。
	resolve(ref: string, base: string): Resolved {
		// ensureIndexed在下面try之外，根索引异常不会被reject分支吞成false。
		this.ensureIndexed();
		// 默认策略直接find，错误原样传播。
		if (!this.rejectUnresolved) return this.find(ref, base);
		// reject策略只包find阶段。
		try {
			// 成功返回正常节点/基准，拒绝模式不改变成功解析。
			return this.find(ref, base);
			// find的任意异常都会进入这里，包括片段解码或外部文档索引异常，不单按错误类别筛选。
		} catch {
			// 记完整解析URI，供isUnresolved查询；它不会清理过去失败记录。
			this.unresolved.add(resolveUri(ref, base));
			// 回退false规则且沿传入base，Compiler会编成恒失败检查，而非全局拒绝整份输入。
			return { node: false, base };
		}
	}

	/** Whether `ref`, from `base`, named nothing and resolved to `false`. */
	// isUnresolved查询同一base下某引用是否曾走reject回退；例显式false目标与缺失目标可据此显示不同错误，无IO。
	isUnresolved(ref: string, base: string): boolean {
		// 相同引用先归成地址再查Set，不重新尝试find。
		return this.unresolved.has(resolveUri(ref, base));
	}

	// find内部流程：解析完整URI→分文档/解码片段→取资源或加载注册文档→整文档/Pointer/锚点三选一。例#Name查anchor，#/$defs/Name走pointer；没有目标或坏百分号编码可抛错。
	private find(ref: string, base: string): Resolved {
		// 把ref按当前base解析，可得到跨资源URI。
		const uri = resolveUri(ref, base);
		// 文档部分为去fragment后的URI，用作资源表键。
		const doc = documentOf(uri);
		// 只对片段decodeURIComponent；坏百分号可抛URIError，query仍属文档地址而非片段。
		const fragment = uri.length > doc.length ? decodeURIComponent(uri.slice(doc.length + 1)) : "";
		// 已加载资源优先；否则只向预注册registry的load要文档，不fetch。
		const root = this.resources.has(doc) ? this.resources.get(doc) : this.load(doc);
		// 资源undefined即失败，布尔false不等于没文档。
		if (root === undefined) throw new Error(`Unresolved $ref ${ref} (no schema registered for ${doc})`);
		// 没有片段或空片段指整个文档，返回文档地址作base。
		if (fragment === "") return { node: root, base: doc };
		// 解码后以/开头的是JSON Pointer，不按普通锚点查。
		if (fragment.startsWith("/")) return this.pointer(root, doc, fragment);
		// 其他片段按完整“文档#名字”查静态锚点表。
		const target = this.anchors.get(`${doc}#${fragment}`);
		// 没有锚点明确报错，不退回根schema猜测。
		if (target === undefined) throw new Error(`Unresolved $ref ${ref} (no anchor ${fragment} in ${doc})`);
		// 成功锚点带自身已索引基准，若未登记才沿文档地址。
		return { node: target, base: this.baseOf.get(target) ?? doc };
	}

	/** Whether `node` is the root of the schema resource at `base`. */
	// isResource通过对象身份判断节点是否为指定URI的资源根，供Compiler决定动态scope入栈；例带$id子规则可成为独立资源。
	isResource(node: object, base: string): boolean {
		// 先确保根资源/锚点表可用，动态编译模式可能因此提前索引。
		this.ensureIndexed();
		// ===判断同一个对象，不比较JSON序列化文本是否相等。
		return this.resources.get(base) === node;
	}

	// Walks only keywords that hold subschemas: an `$id` inside `enum`, `const` or an unknown keyword names nothing.
	// index沿已知schema位置建资源/锚点地址簿：过滤非对象/已见→处理$id→记base→登记锚点→走单节点/映射/数组子项。例enum中的{$id:...}是业务值，不登记成资源。
	private index(node: unknown, base: string): void {
		// isSchemaObject只判非null非数组对象；baseOf按身份挡重复和循环，不假装能验证任意JS对象是合法JSON Schema。
		if (!isSchemaObject(node) || this.baseOf.has(node)) return;
		// 局部b随当前$id调整，再传给子规则；原base参数不被改写。
		let b = base;
		// In draft 7 a `$ref` makes every sibling keyword, `$id` included, inert.
		// draft7有字符串$ref则只保留引用语义，同级关键字/锚点不生效。
		const refOnly = this.draft === "7" && typeof node.$ref === "string";
		// 非refOnly才读取字符串$id；不采纳数字等未知形状。
		if (!refOnly && typeof node.$id === "string") {
			// draft7的片段$id登记锚点，不改变b和资源根。
			if (this.draft === "7" && node.$id.startsWith("#")) this.anchors.set(documentOf(b) + node.$id, node);
			// 其余$id按资源地址处理。
			else {
				// 相对$id依当前b解析，可含片段。
				const uri = resolveUri(node.$id, b);
				// 新的资源基准只用文档部分。
				b = documentOf(uri);
				// 该资源URI指向当前节点；冲突后写覆盖，没有独立冲突报错。
				this.resources.set(b, node);
				// 非空片段也登记锚点，单独#不登记有名字锚点。
				if (uri.length > b.length + 1) this.anchors.set(uri, node);
			}
		}
		// 记录当前对象已见及基准，后面再遇同一对象直接跳过。
		this.baseOf.set(node, b);
		// draft7引用对象在此停止，不索引其兄弟关键字里的子规则。
		if (refOnly) return;
		// 2020-12才采用$anchor/$dynamicAnchor关键字。
		if (this.draft !== "7") {
			// 普通锚点登记为当前资源地址#名字，不在此验证所有锚点命名规则。
			if (typeof node.$anchor === "string") this.anchors.set(`${b}#${node.$anchor}`, node);
			// 动态锚点需字符串值，后面同时登两张表。
			if (typeof node.$dynamicAnchor === "string") {
				// 静态find也可定位动态锚点的初始目标。
				this.anchors.set(`${b}#${node.$dynamicAnchor}`, node);
				// 动态表供Compiler运行时lookup使用；bookended先经静态解析确认初始目标，不在此决定最终动态目标。
				this.dynamicAnchors.set(`${b}#${node.$dynamicAnchor}`, node);
			}
		}
		// 单个子schema字段按当前b递归，undefined/true/false由index入口直接跳过。
		for (const key of SCHEMA_KEYWORDS) this.index(node[key], b);
		// 映射关键字的每个字段值也是子schema，例如$defs.Name。
		for (const key of MAP_KEYWORDS) {
			// 先读关键字值，可能是unknown。
			const map = node[key];
			// 仅对象映射按Object.keys逐项递归；不把原型字段当已声明映射项。
			if (isSchemaObject(map)) for (const k of Object.keys(map)) this.index(map[k], b);
		}
		// 数组关键字每个元素是一个子schema，例如anyOf分支。
		for (const key of ARRAY_KEYWORDS) {
			// 取当前关键字值，items可同时出现在单节点/数组列表里，按真实形状分流。
			const list = node[key];
			// 真正数组才逐项递归，元素是否对象由index自己判。
			if (Array.isArray(list)) for (const s of list) this.index(s, b);
		}
	}

	// load只从registry取预注册文档，写resources后再索引，返回原schema引用。例URI像http://...也不联网；不存在undefined，索引异常保留已写资源记录。
	private load(doc: string): JsonSchema | undefined {
		// 查规范文档URI，不从文件系统/网络获取。
		const schema = this.registry.get(doc);
		// 没注册就返回undefined，让find生成未解引用错误。
		if (schema === undefined) return undefined;
		// 先标为已加载资源，引用递归可看到它；未在此复制文档。
		this.resources.set(doc, schema);
		// 按注册地址为起点索引，内部$id可再声明其他资源。
		this.index(schema, doc);
		// 返回原始布尔或对象规则。
		return schema;
	}

	// pointer按JSON Pointer逐段查自有字段并沿对象更新base；例/a~1b找键a/b。只解析路径不验证最终是schema，越界/键值undefined视失败；百分号解码已在find做。
	private pointer(root: unknown, base: string, fragment: string): Resolved {
		// 从资源根开始，可沿数组的自有数字键等路径进入。
		let node = root;
		// 当前基准随途经已索引对象更新，最终目标内部相对引用可用正确资源地址。
		let b = base;
		// 先split再丢最前空段；中间/最后的空段保留，可表示空字段名。
		for (const raw of fragment.split("/").slice(1)) {
			// 先~1→/再~0→~，顺序避免~01错误变成/；不是URI解码或路径规范化。
			const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
			// 根据下一层存在性，用三元更新node。
			node =
				// 只在非null对象上查自有键，原型继承名不算；数组同样是object，没有在此特别禁止。
				typeof node === "object" && node !== null && Object.hasOwn(node, key)
					? // as SchemaObject仅帮助TS索引；不运行schema验证，也不要求目标属性一定是对象。
						(node as SchemaObject)[key]
					: // 缺失/非对象途径得到undefined。
						undefined;
			// undefined失败，不会把null/false误判为缺失；之后Compiler仍可拒绝非法最终节点。
			if (node === undefined) throw new Error(`Unresolved $ref #${fragment} in ${base}`);
			// 遇对象时若baseOf已登记则换基准，否则沿旧b；索引只走已知schema位置，所以并非任何对象都已登记。
			if (typeof node === "object" && node !== null) b = this.baseOf.get(node) ?? b;
		}
		// 返回定位节点及最终基准，无输入对象修改。
		return { node, base: b };
	}
}

// 单个子schema的关键字清单，只用于寻址索引，不代表每个关键字都做校验断言。
const SCHEMA_KEYWORDS = [
	// 额外对象属性规则。
	"additionalProperties",
	// 属性名规则，不是properties字段表本身。
	"propertyNames",
	// 数组包含项规则。
	"contains",
	// 否定规则。
	"not",
	// 条件规则。
	"if",
	// 条件成功分支。
	"then",
	// 条件失败分支。
	"else",
	// 尚未求值对象属性规则。
	"unevaluatedProperties",
	// 尚未求值数组项规则。
	"unevaluatedItems",
	// 旧式tuple额外项规则。
	"additionalItems",
	// 内容schema在此可索引，不代表校验器会据它解码验证content。
	"contentSchema",
	// items为对象时走单节点递归；数组形态另由ARRAY_KEYWORDS处理。
	"items",
];

// 子schema映射清单：每个名字对应规则；含新$defs和旧definitions/dependencies，值形状仍由index分支判。
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];

// 子schema数组清单：组合分支、prefixItems及旧items元组。不是运行时用户值数组的字段名。
const ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];

/** Whether `value` is a schema object (not `true`/`false`, an array or a primitive). */
// schema对象外形守卫：非null的object且不是数组；例{}成立、true/[]不成立。value is让TS收窄，不保证对象原型/内容/所有关键字合法，Uint8Array等对象也可过此外形关。
export function isSchemaObject(value: unknown): value is SchemaObject {
	// typeof null为object需另排null；数组不作为schema对象，但未做普通对象原型限制。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `ref` resolved against `base`. URNs and other bases a URL parser rejects take fragment-only references. */
// resolveUri先用标准URL相对解析，失败则#片段拼基文档，其余ref原样保留。例urn基准下#A仍可查锚点；不保证任意相对串都能正确解析，不访问该URL。
export function resolveUri(ref: string, base: string): string {
	// try捕获URL构造器拒绝的组合，比如不支持的相对URN基准。
	try {
		// .href返回规范化后的绝对URL字符串；和URL对象本身/网络请求都不同。
		return new URL(ref, base).href;
		// URL解析失败进入有限回退，不在这里抛专用schema错误。
	} catch {
		// 只有ref以#开头才接base文档；其他串原样交后面资源表查，不自动补协议。
		return ref.startsWith("#") ? documentOf(base) + ref : ref;
	}
}

/** `uri` without its fragment. */
// documentOf仅按首个#截片段；例https://a/x?y=1#N保留查询部分。纯字符串操作，无解析/校验/IO。
export function documentOf(uri: string): string {
	// 没有#时indexOf给-1。
	const hash = uri.indexOf("#");
	// 三元无#原样，有#取前缀；slice不修改原字符串。
	return hash < 0 ? uri : uri.slice(0, hash);
}
