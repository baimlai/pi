// 文件导读
// 所属：packages/chord/test/examples/35-plugins/plugins/notes/worker.ts，示例 35 的 @example/notes 插件 worker facet（slice 7c）。
// 插件清单：同目录 package.json 只声明 name "@example/notes"、private 与 type:module；目录同时有 server.ts 与
// worker.ts，因此本插件在 server/worker 两个 kind 各有一个 facet。本文件是 worker kind 的入口。
// 演示内容：worker 服务远程 Notes（main 变体：label/count/add）；count 存在当前对象的内存文档，add 用事务自增。
// main.ts 在 server 上取 Notes 引用，经 route 找到 worker；调用 add 后计数从 0 变 1，重载 label.ts 后计数仍为 1。
// 上游入口：createPlugins 发现本文件（kind worker）→ buildFacet → evaluateFacet → worker.load。
// 下游调用：defineFacet/defineState/host.serve/constant/self.state/self.derive/int/obj、文档 change。
// 失败行为：模块求值/声明错误在装载阶段报告；add 的事务被取消/宿主关闭时，change 的 Promise 拒绝并传播给调用者。
// 能力清单：
// - Count：本对象的内存单例文档 {n:int}，非持久化。
// - Notes 工厂：main 变体的 label（常量）、count（文档派生）、add（事务自增）。
// 典型运行顺序：worker.load 时工厂执行 → main 通过 Notes 引用 add(ctx) → count 变 1 → label.ts 重建并 reload →
// 纯对象原地 swap，文档保留（count 仍 1），新 label 生效。
// 示例（真实签名）：
//   export default defineFacet((host) => host.serve(Notes, (_params, _principal, self) => ({ ... })));
// 阅读顺序：先看 Count 定义与文档生命周期，再看工厂返回的 variant/members，最后看 add 的 change 与返回值。
// 运行方式：由 35-plugins/main.ts 发现并装载，不能单独运行；预期初始 notes: v1 count 1，rollout 后 v2 count 1。
// 相关文档：packages/chord/docs/slice-7c.md §2、§3、§5；相关测试：test/node/plugins/ 的 runtime/e2e 用例。
// The notes plugin's worker facet: serves `Notes`, its count kept in a document.

// 宿主包导入由求值器提供本进程实例；契约与 label 是相对导入，构建时被内联进本 facet 的脚本。
import { constant, defineFacet, defineState, int, obj } from "@earendil-works/chord";
import { Notes } from "../contracts/contract.ts";
import { label } from "./label.ts";

// 定义当前对象拥有的内存文档 {n: number}；initial 无参数、返回新对象，首次缺值时从0开始。
// int 是运行时 schema；初值按定义首次使用时检查，不是每次提交都遍历整个文档。
// Count 是 StateDefinition（不是值）：name "count" 受 checkName 限制，version 参与文档版本/指纹；
// 未写 persist 即非持久化，只存在本进程内存。Notes.params 为空，所以只有一个对象实例，也就只有这份文档。
const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

// setup 登记 Notes 工厂；工厂收到身份参数、调用者身份和 self，前两项以 _ 命名表示本例未用。
// 工厂只声明文档/派生状态/方法，无实际写入；返回 main 分支的成员供 Chord 激活。
// 例如 await notes.add(ctx) 把 n 从0改为1并返回提交后计数；写入/取消错误由 Promise 向调用方传播。
export default defineFacet((host) =>
	host.serve(Notes, (_params, _principal, self) => {
		// self.state 取得本对象该定义的句柄，纯重载时原对象的文档仍在。
		// 句柄本身不是数值：.value 读已提交快照，.change 在事务里修改；不同对象即使共用定义也各有文档。
		const count = self.state(Count);
		return {
			// variant 与契约的 main 对应，成员名称和形状由激活检查确认。
			variant: "main",
			members: {
				// 常量标签来自本次脚本；派生回调解构单元素 sources 值，只读出文档 n，无副作用。
				label: constant(label),
				count: self.derive([count], ([value]) => value.n),
				// 无业务参数的方法只有 ctx；change 等到这一笔文档事务提交后才完成。
				// 契约写的是 method(undefined, int())：无参数 schema，结果 int；实现返回的 Promise 解析为提交后的计数。
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
