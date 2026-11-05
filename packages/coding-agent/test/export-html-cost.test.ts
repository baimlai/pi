// 检验HTML查看器的费用统计：读取真实查看器函数，在VM里对两条内存消息求和，不访问供应商账单或运行完整网页。
// 同步读取手写template.js；new URL会按测试模块位置找资源，而不是当前命令行目录。
import { readFileSync } from "node:fs";
// runInNewContext用传入对象建立JS上下文并执行字符串；这里执行可信本地源码片段，不能把VM当不可信代码安全沙箱。
import { runInNewContext } from "node:vm";
// Vitest提供分组、用例和断言，回调注册后由测试器调用。
import { describe, expect, it } from "vitest";

// type定义本例关心的最小结果形状，不必列出统计器实际返回的所有字段，也不在运行时验证VM结果。
type ExportStats = {
	// cost嵌套对象保存五项number，费用分项与总额分开，不要求总额等于分项和。
	cost: {
		// 输入费用的静态数值字段，不是输入token数。
		input: number;
		// 输出费用字段，同样与输出token数量不同。
		output: number;
		// 缓存读取费用字段。
		cacheRead: number;
		// 缓存写入费用字段。
		cacheWrite: number;
		// 记录的总费用可以与目录分项估计不同，这是这项回归要保护的行为。
		total: number;
	};
};

// 费用回归分组，下方保留原issue编号说明问题来源。
describe("export HTML cost", () => {
	// 一例同时放新旧两种记录：新记录总额0.9优先，旧记录缺总额则加0.4与0.1，最终1.4。
	it("uses recorded totals while falling back to component sums for old sessions", () => {
		// Regression test for #9980: provider-reported totals may differ from catalog-estimated components.
		// 以UTF8读取真实查看器源文本；这不是执行整个IIFE或导出会话文件。
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		// indexOf取函数声明锚点第一次出现的UTF16下标，找不到返回-1，不做JS语法级函数查找。
		const functionStart = templateJs.indexOf("function computeStats(entryList)");
		// 用全局统计调用文字作为切片结束边界，排除真正页面初始化的统计调用。
		const functionEnd = templateJs.indexOf("const globalStats = computeStats(entries);");
		// 起点必须非负；断言失败直接中止本例。
		expect(functionStart).toBeGreaterThanOrEqual(0);
		// 终点必须晚于起点，防止切出空串或倒序范围；只约束这两个文字锚点。
		expect(functionEnd).toBeGreaterThan(functionStart);

		// context起初空对象，result?允许VM运行前尚未有结果；类型注解不自动填result。
		const context: { result?: ExportStats } = {};
		// 执行下方拼成的源码：先放computeStats函数片段，再把JSON夹具传给它并将结果写到context.result。
		// 模板字符串含真实待执行文字，不能向其中随意插注释；JSON.stringify([...])的数组属于插值里的JS表达式，不是字符串正文。
		runInNewContext(
			`${templateJs.slice(functionStart, functionEnd)}
			result = computeStats(${JSON.stringify([
				// 第一个夹具对象将编码成VM代码的数据，下面所有字段只是内存记录，不构造真实AssistantMessage请求。
				{
					// type标记普通消息记录。
					type: "message",
					// message嵌套对象供统计器按角色读取。
					message: {
						// 助手角色才会进入助手费用累计分支。
						role: "assistant",
						// 空内容数组让工具调用计数为0，不把工具块数量混入费用验证。
						content: [],
						// 输入0.1+输出0.2虽为0.3，明确记录total为0.9；测试要求保留0.9而非重算覆盖。缺token字段由实际统计器按0处理。
						usage: { cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.9 } },
					},
				},
				// 第二条模拟旧会话记录：字段结构近似，但故意不提供cost.total。
				{
					// 同样属于message条目，不是用量预热条目或压缩条目。
					type: "message",
					// 其嵌套message与第一条各自独立，不复用对象引用。
					message: {
						// 仍为assistant，确保旧记录也进入相同统计路径。
						role: "assistant",
						// 空内容数组满足统计器扫描工具调用的需求。
						content: [],
						// 缺total时应取四分项和0.5；两个缓存费用0不影响本例总额。
						usage: { cost: { input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
					},
				},
			])});`,
			// context作为第二实参提供给VM，源码赋值result会在该上下文对象上留下结果。
			context,
		);

		// 输入费0.1+0.4约等0.5；toBeCloseTo允许浮点舍入，不像toBe要求数值完全相等。?.仅处理result缺失，缺失会使断言失败。
		expect(context.result?.cost.input).toBeCloseTo(0.5);
		// 输出费0.2+0.1约等0.3，与总额是否按分项重算分开验证。
		expect(context.result?.cost.output).toBeCloseTo(0.3);
		// 总额应为0.9+0.5=1.4，而非0.3+0.5=0.8；它证明聚合逻辑，不证明夹具费用是真实供应商账单。
		expect(context.result?.cost.total).toBeCloseTo(1.4);
	});
});
