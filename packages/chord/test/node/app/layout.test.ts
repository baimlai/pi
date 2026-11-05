// 验证数据目录权限和 worker 地址到目录名的编码，只在临时目录创建文件。
// Tests of the data directory's layout (slice 13 §4): the directories made (the data directory 0700), the default
// data directory, and worker directories: one directory name per address key, distinct even on a case-insensitive
// file system, never leaving `workers/<kind>/`.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostKind, str } from "../../../src/contracts/index.ts";
import { createLayout, defaultDataDir, workerDirectory } from "../../../src/node/app/layout.ts";
import { tempDir } from "./support.ts";

// 定义带字符串 id 的 doc 主机种类；下方 Doc({id}) 构造地址，声明处不启动进程。
const Doc = hostKind("doc", { id: str() });

// 登记布局测试；describe 回调只注册用例。
describe("the data directory", () => {
	// 异步用例在临时根下创建 data，检查子目录、权限位和返回路径；无业务返回值。
	// 例如应用名 acme 的默认路径应是家目录下 .acme，本例只比较该字符串，不写家目录。
	it("makes the layout's directories, the data directory with mode 0700", async () => {
		// tempDir 会登记清理；join 拼出尚未创建的数据子目录。
		const dataDir = join(await tempDir(), "data");
		// 等待实际创建私有目录，并取得布局对象。
		const layout = await createLayout(dataDir);
		// 目录排序后比较固定四项，避免文件系统枚举顺序影响结果。
		expect((await readdir(dataDir)).sort()).toEqual(["logs", "plugins", "server", "workers"]);
		// & 屏蔽文件类型位，只比较八进制权限：所有者可读写进入，其他用户无权限。
		expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
		// 按顺序核对数据库、owner token 和 cookie 密钥的预期路径；这里不读取任何真实密钥。
		expect([layout.serverStore, layout.ownerToken, layout.cookieSecret]).toEqual([
			join(dataDir, "server", "store.sqlite"),
			join(dataDir, "owner-token"),
			join(dataDir, "server", "cookie-secret"),
		]);
		// 只确认默认路径规则，不创建此家目录路径。
		expect(defaultDataDir("acme")).toBe(join(homedir(), ".acme"));
	});
});

// 登记不需要 I/O 的路径编码用例。
describe("worker directories", () => {
	// 同步用例把含 ../ 的 id 送入路径函数；检查编码结果留在 doc 目录下，示例是字符串计算。
	it("encodes an address key as one directory name under its kind", () => {
		// 恶意外形的 id 被当作地址数据，不能成为真正父目录跳转。
		const dir = workerDirectory("/data", Doc({ id: "../../etc/x" }));
		// 目录父路径必须仍是指定 kind。
		expect(dirname(dir)).toBe("/data/workers/doc");
		// 核对竖线、点和斜杠都百分号编码。
		expect(basename(dir)).toBe("doc%7C%2E%2E%2F%2E%2E%2Fetc%2Fx");
		// 单点也编码，避免特殊目录名。
		expect(basename(workerDirectory("/data", Doc({ id: "." })))).toBe("doc%7C%2E");
	});

	// 用 a/A/看似编码的字符串作例子；把结果小写后仍应四项不同，模拟大小写不敏感比较。
	it("keeps keys differing only in case apart, lowercased as a case-insensitive file system sees them", () => {
		// map 回调逐个构造地址并提取目录名，不实际写磁盘。
		const names = ["a", "A", "%41", "%2541"].map((id) => basename(workerDirectory("/data", Doc({ id }))));
		// Set 去重后四项都在，说明这些特定输入不碰撞；不是所有字符串的数学证明。
		expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
	});

	// 以 200 个 x 触发长 key 路径，结果应是 sha256- 加 64 位十六进制。
	it("names a long key by its hash", () => {
		// repeat 构造长 id，basename 只取目录最后一段。
		const name = basename(workerDirectory("/data", Doc({ id: "x".repeat(200) })));
		// 正则验证命名格式，不计算独立摘要对照。
		expect(name).toMatch(/^sha256-[0-9a-f]{64}$/);
	});
});
