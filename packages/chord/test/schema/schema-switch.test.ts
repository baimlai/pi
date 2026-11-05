// Tests of the schema switch from TypeBox to pi-schema (decision "A schema package beneath pi-ai and Chord"): the same
// declarations give byte-identical fingerprints and normal forms, and data stored by the code before the switch loads
// after it (`recorded.json` and `stored/` were made with the TypeBox helpers, see `write-stored.ts`).
// 两个用例分别检查声明元数据兼容，以及真实旧库/旧归档的迁移与任务恢复；不重建历史基线。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { fingerprints, storedReads } from "./proofs.ts";

// 在模块加载时同步读历史 JSON；JSON.parse 是实际解析边界，但这里没有额外 schema 校验。
const recorded = JSON.parse(readFileSync(new URL("./recorded.json", import.meta.url), "utf8"));

describe("fingerprints", () => {
	// 无参数同步用例：生成当前元数据，与旧 TypeBox 基线深比较，字段/数组顺序差异也会失败。
	// 例如合同指纹改变会定位到 recorded.fingerprints 对应位置；不执行任何模型或网络请求。
	it("keeps every fingerprint and normal form of contracts, documents, tables, json columns and jobs", () => {
		// toEqual 比较结构和值，不要求结果与解析出的历史对象是同一引用。
		expect(fingerprints()).toEqual(recorded.fingerprints);
	});
});

describe("stored data", () => {
	// 无参数异步用例：等待临时库的两条恢复路线，再比较文档/表/迁移结果/任务完成记录。
	// 例：旧 edits.file 经迁移后应为 path，且等待中的任务恢复后不再列在 running 中。
	it("reads a store and an archive written before the switch: documents, tables, a migrated table, stopped runs", async () => {
		// 使用无取消信号的后台 context；storedReads 自己管理临时目录，断言拒绝会使本用例失败。
		expect(await storedReads(context)).toEqual(recorded.stored);
	});
});
