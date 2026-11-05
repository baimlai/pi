// 验证显式carrier跨本地进程/实例传播与link关联：父关系、共享工作、快照复制和未知身份回退。测试只启动受控Node worker，无HTTP或真实遥测服务。
// 内置execFileSync启动指定程序并等它退出，参数列表直接传递，不经shell插值。
import { execFileSync } from "node:child_process";
// fileURLToPath把import.meta.url推导出的file URL正确转换成本地路径，包含空格也不用手拆。
import { fileURLToPath } from "node:url";
// Vitest负责分组、注册用例和断言；下列均为本地进程/内存测试。
import { describe, expect, it } from "vitest";
// 多行导入同时取真实运行值和仅供TS的type声明。
import {
	// 内存实现拥有自己的scope和日志。
	InMemoryTelemetryContext,
	// 空记录上下文照常执行callback，但不写span记录。
	NOOP_TELEMETRY_CONTEXT,
	// 空传播实现注入undefined，提取任何carrier回同一空上下文。
	NOOP_TELEMETRY_PROPAGATION,
	// type RecordedTelemetrySpan是规范快照形状，运行时擦除。
	type RecordedTelemetrySpan,
	// type SpanAttributes用于测试故意修改返回快照，不是业务输入转换器。
	type SpanAttributes,
	// carrier是可序列化字符串字典，不是跨进程传递活span对象。
	type TelemetryCarrier,
	// TelemetrySpan类型描述带记录方法的上下文句柄。
	type TelemetrySpan,
} from "../src/index.ts";

