// 定义9组基准规则和正反样本，作为Pi及其他验证器的固定输入；构造数据不读文件、不执行其中的工具命令。
// Speed cases: realistic schemas with a valid and an invalid value each. Argument checks shaped like Chord's
// contracts (closed objects, tagged unions), pi's built-in tool schemas, and MCP tool schemas with $ref and anyOf.

// import type只提供TS静态JsonSchema，不在运行时导入校验器；下面的对象不是调用compile后的结果。
import type { JsonSchema } from "../../src/index.ts";

/** A schema, the draft it is written in, and one valid and one invalid value. */
// 一组比较输入的接口；当前实际字段没有独立draft属性，个别规则在$schema中声明版本，基准调用方另传draft。
export interface Case {
	// name用于表格/原生Zod匹配；readonly只限制TS重赋。
	readonly name: string;
	// 规则为JSON Schema数据，不是执行函数；类型不替运行时验证它。
	readonly schema: JsonSchema;
	// 预期通过的具体值，unknown允许各案例形状不同。
	readonly valid: unknown;
	// 预期拒绝的具体值；它的命名/静态类型不自动执行测试，speed脚本才核对裁决。
	readonly invalid: unknown;
}

// Props把字符串字段名映到object规则；这是规则字典，不是映射后已验证的用户值，也不接受布尔schema作为这里的子规则。
type Props = Record<string, object>;
// closed接属性表和可选名列表，返回封闭对象schema；例closed({text:str()})要求text且拒额外键。无I/O、不检查样本；箭头的({ ... })把花括号当返回对象而非函数体。
const closed = (properties: Props, optional: string[] = []) => ({
	// type关键字限制实际值必须是对象，不是给TS变量标类型。
	type: "object",
	// 同名属性简写，schema保留传入properties表引用。
	properties,
	// 枚举属性自有可枚举字符串键，再用filter保留不在optional中的名字；回调!取反后表示这些键必填。
	required: Object.keys(properties).filter((k) => !optional.includes(k)),
	// 禁止规则未声明的额外字段，不是把输入多余字段删掉。
	additionalProperties: false,
});
// str接可选规则选项返回string schema，例str({minLength:1})；只新建对象，无转换/校验/I/O。后展开o可覆盖前面的type，并非强制永远string。
const str = (o: object = {}) => ({ type: "string", ...o });
// int同样新建integer schema，例int({minimum:0})；JSON Schema整数关键字不创造TS整数类型，选项后展开可覆盖type；这里只构造规则，不校验用户值。
const int = (o: object = {}) => ({ type: "integer", ...o });
// num新建number schema，例num({maximum:1})；不会把字符串转成数值，o后展开仍可覆盖type。
const num = (o: object = {}) => ({ type: "number", ...o });
// lit接string返回只接受该常量的const规则，例lit("text")；没有另写type也能由const约束值，不执行比较或I/O。
const lit = (v: string) => ({ const: v });
// arr接成员规则和可选数组约束返回schema，例arr(str(),{maxItems:2})；保留items引用，后展开o可覆盖type/items，不构造实际用户数组。
const arr = (items: object, o: object = {}) => ({ type: "array", items, ...o });
// UUID外形的正则文字，要求小写十六进制8-4-4-4-12段；没有UUID版本/变体检查，$未启m不忽略最后换行。
const uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

// 内容块schema，下列3种封闭形状通过kind常量区分；对象本身在导入时构造，不检查用户块。
const block = {
	// anyOf要求至少一支通过，不是oneOf的“恰一支”；这些固定tag不同，当前形状彼此区分。
	anyOf: [
		// text分支要求kind=text及字符串text，不允许别的字段。
		closed({ kind: lit("text"), text: str() }),
		// image分支有src和非负整数宽高；第二参数将下面alt移出required。
		closed({ kind: lit("image"), src: str(), width: int({ minimum: 0 }), height: int({ minimum: 0 }), alt: str() }, [
			// alt是可选字段名文字，而非本行已经提供的替代文本。
			"alt",
		]),
		// code分支要求语言为ts/js/py之一，并提供字符串source；source只当数据，不执行代码。
		closed({ kind: lit("code"), lang: { anyOf: [lit("ts"), lit("js"), lit("py")] }, source: str() }),
	],
};

