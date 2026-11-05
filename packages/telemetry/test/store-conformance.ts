// 为TelemetryStore夹具登记六组读存储契约：已结束记录、过滤、分页、传播/link、外部身份与指标统计；测试安排可复用，具体后端资源由factory拥有。
// Vitest登记分组/用例、断言及替换时钟；调用方store.test.ts用afterEach恢复spy，本helper不自行注册恢复钩子。
import { describe, expect, it, vi } from "vitest";
// 整段import type仅给TS，运行时擦除，避免把接口名当真实构造器。
import type {
	// 传播carrier的字符串字典类型。
	TelemetryCarrier,
	// 启动span的公共上下文接口。
	TelemetryContext,
	// counter等指标能力接口。
	TelemetryMetrics,
	// inject/extract传播接口。
	TelemetryPropagation,
	// 异步查询追踪/指标的store接口，不假定具体数据库类型。
	TelemetryStore,
} from "../src/index.ts";

// 夹具把写入、查询、flush与清理组合起来；extends AsyncDisposable要求符号清理方法，接口声明本身不执行释放。
export interface StoreFixture extends AsyncDisposable {
	// 交叉类型&表示context必须同时有基础接口和下面明确必需的能力，非“两个对象相加”。
	readonly context: TelemetryContext & {
		// 此套存储用例要求指标能力存在，不像另一个公共adapter套件允许缺省。
		readonly metrics: TelemetryMetrics;
		// 传播能力同样必需，后面跨实例测试不会因缺能力而自动跳过。
		readonly propagation: TelemetryPropagation;
	};
	// 只读store字段避免通过此视图重赋，store内部仍可记录/查询，不会因此冻结。
	readonly store: TelemetryStore;
	// flush由各adapter夹具提供，表示等测试数据可查询；内存实现可空返回，其他后端如何落盘并非此接口保证。
	flush(): Promise<void>;
}

