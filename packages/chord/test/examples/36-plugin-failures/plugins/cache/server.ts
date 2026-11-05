// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/cache，示例插件 @example/cache 的 server facet。
// 演示什么：同一插件服务两个对象：带 generation 参数的 Cache 和主机生命周期的 Status。Cache 激活时打开一个模拟
// native（约 200 ms），Status 依赖本代 Cache。main.ts 只改副本里 generation 常量的值，让 Cache 获得新身份；
// Status 的新代码因此要等新 Cache 打开，重载在提交后取消也能保留提交结果。
// 上游入口：同 boot：createPlugins 发现 -> buildFacet 构建 -> evaluateFacet 求值 -> host.load/reload 执行 setup。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet/local/str；同目录 package.json 的 name 是插件身份。
// 能力清单：Cache 契约（params.generation，成员 generation: str）；Status 契约（成员 text: str）；
// default facet 登记两个工厂；Cache 工厂声明 native opener/closer；Status 工厂声明 Cache 依赖并派生文本。
// 示例（真实签名）：host.serve(Cache, (params, self) => { self.open(async () => ({}), () => {}); return { generation: constant(params.generation) }; });
// 典型运行：第 4 幕先打印 "4. status: cache v1"；重载后状态引用进入 loading 并触发 abort，reload 以 aborted 拒绝，
// details.committed.changed 含 "@example/cache"；随后 status 变为 "cache v2"，再重载 greeter 后仍是 "cache v2"。
// 建议阅读顺序：generation 常量 -> 两个契约 -> default setup -> Cache 工厂与 native -> Status 工厂与 derive。
// The cache plugin's server facet: `Cache` opens a store per generation, which takes a while (a native); `Status` reads
// the cache of the plugin's generation. A reload to a new generation swaps `Status` in place; its new code needs a new
// `Cache` object, and its first dependency check waits until that one is open: the reload's report waits for it too.

// constant 包装固定值；defineFacet 声明 facet；local/str 声明两个本地契约及字符串成员。
import { constant, defineFacet, local, str } from "@earendil-works/chord";

// 源码标签决定 Status 依赖哪个 Cache 身份；main 只改临时副本里的这行字符串。
const generation = "v1";

// Cache 带 generation 身份参数，不同代是不同对象；Status 无参数，是主机生命周期的消费者。
const Cache = local("example.cache", { version: 1, params: { generation: str() }, members: { generation: str() } });
const Status = local("example.status", { version: 1, params: {}, members: { text: str() } });

// setup 依次登记缓存和状态工厂，返回 void，无 I/O；工厂也只声明，真正的延时发生在激活 opener。
// 例如新代 Status 先等同代 Cache 激活，再暴露对应文本；激活错误由 Chord 记入引用/主机错误。
export default defineFacet((host) => {
	// 本地工厂输入 params 和 self，不接收远端 principal；输出 generation 常量状态。
	host.serve(Cache, (params, self) => {
		// 声明模拟 native，不读取其值；它的存在让激活必须等 open 完成。
		self.open(
			// opener 无需输入，约200ms后返回空对象；定时器未连接 ctx，取消不能提前结束这次延时。
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return {};
			},
			// closer 收到资源时不做事；这里没有真正系统资源需要释放。
			() => {},
		);
		// 参数已经在请求边界由契约校验；constant 提供 JSON 可观察值。
		return { generation: constant(params.generation) };
	});
	// Status 工厂的 _params 未使用；其依赖在激活阶段等待，不在同步工厂里读取值。
	// 下划线前缀只是“未使用参数”的命名约定，TypeScript 不会因此跳过类型检查。
	host.serve(Status, (_params, self) => {
		const cache = self.get(Cache, { generation });
		// derive 解构一个依赖值，纯计算显示文本；Cache 变化/重绑定会触发重算。
		return { text: self.derive([cache.generation], ([value]) => `cache ${value}`) };
	});
});
