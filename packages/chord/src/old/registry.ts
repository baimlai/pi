// Chord v1 的注册表声明与只读视图类型；真正的按代码版本存储、冲突检查和通知由 host.ts 管理。
import type { Ctx } from "./types.ts";

// V 是每个注册项的值类型；此描述只含名字和冲突策略，不存放注册表中的实际条目。
export interface Registry<V> {
	readonly name: string;
	readonly conflict: "error" | "last";
	/** Type carrier only; never set. */
	// 可选 value 只承载泛型供 TS 推导，不会由 defineRegistry 设置。
	readonly value?: V;
}

/** `conflict: "error"` rejects two objects registering one key; `"last"` keeps the later registration. */
/**
 * 用 name 与可选冲突策略创建注册表描述并返回；不注册条目，也不马上检查重名。
 * 默认 error，last 允许后来的条目覆盖。例如 defineRegistry<Handler>("routes") 供 self.register 与 host.registry 使用。
 */
export const defineRegistry = <V>(name: string, options: { conflict?: "error" | "last" } = {}): Registry<V> => ({
	// 箭头函数的 ({ ... }) 表示直接返回对象；属性简写 name 等于 name: name。
	name,
	// ?? 仅在未给出策略时采用 error；此函数没有做运行时输入校验。
	conflict: options.conflict ?? "error",
});

// ReadonlyMap 暴露查找和遍历，TS 不提供 set/delete；运行时不会因此冻结原 Map。
export type RegistryTable<V> = ReadonlyMap<string, V>;

export interface RegistryView<V> {
	/** Table of `ctx.codeVersion`, or of the current code version without ctx. */
	/** 读取 ctx 指定代码版本的完整表；无 ctx 则读当前表。例如 view.table(ctx) 在旧调用内保留旧版本视图。 */
	table(ctx?: Ctx): RegistryTable<V>;
	/** 在所选版本中按 key 查值，不存在返回 undefined；例如 view.get("GET /status", ctx)。 */
	get(key: string, ctx?: Ctx): V | undefined;
	/** Called with the current table immediately and whenever a new table is installed. */
	/** 立即交付当前表和版本，再监听后续安装的新表；返回取消函数。例如 subscribe((table, version) => refresh(table))。 */
	subscribe(listener: (table: RegistryTable<V>, codeVersion: number) => void): () => void;
}

// 一条具体注册记录关联表描述、表内键和实际值；unknown 擦除不同注册表的 V，统一交给宿主管理。
export interface Registration {
	readonly registry: Registry<unknown>;
	readonly key: string;
	readonly value: unknown;
}