/** Shared read-store checks; no raw-measurement or backend-specific persistence assumptions. */
// 登记共享读存储检查：name是报告分组，factory每例提供新夹具；返回void，实际测试稍后由Vitest执行。例store.test.ts接同一内存实例作context/store。会替换Date.now，调用者负责恢复mock；不接管真实后端导出策略。
export function telemetryStoreConformance(name: string, factory: () => Promise<StoreFixture>): void {
	// describe立即登记嵌套it，不在调用登记器时完成异步业务。
	describe(name, () => {
		// 第一例先把root卡在gate，确认无已结束记录；再放行建child，核对完整字段并改快照。它不证明“同trace任一span未结束就必须隐藏整trace”。
		it("returns only settled traces, complete span snapshots, and detached results", async () => {
			// epoch时钟固定20000；数值分隔符_不改变值，performance耗时钟仍按adapter正常运行。
			vi.spyOn(Date, "now").mockReturnValue(20_000);
			// 先await取得夹具，再由await using登记退出时等待Symbol.asyncDispose；正常/抛错退出都走资源清理，不等于自动放行gate。
			await using f = await factory();
			// withResolvers返回{promise,resolve,reject}手动闸门；<void>表示完成不携带业务值。
			const gate = Promise.withResolvers<void>();
			// 保存尚未完成的startSpan Promise，不立即await；callback先记事件再挂在gate，让下一次查询发生在打开期间。
			const active = f.context.startSpan({ name: "root", attributes: { tags: ["original"] } }, async (root) => {
				// 事件属性也用数组，后面故意修改结果以验证复制。
				root.addEvent("event", { tags: ["original"] });
				// 此处挂起root；测试主线仍可继续flush/查询，而不是整个JS线程阻塞。
				await gate.promise;
				// gate放行后才创建child并等待完成，保证第一次查询时child还不存在。
				await root.startSpan({ name: "child" }, () => {});
			});
			// 要求夹具刷新目前可发布的数据，不应把仍打开的root强制标记结束。
			await f.flush();
			// 此刻没有任何settled span，trace列表应为空，不是要求所有部分trace都隐藏。
			expect((await f.store.findTraces()).traces).toEqual([]);
			// 不存在的id返回undefined，不生成空trace对象。
			expect(await f.store.getTrace("missing")).toBeUndefined();
			// 显式完成闸门Promise，让root callback继续。
			gate.resolve();
			// 等root及被其await的child结束；如果异步链拒绝，用例失败而非继续假定成功。
			await active;
			// 再次flush，使已结束数据在store端可见。
			await f.flush();
			// 取首条trace；!只断言存在，不增加运行时校验，准备失败时后续访问/断言会使测试失败。
			const trace = (await f.store.findTraces()).traces[0]!;
			// find按名字找root，!基于刚创建的数据；不依赖父子在快照数组里的固定索引。
			const root = trace.spans.find((span) => span.name === "root")!;
			// 同样找到child，避免把“先结束”误当“第0项”。
			const child = trace.spans.find((span) => span.name === "child")!;
			// 这条测试要求36位小写十六进制/连字符前缀+正整数尾缀；正则不是严格UUID分组校验，也不是所有外部carrier必须如此。
			expect(root.id).toMatch(/^[0-9a-f-]{36}:[1-9][0-9]*$/);
			// 本地新根traceId等于自身全局span id。
			expect(root.traceId).toBe(root.id);
			// 根的StoredSpan省略parentId，而规范getSpans根parentId用null，两个接口分清。
			expect(root.parentId).toBeUndefined();
			// child父id等于root完整id，不是本地数字序号。
			expect(child.parentId).toBe(root.id);
			// 孩子继承root的traceId，父子归同一追踪。
			expect(child.traceId).toBe(root.traceId);
			// 绝对开始时间来自mock的Date.now。
			expect(root.startedMs).toBe(20_000);
			// 结束epoch不早于开始；这里只检查非负耗时，不精确要求运行时间为零。
			expect(root.endedMs).toBeGreaterThanOrEqual(root.startedMs);
			// 相对事件时间同样非负，?.缺事件会让比较断言失败，不会静默通过。
			expect(root.events[0]?.timeMs).toBeGreaterThanOrEqual(0);
			// 故意篡改返回的根属性数组，检查store是否暴露内部引用。
			root.attributes.tags = ["changed"];
			// 再篡改事件的属性，覆盖另一层引用。
			root.events[0]!.attributes.tags = ["changed"];
			// 重新按同traceId查询独立快照。
			const fresh = await f.store.getTrace(trace.traceId);
			// 按id定位原root，属性仍original；toEqual比较结构，不要求引用相同。
			expect(fresh?.spans.find((span) => span.id === root.id)?.attributes.tags).toEqual(["original"]);
			// 事件属性也仍original，证明此次读取结果修改没泄露回记录状态。
			expect(fresh?.spans.find((span) => span.id === root.id)?.events[0]?.attributes.tags).toEqual(["original"]);
		});

		// 过滤例子构造old/wanted/new三条追踪：old把left/right拆在两个孩子，wanted放同一错误孩子，new用数字1；逐项区分首span条件与同span属性/类型。
		it("filters by first-span name and start, any error, and all attributes on one span", async () => {
			// Date.now起点10000，spy句柄now随后移动不同span的开始时间。
			const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
			// 独立夹具拥有本例三条追踪，避免上例数据进入筛选。
			await using f = await factory();
			// old根在10000开始，即便孩子后来到30000，也仍按根的开始时间筛选。
			await f.context.startSpan({ name: "old" }, async (root) => {
				// 让后续孩子开始时间变30000，不改已经保存的old起点。
				now.mockReturnValue(30_000);
				// 第一个孩子只有left=1，不能和另一个孩子拼成一组完整属性匹配。
				await root.startSpan({ name: "recent-child", attributes: { left: 1 } }, () => {});
				// 第二个孩子只有right=2，专门测试属性不允许跨span凑齐。
				await root.startSpan({ name: "split", attributes: { right: 2 } }, () => {});
			});
			// 第二个根wanted在20000开始，与old的较新孩子区分。
			now.mockReturnValue(20_000);
			// 创建wanted根并在其下建failure孩子。
			await f.context.startSpan({ name: "wanted" }, async (root) => {
				// 孩子比根晚1ms，便于验证startMin/startMax只看首个已存span。
				now.mockReturnValue(20_001);
				// 多行startSpan调用下面的完整属性对象与callback，等待孩子结束。
				await root.startSpan(
					// 同一个failure孩子同时有left/right、boolean valid与带引号/点的键；这些键按字典键比较，不解析为路径。
					{ name: "failure", attributes: { left: 1, right: 2, valid: true, 'odd."key': "value" } },
					// 显式标error不抛错，返回Promise仍正常完成，但errors:true应找到它所属追踪。
					(child) => child.setStatus({ status: "error" }),
				);
			});
			// 第三条根在40000开始，是按新到旧排序的首位。
			now.mockReturnValue(40_000);
			// new的valid是数字1，与wanted的布尔true不同，不能按JS宽松相等混为一值。
			await f.context.startSpan({ name: "new", attributes: { valid: 1 } }, () => {});
			// 等待所有刚写的数据可查询，具体flush实现交夹具。
			await f.flush();
			// 本例局部async辅助提取首span名字；Parameters<方法类型>[0]从现有findTraces签名复用首参数类型，不复制另一套查询类型。
			const names = async (query: Parameters<TelemetryStore["findTraces"]>[0]) =>
				// 先await查询，再map各trace首span名字；?.可能产出undefined，后续期望数组会检查是否缺数据。
				(await f.store.findTraces(query)).traces.map((trace) => trace.spans[0]?.name);
			// 以下组合断言同时考查名字、属性、错误、含边界时间，条件必须共同满足。
			expect(
				// 调用局部names，返回Promise所以这里await。
				await names({
					// name是追踪首个已存span名字，应匹配wanted根。
					name: "wanted",
					// left/right必须被同一个span同时满足，wanted孩子具备这两项。
					attributes: { left: 1, right: 2 },
					// errors:true要求追踪里任意span为error，不要求首span本身失败。
					errors: true,
					// 开始时间下界为20000，包含等于。
					startMin: 20_000,
					// 上界也为20000，只选起点正好20000的追踪。
					startMax: 20_000,
				}),
				// 组合条件应只返回wanted，不因它的孩子开始于20001而排除。
			).toEqual(["wanted"]);
			// failure只是孩子名字，不能用追踪首span名字筛选命中它。
			expect(await names({ name: "failure" })).toEqual([]);
			// old两个孩子各有一半属性不能凑齐，因此只有wanted。
			expect(await names({ attributes: { left: 1, right: 2 } })).toEqual(["wanted"]);
			// 带点/引号键按完整键名匹配，布尔true也保持类型。
			expect(await names({ attributes: { valid: true, 'odd."key': "value" } })).toEqual(["wanted"]);
			// 数字1只匹配new，不匹配wanted的true。
			expect(await names({ attributes: { valid: 1 } })).toEqual(["new"]);
			// 任意错误孩子可使wanted满足errors:true。
			expect(await names({ errors: true })).toEqual(["wanted"]);
			// 含下界筛选后按开始时间倒序，new先wanted后。
			expect(await names({ startMin: 20_000 })).toEqual(["new", "wanted"]);
			// 含上界10000只保留old，不能用较新孩子时间替换根起点。
			expect(await names({ startMax: 10_000 })).toEqual(["old"]);
		});

		// 分页例子创建25条同起点追踪，每条含根/孩子；检查默认20、续页5、小页循环和完整追踪不拆分。只验证静态数据，不宣称并发写入时跨页一致。
		it("pages complete traces without duplicates when trace starts tie", async () => {
			// 所有根开始时钟固定20000，专门考查时间相同时的稳定游标次序。
			const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
			// 创建新夹具，此例查询不会混入其他数据。
			await using f = await factory();
			// for用let递增0..24，创建25个独立根，而非25个孩子。
			for (let index = 0; index < 25; index++) {
				// 每次建根前把时钟调回20000，保证起点相同。
				now.mockReturnValue(20_000);
				// 属性简写index记录当前循环值；await保证每条根结束后再开始下一条。
				await f.context.startSpan({ name: "root", attributes: { index } }, async (root) => {
					// 孩子起点设20001，不改变根时间。
					now.mockReturnValue(20_001);
					// 每根创建一个孩子，稍后每trace应含2span。
					await root.startSpan({ name: "child" }, () => {});
				});
			}
			// 写入全部结束后flush，后面分页期间不再新增记录。
			await f.flush();
			// 缺参数使用默认limit20，取第一页。
			const first = await f.store.findTraces();
			// 25条数据下默认页正好20条trace。
			expect(first.traces).toHaveLength(20);
			// 尚有余项，应带续页cursor；这里只断言存在，不解析其内部格式。
			expect(first.cursor).toBeDefined();
			// 将原cursor原样交回store，不自行算数字offset或编辑token。
			const rest = await f.store.findTraces({ cursor: first.cursor });
			// 第二页剩5条，没有重复第一页。
			expect(rest.traces).toHaveLength(5);
			// 已到末页，不应再给cursor造成死循环。
			expect(rest.cursor).toBeUndefined();
			// 用大limit一次取全部，作为分页拼接的对照顺序。
			const all = (await f.store.findTraces({ limit: 100 })).traces;
			// 展开两页拼成新数组，结构应与一次查询全部一致。
			expect([...first.traces, ...rest.traces]).toEqual(all);
			// every检查每条追踪仍有根与孩子，分页单位是trace而不是span行。
			expect(all.every((trace) => trace.spans.length === 2)).toBe(true);
			// string[]空数组收集后续小页的traceId。
			const ids: string[] = [];
			// cursor初始undefined表示首轮，随后赋store返回值。
			let cursor: string | undefined;
			// do...while先执行再判断，确保无初始cursor仍查询第一页。
			do {
				// 按名字root过滤、每页3条，属性简写cursor使用当前续页值。
				const page = await f.store.findTraces({ name: "root", limit: 3, cursor });
				// map抽取id，...展开到push参数，按页序追加。
				ids.push(...page.traces.map((trace) => trace.traceId));
				// 把服务器/adapter返回的下一页cursor存为本轮状态。
				cursor = page.cursor;
				// 无cursor退出；合法有限结果正常终止，不是测试任意坏后端都能终止。
			} while (cursor);
			// 小页收集的id次序与大页一致，覆盖同起点多次续页无重复/遗漏。
			expect(ids).toEqual(all.map((trace) => trace.traceId));
		});

		// 跨实例例子：sender导出身份，receiver继续原trace并另建带link新根；再破坏carrier键验证回退。helper直接传carrier，不自行发网络请求；夹具后端由factory决定。
		it("inherits remote trace IDs and preserves remote parents and cross-trace links", async () => {
			// 固定epoch，便于查询结果比较，不要求span耗时固定。
			vi.spyOn(Date, "now").mockReturnValue(20_000);
			// 第一个await using登记sender清理。
			await using sender = await factory();
			// 再登记receiver，作用域退出时按后创建先清理的资源顺序处理。
			await using receiver = await factory();
			// 声明处!告诉TS由callback赋值，不产生默认carrier也不检验真实性。
			let carrier!: TelemetryCarrier;
			// sender先创建一个新根，用于生产该adapter认可的carrier格式。
			await sender.context.startSpan({ name: "sender" }, (span) => {
				// 注入实际span身份；!只断言本夹具应提供它。
				carrier = sender.context.propagation.inject(span)!;
			});
			// 先等sender数据可查，才能取得对应StoredSpan完整id。
			await sender.flush();
			// 按约定取唯一sent追踪，不把carrier字符串猜成另一种存储格式。
			const sent = (await sender.store.findTraces()).traces[0]!;
			// JSON往返模拟跨边界复制；as仅静态断言，receiver.extract执行其约定的wire字段识别。
			const remote = receiver.context.propagation.extract(JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier);
			// 调用提取父的startSpan，沿sender trace建接收方孩子。
			await remote.startSpan({ name: "receiver" }, () => {});
			// 另一次直接调用receiver根入口，创建独立linked追踪。
			await receiver.context.startSpan(
				// link关联remote父并附背景原因，关联不改变新根的parent/trace。
				{ name: "linked", links: [{ context: remote, attributes: { reason: "background" } }] },
				// 空业务callback返回undefined，仍正常记录并结束。
				() => {},
			);
			// receiver写入完成后flush，使两条记录可查询。
			await receiver.flush();
			// 用sender的traceId查询接收方store，不查询sender store或复制sender的span行。
			const continued = await receiver.store.getTrace(sent.traceId);
			// 接收方沿该trace只记录receiver一条；跨实例trace可各存自己的局部片段。
			expect(continued?.spans).toHaveLength(1);
			// toMatchObject只比较下面列出的关键字段，不要求无其他快照字段。
			expect(continued?.spans[0]).toMatchObject({
				// 继续sender的traceId。
				traceId: sent.traceId,
				// 父id保留sender的完整全局span身份。
				parentId: sent.spans[0]!.id,
				// 本地新span名字为receiver。
				name: "receiver",
			});
			// 本地孩子必须有新id，不能把远端父快照当本地记录。
			expect(continued?.spans[0]?.id).not.toBe(sent.spans[0]!.id);
			// 按linked根名字取得另一条追踪。
			const linked = (await receiver.store.findTraces({ name: "linked" })).traces[0]!;
			// 独立根的traceId应不同于sender，link不等同传播父。
			expect(linked.traceId).not.toBe(sent.traceId);
			// 检查link引用的远端trace/span与附加属性。
			expect(linked.spans[0]?.links).toEqual([
				// 目标是sender原span，附reason:background。
				{ traceId: sent.traceId, spanId: sent.spans[0]!.id, attributes: { reason: "background" } },
			]);
			// 逐个破坏实际carrier的所有自有可枚举字符串键，不硬编码某adapter字段名。
			for (const key of Object.keys(carrier)) {
				// 浅复制字典，避免本次删除影响下一轮或原carrier。
				const incomplete = { ...carrier };
				// delete删当前键，构造缺失身份输入。
				delete incomplete[key];
				// 不完整carrier应提取回根，新建fallback追踪；空callback仍完成。
				await receiver.context.propagation.extract(incomplete).startSpan({ name: "fallback" }, () => {});
				// 计算属性[key]覆盖为数字42；双重as经unknown故意越过TS约束，专门测试wire边界，不建议正常业务这样写。
				const nonString = { ...carrier, [key]: 42 } as unknown as TelemetryCarrier;
				// 非字符串关键身份也应回根，不沿损坏远端身份建孩子。
				await receiver.context.propagation.extract(nonString).startSpan({ name: "fallback" }, () => {});
			}
			// 等所有fallback可查。
			await receiver.flush();
			// 按首span名字fallback过滤，排除先前receiver与linked。
			const fallbacks = (await receiver.store.findTraces({ name: "fallback" })).traces;
			// 每个键对应删除/非字符串两条，数量应为键数乘2。
			expect(fallbacks).toHaveLength(Object.keys(carrier).length * 2);
			// 下面every逐条验证回退后的根身份，不只检查总条数。
			expect(
				// 根无parentId且traceId等于自己id；属性可选链只防空读，错误数据仍让every为false。
				fallbacks.every((trace) => trace.spans[0]?.parentId === undefined && trace.traceId === trace.spans[0]?.id),
				// 所有回退记录都应满足根条件。
			).toBe(true);
		});

		// 外部格式例子用同样键而全换成external-字符串，检查不强制使用本地UUID格式；不是认证/授权测试。
		it("accepts external string identities without imposing an ID format", async () => {
			// 独立夹具获得该adapter实际认可的键集合。
			await using f = await factory();
			// carrier通过下一次callback赋值，!只是明确赋值断言。
			let carrier!: TelemetryCarrier;
			// 先建source以取得合法字段名，随后改变值而保留这些名。
			await f.context.startSpan({ name: "source" }, (span) => {
				// 导出真实身份字典，供Object.keys读取键。
				carrier = f.context.propagation.inject(span)!;
			});
			// map把每个键映成[key,任意外部字符串]，Object.fromEntries重新建字典；所有值仍是string。
			const external = Object.fromEntries(Object.keys(carrier).map((key) => [key, `external-${key}`]));
			// 提取外部父，不能因为值不像本地id就重写成新根。
			const parent = f.context.propagation.extract(external);
			// 再次注入应与外部字典结构一致，说明该父身份被保留。
			expect(f.context.propagation.inject(parent)).toEqual(external);
			// 沿外部父建continued孩子，业务不做任何额外工作。
			await parent.startSpan({ name: "continued" }, () => {});
			// 等待该孩子可查。
			await f.flush();
			// 按continued首span名字取其本地trace片段。
			const trace = (await f.store.findTraces({ name: "continued" })).traces[0]!;
			// traceId应沿外部字符串，正则只检查external-前缀。
			expect(trace.traceId).toMatch(/^external-/);
			// Stored父id也保留外部来源，不强行要求数字尾缀。
			expect(trace.spans[0]?.parentId).toMatch(/^external-/);
		});

		// 指标例子安排两个时间桶与不同名字/属性类型，查询第一桶read=true，按count/sum/min/max合并结果验证。允许后端先聚合，故不强制原始行数。
		it("queries metric names, inclusive interval bounds, typed attribute equality, and detached values", async () => {
			// 起点20001，落入20000开始的桶；now句柄控制后续记录时间。
			const now = vi.spyOn(Date, "now").mockReturnValue(20_001);
			// 独立夹具确保计数从空开始。
			await using f = await factory();
			// 创建hits计数器并声明单位By；工厂不立即记录value。
			const counter = f.context.metrics.counter("hits", { unit: "By" });
			// 首条read/true增量2。
			counter.add(2, { method: "read", valid: true });
			// 属性键顺序对匹配无影响，同一属性组合再加3。
			counter.add(3, { valid: true, method: "read" });
			// 不同method与数字valid的11用来验证类型和属性过滤。
			counter.add(11, { method: "write", valid: 1 });
			// 其他指标名的100不可混入hits查询。
			f.context.metrics.counter("other").add(100, { method: "read", valid: true });
			// 移动到第二个10秒桶内。
			now.mockReturnValue(30_001);
			// 同属性再记7，但时间筛选第一桶时应排除。
			counter.add(7, { method: "read", valid: true });
			// 把当前时钟移到40001，查询应仍看测量时刻的桶，不把记录改到查询时间。
			now.mockReturnValue(40_001);
			// flush使指标对查询可见；等待不是“再记录一次”。
			await f.flush();
			// 构造精确查询对象，const只禁变量重赋，不深冻结里面属性。
			const query = {
				// 要求指标名hits。
				name: "hits",
				// 桶开始时间含下界20000。
				startMin: 20_000,
				// 含上界也20000，选同一桶。
				startMax: 20_000,
				// 两个属性须同时且保持类型匹配，不按键插入顺序匹配。
				attributes: { method: "read", valid: true },
			};
			// 异步取统计行，可是多条count-one，也可是后端已合并行。
			const rows = await f.store.findMetrics(query);
			// reduce从0累加count，共两次符合条件的记录，不要求rows.length为2。
			expect(rows.reduce((count, row) => count + row.count, 0)).toBe(2);
			// 同样累计sum，2+3=5。
			expect(rows.reduce((sum, row) => sum + row.sum, 0)).toBe(5);
			// 每行min再取总最小，结果2。
			expect(Math.min(...rows.map((row) => row.min))).toBe(2);
			// 每行max再取总最大，结果3。
			expect(Math.max(...rows.map((row) => row.max))).toBe(3);
			// every同时检查指标种类、单位和桶起点，不只看总sum。
			expect(rows.every((row) => row.kind === "counter" && row.unit === "By" && row.intervalMs === 20_000)).toBe(
				// 所有返回行都应满足元数据约束。
				true,
			);
			// 故意改第一条返回属性，检查结果是否与后端记录隔离；!不做运行时非空检查。
			rows[0]!.attributes.method = "changed";
			// 再次相同查询仍read，不受外部修改影响。
			expect((await f.store.findMetrics(query))[0]?.attributes.method).toBe("read");
			// 未知指标名应返回空列表。
			expect(await f.store.findMetrics({ name: "missing" })).toEqual([]);
			// 下面单独检查数字属性valid=1的筛选，与布尔true区分。
			expect(
				// 先取数字1的hits行，再把它们reduce成总sum。
				(await f.store.findMetrics({ name: "hits", attributes: { valid: 1 } })).reduce(
					// 累加各行sum，不取count当增量值。
					(sum, row) => sum + row.sum,
					// 初始累加值0，空结果会为0而使下面11断言失败。
					0,
				),
				// 应只命中write那条11，不能把true的2/3/7算进去。
			).toBe(11);
			// 最后检查时间含下界的新桶查询。
			expect(
				// startMin30000选择后来那条7；查询名仍hits，另名和旧桶排除。
				(await f.store.findMetrics({ name: "hits", startMin: 30_000 })).reduce((sum, row) => sum + row.sum, 0),
				// 总和为7，说明区分了记录时间桶。
			).toBe(7);
		});
	});
}
