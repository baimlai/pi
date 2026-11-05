// The notes plugin's worker facet: serves `Notes`, its count kept in a document.

import { constant, defineFacet, defineState, int, obj } from "@earendil-works/chord";
import { Notes } from "../contracts/contract.ts";
import { label } from "./label.ts";

// 定义当前对象拥有的内存文档 {n: number}；initial 无参数、返回新对象，首次缺值时从0开始。
// int 是运行时 schema；初值按定义首次使用时检查，不是每次提交都遍历整个文档。
const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

// setup 登记 Notes 工厂；工厂收到身份参数、调用者身份和 self，前两项以 _ 命名表示本例未用。
// 工厂只声明文档/派生状态/方法，无实际写入；返回 main 分支的成员供 Chord 激活。
// 例如 await notes.add(ctx) 把 n 从0改为1并返回提交后计数；写入/取消错误由 Promise 向调用方传播。
export default defineFacet((host) =>
	host.serve(Notes, (_params, _principal, self) => {
		// self.state 取得本对象该定义的句柄，纯重载时原对象的文档仍在。
		const count = self.state(Count);
		return {
			// variant 与契约的 main 对应，成员名称和形状由激活检查确认。
			variant: "main",
			members: {
				// 常量标签来自本次脚本；派生回调解构单元素 sources 值，只读出文档 n，无副作用。
				label: constant(label),
				count: self.derive([count], ([value]) => value.n),
				// 无业务参数的方法只有 ctx；change 等到这一笔文档事务提交后才完成。
				add: async (ctx) => {
					await count.change((draft) => {
						// draft 是事务专用草稿，此自增被记录为变更；不能把草稿保存到事务外继续使用。
						draft.n += 1;
					}, ctx);
					// 返回提交后的普通数字；不返回已经被撤销的 draft。
					return count.value.n;
				},
			},
		};
	}),
);
