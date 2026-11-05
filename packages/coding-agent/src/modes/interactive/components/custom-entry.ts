// 展示扩展写入会话的自定义状态条目；EntryRenderer 决定内容，undefined 表示不展示，异常则显示错误卡片。
// Component 只约束可渲染/可失效接口，type 导入不会加载运行时值。
import type { Component } from "@earendil-works/pi-tui";
// 容器组织扩展组件；Box/Text 用于渲染器失败后的错误显示。
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
// 状态条目渲染回调返回 Component 或 undefined，选项只有展开状态和快捷键提示。
import type { EntryRenderer } from "../../../core/extensions/types.ts";
// CustomEntry 是持久化状态条目，不同于会进入消息处理的 CustomMessage。
import type { CustomEntry } from "../../../core/session-manager.ts";
// 把当前主题传给扩展，也用于错误卡片着色。
import { theme } from "../theme/theme.ts";
// 把宿主当前快捷键提示函数提供给渲染器，扩展不必写死键名。
import { keyHint, keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
// 本组件拥有消息前的空行，扩展只需返回自身内容；不把条目改成模型消息。
export class CustomEntryComponent extends Container {
	// 泛型 unknown 表示 data 的业务结构未知，扩展自行理解其内容。
	private entry: CustomEntry<unknown>;
	// 保存必需渲染函数；每次重建都会再次调用。
	private renderer: EntryRenderer;
	// 当前真正展示的组件，可缺省；错误卡片也会记在这里。
	private customComponent?: Component;
	// 本地展开状态，默认折叠；具体折叠行为由扩展渲染器决定。
	private _expanded = false;
	// 只用于本组件的错误兜底卡片；EntryRenderOptions 不提供 outputPad。
	private outputPad: number;

	// 创建条目展示，保存条目/回调/错误卡片留白后立即调用渲染器。
	// 例：renderer 返回 Text 就显示文字，返回 undefined 就不占消息空行；渲染器异常转为错误卡片。
	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad = 1) {
		// 初始化父容器。
		super();
		// 保存条目引用，不复制或写回日志。
		this.entry = entry;
		// 保存回调，稍后重建会实际调用它。
		this.renderer = renderer;
		// 保存错误卡片水平留白，默认 1。
		this.outputPad = outputPad;
		// 重建当前内容；不会自动释放被替换组件的资源。
		this.rebuild();
	}

	// 报告是否有展示组件，供宿主决定是否加入聊天区；例如 renderer 返回 undefined 时 false，失败卡片则 true。
	hasContent(): boolean {
		// 只检查是否已保存组件，不检查其 render 是否真的返回可见行。
		return this.customComponent !== undefined;
	}

	// 改变展开状态后重新调用扩展，无返回值；例如从 false 改为 true 让扩展显示详情。
	setExpanded(expanded: boolean): void {
		// 状态相同则跳过重建，避免重复调用扩展。
		if (this._expanded !== expanded) {
			// 保存新状态供下次 renderer 读取。
			this._expanded = expanded;
			// 以新选项再次调用渲染器并替换内容。
			this.rebuild();
		}
	}

	// 设置兜底卡片左右留白并重建，即使数值未变也调用扩展；不把该参数透传给 EntryRenderer。
	setOutputPad(outputPad: number): void {
		// 保存新的错误卡片水平留白；此 setter 没有缺省参数或范围检查。
		this.outputPad = outputPad;
		// 重建当前内容；不会自动释放被替换组件的资源。
		this.rebuild();
	}

	// 先让旧孩子缓存失效，再重建扩展结果；例主题变化后扩展可用新主题重画，无返回值。
	override invalidate(): void {
		// 父容器依次调用现有孩子 invalidate，异常仍可向上传播。
		super.invalidate();
		// 重建当前内容；不会自动释放被替换组件的资源。
		this.rebuild();
	}

	// 清旧内容→调用扩展→必要时造错误卡片→有组件才加间距。
	// 例：渲染器 throw Error("bad") 会显示带 customType 的失败提示；这里只捕获 renderer 调用异常。
	private rebuild(): void {
		// 移除全部孩子，包含旧消息间距。
		this.clear();
		// 先标记无内容，防止渲染器这次不显示时保留旧状态。
		this.customComponent = undefined;

		// 局部变量的联合类型允许尚无组件；let 表示后面会赋值。
		let component: Component | undefined;
		// 只对接下来的扩展回调调用建立异常边界，未来 render 时的异常不在本 try 内。
		try {
			// 传条目、展开状态和快捷键函数、当前主题；对象属性简写 keyText 等于 keyText: keyText。
			component = this.renderer(this.entry, { expanded: this._expanded, keyText, keyHint }, theme);
			// 渲染器同步抛错就构造错误组件，不重新抛原异常。
		} catch (error) {
			// unknown 异常在 Error 分支取 message，其他值转字符串；转换本身若抛错仍会传播。
			const message = error instanceof Error ? error.message : String(error);
			// 错误卡片用当前水平留白、上下 1 行和自定义消息背景。
			const box = new Box(this.outputPad, 1, (text) => theme.bg("customMessageBg", text));
			// 以错误色展示条目类别和原因，不尝试调用原 renderer 兜底。
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			// 把错误卡片也当作有效展示组件，hasContent 会返回 true。
			component = box;
		}

		// 正常返回 undefined 时无需显示任何内容。
		if (!component) {
			// 提前结束，因此不会额外加入空白 Spacer。
			return;
		}

		// 保存当前展示对象；只是引用，不冻结扩展组件。
		this.customComponent = component;
		// 只有确实有组件时才在它前面添加一行消息间距。
		this.addChild(new Spacer(1));
		// 将扩展组件或错误卡片加入父容器，具体样式由它自己负责。
		this.addChild(component);
	}
}
