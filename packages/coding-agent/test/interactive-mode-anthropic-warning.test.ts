// 用原型方法和固定认证替身检查Anthropic订阅费用警告的门禁与顺序，不构造真实运行时、不读凭据或刷新令牌、不发网络请求。
// vi.fn记录调用；每条async test由Vitest等待，假sk-ant-oat字符串只测试前缀启发式，不是有效密钥或真实账户证明。
import { describe, expect, test, vi } from "vitest";
// 导入类取得私有prototype方法，后面用any绕过测试侧可见性；as不创建真实InteractiveMode，也不执行构造器。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// 创建只提供getWarnings的设置替身，输入可省的警告对象、返回新包装对象；例传{anthropicExtraUsage:false}关闭提示，不读写设置文件。
function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	// 返回普通对象，warnings引用由闭包/记录器保留，没有深拷贝或freeze。
	return {
		// mockReturnValue让每次调用同步返回同一warnings对象，并记录调用，不执行真实设置加载。
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

// 创建仅含checkAuth/getAuth的运行时替身，接固定oauth分类或undefined与可选key，返回两项Promise记录器；不调用真实认证API。
// 例credential为oauth时可在第一分支直接提示；getAuth未配置key时只会兑现undefined，不会按名字去刷新或抛刷新失败。
function createModelRuntime(credential: { type: "oauth" } | undefined, apiKey?: string) {
	// 新普通对象满足本用例访问的成员，不是ModelRuntime实例。
	return {
		// mockResolvedValue每次返回兑现固定credential的Promise并记录，undefined也作为正常兑现值。
		checkAuth: vi.fn().mockResolvedValue(credential),
		// key有真值才构造{auth:{apiKey}}，否则兑现undefined；属性简写保留原key，空串也走缺失分支，不读取环境变量。
		getAuth: vi.fn().mockResolvedValue(apiKey ? { auth: { apiKey } } : undefined),
	};
}

// 四例覆盖先后两次提示、已存oauth直达、不相关provider、显式关闭；不测试并发去重、真实token刷新或完整警告文字。
describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	// 顺序调用两次，第一次凭key前缀提示并置已提示，第二次早退；只核showWarning/getAuth次数，不证明并发调用也只提示一次。
	test("warns once when Anthropic subscription auth is detected", async () => {
		// checkAuth固定undefined迫使真实方法再查getAuth，假key命中sk-ant-oat前缀，无真实认证材料。
		const modelRuntime = createModelRuntime(undefined, "sk-ant-oat01-test");
		// any保留原测试的最小假this，放宽成员/类型检查但不做运行时补全，不是生产类型示范。
		const fakeThis: any = {
			// 初始尚未提示；真实方法成功判断后会修改这个字段。
			anthropicSubscriptionWarningShown: false,
			// 缺省空警告对象表示未显式false，因此允许提示。
			settingsManager: createSettingsManager(),
			// 假session仅挂前面这份运行时替身，没有真实会话或模型默认值。
			session: { modelRuntime },
			// showWarning只记录调用，不构造警告组件或访问主题。
			showWarning: vi.fn(),
		};

		// any绕过私有成员限制，.call绑定fakeThis；await等待真实async判断方法及其mock认证Promise。
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			// 显式传最小模型provider，避免默认参数读取fake session.model；并未构造完整Model。
			provider: "anthropic",
		});
		// 第一次await完成后再次调用同一接收者，覆盖的是顺序重复而非两次并发。
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			// 第二次仍明确Anthropic供应商。
			provider: "anthropic",
		});

		// 要求警告记录器累计只一次，未核警告文案参数或真实显示。
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		// getAuth也只一次，说明第二次在已提示门禁返回，没有再次查询key；未直接断言checkAuth次数。
		expect(modelRuntime.getAuth).toHaveBeenCalledTimes(1);
	});

	// 标题提到刷新失败，但本例没有让任何Promise拒绝：实际检查已存oauth分类可直接警告，并完全绕过getAuth/token刷新路径。
	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		// checkAuth兑现oauth最小对象，getAuth默认兑现undefined但不应被调用，不代表运行过失败刷新。
		const modelRuntime = createModelRuntime({ type: "oauth" });
		// any假接收者只放真实方法所需能力。
		const fakeThis: any = {
			// 初始未提示，允许这次oauth分支。
			anthropicSubscriptionWarningShown: false,
			// 警告开关缺省不禁用。
			settingsManager: createSettingsManager(),
			// 会话替身只提供认证记录器。
			session: { modelRuntime },
			// 警告替身仅记录次数，无真实UI输出。
			showWarning: vi.fn(),
		};

		// 绑定假this并等待真实方法走oauth分支，未执行真实ModelRuntime.checkAuth。
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			// 只传provider字段，任何模型价格/窗口信息都不参与判断。
			provider: "anthropic",
		});

		// 应显示一次警告；不检查令牌有效性、账户额度或实际费用。
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		// 关键断言是getAuth从未调用，证明该路径不需要先解析/刷新token；不是检测刷新异常被catch。
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	// 非Anthropic供应商应在认证查询前早退；本例观察警告和getAuth均未调用，不直接断言checkAuth。
	test("does not warn for non-Anthropic models", async () => {
		// 两项认证替身都可正常兑现undefined，不故意抛异常。
		const modelRuntime = createModelRuntime(undefined);
		// 构造本例独立的any接收者。
		const fakeThis: any = {
			// 已提示标志为false，确保早退并非重复提示门禁。
			anthropicSubscriptionWarningShown: false,
			// 警告设置缺省允许，排除开关导致的早退。
			settingsManager: createSettingsManager(),
			// 固定认证替身，无真实凭据存储。
			session: { modelRuntime },
			// 只记录警告调用。
			showWarning: vi.fn(),
		};

		// 调用真实判断方法并等待，实际不会走到getAuth。
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			// provider改openai，触发精确供应商判断，不是按模型名猜类型。
			provider: "openai",
		});

		// 警告记录器保持0次。
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		// key解析记录器保持0次；本例没有额外检查checkAuth记录。
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	// 显式关闭Anthropic费用提示时，应在供应商/认证查询前返回；检查警告和两个认证记录器全未调用。
	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		// 准备可调用但应被门禁跳过的认证替身。
		const modelRuntime = createModelRuntime(undefined);
		// 独立any假接收者，不继承上例已提示状态。
		const fakeThis: any = {
			// 初始false，避免把不提示误归因于旧标志。
			anthropicSubscriptionWarningShown: false,
			// 显式anthropicExtraUsage:false与缺省undefined不同，真正触发设置早退。
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			// 挂固定runtime替身，方法不应调用它。
			session: { modelRuntime },
			// 警告输出仍仅记录器。
			showWarning: vi.fn(),
		};

		// 等待真实async方法完成早退，await不代表发生了网络或IO。
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			// 仍传Anthropic，确保不开警告来自设置而非不相关供应商。
			provider: "anthropic",
		});

		// 关闭时没有警告调用。
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		// 连配置分类查询checkAuth也应跳过，不仅是跳getAuth。
		expect(modelRuntime.checkAuth).not.toHaveBeenCalled();
		// 实际key解析getAuth也未调用。
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});
});
