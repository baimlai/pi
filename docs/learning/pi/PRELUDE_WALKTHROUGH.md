# QuickJS 前导脚本逐句阅读

对应 [prelude-source.ts](../../../packages/codemode/src/runtime/prelude-source.ts)。`vm.ts` 先求值 `PRELUDE_SOURCE`，拿到安装函数，再把私有桥、工具目录、全局函数目录与 store 快照传进去。用户代码执行时，工具调用表现为 Promise；真正的工具运行在宿主，结果再经 `settle()` 回到 VM。

例子：`const r = await tools.read({path:"a.txt"}); text(r); store("last","a.txt");` 会先发 call 请求，等待宿主结果，然后发 output；脚本正常完成才连同写入差量报告 done。`text()` 输出与 `return` 的最终值是两条不同路径。

这是源码模板的逐句对照摘录，供阅读，文档不会被加载执行。下面保留 `${...}`、双反斜杠和转义反引号的原样，它们属于外层 TypeScript 模板写法；中文只存在文档里。不要把这个摘录覆盖回模板正文：哪怕加一条 JS 注释也会改变运行字符串、堆栈行号和确定性执行的前导脚本指纹。指纹是兼容检查用的 32 位哈希，不能当安全认证或无碰撞证明。

| 常量 | 默认值 | 计数对象 |
| --- | ---: | --- |
| MAX_STORE_VALUE_CHARS | 262144 | 单条 JSON 文字的 UTF-16 代码单元数，不含键 |
| MAX_STORE_TOTAL_CHARS | 1048576 | 全部键与 JSON 文字，非删除写入时检查 |
| MAX_OUTPUT_CHARS | 16777216 | 文本、console 文本与 base64 图片正文累计 |
| MAX_OUTPUT_ITEMS | 100000 | text/image/console 的输出项累计，空串也算 |

初始 store 只累计大小，不倒查已有内容是否超限。图片检查覆盖 URI 外形、base64 外形和文件签名前缀，不是完整图片解码。`exit()` 可以被 JavaScript 的 catch 捕获，但调用时终态已上报，catch 不会撤销成功；输出超限同样先锁失败，再抛异常。VM 停止和宿主调用取消还要继续读 `vm.ts`、`execution.ts` 与各后端。

此文件内部是 JavaScript。TypeScript 在外层用 `: string` 标注 `PRELUDE_SOURCE`，不会替内部 JSON、脚本参数和错误字段做类型校验。闭包、Promise、Proxy、Map、Set、解构、展开和可选实参是两种语言共用的运行语法；`readonly`、`interface`、`infer` 等纯类型语法在这个运行脚本里没有出现。

摘录基线：`be37fb285158aba7ce545dace5ce94e1640ae4ee`。按函数名与相邻语句定位；合并 main 后要重新核对原始摘录和中文，不能只因源码 SHA 一致就推断文档解释仍正确。

## 安装入口与内建对象保护

