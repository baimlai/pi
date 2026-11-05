// Writes the stored data of the schema switch's proof (`stored/`): a SQLite store and its export archive, made by the
// code before the switch (TypeBox helpers). Kept as it was written; rerun only to make a new fixture on purpose.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/schema/write-stored.ts
// 这是会覆盖 stored/ 夹具的独立入口，不能作为日常兼容性测试运行；仅阅读以追溯历史数据来源。
// 输入为 declarations.ts/owner.ts 的旧 TypeBox 实现；当前代码即使重跑也不能再证明“切换前生成”。
// recorded.json 另外记录 proofs.ts 的 fingerprints/storedReads 结果，本脚本没有写该 JSON 的语句。

import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { encodeJsonl } from "../../src/store/index.ts";
import { EditsV1, Owner } from "./declarations.ts";
import { ownerHost } from "./owner.ts";

// 从脚本所在目录定位输出，不依赖启动命令的当前路径。
const stored = fileURLToPath(new URL("./stored/", import.meta.url));
// 临时库用唯一目录，最后成功才复制到固定夹具路径；顶层 await 使模块加载也会执行这些副作用。
const directory = await mkdtemp(join(tmpdir(), "chord-schema-switch-"));
const path = join(directory, "store.db");
try {
	// 第一版表仍含 file 字段；"wait" 让任务写进度后停在取消信号上，留给重启恢复测试。
	const { store, host } = await ownerHost(path, EditsV1, "wait", context);
	const owner = await host.get(Owner, {}, context);
	// as const 使嵌套数组按只读字面量元组推导；解构依次取三组 id/body，不是运行时冻结。
	for (const [id, body] of [
		["a", "first note"],
		["b", "second"],
		["c", "third one"],
	] as const) {
		// 每次 write 先提交数据，再提交任务意图；await start 不等于等待 run 最终结束。
		await owner.write({ id, body }, context);
	}
	// 给后台 run 时间写进度；固定 200ms 是夹具脚本的等待方式，不构成所有任务已到位的检查。
	await new Promise((resolve) => setTimeout(resolve, 200));
	// 创建输出目录；已有目录保留，下面的流会覆盖同名 archive.jsonl。
	await mkdir(stored, { recursive: true });
	// export 产生异步归档片段，encodeJsonl 编为一行一个 JSON；pipeline 处理背压并传播流错误。
	await pipeline(encodeJsonl(store.export(context)), createWriteStream(join(stored, "archive.jsonl")));
	// A clean close: the waiting runs are stored `stopped`, resumed by the next host.
	// 导出发生在关主机前；下面的干净关闭再把 SQLite 中未完任务记为 stopped，然后关库连接。
	await host.close(context);
	await store.close(context);
	// 只在 store 关闭后复制 SQLite 主文件；覆盖历史 store.db 是本脚本的有意副作用。
	await copyFile(path, join(stored, "store.db"));
	// 控制台输出实际保存位置，不影响夹具内容。
	console.log("written to", stored);
} finally {
	// 成功/失败都尝试删临时目录；没有这里就会把中间数据库遗留在系统临时目录。
	await rm(directory, { recursive: true, force: true });
}
