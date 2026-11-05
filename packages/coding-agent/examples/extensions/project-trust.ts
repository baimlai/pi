// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示 project_trust 事件：在加载项目本地资源（.pi、AGENTS.md/CLAUDE.md、.agents/skills）前，
//   由扩展决定是否信任当前项目，并可选要求宿主记住选择。
// 上游：全局安装到 ~/.pi/agent/extensions/，或用 -e 指定；宿主在会话启动的信任解析阶段调用处理器。
// 下游：ctx.ui.select/input 收集决定；返回 { trusted: "yes"|"no"|"undecided", remember? }。
//   本示例不直接写信任存储，remember 的处理由宿主的信任流程负责；note 只显示、不持久化。
// 能力：
//   默认导出函数  注册 project_trust 处理器与 session_start 提示。
//   loadCount     扩展模块加载次数（不是 project_trust 触发次数）。
// 典型顺序：启动 -> 检测项目资源 -> project_trust -> 用户选择 -> 首个别于 undecided 的结果生效 ->
//   信任解析完成 -> session_start 提示已加载。
// 示例：有 .pi 目录的项目中启动，选择 "Trust and remember" 后当前项目被信任并记住。
// 阅读顺序：先看返回值三态，再看非交互分支，最后看每个选项映射到的结果。

/**
 * Project Trust Extension
 *
 * Demonstrates the project_trust event. Install globally or pass via -e:
 *
 *   mkdir -p ~/.pi/agent/extensions
 *   cp packages/coding-agent/examples/extensions/project-trust.ts ~/.pi/agent/extensions/
 *
 * Or:
 *
 *   pi -e packages/coding-agent/examples/extensions/project-trust.ts
 *
 * Try it in a project containing .pi, AGENTS.md/CLAUDE.md, or .agents/skills.
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

// 扩展入口。输入：宿主 API；输出：无；副作用是注册信任处理器与启动提示。
// 该扩展本身在信任解析前加载；session_start 的提示只用于证明启动已越过信任阶段。
export default function (pi: ExtensionAPI) {
	let loadCount = 0;
	// 这行只在扩展模块加载时执行一次（每次加载/重载各一次），不会随 project_trust 事件递增。
	loadCount++;

	// Multiple handlers in one extension are allowed. The first handler that returns
	// { trusted: "yes" } or { trusted: "no" } wins and suppresses the built-in
	// trust prompt. Return { trusted: "undecided" } to let another handler or the
	// built-in flow decide.
	// 显式标注返回 Promise<ProjectTrustEventResult>：该事件的处理器必须给出决定对象，不能返回 undefined。
	pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
		// 显示目录、当前模式和加载序号，便于确认事件在何时触发。
		ctx.ui.notify(`project_trust fired for ${event.cwd} (mode: ${ctx.mode}, load: ${loadCount})`, "info");

		// 非交互模式下无法询问用户；返回 undecided 交回内建流程（通常默认不信任）。
		if (!ctx.hasUI) {
			return { trusted: "undecided" };
		}

		// 选择结果可能为 undefined（取消）；下面的 if 链会把未匹配值落到最后的 undecided。
		const choice = await ctx.ui.select(`Project trust for:\n${event.cwd}`, [
			"Trust and remember",
			"Trust with note and remember",
			"Trust this session",
			"Do not trust this session",
			"Let built-in prompt decide",
		]);

		// 带备注分支：input 返回用户输入或 undefined；示例只提示，不把 note 写入信任存储。
		if (choice === "Trust with note and remember") {
			const note = await ctx.ui.input("Project trust note", "Optional note for this demo");
			ctx.ui.notify(note ? `Recorded demo note: ${note}` : "No demo note entered", "info");
			// remember: true 请求宿主持久化信任决定；“记住备注”本身不在宿主 API 中。
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust and remember") {
			return { trusted: "yes", remember: true };
		}
		if (choice === "Trust this session") {
			// 不带 remember，只影响当前会话。
			return { trusted: "yes" };
		}
		if (choice === "Do not trust this session") {
			return { trusted: "no" };
		}
		if (choice === "Let built-in prompt decide") {
			return { trusted: "undecided" };
		}
		// 取消或其他未预期返回值：不替用户做决定。
		return { trusted: "undecided" };
	});

	// 信任解析完成后进入 session_start；提示只用于演示事件顺序，不影响信任结果。
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(`project-trust example loaded after trust resolution in ${ctx.cwd}`, "info");
	});
}