// 传播与link分组：传播决定新span的父身份，link只声明关联，六例分别验证进程、并发、复制和回退。
describe("propagation and links", () => {
	// 本例先结束caller并序列化carrier，再启动Node子进程，验证没有共享记录器state也能保留外部父身份。
	it("continues a parent in another Node process without shared recorder state", async () => {
		// 父进程创建独立记录器。
		const telemetry = new InMemoryTelemetryContext();
		// carrier初始undefined，由同步进入的callback填入；联合类型提醒后续可能无注入结果。
		let carrier: TelemetryCarrier | undefined;
		// 启动caller且等待它结束；传播身份在结束后仍可使用。
		await telemetry.startSpan({ name: "caller" }, (span) => {
			// 导出一份独立字符串字典，不把真实span传给另一个进程。
			carrier = telemetry.inject(span);
		});
		// 同步启动并收集完整stdout，启动失败/非零退出会抛错，这里不吞成空成功结果。
		const output = execFileSync(
			// process.execPath是当前Node可执行路径，避免PATH找到另一个解释器。
			process.execPath,
			// 参数依次是同目录worker绝对路径与carrier JSON；URL相对当前模块定位，不依赖运行命令的cwd。
			[fileURLToPath(new URL("./propagation-worker.ts", import.meta.url)), JSON.stringify(carrier)],
			// encoding:"utf8"让输出直接成为字符串，否则Node默认返回Buffer。
			{ encoding: "utf8" },
		);
		// 解析受控子进程输出后as断言快照数组，不增加形状检查；坏JSON仍会抛错。
		const recorded = JSON.parse(output) as RecordedTelemetrySpan[];
		// 子进程只记录一个remote span，没有复制caller本地日志。
		expect(recorded).toHaveLength(1);
		// 子span保留外部caller的完整parentContext。
		expect(recorded[0]?.parentContext).toEqual(carrier);
		// parentId是本实例数字父id；外部父没有这个本地id，因此为null，不代表没有外部父身份。
		expect(recorded[0]?.parentId).toBeNull();
		// 孩子自己的context与父不同，不能直接把同一carrier当新span身份。
		expect(recorded[0]?.context).not.toEqual(carrier);
	});

	// 并发例子：两个触发各有method父，首次触发创建共享activation根，后来的触发只link它；gate让两路交叉且可控结束。
	it("isolates crossed concurrent remote parents and links shared roots", async () => {
		// caller保存两次触发自己的span。
		const caller = new InMemoryTelemetryContext();
		// provider保存method和共享根，scope与caller不同。
		const provider = new InMemoryTelemetryContext();
		// 稍后保存activation真实句柄，让第二路可建立关联；不是存快照冒充context。
		let activation: TelemetrySpan | undefined;
		// 括号中的() => void是无参回调类型，外层| undefined表示解除gate的函数尚未填入。
		let finishActivation: (() => void) | undefined;
		// Promise<void>作为手动闸门，不返回业务值；执行器立即运行，故resolve句柄可在创建时保存。
		const gate = new Promise<void>((resolve) => {
			// 保存resolve，调用它只是完成gate，不会取消其他任务。
			finishActivation = resolve;
		});
		// 共享Promise初始缺省，首路创建后两路等待同一个工作结果。
		let shared: Promise<void> | undefined;
		// Promise.all同时等待map生成的两条异步链，任何拒绝会向外传播；它本身不自动取消另一条链。
		await Promise.all(
			// map按数组顺序同步调用两个启动入口，返回两个Promise供all等待，不是开两个OS进程。
			["first", "later"].map((name) =>
				// name属性简写保留first/later；trigger是各自真实父句柄，async使后续等待可交叉。
				caller.startSpan({ name }, async (trigger) => {
					// caller导出trigger身份，provider提取为自己的父上下文；显式传递避免共享“当前父”串线。
					const parent = provider.extract(caller.inject(trigger));
					// 在所提取父下建first.method/later.method；模板插值只是名字，不决定父关系。
					await parent.startSpan({ name: `${name}.method` }, async (getter) => {
						// 只在shared尚未赋值时创建activation。此测试启动callback同步进入，首次挂起前会完成赋值所需的启动过程。
						if (!shared)
							// 调用provider根入口，所以activation无父；options里的link只关联getter，不把getter设为父。
							shared = provider.startSpan({ name: "activation", links: [{ context: getter }] }, async (span) => {
								// 保存activation句柄，让后一路能反向link共享根。
								activation = span;
								// 共享工作等gate，模拟一个尚未完成的公共初始化；没有定时器或远端请求。
								await gate;
							});
						// activation已存在时，每个method追加指向它的link；记录关联不改变自己parentContext。
						if (activation) getter.addLink({ context: activation });
						// 第二路解除gate；?.在句柄缺省时跳过，不是强制保证任何错误执行顺序都能解锁。
						if (name === "later") finishActivation?.();
						// 两个method都等待同一个shared完成，之后各自结束。
						await shared;
					});
				}),
			),
		);
		// all完成后再读provider快照，避免把打开状态误当已结束结果。
		const spans = provider.getSpans();
		// find按名字找共享根，没找到时undefined会被下一断言暴露。
		const root = spans.find((span) => span.name === "activation");
		// 根必须parentContext为null，link并没有偷偷变成父子边。
		expect(root?.parentContext).toBeNull();
		// 按名字找到first的method。
		const first = spans.find((span) => span.name === "first.method");
		// 同样找到later的method。
		const later = spans.find((span) => span.name === "later.method");
		// 第一路父context对应caller第0条记录，不能被第二路覆盖。
		expect(first?.parentContext).toEqual(caller.getSpans()[0]?.context);
		// 第二路父context对应caller第1条记录，分别保持身份。
		expect(later?.parentContext).toEqual(caller.getSpans()[1]?.context);
		// activation的创建时link指向第一路getter。
		expect(root?.links[0]?.context).toEqual(first?.context);
		// later.method追加的link指向共享根，表示“使用了同一初始化”。
		expect(later?.links[0]?.context).toEqual(root?.context);
	});

	// 复制例子：结束target→改inject返回值→建立link→再改快照carrier/标签，验证内部身份仍保留原值。
	it("detaches carrier and link snapshots and retains settled target identities", async () => {
		// 新记录器隔离此例数据。
		const telemetry = new InMemoryTelemetryContext();
		// target先缺省，TS类型明确有待callback赋值。
		let target: TelemetrySpan | undefined;
		// 创建并结束target，供后续link引用。
		await telemetry.startSpan({ name: "target" }, (span) => {
			// 保存真实句柄，结束并不抹掉可传播身份。
			target = span;
		});
		// 测试自己的准备断言：若callback没提供target直接失败，同时让TS收窄成TelemetrySpan。
		if (!target) throw new Error("Expected target");
		// 保存原carrier值，供后面结构比较。
		const original = telemetry.inject(target);
		// 再次inject取得另一份外部可改字典。
		const injected = telemetry.inject(target);
		// 确认本例的已知内存span确有carrier，不将缺值掩盖成空字典。
		if (!injected) throw new Error("Expected carrier");
		// 故意把返回字典的本地span字段改999；不调用adapter写入API。
		injected["pi-memory-span"] = "999";
		// 重新inject仍等于原值，证明之前的外部篡改没有写回身份表。
		expect(telemetry.inject(target)).toEqual(original);
		// 创建有初始link的新根，验证已结束target仍能被识别。
		await telemetry.startSpan(
			// link属性包含数组tags，后面会改它以测试隔离。
			{ name: "linked", links: [{ context: target, attributes: { tags: ["original"] } }] },
			// 空callback立即返回undefined，span仍正常结束。
			() => {},
		);
		// 数组解构按开始顺序取target快照和linked快照，不直接取得内部记录对象。
		const [first, linked] = telemetry.getSpans();
		// 测试先确认两记录/link都存在，失败就抛Error；后面才安全地故意修改它们。
		if (!first || !linked?.links[0]) throw new Error("Expected spans and link");
		// as只撤TS只读视图，改的是返回的target carrier，不是原始真实句柄。
		(first.context as TelemetryCarrier)["pi-memory-span"] = "123";
		// 同样改link指向的carrier快照，和上面target快照是两个复制位置。
		(linked.links[0].context as TelemetryCarrier)["pi-memory-span"] = "456";
		// 把返回link属性换成mutated数组，再检查内部仍original。
		(linked.links[0].attributes as SpanAttributes).tags = ["mutated"];
		// 新快照仍保存原目标carrier和标签；toEqual是结构相等断言，不要求同一引用。
		expect(telemetry.getSpans()[1]?.links).toEqual([{ context: original, attributes: { tags: ["original"] } }]);
	});

	// 本例把序列化的远端身份提取成目标，再创建新的background根并link它，验证传播身份可用于关联而无需变父。
	it("links a new root to an extracted remote target", async () => {
		// sender只负责产生外部carrier。
		const sender = new InMemoryTelemetryContext();
		// receiver拥有另一scope和自己的记录日志。
		const receiver = new InMemoryTelemetryContext();
		// carrier由下面trigger的callback填入。
		let carrier: TelemetryCarrier | undefined;
		// 先完成触发span，说明跨实例关联可引用已结束身份。
		await sender.startSpan({ name: "trigger" }, (span) => {
			// 注入carrier而非跨实例复制整个span对象。
			carrier = sender.inject(span);
		});
		// JSON往返模拟传输丢失对象身份，只保留字符串数据；as不校验字典，extract处理认可字段。
		const target = receiver.extract(JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier);
		// 直接调用receiver根入口，不调用target.startSpan，因此background是新trace。
		await receiver.startSpan(
			// 启动时link带reason，表示背景任务的来源关联。
			{ name: "background", links: [{ context: target, attributes: { reason: "restart" } }] },
			// callback接到新background句柄，不是远端target。
			(span) => {
				// 再加一条不带属性的link，测试两种入口都可识别提取父身份。
				span.addLink({ context: target });
			},
		);
		// receiver仅一个本地span，解构取它的规范快照。
		const [recorded] = receiver.getSpans();
		// 它没有parentContext，远端link不意味着把远端设为父。
		expect(recorded?.parentContext).toBeNull();
		// 两条link按追加顺序比较，不会在此去重成一条。
		expect(recorded?.links).toEqual([
			// options初始link保留reason属性。
			{ context: carrier, attributes: { reason: "restart" } },
			// callback追加link未传属性，快照规范为空表。
			{ context: carrier, attributes: {} },
		]);
	});

	// 回退例子：undefined、空字典和未知格式都返回根；空实现也保持空传播/空记录，方法调用不抛。
	it("uses the root for absent and unknown carriers", async () => {
		// 独立内存实例供身份相等断言。
		const telemetry = new InMemoryTelemetryContext();
		// readonly (TelemetryCarrier | undefined)[]表示只读数组，每项可为字典或缺省，不是只读所有后代对象。
		const carriers: readonly (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
		// for...of逐个传入缺/未知carrier。
		for (const carrier of carriers) {
			// toBe比较同一实例引用，提取不认识的carrier不会新建伪父。
			expect(telemetry.extract(carrier)).toBe(telemetry);
		}
		// 空传播器没有可注入身份，结果undefined。
		expect(NOOP_TELEMETRY_PROPAGATION.inject(NOOP_TELEMETRY_CONTEXT)).toBeUndefined();
		// 空传播提取未知carrier返回共享NOOP上下文，不是这个内存telemetry根。
		expect(NOOP_TELEMETRY_PROPAGATION.extract({ unknown: "format" })).toBe(NOOP_TELEMETRY_CONTEXT);
		// 空上下文仍立即进入callback并返回可await的Promise。
		await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "noop" }, (span) => {
			// addLink按空实现丢弃，不改变返回值或生成记录；这里检查可调用且无异常，不检查不存在的存储。
			span.addLink({ context: span });
		});
	});

	// 外部身份例子故意不用UUID/数字格式，验证识别边界是约定键的字符串，不是格式认证或远端身份真实性证明。
	it("treats recognized carrier identifiers as opaque strings", async () => {
		// 新实例的scope与下面external-recorder不同。
		const telemetry = new InMemoryTelemetryContext();
		// 普通对象由TS推导字符串属性形状，运行时未由as变造。
		const carrier = {
			// 外部scope是任意非本实例字符串。
			"pi-memory-scope": "external-recorder",
			// 外部span甚至不是数字，仍作为不透明身份保留。
			"pi-memory-span": "external-span",
			// trace字符串也不要求scope:数字的本地编码。
			"pi-memory-trace": "external-trace",
		};
		// 提取外部父后启动receiver孩子，空callback正常完成；没有按carrier内容发网络请求。
		await telemetry.extract(carrier).startSpan({ name: "receiver" }, () => {});
		// parentContext完整保留原字典值，说明不强行改写成内部UUID格式。
		expect(telemetry.getSpans()[0]?.parentContext).toEqual(carrier);
	});
});
