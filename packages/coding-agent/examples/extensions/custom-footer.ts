// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./custom-footer.ts` 加载。
// 演示内容：用 /footer 在自定义单行页脚和内置页脚之间切换；自定义页脚累计 token/成本、显示模型和 git 分支。
// 上下游：命令 handler 调用 ctx.ui.setFooter；footer 工厂拿到 TUI、主题和只读 footerData；render 时读取 ctx.sessionManager.getBranch() 与 footerData.getGitBranch()，用 pi-tui 的宽度工具拼成一行。不调用模型、不写文件。
// 能力清单：
// - 默认导出 (pi: ExtensionAPI) => void：注册 /footer，维护 enabled 开关。
// - enabled 切换：开启时安装自定义 FooterComponent，关闭时 setFooter(undefined) 恢复内置页脚。
// - 自定义 render(width)：累计当前分支 assistant 消息的 usage，显示 ↑输入 ↓输出 $成本、模型 id 和分支。
// 典型运行顺序：启动会话 -> 输入 /footer -> 安装页脚并提示 -> 对话产生 assistant 消息 -> 每帧重算统计 -> 再输入 /footer -> 恢复内置页脚。
// 示例（真实签名）：
//   /footer
//   // 页脚示例："↑12.3k ↓4.5k $0.042  claude-sonnet-4 (main)"
// 阅读顺序：先看 /footer 的开关和 setFooter 工厂，再看 render 的统计循环，最后看左右布局和宽度截断。
// 前置与副作用：统计来自当前活动分支（getBranch），不是全部分支，也不等于当前上下文占用；历史越长每帧扫描成本越高。示例只在命令执行时安装页脚，没有在 session_start 重新安装，新会话是否保留取决于宿主 UI 生命周期。仅在 TUI 中能真正显示；非 TUI 模式 setFooter 可能无效。页脚宽度不足时会截断右侧内容。
/**
 * Custom Footer Extension - demonstrates ctx.ui.setFooter()
 *
 * footerData exposes data not otherwise accessible:
 * - getGitBranch(): current git branch
 * - getExtensionStatuses(): texts from ctx.ui.setStatus()
 *
 * Token stats come from ctx.sessionManager/ctx.model (already accessible).
 */

// import type 只引入类型；AssistantMessage 用于给已收窄的消息加 usage 字段类型，不改变运行时。
import type { AssistantMessage } from "@earendil-works/pi-ai";
// import type ExtensionAPI：只用于标注扩展入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// truncateToWidth/visibleWidth 按终端可见列处理 ANSI 颜色；用于让一行页脚适配宽度。
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// 扩展入口：注册 /footer 并保存一个扩展实例内的开关；加载时不安装页脚。
export default function (pi: ExtensionAPI) {
	// enabled 初始为 false，不持久化；扩展重载或重新加载后会回到关闭状态。
	let enabled = false;

	// /footer 不接受参数；命令名不带斜杠，description 用于命令列表。
	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		// 每次执行先翻转开关，再安装或恢复页脚；ctx 的 UI 生命周期由宿主管理。
		handler: async (_args, ctx) => {
			// 先更新状态；即使 setFooter 因模式不支持而无效，开关值也已经改变。
			enabled = !enabled;

			// 开启分支：setFooter 接收工厂，宿主在需要时调用它创建组件。
			if (enabled) {
				// 工厂参数是终端、主题和只读 footerData；footerData 提供分支与扩展状态。
				ctx.ui.setFooter((tui, theme, footerData) => {
					// 订阅分支变化；回调只请求重画，不重新计算 token。返回退订函数。
					const unsub = footerData.onBranchChange(() => tui.requestRender());

					// FooterComponent 需要 render 和 invalidate；dispose 可选，用于释放订阅。
					return {
						// dispose: unsub 是属性简写；宿主替换/移除页脚时应调用它取消订阅。
						dispose: unsub,
						// invalidate 为空：没有缓存需要清除。
						invalidate() {},
						// render(width) 返回单行数组；每帧都重新遍历当前分支并计算统计。
						render(width: number): string[] {
							// getBranch() 只返回当前活动分支的条目，不含其他分支；压缩条目也不是 assistant，会被跳过。
							// Compute tokens from ctx (already accessible to extensions)
							// 累计输入/输出 token 与成本；cost 是浮点数，最后按三位小数展示。
							let input = 0,
								output = 0,
								cost = 0;
							// 每次渲染都线性扫描分支；历史很长时会有成本，示例未缓存。
							for (const e of ctx.sessionManager.getBranch()) {
								// 只统计 assistant 消息；type/role 判别联合让 TypeScript 收窄。
								if (e.type === "message" && e.message.role === "assistant") {
									// 收窄后 message 已应是 AssistantMessage；这里的 as 只是显式标注，不做运行时检查。
									const m = e.message as AssistantMessage;
									// usage 来自模型响应；这是历史累计值，不是当前上下文窗口占用。
									input += m.usage.input;
									output += m.usage.output;
									cost += m.usage.cost.total;
								}
							}

							// footerData.getGitBranch() 同步返回缓存的分支名或 null；它不会在这里启动 git 进程。
							// Get git branch (not otherwise accessible)
							// getGitBranch 可能返回 null；下面用条件表达式生成空串或括号片段。
							const branch = footerData.getGitBranch();
							// 小于 1000 原样显示，否则除以 1000 保留一位小数；1000 -> "1.0k"。
							const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

							// 左半部分显示累计 token 与成本；↑/↓ 只是文字符号，不参与计算。
							const left = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)} $${cost.toFixed(3)}`);
							// branch 为 null/空串时不显示括号。
							const branchStr = branch ? ` (${branch})` : "";
							// 右半部分显示当前模型 id；没有模型时用 no-model。
							const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

							// 用可见宽度计算空格数，至少留 1 个；宽度不足时仍先留 1，再由 truncateToWidth 截断。
							const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
							// 最终只返回一行；truncateToWidth 会保留 ANSI 转义并按可见列截断，可能切掉右侧内容。
							return [truncateToWidth(left + pad + right, width)];
						},
					};
				});
				// 安装后立即提示；实际页脚可能要到下一次重画才出现。
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				// 关闭时传 undefined 恢复内置页脚；dispose 由宿主在替换时调用。
				ctx.ui.setFooter(undefined);
				// 恢复成功提示；enabled 已变为 false。
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
