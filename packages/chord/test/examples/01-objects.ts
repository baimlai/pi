// Objects on one host: a contract, a facet serving it, references, calls, and how long objects live.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/01-objects.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { int, local, method, obj, str } from "../../src/contracts/index.ts";
import { isChordError } from "../../src/data/index.ts";
import { createHost, defineFacet } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

// Every call takes a context, used for cancellation; BACKGROUND_CONTEXT is never cancelled.
// 本例把同一个后台上下文传给异步操作；它没有取消信号，错误仍可由 Promise 拒绝传回。
const context = BACKGROUND_CONTEXT;

// A contract declares what an object type offers: state members (schemas) and methods (arguments, result).
// `params` select the instance: one object per params value.
// 声明仅能在当前宿主访问的对象契约；language 参数参与实例身份，而同名状态成员供调用者读取。
const Greeter = local("example.greeter", {
	// 契约版本参与绑定匹配；结构改变也需要升级版本，TypeScript 类型本身不会跨进程校验。
	version: 1,
	// str() 构造字符串 schema；运行时获取实例时会校验参数，而不是把值自动转成字符串。
	params: { language: str() },
	// greet 接收闭合对象 {name: string} 并声明字符串结果；提供者检查参数，结果不会再次按 schema 校验。
	members: { language: str(), greet: method(obj({ name: str() }), str()) },
});
// Empty params: one object for the whole host.
// 空参数的 local 类型随宿主存活；started 是毫秒时间戳状态，int() 声明整数。
const Clock = local("example.clock", { version: 1, params: {}, members: { started: int() } });

// A facet is a plugin's setup for one host. It serves types with factories; a factory only declares and returns the
// implementation: a watchable per state member, an async function per method.
// 此 setup 回调接收声明接口 host，返回 void；load 时登记两个工厂，尚不在这里调用 greet。
// 工厂由 Chord 在激活时运行；示例会打印创建顺序，真实应用工厂应只声明。
const facet = defineFacet((host) => {
	// Clock 工厂无须使用参数，返回 started 的可观察实现；激活时日志和 Date.now() 是本例实际副作用。
	host.serve(Clock, () => {
		// 让读者看到空参数对象在首次 load 期间就创建。
		console.log("clock: created at load");
		// 读取当前时间并包装为不会变化的 watchable；返回实现对象，不是契约或普通数字。
		return { started: constant(Date.now()) };
	});
	// Greeter 工厂解构参数里的 language；同参数的引用共享这个实例，最后引用释放后实例结束。
	host.serve(Greeter, ({ language }) => {
		// 模板字符串插入语言值，打印首次按需创建的时刻。
		console.log(`greeter ${language}: created by its first get`);
		return {
			// 暴露固定的语言状态；对象属性简写以外，这里显式把名称映射到 watchable。
			language: constant(language),
			// 异步方法解构 name，用三元表达式选择德语或英语并返回 Promise<string>；例如 Mario 得到 Hallo Mario。
			// 方法没有自定义错误处理，参数不匹配由调用入口拒绝；省略未使用的 ctx 不表示调用者可以不传上下文。
			greet: async ({ name }) => (language === "de" ? `Hallo ${name}` : `Hello ${name}`),
		};
	});
});

// onError receives background errors, such as a watch listener that throws.
// 创建本例宿主；onError 回调只把后台错误写到 stderr，不会吞掉直接调用返回的拒绝。
const host = createHost({ onError: (error) => console.error("background error:", error) });
// load runs every setup and activates the types with empty params before it resolves.
// 等待声明发布和宿主生命周期对象的首次结果；load 成功返回并不保证所有对象都激活成功。
await host.load([{ name: "@example/greeter", facet }], context);

// A reference is live once its get resolves: its state members have values, its methods can be called.
// 等待德语实例 live 且状态已准备好；超时、取消或 broken 错误可使 get 拒绝。
const german = await host.get(Greeter, { language: "de" }, context);
// 同步读取状态成员的当前值，本例打印 de。
console.log("language:", german.language.value);
// 传正确参数并等待方法结果，再把问候输出到终端。
console.log("greet:", await german.greet({ name: "Mario" }, context));

// Arguments are checked against the contract at the object.
// try/catch 展示预期失败；catch 变量可能是任意抛出值，不能直接假定它有 code。
try {
	// @ts-expect-error: `name` must be a string
	await german.greet({ name: 42 }, context);
} catch (error) {
	// 运行时识别 Chord 的 invalid 错误后打印原因；name:42 的静态错误被下一行指令故意允许，以展示运行时校验。
	if (isChordError(error, "invalid")) console.log("refused:", error.reason, error.message);
}

// The same params share one object; releasing the last reference ends it.
// 再次获取相同参数，只增加一个引用，不重新运行工厂。
const again = await host.get(Greeter, { language: "de" }, context);
// 释放第一个引用；again 尚持有对象，因此实例继续存在。
german.release();
// 最后引用释放使有参数的 Greeter 结束；Clock 仍由宿主生命周期保活。
again.release();
// try/catch 展示预期失败；catch 变量可能是任意抛出值，不能直接假定它有 code。
try {
	// 故意访问已释放引用，触发 released；这不是重新获取对象。
	german.language.value;
} catch (error) {
	// 只在错误确实是 released 时展示消息。
	if (isChordError(error, "released")) console.log("after release:", error.message);
}

// close ends every object.
// 等待宿主结束所有对象与资源；关闭错误仍会使顶层 await 拒绝。
await host.close(context);
