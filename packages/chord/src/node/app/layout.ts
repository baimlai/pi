// The app kit's data directory (slice 13 §4, decision "The app kit, point 4: storage"): one fixed layout, made private
// at every start. `server/` holds the server's store and files, `workers/<kind>/<address>/` each worker's store and
// files, `plugins/` the user's plugins root, `logs/` the logs, `owner-token` the owner's token for command-line
// clients. Directories are 0700 and stores 0600, also when they existed looser before (other local users must not
// read the sessions in a store, nor replace it).

// 所属：packages/chord/src/node/app，app kit 的数据目录布局（slice 13 §4；decision 点 4）。
// 职责边界：计算和创建目录、收紧权限、编码 worker 目录名；不打开 store、不管理锁、不写业务文件。
// 上游：app.ts 的 openServer/createLayout/workerDirectory 调用；下游：node:fs/promises、node:path、node:crypto。
// 结果与错误：openDataDir/createLayout/privateDirectory/privateStore 返回路径或 void，权限、所有权和路径错误抛出；workerDirectory/encodedKey 无 I/O。
// 能力清单：AppLayout 描述路径；defaultDataDir 给出 ~/.name；openDataDir 解析真实目录并拒绝危险位置；createLayout 建全部子目录；privateDirectory 设 0700；privateStore 设 0600；workerDirectory 计算 worker 路径；encodedKey 生成单段目录名。
// 组合顺序：defaultDataDir/openDataDir → createLayout → privateDirectory/privateStore → workerDirectory。
// 示例：const layout = await createLayout(await openDataDir('/tmp/acme')); const dir = workerDirectory(layout.dataDir, Doc({ id: 'p1' }))。
// 建议阅读顺序：先看 AppLayout 与 openDataDir/createLayout，再看 privateDirectory/privateStore，最后 workerDirectory/encodedKey。
import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import type { Address } from "../../contracts/index.ts";

/** The paths of a data directory. */
// 布局是路径数据的结构类型：readonly 限制重赋值，不创建目录；真正的磁盘操作在 createLayout。
export type AppLayout = {
	readonly dataDir: string;
	readonly server: string;
	readonly serverStore: string;
	readonly workers: string;
	readonly plugins: string;
	readonly logs: string;
	readonly ownerToken: string;
	readonly cookieSecret: string;
};

/** The data directory of app `name` unless the start script names one: `~/.<name>`. */
// 根据应用名返回用户主目录下的点目录路径，不创建它；例如 name 为 acme，得到 ~/.acme 对应的绝对路径。
export function defaultDataDir(name: string): string {
	// homedir 读取当前用户的主目录，join 按当前操作系统规则连接路径。
	return join(homedir(), `.${name}`);
}

/**
 * The real path of the data directory `path`, made when missing (mode 0700), refused when the kit must not make it
 * private: the home directory, a file system's root, or a directory another user owns (a clear error, instead of
 * tightening a directory others use or failing on `EPERM`). Its mode is set on the real path, never through a link.
 */
// 创建缺失目录并解析真实路径，拒绝主目录、文件系统根或其他用户所有的目录；返回规范路径。
// 例如符号链接指向 ~/.acme，后续锁和权限都使用同一真实目录。mkdir/realpath/stat 错误直接传播；已有目录的权限在 createLayout 调整。
export async function openDataDir(path: string): Promise<string> {
	// 递归建立缺失部分；0o700 只对新建目录指定用户读写执行权限。
	await mkdir(path, { recursive: true, mode: 0o700 });
	// realpath 消解符号链接，避免同一个目录从不同链接绕过单进程锁。
	const dataDir = await realpath(path);
	// 也解析主目录，按真实位置比较。
	const home = await realpath(homedir());
	// 不能把广泛使用的主目录或磁盘根交给后续 chmod 变成应用私有目录。
	if (dataDir === home || dataDir === parse(dataDir).root) {
		// 三元表达式选取错误中的具体原因。
		const what = dataDir === home ? "the home directory" : "a file system's root";
		// 抛出清楚的配置错误；此时可能已创建请求路径，但还没有收紧该目录权限。
		throw new Error(`startServer: the data directory ${dataDir} is ${what}; name a directory of the app's own`);
	}
	// 读取目录所有者 uid；解构只取得需要的字段。
	const { uid } = await stat(dataDir);
	// 仅在平台提供 getuid 时检查所有者，Windows 等没有该方法的平台跳过。
	if (process.getuid !== undefined && uid !== process.getuid()) {
		throw new Error(`startServer: the data directory ${dataDir} belongs to another user (uid ${uid})`);
	}
	// 返回真实路径，调用者继续加锁并建立布局。
	return dataDir;
}

