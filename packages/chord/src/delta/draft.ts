/*
 * 文件导读
 * ========
 * 所属：packages/chord/src/delta，Chord 共享的 Delta 模块（不依赖 harness 上层）。
 *
 * 职责边界：本文件只定义一个纯类型 `Draft<T>`，把“只读的 JSON 状态类型”映射成“事务中可写的视图类型”。
 * 它不产生任何运行时代码，也不负责校验、拷贝或追踪修改；这些由 tracker.ts 的 Proxy 和 prepare() 完成。
 *
 * 上游入口：调用方通过 `track()` 得到 `Tracker<T>`，再调用 `beginChange()`；返回的 `Change<T>` 上
 * `state: Draft<T>` 就是这里的类型（签名见同目录 tracker.ts）。
 * 下游依赖/结果：调用方在 `change.state` 上改字段、调用数组方法；`change.prepare()` 产出的
 * `Prepared<T>.value` 类型重新回到原来的 `T`。错误（例如只读草稿已结束、写入非法类型）由 tracker 在
 * 运行时抛出，本文件不参与。
 *
 * 能力清单（本文件只有一个导出）：
 * - `Draft<T, Depth = []>`：条件/映射类型。去掉对象与数组的 readonly 修饰，递归映射每个字段；
 *   遇到标量、函数或第 8 层嵌套时停止。
 *
 * 组合关系与典型顺序：
 *   track(value) -> beginChange() -> change.state（Draft<T>）中修改 -> change.prepare()（value: T）
 *   -> tracker.adopt(prepared)。
 *
 * 示例（说明类型行为；`declare` 表示省略真实构造）：
 *   type Doc = { readonly title: string; readonly rows: readonly { readonly n: number }[] };
 *   declare const tracker: Tracker<Doc>;
 *   const change = tracker.beginChange();
 *   const draft: Draft<Doc> = change.state;
 *   draft.title = "new";          // 编译通过：Draft 去掉了 readonly
 *   draft.rows.push({ n: 1 });    // 编译通过：数组元素也递归变成 Draft
 *   const value: Doc = change.prepare().value; // 类型回到只读的 Doc
 * 注意这是类型示例；运行时真正拦截越界写入的是 tracker 的 Proxy，而不是 Draft。
 *
 * 建议阅读顺序：先看类型参数 `T`/`Depth` 的含义，再沿条件类型的四个分支阅读：深度上限、标量、函数、
 * 对象映射。理解 `[...Depth, unknown]` 如何累计深度即可。
 */
/** A mutable transaction-scoped view of a JSON value, preserving tuple positions. */
// `Draft` 有两个类型参数：
// - T：原始 JSON 值的类型，通常是 Readonly 的嵌套对象或数组；
// - Depth：内部递归计数器，默认为空元组 []，调用方一般不需要显式传入。
// 第二行是索引访问类型 `Depth["length"]`，取出元组的长度；这里用它判断递归到了第几层。
export type Draft<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 8
	? // 到达第 8 层就停止展开，直接返回 T。这是编译期的深度上限，避免类型系统在超深嵌套上无限递归。
		T
	: // 原始标量（null、布尔、数字、字符串）没有可写成员，原样返回。
		T extends null | boolean | number | string
		? T
		: // 函数类型不做字段映射，避免把函数当普通对象改写。
			T extends (...args: never[]) => unknown
			? T
			: // 其余对象类型（包括数组与元组）进入映射类型。
				T extends object
				? // 映射类型 `{ -readonly [Key in keyof T]: ... }` 遍历 T 的每个键：
					// - `-readonly` 去掉原有的 readonly 修饰，所以草稿字段可赋值；
					// - 每个字段递归套一层 Draft，并把 `[...Depth, unknown]` 作为新的深度元组，
					//   长度加一，用于上面的第 8 层判断；
					// - 元组的下标键保持不变，因此元组的位置信息得以保留。
					{ -readonly [Key in keyof T]: Draft<T[Key], [...Depth, unknown]> }
				: // 兜底分支：不是对象也不是上面几类，就保持原类型。
					T;
