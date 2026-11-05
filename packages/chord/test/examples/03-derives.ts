// Derives: values computed from documents and from other objects' members, recomputed only when needed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/03-derives.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 03，对应 slice 1（derives，design §12）。
// 演示什么：派生值是纯同步计算：self.derive(sources, compute) 显式声明源，只在需要时计算；没有观察者时提交只标记
//   派生变脏，读取 value 才计算。源可以是本对象的文档，也可以是 self.get 得到的另一个对象的成员。mapShared 按
//   元素对象身份缓存映射结果，因此追加一条备注只重新映射新对象，已有标题保持不变。
// 上游/下游：文件顶部命令启动；下游使用 src/documents 的 defineState、src/host 的 createHost/defineFacet、
//   src/state 的 mapShared、src/contracts 的 local/method/schema。示例全在进程内运行，无网络。
// 能力清单（按演示的机制）：
// - self.derive([source, …], compute)：同步、纯计算；源数组的元素可以是文档句柄或其他成员。
// - 惰性求值：无人观察时提交只标脏；读取派生值触发计算，未变化的源不会重复映射。
// - mapShared(fn)：WeakMap 按输入对象缓存结果；相同备注对象得到同一个标题字符串，派生差异更小。
// - 跨对象派生：Badge 通过 self.get(Notes, {}) 声明依赖，再以 notes.count 为源组合 label。
// - 文档写入：add 在 change 事务里向草稿 push；提交后才对外可见。
// - 依赖未就绪时：工厂只声明依赖，激活等待依赖 live，不在工厂里同步读取值。
// 典型运行顺序：load -> get Notes -> get Badge(mario)（声明并等待依赖）-> 追加两项 -> 首次读取 titles（计算两次）->
//   追加第三项（只计算新标题）-> 再读 titles -> 读 badge.label -> close。
// 示例（符合真实签名）：
//   const title = mapShared((note: { text: string }) => note.text.slice(0, 12));
//   titles: self.derive([notes], ([n]) => title(n.list)),
//   count: self.derive([notes], ([n]) => n.list.length),
//   const badge = self.get(Notes, {}); // 依赖另一个对象
//   label: self.derive([badge.count], ([count]) => `${user}: ${count} notes`)
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无网络；瞬时完成。
// 预期输出（标题只打印首次映射的那几条）：
//   title computed for: buy milk and bread
//   title computed for: call Anna
//   titles: [ 'buy milk and', 'call Anna' ]
//   title computed for: water plants
//   titles: [ 'buy milk and', 'call Anna', 'water plants' ]
//   badge: mario: 3 notes
// 对应测试与文档：packages/chord/test/state/derive.test.ts；packages/chord/test/host/dependencies.test.ts、
//   members.test.ts；slices.md 的 slice 1；design.md 的 §12。
// 建议阅读顺序：先看 NotesDoc 与 Notes/Badge 契约，再看 Notes 工厂里的 mapShared 与两个 derive，
//   随后看 Badge 的 self.get 依赖，最后按两次 titles 读取理解惰性与缓存。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { mapShared } from "../../src/state/index.ts";

// 使用无取消信号的后台上下文；派生计算是同步的，方法和加载仍用 await。
const context = BACKGROUND_CONTEXT;

// 定义内存文档，list 保存原始备注对象；派生值从它读取，不另建可写文档。
const NotesDoc = defineState("notes", {
	// 备注列表元素具有字符串 text；schema 推导方法中的草稿类型。
	schema: obj({ list: arr(obj({ text: str() })) }),
	version: 1,
	// 初值回调无参数，返回新的空列表对象；首次结果经过运行时 schema 检查。
	initial: () => ({ list: [] }),
});

// 本地空参数 Notes 随宿主存活；标题和数量是只读状态，add 是写入口。
const Notes = local("example.notes", {
	version: 1,
	params: {},
	members: { titles: arr(str()), count: int(), add: method(obj({ text: str() })) },
});
// Badge 按 user 区分实例，公开计算后的 label，而不暴露可写文档。
const Badge = local("example.badge", { version: 1, params: { user: str() }, members: { label: str() } });

