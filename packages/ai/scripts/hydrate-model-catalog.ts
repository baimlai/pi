#!/usr/bin/env node
// 将本地models.all.json里的模型值装入指定包的data目录，供Nix构建/pin更新或直接CLI调用；本文件不下载目录。
// hydrate在这里意为补齐本地数据，不生成或改写.models.ts/聚合TS；导入只定义函数，底部入口条件成立才真正执行。

// 同步文件API用于暂存、校验后替换和清理；不是异步事务，删除旧目录后重命名失败没有回滚。
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
// dirname/join按本文件推包根，resolve把CLI路径相对当前cwd转绝对路径，不验证文件存在。
import { dirname, join, resolve } from "node:path";
// fileURLToPath把模块URL转本机路径，pathToFileURL用于判断是否直接运行此文件；均不发网络请求。
import { fileURLToPath, pathToFileURL } from "node:url";
// 以下助手共享生成数据格式；type导入项运行时擦除，函数与常量才是运行时依赖。
import {
	// 计算结构/正文摘要并创建manifest，不自动写文件。
	createModelDataManifest,
	// 按API和type:id分组，保留模型对象的额外字段。
	groupProviderModelData,
	// 清单固定文件名.manifest.json。
	MODEL_DATA_MANIFEST_FILE,
	// 最小模型身份字段类型，仅提供开发期约束。
	type ModelCatalogEntry,
	// provider→type:id→api的结构类型，不是模型全部字段。
	type ModelDataStructure,
	// 从既有生成聚合TS文字提取必须供齐的provider名单。
	readModelDataProviderIds,
	// 校验暂存JSON/manifest的必要字段与一致性，失败抛错。
	validateModelDataDirectory,
} from "./model-data.ts";

// 交叉类型&同时要求type/id/api三键及任意其他unknown字段；不会丢弃额外字段或复制嵌套对象。
type CatalogEntry = ModelCatalogEntry & Record<string, unknown>;

