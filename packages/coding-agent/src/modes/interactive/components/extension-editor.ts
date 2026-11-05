// 扩展多行编辑面板：焦点转给内部 Editor，提交/取消交宿主，外部编辑器调用前暂停 TUI、结束后恢复。
/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import {
	// 纵向组织边框、标题、编辑器和帮助文字。
	Container,
	// 基础多行编辑器，负责文字/光标/提交等输入处理。
	Editor,
	// 基础编辑器选项类型，执行时擦除。
	type EditorOptions,
	// 焦点接口只要求 focused 契约，不自动聚焦子组件。
	type Focusable,
	// 取消动作读取共享全局键位；外部编辑器动作另用传入的应用管理器。
	getKeybindings,
	// 生成显式空行间距。
	Spacer,
	// 显示标题、说明、外部编辑器失败状态和帮助。
	Text,
	// 宿主界面类型，实际停止/恢复/刷新通过传入实例调用。
	type TUI,
} from "@earendil-works/pi-tui";
// 应用键位管理器的类型，构造时由宿主传实例。
import type { KeybindingsManager } from "../../../core/keybindings.ts";
// 真正的辅助流程会建临时文件并 spawn 外部程序，返回编辑文字或失败消息，不在导入时启动。
import { editInExternalEditor } from "../external-editor.ts";
// 创建多行编辑器的样式和当前文字颜色。
import { getEditorTheme, theme } from "../theme/theme.ts";
// 上下边框按实际渲染宽度生成。
import { DynamicBorder } from "./dynamic-border.ts";
// 帮助文字采用宿主共享键位，显示不等于在这里直接绑定键。
import { keyHint } from "./keybinding-hints.ts";

// 继承基础编辑器设置，再加面板说明；options.description 会被拆出而不传进 Editor。
export interface ExtensionEditorOptions extends EditorOptions {
	// 可选说明，非空真值才显示。
	description?: string;
}

// 实现焦点接口并保留容器布局；交互模式负责把面板加入对话框栈并在回调后移除。
export class ExtensionEditorComponent extends Container implements Focusable {
	// 内部多行编辑器，用户文字保存在这里。
	private editor: Editor;
	// 提交时把父 Editor 产生的文字交宿主。
	private onSubmitCallback: (value: string) => void;
	// 取消意图回调，不自动销毁面板。
	private onCancelCallback: () => void;
	// 外部编辑器接管终端前后暂停/恢复这个宿主界面。
	private tui: TUI;
	// 识别应用级外部编辑器动作的管理器。
	private keybindings: KeybindingsManager;
	// 构造时选择的命令字符串；后续不自动跟随环境变量变化。
	private externalEditorCommand: string;
	/** Shows external editor failures; renders nothing while empty. */
	// 空 Text 默认不占正文行，失败后才填警告；父类 super 返回后初始化此字段，再继续执行构造函数体。
	private externalEditorStatus = new Text("", 1, 0);

	// 本面板的焦点标记，默认未聚焦。
	private _focused = false;
	// 读取当前焦点标志，无副作用；例宿主检查面板是否聚焦，不重新查询编辑器状态。
	get focused(): boolean {
		// get 访问器让读取写成 component.focused。
		return this._focused;
	}
	// 设置面板及内部编辑器焦点，无返回值；例宿主聚焦面板时让输入法/硬件光标定位编辑区，不改变正文。
	set focused(value: boolean) {
		// 先保存外层标志。
		this._focused = value;
		// 把相同值传给内部 Editor，使其 render 按焦点产生光标标记。
		this.editor.focused = value;
	}

