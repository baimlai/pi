// 文件导读
// 所属：packages/coding-agent/examples/extensions 的扩展示例；用 `pi -e ./inline-bash.ts` 加载。
// 演示内容：在用户输入发送给模型前，把 !{command} 替换为本地 bash 输出；保留整行 !command 的旧行为。
// 上下游：input 事件 -> 检查/执行 pi.exec("bash",["-c",...]) -> 修改文本并返回 transform；ctx 只用于通知。无模型 API 调用，但输出会进入用户消息并被发送给模型。
// 能力清单：PATTERN/TIMEOUT_MS、整行 bash 跳过、顺序执行、通知摘要、images 透传。
// 典型运行顺序：输入 "What's in !{pwd}?" -> 匹配 -> 执行 pwd -> 用输出替换 -> input handler 返回 transform -> agent 收到替换后的用户消息。
// 示例（真实签名）：
//   What's in !{pwd}?
//   The current branch is !{git branch --show-current}
// 阅读顺序：先看整行 bash 跳过与 PATTERN，再看匹配收集/执行替换，最后看通知和 transform 返回。
// 前置与副作用：PATTERN 只匹配单层 !{...}，不支持内部 }、空命令或嵌套；整行检测用 trimStart，所以前置空白的 !cmd 也被当作整行 bash 跳过。命令顺序执行，每条 30s 超时，N 条最坏 N*30s；没有传 ctx.cwd，使用扩展加载 cwd。stdout 优先于 stderr：code 非零但 stderr 为空时不会标记错误，超时/截断也可能显示为成功。String.replace 使用字符串替换值，输出中的 $&、$1、$$ 会被解释为替换模式；如果输出本身含 !{...}，后续替换可能命中新插入的文本而不是原输入。替换只改第一处匹配，但循环按原匹配列表逐个替换。所有输出会进入用户消息和模型上下文；来源可能是不可信文件，存在提示注入风险。失败命令的 stderr/错误文本也会显示在通知里；非 TUI 只转换不通知。images 原样透传。
/**
 * Inline Bash Extension - expands inline bash commands in user prompts.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/inline-bash.ts
 *
 * Then type prompts with inline bash:
 *   What's in !{pwd}?
 *   The current branch is !{git branch --show-current} and status: !{git status --short}
 *   My node version is !{node --version}
 *
 * The !{command} patterns are executed and replaced with their output before
 * the prompt is sent to the agent.
 *
 * Note: Regular !command syntax (whole-line bash) is preserved and works as before.
 */
