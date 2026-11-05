// 直接测试上传管理器的并发名额和清理；所有上传文件都在临时目录。
// Tests of chunked uploads on their own (slice 13 §4): the cap of uploads under way, a slot freed by expiry or by the
// object's end, the files of ended uploads removed. Their use through `Files` (pipelined appends, finish waiting for
// writes, caps) is in `files.test.ts`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Uploads } from "../../../src/node/app/uploads.ts";
import { tempDir } from "./support.ts";

// 登记上传名额机制测试。
describe("uploads under way", () => {
	// 用最多一个进行中上传的管理器，依次试超额、未过期、立即过期和关闭后重用。
	// 例如 begin(a) 后 begin(b) 应 busy；expire(0) 删除 a，b 才能开始；只产生临时文件，无远程上传。
	it("refuses a begin past the cap busy; an expired upload frees its slot and its file (recheck N1)", async () => {
		// 生成专属 run 路径；tempDir 的 afterEach 会删除整个临时根。
		const run = join(await tempDir(), "run");
		// 把同时进行的上传上限设为 1，构造时尚不创建文件。
		const uploads = new Uploads(run, 1);
		// 开始 a，创建文件和句柄，得到随机上传 id；x 是测试 MIME 字符串。
		const first = await uploads.begin("a", "x");
		// 第二次 begin 超过名额，等待 Promise 拒绝并比较错误分类。
		await expect(uploads.begin("b", "x")).rejects.toMatchObject({ code: "unavailable", reason: "busy" });
		// 只有闲置至少一分钟才过期，刚建立的 a 应保留。
		await uploads.expire(60_000);
		// 还没 append，所以已接收字节数为 0。
		expect(await uploads.uploaded(first)).toBe(0);
		// 以 0 闲置阈值立即回收当前上传与文件。
		await uploads.expire(0);
		// 旧 id 已不在进行中集合，再查询应无效。
		await expect(uploads.uploaded(first)).rejects.toMatchObject({ code: "invalid" });
		// 名额已释放，b 可以创建并取得新 id。
		const second = await uploads.begin("b", "x");
		// 只剩 b 的临时文件，a 的文件确已删除。
		expect(await readdir(run)).toEqual([second]);
		// close 等待写入并删除全部进行中的上传；此管理器没有永久关闭标志。
		await uploads.close();
		// 关闭清理后 run 目录保留，但其中无文件。
		expect(await readdir(run)).toEqual([]);
		// 直接管理器清空后仍可 begin；此断言不意味着已结束的 Files 对象还能接受调用。
		expect(await uploads.begin("c", "x")).toEqual(expect.any(String));
		// close 等待写入并删除全部进行中的上传；此管理器没有永久关闭标志。
		await uploads.close();
	});
});
