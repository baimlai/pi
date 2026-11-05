// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./git-checkpoint.ts` 加载。
// 演示内容：每轮开始时用 git stash create 生成工作树快照，在 session_before_fork 时按分叉点查找快照，并询问是否用 git stash apply 恢复代码。
// 上下游：tool_result 更新 currentEntryId；turn_start 执行 git stash create 并写入 Map；session_before_fork 读取 Map 并可能 apply；agent_settled 清空 Map。ctx 用于 UI 和 sessionManager；git 命令使用扩展加载时的 cwd。
// 能力清单：
// - checkpoints: Map<entryId, stashRef>，保存每个检查点的 git 对象 id。
// - currentEntryId：最近一次 tool_result 后的叶子 entry id。
// - 四个事件回调：记录叶子、创建快照、分叉时恢复、结束时清空。
// 典型运行顺序：tool_result 记录叶子 -> 下一轮 turn_start 执行 git stash create -> 存 Map -> 用户分叉到该 entry -> select 询问 -> git stash apply -> 通知成功。
// 示例（真实签名）：
//   const { stdout } = await pi.exec("git", ["stash", "create"]);
//   const ref = stdout.trim();
//   checkpoints.set(currentEntryId, ref);
// 阅读顺序：先看 Map/currentEntryId 的更新，再看 stash create，最后看分叉恢复和清理。
// 前置与副作用：git stash create 只生成一个 dangling commit（不修改工作树、不加入 stash 列表），默认只包含已跟踪文件，未跟踪/忽略文件不在快照中；对象没有 ref 保护，git gc 可能回收。两次 pi.exec 都没检查 code，apply 失败也会 notify 成功。apply 是合并到当前工作树，不是重置；冲突时可能留下冲突标记。currentEntryId 只在 tool_result 时更新；首轮 turn_start 可能为 undefined，fork 到普通 user/assistant entry 时 Map 里没有对应 key。最关键的是 agent_settled 每轮结束都会 clear()，正常等 Agent 空闲后再分叉时 Map 已空，恢复分支几乎不会被触发。Map 不按会话隔离，currentEntryId 在 session 切换时也不会清空。git 使用扩展加载 cwd，不是 ctx.cwd。
/**
 * Git Checkpoint Extension
 *
 * Creates git stash checkpoints at each turn so /fork can restore code state.
 * When forking, offers to restore code to that point in history.
 */

// import type 只引入类型；ExtensionAPI 用于标注入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：维护进程内检查点表；加载时不执行 git。
export default function (pi: ExtensionAPI) {
	// entryId -> stash commit id；只存在于扩展实例内，不持久化。
	const checkpoints = new Map<string, string>();
	// 最近一次 tool_result 后的叶子 entry；会话切换时不会重置。
	let currentEntryId: string | undefined;

	// Track the current entry ID when user messages are saved
	// 英文注释说跟踪 user message，实际挂在 tool_result 上；每次工具结果后更新叶子。
	pi.on("tool_result", async (_event, ctx) => {
		// getLeafEntry 返回当前分支末端条目；没有条目时返回 undefined。
		const leaf = ctx.sessionManager.getLeafEntry();
		// 保存叶子 id，作为下一轮 stash 的 key；不是用户消息 id。
		if (leaf) currentEntryId = leaf.id;
	});

	// 每轮开始创建快照，尽量在模型修改文件之前记录。
	pi.on("turn_start", async () => {
		// Create a git stash entry before LLM makes changes
		// git stash create 不改变工作树；未传 cwd，使用扩展加载时的 cwd，且忽略 code/stderr。
		const { stdout } = await pi.exec("git", ["stash", "create"]);
		// 没有改动时 stdout 为空；有改动时是 stash commit 的 SHA。
		const ref = stdout.trim();
		// 没有 SHA 或还没有叶子 id 时跳过；首轮经常属于后者。
		if (ref && currentEntryId) {
			// 同一个 entryId 对应最新快照；重复 set 会覆盖旧值。
			checkpoints.set(currentEntryId, ref);
		}
	});

	// 分叉前用用户选择的 entry id 查快照；只匹配 tool_result 叶子，普通消息 entry 查不到。
	pi.on("session_before_fork", async (event, ctx) => {
		// event.entryId 是分叉点；Map 没有对应 key 时静默放行。
		const ref = checkpoints.get(event.entryId);
		// 没有快照就不恢复，也不提示。
		if (!ref) return;

		// 非交互模式不自动恢复，避免无人确认时改动工作树。
		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		// select 返回选中字符串或 undefined；两个选项都要用户主动选择。
		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		// 只以 Yes 开头的选择触发恢复；No、Escape 都保持当前代码。
		if (choice?.startsWith("Yes")) {
			// stash apply 把快照合并进当前工作树；失败/冲突不会在这里检查。
			await pi.exec("git", ["stash", "apply", ref]);
			// 无论 apply 是否成功都通知成功；这是示例的错误处理缺口。
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});

	// agent_settled 是整轮 agent 最终空闲信号；这里清空所有快照。
	pi.on("agent_settled", async () => {
		// Clear checkpoints after the full agent run completes
		// 清空后，正常等 Agent 空闲再 /fork 时已经找不到任何检查点，恢复逻辑基本不会触发。
		checkpoints.clear();
	});
}
