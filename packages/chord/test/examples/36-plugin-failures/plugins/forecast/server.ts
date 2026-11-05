// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/forecast，示例插件 @example/forecast 的 server facet。
// 演示什么：跨插件依赖。forecast 的工厂用 self.get(Weather, {}) 声明依赖并 derive 文本；weather 的 setup 在启动时
// 失败，所以 forecast 对象停在 failed/waiting（引用状态失败，原因 waiting）。
// 上游入口：createPlugins 发现/构建/求值；buildFacet 会把 ../weather/contract.ts 作为另一插件的文件复制进本构建，
// 并列入 BuiltFacet.copied；host.load 随后执行 default facet 的 setup。
// 下游依赖：@earendil-works/chord 的 defineFacet/local/str；weather 的契约文件；同目录 package.json 的 name 是插件身份。
// 能力清单：Forecast 契约（local、空 params、成员 text: str）；default facet 的工厂（Weather 引用 + derive）。
// 示例（真实签名）：
//   const facet = defineFacet((host) => host.serve(Forecast, (_params, self) => {
//     const weather = self.get(Weather, {});
//     return { text: self.derive([weather.celsius], ([celsius]) => `${celsius} degrees`) };
//   }));
// 典型运行：启动输出 forecast 的 failed 状态，running 中没有 forecast；示例不修复 weather。
// 建议阅读顺序：导入（含复制的契约）-> Forecast 契约 -> setup 工厂 -> 引用与 derive。
// The forecast plugin's server facet: a consumer of the weather plugin's `Weather`.

// defineFacet/local/str 用于声明；Weather 来自另一个插件目录，构建时被内联为副本（只允许宿主包和本插件文件）。
import { defineFacet, local, str } from "@earendil-works/chord";
import { Weather } from "../weather/contract.ts";

// 仅本主机的字符串状态契约；空参数意味着主机生命周期。
const Forecast = local("example.forecast", { version: 1, params: {}, members: { text: str() } });

// setup 只登记工厂；工厂接收 self 并声明 Weather 依赖，再返回派生文本，无文件/网络操作。
// 例如天气21会算出对应英文温度文本；本例 Weather setup 失败，所以工厂停在依赖等待阶段。
// get 是同步声明句柄，derive 回调在激活/更新时才接收值；依赖失败由 Chord 表达，不在此 catch。
export default defineFacet((host) =>
	host.serve(Forecast, (_params, self) => {
		// 声明本主机 Weather 的引用，空对象指定它的唯一身份参数集合。
		// self.get 只登记请求并返回同步句柄；参数在这里由契约做运行时检查，真正的绑定在激活阶段。
		const weather = self.get(Weather, {});
		// sources 的单元素数组被回调解构为 celsius，模板字符串只生成返回值，不写源状态。
		// derive 是纯同步计算；依赖变化或重绑定会重新执行回调，依赖失败时本对象停在 failed/waiting。
		return { text: self.derive([weather.celsius], ([celsius]) => `${celsius} degrees`) };
	}),
);
