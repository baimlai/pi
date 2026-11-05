/**
 * Streaming-Aware Input Gate
 *
 * Demonstrates `event.streamingBehavior` to skip expensive pre-processing
 * during mid-stream steering, where low latency matters.
 *
 * This extension prepends `git diff --stat` output when the user mentions
 * file changes, giving the model immediate context. During steering the
 * exec call is skipped so the correction reaches the model without delay.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/input-transform-streaming.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 正则按不区分大小写匹配独立英文单词 change/changes/diff/modified；没有 g，所以 test 不保留扫描位置。
const TRIGGER = /\b(changes?|diff|modified)\b/i;

// 注册输入转换器；涉及变更的输入会附上 git diff --stat，steer 输入直接通过。
// 例如 What changed? 不匹配 changed，而 show diff 匹配 diff；加载时不执行 Git，回调无持久化写入。
export default function (pi: ExtensionAPI) {
	// 异步输入回调根据事件决定是否执行一次本地只读 Git 命令。
	pi.on("input", async (event) => {
		// During steering, skip the exec call — corrections should be fast
		// 只在明确 steer 时跳过；followUp 和 undefined 均继续检查正文。
		if (event.streamingBehavior === "steer") {
			// 保持原输入，使正在生成中的纠正尽快送到后续流程。
			return { action: "continue" };
		}

		// 没有关键词时也不启动子进程。
		if (!TRIGGER.test(event.text)) {
			// 未匹配则保持正文与附图。
			return { action: "continue" };
		}

		// 等待 git diff --stat，只看未暂存的受跟踪文件差异；不是所有未提交变化的完整列表。
		const { stdout, code } = await pi.exec("git", ["diff", "--stat"]);
		// Git 失败或没有统计输出时不改写。
		if (code !== 0 || !stdout.trim()) {
			// 无可用统计直接继续。
			return { action: "continue" };
		}

		// 返回新的输入对象，宿主接着传给其他输入处理器。
		return {
			// transform 是判别字段，要求同时提供 text。
			action: "transform",
			// 在用户原文后加代码围栏和去掉首尾空白的统计；这是提示文字，不重新执行统计里的路径。
			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,
		};
	});
}
