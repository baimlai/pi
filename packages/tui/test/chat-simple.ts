// 手工聊天界面示例：把真实终端、主屏 TUI、编辑器、Markdown 消息与加载动画组合起来；“回复”只从固定数组随机选择，不调用模型。
// 这个文件在模块顶层构造对象并最终 start，直接运行会接管 stdin/stdout，路径补全可列当前目录；它不是 node:test 用例，也没有统一的资源清理流程。
/**
 * Simple chat interface demo using tui.ts
 */

// Chalk 默认实例提供 cyan/dim 等可链式着色函数，返回带样式的字符串；颜色是否实际启用由这个实例的环境检测决定，不是写终端 API。
import chalk from "chalk";
// 真实补全提供者把斜杠命令名与文件路径查询组合起来；构造时保存配置，查询时才读取目录。
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
// 多行 Editor 负责输入、编辑状态、提交与补全菜单；它不自动把输入发送给模型。
import { Editor } from "../src/components/editor.ts";
// Loader 构造就更新显示并启用多帧计时器，后续应单独 stop；把它从容器移除不会自动停止其动画。
import { Loader } from "../src/components/loader.ts";
// Markdown 将消息源码转换成终端文字行，构造只保存材料，实际分词和样式处理发生在 render。
import { Markdown } from "../src/components/markdown.ts";
// Text 用于普通欢迎文字；一份含多个换行的 Text 仍然只是一个子组件。
import { Text } from "../src/components/text.ts";
// ProcessTerminal 连接当前进程的真实输入输出；new 尚未启 raw，start 才开始接管。
import { ProcessTerminal } from "../src/terminal.ts";
// type TUI 仅用于编译期检查主屏/备用屏的共同接口，运行时擦除，不会创建实例。
import type { TUI } from "../src/tui.ts";
// 本示例实际创建主屏 TuiMainScreen，它把组件内容画到终端，并允许输出进入主屏滚动历史。
import { TuiMainScreen } from "../src/tui-main-screen.ts";
// 复用测试用编辑器和 Markdown 主题对象，包含边框、候选与正文样式回调；不在这里查询系统主题。
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";

// Create terminal
// 创建真实进程终端适配器；字段初始化可读取可选输出日志配置，但尚未开始监听键盘。
const terminal = new ProcessTerminal();

// Create TUI
// new 创建主屏对象并注入终端；: TUI 只检查实例可满足接口，不把实例转换成另一类型。
const tui: TUI = new TuiMainScreen(terminal);

// Create chat container with some initial messages
// 把接下来这个欢迎 Text 追加到 children；addChild 只改数组，不立即绘制。
tui.addChild(
	// 整段欢迎与操作说明属于同一个 Text，默认左右1列、上下1行边距。文案虽写 Ctrl+C 退出，这份示例没有为 Editor 安装退出回调；raw 模式下不能据这段文案保证 Ctrl+C 一定结束进程。
	new Text("Welcome to Simple Chat!\n\nType your messages below. Type '/' for commands. Press Ctrl+C to exit."),
);

// Create editor with autocomplete
// 构造多行编辑器，保存 TUI 与主题引用；这一步不自动把它挂到 children 或设为焦点。
const editor = new Editor(tui, defaultEditorTheme);

// Set up autocomplete provider with slash commands and file completion
// 配置命令描述表和路径查询基目录；未传第三参 fdPath，缺省为 null，不会自行探测或启动 fd。
const autocompleteProvider = new CombinedAutocompleteProvider(
	// 数组顺序提供两个命令描述；它们只定义补全信息，真正执行分支写在下面 onSubmit 里。
	[
		// delete 名字不含起始斜杠，description 是菜单说明，不是已经删除了消息。
		{ name: "delete", description: "Delete the last message" },
		// clear 同样只是命令候选描述。
		{ name: "clear", description: "Clear all messages" },
	],
	// process.cwd() 返回运行进程当前目录，之后真实路径查询以它为基准，不是此脚本文件所在目录。
	process.cwd(),
);
// 把提供者装到编辑器，并取消旧补全请求/UI；当前还没有用户输入，因此不立即列目录。
editor.setAutocompleteProvider(autocompleteProvider);

