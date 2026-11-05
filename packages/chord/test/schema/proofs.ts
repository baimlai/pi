// The values the schema switch must keep (`recorded.json`, made with the TypeBox helpers): the fingerprints and normal
// forms of `declarations.ts`, and what a host reads back from the stored data in `stored/`.

import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../../src/context/index.ts";
import type { Contract } from "../../src/contracts/index.ts";
import { contractData } from "../../src/contracts/internal.ts";
import { snapshotSchema } from "../../src/contracts/snapshot.ts";
import type { JsonValue } from "../../src/json.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { decodeJsonl, importStore, sqliteBackend } from "../../src/store/index.ts";
import * as declared from "./declarations.ts";
import { finished, ownerHost } from "./owner.ts";

/** Every fingerprint and normal form of the declarations. */
// 把当前手写声明整理成可与 recorded.json 深比较的 JSON；只读取元数据，不写文件也不打开主机。
// 这里比较的是规则的规范化形式及非安全用途的 hash 指纹，不证明所有可能输入的运行结果相同。
// 例：给 schema 加 description 可以仍有相同 normal，而改必填字段通常会改变指纹。
export function fingerprints(): JsonValue {
	// 此局部回调收任意合同 token，取私有元数据，再把 Map/历史版本转换为普通 JSON。
	const contract = (C: Contract) => {
		// contractData 取得声明时已快照的参数规则和版本历史，不重新推断运行中的对象。
		const data = contractData(C);
		return {
			// params 的 normal 已移除 schema 节点上的注释元数据并对相应键排序。
			params: data.params.normal,
			// map 每个版本生成一项，保留历史顺序；括号包住对象使箭头函数直接返回对象字面量。
			versions: data.versions.map((version) => ({
				fingerprint: version.fingerprint,
				// fromEntries 把 [键,值] 元组数组转成对象，便于 JSON 序列化和深比较。
				variants: Object.fromEntries(
					// [...Map] 转成条目数组；解构取变体名及其状态/方法表。
					[...version.variants].map(([name, variant]) => [
						name,
						{
							// 状态和 keyed 成员只记录各 schema 的 normal，不存运行时 Watchable。
							state: Object.fromEntries([...variant.state].map(([m, s]) => [m, s.normal])),
							keyed: Object.fromEntries([...variant.keyed].map(([m, s]) => [m, s.normal])),
							// 方法一项记录参数和返回规则；m 是方法名，嵌套解构取两个 schema 快照。
							methods: Object.fromEntries(
								[...variant.methods].map(([m, { args, result }]) => [
									m,
									{ args: args.normal, result: result.normal },
								]),
							),
						},
					]),
				),
			})),
		};
	};
	// 表元数据本身不是 JsonValue 类型；双重断言只帮助 TS 接受已知的普通记录，不校验或复制数据。
	// 例：table(Rows) 产生 { fingerprint, record }，不附带 SQL 连接或表句柄。
	const table = (T: { readonly fingerprint: string; readonly record: unknown }) => ({
		fingerprint: T.fingerprint,
		record: T.record as unknown as JsonValue,
	});
	// 下方逐项列出覆盖面，而非遍历模块所有导出，新增声明必须有意加入本清单。
	return {
		// 同时覆盖本地普通/keyed/方法合同、远程变体合同及持久化 Owner 合同。
		contracts: {
			everything: contract(declared.Everything),
			account: contract(declared.Account),
			owner: contract(declared.Owner),
		},
		documents: {
			profile: {
				fingerprint: declared.Profile.fingerprint,
				// 路径 "p" 只用于错误定位；snapshotSchema 会检查词汇并创建规范化副本。
				normal: snapshotSchema(declared.everything, "p").normal,
			},
			notes: declared.Notes.fingerprint,
			importState: declared.ImportState.fingerprint,
		},
		// 保留同一张 edits 的三个版本，确保重命名、默认列、删除列与索引后的记录定义兼容。
		tables: {
			rows: table(declared.Rows),
			editsV1: table(declared.EditsV1),
			editsV2: table(declared.EditsV2),
			editsV3: table(declared.EditsV3),
		},
		job: declared.ImportJob.fingerprint,
	};
}