```text
// 外层函数拿到私有bridge与三份JSON文本，返回settle/run/stalled；例工具目录先安装，run才执行用户脚本。它本身在VM里求值，不执行宿主工具实现。
export const PRELUDE_SOURCE: string = `(function (bridge, toolsJson, globalsJson, storeJson) {
	// 严格模式约束未声明赋值、只读属性写入等行为；这仍是JavaScript，不含TS类型检查。
	"use strict";

	// Freeze every object reachable from the built-in globals, plus the intrinsics that are only
	// reachable from instances (iterator and generator prototypes, %TypedArray%).
	//
	// Freezing alone breaks ordinary code through the "override mistake": a data property that is
	// read-only on a prototype cannot be assigned on an instance either, so
	// this.name = "MyError" in an Error subclass would throw. Commonly overridden properties
	// become accessors whose setter defines an own property on the instance instead.
	// lockdown立即执行：沿内建对象图冻结属性，防脚本改JSON/Promise等共用实现影响桥通信；不负责跨realm隔离，VM本身是独立WASM实例。
	(function lockdown() {
		// Set列出允许实例遮蔽的常用属性名，例Error子类可给自己的name赋值。
		const OVERRIDABLE = new Set(["constructor", "name", "message", "toString", "toLocaleString", "valueOf", "toJSON"]);
		// 先把globalThis标已见，遍历其成员但不把全局对象本身加入冻结队列；后面还需安装tools等新属性。
		const seen = new Set([globalThis]);
		// 数组作后进先出的待处理栈，保存尚未冻结的对象/函数。
		const queue = [];
		// add是内部入栈闭包：只收对象/函数，同一引用只排一次，防循环原型/constructor关系无限遍历。
		const add = (value) => {
			// typeof null为object，所以显式排null；基础值无需冻结，也不入栈。
			if ((typeof value === "object" && value !== null) || typeof value === "function") {
				// 按对象身份去重，非内容比较。
				if (!seen.has(value)) {
					// 入栈前标已见，后续再次遇到不重复排队。
					seen.add(value);
					// push追加；稍后pop使遍历更接近深度优先，而非FIFO队列。
					queue.push(value);
				}
			}
		};

		// Accessors from an object literal have no own prototype object, unlike function expressions,
		// whose prototype.constructor would be converted again without end.
		// allowOverride把可改写数据属性换成访问器：原型本身仍不能改，实例赋值则建自有属性。输入为对象、键、旧值与枚举标志，无IO；例new Error().name="AppError"。
		function allowOverride(object, key, value, enumerable) {
			// 从一个临时对象的accessor属性描述符解构get/set，避免普通function的prototype.constructor再引出无限转换。
			const { get, set } = Object.getOwnPropertyDescriptor(
				// 对象字面量在这里仅用于创建成对getter/setter函数。
				{
					// 读取accessor时调用getter，闭包记住原先数据属性值。
					get accessor() {
						// 返回旧值；不会动态读取object[key]而递归触发自身。
						return value;
					},
					// setter通过this识别真正写入的接收者，next是新值。
					set accessor(next) {
						// 直接改内建原型/对象自己的同名属性仍禁止。
						if (this === object) {
							// 抛TypeError终止写入；String(key)兼容symbol等属性键。
							throw new TypeError("Cannot assign to read only property '" + String(key) + "' of a built-in");
						}
						// 接收者不是对象/函数就直接返回，不试图在原始值上定义属性。
						if ((typeof this !== "object" || this === null) && typeof this !== "function") return;
						// 在实例上定义可写、可枚举、可配置的自有数据属性，遮住原型访问器。
						Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
					},
				},
				// 读取临时对象上名为accessor的描述符，不执行getter。
				"accessor",
			);
			// 用同一键替换原属性，保留原枚举性，并禁止之后重配该访问器。
			Object.defineProperty(object, key, { get, set, enumerable, configurable: false });
			// getter本身也是对象，需要纳入冻结遍历。
			add(get);
			// setter同样纳入，避免从访问器函数继续改内建对象图。
			add(set);
		}

		// Reflect.ownKeys同时枚举字符串键和symbol键，比Object.keys覆盖更多内建成员。
		for (const key of Reflect.ownKeys(globalThis)) {
			// 取描述符而非直接访问globalThis[key]，避免运行潜在getter。
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
			// 数据属性的值若是对象/函数就加入图。
			add(descriptor.value);
			// 访问器的getter函数也加入图；缺失时add(undefined)忽略。
			add(descriptor.get);
			// setter函数同理。
			add(descriptor.set);
			// 只处理可配置的数据属性，不把访问器误当writable数据属性。
			if ("value" in descriptor && descriptor.configurable) {
				// 锁定已有可配置数据全局的重赋/重配；并未冻结globalThis本身或禁止后来新增全局。
				Object.defineProperty(globalThis, key, { writable: false, configurable: false });
			}
		}
		// 补上生成器函数的内在原型，部分对象不直接挂在全局构造器上。
		add(Object.getPrototypeOf(function* () {}));
		// 补上异步函数的内在原型。
		add(Object.getPrototypeOf(async function () {}));
		// 补上异步生成器函数原型。
		add(Object.getPrototypeOf(async function* () {}));
		// Int8Array构造器的原型是共享TypedArray构造器，也要覆盖。
		add(Object.getPrototypeOf(Int8Array));
		// 通过真实数组迭代器实例找到其原型。
		add(Object.getPrototypeOf([][Symbol.iterator]()));
		// 通过Map迭代器实例找到其原型。
		add(Object.getPrototypeOf(new Map()[Symbol.iterator]()));
		// 通过Set迭代器实例找到其原型。
		add(Object.getPrototypeOf(new Set()[Symbol.iterator]()));
		// 通过字符串迭代器找到其原型。
		add(Object.getPrototypeOf(""[Symbol.iterator]()));
		// 通过matchAll结果找到正则字符串迭代器原型。
		add(Object.getPrototypeOf(/a/[Symbol.matchAll]("")));
		// 仅在当前QuickJS提供Iterator构造器时处理迭代器辅助API。
		if (typeof Iterator === "function") {
			// 若支持map，建一个辅助迭代器以取得其原型；箭头x=>x只原样返回元素。
			if (typeof Iterator.prototype.map === "function") add(Object.getPrototypeOf([].values().map((x) => x)));
			// 若支持from，构造包装迭代器取其原型；这里不调用next消费数据。
			if (typeof Iterator.from === "function") add(Object.getPrototypeOf(Iterator.from({ next() {} })));
		}

		// 有待处理对象就继续，seen保证已知有限对象图不重复入队。
		while (queue.length > 0) {
			// 取栈尾对象并移除，不是删除对象本身。
			const object = queue.pop();
			// 原型链也属于要保护的可达对象图。
			add(Object.getPrototypeOf(object));
			// 一次取得所有自有属性描述符，避免挨个读取访问器值。
			const descriptors = Object.getOwnPropertyDescriptors(object);
			// 描述符字典也要同时处理字符串/symbol属性键。
			for (const key of Reflect.ownKeys(descriptors)) {
				// 当前键对应原对象上的属性描述符。
				const descriptor = descriptors[key];
				// 含value即数据属性；否则按访问器分支处理。
				if ("value" in descriptor) {
					// 数据属性指向的对象/函数继续遍历。
					add(descriptor.value);
					// 下面三个条件共同决定是否把数据属性改成允许实例遮蔽的访问器。
					if (
						// 原本可写才需要保留常规的实例赋值体验。
						descriptor.writable &&
						// 原本可配置才允许重新定义为访问器。
						descriptor.configurable &&
						// Object.prototype上的可写可配属性都处理，其他对象只处理白名单属性。
						(object === Object.prototype || OVERRIDABLE.has(key))
					) {
						// 调用前面的访问器转换，保持直接改内建值仍会报错。
						allowOverride(object, key, descriptor.value, descriptor.enumerable);
					}
				// 非数据属性走访问器分支，不调用getter/setter本身。
				} else {
					// 原属性已有getter时，只把函数纳入图，不调用它。
					add(descriptor.get);
					// 原属性已有setter时同理。
					add(descriptor.set);
				}
			}
			// 冻结当前对象自身的属性；它是浅冻结，递归效果来自显式遍历整个可达图。
			Object.freeze(object);
		}
	// 结束函数定义后立即调用lockdown，早于保存JSON/Promise引用与安装工具。
	})();
```

## 桥状态与错误描述

```text
	// 保存内建JSON.stringify引用，后续统一使用它编码桥载荷。
	const stringify = JSON.stringify;
	// 保存JSON.parse引用，工具结果/目录/初始store都在VM端解码。
	const parse = JSON.parse;
	// 保存Promise.prototype.then，run用它直接订阅返回的原生Promise。
	const promiseThen = Promise.prototype.then;
	// 保存Error构造器供instanceof和工具失败包装使用。
	const ErrorCtor = Error;
	// 保存TypeError构造器，用于输入形状/编码失败。
	const TypeErrorCtor = TypeError;
	// 保存RangeError构造器，用于输出配额错误。
	const RangeErrorCtor = RangeError;
	// pending按自增调用id存resolve/reject，使并发工具结果能回答各自Promise。
	const pending = new Map();
	// 调用id从1起；后缀++先取旧值再加一，不是随机ID。
	let nextId = 1;
	// finished标记是否已向宿主报告终态；后续done/output可据此忽略重复。
	let finished = false;
	// Thrown by exit() to unwind the script after it already reported success.
	// EXIT是私有冻结哨兵，exit成功报告后抛出以展开调用栈；不是Error，也不是保证用户无法catch的强制退出。
	const EXIT = Object.freeze({});

	// done是终态闸门：首次记录完成并通知宿主，后续调用忽略。例成功后再遇到拒绝，不重复发第二个终态；不在这里取消所有宿主操作。
	function done(ok, payload, writes) {
		// 完成后立即返回，不再发桥消息。
		if (finished) return;
		// 先置finished再调用bridge，防桥触发的同步重入重复结束。
		finished = true;
		// done桥载荷依次是成功标志、返回值/错误JSON、写入差量；失败通常不带writes。
		bridge("done", ok, payload, writes);
	}

	// serialize统一返回值/参数编码：undefined单独透传，其余JSON.stringify；循环引用/BigInt等可抛错，无IO。
	function serialize(value) {
		// 三元仅对真正undefined绕过stringify；函数等值的stringify也可能得到undefined。
		return value === undefined ? undefined : stringify(value);
	}

	// QuickJS stacks list frames only. Prefix "Name: message" like V8 so the
	// text reads the same as a Node error, and drop this prelude's frames.
	// errorText把QuickJS帧列表补成可读错误栈，过滤文件名含codemode-prelude.js的行；例TypeError+脚本行，不提供完整脱敏或所有内部帧过滤保证。
	function errorText(error) {
		// message为真值时拼name与message，否则只把name转字符串；属性读取/隐式转换仍可能抛错。
		const head = error.message ? error.name + ": " + error.message : String(error.name);
		// frames是后面三元得到的帧数组。
		const frames =
			// 仅字符串stack才按行处理，不把任意stack强转再解析。
			typeof error.stack === "string"
				// 源TS中的双反斜杠n先构成运行脚本的转义，再在脚本执行时代表LF；filter去空行和含指定文件名的帧。
				? error.stack.split("\\n").filter((line) => line.trim() && !line.includes("codemode-prelude.js"))
				// 非字符串stack则无帧。
				: [];
		// 数组展开把头部和帧拼在一起，再按换行连接。
		return [head, ...frames].join("\\n");
	}

	// format供console/错误描述：字符串原样、Error走可读栈、其他先JSON后String回退。例console.log({a:1})输出JSON；最终String转换仍可抛错。
	function format(value) {
		// 字符串不加JSON双引号。
		if (typeof value === "string") return value;
		// 本VM的Error实例走errorText；此分支位于下方try之外，errorText抛错不会被该try兜底。
		if (value instanceof ErrorCtor) return errorText(value);
		// try只保护普通值JSON编码及其首个String回退。
		try {
			// JSON编码会运行值自己的toJSON等逻辑，可能抛错。
			const json = stringify(value);
			// undefined/函数等无JSON结果时用String展示。
			return json === undefined ? String(value) : json;
		// JSON编码或try内String出错时进入回退。
		} catch {
			// 再做一次String转换，没有第三层兜底，仍可能抛出。
			return String(value);
		}
	}

	// The host requires string fields. A script can set an error's name or message to anything, so
	// they are coerced, and a value whose coercion throws gets a placeholder.
	// describeError给宿主生成错误JSON：Error保留name/message/stack，任意抛出值转message，连描述都失败则固定占位。例throw 7→含message的JSON字符串。
	function describeError(error) {
		// 用外层try防错误字段访问/强转又抛错。
		try {
			// 区分本VM Error与throw出来的任意其他值。
			if (error instanceof ErrorCtor) {
				// name/message显式String，stack由errorText整理；不承诺保留Error的其他自定义属性。
				return stringify({ name: String(error.name), message: String(error.message), stack: errorText(error) });
			}
			// 其他值借format可读化，再确保message为字符串。
			return stringify({ message: String(format(error)) });
		// 描述过程失败走占位，不重新传播那个二次异常。
		} catch {
			// 固定message对象再JSON编码；内建stringify已保存/保护。
			return stringify({ message: "The script threw a value that cannot be described" });
		}
	}

```

## 工具代理与全局函数

```text
	// caller创建宿主调用代理，不在此执行工具：序列化参数→建pending→桥发请求→返回Promise。例await tools.read({path:"a"})，稍后settle才解开它。
	function caller(kind, name, spread) {
		// 剩余参数...args收集所有实参；返回箭头函数捕获kind/name/spread。
		return (...args) =>
			// Promise构造器立即同步调用执行器，resolve/reject保存在pending供以后使用。
			new Promise((resolve, reject) => {
				// 先声明json，准备在try内赋值。
				let json;
				// 只有参数编码在此try内处理，尚未分配调用id。
				try {
					// spread为真传整个实参数组，否则只传第一实参；普通工具只吃首个参数对象。
					json = serialize(spread ? args : args[0]);
				// 参数不能编码时拒绝本Promise，不向宿主发工具请求。
				} catch (error) {
					// reject把编码异常交给await调用方。
					reject(error);
					// 退出执行器，避免继续分配id/入pending。
					return;
				}
				// 为这一调用取独立id并推进计数。
				const id = nextId++;
				// 先登记回调再发桥消息，以便同步回传也能找到调用。
				pending.set(id, { resolve, reject });
				// kind通常call/global，后面是id、原始工具/全局名、JSON参数；若bridge同步抛错，Promise会拒绝，但这里无pending清理分支。
				bridge(kind, id, name, json);
			});
	}

	// 无原型字典防toString等继承名干扰工具键查找，不等于对工具本身做权限校验。
	const tools = Object.create(null);
	// allTools独立收集可展示的规范JS名字/说明。
	const allTools = [];
	// 从宿主工具目录JSON解码并逐项解构；本函数信任VM启动数据，不在这里完整schema校验。
	for (const { name, jsName, description } of parse(toolsJson)) {
		// 代理向宿主回传原名name，脚本别名jsName只用于属性访问。
		const fn = caller("call", name);
		// The first tool wins when two names normalize to the same identifier.
		// 规范名没被任何先前登记键占用才注册；发生归一化或别名冲突时先到的键获胜。
		if (!(jsName in tools)) {
			// 同一fn同时可被别名/原名指向。
			tools[jsName] = fn;
			// 成功占用规范名的工具才入ALL_TOOLS，条目冻结；name字段在列表中存jsName。
			allTools.push(Object.freeze({ name: jsName, description }));
		}
		// 原始名字也只在未占用时登记，不覆盖先前规范名或原名。
		if (!(name in tools)) tools[name] = fn;
	}
	// 冻结工具表，防脚本重赋/新增工具键。
	Object.freeze(tools);
	// 冻结目录数组，条目自身已逐个冻结；没有复制工具实现到VM。
	Object.freeze(allTools);

	// Reading a member that does not exist throws an error that names the close matches, instead of
	// a later "not a function". \`in\` checks still work.
	// comparable只保留小写ASCII字母/数字用于建议匹配；是提示归一化，不是权限标识或Unicode等价算法。
	const comparable = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	// guard为缺失成员生成具体建议；返回Proxy，只拦get不拦has。例仅注册read时，tools.Read会建议read；"read" in tools仍可正常判断，不做编辑距离纠错。
	function guard(target, label, names, hint) {
		// 用Proxy包目标对象，不复制/更改它已有成员。
		return new Proxy(target, {
			// get trap接收目标、属性键、接收者；读取目标成员时被调用。
			get(object, property, receiver) {
				// 已有键、symbol、Object.prototype名字、then/toJSON直接放行，避免常规探测/Promise同化/JSON序列化误报。
				if (typeof property !== "string" || property in object || property in Object.prototype || property === "then" || property === "toJSON") {
					// Reflect.get保留receiver语义；不要求这些放行名字一定有值，可能正常返回undefined。
					return Reflect.get(object, property, receiver);
				}
				// 把用户读取的缺失属性名归一化。
				const wanted = comparable(property);
				// 先找忽略大小写/标点后的完全匹配建议。
				const exact = names.filter((name) => comparable(name) === wanted);
				// 没有完全建议才找互相包含的名字；wanted为空时不生成该类建议。
				const close = exact.length > 0 ? exact : names.filter((name) => wanted && (comparable(name).includes(wanted) || wanted.includes(comparable(name))));
				// 先建立明确的label.property不存在提示。
				let message = label + "." + property + " does not exist.";
				// 建议最多前5个，map把每个名字带上命名空间前缀，join用逗号连接。
				if (close.length > 0) message += " Did you mean " + close.slice(0, 5).map((name) => label + "." + name).join(", ") + "?";
				// 没近似建议且总数<=20时列全量候选；不是大目录全量输出。
				else if (names.length <= 20) message += " Available: " + names.join(", ") + ".";
				// 调用方给了hint就附加，命名空间guard可不传。
				if (hint) message += " " + hint;
				// 再附如何通过成员检查确认名字的文字。
				message += ' Check for a member with "' + property + '" in ' + label + ".";
				// 立即抛TypeError，而非返回undefined等后续调用时报not a function。
				throw new TypeErrorCtor(message);
			},
		});
	}
	// 为tools表安装上述代理，后面暴露这个对象给用户脚本。
	const toolsProxy = guard(
		// 被代理的是冻结的原始工具表。
		tools,
		// 错误提示的前缀为tools。
		"tools",
		// 建议名字取ALL_TOOLS里的规范名，不是所有原始别名键。
		allTools.map((tool) => tool.name),
		// 固定提示解释可查看目录/按主题搜索；searchTools是否注册还由启动配置决定。
		"ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.",
	);

	// 按一级命名空间聚合全局函数，例如api.read与api.write放同一个api对象。
	const namespaces = new Map();
	// 解析宿主全局函数声明，spread控制实参是否整组发送。
	for (const { name, spread } of parse(globalsJson)) {
		// 生成global类代理，仍通过同一pending/bridge机制异步调用宿主。
		const fn = caller("global", name, spread);
		// 只查第一个点，不递归拆分所有路径。
		const dot = name.indexOf(".");
		// 无点的名字直接作为globalThis自有属性。
		if (dot === -1) {
			// defineProperty仅显式value/enumerable，默认writable/configurable为false；若撞上不可重配属性可抛错，不在此自动改名。
			Object.defineProperty(globalThis, name, { value: fn, enumerable: true });
			// 此项安装完成后跳过命名空间逻辑。
			continue;
		}
		// 点前内容作顶层命名空间名。
		const namespace = name.slice(0, dot);
		// 首次见该空间才新建无原型字典。
		if (!namespaces.has(namespace)) namespaces.set(namespace, Object.create(null));
		// 第一个点后完整剩余串作成员名；a.b.c在这里不是递归创建a.b.c三层对象。
		namespaces.get(namespace)[name.slice(dot + 1)] = fn;
	}
	// 逐空间安装已收集的成员。
	for (const [namespace, members] of namespaces) {
		// 冻结成员字典，防重写某个宿主函数代理。
		Object.freeze(members);
		// 包guard提供缺失成员提示；Object.keys用于建议列表。
		const value = guard(members, namespace, Object.keys(members));
		// 把带代理的命名空间装进全局；同样默认不可写、不可重配。
		Object.defineProperty(globalThis, namespace, { value, enumerable: true });
	}

```

## 短状态快照与写入差量

```text
	// key -> JSON text. Sizes count key and JSON characters.
	// 初始store是键→JSON文字，不是键→已解码对象；Map(Object.entries(...))接住启动快照。
	const stored = new Map(Object.entries(parse(storeJson)));
	// writes仅记当前执行改过的键，后写同键覆盖前写；宿主不会仅因load就收到写入。
	const writes = new Map();
	// 从0累计已占字符，采用JS字符串length的UTF-16代码单元口径，不是字节或token。
	let storedChars = 0;
	// 总量包含每个键的length和JSON文字length；这里只统计初始快照，不追溯拒绝超限初始值。
	for (const [key, json] of stored) storedChars += key.length + json.length;

	// STORE_HINT为后面配额错误提供使用建议，不会真正替用户写文件。
	const STORE_HINT =
		// 提示store适合ID/摘要，图片用image、大数据放变量或借工具写文件；这是错误文字的一部分。
		"store() is for small state such as IDs or summaries. Show images with image(), keep large data in variables, or write it to a file with a tool.";

	// checkKey验证脚本输入边界，要求真正字符串键；例store(1,x)抛TypeError，不自动转成"1"。
	function checkKey(name, key) {
		// name只用于错误消息，typeof检查真实运行值，不是TypeScript类型推导。
		if (typeof key !== "string") throw new TypeError(name + "() key must be a string");
	}

	// store同步改VM快照并记差量：undefined删键，其他值编码后先查单值/总量再提交。例store("ids",[1])；无直接磁盘IO，只有成功done会提交writes给宿主。
	// 本次目标键的直接提交在编码/额度检查后；toJSON等用户回调可重入store，其写入和其他副作用不会随外层编码失败回滚。
	function store(key, value) {
		// 先校验键，避免不同类型被Map当成新键或配额计算异常。
		checkKey("store", key);
		// 更新旧键时先算应扣除的原键+JSON占用；新键按0处理。
		const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
		// undefined是删除指令，不保存成JSON的null。
		if (value === undefined) {
			// 从本地stored删键，键不存在时无事发生。
			stored.delete(key);
			// 扣旧占用，删除可使已超限的初始快照减少；删除路径不再验总限。
			storedChars -= previous;
			// writes用undefined记删除，稍后编码成单元素[key]。
			writes.set(key, undefined);
			// 删除完成立即返回，不走JSON编码/配额分支。
			return;
		}
		// 后面try成功后json为编码结果。
		let json;
		// 捕获循环对象、BigInt、toJSON等编码异常。
		try {
			// JSON.stringify会把不可JSON的内容按JSON规则省略/转化，不保证无损保存所有JS类型。
			json = stringify(value);
		// 编码抛错时增加store键的上下文；外层尚未直接提交本次键，但不撤销toJSON等回调的重入写入。
		} catch (error) {
			// 把编码错误格式化后包装为TypeError；format本身在极端对象转换下仍可能再抛错。
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable: " + format(error));
		}
		// JSON.stringify返回undefined也表示无法作为store值，例如直接存函数。
		if (json === undefined) {
			// 拒绝该值，不悄悄当删除；只有输入本来就是undefined才走删除分支。
			throw new TypeError("store(" + stringify(key) + ") value is not JSON-serializable");
		}
		// 单值配额仅看JSON文字，不含key，默认256*1024个UTF-16代码单元；相等允许。
		if (json.length > ${MAX_STORE_VALUE_CHARS}) {
			// 超限抛RangeError，尚未直接提交本次键；前面编码回调的副作用不回滚。
			throw new RangeError(
				// 把实际JSON长度与单值限额拼入错误；这里保留TS模板插值写法，模块装载时替换成数字。
				"store(" + stringify(key) + ") value has " + json.length + " characters of JSON, more than the limit of ${MAX_STORE_VALUE_CHARS}. " +
					// 附建议常量。
					STORE_HINT,
			);
		}
		// 总量先扣旧条目再加新键/新JSON，覆盖不是直接把新旧两份都算进去。
		const next = storedChars - previous + key.length + json.length;
		// 默认总量1024*1024，含键与JSON；相等允许，仅这次非删除写入才检查。
		if (next > ${MAX_STORE_TOTAL_CHARS}) {
			// 超总量抛RangeError，不直接提交本次键；不撤销编码回调可能已产生的其他写入。
			throw new RangeError(
				// 错误解释可用undefined删键，文字本身不执行删除。
				"store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON. Delete keys with store(key, undefined). " +
					// 附同一STORE_HINT。
					STORE_HINT,
			);
		}
		// 全部检查通过才替换本地JSON文字，嵌套对象不直接存引用。
		stored.set(key, json);
		// 同步更新本地总占用。
		storedChars = next;
		// 记同键最新JSON，供最终成功提交；不会立即调用宿主。
		writes.set(key, json);
	}

	// load同步从快照取值并JSON.parse成新值；例两次load("obj")通常得不同对象，修改返回对象不会自动成为store写入。键错误或坏JSON可抛错。
	function load(key) {
		// 同样要求字符串键。
		checkKey("load", key);
		// Map读取JSON文字，没条目得到undefined。
		const json = stored.get(key);
		// 不存在直接undefined；存在就重新解码，不返回stored内部可变对象引用。
		return json === undefined ? undefined : parse(json);
	}

	// serializeWrites把差量编码为JSON数组，写为[key,json]、删为[key]；JSON字符串会被再编码一层。例删除x得到含单项数组x的列表，无IO。
	function serializeWrites() {
		// 创建这次序列化专用的条目数组。
		const entries = [];
		// 按writes的Map迭代顺序生成条目；更新旧键不挪动它的首次插入位置。
		for (const [key, json] of writes) entries.push(json === undefined ? [key] : [key, json]);
		// 编码整个差量数组，不是对完整stored再做一次快照。
		return stringify(entries);
	}

	// 安装全局store，默认不可重赋/重配，可枚举。
	Object.defineProperty(globalThis, "store", { value: store, enumerable: true });
	// 安装全局load，配置规则同store。
	Object.defineProperty(globalThis, "load", { value: load, enumerable: true });

```

## 文本输出与预算

```text
	// 当前执行输出的字符累计，从0开始，不是宿主已打印到屏幕的长度。
	let outputChars = 0;
	// 当前执行输出项累计；空字符串仍占1项。
	let outputItems = 0;

	// Past the output limits the script fails: done() reports the error, so catching it does not
	// resume output, and the host ends the script.
	// output统一文本/console/图片桥输出：先看终态，累计字符/项数，超限报告失败再抛错；例打印空串循环由项数限额挡住。计数不回退，无输出流背压机制。
	function output(kind, data, mimeType) {
		// 终态后忽略输出，不再追加项或发桥；用户catch到exit哨兵也无法恢复输出。
		if (finished) return;
		// data为文本或base64正文，按其JS字符串长度计数，不含mime/header/JSON协议外壳。
		outputChars += data.length;
		// 每次调用计1项，包括空字符串。
		outputItems++;
		// 字符/项任一严格超限即失败，相等允许；数值在构造PRELUDE_SOURCE时插入。
		if (outputChars > ${MAX_OUTPUT_CHARS} || outputItems > ${MAX_OUTPUT_ITEMS}) {
			// 创建RangeError用于报告这一次输出预算失败。
			const error = new RangeErrorCtor(
				// 错误写出字符与调用数上限，并列明覆盖三类输出。
				"script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. " +
					// 建议概括输出或借工具写文件，并非自动截断保存剩余内容。
					"Print a summary instead, or write large data to a file with a tool.",
			);
			// 先done(false)锁终态，脚本后续catch不能撤销本次失败。
			done(false, describeError(error));
			// 再抛error展开当前脚本栈；宿主何时停止VM由外层生命周期处理。
			throw error;
		}
		// 合法预算内发output桥消息，不在这里直接写终端。
		bridge("output", kind, data, mimeType);
	}

	// Primitives become their string form, everything else JSON.
	// outputText把基础值转字符串、对象/函数尝试JSON；例text("x")无额外引号，text(null)为null文字。编码/转换异常留给text处理。
	function outputText(value) {
		// &&优先于||，所以非对象且非函数的基础值，以及null/undefined先走String。
		if (value === undefined || value === null || typeof value !== "object" && typeof value !== "function") {
			// String覆盖数字/布尔/symbol/BigInt等基础值，不用JSON编码这些基础值。
			return String(value);
		}
		// 对象/函数用JSON.stringify，循环引用和某些toJSON可抛错。
		const json = stringify(value);
		// 无JSON结果时回退String；非字符串对象未必完整可读。
		return json === undefined ? String(value) : json;
	}

	// text把一个值转成文本项，编码失败包TypeError；例text({count:2})。只发桥消息，不把return值当输出；输出预算错误会从output继续抛出。
	function text(value) {
		// 保存即将输出的字符串。
		let rendered;
		// 只捕获值渲染阶段的异常。
		try {
			// outputText负责基础值/对象不同转换规则。
			rendered = outputText(value);
		// 转换失败转为TypeError，不尝试把坏对象部分输出。
		} catch (error) {
			// 原Error取message，否则String异常值；极端情况下读取/转换本身仍可再抛。
			throw new TypeErrorCtor(error instanceof ErrorCtor ? error.message : String(error));
		}
		// 在渲染try之外调用output，配额错误保持RangeError类别。
		output("text", rendered);
	}

```

## 图片输入与格式识别

```text
	// imageUrl把字符串、image_url对象或image block归一成URL文本；例block的裸base64补data:;base64,。这里只验外形，后续image才验协议与签名，不解码整张图。
	function imageUrl(value) {
		// 字符串原样返回，空字符串交image拒绝。
		if (typeof value === "string") return value;
		// 非对象/null/数组拒绝，数组即使带字段也不接受。
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			// 统一形状错误文字在模块构造字符串时被JSON.stringify正确转义插入。
			throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		}
		// image_url不为undefined优先采用；即使type/data也存在也不会走block分支。
		if (value.image_url !== undefined) {
			// 该字段必须字符串，null等拒绝。
			if (typeof value.image_url !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
			// 返回该URL，暂不验证是否远端/合法base64。
			return value.image_url;
		}
		// 没有image_url时要求type字符串。
		if (typeof value.type !== "string") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		// type必须恰为image，而不是任意MCP内容块。
		if (value.type !== "image") {
			// 包含实际类型的错误，阻止误把text/audio块当图片。
			throw new TypeErrorCtor('image only accepts image blocks, got "' + value.type + '"');
		}
		// data必须非空字符串；mimeType字段此处并不用于最终识别。
		if (typeof value.data !== "string" || value.data === "") throw new TypeErrorCtor("image expected image block data");
		// 已有data:前缀时原样返回，判断不区分大小写。
		if (value.data.toLowerCase().startsWith("data:")) return value.data;
		// 裸数据补无声明mime的base64 data URI，后续靠文件签名识别真实类型。
		return "data:;base64," + value.data;
	}

	// Base64 of the signatures of the formats providers accept inline (PNG, JPEG except
	// JPEG-LS, GIF, "RIFF....WEBP"). Signatures start at byte 0, so their encodings are prefixes.
	// 签名表按base64前缀推测支持的图片格式；不是完整解码、CRC或图片可渲染保证。
	const IMAGE_SIGNATURES = [
		// PNG固定开头的base64正则。
		["image/png", /^iVBORw0KGg/],
		// JPEG开头，负向前瞻排除此规则不接受的JPEG-LS前缀。
		["image/jpeg", /^[/]9j[/](?!9)/],
		// GIF版本前缀。
		["image/gif", /^R0lGOD[dl]h/],
		// RIFF容器加WEBP标志前缀，中间点号匹配变动长度字段的编码字符。
		["image/webp", /^UklG.{8}RUJQ/],
	];

	// image归一输入→拒远端→验data/base64→去空白/验编码外形→识别签名→输出；例image({image_url:dataUri})。失败抛TypeError，无HTTP下载，也不完整校验文件内容。
	function image(value) {
		// 先用imageUrl做输入形状归一。
		const url = imageUrl(value);
		// 空URL直接拒绝，避免后面得到难懂的协议错误。
		if (url === "") throw new TypeErrorCtor(${JSON.stringify(IMAGE_HELPER_EXPECTS)});
		// 第一个冒号定位scheme分隔，缺失为-1。
		const colon = url.indexOf(":");
		// scheme转小写；只认后面明确处理的协议。
		const scheme = colon === -1 ? "" : url.slice(0, colon).toLowerCase();
		// http/https明确拒绝，不把远端图片转交提供商抓取。
		if (scheme === "http" || scheme === "https") {
			// 报错要求base64 data URI，不会在此联网。
			throw new TypeErrorCtor("remote image URLs are not supported in tool outputs. Pass a base64 data URI instead");
		}
		// 第一个逗号隔开data URI头与正文。
		const comma = url.indexOf(",");
		// 头部按分号拆；没有逗号先给空数组，再由条件拒绝。
		const header = comma === -1 ? [] : url.slice(colon + 1, comma).split(";");
		// 必须data协议、有逗号，且mime之后的头字段中有base64标记；不是见到data:就接受。
		if (scheme !== "data" || comma === -1 || header.slice(1).every((part) => part.toLowerCase() !== "base64")) {
			// 协议/头结构不满足时统一TypeError。
			throw new TypeErrorCtor("invalid image output. Pass a base64 data URI instead");
		}
		// Providers reject the whole request on a bad image, and a persisted image block would be
		// resent on every later turn. Line breaks from wrapped base64 are dropped. The declared type
		// is ignored in favor of the detected one, as providers also reject mismatches.
		// 源模板双反斜杠生成脚本中的正则转义；运行脚本用\s去除base64正文全部空白，而非只去LF。
		const data = url.slice(comma + 1).replace(/\\s+/g, "");
		// 长度需为4倍数，主体需正字符+最多2个尾=；此形状检查不保证图片完整/内容无损。
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			// 编码外形错误单独报告，尚未发任何图片输出。
			throw new TypeErrorCtor("invalid image output. The image data is not valid base64 (truncated or corrupted?)");
		}
		// 只截前16个base64字符用于格式签名识别。
		const head = data.slice(0, 16);
		// 解构略过mime取pattern，find返回第一条签名匹配的元组或undefined。
		const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(head));
		// 没有受支持格式签名则拒绝，即使data URI声明了image/png也不信其声明。
		if (!signature) {
			// 列出支持格式的错误提示。
			throw new TypeErrorCtor("invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image");
		}
		// 输出去空白后的base64及识别到的mime，额度计base64正文字符，不含data URI头。
		output("image", data, signature[0]);
	}

