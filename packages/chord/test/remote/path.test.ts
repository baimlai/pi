// 用最小持有者和链接替身，验证 Path 如何在断线和重连时通知所有持有者。
import { describe, expect, it } from "vitest";
import { ChordError } from "../../src/data/index.ts";
import type { HostLink } from "../../src/remote/host-link.ts";
import { Path, type Upstream } from "../../src/remote/path.ts";

/** A holder recording where it was held and what it was told, as `name@link` and `name dropped`. */
// 输入名称与日志数组，返回只实现本组所需方法的持有者替身。
// attach 记录连接名，dropped 记录断线；例如 a 连接到 1 时写入 "a@1"。
// as unknown as Upstream 是两步类型断言，只让测试通过类型检查，不会生成真实 RemoteObject 或补齐方法。
function holder(name: string, log: string[]): Upstream {
	// The path calls only `attach` and `dropped`.
	return {
		// 参数用结构类型声明 name；模板字符串拼出日志，void 丢弃 push 的数字结果。
		attach: (link: { readonly name: string }) => void log.push(`${name}@${link.name}`),
		// 断线通知只记事件，不发起重连。
		dropped: () => void log.push(`${name} dropped`),
	} as unknown as Upstream;
}

/** A link known by its name; the path only passes it on. */
// 按名称制作仅供 Path 转交的链接替身；例如 linkOf("2") 可区分新旧对象身份。
// 返回值没有真实 HostLink 的网络行为；断言只改变编译器视角，不做运行时校验。
function linkOf(name: string): HostLink {
	return { name } as unknown as HostLink;
}

// 注册四个独立场景；describe 回调不返回业务结果，下面的日志都由单个用例自己创建。
describe("a path", () => {
	// 先挂两个持有者而没有链接，再接入链接和第三个持有者；检查何时请求外部解析路径。
	it("asks for a link when it gets a holder without one; holds every holder on each link it gets", () => {
		// string[] 在开发时限制日志元素类型；changes 记录 changed 回调次数。
		const log: string[] = [];
		let changes = 0;
		// 回调捕获 changes；每次路径通知外部时自增，不代表发出了网络消息。
		const path = new Path(() => changes++);
		// 没有链接时，两个 attach 分别通知外部有新需求。
		path.attach(holder("a", log));
		path.attach(holder("b", log));
		expect(changes).toBe(2);
		// 持有者尚未得到链接，所以 attach 日志为空。
		expect(log).toEqual([]);
		const first = linkOf("1");
		// 接入第一条链接，同步把它交给已有的 a、b。
		path.connected(first);
		expect(log).toEqual(["a@1", "b@1"]);
		// 已有链接时新持有者直接连接，不再要求 changed 回调解析链接。
		path.attach(holder("c", log));
		// at(-1) 读取数组末项。
		expect(log.at(-1)).toBe("c@1");
		expect(changes).toBe(2);
	});

	// 模拟旧链接断开、换成新链接、迟到的旧断线回调；证明新链接不会被旧回调清空。
	it("tells every holder when its link drops, then asks for the next; a stale link's drop is ignored", () => {
		// 独立日志、回调计数及路径，避免用例间相互依赖。
		const log: string[] = [];
		let changes = 0;
		const path = new Path(() => changes++);
		// 数组解构把两条不同对象身份的替身分别命名。
		const [first, second] = [linkOf("1"), linkOf("2")];
		path.connected(first);
		path.attach(holder("a", log));
		// 当前链接断开：通知 a，清空路径链接，再发出一次 changed。
		path.disconnected(first);
		expect(log).toEqual(["a@1", "a dropped"]);
		expect(changes).toBe(1);
		expect(path.link).toBeUndefined();
		// 新链接令 a 再次 attach；此后旧 first 的断线消息必须无效。
		path.connected(second);
		path.disconnected(first);
		expect(log).toEqual(["a@1", "a dropped", "a@2"]);
		expect(changes).toBe(1);
		// toBe 比较对象身份，确认仍保存 second 本身。
		expect(path.link).toBe(second);
	});

	// 有两个持有者时依次释放，只有最后一个离开才通知外部；后续重连不应找回它们。
	it("reports its last holder's detach: no later link holds it", () => {
		// 创建两个持有者并保留其对象，detach 按对象身份删除。
		const log: string[] = [];
		let changes = 0;
		const path = new Path(() => changes++);
		const [a, b] = [holder("a", log), holder("b", log)];
		path.connected(linkOf("1"));
		path.attach(a);
		path.attach(b);
		// b 还在，删除 a 不应报告路径已无人使用。
		path.detach(a);
		expect(changes).toBe(0);
		// 最后一个持有者离开，held 变 false，并报告一次 released。
		path.detach(b);
		expect(changes).toBe(1);
		expect(path.held).toBe(false);
		// 接上第二条链接，日志仍只有第一次 attach，说明释放项没有残留。
		path.connected(linkOf("2"));
		expect(log).toEqual(["a@1", "b@1"]);
	});

	// 记录事件 kind 和不可达错误：先无链接 attach，再失败、连接、断线、释放。
	// 例如 "no worker" 只通知持有者失败；Path 自己不抛出这个 ChordError。
	it("says what changed: a holder attached without a link, a drop, the last release; fails its holders waiting", () => {
		// 分开记录路径事件与持有者错误，避免把二者误认为同一种通知。
		const events: string[] = [];
		const failed: string[] = [];
		// event.kind 来自 PathEvent 的联合类型：attached、dropped 或 released。
		const path = new Path((event) => events.push(event.kind));
		const a = {
			// 本例不关心 attach/dropped 的载荷，只为满足被调用的方法保留空实现。
			attach: () => {},
			dropped: () => {},
			// readonly 仅禁止通过这个参数类型写 message，不冻结实际错误对象。
			unreachable: (error: { readonly message: string }) => void failed.push(error.message),
		} as unknown as Upstream;
		// 无链接 attach 产生 attached；unreachable 转告错误，但不删除持有者。
		path.attach(a);
		path.unreachable(new ChordError({ code: "unavailable", message: "no worker" }));
		const link = linkOf("1");
		// 连接不产生本例监听的 changed 事件，断线和最后释放分别产生后两项。
		path.connected(link);
		path.disconnected(link);
		path.detach(a);
		// 精确检查事件顺序，以及同一条错误只转告一次。
		expect(events).toEqual(["attached", "dropped", "released"]);
		expect(failed).toEqual(["no worker"]);
	});
});
