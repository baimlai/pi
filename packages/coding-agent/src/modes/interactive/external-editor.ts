// 把提示词放进独立临时文件，启动配置的外部编辑命令并在成功退出后读回；此helper不暂停/恢复TUI，也不把结果写回用户编辑器。
// spawn异步启动子进程，避免spawnSync同步等待；导入本身不启动程序。
import { spawn } from "node:child_process";
// 同步临时目录/文件读写和删除函数；进程等待异步不代表这些IO也异步。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// 读取宿主操作系统临时目录位置。
import { tmpdir } from "node:os";
// join按本机路径规则拼接目录与文件名。
import { join } from "node:path";
// stripBom只去已解码字符串开头一个BOM，不trim普通空白。
import { stripBom } from "../../utils/text.ts";

// 调用输入结构，只约束TS；外部命令字符串仍由下面的简单拆分规则解释。
export interface ExternalEditorOptions {
	// 完整编辑命令配置，例如code --wait；不是用户提示词，也不是已分好argv的数组。
	command: string;
	// 临时文件的初始提示词内容，本函数不修改原字符串。
	content: string;
}

// status为分辨标签：complete才有content，failed才有message；函数也可能因IO等异常reject，类型联合不表示捕获所有失败。
export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed"; message: string };

// 输入命令及初始正文，异步等待子进程后返回complete新文本或failed说明；例退出0且文件为edited加换行时得到edited。
// 流程：mkdtemp→写prompt.md→空格拆命令→spawn继承终端→等error/close→成功读回去BOM/一个尾LF→finally尽力删除目录。
// 副作用有临时文件、stdout提示及真实子进程；未设超时/取消，不处理完整shell引号。启动error事件通常返回failed，但同步spawn抛错、写读文件或stdout错误仍可reject；宿主仅成功时自行应用返回正文。
export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	// 在os.tmpdir给的位置创建pi-editor独立目录，创建动作在try外，失败直接拒绝且没有已建立的finally；本函数不主动选择项目目录。
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	// 文件名固定prompt.md，放在本次新建目录内；cwd仍保持调用者工作目录。
	const filePath = join(directory, "prompt.md");
	// 从写入开始用finally保障尝试删除目录，内部return也会走清理；没有catch统一包装所有异常。
	try {
		// 用UTF8同步写原正文，不额外补换行，出错会reject并尝试清理。
		writeFileSync(filePath, options.content, "utf-8");
		// 按单个空格split，数组解构取首段作程序名，其余作参数；多余空格产生空参数，带空格/引号的路径不会按完整shell语法正确解析。
		const [editor, ...editorArgs] = options.command.split(" ");
		// 直接写stdout两行启动提示，不经TUI布局，也不处理write返回false的背压；宿主通常此前已暂停TUI。
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		// Null means the editor could not be launched.
		// Promise执行器马上spawn，事件稍后resolve；结果联合为退出码、信号名或null。这里本身不阻塞线程，await暂停当前函数。
		const exit = await new Promise<number | NodeJS.Signals | null>((resolve) => {
			// The editor inherits pi's cwd so project-relative paths, integrated terminals,
			// and similar editor features keep working. A long cwd can break Windows editors:
			// Windows rejects working directories over MAX_PATH, and WSL launches Windows
			// editors (code, notepad.exe) from the cwd's \\wsl.localhost\... path (#11592).
			// The cwd is intentionally not changed; failures are reported to the user instead.
			// 把prompt文件路径追加到配置参数尾部；未传cwd所以继承Pi当前目录，而非切到临时文件所在目录。同步spawn若抛错，Promise自动拒绝而不是返回null。
			const child = spawn(editor, [...editorArgs, filePath], {
				// 继承stdin/stdout/stderr，编辑器直接使用原终端，不在本函数收集其文本输出。
				stdio: "inherit",
				// 仅Windows使用shell，其余平台直接按程序/参数启动；配置命令的解释和启动失败行为可能因此不同。
				shell: process.platform === "win32",
			});
			// 异步启动error被转换为null，原错误详情被丢弃；若后面close再resolve，Promise已结算就不会改结果。
			child.on("error", () => resolve(null));
			// close在子进程结束且stdio关闭后触发；code为null才改取signal，0不会因??被误当缺失。两者都null则结果仍null。
			child.on("close", (code, signal) => resolve(code ?? signal));
		});

		// null按启动失败处理；此检查不捕获上面executor已造成的Promise拒绝。
		if (exit === null) {
			// 返回failed标签和命令说明，不读取编辑文件的新内容。
			return { status: "failed", message: `Failed to launch external editor: ${options.command}` };
		}
		// 严格0以外的数值或信号名均视为失败，终止信号不冒充正常退出码0。
		if (exit !== 0) {
			// 构造结构化失败结果，调用方据status决定不替换原编辑正文。
			return {
				// 标签为failed，TS随后只允许读message而非content。
				status: "failed",
				// 数值原因显示code n，信号名原样显示；prompt unchanged指宿主不采用结果，不保证临时文件未被子进程改动。
				message: `External editor exited with ${typeof exit === "number" ? `code ${exit}` : exit}; prompt unchanged`,
			};
		}

		// 退出0才UTF8读回，stripBom去首BOM，正则仅去最终一个LF；例如a\n\n只变a\n，CRLF仍留下CR，普通空格不裁剪。读失败仍会reject。
		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
		// 成功/failed return或try内异常离开，都尝试执行清理，不改最终返回内容。
	} finally {
		// 清理单独捕获，避免用删除失败覆盖原运行结果/错误。
		try {
			// 递归删除本次临时目录，force允许已不存在；权限等错误仍可能抛。
			rmSync(directory, { recursive: true, force: true });
			// 吞掉清理异常，不能保证文件一定已被删除。
		} catch {
			// Cleanup is best effort.
		}
	}
}
