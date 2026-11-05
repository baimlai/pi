// `linger` and `ref.retry()`: an object that stays warm after its last reference, failed references with `retryAt`,
// a Retry button that skips the backoff, and a broken object renewed by a retry.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/11-linger-and-retry.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 11，对应 slice 3b（linger、引用失败与手动重试）。
// 演示什么：带参数对象在最后一个引用释放后按 linger 保留一段时间，期间重新 get 能拿回同一实例和内存文档；
//   一个先 broken（不自动重试）后 transient（带 retryAt 的退避重试）的引用，如何通过 ref.retry() 跳过退避、
//   在配置修复后重新激活并转为 live；以及 live 状态下 retry 不起作用。
// 上游/下游：文件顶部命令启动；下游使用 src/host 的 createHost/defineFacet/get/hold/RefState、src/data 的 broken、
//   src/documents 的 defineState。示例不访问网络，镜像的可达性由模块内可变标志模拟。
// 能力清单（按演示的机制）：
// - serve 的 linger: 200：最后一个引用释放后对象继续存活 200ms，重开标签页能复用文本。
// - broken(error)：确定性失败，不安排自动重试；RefState 为 failed/broken，retryAt 为 undefined。
// - 普通 throw：transient 失败，按退避自动重试；RefState 的 retryAt 给出下次尝试时间。
// - ref.retry()：立即发起一次新尝试（跳过退避）；broken 对象由此“续期”，live 时调用无效果。
// - ref.state.watch 与 describe：把 loading/live/failed 状态及失败原因格式化成日志。
// 典型运行顺序：load -> get Draft 写入 hello -> release -> 100ms 后重新 get（同实例，文本保留）-> release ->
//   300ms 后重新 get（超过 linger，新实例，文本为空）-> hold Mirror 观察状态 -> 修复配置后 retry（broken 变 transient）->
//   服务端就绪后再次 retry（跳过退避，转 live）-> live 时 retry 无效 -> release -> close。
// 示例（符合真实签名）：
//   const mirror = host.hold(Mirror, { id: 1 }, context); // 同步返回引用
//   remote.configured = true;
//   mirror.retry(); // 跳过退避立即重试；之后 mirror.state.value 可能变为 transient/live
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无外部服务；总时长约 0.4 秒。
// 预期输出：(draft c1 activated)；within linger: "hello"；(draft c1 activated)；after linger: ""；
//   onError: activation_failed；ref.state → failed, broken, no automatic retry: …no mirror configured；
//   ref.state → loading；onError: activation_failed；ref.state → failed, transient, retries in 1000 ms: …
//   ref.state → loading；ref.state → live；status: mirroring。毫秒数允许少量调度误差。
// 对应测试与文档：packages/chord/test/host/retry-on.test.ts、ref-state.test.ts、native.test.ts；
//   slices.md 的 slice 3b；失败分类的细节见示例 07-failures.ts。
// 建议阅读顺序：先看 Draft/Mirror 契约、DraftDoc 与 remote 标志，再看两个 serve 工厂（尤其 open 的 broken/transient
//   分支），随后看 describe 辅助函数，最后按 2-6 步读 linger 与 retry 的时间线。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, obj, str } from "../../src/contracts/index.ts";
import { broken } from "../../src/data/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

// 进程内后台上下文；wait 只是示例的观察手段。
const context = BACKGROUND_CONTEXT;

// Draft 按 conversation 区分实例；text 是只读状态，type 接收新文本并写文档。
const Draft = local("example.draft", {
	version: 1,
	params: { conversation: str() },
	members: { text: str(), type: method(obj({ text: str() })) },
});

// Mirror 按 id 区分实例；状态恒为 mirroring，能否激活取决于模拟的远端配置。
const Mirror = local("example.mirror", { version: 1, params: { id: int() }, members: { status: str() } });

// 草稿文档保存单个 text 字段；每个 Draft 实例各有一份。
const DraftDoc = defineState("draft", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }) });

// What the mirror's open finds: nothing configured, then a server that is down, then one that answers.
// 模块级可变对象模拟外部状态：configured 控制 broken，up 控制 transient；示例按步骤修改它。
const remote = { configured: false, up: false };