	// 创建多行面板：选外部命令、拆说明选项、搭边框/标题、建 Editor 并填预置值、绑定提交及帮助。
	// 例预填 "draft" 后确认，回调收到父 Editor 提交整理后的文本；真正外部程序只在触发相应动作时启动。
	// 可读 VISUAL/EDITOR 环境变量但构造不启动进程；布局/主题等同步异常传播，宿主负责显示和移除。
	constructor(
		// 必需的界面宿主。
		tui: TUI,
		// 应用键位匹配器。
		keybindings: KeybindingsManager,
		// 标题，直接显示而非 Markdown 解析。
		title: string,
		// 可明确没有预填内容，空串不调用 setText。
		prefill: string | undefined,
		// 确认时同步回传文本。
		onSubmit: (value: string) => void,
		// 取消时同步通知。
		onCancel: () => void,
		// 可选基础编辑器配置及说明。
		options?: ExtensionEditorOptions,
		// 可选显式命令，真值优先于环境变量。
		externalEditorCommand?: string,
	) {
		// 先初始化父容器。
		super();

		// 保存可暂停/启动的宿主引用。
		this.tui = tui;
		// 保存应用键位引用。
		this.keybindings = keybindings;
		// 下面用 || 依次挑第一个真值，空字符串也会继续回退。
		this.externalEditorCommand =
			// 显式非空命令优先。
			externalEditorCommand ||
			// 其次读 VISUAL 环境变量。
			process.env.VISUAL ||
			// 再尝试 EDITOR。
			process.env.EDITOR ||
			// 没有配置时 Windows 用 notepad，其余用 nano，不在此检查是否已安装。
			(process.platform === "win32" ? "notepad" : "nano");
		// 保存提交回调。
		this.onSubmitCallback = onSubmit;
		// 保存取消回调。
		this.onCancelCallback = onCancel;
		// 对象剩余解构取出说明，其余配置交 Editor；不深复制其中嵌套对象。
		const { description, ...editorOptions } = options ?? {};

		// Add top border
		// 面板上下各放一条动态边框。
		this.addChild(new DynamicBorder());
		// 在边框、标题、编辑区、帮助之间明确留一行。
		this.addChild(new Spacer(1));

		// Add title and optional description
		// 标题用强调色，左右各留 1 列，上下不另留白。
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		// 说明非空真值才展示；纯空白串仍为真值。
		if (description) {
			// 说明前加一行间距。
			this.addChild(new Spacer(1));
			// 说明按普通 Text 排版，不作为提示词发送给模型。
			this.addChild(new Text(theme.fg("text", description), 1, 0));
		}
		// 在边框、标题、编辑区、帮助之间明确留一行。
		this.addChild(new Spacer(1));

		// Create editor
		// 基础编辑器接收拆掉 description 后的选项，负责规范自身边距等设置。
		this.editor = new Editor(tui, getEditorTheme(), editorOptions);
		// 有非空预置文字才填入，undefined/空串保留基础初始空值。
		if (prefill) {
			// 直接设置编辑内容，不触发提交。
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		// 父 Editor 处理实际提交动作；其提交会展开大粘贴并 trim、清编辑状态后再回调。
		this.editor.onSubmit = (text: string) => {
			// 把已整理的文本交宿主，回调本身可能关闭面板，组件不自行保存。
			this.onSubmitCallback(text);
		};
		// 加入编辑区。
		this.addChild(this.editor);
		// 编辑区之后放可空的失败提示，成功时清文字。
		this.addChild(this.externalEditorStatus);

		// 在边框、标题、编辑区、帮助之间明确留一行。
		this.addChild(new Spacer(1));

		// Add hint
		// 组合帮助文字，反映当前配置，默认键名不应被当作固定行为保证。
		const hint =
			// 提交提示采用选择确认动作；实际 Editor 提交仍按其输入动作规则。
			keyHint("tui.select.confirm", "submit") +
			// 用两个空格分隔各动作提示。
			"  " +
			// 换行提示采用输入换行动作。
			keyHint("tui.input.newLine", "newline") +
			// 用两个空格分隔各动作提示。
			"  " +
			// 取消提示采用共享取消动作。
			keyHint("tui.select.cancel", "cancel") +
			// 最后显示应用级外部编辑器动作，真实匹配用传入的 keybindings。
			`  ${keyHint("app.editor.external", "external editor")}`;
		// 帮助 Text 左右留 1 列，不自己处理输入。
		this.addChild(new Text(hint, 1, 0));

		// 在边框、标题、编辑区、帮助之间明确留一行。
		this.addChild(new Spacer(1));

		// Add bottom border
		// 面板上下各放一条动态边框。
		this.addChild(new DynamicBorder());
	}

	// 路由输入：共享取消键优先→应用外部编辑器动作→其余交内部 Editor；例取消只通知宿主，外部动作启动异步流程。
	// 不在此保存文本，无返回值；同步回调异常传播，void 异步调用不会自动捕获拒绝。
	handleInput(keyData: string): void {
		// 每次取消匹配读取全局共享键位，不缓存默认键。
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		// 取消优先于外部编辑器/普通编辑，即使动作配置共用同键。
		if (kb.matches(keyData, "tui.select.cancel")) {
			// 宿主决定如何移除/关闭面板，本组件只通知。
			this.onCancelCallback();
			// 本输入已处理，不继续交内部编辑器。
			return;
		}

		// External editor (app keybinding)
		// 应用动作使用构造传入管理器，通常与宿主共享配置一致。
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			// 启动而不等待 Promise；没有忙锁/去重或 catch，多次调用可并发，拒绝可能成为未处理拒绝。
			void this.handleOpenExternalEditor();
			// 本输入已处理，不继续交内部编辑器。
			return;
		}

		// Forward to editor
		// 其余按键交多行编辑器处理文字/补全/提交。
		this.editor.handleInput(keyData);
	}

	// 取当前文本→暂停 TUI→等外部程序→展示失败或替换正文→finally 恢复 TUI 并全量重绘。
	// 例退出码 0 时采用临时文件新内容，非零返回 failed 只提示且不替换文本；helper 的临时文件/进程副作用实际发生在这里。
	// stop 在 try 前，其抛错不会进 finally；helper/恢复错误可拒绝本 Promise，没有取消外部进程或关闭后淘汰结果的机制。
	private async handleOpenExternalEditor(): Promise<void> {
		// 读取编辑器当前存储文本，不调用提交；该方法与展开大粘贴的提交文本可能不同。
		const content = this.editor.getText();
		// 先暂停宿主界面让外部编辑器接管终端；此行在下面 try 之外。
		this.tui.stop();
		// 从外部调用开始建立 finally 恢复保障，没有 catch 把所有失败变成提示。
		try {
			// helper 创建临时 prompt 文件、启动命令、等待退出并读取结果；某些 IO/启动异常仍会拒绝。
			const result = await editInExternalEditor({
				// 使用构造时选定的命令，helper 的空格拆命令并非完整 shell 引号解析。
				command: this.externalEditorCommand,
				// 写进临时文件的初始内容，属性简写等于 content: content。
				content,
			});
			// failed 用警告色显示原因，complete 清掉旧提示；错误分支不会自动清正文。
			this.externalEditorStatus.setText(result.status === "failed" ? theme.fg("warning", result.message) : "");
			// 标签联合收窄后才能读成功分支 content。
			if (result.status === "complete") {
				// 成功才替换正文，空字符串也会采用；不自动提交给宿主。
				this.editor.setText(result.content);
			}
			// 正常返回或 try 内抛错都尝试恢复；不代表错误会被吞掉。
		} finally {
			// 恢复界面输入/绘制流程；若 start 自身抛错，下面请求会被跳过。
			this.tui.start();
			// 请求全量重绘以清理外部程序留下的终端画面。
			this.tui.requestRender(true);
		}
	}
}
