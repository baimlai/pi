// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：在 before_agent_start 中读取 systemPromptOptions，根据本轮启用的工具和技能生成
//   <tool_guidance> 段；它修改结构化选项而不是替换/重新解析整份已渲染提示。
// 上游：全局或项目扩展目录加载；每轮 agent 启动前宿主派发事件。
// 下游：直接写 event.systemPromptOptions.sections.tool_guidance；没有匹配规则时删除该段。
//   不返回覆盖对象，也不改系统提示字符串本身；宿主之后统一渲染。
// 能力：
//   buildToolGuidance()  按 selectedTools/skills 拼接规则文本。
//   默认导出函数          注册 before_agent_start 处理器。
// 运行：加载后正常对话；启用/禁用 read/bash/edit/write 或安装技能，观察提示中的段变化。
// 示例：只启用 read 时提示含 read 的两条规则；全部禁用且无技能时 tool_guidance 段被删除。
// 阅读顺序：先看 buildToolGuidance 的条件与输出，再看处理器为何直接 mutate 而不 return。

/**
 * Prompt Customizer Extension
 *
 * Demonstrates using systemPromptOptions to add context-aware prompt sections
 * without replacing or reparsing the complete rendered prompt.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use the extension — it automatically adapts to your active tools and skills
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 根据本轮选项生成工具使用说明。输入：提示构建选项（selectedTools/skills 可能缺省）；
// 输出：以换行连接的规则文本，无匹配时为 ""；无副作用。
// hasTool 用 ?. 与 ?? false 处理 selectedTools 未提供的情况。
// 示例：selectedTools=["read","bash"] 且无技能时返回三条规则（read 两条 + bash 一条）。
function buildToolGuidance(options: BuildSystemPromptOptions): string {
	// selectedTools 缺省时视为没有工具；includes 只做字符串精确匹配。
	const hasTool = (name: string) => options.selectedTools?.includes(name) ?? false;
	const rules: string[] = [];

	if (hasTool("read")) {
		// 一次 push 多条规则；数组顺序就是最终提示中的顺序。
		rules.push(
			"- Use `read` for file contents; it supports text and images.",
			"- For large files, use `offset` and `limit` to read in chunks.",
		);
	}
	if (hasTool("bash")) {
		rules.push("- Use `bash` for file operations such as `ls`, `find`, and `grep`.");
	}
	if (hasTool("edit")) {
		rules.push("- Use `edit` for precise text replacements that match existing content exactly.");
	}
	if (hasTool("write")) {
		rules.push("- Use `write` to create new files or replace existing files completely.");
	}
	// skills 已加载的元信息数组；只取 name 列出，不读取技能正文。
	if (options.skills && options.skills.length > 0) {
		rules.push(`- Available skills: ${options.skills.map((skill) => skill.name).join(", ")}.`);
	}

	// 空数组 join 得到空字符串，处理器据此判断是否删除旧段。
	return rules.join("\n");
}

// 扩展入口。输入：宿主 API；输出：无；副作用是注册 before_agent_start 处理器。
// 处理器没有 async：这里只做同步字符串拼接和对象字段修改。
// 示例：切换工具集后，下一轮系统提示中的 tool_guidance 段随 selectedTools 变化。
export default function promptCustomizer(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		// event.systemPromptOptions 是本轮共享的可变选项，类型为 NormalizedBuildSystemPromptOptions，
		// 它是 BuildSystemPromptOptions 的超集，因此可直接传给参数类型更宽的 buildToolGuidance。
		const guidance = buildToolGuidance(event.systemPromptOptions);
		if (guidance) {
			// 段名 tool_guidance 必须是合法段名；宿主渲染时会包成 <tool_guidance>...</tool_guidance>。
			// 直接修改共享对象会让后续处理器看到该段；无需返回 systemPrompt。
			event.systemPromptOptions.sections.tool_guidance = guidance;
		} else {
			// 没有规则时删除段，避免上一轮的内容残留；delete 对不存在的键也安全。
			delete event.systemPromptOptions.sections.tool_guidance;
		}
	});
}