// import type 只引入类型；ExtensionAPI 用于标注入口，编译后擦除。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 扩展入口：把 input handler 注册到宿主；加载时不执行 bash。
export default function (pi: ExtensionAPI) {
	// 全局正则有 lastIndex 状态；test/exec 后会推进，下面在 test 成功后手动重置。
	const PATTERN = /!\{([^}]+)\}/g;
	// pi.exec 的 timeout 单位是毫秒；30000 即 30 秒，不是 30 毫秒。
	const TIMEOUT_MS = 30000;

	// input 事件在用户输入提交、发送给 agent 之前触发；返回 transform 可改写文本。
	pi.on("input", async (event, ctx) => {
		// 原始输入文本；images 另行保留，不参与替换。
		const text = event.text;

		// 英文注释：整行 bash（以 ! 开头）保持原行为；下面用 trimStart 判断。
		// Don't process if it's a whole-line bash command (starts with !)
		// This preserves the existing !command behavior
		// 以 ! 开头但不是 !{ 的内容视为整行 bash，交回宿主处理；!{ 则继续内联展开。
		if (text.trimStart().startsWith("!") && !text.trimStart().startsWith("!{")) {
			// continue 表示不修改文本，也不触发额外动作。
			return { action: "continue" };
		}

		// 先测试是否存在内联模式；没有则直接放行，避免无谓的 execute。
		// Check if there are any inline bash patterns
		// test 成功时 lastIndex 停在匹配之后；失败时 JS 会把它重置为 0。
		if (!PATTERN.test(text)) {
			// 没有内联命令，保持原输入。
			return { action: "continue" };
		}

		// 成功 test 后重置全局正则，保证下面的 exec 从字符串开头查找。
		// Reset regex state after test()
		PATTERN.lastIndex = 0;

		// result 是可变的替换累积器；matches 则保存原始文本里的所有匹配。
		let result = text;
		// expansions 收集命令、输出和可选错误，用于末尾通知。
		const expansions: Array<{ command: string; output: string; error?: string }> = [];

		// 先收集匹配再执行，避免边 exec 边 replace 改变正则位置。
		// Find all matches first (to avoid issues with replacing while iterating)
		// full 是完整 !{...}，command 是花括号内的命令文本。
		const matches: Array<{ full: string; command: string }> = [];
		// exec 从上次 lastIndex 继续；循环直到没有匹配。
		let match = PATTERN.exec(text);
		// 每个匹配只记录一次；空 command 不会被 PATTERN 匹配。
		while (match) {
			matches.push({ full: match[0], command: match[1] });
			match = PATTERN.exec(text);
		}

		// 按原输入顺序执行；前一条命令的输出不会影响后一条的命令文本。
		// Execute each command and collect results
		// 一个命令失败不会中断其他命令；所有结果都会收集。
		for (const { full, command } of matches) {
			// 只有 spawn/执行异常进入 catch；非零退出码走正常 ExecResult。
			try {
				// 未传 cwd，bash 使用扩展加载时的 cwd，而不是当前 ctx.cwd。
				const bashResult = await pi.exec("bash", ["-c", command], {
					// 每条命令独立 30s 超时；没有整体超时或取消信号。
					timeout: TIMEOUT_MS,
				});

				// stdout 优先；只有 stdout 为空时才使用 stderr；两者都空则为空串。
				const output = bashResult.stdout || bashResult.stderr || "";
				// 去掉首尾空白后再插入；内部换行保留。
				const trimmed = output.trim();

				// 非零退出且 stderr 非空时标记错误；stderr 为空时不会标记（可能被当成成功）。
				if (bashResult.code !== 0 && bashResult.stderr) {
					// 记录命令、输出和 "exit code N" 错误；output 仍可能是 stdout。
					expansions.push({
						command,
						output: trimmed,
						error: `exit code ${bashResult.code}`,
					});
					// 退出码为 0，或非零但没有 stderr：记录为普通输出。
				} else {
					expansions.push({ command, output: trimmed });
				}

				// String.replace 只替换第一个匹配；循环按 matches 顺序推进；替换值按字符串规则解释 $ 序列，输出中的 $&/$1/$$ 可能被展开。
				result = result.replace(full, trimmed);
			} catch (err) {
				// 外部边界：异常值可能不是 Error，所以用 instanceof 取 message。
				const errorMsg = err instanceof Error ? err.message : String(err);
				expansions.push({ command, output: "", error: errorMsg });
				// 异常也替换成可见的 [error: ...]；这条替换值同样受 $ 替换规则影响。
				result = result.replace(full, `[error: ${errorMsg}]`);
			}
		}

		// 通知仅在交互 UI 中存在；转换本身已经完成。
		// Show what was expanded (if UI available)
		// 至少执行过一条命令才显示摘要；没有匹配时不会到这里。
		if (ctx.hasUI && expansions.length > 0) {
			// map 把每条 expansion 转成一行摘要，join 用换行连接；status 附加错误，preview 截断到 50 字符。
			// slice 按 UTF-16 码元截断，可能切开 emoji；模板只拼接已计算字段，命令/输出可能含换行或控制字符。
			const summary = expansions
				.map((e) => {
					const status = e.error ? ` (${e.error})` : "";
					const preview = e.output.length > 50 ? `${e.output.slice(0, 50)}...` : e.output;
					return `!{${e.command}}${status} -> "${preview}"`;
				})
				.join("\n");

			// notify 级别固定 info，即使有命令失败；错误详情只在正文中。
			ctx.ui.notify(`Expanded ${expansions.length} inline command(s):\n${summary}`, "info");
		}

		// transform 返回新文本并保留 images；不返回 continue，避免后续 handler 再处理旧文本。
		return { action: "transform", text: result, images: event.images };
	});
}
