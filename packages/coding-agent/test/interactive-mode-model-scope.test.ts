// 验证模型范围提示放在页头而非直接console.log；只借用原型方法和内存组件，不创建InteractiveMode或启动终端。
// Container是纵向拼接子组件的实际容器，供测试收集页头并渲染成字符串。
import { Container } from "@earendil-works/pi-tui";
// 导入每例初始化、测试分组、断言和spy工具；这些不是产品运行时的配置。
import { beforeEach, describe, expect, it, vi } from "vitest";
// 导入真实类以取得prototype，稍后.call会用假上下文作this，不调用构造函数。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
// 显式初始化全局主题，保证真实提示渲染可取颜色；默认不启用主题文件监听。
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// type描述这两个方法实际会读的最小上下文；不是完整会话，也不会运行时补出缺少的字段。
type ModelScopeContext = {
	// Array<...>是数组类型；每项只有模型id，thinkingLevel?允许缺省，不在这里校验等级是否合法。
	session: { scopedModels: Array<{ model: { id: string }; thinkingLevel?: string }> };
	// getKeys是函数类型：接收动作名、返回字符串数组；这里只约束签名。
	keybindings: { getKeys: (keybinding: string) => string[] };
	// 页头容器保存实际组件，后续render才生成可检查的显示文字。
	headerContainer: Container;
	// 无参数布尔回调代替真实启动设置判断，控制提示是否允许显示。
	shouldShowStartupDetails: () => boolean;
	// 联合类型表示可能返回文字或undefined；后者在真实方法中表示省略提示。
	getModelScopeNotice: () => string | undefined;
};

// 为测试声明两个私有方法的形状，使后续调用有明确类型；这不会修改真实类的访问修饰符。
type InteractiveModePrivate = {
	// this参数只供TS检查.call的接收对象，不是需要额外传入的普通实参。
	getModelScopeNotice(this: ModelScopeContext): string | undefined;
	// 添加页头组件的方法返回void；它不自行验证当前渲染模式确实是fullscreen。
	showFullscreenModelScopeNotice(this: ModelScopeContext): void;
};

// 经unknown双重断言借出私有原型成员；as在运行时消失，不检查方法存在或绑定this。
const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

// 创建每例独立的假上下文，默认展示细节，返回带空页头的对象；例如createContext(false)用于隐藏路径。
// 仅分配内存组件和回调；固定模型/键位用于断言，不读认证、配置或真实会话。
function createContext(showDetails = true): ModelScopeContext {
	// 返回新的对象；下方各属性及函数值共同满足ModelScopeContext。
	return {
		// 放两个范围项：第一个带high后缀，第二个不带等级，便于同时检查两种格式。
		session: { scopedModels: [{ model: { id: "model-a" }, thinkingLevel: "high" }, { model: { id: "model-b" } }] },
		// 假getKeys忽略传入动作，始终返回ctrl+p；因此本例不证明真实键位配置读取正确。
		keybindings: { getKeys: () => ["ctrl+p"] },
		// 新建空容器，避免前一个测试留下的页头影响当前断言。
		headerContainer: new Container(),
		// 箭头函数闭包捕获showDetails，调用时给出本例指定布尔结果。
		shouldShowStartupDetails: () => showDetails,
		// 复制真实函数引用为对象方法，之后以context作this可读取这里的session与keybindings。
		getModelScopeNotice: interactiveModePrototype.getModelScopeNotice,
	};
}

// 去掉本例着色使用的SGR串并返回文字，例如ESC[31mA变A；不覆盖全部ANSI/OSC控制序列。
function stripAnsi(text: string): string {
	// 正则中\x1b表示ESC，\[匹配左方括号，g替换所有数字/分号加m的匹配；不改原字符串。
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// 注册模型范围提示的两条回归；describe回调用于定义测试，不代表启动产品界面。
describe("InteractiveMode model scope notice", () => {
	// 每例设置dark全局主题；首次可能读包内dark/light资源，不读取用户主题目录或启动watch。
	// 颜色编码还会读取终端能力；tmux冷状态可能查询外部tmux，不把主题初始化称作纯函数。
	beforeEach(() => initTheme("dark"));

	// Regression test for #11508: fullscreen must not print the notice to the shell's main screen.
	// 有细节时借用真实页头方法，检查同步调用期间未console.log，并在内存渲染后包含范围与循环提示。
	it("renders the model scope inside the fullscreen header instead of printing it", () => {
		// 使用默认true上下文，两个模型的顺序就是预期显示顺序。
		const context = createContext();
		// spy替换console.log为空函数并记录调用；防止提示被直接写到shell，同时保留恢复句柄。
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		// try/finally确保方法或断言抛错时仍恢复console.log，避免污染别的测试。
		try {
			// .call把context绑定为接收者，真实方法会加ThemedText和Spacer，不会创建实际TUI。
			interactiveModePrototype.showFullscreenModelScopeNotice.call(context);
			// 只检查到此同步调用为止spy没有被调用；下面render已在恢复后，不在这次spy覆盖窗口中。
			expect(log).not.toHaveBeenCalled();
			// finally无论上述断言成功还是失败都会执行；不负责恢复全局主题。
		} finally {
			// 恢复原console.log，而非仅清空调用次数。
			log.mockRestore();
		}

		// 按120列渲染实际子组件、用换行连接再去SGR；这会调用ThemedText保存的构建回调，不写终端。
		const rendered = stripAnsi(context.headerContainer.render(120).join("\n"));
		// toContain只要求包含这段文字，证明两个模型/high后缀和Ctrl+P提示；不约束全部留白或唯一性。
		expect(rendered).toContain("Model scope: model-a:high, model-b (Ctrl+P to cycle)");
	});

	// 隐藏启动细节时应不创建页头占位；这里只检查children为空，不断言console或所有UI都无输出。
	it("adds nothing when startup details are hidden", () => {
		// 显式false不会被默认值true替换；默认参数仅在省略或传undefined时生效。
		const context = createContext(false);
		// 仍调用真实页头方法，由getModelScopeNotice返回undefined触发提前返回。
		interactiveModePrototype.showFullscreenModelScopeNotice.call(context);
		// 零长度意味着既没加提示也没加Spacer；没有启动渲染器，因此不是屏幕截图检查。
		expect(context.headerContainer.children).toHaveLength(0);
	});
});
