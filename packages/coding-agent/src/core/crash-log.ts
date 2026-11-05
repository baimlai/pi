// 持久化最多5条崩溃记录，并按堆栈关联已加载扩展；交互模式记录/提示，报告流程读取这些材料。
// 同步文件API会阻塞当前线程，这里不启动后台上传。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// 路径操作只拼接/取目录，不自动解析软链接。
import { dirname, join } from "node:path";
// 通过config定位用户代理目录并读取版本，不硬编码安装路径。
import { getAgentDir, VERSION } from "../config.ts";
// Pick稍后只取Extension的三个元数据字段，不需要完整扩展执行器。
import type { Extension } from "./extensions/types.ts";
// 排除扩展工厂等合成标识，避免把它当磁盘路径匹配。
import { isSyntheticPath } from "./source-info.ts";

// 本地JSON记录契约；读取函数实际只检查其中两个字段，并非完整反序列化验证。
export interface CrashRecord {
	// ISO时间文字；接口本身不检查日期有效性。
	timestamp: string;
	// 崩溃时Pi版本。
	version: string;
	// 来源标签只允许未捕获异常/致命错误。
	kind: "uncaught_exception" | "fatal_error";
	// 可显示错误说明，没有统一脱敏保证。
	message: string;
	// 无Error堆栈时用null，区别于空字符串。
	stack: string | null;
	// 无持久会话文件时明确null。
	sessionFile: string | null;
	// 当时会话工作目录。
	cwd: string;
	// ?允许旧记录没有字段；只有已通知才置true。
	notified?: boolean;
}

// 写入新记录时只保留末尾5条，不是整个进程的错误计数上限。
const MAX_CRASH_RECORDS = 5;
// 7天换算成毫秒，供通知筛选；并不据此自动删除旧文件。
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// 生成崩溃日志路径，不读写文件；例：传临时目录得到该目录下crashes.json。默认参数在调用时取代理目录。
function crashLogPath(agentDir = getAgentDir()): string {
	// join适配平台分隔符，返回字符串。
	return join(agentDir, "crashes.json");
}

// 读取本地日志并保留通过粗检查的记录，文件缺失/解析失败返回[]；例：非数组JSON也视为空。只核对timestamp/message，返回类型的其他字段未被逐一保证。
export function readCrashLog(path = crashLogPath()): CrashRecord[] {
	// 文件I/O、JSON解析和筛选异常都降级为空数组。
	try {
		// 文件是信任边界：先保存为unknown，而不是把JSON.parse结果当完整CrashRecord。
		const records: unknown = JSON.parse(readFileSync(path, "utf8"));
		// 必须真是数组才继续逐条筛选。
		return Array.isArray(records)
			? // filter返回新数组，不修改原解析数组。
				records.filter(
					// 类型谓词record is CrashRecord让TS收窄；这是实现承诺，不会自动补齐其余字段。
					(record): record is CrashRecord =>
						// 粗检查要求对象。
						typeof record === "object" &&
						// 排除typeof null为object的情况。
						record !== null &&
						// as断言只允许读timestamp，真正检查是typeof字符串。
						typeof (record as CrashRecord).timestamp === "string" &&
						// message同样要求字符串；version/kind等仍未验证。
						typeof (record as CrashRecord).message === "string",
				)
			: // 顶层不是数组时返回新空数组。
				[];
		// catch没有把错误重新抛给本来就在处理崩溃的调用方。
	} catch {
		// 不可读与无记录在本接口中同样表现为[]。
		return [];
	}
}

