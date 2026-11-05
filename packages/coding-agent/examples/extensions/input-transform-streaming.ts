// 文件导读
// 所属：packages/coding-agent/examples/extensions，coding-agent 扩展示例系列。
// 作用：演示 pi 的 "input" 事件和 event.streamingBehavior。用户提到 change/changes/diff/modified 时，
//   扩展先执行 git diff --stat 并把统计附加到输入；如果这次输入是流式过程中插入的 steer 纠正，
//   就跳过子进程，让纠正尽快到达模型。
// 上游：用户用 `pi -e ./examples/extensions/input-transform-streaming.ts` 加载本文件，宿主调用默认导出
//   工厂登记 input 处理器，之后每次提交输入都会派发该事件。
// 下游：pi.exec 启动本地 git 进程读取工作区差异；返回值是 { action: "continue" | "transform" }，
//   交给宿主继续输入链。扩展本身不写文件、不改会话、失败时只是附加原输入。
// 能力：
//   TRIGGER                 匹配英文 change/changes/diff/modified 的正则常量。
//   默认导出函数             向 ExtensionAPI 注册一个 input 处理器。
// 典型顺序：加载扩展 -> 用户输入 -> 宿主派发 input -> 处理器检查 streamingBehavior 与正文 ->
//   必要时执行 git -> 返回 continue 或附注后的 transform。
// 示例：输入 `show diff`，模型收到的文字末尾会多出一段 "Current uncommitted changes" 代码围栏。
// 阅读顺序：先看 TRIGGER，再看默认导出里的 input 回调；pi.exec 的返回结构可参考 ExecResult 类型。

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

// ExtensionAPI 由宿主作为唯一参数传入；本函数只登记处理器，不自行读取输入。
// 注册输入转换器；涉及变更的输入会附上 git diff --stat，steer 输入直接通过。
// 例如 What changed? 不匹配 changed，而 show diff 匹配 diff；加载时不执行 Git，回调无持久化写入。
// 示例：默认导出签名固定为 (pi: ExtensionAPI) => void，宿主加载模块时调用一次。
export default function (pi: ExtensionAPI) {
	// "input" 是类型化事件名：handler 的事件类型是 InputEvent，返回类型必须落在 InputEventResult 联合里。
	// async 回调的返回值会被包成 Promise，宿主 await 后才继续输入链；抛出的异常由宿主事件链报告。
	// 异步输入回调根据事件决定是否执行一次本地只读 Git 命令。
	pi.on("input", async (event) => {
		// During steering, skip the exec call — corrections should be fast
		// 只在明确 steer 时跳过；followUp 和 undefined 均继续检查正文。
		if (event.streamingBehavior === "steer") {
			// 保持原输入，使正在生成中的纠正尽快送到后续流程。
			return { action: "continue" };
		}

		// event.text 是当前累计正文（前面的 transform 可能已经改过它），不是原始键盘输入。
		// 没有关键词时也不启动子进程。
		if (!TRIGGER.test(event.text)) {
			// 未匹配则保持正文与附图。
			return { action: "continue" };
		}

		// pi.exec 按参数数组启动进程，不经过 shell，所以这里不会有管道/重定向解析。ExecResult 的
		// code 是数字或 undefined（取消时），stdout 是文本；解构只取本次用到的两个字段。
		// 等待 git diff --stat，只看未暂存的受跟踪文件差异；不是所有未提交变化的完整列表。
		const { stdout, code } = await pi.exec("git", ["diff", "--stat"]);
		// Git 失败或没有统计输出时不改写。
		if (code !== 0 || !stdout.trim()) {
			// 无可用统计直接继续。
			return { action: "continue" };
		}

		// 返回新的输入对象，宿主接着传给其他输入处理器。
		// 省略 images 字段表示保留当前附图；若要清空附图应显式传 images: []。
		// 返回对象字面量由 InputEventResult 的判别联合检查。
		return {
			// transform 是判别字段，要求同时提供 text。
			action: "transform",
			// 在用户原文后加代码围栏和去掉首尾空白的统计；这是提示文字，不重新执行统计里的路径。
			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,
		};
	});
}