// 文档根也封闭，下面属性默认必填，第二参数再移除score/draft；不读写文档文件。
const document = closed(
	{
		// id只验证上面的UUID文字外形。
		id: str({ pattern: uuid }),
		// 标题长度1到200，JSON Schema长度按Unicode码点，当前样本是ASCII。
		title: str({ minLength: 1, maxLength: 200 }),
		// 最多16个字符串tag；没有uniqueItems，所以不要求去重。
		tags: arr(str(), { maxItems: 16 }),
		// 作者自身封闭且name必填、email可省；email没有format校验。
		author: closed({ name: str(), email: str() }, ["email"]),
		// blocks为内容块数组，未设置minItems，空数组也允许。
		blocks: arr(block),
		// score在0到1之间，是否必填由外层optional列表决定。
		score: num({ minimum: 0, maximum: 1 }),
		// draft规则要求boolean；这里不是直接设置文档草稿标记为某个值。
		draft: { type: "boolean" },
	},
	// 这两个名字不进根required，其余声明字段由closed自动收集。
	["score", "draft"],
);

// 配套文档正样本，后面反样本只替换最后一个image块，部分未改子对象仍可共享。
const documentValue = {
	// 这个id满足小写十六进制分段模式。
	id: "01890a5d-ac96-774b-bcce-b302099a8057",
	// 非空ASCII标题处在规定长度内。
	title: "Quarterly notes",
	// 三个字符串tag，不触及16项上界。
	tags: ["a", "b", "c"],
	// 作者包含name和可选email，规则只要求字符串。
	author: { name: "Mario", email: "m@example.com" },
	// 混合块数组覆盖不同tag分支，不是同一种元素的静态TS联合校验结果。
	blocks: [
		// text块提供对应字段。
		{ kind: "text", text: "Hello" },
		// image宽高合法且省略alt，展示可选字段。
		{ kind: "image", src: "a.png", width: 640, height: 480 },
		// code块用ts标签；source是待验证文本，导入本模块不执行这段字符串。
		{ kind: "code", lang: "ts", source: "const x = 1;" },
		// 另一个text块让数组包含重复分支。
		{ kind: "text", text: "World" },
		// 最后image提供可选alt，反例会用负width替掉这个块。
		{ kind: "image", src: "b.png", width: 10, height: 20, alt: "b" },
	],
	// 0.5落在score上下界内；本样本不提供可选draft。
	score: 0.5,
};

// 复用非负整数id规则对象，未为每个引用点克隆。
const id = int({ minimum: 0 });
// 仿消息协议的五分支规则，只用于校验性能数据，不代表实际Chord协议实现。
const message = {
	// anyOf枚举hello/hold/release/call/abort，各支封闭。
	anyOf: [
		// 第一支生成hello封闭对象，以下四字段必填。
		closed({
			// kind常量作为分支标签，不是任意字符串。
			kind: lit("hello"),
			// protocol非负整数，规则未固定为某个真实协议号。
			protocol: int({ minimum: 0 }),
			// incarnation只验证UUID外形。
			incarnation: str({ pattern: uuid }),
			// calls至少1。
			calls: int({ minimum: 1 }),
		}),
		// hold分支稍长，用第二参数单独声明可选chain。
		closed(
			{
				// kind必须hold才符合此支。
				kind: lit("hold"),
				// hold字段复用非负整数规则。
				hold: id,
				// type字段在业务数据中是字符串，区别schema对象自己的type关键字。
				type: str(),
				// 版本至少1，不探测本机软件版本。
				version: int({ minimum: 1 }),
				// 指纹只限制16个小写十六进制字符，不计算真实摘要。
				fingerprint: str({ pattern: "^[0-9a-f]{16}$" }),
				// 空schema接受任意JSON值；键仍由closed列为required，规则空不等于字段可缺。
				params: {},
				// address要求kind字符串和任意params，两者必填且无额外键。
				address: closed({ kind: str(), params: {} }),
				// chain若提供，最多64个UUID外形字符串。
				chain: arr(str({ pattern: uuid }), { maxItems: 64 }),
			},
			// 只把chain改为可选，其余hold字段必填。
			["chain"],
		),
		// release支只带标签和hold。
		closed({ kind: lit("release"), hold: id }),
		// call支要求非负call/hold/method，args可省、提供时值不限；closed仍拒额外键。
		closed({ kind: lit("call"), call: id, hold: id, method: id, args: {} }, ["args"]),
		// abort支只验证kind与call，不在这里真的中止请求。
		closed({ kind: lit("abort"), call: id }),
	],
};

// tool接属性表和显式必填名，返回开放对象schema；例tool({path:str()},["path"])。不同于closed，它不写additionalProperties:false；只建数据，无执行工具或I/O。
const tool = (properties: Props, required: string[]) => ({ type: "object", properties, required });

