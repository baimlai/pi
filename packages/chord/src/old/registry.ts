// Chord v1 的注册表声明与只读视图类型；真正的按代码版本存储、冲突检查和通知由 host.ts 管理。
//
// 所属模块：packages/chord/src/old，Chord v1 宿主运行时的一部分。注册表（registry）是“插件在某个代码版本内向
// 宿主登记键值条目，其它代码按版本读取”的机制，例如把 HTTP 路由名映射到处理函数。
//
// 职责边界：本文件只提供类型与一个描述对象工厂，不保存条目、不做重名检查、不通知订阅者。真正的条目来自对象工厂里的
// self.register(registry, { key: value })；对象层把它们收进 Decls.registrations。host.ts 的 buildTables 生成每个代码
// 版本不可变的 RegistryTable，checkRegistrations 在对象激活前试建以校验冲突，registriesChanged 重建当前版本的表。
// 读取方通过 host.registry(registry) 拿到 RegistryView，按 ctx 中的 codeVersion 选择对应版本的表。
//
// 上游入口：应用代码 import { defineRegistry } from "@earendil-works/chord/old" 声明一个注册表，再用
// self.register(registry, { key: value }) 写入条目、host.registry(registry) 读取；对象层和宿主层都会引用本文件的类型。
// 下游依赖：只有 types.ts 的 Ctx（仅类型）。没有运行时依赖，也不会自己抛出错误；冲突错误由宿主侧产生，
// 代码为 invalid、reason 为 registry_conflict。
//
// 能力清单：
// - Registry<V>：注册表描述，含 name、冲突策略 conflict（"error" 重名报错 / "last" 后者覆盖）以及仅用于类型推导的 value。
// - defineRegistry<V>(name, options?)：创建上述描述；不注册任何条目。
// - RegistryTable<V>：某一代码版本的只读表（ReadonlyMap<string, V>）。
// - RegistryView<V>：读取入口，table(ctx?) 取整表、get(key, ctx?) 取单值、subscribe 监听新表安装。
// - Registration：对象层向宿主提交的一条具体注册记录（描述、键、值）。
//
// 组合与典型顺序：defineRegistry 只执行一次 → 对象工厂 self.register(registry, { key: value }) → 宿主在对象激活/重载时生成表 →
// host.registry(registry) 得到 RegistryView → 调用方在每次读取时传入当前 Ctx，使旧调用仍看到旧版本的表。
//
// 示例（真实签名，省略宿主创建）：
//   const routes = defineRegistry<(req: Request) => Response>("routes");
//   // 在 host 生命周期对象的工厂中：self.register(routes, { "GET /health": handler })
//   // 在宿主调用中：const view = host.registry(routes); view.get("GET /health", ctx)
//   这里 view.get 返回 handler 或 undefined；ctx 决定读取哪个代码版本，未传 ctx 时读当前版本。
//
// 建议阅读顺序：先看 Registry<V> 与 defineRegistry 理解描述对象；再看 RegistryTable / RegistryView 理解按版本读取；
// 最后看 Registration，把本文件与 host.ts 的 buildTables、installTables、registration 实现串起来。
import type { Ctx } from "./types.ts";

// V 是每个注册项的值类型；此描述只含名字和冲突策略，不存放注册表中的实际条目。
// 这是 interface，运行时不存在对应对象；V 只在编译期参与类型检查，不会在运行时验证 value 的实际形状。
export interface Registry<V> {
	// 注册表名，用于宿主内部按名字索引，也是重载时判断表是否被替换的依据之一；没有运行时唯一性检查。
	readonly name: string;
	// 联合字面量类型："error" 表示同一代码版本内两个对象注册同一 key 时报错；"last" 表示后来的覆盖先前的。
	// 该策略在宿主写入表时执行，本文件仅保存这个选择。
	readonly conflict: "error" | "last";
	/** Type carrier only; never set. */
	// 可选 value 只承载泛型供 TS 推导，不会由 defineRegistry 设置。
	readonly value?: V;
}

/** `conflict: "error"` rejects two objects registering one key; `"last"` keeps the later registration. */
/**
 * 用 name 与可选冲突策略创建注册表描述并返回；不注册条目，也不马上检查重名。
 * 默认 error，last 允许后来的条目覆盖。例如 defineRegistry<Handler>("routes") 供 self.register 与 host.registry 使用。
 *
 * 输入：name 是表名；options.conflict 可省略，省略时为 "error"。
 * 输出：新的 Registry<V> 描述对象，不包含任何条目。
 * 副作用：没有；不访问宿主、不注册全局单例，也不校验 name 是否为空。
 * 错误路径：本函数不会抛错；非法 conflict 只会在 TypeScript 编译期被拒绝（运行时没有校验）。
 * 示例：const handlers = defineRegistry<(n: number) => number>("handlers", { conflict: "last" });
 * 之后的读取方用 host.registry(handlers)，写入方在对象工厂里 self.register(handlers, { double: (n) => n * 2 })。
 * 注意 register 的第二个参数是一个“键 → 值”的记录；同一对象同一次 run 内重复键会先被 object.ts 以 invalid/duplicate
 * 拒绝，conflict 策略只处理不同对象之间的同键注册。
 * 注意这是描述对象；重复调用 defineRegistry 会得到彼此独立、但 name 可能相同的描述，它们不会自动共享数据。
 */