// setup 登记 Notes 和 Badge 两种对象；本函数只声明，返回 void，load 时执行。
const facet = defineFacet((host) => {
	// Notes 工厂用 self 声明文档和派生计算，返回状态与 add；初始化失败会阻止实例就绪。
	host.serve(Notes, (_, self) => {
		// 取得本对象的原始数据句柄，后面所有派生源都指向它。
		const notes = self.state(NotesDoc);
		// mapShared calls its function once per note object: unchanged notes keep the same title, so the derive's
		// diff after an append is one insert, not a comparison of every title.
		// 创建列表映射函数 title；回调参数的 {text:string} 是 TS 结构类型，不执行运行时校验。
		// 回调接收新备注对象，打印一次并返回前12个 UTF-16 码元；WeakMap 按对象身份复用已有结果。
		const title = mapShared((note: { text: string }) => {
			// 日志用于看哪些元素重新映射；它是此教学示例的副作用。
			console.log("  title computed for:", note.text);
			// slice 截取标题；若不足12个码元则完整返回，可能在代理对中间截断。
			return note.text.slice(0, 12);
		});
		return {
			// A derive declares its sources; its compute is synchronous and pure.
			// derive 显式声明一个源，数组解构 [n] 取其值，交给 title 映射；例如追加一个对象只重新映射该对象。
			titles: self.derive([notes], ([n]) => title(n.list)),
			// 同步计算列表长度；这是纯计算，不在回调里写文档或发起调用。
			count: self.derive([notes], ([n]) => n.list.length),
			// add 解构输入正文，经一次 change 事务追加备注，提交后返回 null；失败沿 Promise 传播。
			add: async ({ text }, ctx) => {
				// change 先加载草稿，再执行同步回调；await 等到提交完成。
				await notes.change((draft) => {
					// 在草稿里追加新对象；旧备注仍保持对象身份，便于 mapShared 复用。
					draft.list.push({ text });
				}, ctx);
				// 无结果的方法返回 null。
				return null;
			},
		};
	});
	// A derive over another object's member, through a reference declared with self.get.
	// Badge 工厂接收用户名和声明接口；先声明 Notes 依赖，再返回 label 派生状态。
	// 例如 user=mario 时 label 可能是 mario: 3 notes；工厂不立即读取依赖值，依赖未就绪时会停车等待。
	host.serve(Badge, ({ user }, self) => {
		// 声明依赖引用，让 Chord 在 Badge 激活前准备 Notes，并随 Badge 结束释放它。
		const notes = self.get(Notes, {});
		// 只以 count 为源，数量变化后重新组合标签；user 来自本实例工厂闭包。
		return { label: self.derive([notes.count], ([count]) => `${user}: ${count} notes`) };
	});
});

// 创建宿主并打印后台错误；这里只使用本地对象。
const host = createHost({ onError: (error) => console.error("background error:", error) });
// 发布两类声明，启动空参数 Notes；Badge 等首次 get 才按需创建。
await host.load([{ name: "@example/notes", facet }], context);
// 获取可调用的 Notes 引用。
const notes = await host.get(Notes, {}, context);
// 创建 mario 的徽章，等待其 Notes 依赖及首个 label 计算完成。
const badge = await host.get(Badge, { user: "mario" }, context);

// 追加第一项，标题派生没有观察者，提交主要标记它变脏。
await notes.add({ text: "buy milk and bread" }, context);
// 追加第二项；随后读取 titles 才计算脏值。
await notes.add({ text: "call Anna" }, context);
// Nobody watches `titles`, so the commits only marked it; reading computes it, each title once.
// 读取时触发需要的派生计算；第二次读取会复用未变化备注的映射结果。
console.log("titles:", notes.titles.value);
// 追加第三项，新备注对象会触发一次新的标题映射。
await notes.add({ text: "water plants" }, context);
// 读取时触发需要的派生计算；第二次读取会复用未变化备注的映射结果。
console.log("titles:", notes.titles.value);
// 读取徽章标签，必要时沿 count 依赖链计算最新数量。
console.log("badge:", badge.label.value);

// 关闭宿主并解除派生值与其源之间的订阅关系。
await host.close(context);
