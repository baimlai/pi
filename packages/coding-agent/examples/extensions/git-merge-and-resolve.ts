// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./git-merge-and-resolve.ts` 加载。
// 演示内容：每次 agent_end 后检查当前工作分支；工作树干净时 fetch 上游并 merge --no-ff，冲突时把冲突文件和行范围作为 follow-up 发给 agent。
// 上下游：agent_end -> git rev-parse/status/fetch/merge；findConflicts 读取未合并文件；sendUserMessage 触发后续 agent run。ctx 提供 cwd/UI；所有 git 调用未传 cwd，使用扩展加载时的 cwd。
// 能力清单：
// - ConflictBlock：一个冲突块的文件、起始行、分隔行、结束行。
// - findConflicts(pi, cwd)：解析 git 未合并文件里的标准冲突标记。
// - formatRange/formatConflicts：把行号范围格式化为 follow-up 文本。
// - 默认导出：在 agent_end 中执行自动 fetch/merge 并发送冲突摘要。
// 典型运行顺序：agent 结束 -> 确认是 git 仓库 -> 若不在 merge 中且工作树干净，取 @{u}、fetch、merge -> 冲突则读取文件 -> 发送 follow-up。
// 示例（真实签名）：
//   pi -e ./examples/extensions/git-merge-and-resolve.ts
//   // 冲突后 follow-up 形如 "  src/app.ts:10-18 (ours 11-14, theirs 16-17)"
// 测试引用：packages/coding-agent/test/git-merge-and-resolve-extension.test.ts（fake exec/ctx，覆盖跳过、冲突与 follow-up 分支）。
// 阅读顺序：先看 findConflicts 的标记解析和 range 格式化，再看 agent_end 的仓库/merge 判定，最后看 follow-up 发送。
// 前置与副作用：自动 fetch/merge 没有确认，会访问网络并修改工作树；要求工作树干净（包括 untracked）。所有 pi.exec 都未传 cwd，findConflicts 只用 ctx.cwd 读文件，若两者不同会合并一个仓库却读另一个仓库的文件；git diff 路径通常相对仓库根，ctx.cwd 为子目录时 join 也可能错。status/fetch/merge 的退出码并非都检查：status 失败被当作干净，merge 非冲突失败后 conflicts 为空会静默返回。findConflicts 的 catch 静默跳过读不了的文件。formatConflicts 只发文件与行范围，不发 ours/theirs 的实际内容，和文件头描述不符。已处于未完成 merge 时 ref 固定为 MERGE_HEAD；只要冲突还在，每次 agent_end 都可能再次发 follow-up，可能重复触发。marker 解析不处理 diff3 的 base 段、嵌套冲突或异常 marker。
/**
 * Merge and Resolve
 *
 * Keeps the working branch up to date with its upstream tracking ref.
 * After each agent turn, fetches and merges. Clean merges complete
 * silently. When conflicts arise, the working tree is left dirty and
 * the agent receives a follow-up message listing each conflict block
 * with file, line range, and ours/theirs sections so it can resolve them.
 * Also re-sends unresolved conflicts from a previous incomplete merge.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/git-merge-and-resolve.ts
 */
// createReadStream 读取工作树文件，join 拼路径；readline 逐行解析冲突标记。
import { createReadStream } from "node:fs";
// node:path 的 join 使用平台分隔符；git 输出路径通常用 /，在 Windows 上也能被 join 处理。
import { join } from "node:path";
// createInterface 把文件流变成异步行迭代器；for await 会等待每一行。
import { createInterface } from "node:readline";
// import type 只引入类型；ExtensionAPI 用于函数参数标注。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 一个冲突块的范围都按 1 起始的行号记录；separatorLine 是 ======= 行。
interface ConflictBlock {
	file: string;
	startLine: number;
	separatorLine: number;
	endLine: number;
}

// 读取 git 未合并文件，解析标准冲突标记，返回每个冲突块的文件与行号范围。
// 输入 pi 执行 git、cwd 读取文件；输出 ConflictBlock[]；只读，无其他副作用。
// 流程：git diff --diff-filter=U -> 逐文件 readline -> 记录 <<<<<<</=======/>>>>>>> 行号。
// 示例：一个文件含三段冲突标记时返回 [{file,startLine,separatorLine,endLine}]。
/** Parse conflict markers from working tree files with unmerged paths. */
async function findConflicts(pi: ExtensionAPI, cwd: string): Promise<ConflictBlock[]> {
	// 未传 {cwd}：git 使用扩展加载时的 cwd，而不是参数里的 cwd；参数只用于读取文件。
	const { stdout, code } = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
	// 非零退出（不是仓库/权限等）或没有未合并文件时返回空数组，调用方会静默结束。
	if (code !== 0 || !stdout.trim()) return [];

	// 收集所有文件的冲突块；文件之间不排序，顺序来自 git diff。
	const blocks: ConflictBlock[] = [];
	// stdout.trim().split 按行遍历；路径含换行时 git 默认会加引号，join 前不会解码。
	for (const file of stdout.trim().split("\n")) {
		// 单个文件读取/解析失败被下面的空 catch 吞掉，不影响其他文件。
		try {
			// createReadStream 的错误可能通过流事件或 for-await 抛出；for await 在 readline 关闭时结束。
			const rl = createInterface({ input: createReadStream(join(cwd, file), "utf-8") });
			// lineNo 从 1 开始，与编辑器和 git 的行号习惯一致。
			let lineNo = 0;
			// blockStart/separatorLine 记录当前尚未闭合的冲突块；undefined 表示不在块内。
			let blockStart: number | undefined;
			let separatorLine: number | undefined;
			// for await 按行读取；遇到 I/O 错误会抛出到 try。
			for await (const line of rl) {
				// 每读一行先递增；标记行本身也占一行。
				lineNo++;
				// 新的 <<<<<<< 开始一个块；若上一个块没闭合，会被新块覆盖。
				if (line.startsWith("<<<<<<<")) {
					// 记录 ours 段之前的标记行；分隔行暂时清空。
					blockStart = lineNo;
					separatorLine = undefined;
					// ======= 只有在已看到起始标记时才生效。
				} else if (line.startsWith("=======") && blockStart !== undefined) {
					separatorLine = lineNo;
					// 结束标记要求起始和分隔都存在，避免把普通文本当成完整冲突。
				} else if (line.startsWith(">>>>>>>") && blockStart !== undefined && separatorLine !== undefined) {
					// 行号范围包含起止标记；formatConflicts 再排除标记行。
					blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNo });
					// 重置状态，允许同一文件里有多个冲突块。
					blockStart = undefined;
					separatorLine = undefined;
				}
			}
			// 空 catch 跳过无法读取/解析的文件；调用方不会收到错误。
		} catch {}
	}
	return blocks;
}

