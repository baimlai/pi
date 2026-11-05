// 用两个手动兑现的Promise模拟启动重绑与替换会话重绑重叠，验证旧bind返回后不重复订阅；不构造Agent、真实终端或模型。
// Vitest注册用例并提供调用计数替身，时间顺序由resolve显式控制而不是靠sleep猜测。
import { describe, expect, it, vi } from "vitest";
// 导入类只为取得原型真实方法，后面不调用构造器/启动TUI。
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// 最小接收者类型描述这条重绑路径所需字段；类型声明不生成会话或方法实现。
type RebindContext = {
	// session只需作为可比较的对象身份，夹具不提供真实会话API。
	session: object;
	// 可选unsubscribe回调，本例没有赋它，不据此验证真实旧订阅如何清理。
	unsubscribe?: () => void;
	// 应用设置方法在夹具中是空函数，避免真的读配置或准备外部工具。
	applyRuntimeSettings: () => void;
	// programStatus含无返回reset方法，在本例也只是空实现。
	programStatus: { reset(): void };
	// 会话画面重建是同步无返回函数契约，夹具不真的绘图。
	renderCurrentSessionState: () => void;
	// 扩展绑定返回Promise，用于插入两次可控等待。
	bindCurrentSessionExtensions: () => Promise<void>;
	// 订阅方法是同步动作，本例只记调用次数，不建立真实事件监听。
	subscribeToAgent: () => void;
	// 计数更新在夹具中返回Promise以保留被测await边界；真实实现的具体同步/异步工作不在这里验证。
	updateAvailableProviderCount: () => Promise<void>;
	// 边框更新仅声明无返回动作。
	updateEditorBorderColor: () => void;
	// 标题更新也只需可记录是否调用，不操作真实窗口。
	updateTerminalTitle: () => void;
};

// 给私有原型方法声明一个测试用可调用视图，不修改类的正式可见性。
type InteractiveModePrototype = {
	// this是擦除的接收者参数；options?可省，renderBeforeBind?布尔控制提前绘图/订阅，Promise<void>描述完成时没有业务值。
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

// 先as unknown再断言最小接口，跨过private/结构兼容限制；运行时仍是同一个原型对象，不复制或创建实例。
const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

// 只注册一项重叠顺序回归，不能据此断言所有异步会话切换都无竞态。
describe("overlapping startup and replacement session rebinds", () => {
	// 流程先挂起启动bind→替换会话并提前订阅→旧bind兑现不订阅→新bind兑现更新标题；所有context能力都是内存替身。
	it("does not subscribe from the stale startup rebind", async () => {
		// 空对象用作第一会话身份标记，不模拟它的内部状态。
		const startupSession = {};
		// 第二个独立空对象引用不同，允许真实方法用===判断会话是否被替换。
		const replacementSession = {};
		// 声明函数变量，!是确定赋值断言，不在运行时自动赋resolve；下面Promise executor同步赋值后才使用。
		let resolveStartupBind!: () => void;
		// 第二个resolve槽控制替换会话的绑定等待，与第一槽互不替代。
		let resolveReplacementBind!: () => void;

		// new Promise立即运行executor，把兑现函数保存出来；尚未调用resolve所以Promise保持pending。
		const startupBind = new Promise<void>((resolve) => {
			// 保存第一条兑现回调，返回值不需要数据，因此泛型void。
			resolveStartupBind = resolve;
		});
		// 再创建第二条独立Promise，不是复用startupBind。
		const replacementBind = new Promise<void>((resolve) => {
			// 保存第二条兑现回调，稍后单独推进新会话。
			resolveReplacementBind = resolve;
		});

		// 订阅替身仅记调用，不设置context.unsubscribe或连接真实Agent。
		const subscribeToAgent = vi.fn();
		// 标题替身只记次数，不写终端标题控制串。
		const updateTerminalTitle = vi.fn();
		// 可变bindCount决定两次绑定各等待哪一条Promise。
		let bindCount = 0;

		// 构造假this对象，字段名与原方法访问保持一致，TS检查该最小契约。
		const context: RebindContext = {
			// 初始session指向startupSession引用，不深克隆。
			session: startupSession,
			// 空设置更新实现避免读取用户配置。
			applyRuntimeSettings: () => {},
			// 空状态reset用于满足被测调用，未测试真实状态报告。
			programStatus: { reset: () => {} },
			// 空画面恢复实现允许renderBeforeBind路径走过但不绘制。
			renderCurrentSessionState: () => {},
			// 绑定替身按调用次数给出可控Promise，本身不加载扩展。
			bindCurrentSessionExtensions: () => {
				// 每次调用先递增计数，await挂起前已能同步观察到。
				bindCount += 1;
				// 三元只选第一或第二Promise；超过两次仍返回第二条，本例只触发两次。
				return bindCount === 1 ? startupBind : replacementBind;
			},
			// 属性简写放入前面建立的同一个订阅记录器。
			subscribeToAgent,
			// 空async函数给立即兑现为undefined的Promise，保留await后的微任务切换。
			updateAvailableProviderCount: async () => {},
			// 空边框回调，不调用主题或编辑器。
			updateEditorBorderColor: () => {},
			// 属性简写传标题记录器，后面直接断言它的次数。
			updateTerminalTitle,
		};

		// 用.call把假context绑定为this，真实重绑方法在第一个await暂停，返回尚未完成的Promise。
		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		// 此时首次bind已经被调用一次，尚未订阅，因为没要求提前render。
		expect(bindCount).toBe(1);

		// 在旧bind仍挂起时改同一context.session引用，模拟运行时换会话。
		context.session = replacementSession;
		// 对同一context再跑真实方法，启动第二次重绑；不await，保留它也挂起的状态。
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			// renderBeforeBind:true使第二次在等待绑定之前就渲染并订阅。
			renderBeforeBind: true,
		});

		// 两次绑定已同步进入，说明旧新两条异步流程确实重叠。
		expect(bindCount).toBe(2);
		// 订阅应只有第二次提前订阅产生的1次。
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		// 手动兑现旧bind，只推进旧流程的await之后部分。
		resolveStartupBind();
		// 等待旧重绑结束，真实方法看到session身份已变应早退。
		await startupRebind;

		// 旧流程恢复后订阅仍为1，检查没有补出第二次旧订阅。
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		// 旧流程不能继续更新标题；并未测试后续计数await期间再次换会话的情况。
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		// 再兑现新会话绑定，允许新流程继续。
		resolveReplacementBind();
		// 等待新重绑完成，包括它的计数更新await。
		await replacementRebind;

		// 新流程已提前订阅，不应在bind后再订阅一次。
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		// 最终标题只更新一次，来自当前替换会话流程；不证明真实标题文字或终端输出。
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
