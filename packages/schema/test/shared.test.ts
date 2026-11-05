// 在本地V8中验证纯类型check的身份复用与正则弱缓存回收；主动GC只为测试观察，不代表业务代码能保证何时自动回收。
// Values shared across compiled schemas hold nothing alive: a cached pattern goes once its schemas are collected.

// V8测试接口用于打开gc入口，不是pi-schema校验逻辑的依赖。
import { setFlagsFromString } from "node:v8";
// vm创建新上下文取得暴露的gc函数；执行的是下面固定字符串，不执行用户输入。
import { runInNewContext } from "node:vm";
// Vitest登记两例并比较函数引用/缓存项数。
import { describe, expect, it } from "vitest";
// compile从规则生成验证器，其check可能复用模块级叶检查或持有正则的闭包。
import { compile } from "../src/index.ts";
// 计数函数只读缓存Map.size，包括尚未清理的弱引用项，不主动GC。
import { sharedRegexCount } from "../src/shared.ts";

// 在当前测试进程开启暴露gc标志；这是V8专用测试安排，不适用于所有JS运行时。
setFlagsFromString("--expose-gc");
// 新上下文表达式返回gc函数，as () => void仅给TS调用签名，不验证运行值或创建包装函数。
const gc = runInNewContext("gc") as () => void;

// 异步辅助给GC/弱引用清理多轮机会：无参数/结果，逐轮等setImmediate再调用gc；固定六轮是测试策略，不是任意宿主回收时限保证。
async function collectGarbage(): Promise<void> {
	// round从0到5共六次，不在同一同步栈连续调用完。
	for (let round = 0; round < 6; round++) {
		// Promise由下一次setImmediate回调完成，让执行跨越当前任务，给弱引用与清理回调机会；await不阻塞整个线程。
		await new Promise((resolve) => setImmediate(resolve));
		// 显式请求一次GC，不直接删除shared.ts缓存项。
		gc();
	}
}

// 共享检查分组：先比较裸type函数，再观察不同pattern对象何时可回收。
describe("shared checks", () => {
	// 两个只带描述信息的string规则应复用同一个基础check；注解字段不增加校验约束。
	it("share the module-level check of a bare type", () => {
		// 第一schema有description:a，但实质只有type:string。
		const a = compile({ type: "string", description: "a" });
		// 第二schema改title:b，校验语义仍相同。
		const b = compile({ type: "string", title: "b" });
		// toBe比较同一函数对象，不只是对同一输入返回相同结果。
		expect(a.check).toBe(b.check);
	});

	// 弱缓存例子造50种pattern，再造重复的第0种；释放第一批check后，重复者仍保持一种正则存活，其余应被清理。
	it("share a pattern's regular expression and drop it with the last schema that uses it", async () => {
		// 先跨任务GC，减少前面测试遗留的缓存项对基线影响。
		await collectGarbage();
		// 保存当前Map项数，后面的增量按此计算，不假定整套测试进程缓存必为0。
		const before = sharedRegexCount();
		// let联合undefined允许稍后丢掉数组；只保留check:object视图供WeakRef引用，不代表check真的不是函数。Array.from生成50个验证器。
		let validators: { check: object }[] | undefined = Array.from({ length: 50 }, (_, i) =>
			// 每个i形成不同的锚定正则源码，^unique-0$到^unique-49$，因此预期新增50项。
			compile({ type: "string", pattern: `^unique-${i}$` }),
		);
		// 再次编译第0种pattern；不同check闭包可共用同一个RegExp，因此缓存不再新增第51项。
		const again = compile({ type: "string", pattern: "^unique-0$" });
		// 比较基线+50验证源码相同会复用缓存项。
		expect(sharedRegexCount()).toBe(before + 50);
		// 在释放第一批前实际调用一次again.check，确认复用的正则能正确匹配；这次调用本身不保证对象以后永不回收。
		expect(again.check("unique-0")).toBe(true);
		// WeakRef弱指向第一批第0个check闭包，而不是直接指向RegExp；again的另一个check可独立持有同一正则。
		const check = new WeakRef(validators[0].check);
		// 丢掉第一批验证器数组的强引用，不能再通过它保持那50个闭包存活。
		validators = undefined;
		// 等多轮任务/GC，给闭包回收及正则清理回调运行机会，不靠固定毫秒sleep。
		await collectGarbage();
		// `again` still uses ^unique-0$; the other 49 patterns are gone.
		// 原check闭包应已不可取得，证明弱观察本身没有让它强存活；即使again的正则仍活着也不保原闭包。
		expect(check.deref()).toBeUndefined();
		// 最终只比基线多1项：again仍用第0种正则，其余49种清理；这是本例观察，不是读取size就会触发清理。
		expect(sharedRegexCount()).toBe(before + 1);
	});
});
