// The forecast plugin's server facet: a consumer of the weather plugin's `Weather`.

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
		const weather = self.get(Weather, {});
		// sources 的单元素数组被回调解构为 celsius，模板字符串只生成返回值，不写源状态。
		return { text: self.derive([weather.celsius], ([celsius]) => `${celsius} degrees`) };
	}),
);
