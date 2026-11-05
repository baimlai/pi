// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：注册 question 工具，让模型向用户提一个问题并给出若干选项；自定义 UI 同时支持选项列表与
//   “Type something.”自由输入，答案写回工具结果与 details。
// 上游：`pi --extension ./examples/extensions/question.ts` 加载；模型调用 question 工具时执行 execute。
// 下游：ctx.ui.custom 渲染自绘列表/编辑器；Editor 处理自由输入；结果返回给模型。
//   不写文件、不发网络，答案只进入当前会话。
// 能力：
//   OptionWithDesc / DisplayOption  选项与“自定义输入”占位项的形状。
//   QuestionDetails                工具结果里保留的结构化答案。
//   OptionSchema / QuestionParams  typebox 参数 schema，同时驱动校验与 TS 类型。
//   默认导出函数                    注册 question 工具及 renderCall/renderResult。
// 典型顺序：模型调用 -> 参数校验 -> 非 TUI/空选项拒绝 -> 显示选择器 -> 选项或自定义答案 -> 结果文本与 details。
// 示例：选项 ["A","B"]，用户选 B 时结果文本为 "User selected: 2. B"；选择 “Type something.” 输入文字时
//   文本为 "User wrote: ..."，details.wasCustom 为 true。
// 阅读顺序：先看 schema 与 execute 的拒绝分支，再看自定义 UI 的状态机（选项/编辑模式），最后看结果渲染。

/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options cancels
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Editor 是可复用的多行编辑组件；EditorTheme 描述其颜色；Key 生成按键标识；
// matchesKey 按当前键位配置匹配；Text 是静态文本组件；visibleWidth 计算显示列；
// wrapTextWithAnsi 按显示宽度换行并保留 ANSI 样式。
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// Type 是 typebox 的 schema 构造器：运行时校验参数，同时为 execute 的 params 提供静态类型。
import { Type } from "typebox";

// 业务选项：label 必填，description 可选（显示在标签下方）。
interface OptionWithDesc {
	label: string;
	description?: string;
}

// UI 内部选项：在业务选项基础上加 isOther 标记，用于“Type something.”占位项。
// 交叉类型意味着它仍拥有 label/description 字段。
type DisplayOption = OptionWithDesc & { isOther?: boolean };

// 工具 details 的结构化答案。answer 为 null 表示取消或失败；wasCustom 区分自由输入。
interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// Options with labels and optional descriptions
// typebox schema：description 只用于向模型描述参数，Type.Optional 允许省略该字段。
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

// 工具参数：question 必填，options 是选项数组。
// schema 没有声明 minItems，因此空数组也能通过校验，由 execute 自己返回错误。
const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

