// 用内存存储验证临时API key覆盖层；这里的key/token是固定测试文字，不读取真实账号或发起认证。
// import type只导入编译期接口，不因这一行创建凭据存储。
import type { CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

// 登记覆盖层的读取、列举、信号转发和删除行为。
describe("RuntimeCredentials", () => {
	// 无输入；设置临时key后分别读取覆盖层/底层，再移除覆盖。例如runtime-key应遮住stored-key，但底层仍保存旧值；异步失败由Vitest报告。
	test("runtime overrides mask stored credentials without persisting", async () => {
		// inMemory以JSON内存后端初始化，后续读写不会生成auth.json。
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		// 覆盖层只保存底层引用与自己的Map。
		const credentials = new RuntimeCredentials(storage);

		// 临时Map中登记anthropic，未调用底层modify。
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		// await先得到凭据，再按对象结构比较，证明非空覆盖优先。
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		// 直接读底层，证明其值未被这个set操作改写；没有验证磁盘持久化。
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });

		// 只清临时Map，不删除底层条目。
		credentials.removeRuntimeApiKey("anthropic");
		// 之后读取重新落到底层值。
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
	});

	// 无输入；底层有OAuth元数据，再为同名及新增供应商设置覆盖，列举结果只含providerId/type。例如anthropic从oauth显示为api_key且只出现一次，不包含秘密字段。
	test("enumeration merges overrides without exposing keys", async () => {
		// 未来一分钟的expires仅构造OAuth数据，list不会验证token有效性或刷新它。
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		});
		// 新建独立覆盖层，状态不与前例共用。
		const credentials = new RuntimeCredentials(storage);
		// 覆盖已有供应商的列表类型。
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		// 新供应商会追加到列表中。
		credentials.setRuntimeApiKey("openai", "other-runtime-key");

		// 深比较完整结果，不只是检查两个名字存在；固定样本中不得额外携带key/access/refresh。
		expect(await credentials.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});

	// 无输入；手写CredentialStore记录各操作收到的signal，再依次调用四入口。例如每次应是同一个controller.signal；这里只测转发，未abort控制器或验证真实取消。
	test("forwards operation signals to the persistent store", async () => {
		// 控制器可产生取消信号；本例保持未取消状态。
		const controller = new AbortController();
		// AbortSignal[]约束数组元素；运行时仍是普通可变数组。
		const received: AbortSignal[] = [];
		// 接口让TypeScript检查方法形状，不自动赋予存储锁或持久化能力。
		const storage: CredentialStore = {
			// read接供应商和可选选项；下划线仅表示这里不使用该参数。
			read: async (_providerId, options) => {
				// ?.允许缺选项；as仅作断言，若真的缺signal仍会push undefined。
				received.push(options?.signal as AbortSignal);
				// 假存储始终表示没有凭据。
				return undefined;
			},
			// list只需options，记录后返回空元信息数组。
			list: async (options) => {
				// 保存收到的同一信号引用，便于末尾比较。
				received.push(options?.signal as AbortSignal);
				// async自动把空数组包装成Promise结果。
				return [];
			},
			// modify接变换函数，但本例不调用它，因此不测试变换或互斥语义。
			modify: async (_providerId, _fn, options) => {
				// 仅观察第三个位置的操作选项。
				received.push(options?.signal as AbortSignal);
				// 固定无结果，不修改任何状态。
				return undefined;
			},
			// delete的Promise没有结果值，只记录信号。
			delete: async (_providerId, options) => {
				// 此假删除不触盘、不删真实账户。
				received.push(options?.signal as AbortSignal);
			},
		};
		// 将这份四方法替身交给覆盖层。
		const credentials = new RuntimeCredentials(storage);

		// 无覆盖时read会委托底层，因此记录一次。
		await credentials.read("anthropic", { signal: controller.signal });
		// list先委托底层，随后才合并覆盖项。
		await credentials.list({ signal: controller.signal });
		// async回调声明不变更凭据；本桩没有实际执行它。
		await credentials.modify("anthropic", async () => undefined, { signal: controller.signal });
		// 删除先转发成功，覆盖层才清Map。
		await credentials.delete("anthropic", { signal: controller.signal });

		// 顺序与长度也在比较内，证明四入口都转发了信号。
		expect(received).toEqual([controller.signal, controller.signal, controller.signal, controller.signal]);
	});

	// 无输入；让底层delete拒绝一个名叫AbortError的Error，确认覆盖未提前丢弃。例如删除失败后仍读runtime-key；没有真正触发AbortSignal取消。
	test("keeps a runtime override when persistent deletion is cancelled", async () => {
		// 构造可按对象身份断言的异常。
		const aborted = new Error("cancelled");
		// 改name模拟取消错误分类，不会取消任何控制器。
		aborted.name = "AbortError";
		// 底层使用固定内存凭据。
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		// spy仅下一次调用拒绝；没有走底层原删除函数。
		const deleteSpy = vi.spyOn(storage, "delete").mockRejectedValueOnce(aborted);
		// 包装桩所在的底层对象。
		const credentials = new RuntimeCredentials(storage);
		// 先提供覆盖，才能观察失败后是否保留。
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		// signal仍未取消；rejects.toBe要求原异常对象原样传播，不只是同文案。
		await expect(credentials.delete("anthropic", { signal: new AbortController().signal })).rejects.toBe(aborted);
		// 正好调用底层一次，没有隐式重试。
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		// await失败后读取仍得到覆盖值。
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
	});

	// 无输入；成功删除应先清底层再清覆盖。例如删除anthropic后read无值且list为空；两者皆为本测试自建的内存状态。
	test("delete clears both the override and persisted credential", async () => {
		// 预置一条内存持久层记录；“persisted”在此不指真实磁盘文件。
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		// 新建覆盖容器。
		const credentials = new RuntimeCredentials(storage);
		// 为同供应商加临时值，确保两层都要清。
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		// 等待底层异步删除完成，覆盖层随后删除Map项。
		await credentials.delete("anthropic");

		// 无覆盖且无底层记录，读取结果才是undefined。
		expect(await credentials.read("anthropic")).toBeUndefined();
		// 元信息列表也不再出现该供应商。
		expect(await credentials.list()).toEqual([]);
	});
});