// import.meta.url 指本模块位置，URL 相对它定位历史夹具；fileURLToPath 转为操作系统路径。
const stored = fileURLToPath(new URL("./stored/", import.meta.url));

/**
 * What a host of the current code reads from the stored data: from a copy of the SQLite store, and from a store
 * imported from the archive (both written at table version 1, read at version 3; the stopped job runs resume).
 */
// 接收读取用 context，返回 {store,archive} 两条恢复路线的观察结果，失败向调用者抛出。
// 只操作系统临时目录：复制旧 SQLite，再导入旧 JSONL 为第二份 SQLite，分别交给 read 迁移/恢复。
// 例：两份旧数据的 file 列都会按 V1→V2→V3 变成 path；finally 删除临时库，原夹具不改。
export async function storedReads(context: Context): Promise<JsonValue> {
	// mkdtemp 生成独一临时目录，避免同时运行测试时互相覆盖。
	const directory = await mkdtemp(join(tmpdir(), "chord-schema-switch-"));
	try {
		// 先复制 SQLite，当前代码的迁移/恢复写入只会落在副本上。
		const fromStore = join(directory, "store.db");
		await copyFile(join(stored, "store.db"), fromStore);
		// 等待第一条恢复路线完整结束，read 也会关闭其主机与 store。
		const store = await read(fromStore, context);
		// 第二条路线用全新库导入历史 archive；解码器从文件流逐条读取，不把它当 TypeScript 模块。
		const imported = await importStore(
			sqliteBackend(await openNodeSqliteDatabase(join(directory, "imported.db"))),
			decodeJsonl(createReadStream(join(stored, "archive.jsonl"))),
			context,
		);
		// 先关导入连接，再用 ownerHost 重新打开，使其走与复制库相同的激活流程。
		await imported.close(context);
		const archive = await read(join(directory, "imported.db"), context);
		return { store, archive };
	} finally {
		// 正常或异常都会尝试递归删除临时目录；清理失败也会让函数拒绝。
		await rm(directory, { recursive: true, force: true });
	}
}

/** The owner's dump on the store at `path`, after its stopped runs finished. */
// 在指定库恢复 Owner，最多轮询约一秒等三个 finish，读取 dump/笔记后关闭资源并返回 JSON。
// finished 不足三个时不会在这里主动抛超时，而是返回实际记录，让测试的深比较暴露差异。
// 例：旧夹具三次 write 启动的任务在 "finish" 模式恢复后，finished 应有三项 count=2。
async function read(path: string, context: Context): Promise<JsonValue> {
	// 原地清空共享数组，保持 owner.ts 中 finish 闭包持有的数组身份不变。
	finished.length = 0;
	const { store, host } = await ownerHost(path, declared.EditsV3, "finish", context);
	// get 等待对象 live 且状态加载完；引用会随后由 host.close 结束。
	const owner = await host.get(declared.Owner, {}, context);
	// 每轮让出 10ms，三项已经到齐就提前停止；这是有界等待，不保证定时器精确。
	for (let i = 0; i < 100 && finished.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	// dump 是异步对象方法，返回值的 unknown 类型由这里的测试前提解释为 JSON。
	const dump = await owner.dump({}, context);
	const result = {
		dump: dump as JsonValue,
		// 浅拷贝数组固定本轮记录，下一次 read 清空 finished 时不会清掉这个返回数组。
		finished: [...finished] as JsonValue,
		note: await owner.read("b", context),
	};
	// 主机先停对象/任务并完成关闭写入；store 由调用者拥有，必须随后独立关闭。
	await host.close(context);
	await store.close(context);
	// 这里没有局部 finally；若 dump/close 先失败，外层只保证删除临时目录，并非关闭全部资源。
	return result;
}