// 同步覆盖日志；先创建父目录，再写格式化JSON加LF，返回void。例：新代理目录可自动创建；没有临时文件重命名或并发写协调，失败直接抛给外层。
function writeCrashLog(records: readonly CrashRecord[], path: string): void {
	// recursive允许目录已存在，父目录创建失败仍会抛。
	mkdirSync(dirname(path), { recursive: true });
	// readonly只限制本函数通过类型修改数组，不会冻结；JSON编码/写文件失败可抛，写入不是原子替换。
	writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

// Pick从Extension取path/resolvedPath/sourceInfo形成小接口，不在运行时复制对象。
type ExtensionStackMetadata = Pick<Extension, "path" | "resolvedPath" | "sourceInfo">;

// 统一堆栈匹配用的路径文字；例：C:\x\变C:/x，不realpath或解析..。
function normalizeStackPath(value: string): string {
	// 全局替换反斜杠，再去所有末尾正斜杠；不是通用路径合法性校验。
	return value.replace(/\\/g, "/").replace(/\/+$/u, "");
}

// 判断堆栈文字是否包含目标路径，返回boolean；includeDescendants选择目录前缀或文件尾边界。例：目录/x匹配/x/a.ts；只是文字启发式，不证明扩展就是错误根因。
function stackContainsPath(stack: string, targetPath: string, includeDescendants: boolean): boolean {
	// 先规范化目标路径，堆栈由上层统一规范化。
	const target = normalizeStackPath(targetPath);
	// 空路径或<...>合成标识不参与匹配。
	if (!target || isSyntheticPath(target)) return false;
	// 只有盘符形式目标触发忽略大小写，不按当前OS一概处理。
	const caseInsensitive = /^[a-z]:\//iu.test(target);
	// 三元表达式选择小写堆栈或原文字，不修改输入。
	const haystack = caseInsensitive ? stack.toLowerCase() : stack;
	// 目标用同一大小写规则。
	const needle = caseInsensitive ? target.toLowerCase() : target;
	// 目录匹配要求后接/；这里只做includes，没有额外检查路径起点边界。
	if (includeDescendants) return haystack.includes(`${needle}/`);

	// 精确文件模式先定位第一次出现，找不到为-1。
	let index = haystack.indexOf(needle);
	// 可能多次出现：前一次尾边界不合格时继续查后一次。
	while (index !== -1) {
		// 读取目标末尾后一位，越界为undefined。
		const next = haystack[index + needle.length];
		// 仅允许文本结束、冒号、右括号或空白作文件尾边界；不会误把a.tsx当a.ts。
		if (next === undefined || next === ":" || next === ")" || /\s/u.test(next)) return true;
		// 从本次匹配末尾继续查，index变量因此必须用let。
		index = haystack.indexOf(needle, index + needle.length);
	}
	// 没有合法匹配，返回false。
	return false;
}

/** Find loaded extensions with source files in a stack trace. */
// 从V8风格at帧匹配已加载扩展，按输入顺序返回去重标签；不修改扩展或文件。例：npm包任意子文件命中可归到包来源。仅处理at帧，匹配只是诊断线索。
export function findExtensionStackMatches(
	// 堆栈可缺，空串也视为没有。
	stack: string | undefined,
	// readonly数组保护调用接口，不深冻结扩展对象。
	extensions: readonly ExtensionStackMetadata[],
): string[] {
	// 无堆栈立即返回新空列表。
	if (!stack) return [];
	// 开始构造只含帧的规范化文字。
	const normalizedStack = stack
		// 按LF拆，CR若存在留在对应行中。
		.split("\n")
		// 跳过第一行错误描述，避免错误文字里提到路径就归因给扩展。
		.slice(1)
		// 仅保留前面空白加at的帧，不解析所有运行时堆栈格式。
		.filter((line) => /^\s+at\s/u.test(line))
		// 逐帧解码URL路径，失败只影响本帧。
		.map((line) => {
			// decodeURI可能因残缺%转义抛错。
			try {
				// 将%20等还原，便于匹配带空格路径；不执行URL内容。
				return decodeURI(line);
				// 坏转义保留该行原文字。
			} catch {
				// 不会因一个坏帧丢掉其他帧。
				return line;
			}
		})
		// 重新合成匹配文本。
		.join("\n")
		// Windows反斜杠转正斜杠。
		.replace(/\\/g, "/");
	// 显式string[]便于后续push时有准确元素类型。
	const matches: string[] = [];
	// Set用标签去重，同包多个入口只报告一次。
	const seen = new Set<string>();

	// 以已加载扩展顺序逐个尝试匹配。
	for (const extension of extensions) {
		// 扩展解析后的实际入口路径，同样仅文字规范化。
		const resolvedPath = normalizeStackPath(extension.resolvedPath);
		// 判断来源是否看起来是本地单文件包。
		const singleFilePackage =
			// 先要求资源来源类别package。
			extension.sourceInfo.origin === "package" &&
			// 排除npm/git/网络等来源前缀。
			!/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/u.test(extension.sourceInfo.source) &&
			// 只认JS/TS及c/m扩展名后缀；不是实际磁盘文件类型检测。
			/\.[cm]?[jt]s$/u.test(extension.sourceInfo.source);
		// 非单文件包可使用已记录的baseDir作为整个包根。
		const packageRoot =
			// &&短路：必须package、非单文件、且baseDir有值。
			extension.sourceInfo.origin === "package" && !singleFilePackage && extension.sourceInfo.baseDir
				? // 满足时采用包根路径。
					extension.sourceInfo.baseDir
				: // 否则undefined，让后续尝试入口目录/文件。
					undefined;
		// 最后/用于取index入口所在目录。
		const slashIndex = resolvedPath.lastIndexOf("/");
		// index.js/index.ts等被视为目录入口。
		const directoryEntry = /\/index\.[cm]?[jt]s$/u.test(resolvedPath);
		// 依次选择包根、目录入口、精确文件的匹配策略。
		const matched = packageRoot
			? // 包内任何子路径出现都算命中。
				stackContainsPath(normalizedStack, packageRoot, true)
			: // 没有包根时，只有index入口才按父目录匹配。
				directoryEntry && slashIndex !== -1
				? // slice去掉/index文件名，保留目录。
					stackContainsPath(normalizedStack, resolvedPath.slice(0, slashIndex), true)
				: // 普通单文件入口按文件尾边界匹配，避免把兄弟文件归给它。
					stackContainsPath(normalizedStack, resolvedPath, false);
		// 未命中就跳过，不生成空标签。
		if (!matched) continue;

		// 选择展示标签。
		const label =
			// package且来源非空时优先原安装来源。
			extension.sourceInfo.origin === "package" && extension.sourceInfo.source
				? // 例如npm:memory，方便用户定位安装包。
					extension.sourceInfo.source
				: // 其余回退原extension.path。
					extension.path;
		// 相同标签只保留第一份。
		if (!seen.has(label)) {
			// 先记见过，再添加结果。
			seen.add(label);
			// push保留输入扩展顺序，不排序。
			matches.push(label);
		}
	}
	// 返回新字符串数组，扩展元数据本身未改。
	return matches;
}

/** Best-effort persistence for callers that are already crashing. */
// 尽力追加崩溃记录并只保留最近5条，返回新记录或undefined；例：普通字符串抛出值也转为message。try内构造/读写错误吞掉，默认path求值在try外；同步写入不保证崩溃时一定落盘。
export function recordCrash(
	// 内联对象约束必需字段；error:unknown允许任意JS抛出值。
	crash: { kind: CrashRecord["kind"]; error: unknown; sessionFile?: string; cwd: string },
	// 可传临时文件测试，省略时定位用户代理目录。
	path = crashLogPath(),
): CrashRecord | undefined {
	// 连错误转文字/JSON编码的失败也在本try内。
	try {
		// 解构只取error，不改变crash。
		const { error } = crash;
		// 类型注解检查构建的记录字段，不校验任意外部JSON。
		const record: CrashRecord = {
			// 用当前时间新建ISO字符串。
			timestamp: new Date().toISOString(),
			// 记录此版本，后续升级不会回写旧记录。
			version: VERSION,
			// 属性值取调用方已分类的kind。
			kind: crash.kind,
			// Error优先message，空message用name；非Error调用String，可能触发自定义转换。
			message: error instanceof Error ? error.message || error.name : String(error),
			// Error且堆栈非空才保存，否则null。
			stack: error instanceof Error && error.stack ? error.stack : null,
			// ??只对undefined/null回退，空字符串路径仍保留。
			sessionFile: crash.sessionFile ?? null,
			// 保存调用者提供的cwd，不擅自改为process.cwd。
			cwd: crash.cwd,
		};
		// 先读旧数组，再追加并取末尾5条后覆盖；没有锁，多进程竞争写可能丢记录。
		writeCrashLog([...readCrashLog(path), record].slice(-MAX_CRASH_RECORDS), path);
		// 落盘成功才返回记录。
		return record;
		// 读旧记录失败已变[]；此处主要处理构造/写入等失败。
	} catch {
		// 失败返回undefined，不给崩溃路径添第二个异常。
		return undefined;
	}
}

/** Return the newest recent crash, marking pending records as announced. */
// 取追加顺序中最后一条未通知且不超过7天的记录，并尝试把所有未通知记录标记；例：旧记录也一起标记。按数组倒序而非时间排序，未来时间也满足年龄<=7天，没有下界检查。
export function takeUnnotifiedCrash(path = crashLogPath(), now = Date.now()): CrashRecord | undefined {
	// 粗校验后获得数组，读失败为空。
	const records = readCrashLog(path);
	// 展开复制外层数组，避免reverse改变原records顺序。
	const crash = [...records]
		// 倒序使最近追加的记录先被find考察。
		.reverse()
		// false/undefined都视为未通知；无效日期变NaN使比较false，未来日期得到负年龄也可匹配。
		.find((record) => !record.notified && now - Date.parse(record.timestamp) <= MAX_AGE);
	// 没有候选则不重写日志。
	if (!crash) return undefined;
	// 更新通知标记失败不阻止返回选中的记录。
	try {
		// 按原顺序重新覆盖日志。
		writeCrashLog(
			// 已通知对象原样保留；未通知对象浅复制并置true，不只改选中那条。
			records.map((record) => (record.notified ? record : { ...record, notified: true })),
			// 写回同一路径。
			path,
		);
		// 忽略写失败，下次可能再次显示提示。
	} catch {
		// Showing the notice again is harmless.
	}
	// 返回原选中对象，它自身notified未必为true；标记存在于写入的新对象。
	return crash;
}

// 删除崩溃日志并忽略失败，返回void；例：文件不存在也成功。上游报告完成后调用，不清除已构建bundle中的记录。
export function clearCrashLog(path = crashLogPath()): void {
	// 只删除路径对应文件，不递归删除代理目录。
	try {
		// force允许缺文件，不表示绕过系统权限。
		rmSync(path, { force: true });
		// 权限/文件类型等错误吞掉，记录可供下次重试发送。
	} catch {
		// The records can be attached again if cleanup fails.
	}
}
