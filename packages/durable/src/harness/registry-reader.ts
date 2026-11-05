// 所属：packages/durable/src/harness，Durable Harness 的注册表适配层（Chord v2 slice 8 §5）。
// 解决的问题：应用可能把多个来源的扩展组合到一个 Chord registry；Harness 只需要“当前整份快照 + 变化通知”。
// 职责边界：本文件不安装扩展、不校验任务名、不运行任务；只把 Chord 的组合值翻译成 Durable 的 RegistryReader。
// 上游：Harness 构造时把 registryReader(value, context) 传给 TaskScheduler；value 来自 host.registry(Extensions)。
// 下游：Chord 的 RegistryValue.value 与 observe；RegistryReader/RegistrySnapshot 是 harness/types.ts 的接口。
// 结果与错误：snapshot() 返回当前组合值；subscribe() 返回解除函数。value.observe 的同步错误会直接抛出。
// 能力清单：
// - registryReader<Tool>：输入 Chord RegistryValue<RegistrySnapshot<Tool>> 与观察 Context，
//   返回 { snapshot, subscribe } 两方法的只读注册表；subscribe 只在组合成功（advance 的 kind 为 value）时唤醒 listener。
// 组合与顺序：创建 reader（此时不订阅）→ 调度器每次需要定义时调 snapshot() → 订阅后组合变化触发 listener 并重新读取。
// 示例：const reader = registryReader(await host.registry(Extensions, ctx), ctx);
//   const tasks = reader.snapshot().tasks(); // 读取当前组合
//   const stop = reader.subscribe(() => scheduler.reconsider()); // 变化时只唤醒，不传值
//   stop(); // 解除观察
// 建议阅读顺序：先看 RegistryReader/RegistrySnapshot 的接口形状，再看 registryReader 的 snapshot 与 subscribe 两个闭包。
// 测试：test/harness-registry-reader.test.ts 覆盖同步唤醒、组件内重入被拒绝、以及注册表变化唤醒调度器。
// A Harness's registry over a Chord registry (Chord v2 slice 8 §5): the composed value of p3's extensions registry,
// read as Durable's `RegistryReader`.

// 仅导入类型，编译后消失；RegistryValue 是 Chord 组合后的响应式值。
import type { RegistryValue } from "@earendil-works/chord";
// Context 提供观察生命周期；aborting 它会解除所有观察，而不只是某一次订阅。
import type { Context } from "@earendil-works/chord/context";
// RegistryReader/RegistrySnapshot 是 Harness 侧接口，ToolRegistration 约束扩展工具的具体类型。
import type { RegistryReader, RegistrySnapshot, ToolRegistration } from "./types.ts";

/**
 * A `RegistryReader` over a Chord registry value whose composition is a registry snapshot: `snapshot()` reads the
 * current composition (the last good one while `compose` fails), `subscribe` observes its compositions, its listener
 * called synchronously inside the Chord batch that composed (so it only wakes the scheduler; a Chord call there
 * throws `invalid/reentrant`). `context` is the observation's: aborting it detaches every listener.
 */
// 把 Chord 注册值适配为 Harness 的只读注册表；输入已组合的快照值与观察上下文，返回 snapshot/subscribe 两方法。
// 例如扩展重新组合成功会唤醒订阅者；失败保持旧值。订阅会附加观察，返回的函数负责解除；底层 observe 错误向上传播。
// 流程：构造只创建两个闭包；snapshot 直接读 value.value；subscribe 调 value.observe，
// 在同步的 advance 回调中过滤 value 事件后调用 listener，并返回 detach 闭包。
// 副作用：subscribe 会向 Chord 注册观察并可能长期持有 listener；snapshot 无副作用。
// 错误：value.observe 同步抛出的错误会从 subscribe 抛出；listener 自己抛错时由 Chord 的观察框架处理。
// 泛型 Tool 默认 ToolRegistration，调用方可用具体工具类型实例化，编译期保证快照与工具的对应关系。
export function registryReader<Tool extends ToolRegistration = ToolRegistration>(
	value: RegistryValue<RegistrySnapshot<Tool>>,
	context: Context,
): RegistryReader<Tool> {
	// 返回闭包，保留 value 和 context；此刻尚未建立订阅。
	// 对象字面量满足 RegistryReader 接口：snapshot 是同步函数，subscribe 接收无参监听器。
	return {
		// 每次访问当前组合值，不缓存调用时的旧快照。
		// value.value 是 Chord 的当前值；组合失败期间它保持上一份成功值。
		snapshot: () => value.value,
		// listener 无参数；它只通知“可重新读取”，不把快照复制给调用者。
		subscribe: (listener) => {
			// Chord 观察的生命周期绑定到 context，abort 会解除该观察。
			// observe 在每次组合推进时同步调用 advance；end 表示观察结束。
			const observation = value.observe(
				{
					// Chord 同步交付组合事件；不能在此回调里重入 Chord 操作。
					advance: (call) => {
						// A failed composition keeps the last snapshot: nothing to reconsider.
						// 仅成功值事件唤醒调度器，失败事件不改变可用注册快照。
						// kind 是判别字段：value 表示新组合值，其他分支（如失败）忽略。
						if (call.kind === "value") listener();
					},
					// 观察结束无需向 Harness 再发送一份注册值。
					end: () => {},
				},
				context,
			);
			// 返回取消订阅闭包，调用才 detach；不要在 subscribe 过程中立即解除。
			// 闭包让调用方可以像普通事件监听器一样保存并稍后释放。
			return () => observation.detach();
		},
	};
}
