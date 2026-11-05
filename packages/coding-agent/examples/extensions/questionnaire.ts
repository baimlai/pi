// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：注册 questionnaire 工具，统一处理单问题与多问题：单问题显示简单选项列表；多问题显示
//   可切换的问题标签栏与 Submit 页，支持“Type something.”自由输入。
// 上游：`pi --extension ./examples/extensions/questionnaire.ts` 加载；模型调用工具时执行 execute。
// 下游：ctx.ui.custom 渲染自绘界面；Editor 处理自由输入；答案文本放进 content 返回模型，
//   结构化 details 供 UI/程序化调用方使用（不发送给模型）。不写文件、不发网络。
// 能力：
//   QuestionOption/Question/Answer/QuestionnaireResult  选项、问题、答案与最终结果类型。
//   QuestionOptionSchema/QuestionSchema/QuestionnaireParams  typebox 参数 schema。
//   errorResult()   构造统一的错误结果（cancelled=true）。
//   默认导出函数     注册工具、执行逻辑与结果渲染。
// 典型顺序：模型调用 -> 参数校验 -> 非 TUI/空问题拒绝 -> 规范化默认值 -> 单/多问题界面 ->
//   逐题保存答案 -> Submit 页确认 -> 返回答案列表。
// 示例：两个问题 [Scope, Priority]，依次选择后进入 Submit 页，按 Enter 返回每行
//   "Scope: user selected: 1. ..."；在选项页或 Submit 页按 Esc 则 cancelled=true，输入模式下第一次
//   按 Esc 只退出编辑并回到选项页。
// 阅读顺序：先看类型与规范化，再看 custom 内的状态机（标签切换/输入模式/提交页），最后看结果映射。

/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Editor 用于自由输入；EditorTheme 提供样式；Key 生成按键标识；matchesKey 匹配按键；
// Text 是静态文本组件；visibleWidth/wrapTextWithAnsi 处理显示宽度与 ANSI 折行。
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
// typebox 构造运行时校验 + 静态类型的参数 schema。
import { Type } from "typebox";

// Types
// 业务选项：value 是选择后返回给调用方的值，label 是显示文本，description 可选。
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

// 渲染用选项：在业务选项上追加 isOther，标记“Type something.”占位项。
type RenderOption = QuestionOption & { isOther?: boolean };

// 规范化后的问题：label 与 allowOther 已补默认值，因此都是必填。
// id 的“唯一”由 schema 描述约定，运行时并不检查重复；重复 id 会让答案 Map 互相覆盖。
interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

// 单个答案：value 是返回值，label 是展示文本（自由输入时两者相同）；
// wasCustom 区分自由输入；index 是普通选项的 1 基序号。
interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

// custom UI 返回并在 details 中保存的完整结果；cancelled=true 时 answers 可能不完整。
interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
// 选项 schema：value/label 必填，description 可选。
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

// 问题 schema：label/allowOther 可选，prompt/options 必填；数组没有 minItems，空选项列表可通过校验。
const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

// 工具参数：外层 questions 数组同样没有 minItems，空数组由 execute 拒绝。
const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

// 构造错误结果。输入：错误文本、可选的问题列表（用于 details）；输出：工具结果。
// cancelled=true 让渲染器与模型都知道没有正常完成；无副作用。
// 示例：errorResult("Error: No questions provided") 返回一条文本 + 空答案 + cancelled。
function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

