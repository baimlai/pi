// 问题 #3686：核对会话显示名的保存和通知；使用内存会话与本地扩展，不调用模型。
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// 注册问题 #3686 的会话命名回归用例；测试直接 API 与扩展 API 是否产生一致的最终名称和通知。
describe("regression #3686: session name changes emit an event", () => {
	// 保存本组创建的测试环境；Harness[] 是元素类型为 Harness 的数组，清理时逐一释放临时目录和 faux 注册。
	const harnesses: Harness[] = [];

	// 每个用例结束后执行清理回调；无参数、无业务返回值，断言失败时 Vitest 也会安排它运行。
	afterEach(() => {
		// 只要还有测试环境，就从尾部取出一个，避免 faux 供应商和会话订阅泄漏到下一例。
		while (harnesses.length > 0) {
			// pop 取出并移除最后一项；?. 在数组意外为空时跳过，cleanup 释放会话、注销 faux 并删本环境临时目录。
			harnesses.pop()?.cleanup();
		}
	});

	// 无参数异步用例：从标题指定入口设置名称，检查保存结果及事件顺序；例如 hello world 应出现在 manager 和公开通知中。
	it("emits session_info_changed when AgentSession.setSessionName is called", async () => {
		// 等待创建内存会话、假认证和 faux 模型；工具响应来自本地脚本，不请求真实供应商。
		const harness = await createHarness();
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);

		// 直接改会话显示名；此调用同步追加 session_info 并发公开事件，不改变会话 id。
		harness.session.setSessionName("hello world");

		// 读取 manager 最终保存的名称并精确比较；这是运行时断言，不是 TypeScript 静态类型检查。
		expect(harness.sessionManager.getSessionName()).toBe("hello world");
		// 筛选 session_info_changed 事件并取 name；toEqual 要求数组长度、顺序和值全部相同。
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["hello world"]);
	});

	// 无参数异步用例：从标题指定入口设置名称，检查保存结果及事件顺序；例如 hello world 应出现在 manager 和公开通知中。
	it("emits session_info_changed when an extension calls pi.setSessionName", async () => {
		// 联合类型表示 API 尚未捕获；TypeScript 要求访问前处理 undefined，但不会在运行时自动赋值。
		let api: ExtensionAPI | undefined;
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 提供内联扩展工厂数组，harness 会加载这些函数并绑定到本次会话。
			extensionFactories: [
				// 扩展工厂接收本次 ExtensionAPI；只注册或保存 API，工厂本身不是模型回复。
				(pi) => {
					// 把初始化时收到的扩展 API 留给用例稍后调用，闭包共享外层变量。
					api = pi;
				},
			],
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);

		// 可选调用捕获的扩展 API；若未捕获会跳过，但后续保存值/事件断言仍会失败，不会把缺失 API 误判成功。
		api?.setSessionName("from extension");

		// 读取 manager 最终保存的名称并精确比较；这是运行时断言，不是 TypeScript 静态类型检查。
		expect(harness.sessionManager.getSessionName()).toBe("from extension");
		// 筛选 session_info_changed 事件并取 name；toEqual 要求数组长度、顺序和值全部相同。
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["from extension"]);
	});

	// 无参数异步用例：从标题指定入口设置名称，检查保存结果及事件顺序；例如 hello world 应出现在 manager 和公开通知中。
	it("emits session_info_changed to extensions", async () => {
		// 联合类型表示 API 尚未捕获；TypeScript 要求访问前处理 undefined，但不会在运行时自动赋值。
		let api: ExtensionAPI | undefined;
		// 记录扩展收到的名称；Array<...> 表示对象数组，name 必须存在但值允许 undefined。
		const events: Array<{ name: string | undefined }> = [];
		// 异步创建配置化测试环境；下面选项决定扩展、工具或重试设置，await 等初始化完成。
		const harness = await createHarness({
			// 提供内联扩展工厂数组，harness 会加载这些函数并绑定到本次会话。
			extensionFactories: [
				// 扩展工厂接收本次 ExtensionAPI；只注册或保存 API，工厂本身不是模型回复。
				(pi) => {
					// 把初始化时收到的扩展 API 留给用例稍后调用，闭包共享外层变量。
					api = pi;
					// 注册扩展通知回调，输入为命名事件；将 name 复制到记录数组，无返回和外部 I/O。
					pi.on("session_info_changed", (event) => {
						// 只记录本次事件名称，用两个相继命名值观察扩展接收顺序。
						events.push({ name: event.name });
					});
				},
			],
		});
		// 把已创建环境登记到清理数组；这不复制环境对象，后面操作和清理使用同一实例。
		harnesses.push(harness);

		// 可选调用捕获的扩展 API；若未捕获会跳过，但后续保存值/事件断言仍会失败，不会把缺失 API 误判成功。
		api?.setSessionName("first");
		// 直接改会话显示名；此调用同步追加 session_info 并发公开事件，不改变会话 id。
		harness.session.setSessionName("second");

		// 要求扩展先收到 first 再收到 second；不把该同步处理器测试扩大为所有异步扩展完成保证。
		expect(events).toEqual([{ name: "first" }, { name: "second" }]);
	});
});
