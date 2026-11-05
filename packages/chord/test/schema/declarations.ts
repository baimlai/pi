// The declarations of the schema switch's proofs (TypeBox to pi-schema): one of every schema helper and option in a
// contract, persisted documents, tables with defaults, an optional and a `json(...)` column, an evolved table and a
// persisted job. Their fingerprints were recorded with the TypeBox helpers; the stored data in `stored/` was written
// by that code (`write-stored.ts`).
// 这些手写声明同时是“旧 TypeBox 换成 pi-schema 后是否兼容”的输入。这里声明规则，不创建主机或写数据库。
// recorded.json 和 stored/ 是历史生成夹具，不能为了让当前测试通过而重写；生成步骤见 write-stored.ts。

import {
	arr,
	bool,
	bytes,
	hostKind,
	int,
	keyed,
	lit,
	local,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	str,
	union,
	unknown,
} from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { defineJob } from "../../src/jobs/index.ts";
import { defineTable, evolveTable, json } from "../../src/store/index.ts";

/** A schema with every helper and option a declaration can use. */
// obj 把字段规则组合成默认拒绝额外字段的对象 schema；Static 等类型工具会据此推导 TS 类型，
// 但下面的 min/max/pattern 等约束仍须运行时校验器执行，TS 的 string/number 本身不检查它们。
export const everything = obj({
	// 字符串长度 1～40，且只包含小写字母和空格；例如 "ada" 合法，"Ada" 不合此规则。
	name: str({ min: 1, max: 40, pattern: "^[a-z ]+$" }),
	// default 是 schema 中的默认值元数据；此声明本身不替一个现有对象填字段。
	nick: str({ default: "x" }),
	// int 是整数，num 是一般有限数；min/max 分别约束取值下界与上界。
	age: int({ min: 0, max: 150 }),
	count: int({ default: 0 }),
	score: num({ min: 0, max: 100 }),
	ratio: num({ default: 0.5 }),
	active: bool(),
	verified: bool({ default: false }),
	// oneOf 的参数展开成字面量候选；role 只能取这三个字符串，level 只能取 1、2、3。
	role: oneOf("admin", "user", "guest"),
	level: oneOf(1, 2, 3),
	// lit 固定为一个具体值，与 str()/num()/bool() 允许一类值不同。
	kind: lit("person"),
	one: lit(1),
	yes: lit(true),
	// arr(元素规则, 数量限制) 描述数组；map(int()) 描述任意字符串键到整数值的记录。
	tags: arr(str(), { min: 0, max: 5 }),
	points: arr(int()),
	extra: map(int()),
	// opt 允许字段不存在；nul 允许值为 null，两者不是一回事。
	note: opt(str()),
	nothing: nul(),
	// union 接受数组中的任一种形状；第三种是带 deep 数组的对象，数组每项又必须有数值 x。
	choice: union([str(), int(), obj({ deep: arr(obj({ x: num() })) })]),
	// nested 必须存在，但它的 inner 可省略；inner 若存在则必须包含字符串 v。
	nested: obj({ inner: opt(obj({ v: str() })) }),
});

/** A local contract with state, keyed state and methods of every argument shape. */
// local 只供同一主机调用；id/shard 选择实例，members 同时描述可观察状态和方法的参数/结果。
export const Everything = local("fixture.switch.everything", {
	version: 1,
	params: { id: str(), shard: int() },
	members: {
		// 普通状态成员暴露整个 profile；keyed 状态让本地主机按字符串键访问各个 note。
		profile: everything,
		notes: keyed(obj({ body: str() })),
		// method() 没有业务参数/结果；下面分别覆盖仅参数、仅结果和两者都有的声明。
		plain: method(),
		args: method(obj({ a: str(), b: opt(int()), any: unknown() })),
		result: method(undefined, arr(str())),
		both: method(obj({ when: int({ min: 0 }) }), union([lit("ok"), obj({ error: str() })])),
		// bytes 是 Uint8Array 叶子，max 约束字节数；这不是允许在 JSON 状态中存字节。
		blob: method(obj({ data: bytes({ max: 1024 }) }), bytes()),
	},
});

// 声明带 region 参数的主机种类，调用 Server({ region: "eu" }) 只构造地址，不启动进程。
const Server = hostKind("fixture.switch.server", { region: str() });

/** A remote contract with variants and a host address. */
// remote 按主体身份区分对象；这里 owner 有 pay 方法，guest 只读 balance，具体分支由服务工厂选择。
export const Account = remote("fixture.switch.account", {
	version: 1,
	params: { user: str({ min: 1 }) },
	// 地址回调忽略 user，所有用户都由 eu 地址提供；例如 user="ada" 也定位到同一主机。
	hostAddress: () => Server({ region: "eu" }),
	variants: {
		owner: { state: { balance: num() }, methods: { pay: method(obj({ amount: num({ min: 0 }) }), bool()) } },
		guest: { state: { balance: num() } },
	},
});