// 扩展入口。输入：宿主 API；输出：无；副作用是注册 question 工具。
// 工具名 question 会暴露给模型；description 影响模型何时调用它。
// executionMode: "sequential" 让该工具与其他工具串行执行，避免并行弹窗互相干扰。
export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential",

		// execute 签名由宿主固定：调用 id、schema 推导的参数、取消信号、流式更新回调、工具上下文。
		// params 已按 QuestionParams 校验；这里只处理 UI 能力与业务约束（非空选项）。
		// 输出：content 给模型看的文本 + details 给渲染器用的结构化数据；不抛异常，错误也用文本返回。
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 非交互模式没有 custom UI，无法提问；返回错误文本而不是抛出，模型能读到失败原因。
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					// as QuestionDetails 是断言：details 的静态类型较宽，运行时不校验形状。
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			// schema 未限制最小长度，空数组在这里被拒绝；仍在 details.options 中保留空列表。
			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			// 追加固定占位项，索引为 params.options.length；isOther 让选择时进入编辑模式。
			const allOptions: DisplayOption[] = [...params.options, { label: "Type something.", isOther: true }];

			// custom 的返回类型：选中/提交时给出答案与是否为自定义输入，index 是选项序号（自定义时缺省）；
			// null 表示用户取消。组件用闭包状态实现“选项列表 ↔ 编辑模式”的切换。
			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					// optionIndex 指向 allOptions 的当前行；editMode 为 true 时所有按键交给 Editor；
					// cachedLines 缓存上一次渲染结果，状态变化时通过 refresh 清空。
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

					// Editor 的主题配置；selectList 子配置供 Editor 内部可能使用的选择器样式。
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					// Editor 需要 TUI 句柄来处理输入/光标；它自身的提交通过 onSubmit 回调通知。
					const editor = new Editor(tui, editorTheme);

					// 提交自由输入：trim 后非空才接受；空白提交视为放弃输入，回到选项列表并清空编辑器。
					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					// 使缓存失效并请求宿主重绘；所有状态修改后都需要调用。
					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					// 一次按键的路由：编辑模式优先；否则上下移动、Enter 选择、Esc 取消。
					// 编辑模式下 Esc 只退出编辑，不取消整个提问；选项模式下的 Esc 才 done(null)。
					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							// 其余按键（字符、方向、退格等）交给 Editor 处理。
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							// 选中项上移，下限 0（不循环）。
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							// 选中项下移，上限为最后一项（包含“Type something.”）。
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							// optionIndex 已由上下键夹在合法范围，因此 selected 存在。
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								// 占位项不立即完成，而是进入编辑模式等待输入。
								editMode = true;
								refresh();
							} else {
								// index 从 1 开始，与界面编号一致；wasCustom=false 区分自由输入。
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							// 选项模式取消整个提问，自定义 UI 返回 null。
							done(null);
						}
					}

					// 渲染整个界面。输入：宿主给的可视宽度；输出：行数组；有缓存时直接复用。
					// 换行使用 wrapTextWithAnsi，保证 ANSI 样式在折行后仍然有效。
					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						// 宽度至少 1，避免 wrapTextWithAnsi 收到 0 或负数。
						const renderWidth = Math.max(1, width);

						// 折行后整行推入，不带前缀。
						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						// 带前缀折行：首行加 prefix，续行用等宽空格对齐；prefix 本身比可用宽度还宽时
						// 退化为“前缀+正文”整体折行，保证内容不丢失。
						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							// 续行缩进与 prefix 同宽，使文本块视觉对齐。
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						// 顶部分隔线、问题正文、空行。
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						addWrappedWithPrefix(" ", theme.fg("text", params.question));
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							// 选中行前缀 "> " 用 accent，未选中保留两空格对齐。
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							// 自定义项在编辑模式下追加 ✎ 标记。
							const label = `${i + 1}. ${opt.label}${isOther && editMode ? " ✎" : ""}`;
							// 选中行或正在编辑的自定义项用 accent，其余用 text。
							const color = selected || (isOther && editMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));

							// Show description if present
							// 描述缩进 5 列，位于标签下方；没有描述就不占行。
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}

						if (editMode) {
							// 编辑区：标题 + 内嵌 Editor 的渲染行；宽度留出左右各一列。
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
						}

						// 底部提示随模式变化，最后一行分隔线。
						lines.push("");
						if (editMode) {
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
						} else {
							addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
						}
						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						// 缓存本次结果；状态变化时 refresh/invalidate 会清空。
						cachedLines = lines;
						return lines;
					}

					// custom 组件接口：render 用于绘制，invalidate 清缓存，handleInput 处理按键。
					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			// Build simple options list for details
			// details 只保存业务选项标签，不保存追加的 “Type something.” 占位项。
			const simpleOptions = params.options.map((o) => o.label);

			// null 表示用户取消；content 供模型阅读，details.answer 用 null 标记无答案。
			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			// 自由输入分支：没有 index（不在 options 列表中），wasCustom=true 让渲染器显示 (wrote)。
			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			// 普通选项分支：result.index 从 1 开始，直接用于给模型看的编号。
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		// 工具“被调用”行的渲染。输入：schema 推导的 args、主题、渲染上下文；输出：Text 组件。
		// 折叠/展开状态下都显示问题与选项摘要；追加的占位项也列出来，方便用户知道可以自由输入。
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			// Array.isArray 是示例的防御性写法；按 schema 类型 args.options 已是数组。
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				// 手动编号（1..n）与追加的 “Type something.” 一起展示；join 用逗号分隔。
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		// 工具结果的渲染。输入：结果、渲染选项、主题、上下文；输出：Text 组件。
		// details 是 execute 写入的结构化数据；断言后按字段分支：取消/自由输入/选项。
		renderResult(result, _options, theme, _context) {
			// 断言是编译期行为；如果其他实现返回不同 details 形状，这里不会做运行时校验。
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				// 没有 details 时退回第一条文本内容；图片等非文本块显示为空。
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				// 自由输入：✓ (wrote) 加答案文本。
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			// 普通选项：用 answer 反查 1 基序号；找不到时（配置变化等）只显示答案原文。
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
