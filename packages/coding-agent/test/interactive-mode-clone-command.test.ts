// 用原型方法和固定fork替身检查/clone分派，不真的创建新会话或写文件；两例覆盖有叶子成功与无叶子早退。
// Vitest注册异步测试、做断言并以vi.fn记录调用；不会因测试名写着clones就自动执行真实克隆。
import { describe, expect, it, vi } from "vitest";
// 导入真实类以借prototype，后面没有调用构造函数或启动交互界面。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// type列出测试接收者的最小能力；不是完整InteractiveMode，不会在运行时补齐字段。
type CloneCommandContext = {
	// getLeafId无参数，返回当前条目id或null；null代表还没有可克隆叶子，不是字符串null。
	sessionManager: { getLeafId: () => string | null };
	// runtimeHost能力由下面fork函数签名约束，实际测试用spy替代。
	runtimeHost: {
		// fork接id及可选options，position?可省且限定before/at；Promise结果的cancelled为必有布尔字段。
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
	// 记录UI重建入口，本测试要求成功路径不在这里再显式调用它。
	renderCurrentSessionState: () => void;
	// 编辑器setText用于成功后清输入；替身只记录文字，不模拟真实编辑器状态。
	editor: { setText: (text: string) => void };
	// 状态提示接文字，下面检查成功或无内容文案。
	showStatus: (message: string) => void;
	// 错误提示接文字，正常两个样本都不应调用。
	showError: (message: string) => void;
	// 重绘入口只记录请求，测试不创建终端渲染器。
	ui: { requestRender: () => void };
};

// 为私有方法建立测试侧类型视图，只含本文件要调用的成员。
type InteractiveModePrototype = {
	// this参数只约束.call绑定对象，不占普通实参；方法返回Promise<void>供测试await。
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

// 经unknown双重断言取得私有原型成员；as不检查存在、不绑定this，也不改变真实类访问规则。
const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

// 注册两条/clone命令回归；这里检验UI委托，不覆盖真实RuntimeHost分叉、落盘、取消和异常。
describe("InteractiveMode /clone", () => {
	// 有leaf-123时应以position:at委托fork，成功后清输入并提示；只观察假对象调用。
	it("clones the current leaf into a new session", async () => {
		// async替身每次兑现新cancelled:false对象，表示此次假分叉成功，不执行文件复制或会话切换。
		const fork = vi.fn(async () => ({ cancelled: false }));
		// 记录是否重复请求当前会话UI重建。
		const renderCurrentSessionState = vi.fn();
		// 记录输入文本设置，下面应收到空串。
		const setText = vi.fn();
		// 记录状态文案，未真的画聊天消息。
		const showStatus = vi.fn();
		// 记录错误文案，成功样本应保持未调用。
		const showError = vi.fn();
		// 记录UI重绘请求，成功路径不应由这层额外发起。
		const requestRender = vi.fn();

		// 显式类型检查下面假上下文形状，运行时仍是普通对象。
		const context: CloneCommandContext = {
			// 叶子查询固定返回leaf-123，不读取真实SessionManager或磁盘。
			sessionManager: { getLeafId: () => "leaf-123" },
			// 属性简写把上面的fork spy放入假runtimeHost。
			runtimeHost: { fork },
			// 同名属性简写保留这份UI重建spy引用。
			renderCurrentSessionState,
			// editor对象里setText也使用属性简写，不在这里调用。
			editor: { setText },
			// 把状态spy作为上下文方法，之后通过this.showStatus调用。
			showStatus,
			// 把错误spy放入接收对象，供真实catch路径使用。
			showError,
			// 重绘spy放在ui下一层，匹配真实代码的访问路径。
			ui: { requestRender },
		};

		// .call以context作this；await等待真实命令方法和假fork Promise，不运行真实RuntimeHost。
		await interactiveModePrototype.handleCloneCommand.call(context);

		// 要求至少一次fork收到当前叶子和at选项，at表示克隆范围包含目标条目；不单独检查总调用次数。
		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		// 要求本层不额外调用UI重建spy；不能据此声称真实RuntimeHost从不重绑或重绘。
		expect(renderCurrentSessionState).not.toHaveBeenCalled();
		// 要求成功后向编辑器传空串；没有真实编辑器供检查最终光标/文字。
		expect(setText).toHaveBeenCalledWith("");
		// 至少一次显示固定成功提示，不证明实际新会话文件存在。
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		// 成功样本没有调用错误提示。
		expect(showError).not.toHaveBeenCalled();
		// 没有调用本层重绘spy；此处不是全系统渲染次数断言。
		expect(requestRender).not.toHaveBeenCalled();
	});

	// getLeafId为null时只提示没有内容，并在调用fork之前返回；未覆盖空字符串或异常。
	it("shows a status message when there is nothing to clone", async () => {
		// 准备可正常兑现的fork spy，但无叶子路径不应使用它。
		const fork = vi.fn(async () => ({ cancelled: false }));
		// 本例独立状态spy，避免继承上例调用记录。
		const showStatus = vi.fn();
		// 本例独立错误spy。
		const showError = vi.fn();

		// 新建无叶子的完整最小上下文，不复用上例状态。
		const context: CloneCommandContext = {
			// null使真实方法的!leafId门禁成立；不创建空会话文件。
			sessionManager: { getLeafId: () => null },
			// 挂上fork spy以便下面确认其完全未调用。
			runtimeHost: { fork },
			// 仍提供UI重建替身，但本例没有单独检查这个spy。
			renderCurrentSessionState: vi.fn(),
			// 文本替身也保留在上下文，本例只断言状态/错误/fork。
			editor: { setText: vi.fn() },
			// 属性简写挂本例状态记录器。
			showStatus,
			// 属性简写挂本例错误记录器。
			showError,
			// 重绘替身只补齐上下文形状，没有实际TUI。
			ui: { requestRender: vi.fn() },
		};

		// 等待真实async方法的无叶子早返；async即使没有走await也仍返回Promise。
		await interactiveModePrototype.handleCloneCommand.call(context);

		// 关键断言是没有委托fork，不能把这例算作真实克隆测试。
		expect(fork).not.toHaveBeenCalled();
		// 要求至少一次提示Nothing to clone yet，未限定提示调用恰一次。
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		// 该无内容情况是状态提示，不调用错误入口。
		expect(showError).not.toHaveBeenCalled();
	});
});