// 仿创建issue的参数规则，不连接GitHub，不读取真实issue。
const mcpIssue = {
	// 规则自己声明draft-07 URI；它是版本标识，不会在这里从网络下载schema。
	$schema: "http://json-schema.org/draft-07/schema#",
	// 根值要求object。
	type: "object",
	// properties列出允许/验证的字段形状，是否必填另由required定。
	properties: {
		// owner非空且只含字母数字连字符，空格会失败。
		owner: str({ minLength: 1, pattern: "^[A-Za-z0-9-]+$" }),
		// repo还允许点/下划线，未校验真实仓库是否存在。
		repo: str({ minLength: 1, pattern: "^[A-Za-z0-9._-]+$" }),
		// title至少一个字符。
		title: str({ minLength: 1 }),
		// body为可选字符串，无长度下界。
		body: str(),
		// labels为可选字符串数组。
		labels: arr(str()),
		// assignees同为字符串数组，不查询用户。
		assignees: arr(str()),
		// milestone接受number或null；没有minimum或integer限制。
		milestone: { anyOf: [{ type: "number" }, { type: "null" }] },
		// state既要求string，又只接受open/closed两个值。
		state: { type: "string", enum: ["open", "closed"] },
	},
	// 只有owner/repo/title必填，其他字段都可省。
	required: ["owner", "repo", "title"],
	// 禁止所有未声明的根字段。
	additionalProperties: false,
};

// 仿批量编辑文件的schema，演示同文档$defs/$ref与anyOf；构造它不改文件。
const mcpEdit = {
	// 声明2020-12，供尊重$schema的验证器选择语义。
	$schema: "https://json-schema.org/draft/2020-12/schema",
	// 编辑请求根值为对象。
	type: "object",
	// $defs保存复用规则，定义出现在表里不代表直接约束根值。
	$defs: {
		// Range的start/end都至少1；没有start<=end的跨字段检查。
		Range: closed({ start: int({ minimum: 1 }), end: int({ minimum: 1 }) }),
		// Replace要求oldText/newText字符串，允许空字符串。
		Replace: closed({ oldText: str(), newText: str() }),
		// LineEdit以本地Pointer引用Range，并要求text。
		LineEdit: closed({ range: { $ref: "#/$defs/Range" }, text: str() }),
	},
	// 根请求字段表，下面path和edits必填，dryRun可选。
	properties: {
		// 路径正则允许可选/、./或盘符反斜杠前缀，余下至少一个非NUL字符；不规范化路径、不证明文件可访问。
		path: str({ pattern: "^(/|\\./|[A-Za-z]:\\\\)?[^\\u0000]+$" }),
		// edits至少1项，每项可通过Replace或LineEdit规则；这里只是引用解析/联合校验样本，不执行替换。
		edits: arr({ anyOf: [{ $ref: "#/$defs/Replace" }, { $ref: "#/$defs/LineEdit" }] }, { minItems: 1 }),
		// dryRun若提供必须boolean。
		dryRun: { type: "boolean" },
	},
	// 必须有path和edits。
	required: ["path", "edits"],
	// 根不接受额外字段。
	additionalProperties: false,
};

