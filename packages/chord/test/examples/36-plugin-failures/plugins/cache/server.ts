// The cache plugin's server facet: `Cache` opens a store per generation, which takes a while (a native); `Status` reads
// the cache of the plugin's generation. A reload to a new generation swaps `Status` in place; its new code needs a new
// `Cache` object, and its first dependency check waits until that one is open: the reload's report waits for it too.

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
	host.serve(Status, (_params, self) => {
		const cache = self.get(Cache, { generation });
		// derive 解构一个依赖值，纯计算显示文本；Cache 变化/重绑定会触发重算。
		return { text: self.derive([cache.generation], ([value]) => `cache ${value}`) };
	});
});
