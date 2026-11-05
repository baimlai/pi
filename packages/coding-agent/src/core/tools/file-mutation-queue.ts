// 把写入/编辑同一个文件的操作排队；write.ts 与 edit.ts 在真正改文件前调用这里，不同文件仍可并行。
// 导入异步真实路径查询，跟随符号链接；import 花括号表示取模块的具名导出。
import { realpath } from "node:fs/promises";
// resolve 只计算绝对路径，不会创建文件或验证文件存在。
import { resolve } from "node:path";

// Map 的键是文件路径，值是该文件已登记操作的队尾 Promise；这里只存等待完成的信号，不存文件内容。
const fileMutationQueues = new Map<string, Promise<void>>();
// 所有登记步骤先串行，避免两个请求同时解析路径、读取同一个旧队尾后互相覆盖；实际文件操作不在此全局锁内。
let registrationQueue = Promise.resolve();

/**
 * 判断文件系统错误是否表示路径尚不存在；输入来自操作系统，所以先检查 unknown 的形状。
 * 例如 ENOENT 允许新建文件继续排队；权限错误不能冒充“文件不存在”。
 */
function isMissingPathError(error: unknown): boolean {
	// 下面多个 && 条件必须同时成立，才把外部错误视为可用绝对路径兜底的缺路径错误。
	return (
		// unknown 可以是任意抛出值；只有对象才可能读取 code。
		typeof error === "object" &&
		// JavaScript 的 typeof null 也是 object，必须单独排除 null。
		error !== null &&
		// in 检查对象是否具有该属性，也让 TypeScript 收窄后续可访问的字段。
		"code" in error &&
		// ENOENT 是缺少路径，ENOTDIR 是某级父路径不是目录；|| 表示满足任一即可。
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * 输入文件路径，返回队列键：已存在文件尽量用真实路径消除符号链接别名，不存在时用绝对路径。
 * 例如 a.txt 与指向它的链接可共用队列；除缺路径外的 realpath 错误继续抛出。
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	// 先将相对路径转绝对路径，例如 ./a.txt 转成当前进程目录下的 a.txt。
	const resolvedPath = resolve(filePath);
	try {
		// await 等文件系统解析符号链接；return await 使错误能被当前 try/catch 捕获。
		return await realpath(resolvedPath);
		// 真实路径查询可能失败；此处根据操作系统错误决定兜底还是继续报错。
	} catch (error) {
		// 目标还没创建时，真实路径不可得，但 write 仍需要一个稳定的排队键。
		if (isMissingPathError(error)) {
			// 缺路径时使用规范绝对路径；这不是宣称文件现在存在。
			return resolvedPath;
		}
		// 权限、I/O 等其他失败继续传播，不能悄悄改用另一个队列身份。
		throw error;
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
/**
 * 对同一文件串行执行异步操作，返回 fn 的原始结果，异常也原样传播；不同文件的工作不互相等待。
 * 流程：顺序登记真实路径 → 接到该文件队尾 → 等前一个完成 → 执行 fn → finally 放行下一项并清理队列。
 * 例：同时 edit(a.txt) 与 write(a.txt) 会排队；write(b.txt) 可与 a.txt 的实际写入并行。T 是 fn 返回值类型，Promise<T> 保留该类型。
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	// 把登记动作接在前一个登记动作后；then 接受的 async 回调返回一个 Promise。
	const registration = registrationQueue.then(async () => {
		// 登记期间确定本文件身份，避免别名路径绕过同文件串行约束。
		const key = await getMutationQueueKey(filePath);
		// 有旧队尾就等待它；首次操作用已完成 Promise，?? 只在 null/undefined 时采用右侧值。
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		// 声明稍后初始化的放行函数；! 是确定赋值断言，只影响 TS 检查，不会自动生成函数。
		let releaseNext!: () => void;
		// 创建本次操作的完成闸门；void 表示放行时不携带业务数据。
		const nextQueue = new Promise<void>((resolveQueue) => {
			// 保存 resolve，等实际操作的 finally 执行时手动放行下一项。
			releaseNext = resolveQueue;
		});
		// 新队尾必须先等旧队尾，再等本次闸门；后来的同文件请求会等这个组合 Promise。
		const chainedQueue = currentQueue.then(() => nextQueue);
		// 在执行 fn 前先公布新队尾，使后来的请求可靠接到本次之后。
		fileMutationQueues.set(key, chainedQueue);

		// 把登记结果一次返回；对象属性简写表示 key: key 等同名字段。
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	// 让下一次登记等待本次登记完成，同时吞掉登记失败作为全局队列尾的拒绝状态。
	registrationQueue = registration.then(
		// 成功与失败分支都只完成全局登记闸门；当前调用仍会通过 await registration 收到自身错误。
		() => undefined,
		// 成功与失败分支都只完成全局登记闸门；当前调用仍会通过 await registration 收到自身错误。
		() => undefined,
	);

	// 对象解构取得排队资料；登记结束不等于文件操作结束。
	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	// 此处才等待同一文件的前序操作；其他文件若没有前序工作可以立即继续。
	await currentQueue;
	try {
		// 执行调用者传入的实际读改写/写入操作，保留返回值和异常。
		return await fn();
		// 无论成功、抛错还是取消，finally 都必须放行，避免队列永远卡住。
	} finally {
		// 结束本次闸门，让已经登记在后面的同文件操作有机会开始。
		releaseNext();
		// 只有自己仍是最后一项才能删除；若后面已有新登记，必须保留对方的队尾。
		if (fileMutationQueues.get(key) === chainedQueue) {
			// 删除空闲文件的队列引用，避免处理过的文件路径无限留在 Map 中。
			fileMutationQueues.delete(key);
		}
	}
}
