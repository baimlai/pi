import assert from "node:assert/strict";
import { bool, num, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { describe, it } from "vitest";
import {
	bind,
	coverage,
	hostFamily,
	hostNamed,
	isChordError,
	local,
	method,
	opaque,
	remote,
} from "../../src/old/index.ts";
import { canonicalIdentity, fits, normalize } from "../../src/old/schema.ts";

// 共用的状态 schema：需要 text 字符串，允许附加属性；不是状态值本身。
const View = obj({ text: str() }, { open: true });

// 定义聊天契约第一版，后续用浅展开有意改变一部分描述来测试兼容关系；没有建立主机或连接。
const chatV1 = remote("t.chat", {
	// 版本属于契约描述，改变它会改变指纹，并触发跨版本适配要求。
	version: 1,
	// 输入含必需 session 与有默认值 0 的 conversation；规范化会补默认值并清理未知字段。
	input: obj({ session: str(), conversation: num({ default: 0 }) }, { open: true }),
	// 按 session 输入字段组成 session: 前缀主机地址，位置也参与兼容比较。
	host: hostFamily("session:", "session"),
	// viewer 只读状态，participant 多一个 send；TypeScript 的引用联合会按 variant 缩窄。
	variants: {
		// viewer 暴露 View 对应的状态成员。
		viewer: { state: { view: View } },
		// participant 变体同时包含状态和方法。
		participant: {
			// View 的同一 schema 引用复用于此状态。
			state: { view: View },
			// send 接受 text，返回含数值 id 的对象；此处只声明方法契约。
			methods: { send: method(obj({ text: str() }, { open: true }), obj({ id: num() }, { open: true })) },
		},
	},
});

// 这些是同步纯数据测试：构造契约、比较描述和检查抛错，不启动 Chord 主机。
describe("contracts", () => {
	// 例子：带 format=email 的 schema 接受 "nope"；验证当前校验器把 format 当注解而非邮箱验证。
	it("treats `format` as an annotation: an input with format email accepts any string", () => {
		// 创建带格式注解的本地输入契约，尚未校验具体值。
		const Mail = local("t.mail", { version: 1, input: obj({ to: str({ format: "email" }) }) });
		// 实际运行 normalize，返回原字符串表明未执行邮箱语义检查。
		assert.deepEqual(normalize(Mail.input, { to: "nope" }, "input"), { to: "nope" });
	});

	// 例子：缺失 conversation 时补 0，额外 extra 被清理；与显式 0 的输入获得相同规范身份。
	it("normalizes input and omits defaults from the identity", () => {
		// normalize 克隆数据、填默认值、清理未知字段后运行校验。
		const a = normalize(chatV1.input, { session: "s", extra: 1 }, "input");
		// 确认输出只保留已知字段且默认值已补齐。
		assert.deepEqual(a, { session: "s", conversation: 0 });
		// 反转字段顺序并显式给出默认值，检验身份不依赖输入书写方式。
		const b = normalize(chatV1.input, { conversation: 0, session: "s" }, "input");
		// 身份字符串会省略等于默认值的字段，并按规范顺序编码对象。
		// 直接核对实际身份只含 session。
		assert.equal(canonicalIdentity(chatV1.input, a), canonicalIdentity(chatV1.input, b));
		assert.equal(canonicalIdentity(chatV1.input, a), '{"session":"s"}');
		// 故意传数值 session 绕过正确数据形状，验证运行时 normalize 抛 invalid/input。
		assert.throws(
			() => normalize(chatV1.input, { session: 1 }, "input"),
			// 错误谓词先识别 ChordError，再检查原因 input，不靠 TS 类型替代实际断言。
			(error) => isChordError(error, "invalid") && error.reason === "input",
		);
	});

	// 重新构造等描述契约指纹相同，只改 version 指纹不同；不证明哈希绝无碰撞。
	it("fingerprints are stable and description-based", () => {
		// 基于同一 def 建另一个契约对象。
		const copy = remote("t.chat", chatV1.def);
		// 对象不同但 description 相同，应得到同一个描述哈希。
		assert.equal(copy.fingerprint, chatV1.fingerprint);
		// 浅展开原 def 并覆盖版本，验证版本进入指纹。
		assert.notEqual(remote("t.chat", { ...chatV1.def, version: 2 }).fingerprint, chatV1.fingerprint);
	});

	// 构造非法声明，测试保留成员名及远程 opaque 限制在运行时也会拒绝。
	it("rejects reserved member names and opaque remote members", () => {
		// status 是旧版保留名，本地声明也不能覆盖它。
		assert.throws(() => local("t.x", { version: 1, input: obj({}, { open: true }), members: { status: method() } }));
		// 用 as never 人为绕过 TypeScript 限制，证明远程 opaque 仍被运行时契约构造器拒绝。
		assert.throws(() =>
			remote("t.x", {
				host: hostNamed("server"),
				version: 1,
				input: obj({}, { open: true }),
				variants: { a: { state: { h: opaque("x@1") as never } } },
			}),
		);
	});

	// 在同版本内：添加可选方法参数与额外结果/状态字段可覆盖旧接口，添加必需参数或把 text 改成数值则不可。
	it("covers additive changes and refuses breaking ones", () => {
		// 浅展开保持名字/版本/输入/主机位置，只替换 participant 变体。
		const additive = remote("t.chat", {
			...chatV1.def,
			variants: {
				...chatV1.def.variants,
				participant: {
					state: { view: obj({ text: str(), extra: num() }, { open: true }) },
					methods: {
						send: method(
							obj({ text: str(), urgent: opt(bool()) }, { open: true }),
							obj({ id: num(), at: num() }, { open: true }),
						),
					},
				},
			},
		});
		// coverage 成功返回 undefined；它比较 schema 结构，没有实际调用 send。
		assert.equal(coverage(additive.description, chatV1.description), undefined);
		// 同版本兼容变更直接绑定，无需适配函数，因此返回 undefined。
		assert.equal(bind(additive, undefined, chatV1), undefined);

		// 将 urgent 改为必需字段，旧消费者不会发送它。
		const required = remote("t.chat", {
			...chatV1.def,
			variants: {
				...chatV1.def.variants,
				participant: {
					state: { view: View },
					methods: {
						send: method(
							obj({ text: str(), urgent: bool() }, { open: true }),
							obj({ id: num() }, { open: true }),
						),
					},
				},
			},
		});
		// 失败原因应指向方法参数。?? 仅在 undefined 时换空字符串，使正则断言可靠失败。
		assert.match(coverage(required.description, chatV1.description) ?? "", /arguments/);
		// bind 不是返回原因字符串，而是抛 contract_mismatch。
		assert.throws(
			() => bind(required, undefined, chatV1),
			(error) => isChordError(error, "contract_mismatch"),
		);

		// 保持 text 字段名但改成数值 schema，制造状态类型不兼容。
		const retyped = remote("t.chat", {
			...chatV1.def,
			variants: { ...chatV1.def.variants, viewer: { state: { view: obj({ text: num() }, { open: true }) } } },
		});
		// 状态输出不满足旧消费者的 string 期望，应报告 state。
		assert.match(coverage(retyped.description, chatV1.description) ?? "", /state/);
	});

	// 区分无参数与带参数；无结果消费者可忽略提供方结果，但需要结果的消费者不能绑定无结果提供方。
	it("methods without arguments or result: described without them; their presence must match, a void consumer accepts a result", () => {
		// 小构造器接收 local 的 members 参数类型，返回契约 description；Parameters/typeof/[1] 是静态类型提取，无运行时校验。
		const of = (members: Parameters<typeof local>[1]["members"]) =>
			// 只返回描述用于下面 coverage，不创建实例。
			local("t.methods", { version: 1, input: obj({}, { open: true }), members }).description;
		// method() 的描述既无 args 也无 result。
		const none = of({ m: method() });
		// 可选链避免分支不存在时读属性抛错，断言实际描述只含 kind。
		assert.deepEqual(none.variants[""]?.m, { kind: "method" });
		// 构造有字符串参数、没有结果的方法。
		const withArgs = of({ m: method(str()) });
		// 显式省略参数 schema，声明数字结果。
		const withResult = of({ m: method(undefined, num()) });
		// 相同无参数无结果描述可以互相覆盖。
		assert.equal(coverage(none, none), undefined);
		// 消费者不发参数而提供方需要参数，无法覆盖。
		assert.match(coverage(withArgs, none) ?? "", /arguments/, "the consumer sends none, the provider expects some");
		// 消费者会发参数而提供方声明不接参数，也无法覆盖。
		assert.match(coverage(none, withArgs) ?? "", /arguments/, "the consumer sends some, the provider takes none");
		// 消费者不关心结果时允许提供方多返回值。
		assert.equal(coverage(withResult, none), undefined, "a void consumer ignores a result");
		// 消费者需要数字结果，提供方必须声明结果。
		assert.match(coverage(none, withResult) ?? "", /result/, "a consumer expecting a result needs one");
	});

	// 例子：v2 将 view 改成 body，v1 消费者需显式 accepts[1] 映射；只提供函数但本测试不运行映射。
	it("binds other versions only through accepts adapters", () => {
		// 新版本只提供 viewer.body，保留原名字与位置。
		const v2 = remote("t.chat", { ...chatV1.def, version: 2, variants: { viewer: { state: { body: View } } } });
		// 未配置跨版本适配，绑定必须抛错。
		assert.throws(
			() => bind(v2, undefined, chatV1),
			(error) => isChordError(error, "contract_mismatch"),
		);
		// 接收当前成员表，构造旧版 viewer/view 形状；Record<string,unknown> 不保证 body 的具体类型。
		const adapter = (current: Record<string, unknown>) => ({ variant: "viewer", view: current.body });
		// 断言选中的正是注册的适配函数引用，不把函数选择当作结果值验证。
		assert.equal(bind(v2, { 1: adapter }, chatV1), adapter);
	});

	// opaque 按标识与版本比较；函数参数按可接收值范围逆向比较，返回值按输出范围比较。
	it("compares opaque members by name@version and function members structurally", () => {
		// 本地接口允许 opaque，并允许以函数 schema 描述回调值。
		const a = local("t.idx", {
			version: 1,
			input: obj({}, { open: true }),
			members: {
				harness: opaque("h@1"),
				onChange: method({ type: "function", parameters: [str()], returnType: { type: "void" } }),
			},
		});
		// 浅展开更换 opaque 标识 h@1 为 h@2，故消费者不能当作同一个不透明接口。
		const b = local("t.idx", { ...a.def, members: { ...a.def.members, harness: opaque("h@2") } });
		// 核对差异原因明确落在 opaque 成员。
		assert.match(coverage(b.description, a.description) ?? "", /opaque/);
		// 接受 unknown 的函数可以接收所有字符串，所以能满足只会传 string 的使用方。
		assert.ok(
			fits(
				{ type: "function", parameters: [unknown()], returnType: { type: "void" } },
				{ type: "function", parameters: [str()], returnType: { type: "void" } },
			),
		);
		// 反向不成立：只接 string 的函数不能满足可能传任意 unknown 的使用方；! 对结果取反。
		assert.ok(
			!fits(
				{ type: "function", parameters: [str()], returnType: { type: "void" } },
				{ type: "function", parameters: [unknown()], returnType: { type: "void" } },
			),
		);
	});
});