// facet 登记两个本地类型；setup 在 load 时运行，工厂在激活时运行。
const facet = defineFacet((host) => {
	// 1. A draft lingers 200 ms after its last reference: a tab that closes and reopens quickly finds its text.
	// Draft 工厂解构 conversation，取得文档；第三个参数设置 linger 200ms。
	host.serve(
		Draft,
		({ conversation }, self) => {
			// 每次真正激活（而非复用 linger 实例）都会打印，用于区分两条路径。
			console.log(`  (draft ${conversation} activated)`);
			const doc = self.state(DraftDoc);
			return {
				// text 派生自文档；提交后派生会重新计算。
				text: self.derive([doc], ([d]) => d.text),
				// type 在事务中覆盖文本；change 回调是同步的，await 等提交完成。
				type: async ({ text }, ctx) => {
					await doc.change((draft) => {
						draft.text = text;
					}, ctx);
					// 无结果的方法返回 null。
					return null;
				},
			};
		},
		// 最后一个引用释放后保持 200ms；期间新的 get 复用同一实例和文档。
		{ linger: 200 },
	);
	host.serve(Mirror, (_, self) => {
		self.open(
			async () => {
				// `broken`: retrying cannot help until someone changes something (no automatic retry).
				// 未配置是确定性失败：broken 包装后不安排自动重试，retryAt 为 undefined。
				if (!remote.configured) throw broken(new Error("no mirror configured"));
				// A plain throw is transient: retried with backoff (1 s, doubling).
				// 已配置但服务不可达是暂时失败：普通 Error 触发 1s、2s、4s… 的自动退避重试。
				if (!remote.up) throw new Error("mirror unreachable");
				// open 成功；这里返回 null，因为状态成员是恒定值，不依赖资源值。
				return null;
			},
			// 关闭回调无需清理。
			() => {},
		);
		return { status: constant("mirroring") };
	});
});

// 宿主 onError 只打印错误 kind；激活失败会以 activation_failed 报告两次（broken 与 transient）。
const host = createHost({ onError: (error) => console.log(`  onError: ${error.kind}`) });
// 发布 facet；空参数的宿主生命周期对象在 load 期间启动。
await host.load([{ name: "@example/app", facet }], context);
// wait 辅助函数：毫秒数参数，返回到点 resolve 的 Promise；用于等待 linger 与状态传播。
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A state for the log: a failure with its kind, when it retries by itself, and its error. */
// describe 把 RefState 格式化成一行日志；输入是引用状态联合，输出字符串。
// 非 failed 状态直接返回 kind；failed 状态读 cause.kind、retryAt 与 cause.error。
function describe(state: RefState): string {
	// 先按 kind 窄化；只有 failed 分支有 cause/retryAt 字段。
	if (state.kind !== "failed") return state.kind;
	// retryAt 是绝对毫秒时间戳；undefined 表示不会自动重试（broken 或 waiting）。
	const retry = state.retryAt === undefined ? "no automatic retry" : `retries in ${state.retryAt - Date.now()} ms`;
	// cause 是 FailureCause：kind 为 transient/broken/waiting，error 是原始错误。
	return `failed, ${state.cause.kind}, ${retry}: ${state.cause.error.message}`;
}

// 2. Linger: release, get again within 200 ms, the same object and its in-memory document.
// 首次获取并写入 hello；let 允许后面把 draft 重新赋值为新引用。
let draft = await host.get(Draft, { conversation: "c1" }, context);
await draft.type({ text: "hello" }, context);
// 释放引用；对象因 linger 200ms 暂不结束。
draft.release();
// 100ms 内重新获取，应复用同一实例（不会再打印 activated），文档仍是 hello。
await wait(100);
draft = await host.get(Draft, { conversation: "c1" }, context);
console.log("within linger:", JSON.stringify(draft.text.value));
draft.release();
// 超过 linger（300ms > 200ms）后对象已结束；再次获取会重新激活并得到 initial 空文本。
await wait(300);
draft = await host.get(Draft, { conversation: "c1" }, context);
console.log("after linger:", JSON.stringify(draft.text.value));
draft.release();

// 3. A held reference follows its object: broken first (no retryAt), so nothing happens by itself.
// hold 同步返回 Mirror 引用；初始激活会因未配置而 broken。
const mirror = host.hold(Mirror, { id: 1 }, context);
// 观察引用状态，打印每次变化。
const watch = await mirror.state.watch(context);
watch.start(async (call) => {
	// 原生帧 value 分支的 call.value 是 RefState；交给 describe 统一格式化。
	if (call.kind === "value") console.log(`  ref.state → ${describe(call.value)}`);
});
// 等首次失败上报与状态帧送达。
await wait(10);

// 4. The user fixes the configuration and presses Retry: the broken object is renewed and tries again. The server is
// still down: a transient failure, retried automatically at retryAt.
// 模拟“配置已修复”；此时 open 会越过 broken 分支，但因为服务未启动而抛普通错误。
remote.configured = true;
// retry 跳过退避立即重试：broken → loading → transient（retryAt 约 1000ms 后）。
mirror.retry();
await wait(10);

// 5. Retry again (a Retry button): the backoff window is skipped; this time it goes live.
// 模拟服务启动；再次 retry 不等退避时间到点，直接新尝试。
remote.up = true;
mirror.retry();
await wait(10);
// 激活成功；读取状态成员确认值可读。
console.log("status:", mirror.status.value);

// 6. A retry while live does nothing.
// live 状态下 retry 是无操作，不会重建对象；等待后释放引用并关闭宿主。
mirror.retry();
await wait(10);
mirror.release();
await host.close(context);