```

## 主动结束与全局输出助手

```text
	// exit先编码writes并报告成功，再抛私有EXIT停止当前栈；例store("x",1);exit()可提交x。它可以被脚本catch，但终态已锁；不会把后续行为重新变回成功运行中。
	function exit() {
		// 预先声明待传给done的差量JSON。
		let writesJson;
		// 单独保护写入差量编码阶段。
		try {
			// 正常序列化只有本次修改过的键。
			writesJson = serializeWrites();
		// 若差量编码异常，转失败终态，不提交成功写入。
		} catch (error) {
			// 失败错误JSON交宿主。
			done(false, describeError(error));
			// 抛EXIT展开栈，避免继续走成功分支；EXIT本身不作为宿主错误载荷。
			throw EXIT;
		}
		// 成功没有最终return值，writes照常带上；done会忽略重复终态。
		done(true, undefined, writesJson);
		// 成功发出后抛哨兵；即使用户捕获也无法重新打开finished。
		throw EXIT;
	}

	// 新建局部console对象，后面只提供指定五种方法，不是Node完整console。
	const console = {};
	// 统一安装log/info/warn/error/debug；这些等级当前都走console输出项，未各自分不同协议级别。
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		// 每个方法收集任意多个参数。
		console[level] = (...args) => {
			// 各参数独立format后用空格连接，调用统一output预算；格式化异常直接传播。
			output("console", args.map(format).join(" "));
		};
	}
	// 冻结console，防改方法；函数实现仍通过闭包里的output发宿主。
	Object.freeze(console);

	// 暴露带缺失成员提示的tools代理。
	Object.defineProperty(globalThis, "tools", { value: toolsProxy, enumerable: true });
	// 暴露冻结的工具目录数组ALL_TOOLS。
	Object.defineProperty(globalThis, "ALL_TOOLS", { value: allTools, enumerable: true });
	// 用精简console作为全局console，不直接连接宿主进程console。
	Object.defineProperty(globalThis, "console", { value: console, enumerable: true });
	// 暴露text输出函数。
	Object.defineProperty(globalThis, "text", { value: text, enumerable: true });
	// 暴露image输出函数。
	Object.defineProperty(globalThis, "image", { value: image, enumerable: true });
	// 暴露exit函数；上述defineProperty均为可枚举、默认不可写不可重配。
	Object.defineProperty(globalThis, "exit", { value: exit, enumerable: true });

