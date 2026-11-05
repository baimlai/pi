// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/summary，示例插件 @example/summary 的 server facet，
// 是 prices 的消费者。
// 演示什么：闭包规则（closure rule）与 parked 对象。summary 的工厂用本插件复制来的 Price 契约声明依赖；
// prices 升到 v2 且新代码构建失败时，宿主保留 prices 旧代码，summary 的新代码因请求 v2 无法绑定也被保留旧代码。
// 修复后，新 summary 在报告里 parked，等新 Price 就绪后推导出 v2 文本。
// 上游入口：buildFacet 复制 ../prices/contract.ts；evaluateFacet 求值；host.reload 的 staging/closure 规则。
// 下游依赖：@earendil-works/chord 的 defineFacet/local/str；prices 的契约副本；package.json 的 name 是插件身份。
// 能力清单：Summary 契约（local、空 params、成员 text: str）；default facet 的工厂（Price 引用 + derive）。
// 示例（真实签名）：
//   const facet = defineFacet((host) => host.serve(Summary, (_params, self) => {
//     const price = self.get(Price, {});
//     return { text: self.derive([price.cents], ([cents]) => `price v${Price.version}: ${cents} cents`) };
//   }));
// 典型运行：第 2 幕 failed summary 文本为 "needs example.price v2, which plugin ... serves on its old code"；
// 第 3 幕 objects 行显示 "example.summary parked"，随后 running 里仍是旧文本，直到 then 行变为 "price v2: 300 cents"。
// 建议阅读顺序：导入 -> Summary 契约 -> 工厂 -> Price 引用 -> derive。
// The summary plugin's server facet: a consumer of the prices plugin's `Price`, at the version its copy of the
// contract declares.

// defineFacet/local/str 用于声明；Price 来自另一个插件目录，构建时被内联为副本（只允许宿主包和本插件文件）。
import { defineFacet, local, str } from "@earendil-works/chord";
import { Price } from "../prices/contract.ts";

// 本主机、空身份参数的契约；text 的值由下面的 Price 依赖派生。
const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });

// setup 登记工厂，工厂接收 self、声明 Price 引用、返回摘要状态，无写入/网络副作用。
// 例如第一版250分会返回带版本和价格的英文文本；Price 无法绑定时对象为 failed/waiting，重载时新代码可能先以
// parked 出现在报告里，等依赖就绪后再 live。
// Price.version 来自打包进本脚本的契约副本，不是动态询问 provider 最新版本。
// 下划线前缀的 _params 只是未使用参数的命名约定，类型仍由契约推断。
export default defineFacet((host) =>
	host.serve(Summary, (_params, self) => {
		// 依赖必须与导入的契约版本/指纹匹配；工厂本身不 await，也不立即读值。
		// self.get 同步登记请求；绑定发生在激活阶段，失败或未就绪会让本对象等待。
		const price = self.get(Price, {});
		// 单输入纯函数把 cents 变为字符串；下次依赖更新或重绑定时再计算。
		// sources 数组按位置解构；模板字符串里的 Price.version 是构建时复制进本脚本的契约版本。
		return { text: self.derive([price.cents], ([cents]) => `price v${Price.version}: ${cents} cents`) };
	}),
);
