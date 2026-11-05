// The summary plugin's server facet: a consumer of the prices plugin's `Price`, at the version its copy of the
// contract declares.

import { defineFacet, local, str } from "@earendil-works/chord";
import { Price } from "../prices/contract.ts";

// 本主机、空身份参数的契约；text 的值由下面的 Price 依赖派生。
const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });

// setup 登记工厂，工厂接收 self、声明 Price 引用、返回摘要状态，无写入/网络副作用。
// 例如第一版250分会返回带版本和价格的英文文本；Price 无法绑定时对象 parked，错误由 Chord 保存。
// Price.version 来自打包进本脚本的契约副本，不是动态询问 provider 最新版本。
export default defineFacet((host) =>
	host.serve(Summary, (_params, self) => {
		// 依赖必须与导入的契约版本/指纹匹配；工厂本身不 await，也不立即读值。
		const price = self.get(Price, {});
		// 单输入纯函数把 cents 变为字符串；下次依赖更新或重绑定时再计算。
		return { text: self.derive([price.cents], ([cents]) => `price v${Price.version}: ${cents} cents`) };
	}),
);