// 把编辑器追加到欢迎组件之后；初始 children 恰好两个元素，而不是下面旧英文所假设的两个欢迎组件加编辑器。
tui.addChild(editor);

// Focus the editor
// 将键盘焦点指向编辑器，不等于已经启动输入监听，也不自动插入文字。
tui.setFocus(editor);

// Track if we're waiting for bot response
// let 布尔变量跟踪本例1000ms模拟回复是否还在等待；它属于当前模块内存，不是模型服务器状态。
let isResponding = false;

// Handle message submission
// 注册同步提交回调：接提交字符串，先拦等待状态，再处理 /delete、/clear 或普通消息，返回 void。
// 例如提交 hello 会插入用户 Markdown 和 Loader，再登记1000ms后的固定随机回复；注册此函数本身不执行它。Editor 实际先展开/trim并清空草稿再调用它，因此早退不会恢复已清空文字，回调与计时器错误也没有整体回滚。
editor.onSubmit = (value: string) => {
	// Prevent submission if already responding
	// 若回调被调用时仍在等待，直接拒绝这次内容；disableSubmit 另在编辑器正常按键入口阻止提交，两层判断用途不同。
	if (isResponding) {
		// 结束回调，不增加消息或登记另一计时器。
		return;
	}

	// 再次 trim 首尾空白，用于空内容和精确命令判断；Editor 正常提交路径此前也做过 trim。
	const trimmed = value.trim();

	// Handle slash commands
	// 只在整段文本精确等于 /delete 时走删除分支，不接受带参数或大小写变体的命令。
	if (trimmed === "/delete") {
		// children 是容器公开数组的原引用，下面 splice 直接修改真实组件列表，不是操作副本。
		const children = tui.children;
		// Remove component before editor (if there are any besides the initial text)
		// 只有组件总数大于3才允许删除；由于初始只有欢迎和编辑器两个组件，剩一个消息时总数3便不会再删，这与“任何最后消息都可删”不同。
		if (children.length > 3) {
			// children[0] = "Welcome to Simple Chat!"
			// children[1] = "Type your messages below..."
			// children[2...n-1] = messages
			// children[n] = editor
			// 删除倒数第二个组件，也就是当前编辑器前的一项。上面的英文 children[1] 说明与当前初始化不符：欢迎说明在同一个 Text 内，没有独立第二个欢迎组件。这里只移除组件，不自动调用 stop/dispose。
			children.splice(children.length - 2, 1);
		}
		// 无论是否真的删除，都请求后续重画；requestRender 安排执行而不等待终端完成绘制。
		tui.requestRender();
		// 命令处理结束，不继续把 /delete 当成普通聊天消息。
		return;
	}

	// 精确匹配 /clear 的独立分支；前一个分支已 return，不会两者同时执行。
	if (trimmed === "/clear") {
		// 继续使用 children 的原数组引用。
		const children = tui.children;
		// Remove all messages but keep the welcome text and editor
		// 从索引2删 length-3 项，实际保留索引0、1和末尾。由于只有一个欢迎 Text，索引1可能已是第一条用户消息，所以现有代码并非总能清掉所有消息；总数不足时负 deleteCount 按0处理。
		children.splice(2, children.length - 3);
		// 请求重画当前数组状态，不额外修正索引规则。
		tui.requestRender();
		// 命令分支结束。
		return;
	}

	// 只有 trim 后非空才进入普通消息分支；未知斜杠命令也会被当普通文字。
	if (trimmed) {
		// 先标记等待，阻止后续提交同时再建立一轮模拟回复。
		isResponding = true;
		// 禁止 Editor 的正常提交动作；它仍可接收其他编辑按键，不是禁用整个输入框。
		editor.disableSubmit = true;

		// 把提交 value 保存为用户 Markdown，左右1列、上下1行；不设置额外背景函数，也不向远端发送消息。
		const userMessage = new Markdown(value, 1, 1, defaultMarkdownTheme);

		// 取得当前可变 children 原引用，后面的延迟回调也会闭包捕获它。
		const children = tui.children;
		// splice(start,0,item) 不删除元素，在末尾编辑器之前插入用户消息，维持编辑器最后显示。
		children.splice(children.length - 1, 0, userMessage);

		// 创建加载动画，构造阶段就开始切帧/请求重画；这只是界面等待提示，不对应实际模型任务。
		const loader = new Loader(
			// 传宿主给 Loader，让它能请求后续绘制。
			tui,
			// 这个箭头接一帧字符串并返回青色版本；求值参数时先建立函数，Loader 构造内首次 updateDisplay 就会调用它，以后的动画更新也会继续调用。
			(s) => chalk.cyan(s),
			// 第二个回调把提示文字变暗；函数参数 s 的 string 类型来自 Loader 构造签名推断。
			(s) => chalk.dim(s),
			// 等待提示固定为 Thinking...，没有动态生成的模型思考内容。
			"Thinking...",
		);
		// 把已启动的 Loader 插在编辑器前面、用户消息后面。
		children.splice(children.length - 1, 0, loader);

		// 请求显示刚插入的用户消息与动画。
		tui.requestRender();

		// 登记一次延迟回调，第二参数1000表示毫秒，约到时移除动画、随机选句、插入回复并重新允许提交；计时不保证准点，句柄未保存用于提前取消，回调结束也不会自动停止被移除的 Loader 动画。
		setTimeout(() => {
			// 仅从 children 移除这个 Loader；Container.removeChild 不调用 Loader.stop，因此本例原有的动画 interval 仍可能继续请求重画并保留相关引用。
			tui.removeChild(loader);

			// Simulate a response
			// 固定回复数组在延迟回调真正运行时创建，下面八条只是演示素材，没有模型推理。
			const responses = [
				// 第1条可随机选中的演示回复。
				"That's interesting! Tell me more.",
				// 第2条固定回复。
				"I see what you mean.",
				// 第3条固定回复。
				"Fascinating perspective!",
				// 第4条固定回复。
				"Could you elaborate on that?",
				// 第5条固定回复。
				"That makes sense to me.",
				// 第6条固定回复。
				"I hadn't thought of it that way.",
				// 第7条固定回复。
				"Great point!",
				// 第8条固定回复。
				"Thanks for sharing that.",
			];
			// Math.random() 给0到小于1的数，乘数组长度后 floor 得到0至7的下标，读取一条字符串；不是根据用户内容匹配回复。
			const randomResponse = responses[Math.floor(Math.random() * responses.length)];

			// Add assistant message with no background (transparent)
			// 将随机句保存为无额外背景的 Markdown 组件，左右1列、上下1行；尚未在这一行直接渲染。
			const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
			// 插入在当前数组末尾编辑器之前，用户消息仍保留在更前面。
			children.splice(children.length - 1, 0, botMessage);

			// Re-enable submit
			// 标记这轮模拟回复结束；若前面回调抛错，这行不会保证执行。
			isResponding = false;
			// 重新允许 Editor 正常提交；这里没有 finally，因此它也不是失败时必然恢复的保证。
			editor.disableSubmit = false;

			// Request render
			// 请求下一帧把回复和输入状态呈现出来。
			tui.requestRender();
		}, 1000);
	}
};

// Start the TUI
// 实际启动主屏与 ProcessTerminal：注册输入、协议/退出处理并排首帧。直接导入本文件也会走到这里，没有 import-only 或测试模式门禁。
tui.start();
