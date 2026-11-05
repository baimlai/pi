/**
 * Log messages MCP servers send with `notifications/message`, appended to `mcp.log` in the agent
 * directory. Several pi processes may write to the same file, so every message is one synchronous
 * append. The file is rotated to `mcp.log.1` once it grows past `MAX_LOG_BYTES`.
 */

// 接住 MCP 服务器主动推送的日志，格式化后尽力追加到本地 mcp.log。runtime.ts 订阅 notifications/message 再调用 write。
// 例：服务器 data="慢查询" 会成为带时间、服务器名和级别的一行；这里不上传日志，也不脱敏。
// 这些 fs API 是同步操作，会阻塞当前 JS 执行到本次读写结束；日志失败通常被 write 吞掉。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
// dirname 只取路径的父目录，真正创建目录在首次 write 时发生。
import { dirname } from "node:path";

// 阈值为 5 MiB。判断发生在下一条追加前且用 >，所以文件可超过阈值；不是严格的文件容量上限。
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// unknown 来自服务器通知边界；这个类型谓词只排除 null/数组和基本类型，不验证对象字段，也不保证是普通对象。
function isRecord(value: unknown): value is Record<string, unknown> {
	// value is Record<...> 告诉 TS：返回 true 时，可将 value 当字符串键/未知值的对象使用。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 将日志 data 转成文字：字符串原样，其他值优先 JSON；循环引用等 JSON 失败时改 String，不做通用脱敏。
function formatData(data: unknown): string {
	// 字符串不额外加 JSON 双引号。
	if (typeof data === "string") return data;
	try {
		// JSON.stringify(undefined) 可能没有结果，?? 再用 String；BigInt 或循环对象会进入 catch。
		return JSON.stringify(data) ?? String(data);
	} catch {
		// String 本身若遇到会抛错的自定义转换仍可能抛错，这里没有再套保护。
		return String(data);
	}
}

/** Format one `notifications/message` from `server` as a log line; continuation lines are indented. */
/**
 * 把一次日志通知转成文本行，不读写文件。输入可为未知数据；默认 now 为调用时刻，便于测试传固定时间。
 * 例：data 为两行文字时，第二行前缩进四空格；只处理 data 内的 CRLF/LF，不转义 ANSI，也不清洗 server/level/logger。
 * Date 无效会在 toISOString 抛错；字段访问/字符串转换也没有完整异常隔离。
 */
export function formatMcpLogMessage(server: string, params: unknown, now: Date = new Date()): string {
	// 对象通知按字段读取；非对象（含数组）整体当作 data，保证后续有同一个读取入口。
	const message = isRecord(params) ? params : { data: params };
	// 只有 level 为字符串才采用；空字符串也算字符串，不验证是否属于 MCP 规范的级别名。
	const level = typeof message.level === "string" ? message.level : "info";
	// logger 必须是非空字符串才加前缀，前导空格和冒号只是排版。
	const logger = typeof message.logger === "string" && message.logger ? ` ${message.logger}:` : "";
	// 正则 g 表示替换所有 CRLF/LF；独立 CR、Unicode 换行符和控制字符不会在此统一处理。
	const text = formatData(message.data).replace(/\r?\n/g, "\n    ");
	// 模板字符串插入 ISO 时间和名称，尾部显式换行，供一次 append 写入；UTF-8 字节数在 write 中另算。
	return `${now.toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

/** Appends server log messages to one file. Write errors are ignored: logging must not break tools. */
/** 维护一个日志路径和本实例的大小估算；多进程各自估算且没有轮转锁，不保证严格单行隔离或无轮转竞争。 */
export class McpServerLog {
	// readonly 约束不能重赋 path，不是限制操作系统上该文件不可被其他进程改动。
	readonly path: string;
	// undefined 表示本实例还未首次测量文件大小；以后主要按自己写入的字节累计，可能落后于其他进程。
	private size: number | undefined;

	/** 只保存路径，不立即建目录、读文件或打开持续的文件句柄。 */
	constructor(path: string) {
		// 直接保存调用者给的路径，相对路径仍相对当前进程 cwd。
		this.path = path;
	}

	/** 格式化后尝试轮转/追加一条日志，写盘错误忽略；格式化位于 try 外，data 转文字等操作抛出的异常仍可传播。 */
	write(server: string, params: unknown): void {
		// 先在 try 外生成整条字符串，不是异步写队列，也不是流式分段写。
		const line = formatMcpLogMessage(server, params);
		try {
			// 本实例首次写入才初始化；第一次文件系统失败可能让下次重新尝试。
			if (this.size === undefined) {
				// 递归创建父目录，不在这里设置文件/目录权限或加密。
				mkdirSync(dirname(this.path), { recursive: true });
				// 现有文件取实际字节大小，不存在或 stat 失败都当 0。
				this.size = this.currentSize();
			}
			// 先看本实例估算；其他进程写大而本实例估算尚小，本次可能直接继续追加。
			if (this.size > MAX_LOG_BYTES) {
				// Another process may have rotated it already; check before renaming.
				// 只有再次 stat 确认超过阈值才重命名成 .1；检查与 rename 之间仍有竞争，替换目标行为也依平台文件系统。
				if (this.currentSize() > MAX_LOG_BYTES) renameSync(this.path, `${this.path}.1`);
				// 轮转后重新 stat 原路径；通常原文件已不存在，因此回到 0，其他进程也可能已创建新文件。
				this.size = this.currentSize();
			}
			// 一次同步追加整条文字；不存在时可创建文件，默认 UTF-8，不等于跨所有平台/写入大小的事务保证。
			appendFileSync(this.path, line);
			// 按 UTF-8 字节累计本次成功写入量，中文常占多个字节，不能用字符串 length 替代。
			this.size += Buffer.byteLength(line);
			// 只吞 try 内文件操作错误；本次写不成就丢弃，不重试、不向模型报错。
		} catch {
			// Ignore: the log is best effort.
		}
	}

	// 读取当前日志实际字节大小；失败统一返回 0，不区分不存在和权限问题。
	private currentSize(): number {
		try {
			// statSync 不读取文件内容，size 是文件系统报告的字节数。
			return statSync(this.path).size;
		} catch {
			// 日志尽力而为；这里把 stat 错误降级为空文件估算。
			return 0;
		}
	}
}
