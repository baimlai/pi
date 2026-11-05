// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；复制到扩展目录或 `pi -e ./dirty-repo-guard.ts` 加载。
// 演示内容：在新建/切换会话或分叉之前检查 git 工作区；有未提交变化时询问，用户不确认就返回 {cancel:true} 阻止操作。
// 上下游：注册 session_before_switch/session_before_fork 可取消事件；checkDirtyRepo 调用 pi.exec 运行 git status --porcelain，再通过 ctx.ui.select/notify 交互。不修改仓库、不调用模型。
// 能力清单：
// - checkDirtyRepo(pi, ctx, action)：异步检查；干净/非零退出返回 undefined 放行，有变化且无 UI 或用户拒绝时返回 {cancel:true}。
// - 默认导出 (pi: ExtensionAPI) => void：把 new/resume 和 fork 映射到检查函数。
// 典型运行顺序：用户执行 /new、恢复会话或分叉 -> 事件触发 -> git status -> 干净直接放行 -> 有变化时选择 -> 只有精确选择 Yes 才继续。
// 示例（真实签名）：
//   await ctx.ui.select("You have 2 uncommitted file(s). new session anyway?", ["Yes, proceed anyway", "No, let me commit first"])
//   // 选择 No 或按 Escape 时 checkDirtyRepo 返回 { cancel: true }
// 阅读顺序：先看 checkDirtyRepo 的放行/阻止分支，再看 action 文案和两个事件注册。
// 前置与副作用：必须在 git 仓库中；code !== 0 被统一当作“不是仓库”放行，权限/损坏/未安装等错误也会放行。非交互模式（ctx.hasUI=false）在脏仓库时默认阻止。文件数按 porcelain 输出行数估算，重命名等特殊格式可能不精确。select 的 undefined（Escape/取消）也会取消操作。示例没有把 ctx.cwd 传给 pi.exec；未指定 cwd 时使用扩展加载时的 cwd，若它与当前会话目录不同，检查的仓库可能不是用户以为的那个。检查本身只读，不暂存或提交。
/**
 * Dirty Repo Guard Extension
 *
 * Prevents session changes when there are uncommitted git changes.
 * Useful to ensure work is committed before switching context.
 */

// import type 只引入类型；ExtensionAPI 用于标注入口，ExtensionContext 用于 checkDirtyRepo 的 ctx 参数。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 检查工作区是否有未提交变化，并决定是否取消当前会话操作。
// 输入：pi 用来执行 git，ctx 提供 UI/模式，action 只用于提示文案；输出：undefined 表示放行，{cancel:true} 表示阻止。
// 流程：git status --porcelain -> 非零/干净放行 -> 无 UI 阻止 -> 有 UI 时询问 -> 非精确 Yes 阻止。
// 示例：checkDirtyRepo(pi, ctx, "fork") 在脏仓库且用户选 No 时解析为 { cancel: true }。
async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
	// pi.exec 返回 { stdout, code }；未传 options.cwd，因此使用扩展加载时的 cwd，不一定等于 ctx.cwd。
	// Check for uncommitted changes
	// --porcelain 输出稳定、适合脚本；每行一个变化。
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

	// code !== 0 被当作“不是仓库”放行；注释之外，也可能是权限/损坏/未安装等错误，同样放行。
	if (code !== 0) {
		// Not a git repo, allow the action
		return;
	}

	// trim 后为空说明没有变化；porcelain 会对特殊路径做引用，不会产生无意义的空行。
	const hasChanges = stdout.trim().length > 0;
	if (!hasChanges) {
		return;
	}

	// 非交互模式无法询问，默认阻止；这与 confirm-destructive 在无 UI 时放行的策略相反。
	if (!ctx.hasUI) {
		// In non-interactive mode, block by default
		return { cancel: true };
	}

	// 按行数估算变化文件数；重命名等特殊格式可能一行包含多个路径。
	// Count changed files
	// filter(Boolean) 去掉空行；计数只是提示用，不参与判断。
	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;

	// select 返回选中字符串或 undefined（取消/Escape）。
	const choice = await ctx.ui.select(`You have ${changedFiles} uncommitted file(s). ${action} anyway?`, [
		"Yes, proceed anyway",
		"No, let me commit first",
	]);

	// 只有精确选择 Yes 才放行；No、Escape 和取消都取消操作。
	if (choice !== "Yes, proceed anyway") {
		// 提示用户先提交；warning 级别比 info 更醒目。
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}
}

// 扩展入口：把两个可取消事件接到同一个检查函数；加载时不执行 git。
export default function (pi: ExtensionAPI) {
	// 新建/切换会话前检查；reason 只有 new/resume。
	pi.on("session_before_switch", async (event, ctx) => {
		// 把 reason 映射成提示中的动作文本；不影响取消逻辑。
		const action = event.reason === "new" ? "new session" : "switch session";
		// 把检查结果原样返回给事件系统；undefined 放行，{cancel:true} 阻止。
		return checkDirtyRepo(pi, ctx, action);
	});

	// 分叉前同样检查；不需要区分原因。
	pi.on("session_before_fork", async (_event, ctx) => {
		// 返回 Promise 结果，宿主等待异步检查完成。
		return checkDirtyRepo(pi, ctx, "fork");
	});
}
