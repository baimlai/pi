// 所属：packages/durable/src/tools，Durable 工具层的进程内写操作串行器。
// 解决的问题：并发的 edit/write 可能同时读-改-写同一文件，后写者会覆盖前写者的结果；同一文件还可能通过
// 符号链接、相对路径等不同写法出现。这里用“文件系统 id + 规范路径”把同一文件的写操作排成队列。
// 职责边界：只串行本进程内通过本模块调用的异步函数；不加文件锁，不阻止 bash 或其他进程同时修改文件，也不
// 提供事务或回滚。队列只存在于当前进程内存，重启即丢失。
// 上游：write.ts 和 edit.ts 的 execute 在真正写文件前调用 withFileMutationQueue。下游：ExecutionEnv 的
// absolutePath/canonicalPath/joinPath，用于计算排队键。
// 能力清单：
// - withFileMutationQueue(env, path, fn, context)：等待同键前一个操作结束后执行 fn；无论 fn 成功或抛错都会
//   释放队列，并原样返回/抛出 fn 的结果或错误。
// 组合与顺序：mutationKey 先解析绝对路径和规范路径，再入队；多个调用按各自的键解析完成顺序排队，而不是按
// 调用表达式书写的顺序。
// 示例（真实签名）：
//   await withFileMutationQueue(env, absolutePath, async () => { await env.writeFile(...); }, context);
// 建议阅读顺序：先看 mutationKey 与 canonical（理解键如何合并别名），再看 withFileMutationQueue 的 Promise 链。
import type { Context } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

/** Tail of the mutation chain of each file, keyed by file system id and canonical path. */
const queues = new Map<string, Promise<void>>();

/**
 * 为 env 内的 path 生成排队键；context 传给路径操作，返回“文件系统 id + NUL + 规范路径”。
 * 只解析路径，不改文件；路径操作失败时抛错。例如同一文件系统里指向同一文件的软链接可落到同一键。
 */
async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	// 先将相对路径按环境 cwd 解析；Result 失败转为异常。
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	// id 隔离不同文件系统；\0 是键内分隔符，不是磁盘路径的一部分。
	return `${env.id}\0${await canonical(env, absolutePath, context)}`;
}

/**
 * The canonical path; for a file that does not exist yet, its canonical parent joined with its name, so a `write` that
 * creates a file and a later mutation of it share one key even under a symlinked directory.
 */
/**
 * 取得 absolutePath 的规范路径；文件不存在时递归解析父目录再拼回文件名。
 * 不支持规范化的环境退回绝对路径，其他非 not_found 错误抛出；只做路径查询，不创建目录。
 * 例如 /link/new.txt 尚不存在、/link 指向 /real 时，可得到 /real/new.txt 作为排队依据。
 */
async function canonical(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
	// 由环境处理软链接与平台路径语法，不在此用宿主机路径库推断远端路径。
	const result = await env.canonicalPath(absolutePath, context);
	// ok 是可辨别联合的标记，检查它后 TypeScript 才允许访问对应 value/error。
	if (result.ok) return result.value;
	// 环境没有实现此能力时仍能按绝对路径串行化，但不保证别名合并。
	if (result.error.code === "not_supported") return absolutePath;
	// 权限等错误不能通过“当成新文件”掩盖。
	if (result.error.code !== "not_found") throw result.error;
	// The file system splits the path, so a name may contain characters that are separators elsewhere.
	const parent = getOrThrow(await env.joinPath([absolutePath, ".."], context));
	// 到根目录或不能可靠拆分时停止递归，避免无进展或误切文件名。
	if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath;
	// 父路径已带分隔符时不再跳过一个字符；否则越过父目录与文件名之间的分隔符。
	const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1));
	// 先递归规范化父目录，再用同一环境的 joinPath 组装缺失文件的候选路径。
	return getOrThrow(await env.joinPath([await canonical(env, parent, context), name], context));
}

/**
 * Serialize `edit` and `write` mutations of one file within this process: same file system id and canonical path,
 * whichever environment object the call got. Other files, and other file systems, never wait. Concurrent calls on one
 * file run in the order their keys resolve. Not a lock against `bash` or other processes.
 */
/**
 * 在本进程内对同一文件依次执行异步 fn，返回 fn 的结果 T；env/path 确定文件，context 用于路径查询。
 * 会修改模块内 queues，不自行取消等待；fn 抛错也释放队位并原样传播错误。
 * 例如两个 write 指向同一规范路径时，后一个等前一个完成；bash 和其他进程仍可能同时改该文件。
 */
export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	// 这里的异步解析决定入队先后，不保证调用表达式的先后就是队列顺序。
	const key = await mutationKey(env, path, context);
	// Take the slot without awaiting, so no other call can take it in between.
	const previous = queues.get(key) ?? Promise.resolve();
	// release 随后替换为 Promise 的 resolve；初值让变量在类型和赋值顺序上完整。
	let release = (): void => {};
	// done 代表“本次 fn 已经结束”，并不携带 fn 的返回值或异常。
	const done = new Promise<void>((resolve) => {
		// Promise 构造器同步执行此回调，所以 await previous 前 release 已可用。
		release = resolve;
	});
	// 当前尾节点等前一节点，再等本次释放；fn 的异常不会使队列尾 Promise 拒绝。
	const tail = previous.then(() => done);
	// 在第一次 await 前发布尾节点，后续同键调用会排到它后面。
	queues.set(key, tail);
	// 只等前一调用释放，之后才进入用户提供的写操作。
	await previous;
	try {
		// await 放在 try 内，保证异步拒绝也经过 finally。
		return await fn();
	} finally {
		// 无论成功、异常都解除后续等待。
		release();
		// 只有自己仍是最后节点时才删键，不能删除后来已经排队的节点。
		if (queues.get(key) === tail) queues.delete(key);
	}
}
