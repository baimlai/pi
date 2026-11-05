/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */

// 供AgentSession的HTML导出预渲染扩展工具：调用其同步展示回调→Component.render(width)→ANSI转HTML，不重新调用工具execute。
// 展示回调仍是宿主可执行代码，可能有副作用；本适配器捕获渲染异常并返回undefined，让模板考虑结构化兜底，不构成代码沙箱。
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, as resolved by extensions and the registered tool */
	// 按名字动态解析展示方法，不在创建适配器时一次性锁定所有定义；返回undefined表示当前无定义。
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	// 传入终端主题对象给扩展回调；和最终HTML页面themeName选择是两条输入，适配器不自行同步二者。
	theme: Theme;
	/** Working directory for render context */
	// 提供给渲染回调的会话工作目录，仅上下文数据，本函数不chdir。
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	// 模拟终端列宽，省略/undefined才用100，不约束为正数或改成浏览器像素宽。
	width?: number;
}

// 同步展示接口，结果是HTML片段而非写文件任务；参数unknown由扩展自身理解，本接口不执行工具schema校验。
export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	// toolCallId关联同一次调用的组件/参数/状态；缺渲染器或渲染异常可返回undefined。
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	// result是会话通用内容结构，details为扩展数据，isError仅是展示标记；collapsed可省，expanded可为空串。
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
// 仅识别分号SGR颜色/样式，不删除OSC或任意终端控制序列；用于判断渲染首尾空白行。
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

// 输入一条渲染行，删除本正则认识的SGR后trim，返回是否空白，无I/O；例如带红色起止码的空格行也算空。
// 不测终端显示宽度，只有控制序列但非SGR的行未必被当空；replace对g正则会重置lastIndex。
function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

// 输入组件行数组，去掉连续首尾空白行并返回slice新数组，中间空行保留，不修改原数组。
// 例如["","one","","two",""]→["one","","two"]；全空得到[]，只修剪结果区，不用于调用区。
function trimRenderedResultLines(lines: string[]): string[] {
	// 半开区间[start,end)，先向右找首个非空，再向左找最后非空。
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	// end>start防止全空数组时访问范围交叉；每次只减末尾，不trim正文行内空格。
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

// 输入解析器/主题/cwd/可选列宽，返回一对带共享缓存的展示函数；创建时不执行扩展回调、不写导出文件。
// 例如同一id先renderCall再renderResult，参数和state跨调用共享，结果先折叠再展开，lastComponent允许扩展复用组件。
// 缓存与返回适配器同寿命，没有逐id清理；错误不回滚已经记录的参数、状态或组件，回调也不保证无副作用。
export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	// 解构保存依赖值，默认参数只覆盖width===undefined；传0仍原样交给组件。
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	// 调用区与结果区分别缓存组件，避免把两个渲染槽混用；id按字符串精确区分。
	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	// 这里沿用原API的any状态，实际形状由扩展决定，不额外验证或深复制。
	const renderedStates = new Map<string, any>();
	// 参数即使无renderCall/渲染失败也可能已存入，结果区稍后可从context.args取得。
	const renderedArgs = new Map<string, unknown>();

	// 输入调用id，取得/懒建共享状态对象并返回；例如调用区写state.x后结果区可读它，没有冻结或持久化。
	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			// 无已有真值状态才创建空对象，随后在这个适配器的Map中保存。
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	// 输入id、该槽上次组件、展开/部分/错误标记，生成本次展示上下文；读取/可能创建共享state，无真实工具执行。
	// 例如调用区用isPartial:true而argsComplete:true，这些是本导出器约定的展示值，并非重建历史执行时刻状态。
	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			// 参数来自先前renderCall；若只渲染结果，args可能为undefined。
			args: renderedArgs.get(toolCallId),
			toolCallId,
			// 静态导出不安排后续重绘，invalidate是空函数；不能据此等待异步数据填充完成。
			invalidate: () => {},
			lastComponent,
			// 同一次调用的调用区/折叠结果/展开结果共享这份状态。
			state: getState(toolCallId),
			cwd,
			// 导出按已开始、参数已完整展示，不实际启动工具或恢复执行计时器。
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			// 不显示TUI内联图片；并非从导出数据中删除所有image内容，扩展仍收到result。
			showImages: false,
			isError,
			// 未从历史提取耗时；固定padding=1也不读取当前outputPad设置。
			durationMs: undefined,
			outputPad: 1,
			// 快捷键提示函数仍可按当前全局键位生成文字，非历史按键快照。
			keyText,
			keyHint,
		};
	};

	return {
		// 输入id/工具名/参数，查renderCall→构建上下文→渲染组件→转HTML；例如缺自定义调用展示时返回undefined。
		// 同步异常被catch，已存参数/组件不回滚；方法只返回片段，不触发工具execute或写文件。
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				// 先存参数，后查定义，因此即使无调用渲染器，结果回调仍可取得args。
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				// 显式调用扩展展示代码，传终端主题；lastComponent只取此id调用区缓存。
				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				// render可能重用/修改组件，返回字符串行；列宽不等于最终浏览器容器宽度。
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},

		// 输入结果内容/详情/错误标记，为同一id依次渲染折叠和展开HTML；例如两种内容一致时省掉重复collapsed键。
		// 缺renderResult或任一阶段异常返回undefined；已经执行的折叠回调及缓存更新不回滚，下一次可见这些状态。
		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				// 每次重新查渲染器，不要求前面已成功生成调用HTML。
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				// as仅桥接静态类型，不验证每项确为text/image，也不把未知内容格式转换掉。
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Render collapsed
				// 两处expanded/isPartial标记一致；先提供结果槽已有组件，让扩展可复用它。
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				// 首尾间隔行移除，内部空行/缩进保留，再逐行转HTML。
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// Render expanded
				// 此处get取到刚存的collapsedComponent，同一state也继续复用，不独立克隆一份展开状态。
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				// 导出的缓存最终保留展开组件，后续同id再渲染从它开始。
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					// 条件展开只在非空且两种HTML不同才附collapsed；expanded始终存在，即使是空串。
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				// 不向上抛展示错误，也不假装返回一份部分成功的折叠结果。
				return undefined;
			}
		},
	};
}
