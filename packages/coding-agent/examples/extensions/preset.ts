// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：从 JSON 配置读取命名预设（模型、思考级别、工具集、附加指令），通过 --preset 标志、
//   /preset 命令或 Ctrl+Shift+U 循环应用；还可从会话记录恢复预设名并把指令注入系统提示。
// 上游：扩展加载后 session_start 读取 ~/.pi/agent/presets.json 与 <cwd>/.pi/presets.json；
//   用户命令/快捷键触发应用。
// 下游：pi.setModel/setThinkingLevel/setActiveTools 改变运行时配置；ctx.ui.custom + SelectList 显示选择器；
//   pi.appendEntry 把当前预设名写入会话；before_agent_start 追加 instructions。文件写入仅由配置作者完成。
// 能力：
//   Preset / PresetsConfig    单个预设与“名称 -> 预设”的配置形状。
//   loadPresets()             读取并合并全局/项目配置，项目同名覆盖全局。
//   applyPreset()             应用模型/思考级别/工具，并记录当前预设。
//   buildPresetDescription()  生成选择器里的单行摘要。
//   showPresetSelector()      自定义 SelectList 选择器。
//   cyclePreset()             Ctrl+Shift+U 循环，包含 "(none)"。
//   updateStatus()            页脚状态显示。
//   默认导出函数               注册标志、命令、快捷键与三个阶段事件。
// 运行：准备好 presets.json 后 `pi --preset plan`，或会话中执行 /preset implement、按 Ctrl+Shift+U。
// 示例：--preset plan 会切换到配置的模型/思考级别/工具，并把 plan 的 instructions 追加到系统提示。
// 阅读顺序：先看 Preset 形状与 loadPresets 的合并规则，再看 applyPreset 的状态快照，最后看
//   session_start 的恢复逻辑和 turn_start 的持久化。

/**
 * Preset Extension
 *
 * Allows defining named presets that configure model, thinking level, tools,
 * and system prompt instructions. Presets are defined in JSON config files
 * and can be activated via CLI flag, /preset command, or Ctrl+Shift+U to cycle.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/presets.json (global)
 * - <cwd>/.pi/presets.json (project-local)
 *
 * Example presets.json:
 * ```json
 * {
 *   "plan": {
 *     "provider": "openai-codex",
 *     "model": "gpt-5.2-codex",
 *     "thinkingLevel": "high",
 *     "tools": ["read", "grep", "find", "ls"],
 *     "instructions": "You are in PLANNING MODE. Your job is to deeply understand the problem and create a detailed implementation plan.\n\nRules:\n- DO NOT make any changes. You cannot edit or write files.\n- Read files IN FULL (no offset/limit) to get complete context. Partial reads miss critical details.\n- Explore thoroughly: grep for related code, find similar patterns, understand the architecture.\n- Ask clarifying questions if requirements are ambiguous. Do not assume.\n- Identify risks, edge cases, and dependencies before proposing solutions.\n\nOutput:\n- Create a structured plan with numbered steps.\n- For each step: what to change, why, and potential risks.\n- List files that will be modified.\n- Note any tests that should be added or updated.\n\nWhen done, ask the user if they want you to:\n1. Write the plan to a markdown file (e.g., PLAN.md)\n2. Create a GitHub issue with the plan\n3. Proceed to implementation (they should switch to 'implement' preset)"
 *   },
 *   "implement": {
 *     "provider": "anthropic",
 *     "model": "claude-sonnet-4-5",
 *     "thinkingLevel": "high",
 *     "tools": ["read", "bash", "edit", "write"],
 *     "instructions": "You are in IMPLEMENTATION MODE. Your job is to make focused, correct changes.\n\nRules:\n- Keep scope tight. Do exactly what was asked, no more.\n- Read files before editing to understand current state.\n- Make surgical edits. Prefer edit over write for existing files.\n- Explain your reasoning briefly before each change.\n- Run tests or type checks after changes if the project has them (npm test, npm run check, etc.).\n- If you encounter unexpected complexity, STOP and explain the issue rather than hacking around it.\n\nIf no plan exists:\n- Ask clarifying questions before starting.\n- Propose what you'll do and get confirmation for non-trivial changes.\n\nAfter completing changes:\n- Summarize what was done.\n- Note any follow-up work or tests that should be added."
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi --preset plan` - start with plan preset
 * - `/preset` - show selector to switch presets mid-session
 * - `/preset implement` - switch to implement preset directly
 * - `Ctrl+Shift+U` - cycle through presets
 *
 * CLI flags always override preset values.
 */