// 把行号范围格式化为 "empty" / 单行 / "start-end"；输入整数，输出字符串。
function formatRange(start: number, end: number): string {
	// 起始大于结束时说明 ours/theirs 段为空。
	if (start > end) return "empty";
	if (start === end) return `${start}`;
	return `${start}-${end}`;
}

// 把冲突块格式化为发给 agent 的 follow-up 文本：文件:起始-结束 (ours 范围, theirs 范围)。
// 只包含行号范围，不包含 ours/theirs 的实际内容；输入 ref 和 blocks，输出字符串，无副作用。
function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
	// 第一行说明合并来源；ref 可能是上游分支名，也可能是固定的 MERGE_HEAD。
	const lines = [`Merged ${ref} with conflicts:`, ""];
	for (const b of blocks) {
		// ours 段在起始标记和分隔标记之间，排除两个标记行。
		const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
		// theirs 段在分隔标记和结束标记之间，排除两个标记行。
		const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
		lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
	}
	// 最后追加行动指令；没有附带冲突正文。
	lines.push("", "Resolve these conflicts.");
	return lines.join("\n");
}

// 扩展入口：每次 agent_end 自动尝试同步上游；加载时不执行 git。
export default function (pi: ExtensionAPI) {
	// agent_end 可能被自动重试/压缩继续，不一定是最终空闲；本示例仍在每次结束时尝试 merge。
	pi.on("agent_end", async (_event, ctx) => {
		// 未传 cwd；rev-parse 使用扩展加载时的 cwd。
		const { code: revParseCode } = await pi.exec("git", ["rev-parse", "--git-dir"]);
		if (revParseCode !== 0) return;

		let ref = "MERGE_HEAD";

		// If not already in a merge, attempt one
		const { code: mergeHeadCode } = await pi.exec("git", ["rev-parse", "MERGE_HEAD"]);
		// MERGE_HEAD 存在说明已有未完成 merge；此时跳过新 merge，直接查找冲突。
		if (mergeHeadCode !== 0) {
			// Only attempt a new merge if the working tree is clean
			// status 的 code 没有检查；命令失败且 stdout 为空时会被当成干净工作树。
			const { stdout: status } = await pi.exec("git", ["status", "--porcelain"]);
			// 有任何未提交变化（含 untracked）就不自动 merge，避免覆盖用户改动。
			if (status.trim()) return;

			const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]);
			// 没有 upstream 配置时直接返回，不 fetch/merge。
			if (upstreamCode !== 0) return;

			// 保存上游 tracking ref，例如 origin/main；后续 fetch/merge 都用它。
			ref = upstream.trim();
			// 取 ref 的第一段作为 remote 名；上游若是本地分支（无斜杠），这里会把分支名当 remote。
			const remote = ref.split("/")[0];
			// notify 是 UI 副作用，不等待用户确认；fetch/merge 仍会继续。
			ctx.ui.notify(`git-merge-and-resolve: fetching ${remote}, merging ${ref}`, "info");

			// fetch 未传 cwd 和 timeout；网络慢时可能长时间等待。
			const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", ["fetch", remote]);
			if (fetchCode !== 0) {
				ctx.ui.notify(`git-merge-and-resolve: fetch failed: ${fetchErr.trim()}`, "warning");
				return;
			}

			// merge 未传 cwd；非零退出既可能是冲突，也可能是其他错误。
			const { code: mergeCode } = await pi.exec("git", ["merge", "--no-ff", ref]);
			// 干净合并成功直接返回；非零继续走冲突解析。
			if (mergeCode === 0) return;
		}

		// 这里既可能是刚 merge 出的冲突，也可能是本来就未完成的 merge。
		// Either we just merged with conflicts, or we were already in an unfinished merge
		// findConflicts 用 ctx.cwd 读文件，但 git 命令本身用扩展加载 cwd；两者不一致时会错位。
		const conflicts = await findConflicts(pi, ctx.cwd);
		if (conflicts.length === 0) return;

		// 以 user 消息发送冲突摘要；deliverAs followUp 表示作为后续输入投递，可能启动新一轮 agent。
		pi.sendUserMessage(formatConflicts(ref, conflicts), { deliverAs: "followUp" });
	});
}
