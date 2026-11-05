// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/weather，示例插件 @example/weather 的 server facet。
// 演示什么：启动时 setup 抛错。apiKey 夹具固定为 undefined；setup 检查后抛 Error，host.load 把插件列入 failed 并
// 继续加载其他插件；forecast 因此等待 Weather。
// 上游入口：createPlugins 发现/构建/求值；host.load 执行 setup，抛错被每插件失败边界捕获。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet；同目录 contract.ts；package.json 的 name 是插件身份。
// 能力清单：default facet；配置存在时登记 Weather 的无参工厂，返回固定摄氏温度。
// 示例（真实签名）：defineFacet((host) => { if (key === undefined) throw new Error(...); host.serve(Weather, () => ({ celsius: constant(21) })); });
// 典型运行：启动打印 "1. left out @example/weather: plugin "@example/weather": weather: no API key configured"；
// 之后每次 reload 报告仍列 weather failed，因为组件每次都把它的脚本交给宿主而 setup 仍抛错。
// 注意：不读取真实凭证、不发网络请求，也不自动补 API key。
// 建议阅读顺序：导入 -> apiKey 夹具 -> default setup -> 配置检查 -> 工厂。
// The weather plugin's server facet: its setup throws (no API key configured), so the host leaves the plugin out at
// startup and runs the others.

// constant 包装固定温度；defineFacet 声明 facet；Weather 是本插件的契约令牌。
import { constant, defineFacet } from "@earendil-works/chord";
import { Weather } from "./contract.ts";

// 联合类型允许字符串或 undefined；此夹具固定缺值，完全不读取真实凭证或调用天气 API。
// `string | undefined` 只是编译期注解，运行时这个变量就是 undefined；没有环境变量或文件读取。
const apiKey: string | undefined = undefined;

// setup 输入 host，先检查此夹具配置，再登记工厂；本例必然抛错，没有返回/外部副作用。
// 例如 load 会把该插件列入 failed 并继续其他插件；失败不是模拟网络超时，也不会自动补 API key。
// defineFacet 只保存 setup；真正的检查在 host.load/host.reload 运行 setup 时执行，抛出的 Error 被该插件的失败边界捕获。
export default defineFacet((host) => {
	// 这是插件配置的运行时决定，Error 被 load/reload 的每插件失败边界处理。
	// 检查之后 TypeScript 把 apiKey 从 string | undefined 收窄为 string；本例的分支永远走 throw。
	if (apiKey === undefined) throw new Error("weather: no API key configured");
	// 只有配置存在时才登记此无参工厂；工厂提供固定温度观察值，无真实请求。
	// 正常配置下宿主会服务 Weather，forecast 的依赖就能绑定并计算文本。
	host.serve(Weather, () => ({ celsius: constant(21) }));
});