// 同步文件 API：存在性检查与读取；示例在 session_start 中一次性加载配置。
import { existsSync, readFileSync } from "node:fs";
// join 用于拼跨平台路径；不解析符号链接。
import { join } from "node:path";
// Api/Model 只作类型参数，描述模型注册表返回的模型形状。
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// CONFIG_DIR_NAME 是项目配置目录名（.pi）；getAgentDir 定位全局 agent 目录；
// DynamicBorder 随内容宽度变化的上下边框。
import { CONFIG_DIR_NAME, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
// Container 组合多个组件；Key 声明快捷键；SelectItem/SelectList 是列表选择组件；Text 是静态文本。
import { Container, Key, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

// Preset configuration
// 单个预设的所有字段都是可选的：只写声明的部分，其余保持当前值。
// 字段来自 JSON 配置，加载时不做 schema 校验；错误类型会在使用处按字符串/数组操作时暴露。
interface Preset {
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model ID (e.g., "claude-sonnet-4-5") */
	model?: string;
	/** Thinking level */
	// 字面量联合同时是编译期约束和运行时允许值；JSON 中的其他字符串不会被这里拦截。
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Tools to enable (replaces default set) */
	tools?: string[];
	/** Instructions to append to system prompt */
	instructions?: string;
}

// 索引签名：任意预设名映射到一个 Preset；JSON.parse 的结果被断言成此类型。
interface PresetsConfig {
	[name: string]: Preset;
}

/**
 * Load presets from config files.
 * Project-local presets override global presets with the same name.
 */
// 读取两个位置的 presets.json 并合并。输入：cwd；输出：名称到预设的对象；副作用：读文件、出错时写 stderr。
// 错误处理是“记录并继续”：单个文件解析失败不会阻止另一个文件生效，也不会抛出到事件循环。
// 示例：全局有 plan=v1，项目有 plan=v2 时返回的 plan 是 v2；项目没有的预设保留全局值。
function loadPresets(cwd: string): PresetsConfig {
	const globalPath = join(getAgentDir(), "presets.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "presets.json");

	// 先给空对象，文件不存在时保持为空，合并逻辑无需额外分支。
	let globalPresets: PresetsConfig = {};
	let projectPresets: PresetsConfig = {};

	// Load global presets
	if (existsSync(globalPath)) {
		try {
			const content = readFileSync(globalPath, "utf-8");
			// JSON.parse 是信任边界：返回值 any/unknown，此处直接断言为 PresetsConfig，不校验字段类型。
			globalPresets = JSON.parse(content);
		} catch (err) {
			// 读取或解析失败都进入这里；示例仅报告，不中断扩展加载。
			console.error(`Failed to load global presets from ${globalPath}: ${err}`);
		}
	}

	// Load project presets
	if (existsSync(projectPath)) {
		try {
			const content = readFileSync(projectPath, "utf-8");
			// 同上：JSON 结构与字段类型未在运行时验证，写错配置可能导致后续字段访问异常。
			projectPresets = JSON.parse(content);
		} catch (err) {
			console.error(`Failed to load project presets from ${projectPath}: ${err}`);
		}
	}

	// Merge (project overrides global)
	// 展开顺序决定优先级：后展开的 projectPresets 覆盖同名全局预设。
	return { ...globalPresets, ...projectPresets };
}

// 应用第一个预设前的“原始状态”快照，用于选择 (none) 时恢复。
// model 可能为 undefined（尚未选择模型）；tools 是工具名列表，不是工具对象。
interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools: string[];
}

// 扩展入口。输入：宿主 API；输出：无；副作用是注册标志、命令、快捷键和事件处理器。
// 闭包状态：presets 配置、当前预设名/对象、应用前快照；这些状态不写入磁盘，除预设名外不跨会话保存。
export default function presetExtension(pi: ExtensionAPI) {
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	// Register --preset CLI flag
	// 声明字符串标志；真正读取在 session_start，CLI 解析与扩展加载顺序由宿主保证。
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});

	/**
	 * Apply a preset configuration.
	 */
	// 应用预设。输入：名称、预设对象、扩展上下文；输出：是否完成（当前实现总是 true）。
	// 副作用：可能切换模型/思考级别/工具，发出警告通知，并更新 activePresetName/activePreset。
	// setModel 返回 false（未配置认证）时只警告并继续应用其余字段；若它抛错，异常会跳出本函数，
	// 已执行的切换不会回滚。因此“部分失败继续”只适用于返回 false 的路径。
	// 示例：applyPreset("plan", { provider:"anthropic", model:"claude-sonnet-4-5", tools:["read"] }, ctx)。
	async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<boolean> {
		// Snapshot state before the first preset is applied (i.e. only when transitioning from no-preset)
		// 仅在“从无预设进入预设”时快照；预设 A -> B 不会覆盖原始状态，(none) 仍能恢复到最初配置。
		if (activePresetName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		// Apply model if specified
		// provider 与 model 必须同时存在才尝试切换；只写一个时静默跳过。
		if (preset.provider && preset.model) {
			// find 只查注册表，不发起网络；返回 undefined 表示该 provider/model 未注册。
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (model) {
				// setModel 返回 Promise<boolean>：false 表示该 provider 未配置认证，此时不会切换；
				// 已配置认证但切换过程失败时，Promise 会 reject，而不是返回 false。
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(`Preset "${name}": No API key for ${preset.provider}/${preset.model}`, "warning");
				}
			} else {
				ctx.ui.notify(`Preset "${name}": Model ${preset.provider}/${preset.model} not found`, "warning");
			}
		}

		// Apply thinking level if specified
		// 空字符串不会进入；setThinkingLevel 同步修改会话设置。
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools if specified
		// 空数组等同于未指定，避免把工具全关掉；配置中的未知工具名会被过滤。
		if (preset.tools && preset.tools.length > 0) {
			const allToolNames = pi.getAllTools().map((t) => t.name);
			// 两次 filter 得到互补集合：可用工具用于设置，未知工具仅用于提示。
			const validTools = preset.tools.filter((t) => allToolNames.includes(t));
			const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));

			if (invalidTools.length > 0) {
				ctx.ui.notify(`Preset "${name}": Unknown tools: ${invalidTools.join(", ")}`, "warning");
			}

			// 只有至少一个有效工具时才替换工具集；全部无效则保留当前工具。
			if (validTools.length > 0) {
				pi.setActiveTools(validTools);
			}
		}

		// Store active preset for system prompt injection
		// 记录预设用于 before_agent_start 注入 instructions；即使前面的模型/工具应用失败也会记录。
		activePresetName = name;
		activePreset = preset;

		return true;
	}

	/**
	 * Build description string for a preset.
	 */
	// 生成选择器里的一行摘要。输入：预设；输出：用 " | " 连接的字段描述；无副作用。
	// instructions 超过 30 字符时保留前 27 个再加 "..."（总长 30）。
	// 示例：{provider:"anthropic",model:"x",thinkingLevel:"high"} -> "anthropic/x | thinking:high"。
	function buildPresetDescription(preset: Preset): string {
		const parts: string[] = [];

		if (preset.provider && preset.model) {
			parts.push(`${preset.provider}/${preset.model}`);
		}
		if (preset.thinkingLevel) {
			parts.push(`thinking:${preset.thinkingLevel}`);
		}
		if (preset.tools) {
			// join 不排序，保留配置中的顺序。
			parts.push(`tools:${preset.tools.join(",")}`);
		}
		if (preset.instructions) {
			// 三目表达式避免短文本也被截断；slice 以 UTF-16 码元计，不按显示宽度。
			const truncated =
				preset.instructions.length > 30 ? `${preset.instructions.slice(0, 27)}...` : preset.instructions;
			parts.push(`"${truncated}"`);
		}

		return parts.join(" | ");
	}

	/**
	 * Show preset selector UI using custom SelectList component.
	 */
	// 弹出预设选择器。输入：扩展上下文；输出：Promise<void>；副作用：显示 custom UI、应用选择、更新状态。
	// 取消（Esc）时 result 为 null，直接返回；选择 (none) 恢复快照；其余按名称应用。
	// 示例：列表显示 plan/implement 与 "(none)"，选中 implement 后立即切换并提示。
	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const presetNames = Object.keys(presets);

		// 没有配置时只提示两个可放配置文件的位置，不打开空列表。
		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add presets to ${join(getAgentDir(), "presets.json")} or ${join(ctx.cwd, CONFIG_DIR_NAME, "presets.json")}`,
				"warning",
			);
			return;
		}

		// Build select items with descriptions
		// SelectItem 的 value 是选中后返回的值，label 是显示文本，description 是次要说明。
		const items: SelectItem[] = presetNames.map((name) => {
			const preset = presets[name];
			const isActive = name === activePresetName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildPresetDescription(preset),
			};
		});

		// Add "None" option to clear preset
		// "(none)" 是保留值，配置里同名预设会被这个选项遮蔽。
		items.push({
			value: "(none)",
			label: "(none)",
			description: "Clear active preset, restore defaults",
		});

		// custom 的泛型是 done 的返回类型；组件用对象字面量实现 Component 所需方法。
		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			// 动态边框随容器宽度绘制，颜色由主题 accent 提供。
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			// Header
			container.addChild(new Text(theme.fg("accent", theme.bold("Select Preset"))));

			// SelectList with themed styling
			// 第二个参数是可见行数，最多 10 行；超出的列表通过滚动查看。
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			// 回调里调用 done 关闭 custom：选中返回 value，取消返回 null。
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			// Footer hint
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));

			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			// 返回 Component 适配层：把渲染/失效/输入转发给容器与列表。
			return {
				// Let PageUp/PageDown page the list instead of scrolling the fullscreen transcript.
				// 把列表对翻页键的捕获能力上报给宿主，避免按键被外层 transcript 抢走。
				capturesViewportInput: selectList.capturesViewportInput,
				render(width: number) {
					// 宽度由宿主传入，容器据此布局子组件。
					return container.render(width);
				},
				invalidate() {
					// 清空子组件缓存，下一次 render 重新计算。
					container.invalidate();
				},
				handleInput(data: string) {
					// 先交给列表处理选择/取消，再主动请求重绘以显示高亮变化。
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		// null 表示用户取消，不改变当前预设。
		if (!result) return;

		if (result === "(none)") {
			// Clear preset and restore original state
			// 清空活动预设名称，使 before_agent_start 不再注入 instructions，并让下次应用重新快照。
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				// 逐个恢复；model 为 undefined 时跳过，避免把“无模型”当成可设置值。
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				pi.setActiveTools(originalState.tools);
			} else {
				// 没有快照时用内置默认工具集兜底。
				pi.setActiveTools(["read", "bash", "edit", "write"]);
			}
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			return;
		}

		const preset = presets[result];
		if (preset) {
			await applyPreset(result, preset, ctx);
			ctx.ui.notify(`Preset "${result}" activated`, "info");
			updateStatus(ctx);
		}
	}

	/**
	 * Update status indicator.
	 */
	// 更新页脚预设状态。输入：扩展上下文；输出/副作用：setStatus 写入或清除 "preset" 片段。
	// 预设名用 accent 色显示；没有活动预设时传 undefined 移除片段。
	function updateStatus(ctx: ExtensionContext) {
		if (activePresetName) {
			ctx.ui.setStatus("preset", ctx.ui.theme.fg("accent", `preset:${activePresetName}`));
		} else {
			ctx.ui.setStatus("preset", undefined);
		}
	}

	// 返回按名称排序的预设名，保证 Ctrl+Shift+U 循环顺序稳定；不依赖配置对象的属性顺序，
	// 也不会让整数样式的键按数值排在字符串键前面而改变循环次序。
	function getPresetOrder(): string[] {
		return Object.keys(presets).sort();
	}

	// 循环到下一个预设（含 "(none)"）。输入：扩展上下文；输出：Promise<void>。
	// 副作用：可能恢复快照或应用预设，并发通知/更新状态。
	// 示例：当前 plan，排序后 [implement, plan]，循环列表 ["(none)", "implement", "plan"]，
	//   下一次是 implement；在 plan 时下一次回到 "(none)"。
	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const presetNames = getPresetOrder();
		if (presetNames.length === 0) {
			ctx.ui.notify(
				`No presets defined. Add presets to ${join(getAgentDir(), "presets.json")} or ${join(ctx.cwd, CONFIG_DIR_NAME, "presets.json")}`,
				"warning",
			);
			return;
		}

		// 第一个元素是清除项；?? 把“无活动预设”映射为 "(none)"。
		const cycleList = ["(none)", ...presetNames];
		const currentName = activePresetName ?? "(none)";
		const currentIndex = cycleList.indexOf(currentName);
		// 当前名称不在列表（例如配置被删）时从 0 开始；否则取模回绕。
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
		const nextName = cycleList[nextIndex];

		// nextName 一定存在（数组非空且取模在范围内）；命中 "(none)" 时恢复快照。
		if (nextName === "(none)") {
			// 与选择器中的清除逻辑一致：恢复快照并移除状态。
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				pi.setActiveTools(originalState.tools);
			} else {
				pi.setActiveTools(["read", "bash", "edit", "write"]);
			}
			ctx.ui.notify("Preset cleared, defaults restored", "info");
			updateStatus(ctx);
			return;
		}

		const preset = presets[nextName];
		if (!preset) return;

		await applyPreset(nextName, preset, ctx);
		ctx.ui.notify(`Preset "${nextName}" activated`, "info");
		updateStatus(ctx);
	}

	// Ctrl+Shift+U 快捷键：用 Key 构造函数生成可配置按键标识，handler 复用 cyclePreset。
	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: async (ctx) => {
			await cyclePreset(ctx);
		},
	});

	// Register /preset command
	// /preset 命令：有参数时按名称直接应用，无参数时打开选择器。
	// args 是命令后的原始文本；?.trim() 同时处理 undefined 与空白。
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			// If preset name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();
				const preset = presets[name];

				if (!preset) {
					// 未找到时列出可用名称；空对象时显示 "(none defined)"。
					const available = Object.keys(presets).join(", ") || "(none defined)";
					ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, "error");
					return;
				}

				await applyPreset(name, preset, ctx);
				ctx.ui.notify(`Preset "${name}" activated`, "info");
				updateStatus(ctx);
				return;
			}

			// Otherwise show selector
			await showPresetSelector(ctx);
		},
	});

	// Inject preset instructions into system prompt
	// 每轮开始前把活动预设的 instructions 追加到系统提示；返回的 systemPrompt 会替换本轮完整提示。
	// 示例：plan 预设的 instructions 以 "\n\n" 与现有提示分隔，避免粘连上一段最后一行。
	pi.on("before_agent_start", async (event) => {
		if (activePreset?.instructions) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}`,
			};
		}
		// 无活动预设或无指令时不干预本轮提示。
	});

	// Initialize on session start
	// 会话启动：加载配置、处理 --preset 标志、从历史记录恢复预设名、刷新页脚。
	// 顺序很重要：标志优先于历史恢复，因为 CLI 参数代表用户本次显式选择。
	pi.on("session_start", async (_event, ctx) => {
		// Load presets from config files
		// 每次会话启动重新读取，配置文件改动在新会话中生效；同一会话内不热更新。
		presets = loadPresets(ctx.cwd);

		// Check for --preset flag
		// getFlag 的返回类型包含非字符串；typeof 检查是运行时边界（CLI 输入）。
		const presetFlag = pi.getFlag("preset");
		if (typeof presetFlag === "string" && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated`, "info");
			} else {
				const available = Object.keys(presets).join(", ") || "(none defined)";
				ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, "warning");
			}
		}

		// Restore preset from session state
		// 会话条目是持久化数据（信任边界）：这里按 type/customType 过滤，再用 as 断言 data 形状。
		// pop() 取最后一条，即本会话最近一次 turn_start 写入的预设名。
		const entries = ctx.sessionManager.getEntries();
		const presetEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "preset-state")
			.pop() as { data?: { name: string } } | undefined;

		// 有 --preset 时不恢复历史，避免覆盖显式标志；只恢复名称用于 instructions，不重复切换模型/工具。
		if (presetEntry?.data?.name && !presetFlag) {
			const preset = presets[presetEntry.data.name];
			if (preset) {
				activePresetName = presetEntry.data.name;
				activePreset = preset;
				// Don't re-apply model/tools on restore, just keep the name for instructions
			}
		}

		updateStatus(ctx);
	});

	// Persist preset state
	// 每轮开始时把当前预设名追加为自定义条目；恢复会话时据此重新注入 instructions。
	// 副作用：写入会话记录（持久化），不修改配置文件。
	pi.on("turn_start", async () => {
		if (activePresetName) {
			pi.appendEntry("preset-state", { name: activePresetName });
		}
	});
}