// <V> 是泛型参数：调用方通过 defineRegistry<Handler>(...) 固定值类型，返回类型随之变成 Registry<Handler>。
// 参数类型中的 = {} 是默认值，允许省略第二个实参；options 里的 ? 表示 conflict 字段可缺省。
export const defineRegistry = <V>(name: string, options: { conflict?: "error" | "last" } = {}): Registry<V> => ({
	// 箭头函数的 ({ ... }) 表示直接返回对象；属性简写 name 等于 name: name。
	name,
	// ?? 仅在未给出策略时采用 error；此函数没有做运行时输入校验。
	conflict: options.conflict ?? "error",
});

// ReadonlyMap 暴露查找和遍历，TS 不提供 set/delete；运行时不会因此冻结原 Map。
// 类型别名（type）只是给已有类型起名字，运行时被擦除；RegistryTable<V> 就是 Map<string, V> 的只读视图。
// 宿主每次重载会新建表而不是原地修改旧表，因此旧代码版本持有的表不会被新版本内容污染。
export type RegistryTable<V> = ReadonlyMap<string, V>;

// 读取注册表的句柄。它由宿主实现并返回；这里只声明接口，方法如何在运行时分派版本由 host.ts 决定。
// V 必须与 defineRegistry 的 V 一致，否则 TS 会在调用 host.registry(...) 时报类型不匹配。
export interface RegistryView<V> {
	/** Table of `ctx.codeVersion`, or of the current code version without ctx. */
	/** 读取 ctx 指定代码版本的完整表；无 ctx 则读当前表。例如 view.table(ctx) 在旧调用内保留旧版本视图。 */
	// 输入：可选 ctx。输出：该版本的只读表；该版本没有注册过这个 registry 时返回共享空表。
	// 副作用：无；不会触发注册或通知。错误路径：ctx.codeVersion 已退役时宿主抛 superseded（接口未声明）。
	table(ctx?: Ctx): RegistryTable<V>;
	/** 在所选版本中按 key 查值，不存在返回 undefined；例如 view.get("GET /status", ctx)。 */
	// 这是 table(ctx).get(key) 的便捷形式；只读，不会因 key 缺失而报错。
	get(key: string, ctx?: Ctx): V | undefined;
	/** Called with the current table immediately and whenever a new table is installed. */
	/** 立即交付当前表和版本，再监听后续安装的新表；返回取消函数。例如 subscribe((table, version) => refresh(table))。 */
	// 输入：listener(table, codeVersion)。输出：无参取消函数。副作用：注册时同步调用一次当前表，之后当前版本安装新表时经发布队列异步通知；
	// 初始同步调用若抛错会直接传播；后续通知的异常逐个报告，不中断其它订阅者。读取旧版本的订阅者需自己保存旧表，
	// 宿主不会重放历史。
	// 注意 subscribe 没有 ctx 参数：它只报告“当前”表安装事件，旧代码版本仍靠调用方手中的 ctx 读取旧表。
	subscribe(listener: (table: RegistryTable<V>, codeVersion: number) => void): () => void;
}

// 一条具体注册记录关联表描述、表内键和实际值；unknown 擦除不同注册表的 V，统一交给宿主管理。
// 这是运行时对象：对象工厂调用 self.register(registry, { key: value }) 时在 object.ts 中构造，并写入本次 run 的
// Decls.registrations（只有 host 生命周期对象允许注册；同一次 run 内 registry+key 不可重复）。
// registry 用 Registry<unknown> 是为了让不同 V 的记录能放进同一个集合；真正写表时宿主按 registry 的 name 分组。
// key/value 只做透传，插入表前的重名检查由宿主按 registry.conflict 完成；这里没有运行时 schema 校验。
export interface Registration {
	// 表描述；name 决定写入哪张表，conflict 决定同键冲突行为。
	readonly registry: Registry<unknown>;
	// 表内键，例如路由字符串；同一代码版本内是否允许重复由 registry.conflict 决定。
	readonly key: string;
	// 调用方登记的值；宿主不解释它，只按类型断言放入 RegistryTable<unknown>，因此运行时形状由调用方自己保证。
	readonly value: unknown;
}