// 扩展入口。输入：宿主 API；输出：无；副作用是注册 questionnaire 工具。
// 工具的 description 说明单/多问题的界面差异，模型据此决定是否调用。
export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		// execute 的参数已由 schema 校验；返回值包含给模型的文本和给界面的 details。
		// 与 question 工具不同，这里统一处理 1..n 个问题，并在多问题时提供 Submit 页。
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 非交互模式无法显示 custom UI，直接返回错误结果（cancelled=true）。
			if (ctx.mode !== "tui") {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			// 外层数组允许为空，这里做业务校验。
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			// 展开原始字段后覆盖两个默认值：
			// - label 缺失或空串时用 Q1、Q2…；
			// - allowOther 只有显式 false 才关闭，省略时默认 true。
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			// 多问题才显示标签栏；totalTabs 多出最后一个 Submit 页。
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				// currentTab 指向 questions 下标或最后的 Submit 页；optionIndex 只在当前问题的选项内；
				// inputMode/inputQuestionId 记录是否正在为某个问题自由输入；answers 按问题 id 保存答案。
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				// 与 question.ts 相同的编辑器主题；同一时刻只编辑一个问题。
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
				const editor = new Editor(tui, editorTheme);

				// Helpers
				// 清缓存并请求重绘；状态修改后统一调用。
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				// 结束 custom：把问题列表、已保存答案和取消标记交给调用方。
				// Array.from 把 Map 的值按插入顺序转成数组。
				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				// 当前页对应的问题；Submit 页（currentTab === questions.length）返回 undefined。
				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				// 当前问题的显示选项：业务选项浅拷贝后，按 allowOther 追加占位项。
				// "__other__" 是内部 value，不会作为普通选项返回。
				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				// 每题是否已有答案；按 id 判断，因此重复 id 会让两题共享一个答案。
				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				// 保存一个答案后推进：单问题立即提交；多问题前进到下一题，最后一题后进入 Submit 页。
				// 注意不会自动提交多问题问卷，用户仍可在 Submit 页检查。
				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				// 写入答案 Map；index 对自由输入为 undefined，对普通选项为 1 基序号。
				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				// 自由输入提交：空输入也保存为 "(no response)"（仍算已作答），随后退出输入模式并推进。
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					// trim 后为空时使用固定占位文本；value 与 label 都保存该结果。
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					// 重置输入状态，避免下一题仍把按键路由给 Editor。
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				// 按键路由。输入：原始按键序列；副作用：切换标签、移动选项、进入输入模式或提交。
				// 优先级：输入模式 -> 多问题标签切换 -> Submit 页 -> 选项导航/选择 -> 取消。
				// 示例：多问题界面按 Tab 从 Q1 到 Q2；在 Q1 按 Enter 选择普通项后自动进入 Q2。
				function handleInput(data: string) {
					// Input mode: route to editor
					// 输入模式下 Esc 只退出编辑并清空，不取消问卷；其他按键交给 Editor。
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					// Tab/→ 下一个标签，Shift+Tab/← 上一个；取模实现首尾循环，切换后选项归零。
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							// 加 totalTabs 再取模，避免负下标。
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					// 除上面已处理的标签切换键外，Submit 页只处理 Enter（全部已答才提交）与 Esc（取消）。
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					// 上下移动当前问题的选项，夹在 0..长度-1。
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					// q 在非 Submit 页一定存在；再加 q 条件是为了让类型收窄。
					if (matchesKey(data, Key.enter) && q) {
						// schema 不要求 options 非空；若某题 options=[] 且 allowOther=false，opts 为空，
						// 这里得到 undefined，下一行读取 isOther 会抛 TypeError。示例没有防护该配置。
						const opt = opts[optionIndex];
						if (opt.isOther) {
							// 占位项：进入该问题的编辑模式，并清空上一次输入。
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						// 普通选项保存 value/label，index 使用 1 基序号。
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					// Esc 在选项界面取消整个问卷（已填答案仍随 details 返回，cancelled=true）。
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				// 渲染当前界面。输入：宿主给的可视宽度；输出：行数组；有缓存时直接复用。
				// 三种内容分支：输入模式（问题+选项参考+Editor）、Submit 页（答案摘要）、普通问题页。
				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					// 宽度至少 1，避免换行函数收到非正数。
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();

					// 无前缀折行，整行推入。
					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					// 带前缀折行：首行加 prefix，续行用等宽空格对齐；prefix 过宽时整体折行。
					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					// 标签栏：← 提示可左移，每个问题显示 ■（已答）/□（未答），活动标签加 selectedBg 背景；
					// 最后是 Submit 标签，全部答完才用 success 色，否则 dim。
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							// 活动标签用背景色突出；非活动标签按是否已答着色。
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						// 所有标签拼成一行再统一折行，宽度不足时自动换行。
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					// Helper to render options list
					// 选项列表：选中行 "> " 前缀与 accent 色；自由输入项在编辑时追加 ✎。
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							// 可选描述缩进 5 列显示在选项下方。
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						// 输入模式：问题正文、作为参考的选项、编辑框、提交提示。
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						// Editor 宽度比外层少 2，给每行前导空格留位置。
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						// 提示文案写 "Esc to cancel"，但本组件的输入模式 Esc 实际只退出编辑；
						// 要取消问卷需回到选项页再按 Esc。
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						// Submit 页：列出已答问题；未答完时显示缺失标签，不能按 Enter 提交。
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							// 只显示已答项；未答项在下方统一列出。
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							// filter 收集未答问题并拼接标签；这里再次检查 answers，保证摘要与状态一致。
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						// 普通问题页：问题正文 + 选项列表。
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					// 帮助行只在非输入模式显示；输入模式的提示已在上方给出。
					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: "↑↓ navigate • Enter select • Esc cancel";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// 缓存结果；任何状态变化后由 refresh/invalidate 清空。
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// 取消分支：details 保留已收集的问题与答案，方便调用方了解用户填到哪一步。
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			// 把每个答案映射成给模型看的文本行；标签优先用问题 label，找不到时退回 id。
			// 自由输入显示 user wrote，普通选项显示 1 基序号 + 标签。
			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			// 多行文本一次返回；details 保留完整结构化结果。
			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		// 调用行：显示问题数量与标签摘要。输入：schema 推导的 args、主题、上下文；输出：Text。
		// args.questions 的 as 断言是编译期行为；|| [] 是示例的防御性兜底。
		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			// 标签缺失时用 id；join 用逗号连接，长列表可能在渲染时换行。
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			// question/questions 单复数通过三目表达式处理。
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		// 结果行：取消显示 Cancelled；否则每个答案一行，用 ✓ 标记完成。
		// details 断言后按 wasCustom 分支；index 缺省时只显示标签。
		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				// 没有结构化 details 时退回第一条文本内容。
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			// 结果行显示问题 id（不是 label），与 details 中的答案 id 对应。
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				// index 为 undefined 时退化为纯标签；正常普通选项都有 1 基序号。
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