// 递归页面规则演示本地引用和oneOf，未声明$schema时由基准的draft选项决定。
const mcpPage = {
	// 页面根为对象。
	type: "object",
	// 两份定义分别描述富文本与可递归块。
	$defs: {
		// RichText使用closed生成封闭对象，annotations本身可选。
		RichText: closed(
			{
				// type允许text/mention两个文字，enum本身已限制这些字符串常量。
				type: { enum: ["text", "mention"] },
				// content最多2000个Unicode码点，未设最短长度。
				content: str({ maxLength: 2000 }),
				// annotations若提供是封闭对象，下面三个字段都移出其required；这与zod.ts原生版本三个子字段必填并非完全等价。
				annotations: closed({ bold: { type: "boolean" }, italic: { type: "boolean" }, color: str() }, [
					// bold是可选子字段，存在时必须boolean。
					"bold",
					// italic同样可选，存在时必须boolean。
					"italic",
					// color可选且只限制string，不要求default或某个颜色枚举。
					"color",
				]),
			},
			// 把annotations从RichText的required移除，type/content仍必填。
			["annotations"],
		),
		// Block定义可在children中引用自己，不是直接创建无限深JS对象。
		Block: {
			// 每个块实际值为object。
			type: "object",
			// 块的字段规则表。
			properties: {
				// 块类型只接五种标签，没有按标签进一步限制checked等字段。
				type: { enum: ["paragraph", "heading_1", "heading_2", "bulleted_list_item", "to_do"] },
				// rich_text每项复用RichText定义，允许空数组。
				rich_text: arr({ $ref: "#/$defs/RichText" }),
				// checked若存在是boolean，所有块标签都可提供。
				checked: { type: "boolean" },
				// children里的每项回到Block，形成schema引用递归；规则未设最大深度。
				children: arr({ $ref: "#/$defs/Block" }),
			},
			// 块只要求type/rich_text，checked和children可省。
			required: ["type", "rich_text"],
			// 块不允许其他字段。
			additionalProperties: false,
		},
	},
	// 页面根字段表，与定义内部字段分开。
	properties: {
		// parent必须恰通过一支封闭对象：page_id或database_id，各值为UUID外形；两个键都放会被两支拒绝。
		parent: { oneOf: [closed({ page_id: str({ pattern: uuid }) }), closed({ database_id: str({ pattern: uuid }) })] },
		// 页面标题非空。
		title: str({ minLength: 1 }),
		// 日期只看四位-两位-两位数字外形，不校验日历。
		due: str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
		// 根children最多100项，只限制这一层数组，不给递归后代每层自动加100上限。
		children: arr({ $ref: "#/$defs/Block" }, { maxItems: 100 }),
	},
	// parent/title必填；due/children可省。
	required: ["parent", "title"],
	// 根页面也封闭。
	additionalProperties: false,
};

// rt把content文字包装成固定text富文本样本；例rt("one")返回带三个annotations子字段的新对象，无校验/副作用/I/O，content用同名属性简写。
const rt = (content: string) => ({
	// 样本标签固定text，而非任意RichText标签。
	type: "text",
	// 保留入参字符串作为content，不转义成另一份文本。
	content,
	// 三个注解值全部提供，因此同时满足这里与Zod原生版本的当前样本要求。
	annotations: { bold: false, italic: false, color: "default" },
});
// 页面正样本含嵌套children，用于递归校验路径。
const pageValue = {
	// parent仅给page_id，满足oneOf的一支。
	parent: { page_id: "01890a5d-ac96-774b-bcce-b302099a8057" },
	// 非空标题。
	title: "Plan",
	// 日期符合纯数字外形。
	due: "2026-11-01",
	// 三个根块远少于100项。
	children: [
		// 标题块用rt生成一条富文本。
		{ type: "heading_1", rich_text: [rt("Plan")] },
		{
			// 这一项是列表块，内部还有子待办块。
			type: "bulleted_list_item",
			// 列表项正文为字符串one对应的富文本。
			rich_text: [rt("one")],
			// 嵌套待办checked为true，正例通过；反例下面只替此层子数组。
			children: [{ type: "to_do", rich_text: [rt("sub")], checked: true }],
		},
		// 段落带三条富文本，校验会遍历数组每一项。
		{ type: "paragraph", rich_text: [rt("a"), rt("b"), rt("c")] },
	],
};
// structuredClone复制整份当前页面数据，再改反例不改变pageValue；这里只包含可克隆普通对象/数组/基础值。
const pageInvalid = structuredClone(pageValue);
// 将第二个根块的children换成checked为字符串yes的反例；as unknown as boolean只绕开TS赋值限制，运行值仍字符串，正是要让schema拒绝它。
pageInvalid.children[1].children = [{ type: "to_do", rich_text: [rt("sub")], checked: "yes" as unknown as boolean }];

