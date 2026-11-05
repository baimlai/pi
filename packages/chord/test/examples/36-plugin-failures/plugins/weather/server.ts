// The weather plugin's server facet: its setup throws (no API key configured), so the host leaves the plugin out at
// startup and runs the others.

import { constant, defineFacet } from "@earendil-works/chord";
import { Weather } from "./contract.ts";

// 联合类型允许字符串或 undefined；此夹具固定缺值，完全不读取真实凭证或调用天气 API。
const apiKey: string | undefined = undefined;

// setup 输入 host，先检查此夹具配置，再登记工厂；本例必然抛错，没有返回/外部副作用。
// 例如 load 会把该插件列入 failed 并继续其他插件；失败不是模拟网络超时，也不会自动补 API key。
export default defineFacet((host) => {
	// 这是插件配置的运行时决定，Error 被 load/reload 的每插件失败边界处理。
	if (apiKey === undefined) throw new Error("weather: no API key configured");
	// 只有配置存在时才登记此无参工厂；工厂提供固定温度观察值，无真实请求。
	host.serve(Weather, () => ({ celsius: constant(21) }));
});