/** The layout of `dataDir` (a real path, `openDataDir`'s), its directories made private (`privateDirectory`). */
// 接收 openDataDir 得到的真实目录，收紧权限并建立固定子目录，返回全部路径；有磁盘副作用。
// 例如 layout.serverStore 指向 server/store.sqlite，这里只创建目录，不打开 SQLite。
export async function createLayout(dataDir: string): Promise<AppLayout> {
	// 先确保数据根目录为 0700，再放入敏感文件。
	await privateDirectory(dataDir);
	// 对象字面量只计算路径；AppLayout 在开发时检查这些属性齐全。
	const layout: AppLayout = {
		dataDir,
		server: join(dataDir, "server"),
		serverStore: join(dataDir, "server", "store.sqlite"),
		workers: join(dataDir, "workers"),
		plugins: join(dataDir, "plugins"),
		logs: join(dataDir, "logs"),
		ownerToken: join(dataDir, "owner-token"),
		cookieSecret: join(dataDir, "server", "cookie-secret"),
	};
	// 顺序建立 server/workers/plugins/logs 并收紧权限；任一失败使 Promise 拒绝。
	for (const dir of [layout.server, layout.workers, layout.plugins, layout.logs]) await privateDirectory(dir);
	// 路径对象交回启动流程复用，没有复制或冻结。
	return layout;
}

/** Makes `dir` (and missing parents) with mode 0700, and sets 0700 on it when it existed. */
// 建立缺失目录并把目标本身设为 0700；返回无值 Promise。例：已有 0755 目录会被改为 0700。
export async function privateDirectory(dir: string): Promise<void> {
	// recursive 允许父级缺失或目录已存在；不因存在而报错。
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// 单独 chmod 保证已存在的目标也被收紧；不会逐层重新 chmod 所有祖先。
	await chmod(dir, 0o700);
}

/**
 * Makes the store file `path` private before SQLite opens it: created empty with mode 0600 when missing (SQLite gives
 * its journal files the database's mode), else set to 0600 with the journal files it has.
 */
// 在 SQLite 打开前准备私有数据库文件，主文件及存在的 wal/shm 都设 0600；返回无值 Promise。
// 例如首次启动先创建空主文件；缺失的 journal 被忽略，权限等其他错误保留。
export async function privateStore(path: string): Promise<void> {
	// 用追加模式创建缺失主文件，立即关闭描述符，不改已有内容。
	await (await open(path, "a", 0o600)).close();
	// 遍历数据库及两种 SQLite 辅助文件。
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		// 异步 chmod 失败用 catch 检查 Node 错误码；参数类型声明不会验证操作系统异常。
		await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
			// 只忽略尚未创建的辅助文件，其他失败使启动中断。
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** The directory of the worker at `address`: `workers/<kind>/<its key, encoded>`. */
// 根据数据根目录和 Address 返回 worker 路径，无 I/O；例如某项目的 key 先编码为单个目录名。
// kind 是 hostKind 已声明的种类，key 来自地址的稳定标识；这里不创建目录。
export function workerDirectory(dataDir: string, address: Address): string {
	// 把种类作为一层，encodedKey 作为下一层，保证地址键中的路径字符不变成目录分隔。
	return join(dataDir, "workers", address.kind, encodedKey(address.key));
}

/** The longest key kept readable as a directory name; a longer one is named by its hash. */
const READABLE_KEY = 160;

/**
 * An address key as one directory name: percent-encoded (`/`, `\`, `.` and every other character a file system might
 * treat specially included), or its SHA-256 when that is longer than `READABLE_KEY`. Capital letters are encoded too:
 * on a case-insensitive file system (macOS) `p|A` and `p|a` would otherwise share a directory.
 */
// 将地址键转换成大小写不敏感文件系统也可区分的单段名字；超过 160 字符则改用 SHA-256。
// 例如键含大写 A 时写成 %41，小写 a 保留，因此两者不会因文件系统折叠大小写而冲突。
function encodedKey(key: string): string {
	// 先 URI 编码，再补编码 URI 原本允许但文件名需区分的字符。
	const encoded = encodeURIComponent(key).replace(
		// 第一个捕获组选已有 %XX 序列，第二分支选需补编码的字符；g 表示处理所有匹配。
		/(%[0-9A-F]{2})|[.!'()*~A-Z]/g,
		// 回调的 escaped 有值就保留原转义，否则把字符编码成大写 hex；?? 只把 null/undefined 当缺失。
		(match, escaped: string | undefined) => escaped ?? `%${match.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	// 短名保留可读编码，长名对原 key 求摘要；这是命名规则，不是加密地址。
	return encoded.length <= READABLE_KEY ? encoded : `sha256-${createHash("sha256").update(key).digest("hex")}`;
}
