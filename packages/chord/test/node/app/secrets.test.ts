// 验证测试专用随机 token、摘要比较和临时密钥文件，不读取用户的真实 token。
// Tests of the kit's secrets (slice 13 §2): random tokens, hashes compared in constant time, and secret files written
// with mode 0600 in one step (a create never overwrites, a replace swaps whole files, no temporary file left).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	hashToken,
	matchesHash,
	newToken,
	readSecret,
	secretFile,
	writeSecret,
} from "../../../src/node/app/secrets.ts";
import { tempDir } from "./support.ts";

// 登记 token 编码与摘要匹配测试；常量时间比较由实现调用 crypto API，本例不测时间差。
describe("tokens and hashes", () => {
	// 同步用例生成随机 token、计算 SHA-256，再验证原值匹配、改值不匹配。
	// 例如默认32字节编码为43字符；100项无重复只是本次抽样，不证明永不碰撞。
	it("makes distinct base64url tokens of the asked size and matches only their own hash", () => {
		// 生成默认 32 字节随机值的 base64url 字符串。
		const token = newToken();
		// 检查长度43及 URL 安全字符集。
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// 显式12字节应编码为16字符。
		expect(newToken(12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
		// 生成一百次后以 Set 去重，检查这批样本无重复。
		expect(new Set(Array.from({ length: 100 }, () => newToken())).size).toBe(100);
		// 对本次 token 计算摘要；不把摘要当成原始凭证。
		const hash = hashToken(token);
		// SHA-256 十六进制表示应长64字符。
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// 原 token 与自己的摘要相符。
		expect(matchesHash(token, hash)).toBe(true);
		// 追加一个字符会改变摘要，不能通过匹配。
		expect(matchesHash(`${token}x`, hash)).toBe(false);
		// 异常短摘要被判为不匹配，本例不测试全部错误编码。
		expect(matchesHash(token, "short")).toBe(false);
	});
});

// 登记临时目录中的密钥文件写入行为。
describe("secret files", () => {
	// 异步用例按不存在→create→重复create→replace 顺序写临时文件，检查内容、权限和临时文件清理。
	// 例如 create("two") 返回 exists，旧内容 one 保留；无真实应用密钥被改动。
	it("creates a file with mode 0600, never overwrites it on create, replaces it whole, leaves no temporary file", async () => {
		// 建立并登记自动清理的临时目录。
		const dir = await tempDir();
		// 拼出本例密钥文件路径。
		const path = join(dir, "secret");
		// 文件未创建时读取返回 undefined。
		expect(await readSecret(path)).toBeUndefined();
		// 第一次排他创建成功。
		expect(await writeSecret(path, "one", "create")).toBe("written");
		// 屏蔽文件类型位，检查仅所有者读写。
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		// create 不覆盖已存在的文件。
		expect(await writeSecret(path, "two", "create")).toBe("exists");
		// 读取辅助函数会 trim，返回原值 one。
		expect(await readSecret(path)).toBe("one");
		// replace 用完整新文件替换旧内容。
		expect(await writeSecret(path, "three", "replace")).toBe("written");
		// 直接读文件保留写入的尾换行，区别于 readSecret。
		expect(await readFile(path, "utf8")).toBe("three\n");
		// 屏蔽文件类型位，检查仅所有者读写。
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		// 目录只剩目标文件，临时文件未泄漏。
		expect(await readdir(dir)).toEqual(["secret"]);
	});

	// 首次 secretFile 创建随机值，此后读取同一路径必须复用；此例检查复用和0600权限。
	it("keeps a secret file's first value: a fresh token at first, then that one", async () => {
		// 建立并登记自动清理的临时目录。
		const dir = await tempDir();
		// 该名字属于临时目录，与用户真实 cookie-secret 无关。
		const path = join(dir, "cookie-secret");
		// 首次缺失时生成并持久化新 token。
		const first = await secretFile(path);
		// 验证新值的编码形状。
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// 第二次调用读回相同值，不能每次重置签名密钥。
		expect(await secretFile(path)).toBe(first);
		// 屏蔽文件类型位，检查仅所有者读写。
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	// 暂将当前测试进程 umask 设为0，再创建文件，确认显式权限仍是0600；finally 恢复原掩码。
	it("keeps the mode 0600 under a permissive umask", async () => {
		// 建立并登记自动清理的临时目录。
		const dir = await tempDir();
		// 保存旧文件权限掩码并暂时放开默认限制；影响当前进程，所以必须恢复。
		const previous = process.umask(0);
		// 将写入包进清理保护范围。
		try {
			// 在临时路径按 create 模式写入固定样例 x。
			await writeSecret(join(dir, "s"), "x", "create");
			// 即使写入失败，也要恢复进程设置。
		} finally {
			// 恢复用例开始前的 umask。
			process.umask(previous);
		}
		// 最后读取实际文件权限，验证不是依赖 umask 才变成私有。
		expect((await stat(join(dir, "s"))).mode & 0o777).toBe(0o600);
	});
});