```

## 宿主控制接口：回复、运行与死等

```text
	// 外层返回控制接口对象，宿主VM驱动器持有；用户脚本通过全局函数访问能力，不直接取得bridge。
	return {
		// settle回答一个工具/全局调用：找pending→先删→失败建Error或成功JSON解码→reject/resolve。例id=2回复可先完成第二个Promise；确定性seq排序由外层VM控制，不在此函数。
		settle(id, ok, payload, propertiesJson) {
			// 按调用id查回调，不按完成顺序或工具名猜测。
			const entry = pending.get(id);
			// 未知/重复id直接忽略，既不建新Promise也不报错。
			if (!entry) return;
			// 先删除，随后拒绝/解析即使抛错也不会保留该entry；本函数未对全部失败载荷处理加总try。
			pending.delete(id);
			// ok为false走错误分支，payload在此作为错误message而不是JSON成功值。
			if (!ok) {
				// 生成本VM的Error，宿主Error对象本身不会跨WASM传过来。
				const error = new ErrorCtor(payload);
				// 附加属性JSON只有提供时才解码。
				if (propertiesJson !== undefined) {
					// 解析附加属性，错误JSON在此没有局部catch，会从settle抛出而不是自动reject该entry。
					const properties = parse(propertiesJson);
					// 只复制JSON对象自有可枚举字符串键。
					for (const key of Object.keys(properties)) {
						// 保留Error核心name/message/stack，不让附加属性覆盖。
						if (key === "name" || key === "message" || key === "stack") continue;
						// defineProperty直接定义自有数据属性，也不会对__proto__做普通赋值触发原型setter；字段允许后续写入/枚举/重配。
						Object.defineProperty(error, key, { value: properties[key], writable: true, enumerable: true, configurable: true });
					}
				}
				// 拒绝调用Promise，脚本await可catch；不在此直接done失败整个脚本。
				entry.reject(error);
				// 失败路径已处理，不再尝试成功JSON解析。
				return;
			}
			// 准备保存成功结果。
			let value;
			// 成功值JSON解析有局部try，语法异常会拒绝Promise。
			try {
				// undefined单独透传，其他payload经JSON.parse成为VM内值。
				value = payload === undefined ? undefined : parse(payload);
			// 解析失败进入拒绝路径。
			} catch (error) {
				// 把JSON异常交调用者的Promise。
				entry.reject(error);
				// 退出，避免接着resolve未赋值。
				return;
			}
			// 用解码结果解开Promise，await后续代码需由外层驱动QuickJS pending jobs运行。
			entry.resolve(value);
		},
		// run启动用户异步函数，订阅完成：同步抛错/Promise拒绝报失败，成功编码return和writes。例return 1仅设置最终value；text另发输出。这里fn应返回真正Promise，不接受任意thenable的泛化同化。
		run(fn) {
			// 保存用户函数返回的Promise，通常由vm.ts编成async函数。
			let promise;
			// try只包用户函数首次调用，不覆盖后面then订阅或所有成功回调。
			try {
				// 传toolsProxy和console给脚本函数参数，其他API已装全局。
				promise = fn(toolsProxy, console);
			// 首次调用同步抛错时直接转失败终态。
			} catch (error) {
				// 将错误格式化并通知宿主。
				done(false, describeError(error));
				// 已报告同步失败，停止订阅。
				return;
			}
			// 使用保存的原生then，通过.call指定接收者为promise；返回的链式Promise未保存。
			promiseThen.call(
				// 接收者是fn返回值；如果不是可用的本VM Promise，此处可抛错，由外层VM处理。
				promise,
				// 第一个回调处理正常resolve值。
				(value) => {
					// 声明最终return值JSON文本。
					let json;
					// try只保护serialize(value)，不包括稍后的serializeWrites。
					try {
						// undefined保持undefined，其他结果JSON编码；无法编码可抛错。
						json = serialize(value);
					// return值编码失败后报脚本失败。
					} catch (error) {
						// done(false)锁定失败终态。
						done(false, describeError(error));
						// 退出成功回调，不再提交writes。
						return;
					}
					// 成功时把return值与写入差量一起发出；若serializeWrites自身抛错，不在上面的局部catch内，也不会由同次then的第二个回调处理。
					done(true, json, serializeWrites());
				},
				// 第二个回调仅处理原promise拒绝，不处理第一个回调自身抛出的异常。
				(error) => {
					// 拒绝原因转错误JSON再报失败；已finished则done忽略。
					done(false, describeError(error));
				},
			);
		},
		// stalled由外层在pending jobs清空后检查：尚未完成且没有宿主调用可回来时判死等。例await new Promise(()=>{})会失败；不是任意时刻都可调用的通用死锁探测。
		stalled() {
			// 已经结束，或还有宿主调用pending，则不能据此断定永远不会恢复。
			if (finished || pending.size > 0) return false;
			// 否则报告失败终态。
			done(
				// 第一个done参数false表示运行失败。
				false,
				// 把下面错误对象编码为协议用JSON文字。
				stringify({
					// 错误类别为Error。
					name: "Error",
					// message值分行书写，接下一行完整文字。
					message:
						// 解释等待不可能settle的Promise：VM没有计时器，且当前没有待回的工具调用；成立前提是外层已把可运行微任务排空。
						"The script is waiting on a promise that can never settle: no tool call is pending, and timers do not exist here.",
				}),
			);
			// 确已报告stalled则true，供驱动层决定后续处理。
			return true;
		},
	};
// 结束并返回这个函数表达式的文本；源码此处末尾反引号才关闭外层TS模板，不是立即调用该外层函数。
})`;
```
