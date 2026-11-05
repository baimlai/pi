// Errors: what Chord refuses and how a caller tells the cases apart (`ChordError` with `code` and `reason`).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/05-errors.ts
// 文件导读
// 所属包与示例系列：packages/chord/test/examples，Chord v2 示例 05，对应 slice 1（错误分类；readyTimeout 相关行为
//   在后续失败/恢复 slice 中展开）。
// 演示什么：Chord 会拒绝哪些操作，以及调用方如何用 isChordError 区分。示例覆盖参数错误、参数对象错误、依赖环、
//   实现声明不符、契约版本不匹配、工厂抛错、引用释放和宿主关闭；每次失败都经 attempt 打印 code/reason/message。
//   同时演示激活失败会作为后台报告进入 onError，而 load 仍能完成（每个对象先有 live 或 failed 的首次结果）。
// 上游/下游：文件顶部命令启动；下游使用 src/contracts 的 local/method/schema、src/data 的 isChordError、
//   src/host 的 createHost/defineFacet/HostError、src/state 的 constant。示例全在进程内运行，无网络。
// 能力清单（按演示的机制）：
// - isChordError(error, code?)：运行时先验 instanceof，再按需比较固定 code；用于安全读取 code/reason/message。
// - invalid/args：方法参数类型错误或出现未知字段；检查发生在对象入口，错误消息带 args/<字段>。
// - invalid/params：get 的 params 不匹配 schema；对象不会被创建。
// - invalid/cycle：同宿主激活链回到自身；消息给出完整环，链上对象都以 broken 结束。
// - unavailable：实现包含契约未声明的成员，或工厂抛错；消息说明具体对象与原因。
// - contract_mismatch：另一份同名声明（v2）与服务中的 v1 版本/结构不匹配；get 在 readyTimeout 内等待匹配者，
//   超时后以该原因拒绝。
// - released：使用已释放的引用；released/closed：宿主关闭后的 get。
// - onError：activation_failed 等后台报告与调用侧拒绝分开；@ts-expect-error 展示编译期检查与运行时校验的差别。
// 典型运行顺序：load（Ping/Pong 环与空参数对象先有首次结果）-> 环 get -> 正常 get Echo -> 错误参数/未知字段 ->
//   错误 params -> Sloppy 多余成员 -> EchoV2 契约不匹配（等待 100ms）-> Broken 工厂抛错 -> release 后调用 ->
//   close 后 get。
// 示例（符合真实签名）：
//   if (isChordError(error, "invalid")) console.log(error.code, error.reason, error.message);
//   await echo.echo({ text: "hi" }, context);
//   await host.get(EchoV2, { id: 1 }, context, { readyTimeout: 100 });
//   echo.release();
// 运行方式与环境：在 packages/chord 下执行文件顶部命令；无环境变量、无网络；约 0.1 秒完成（契约不匹配的等待）。
// 预期输出：
//   reported: example.pong failed broken
//   reported: example.ping failed broken
//   get in a cycle: invalid/cycle - dependency cycle: example.ping → example.pong → example.ping
//   wrong argument: invalid/args - args/text: expected string, got integer
//   unknown field: invalid/args - args/extra: unknown field
//   bad params: invalid/params - params/id: expected integer, got string
//   reported: example.sloppy(1) failed broken
//   unknown member: unavailable - example.sloppy(1): extra: not a member
//   contract mismatch: contract_mismatch - example.echo v2 does not match the served v1
//   reported: example.broken(1) failed broken
//   throwing factory: unavailable - example.broken(1): broken: missing configuration
//   released reference: released - example.echo: released
//   get after close: released/closed - the host is closed
// 对应测试与文档：packages/chord/test/host/attempt.test.ts、host.test.ts、dependencies.test.ts、reference.test.ts；
//   packages/chord/test/data/（错误构造与匹配）；slices.md 的 slice 1；design.md 的 §5/§6/§7。
// 建议阅读顺序：先看 attempt 与 Echo/依赖环定义，再看 facet 中三个工厂与 onError 分支，
//   最后按输出顺序读参数、身份、契约与生命周期错误。
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, obj, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

