// 自定义消息渲染器收到的留白选项应随组件更新；只在内存里生成显示行，不启动终端。
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Vitest 分组回调注册一个同步测试，没有真实扩展加载或模型请求。
describe("CustomMessageComponent", () => {
	// 构造时留白为 1，再改成 0，同时检查传给回调的参数和实际文字前缀。
	test("provides output padding to custom renderers and updates it", () => {
		// 初始化全局主题以便组件可读取样式；这里选内置 dark，不探测用户终端颜色。
		initTheme("dark");
		// MessageRenderOptions[] 约束数组元素形状；空数组稍后由 renderer 回调填充。
		const optionsSeen: MessageRenderOptions[] = [];
		// MessageRenderer 指定参数/返回组件类型；_message 表示本例有意不用消息参数。
		// 这个回调接收当前选项，记录原对象引用并返回 Text；例：outputPad=1 时文字左右按一列留白。
		const renderer: MessageRenderer = (_message, options) => {
			// push 会修改外层捕获的数组，方便断言渲染器收到过什么。
			optionsSeen.push(options);
			// 第二参数是水平留白，第三参数是垂直留白；不依赖组件替扩展自动添加水平空格。
			return new Text("custom", options.outputPad, 0);
		};
		// 手工消息夹具；CustomMessage 只是 TS 类型，不在这里做运行时校验。
		const message: CustomMessage = {
			// role 让消息进入自定义消息联合分支，customType 区分扩展自己的消息类别。
			role: "custom",
			customType: "test",
			content: "custom",
			// 表达应显示的消息；本例直接建组件，没有测试上层按 display 过滤的逻辑。
			display: true,
			// 当前毫秒时间只满足消息结构，下面没有关于时间的断言。
			timestamp: Date.now(),
		};
		// 显式 undefined 使第三参数采用默认 Markdown 主题，第四参数设初始留白；构造时同步调用 renderer。
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		// toMatchObject 只核对列出的字段，不要求选项对象没有 keyText/keyHint 等其他字段。
		expect(optionsSeen).toMatchObject([{ expanded: false, outputPad: 1 }]);
		// 链式调用先生成 40 列内的行，再去 ANSI，最后检查是否至少一行有目标前缀。
		expect(
			component
				// render 返回行数组，不向屏幕输出。
				.render(40)
				// map 为每一行调用 stripAnsi，返回新的纯文字数组。
				.map(stripAnsi)
				// 箭头回调为真时 some 提前结束；这里不是完整行快照比较。
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		// 新旧留白不同触发重建，因此 renderer 再次被调用。
		component.setOutputPad(0);

		// at(-1) 取最后一项，核对最新回调参数，不要求总共恰好两次调用。
		expect(optionsSeen.at(-1)).toMatchObject({ expanded: false, outputPad: 0 });
		// 重新渲染验证不再有左侧空格；仍只证明存在一条相应前缀的行。
		expect(
			component
				// 仍以相同宽度渲染，排除宽度变化造成结果不同。
				.render(40)
				// 去除主题控制序列后再比较可见文本。
				.map(stripAnsi)
				// 只接受从行首立即开始的 custom。
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});