/** A persisted singleton document of `everything`. */
// defineState 创建文档定义；真正的值由对象的 self.state(Profile) 持有并通过事务修改。
export const Profile = defineState("fixture.switch.profile", {
	schema: everything,
	version: 1,
	// initial 无参数，每次产生新对象；首次使用的结果会按 schema 检查，不是在这里立即写入数据库。
	initial: () => ({
		name: "ada",
		nick: "x",
		age: 36,
		count: 0,
		score: 1,
		ratio: 0.5,
		active: true,
		verified: false,
		// as const 保留具体字面量类型，避免 "admin" 被扩大为任意 string；它不会在运行时冻结对象。
		role: "admin" as const,
		level: 1 as const,
		kind: "person" as const,
		one: 1 as const,
		yes: true as const,
		// 可选 note/inner 省略；数组、记录每次重新创建，初始 count=0，后续 write 会累加。
		tags: [],
		points: [],
		extra: {},
		nothing: null,
		choice: "a",
		nested: {},
	}),
	// persist 允许写入主机的 store；仅 local 且空 params 的稳定对象能拥有此类持久化文档。
	persist: true,
	// _ 前缀表示本回调未使用的参数；解构读取此前已有的增量数，达到 2 时改存整份新基线。
	// 例如已有 2 条 delta，再次写入会选 checkpoint；新建/版本改变另由引擎直接写基线。
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 2,
});

/** A persisted keyed document. */
// 例：Notes 的键 "a" 和 "b" 各有自己的 body；初始回调只返回空 body，tags 是可选字段。
export const Notes = defineState("fixture.switch.notes", {
	schema: obj({ body: str(), tags: opt(arr(str())) }),
	version: 1,
	initial: () => ({ body: "" }),
	// keyed 表示一份定义对应多键文档，而非一个可直接读取 .value 的单例。
	keyed: true,
	persist: true,
	// 普通变更从不主动选 checkpoint；创建文档仍会存基线，不是永远没有基线。
	checkpointWhen: () => false,
});

/** A table with defaults, an optional column and a `json(...)` column. */
// defineTable 是表定义；self.table(Rows) 才把它声明给对象。例：put 省略 n/flag 时会用表默认值。
export const Rows = defineTable("fixture.switch.rows", {
	version: 1,
	columns: {
		id: str(),
		n: int({ default: 0 }),
		flag: bool({ default: false }),
		label: opt(str()),
		// json 列有独立的内容版本/指纹；可选列 maybe 不存在时不是空对象，而是缺省值。
		data: json(obj({ a: int(), b: opt(arr(str())) }), { version: 1 }),
		maybe: opt(json(map(num()), { version: 1 })),
	},
	// id 是主键；by_n 先按 n 再按 id 排序，id 提供同 n 值间的稳定次序。
	key: ["id"],
	indexes: { by_n: ["n", "id"] },
});

/** A table evolved over three versions: a rename, an added column with a default, a json column, a drop. */
// 历史声明从 file 列开始；下面的演进回调只记录迁移步骤，读旧库时才应用。
export const EditsV1 = defineTable("fixture.switch.edits", {
	version: 1,
	columns: { id: str(), file: str(), at: int() },
	key: ["id"],
});

// t 是演进构造器；链式调用把 file 改名为 path，增加 dir，再逐行由 path 计算 dir。
// 例：path="/notes/a.md" 得到 dir="/notes"；slice 不修改原字符串，rows 返回待更新字段。
export const EditsV2 = evolveTable(EditsV1, (t) =>
	t
		.rename("file", "path")
		.add("dir", str({ default: "" }))
		.rows((row) => ({ dir: row.path.slice(0, row.path.lastIndexOf("/")) })),
);

// 第三版删除临时 dir 列并建索引；例如从第一版打开，会顺次经过 V2、V3，不跳过中间行迁移。
export const EditsV3 = evolveTable(EditsV2, (t) => t.drop("dir").index("by_path", ["path", "at"]));

/** A persisted job with a state document. */
// 每次任务有自己的 ImportState，initial 返回 done=0；checkpointWhen=false 让进度继续存增量。
export const ImportState = defineState("fixture.switch.import.state", {
	schema: obj({ done: int() }),
	version: 1,
	initial: () => ({ done: 0 }),
	persist: true,
	checkpointWhen: () => false,
});

// 任务声明本身不运行导入；run 收 path，产生 count，重开库时 rerun 会再次调用实现并保留已有进度。
export const ImportJob = defineJob("fixture.switch.import", {
	version: 1,
	args: obj({ path: str() }),
	result: obj({ count: int() }),
	state: ImportState,
	persist: { resume: "rerun" },
});

/** The object owning the persisted documents and the tables (a local type with empty params, as tables need). */
// 空 params 的 local 对象随主机存活，可稳定拥有持久化数据；write/read/dump 实现在 owner.ts。
// unknown() 允许任意 JSON 值作为 dump 的描述；它不等于 TypeScript 的 any。
export const Owner = local("fixture.switch.owner", {
	version: 1,
	params: {},
	members: {
		profile: everything,
		write: method(obj({ id: str(), body: str() })),
		read: method(str(), str()),
		dump: method(obj({}), unknown()),
	},
});