// 本例统一使用后台上下文；故意触发的失败由 attempt 捕获显示。
const context = BACKGROUND_CONTEXT;

/** Prints how `work` failed: a ChordError's code, reason and message, or a plain error's message. */
// 执行 work 并打印带 label 的结果，返回不含业务值的 Promise<void>；work 可同步返回或返回 Promise。
// 先 await 再记录成功；捕获任意抛出值并区分 ChordError/普通 Error，例如 attempt("x", () => Promise.reject(err)) 会打印错误。
// 该函数把错误用于演示而不重新抛出；副作用只有执行 work 和终端输出，不断言具体结果。
async function attempt(label: string, work: () => unknown): Promise<void> {
	// 把同步抛错和 await 的异步拒绝都纳入同一个 catch。
	try {
		// 调用无参数回调并等待其结果；unknown 允许任意结果，await 也可接收普通值。
		await work();
		// 只有 work 正常完成才输出 ok。
		console.log(`${label}: ok`);
	} catch (error) {
		// 运行时辨认 ChordError，之后 code/reason/message 字段才有相应 TS 类型。
		if (isChordError(error))
			// 有 reason 时补上 /reason，无 reason 时输出空字符串；模板嵌套只用于格式化。
			console.log(`${label}: ${error.code}${error.reason ? `/${error.reason}` : ""} - ${error.message}`);
		// 异常边界允许任意值；Error 取 message，其余用 String 转成可打印文字。
		else console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// 声明按整数 id 区分的本地实例；echo 要求 {text:string} 并返回字符串。
const Echo = local("example.echo", {
	version: 1,
	params: { id: int() },
	members: { id: int(), echo: method(obj({ text: str() }), str()) },
});
// Two types that get each other while they activate: a cycle.
// 空参数 Ping 会在 load 时尝试激活，供下面构造依赖环。
const Ping = local("example.ping", { version: 1, params: {}, members: { n: int() } });
// Pong 与 Ping 对称，两个工厂相互 self.get 后不能同时满足激活依赖。
const Pong = local("example.pong", { version: 1, params: {}, members: { n: int() } });
// Broken 带参数，因此稍后的 get 才会触发故意抛错的工厂。
const Broken = local("example.broken", { version: 1, params: { id: int() }, members: { n: int() } });
// Sloppy 契约只声明 n，额外实现成员将在激活检查中被拒绝。
const Sloppy = local("example.sloppy", { version: 1, params: { id: int() }, members: { n: int() } });

// setup 登记正常、抛错及多余成员三个工厂；load 只发布其声明。
const facet = defineFacet((host) => {
	// Echo 工厂解构 id 返回固定状态和 echo；内部异步方法原样返回 text，例如 hi 得到 hi，不产生写入。
	host.serve(Echo, ({ id }) => ({ id: constant(id), echo: async ({ text }) => text }));
	// Broken 工厂忽略参数并立即抛 Error；这是对象代码错误，标为 broken，而非自动退避重试的 open 失败。
	host.serve(Broken, () => {
		// 构造故障演示，异常由激活路径报告并使 get 拒绝。
		throw new Error("broken: missing configuration");
	});
	// Plugins are bundled without type checks; Chord checks the implementation's members when the object activates.
	// as never 故意绕过开发期实现类型限制；它不删除 extra，运行时仍检查实际成员并拒绝。
	host.serve(Sloppy, () => ({ n: constant(1), extra: constant(2) }) as never);
});
// Ping and Pong are served by a second plugin: types with empty params activate at load.
// 第二个插件 setup 登记依赖环，无业务返回值；环在激活时被发现，不是 TS 的递归类型检查。
const cycle = defineFacet((host) => {
	// Ping 工厂声明 Pong 依赖并转暴露其 n；没有立即同步读取 n.value。
	host.serve(Ping, (_, self) => ({ n: self.get(Pong, {}).n }));
	// Pong 反向声明 Ping，形成 Ping → Pong → Ping 的激活环，导致 invalid/cycle。
	host.serve(Pong, (_, self) => ({ n: self.get(Ping, {}).n }));
});

// Failed activations are reported to onError; 07-failures.ts shows the other reports.
// 接收宿主后台报告并输出类型，返回 void；HostError 是 TS 联合类型，运行时以 kind 分支区分。
const onError = (error: HostError): void => {
	// 激活失败报告含 failure，打印哪个对象失败以及原因分类。
	if (error.kind === "activation_failed") console.log(`reported: ${error.object} failed ${error.failure.kind}`);
	// 其他后台报告只显示 kind。
	else console.log("reported:", error.kind);
};

// A dependency cycle fails every object on it broken, with invalid/cycle naming the chain. Load still resolves: the
// start barrier waits for each object's first outcome, live or failed.
// 对象简写把同名 onError 回调交给宿主。
const host = createHost({ onError });
// 加载两个插件；本地空参数对象会尝试启动，load 等首次结果，环失败不会使整个宿主自动关闭。
await host.load(
	[
		// 正常示例插件用同名变量 facet。
		{ name: "@example/errors", facet },
		// 环示例插件显式把 cycle 值放在 facet 字段。
		{ name: "@example/cycle", facet: cycle },
	],
	context,
);
// 用惰性回调把 get 的拒绝交给 attempt，展示 broken 环错误。
await attempt("get in a cycle", () => host.get(Ping, {}, context));
// 获取正常引用，随后用它演示参数边界。
const echo = await host.get(Echo, { id: 1 }, context);

// Arguments are checked against the contract at the object: wrong types and unknown fields are invalid/args.
// @ts-expect-error: text must be a string
await attempt("wrong argument", () => echo.echo({ text: 1 }, context));
// @ts-expect-error: an unknown field
await attempt("unknown field", () => echo.echo({ text: "hi", extra: true }, context));

// Params select the object and are checked on every get: invalid/params.
// @ts-expect-error: id must be an integer
await attempt("bad params", () => host.get(Echo, { id: "one" }, context));

// An implementation with a member its contract does not declare fails activation.
// 触发多余 extra 成员的激活失败，并打印错误。
await attempt("unknown member", () => host.get(Sloppy, { id: 1 }, context));

// A get needs the provider's version and fingerprint; another declaration of the type does not fit. That is not the
// caller's fault (a reload may bring the version): the get waits up to its readyTimeout, then rejects with the cause.
// 用相同名称构造另一个版本的消费者契约；它不替换已发布 v1 提供者。
const EchoV2 = local("example.echo", { version: 2, params: { id: int() }, members: { id: int() } });
// 等待最多约100ms仍无匹配提供者后，get 拒绝并释放自身引用；不是立即把现有对象终结。
await attempt("contract mismatch", () => host.get(EchoV2, { id: 1 }, context, { readyTimeout: 100 }));

// A factory that throws fails broken: the get rejects at once with its error, and no object is left behind.
// 激活 Broken 后立即观察工厂错误；attempt 打印并继续后续示例。
await attempt("throwing factory", () => host.get(Broken, { id: 1 }, context));

// After release, every use of a reference throws released.
// 释放引用后它不能继续调用方法，其他引用不受这一个 release 直接影响。
echo.release();
// 调用已释放引用，展示 released 而非真正执行 echo。
await attempt("released reference", () => echo.echo({ text: "hi" }, context));

// 等待关闭宿主，再演示关闭后的访问。
await host.close(context);
// 关闭后 get 失败；此行打印结果，不重新创建宿主。
await attempt("get after close", () => host.get(Echo, { id: 1 }, context));