// 检查unknown是否非null非数组对象，返回TS类型谓词不改值；例如{}通过，但不保证纯原型或自有字段。
function isRecord(value: unknown): value is Record<string, unknown> {
	// 三项&&都满足才true；typeof null的特殊结果由显式比较排除。
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 对单条输入先做最小身份检查，返回类型谓词、不转换数据；例：api空串不通过，type/id空串本关仍通过。
// 名称、cost、窗口等在写入暂存后由目录校验器继续检查，这不是一次完整模型schema验证。
function isCatalogEntry(value: unknown): value is CatalogEntry {
	// 括号包多行boolean表达式，return返回整个&&链结果。
	return (
		// 先要求对象，短路保证后面可以读字段。
		isRecord(value) &&
		// type只查string，尚未限制为三种支持的类型。
		typeof value.type === "string" &&
		// id只查string，不在此trim或要求非空。
		typeof value.id === "string" &&
		// api先查string再读length。
		typeof value.api === "string" &&
		// api须至少一个码元，但只有空格仍可能通过。
		value.api.length > 0
	);
}

/**
 * Hydrate the checkout's provider data files from a published typed catalog
 * (`models.all.json`) without network access. With `validateOnly`, stage and
 * validate the data without replacing the checkout's current data.
 */
// 从catalogPath同步读JSON，按packageRoot已有provider名单分组，造固定时刻manifest，写暂存并验证；成功返回void，不访问网络。
// options.validateOnly真时仍创建/删除暂存目录，但不替换现有data；例：本地目录多出额外provider时忽略它，缺少本包要求的provider则抛。
// 解析/分组错误发生在建暂存之前；建暂存之后用finally清理。真正替换先rm旧data再rename，没有备份/事务，rename失败可能留下data缺失。
export function hydrateModelCatalog(
	// 指定目标AI包根目录，既有src/models.generated.ts决定所需provider，src/providers须存在供创建暂存。
	packageRoot: string,
	// 输入本地JSON文件路径，不是URL，未在此检查发布者签名或下载完整性。
	catalogPath: string,
	// 缺选项才新建空对象；字段?可省，运行时按真值决定只验证，不由类型进行输入验证。
	options: { validateOnly?: boolean } = {},
// 同步函数成功返回undefined，错误作为同步异常向调用方传播。
): void {
	// 同步读UTF8并JSON.parse，结果立刻置unknown；读取/语法异常此处直接抛，不统一包装。
	const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
	// 顶层不是非null非数组对象立即拒绝，无文件替换。
	if (!isRecord(catalog)) throw new Error("Model catalog must be an object");

	// 新普通对象收集将写出的provider文件名→正文；尚未写磁盘。
	const files: Record<string, string> = {};
	// 收集各provider的结构映射，稍后计算结构hash。
	const structure: ModelDataStructure = {};
	// 只遍历聚合TS里已有provider，顺序由提取助手排序；不会按输入目录额外键自动新增供应商。
	for (const provider of readModelDataProviderIds(packageRoot)) {
		// 读取输入对象相应属性；普通对象读取未使用hasOwn，不是任意原型对象的消毒边界。
		const models = catalog[provider];
		// undefined意味着未提供此provider，立即抛；null会由下面数组要求拒绝。
		if (models === undefined) throw new Error(`Model catalog is missing provider: ${provider}`);
		// 必须是非空数组，不能把旧的id→模型对象格式当新版typed数组。
		if (!Array.isArray(models) || models.length === 0) {
			// 没有模型列表就报该provider，不继续尝试落盘。
			throw new Error(`Model catalog has no typed model list for provider: ${provider}`);
		}
		// 为本provider建已过最小guard的条目数组，数组类型不补全模型字段。
		const entries: CatalogEntry[] = [];
		// 逐条遍历JSON模型数组；成员即使是null等坏值也要交给下面guard拒绝，不自动过滤。
		for (const model of models) {
			// 任一最小身份字段不符就中止，不悄悄过滤坏条目。
			if (!isCatalogEntry(model)) throw new Error(`Model catalog has an invalid entry for provider ${provider}`);
			// 保存同一模型对象引用，不clone、删多余字段或转字段类型。
			entries.push(model);
		}
		// 按API与type:id分组，正常同API重复身份会在助手里抛错。
		const grouped = groupProviderModelData(provider, entries);
		// 把当前provider的结构存入两层映射，普通对象不是Map。
		structure[provider] = grouped.structure;
		// 序列化完整分组模型后加一个LF，正文空白也会纳入文件hash；不序列化注释。
		files[`${provider}.json`] = `${JSON.stringify(grouped.groups)}\n`;
	}

	// Public catalogs have no generation timestamp. Use a fixed stamp so hydration
	// produces identical bytes for identical input, regardless of build time.
	// 固定生成时刻避免每次运行时钟改变manifest；摘要输入只有结构与各JSON文本，不含本脚本源码。
	const manifest = createModelDataManifest(structure, files, "1970-01-01T00:00:00.000Z");
	// 定位目标providers目录，不新建这个父目录。
	const providersDir = join(packageRoot, "src", "providers");
	// mkdtempSync在目标providers下创建随机后缀暂存根；调用发生在try之前，创建失败没有本次finally可清。
	const stagingRoot = mkdtempSync(join(providersDir, ".model-hydration-"));
	// 暂存data子目录路径此时尚未建立。
	const stagedData = join(stagingRoot, "data");
	// 从这里进入finally保护，后续早return或抛错都尝试删暂存根，清理失败可覆盖原错误。
	try {
		// 建立暂存data目录，父暂存根已存在，不开recursive。
		mkdirSync(stagedData);
		// 遍历每份内存正文并同步写暂存文件，写失败进入finally，不是批量原子写入。
		for (const [name, content] of Object.entries(files)) writeFileSync(join(stagedData, name), content);
		// 将清单序列化加LF写入同一暂存目录。
		writeFileSync(join(stagedData, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		// 用已收集结构校验暂存内容，必要字段/跨组重复/manifest错误都在旧data删除之前拒绝。
		validateModelDataDirectory(structure, stagedData);
		// 真值表示只验证，return仍触发finally；不等于整个函数没有任何文件写入。
		if (options.validateOnly) return;
		// 确定现有正式data目录目标。
		const dataDir = join(providersDir, "data");
		// 递归强制删除旧data，缺失不报ENOENT；不是把旧目录保留为可回滚备份。
		rmSync(dataDir, { recursive: true, force: true });
		// 重命名暂存data为正式data；同步失败时旧data已经删去，本函数没有自动恢复。
		renameSync(stagedData, dataDir);
	// finally无论验证早返、替换成功或出错都运行，未catch原错误。
	} finally {
		// 删除整个暂存根；成功rename后它已不含data，失败时也会删除剩余暂存材料。
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

// 直接入口门禁：有argv[1]且其绝对file URL精确等模块URL才执行；正常import此模块不会自动运行hydrate，未解析符号链接别名。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	// CLI恰好需要一个catalog文件参数，参数不符同步抛Usage；没有通用命令行选项解析。
	if (process.argv.length !== 3) throw new Error("Usage: node hydrate-model-catalog.ts <models.all.json>");
	// 包根取当前脚本上一级，输入文件按cwd resolve，再同步水合；没有try/catch把失败改为成功。
	hydrateModelCatalog(join(dirname(fileURLToPath(import.meta.url)), ".."), resolve(process.argv[2]));
}
