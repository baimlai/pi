// Fixture plugin (slice 7c): the worker facet, serving `Notes` with a count document.

import { constant, defineFacet, defineState, int, obj } from "@earendil-works/chord";
import { Notes } from "../contracts/contract.ts";
import { label } from "./label.ts";

// 声明本地内存文档的 schema/版本与初始值；initial 无参返回 {n:0}，第一次使用会检查该初始值。
const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

// worker facet 注册远端 Notes 工厂；_params/_principal 形参不用，self 用于声明文档、派生值和方法。
// 每个对象的计数起始为 0，label 来自导入模块；add 在事务提交后返回最新 n，例如单次调用使 0 变 1。
// 不写持久化 store；提交失败会让 add 拒绝，工厂注册本身不修改文档。
export default defineFacet((host) =>
	host.serve(Notes, (_params, _principal, self) => {
		// self.state 取得该对象拥有的 Count 句柄；工厂只声明，激活过程负责加载初始文档。
		const doc = self.state(Count);
		// 返回提供端要求的 {variant,members}，变体必须与合同 main 一致。
		return {
			variant: "main",
			members: {
				// constant 把标签暴露为不变 JSON watchable；与下面按文档计算的 count 分开。
				label: constant(label),
				// self.derive 观察 doc 并用解构回调取 value.n；依赖变化时生成新的数值状态。
				count: self.derive([doc], ([value]) => value.n),
				// add 不带业务参数，只接本次调用上下文；等待一次文档事务，再返回已提交值。
				add: async (ctx) => {
					// change 的同步回调拿可修改草稿；ctx 控制排队与提交前取消，await 保证提交结束后再读值。
					await doc.change((draft) => {
						// 只修改事务草稿，把 n 加 1；不直接改 doc.value，事务失败时不会发布这一改动。
						draft.n += 1;
					}, ctx);
					// 读取提交后的当前值；若其他提交恰好已完成，也可能返回更晚的计数。
					return doc.value.n;
				},
			},
		};
	}),
);
