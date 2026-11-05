#!/usr/bin/env node
// 文件导读
// 所属：仓库根 scripts/ 的思考能力快照生成器，被 diff-model-catalog.mjs 的 --thinking 模式调用。
// 职责：读取一份模型目录 JSON，按当前工作区的 getSupportedThinkingLevels 规则计算每个模型的生效思考级别，
//   记录与级别同名的原生值映射，按 provider 写出紧凑 JSON 快照。
// 上游：diff-model-catalog.mjs（两侧 worktree 各运行一次）；也可手动执行。
// 下游：读取目录 JSON 与 packages/ai/src/models.ts 的实现；写 <output-dir>/providers/<provider>.json。
// 输入：位置参数 <catalog-path> <output-dir>；目录形状为 provider → modelId → model 对象。
// 输出：无 stdout；成功时退出码 0。缺参数/读盘/解析失败以未捕获异常退出（默认退出码 1）。
// 副作用：递归创建输出目录、覆盖同名 provider JSON；不清理旧文件、不联网、不调用模型。
// 幂等性：同一输入与同一实现产生相同文件。
// 示例：
//   node scripts/generate-thinking-capabilities.mjs .artifacts/model-catalog/models.json /tmp/thinking
// 建议阅读顺序：参数校验 → 目录遍历 → getSupportedThinkingLevels → thinkingLevelMap 过滤 → 写文件。
// 将聊天目录转成有效思考能力快照。输入是目录 JSON/输出目录，副作用为 mkdir 和写 JSON；不会调用模型。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// 从 TypeScript 源直接导入依赖 Node 的类型剥离；这是判断“支持哪些级别”的唯一规则来源。
import { getSupportedThinkingLevels } from "../packages/ai/src/models.ts";

// 数组解构取两个位置参数；slice(2) 跳过 Node 可执行文件和脚本路径。
const [catalogPath, outputDir] = process.argv.slice(2);
// 这是命令行输入边界：缺任一路径就拒绝继续，不会验证文件内容符合完整模型 schema。
if (!catalogPath || !outputDir) {
	// 以未捕获异常终止并显示用法，避免往未知位置生成文件。
	throw new Error("Usage: node scripts/generate-thinking-capabilities.mjs <catalog-path> <output-dir>");
}

// 同步读 UTF-8 JSON；期望 provider→id→聊天模型，读盘或解析失败直接抛出。
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
// 把按供应商输出统一放在 outputDir/providers。
const providersDir = join(outputDir, "providers");
// 递归创建输出目录，既有目录可复用；不会清理旧的供应商文件。
mkdirSync(providersDir, { recursive: true });

// entries 生成键值对，解构分别取得供应商 id 和该家的模型字典。
for (const [provider, models] of Object.entries(catalog)) {
	// 将下方每个 [模型id, 能力对象] 键值对还原为字典。
	const capabilities = Object.fromEntries(
		// 回调为每个模型生成一项，不修改输入模型；例 model.reasoning=false 时能力 levels 只有 off。
		Object.entries(models).map(([id, model]) => {
			// 按本工作区实际能力规则筛级别：非 reasoning 仅 off，null 禁用，xhigh/max 需显式映射；不探测远端。
			const levels = getSupportedThinkingLevels(model);
			// 只记录与统一级别名不同的原生值，避免重复保存默认同名映射。
			const values = Object.fromEntries(
				// flatMap 将每级别产生的零项/一项键值对数组合并一层；回调只决定输出记录。
				levels.flatMap((level) => {
					// 可选链在 map 缺失时得到 undefined，方括号用变量 level 取属性。
					const value = model.thinkingLevelMap?.[level];
					// 有显式且不同名映射才保留；例如 high→1024 输出一项，high→high 或缺映射输出空数组。
					return value !== undefined && value !== level ? [[level, value]] : [];
				}),
			);
			// 有非默认映射才带 values；三元表达式选输出形状，属性简写复用局部变量。
			return [id, Object.keys(values).length > 0 ? { levels, values } : { levels }];
		}),
	);
	// 按 provider 写紧凑 JSON，覆盖同名文件；该生成物用于目录比较，不手工改其正文。
	writeFileSync(join(providersDir, `${provider}.json`), JSON.stringify(capabilities));
}