/** The speed cases. */
// 导出的9案例数组只读是TS约束，不冻结内部对象；speed先核对正反裁决再计时，Zod映射按这些schema对象身份查找。
export const cases: readonly Case[] = [
	// 最小封闭对象：text="hello"应过，text=1应因类型错被拒绝。
	{ name: "small closed object", schema: closed({ text: str() }), valid: { text: "hello" }, invalid: { text: 1 } },
	{
		// 表格/原生适配都用这个精确名字标识文档案例。
		name: "nested object with tagged unions",
		// 复用上面的document规则原引用。
		schema: document,
		// 正例复用documentValue。
		valid: documentValue,
		// 反例只替换一个块，其他内容沿用正例。
		invalid: {
			// 浅展开文档顶层，不是深复制所有子对象。
			...documentValue,
			// 保留前4块、最后造width=-1的image，因非负约束失败；slice/展开新建数组，前4个块仍共享对象引用。
			blocks: [...documentValue.blocks.slice(0, 4), { kind: "image", src: "b.png", width: -1, height: 20 }],
		},
	},
	{
		// 五分支消息案例名。
		name: "message union of 5",
		// 使用message联合schema，不执行协议请求。
		schema: message,
		// 合法call含所需非负id，可选args提供任意对象。
		valid: { kind: "call", call: 7, hold: 3, method: 1, args: { a: 1 } },
		// 非法call多了extra，closed分支拒绝；省略可选args本身不是错因。
		invalid: { kind: "call", call: 7, hold: 3, method: 1, extra: true },
	},
	{
		// read工具形状案例，不调用读文件工具。
		name: "tool: read",
		// 只有path必填；offset/limit仅为number，未限制正数或整数，description不影响裁决。
		schema: tool({ path: str({ description: "Path to the file" }), offset: num(), limit: num() }, ["path"]),
		// 提供path及两个可选数值是正例。
		valid: { path: "src/a.ts", offset: 10, limit: 50 },
		// 反例缺必填path，offset=1本身合法。
		invalid: { offset: 1 },
	},
	{
		// edit工具形状案例。
		name: "tool: edit",
		// 根和每项都是tool开放对象；每项必须有oldText/newText，根必填名在下面列出。
		schema: tool({ path: str(), edits: arr(tool({ oldText: str(), newText: str() }, ["oldText", "newText"])) }, [
			// path列入required。
			"path",
			// edits也列入required；数组未设minItems，所以空数组仍可通过。
			"edits",
		]),
		// 合法编辑样本，所有必填字段都提供。
		valid: {
			// 路径只要求字符串，不检查文件是否存在。
			path: "a.ts",
			// 两条编辑内容作为数据。
			edits: [
				// 第一项有旧新文本。
				{ oldText: "a", newText: "b" },
				// 第二项也满足两个必填字符串。
				{ oldText: "c", newText: "d" },
			],
		},
		// 反例的编辑项缺newText，路径和oldText都合法。
		invalid: { path: "a.ts", edits: [{ oldText: "a" }] },
	},
	{
		// bash工具参数案例，不在导入或校验时执行shell。
		name: "tool: bash",
		// command必填字符串，timeout可选number，规则不验证具体命令安全性。
		schema: tool({ command: str(), timeout: num() }, ["command"]),
		// ls -la只是字符串样本，timeout=30合法。
		valid: { command: "ls -la", timeout: 30 },
		// command=5违反字符串类型。
		invalid: { command: 5 },
	},
	{
		// issue案例聚焦pattern/anyOf/enum组合，不与真实MCP服务通信。
		name: "MCP create_issue (pattern, anyOf, enum)",
		// 复用draft-07的mcpIssue规则。
		schema: mcpIssue,
		// 正例包括部分可选字段，assignees可省。
		valid: {
			// owner只含允许字符。
			owner: "earendil-works",
			// repo为非空合法文字。
			repo: "pi",
			// title非空。
			title: "Bug",
			// body作为普通字符串，不因省略内容号而有特殊含义。
			body: "...",
			// labels含一个字符串。
			labels: ["bug"],
			// milestone=null命中anyOf的null支。
			milestone: null,
			// state命中open枚举值。
			state: "open",
		},
		// owner含空格违反模式；其他两个必填字段合法。
		invalid: { owner: "earendil works", repo: "pi", title: "Bug" },
	},
	{
		// edit_file案例聚焦本地引用及替换/范围两支。
		name: "MCP edit_file ($ref, anyOf)",
		// 复用2020-12编辑规则。
		schema: mcpEdit,
		// 正例同时覆盖两种编辑项。
		valid: {
			// 相对路径只做模式检查，不在这里转绝对路径。
			path: "./src/a.ts",
			// 两项分别走Replace和LineEdit。
			edits: [
				// 字符串替换正例，不实际改文件。
				{ oldText: "a", newText: "b" },
				// start=1/end=3满足各自下界，text为字符串。
				{ range: { start: 1, end: 3 }, text: "x" },
			],
		},
		// 反例start=0违反Range.minimum=1，引用解析后应拒绝；并非因为缺oldText。
		invalid: { path: "./src/a.ts", edits: [{ range: { start: 0, end: 3 }, text: "x" }] },
	},
	// 递归页面正反对：checked=true通过，反例深层checked="yes"失败，覆盖嵌套$ref与parent的oneOf。
	{ name: "MCP create_page (recursive $ref, oneOf)", schema: mcpPage, valid: pageValue, invalid: pageInvalid },
];
