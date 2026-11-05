// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到 ~/.pi/agent/extensions/ 或项目 .pi/extensions/ 后加载。
// 演示内容：提供 /commands，列出当前会话的动态斜杠命令（extension/prompt/skill），可按来源过滤，并在选择后显示命令源文件路径。
// 上下游：宿主调用 registerCommand 的 handler/getArgumentCompletions；handler 调用 pi.getCommands() 取命令快照，再用 ctx.ui.select/confirm/notify 交互。文件不读文件、不调用模型。
// 能力清单：
// - 默认导出 commandsExtension(pi: ExtensionAPI)：注册 /commands，加载时不读取命令表。
// - getArgumentCompletions(prefix)：对 extension/prompt/skill 做前缀补全；无匹配返回 null。
// - handler(args, ctx)：按来源过滤、分组展示、选中后可选显示 sourceInfo.path。
// 典型运行顺序：输入 /commands（或 /commands extension）-> 命令面板 -> 选择一条命令 -> 可选确认查看路径 -> notify 显示路径。
// 示例（真实签名）：
//   /commands extension
//   // 假设存在扩展命令 /hello，选择项形如 "/hello - Say hello"
// 阅读顺序：先看 registerCommand 的补全函数，再看 handler 的过滤/分组，最后看选中后的名称解析和路径确认。
// 前置与副作用：pi.getCommands() 只包含扩展/提示词/技能等动态命令，不包含内置命令；返回的是调用时快照。来源过滤参数用 as 断言，未知字符串不会被拒绝，只会得到空结果并提示。选择器里的 "--- 分组 ---" 是普通字符串，不是可执行命令；取消选择返回 undefined。sourceInfo.path 可选，没有路径时不会弹出确认。命令名按第一个 " - " 分段，带该子串的命令名可能解析错误（正常命令名不含空格）。无文件写入，notify 只是界面提示。
/**
 * Commands Extension
 *
 * Demonstrates the pi.getCommands() API by providing a /commands command
 * that lists all available slash commands in the current session.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /commands to see available commands
 * 3. Use /commands extensions to filter by source
 */

// import type 只引入类型；SlashCommandInfo 用于 formatCommand 的参数标注，运行时不会加载额外值。
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

// 扩展入口：注册 /commands；加载阶段不调用 getCommands，命令表在每次执行时重新获取。
// 示例：用户输入 /commands skill 后，处理函数筛选 source === "skill" 的命令并打开选择器。
export default function commandsExtension(pi: ExtensionAPI) {
	// 命令名不带斜杠；description 供 /help 或补全列表展示。
	pi.registerCommand("commands", {
		description: "List available slash commands",
		// 补全回调接收已输入前缀，返回 {value,label} 数组；null 表示不提供建议，不是空数组。
		getArgumentCompletions: (prefix) => {
			// 固定候选是命令来源分类；过滤的是 source 字段，不是命令名。
			const sources = ["extension", "prompt", "skill"];
			// startsWith 区分大小写；空前缀匹配全部三项。
			const filtered = sources.filter((s) => s.startsWith(prefix));
			// 只有至少一个匹配才 map；数组元素同时作为补全值和显示标签。
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		// handler：执行命令时读取命令表、过滤/分组并打开选择器；args 是原始参数，ctx 提供 UI。
		handler: async (args, ctx) => {
			// getCommands() 返回当前会话的动态命令快照（extension/prompt/skill），不含内置命令。
			const commands = pi.getCommands();
			// as 断言把任意字符串当成来源联合或空串；没有运行时校验，非法值只会在下面过滤成空数组。
			// 注意英文用法写的是 /commands extensions（复数），实际 source 值是单数 "extension"；照抄会得到空结果。
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";

			// Filter by source if specified
			// 有过滤词就按 source 精确匹配，否则保留全部；filter 返回新数组，不修改原快照。
			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			// 过滤结果为空时直接提示并结束；空来源字符串不会导致这个分支，除非命令表本身为空。
			if (filtered.length === 0) {
				// notify 第二参数限定 info/warning/error；这里即使“没找到”也用 info。
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			// Build selection items grouped by source
			// 把一条命令格式化为一行的 "/name - description"；description 可选。
			const formatCommand = (cmd: SlashCommandInfo): string => {
				// 没有 description 时 desc 为空串，避免留下 " - " 尾巴。
				const desc = cmd.description ? ` - ${cmd.description}` : "";
				return `/${cmd.name}${desc}`;
			};

			// items 混合分组标题和命令字符串，稍后交给 select；标题以 --- 开头用于区分。
			const items: string[] = [];
			// 用对象数组固定分组顺序和显示名；key 限定为 SlashCommandSource 的三个值。
			const sources: Array<{ key: "extension" | "prompt" | "skill"; label: string }> = [
				{ key: "extension", label: "Extensions" },
				{ key: "prompt", label: "Prompts" },
				{ key: "skill", label: "Skills" },
			];

			// 依次处理三个来源；每组只保留过滤后仍存在的命令。
			for (const { key, label } of sources) {
				// 再按 source 筛一次；filtered 可能已经按来源过滤，这里仍然成立。
				const cmds = filtered.filter((c) => c.source === key);
				if (cmds.length > 0) {
					// 分组标题也放进 items，因此选择器允许高亮它；后面的 selected 检查会忽略。
					items.push(`--- ${label} ---`);
					// map 生成命令行数组，展开后逐个 push；组内顺序继承 getCommands() 的返回顺序。
					items.push(...cmds.map(formatCommand));
				}
			}

			// Show in a selector (user can scroll and see all commands)
			// 打开选择器并等待用户操作；取消/Escape 时返回 undefined。
			const selected = await ctx.ui.select("Available Commands", items);

			// If user selected a command (not a header), offer to show its path
			// 排除分组标题；selected 为 undefined 或空串时也不处理。
			if (selected && !selected.startsWith("---")) {
				// 取第一个 " - " 前的部分并去掉开头的 "/"；description 中的 " - " 不会影响命令名解析。
				const cmdName = selected.split(" - ")[0].slice(1); // Remove leading /
				// 按 name 找到完整命令对象；getCommands() 已负责同名冲突的取舍。
				const cmd = commands.find((c) => c.name === cmdName);
				// sourceInfo.path 是可选字段；只有存在路径时才值得弹确认。
				if (cmd?.sourceInfo.path) {
					// confirm 返回 boolean；正文里用换行显示路径。
					const showPath = await ctx.ui.confirm(cmd.name, `View source path?\n${cmd.sourceInfo.path}`);
					if (showPath) {
						// 显示路径文本；确认不会打开编辑器，也不会执行该命令。
						ctx.ui.notify(cmd.sourceInfo.path, "info");
					}
				}
			}
		},
	});
}
