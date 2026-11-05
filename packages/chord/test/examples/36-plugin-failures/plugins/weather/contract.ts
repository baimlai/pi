// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/weather/contract.ts，@example/weather 的契约文件，
// 被 forecast 插件复制导入。
// 演示什么：没有工厂的契约文件。weather 的 server facet 在启动时失败，这个契约仍被 forecast 的构建内联；绑定失败
// 使 forecast 停在 failed/waiting。
// 上游入口：weather/server.ts 与 forecast/server.ts 的 import；buildFacet 把跨插件文件复制进各自脚本并列在 copied。
// 下游依赖：@earendil-works/chord 的 int/local；上一级 package.json 的 name 是插件身份。
// 能力清单：Weather 契约（local、空 params、成员 celsius: int）。
// 示例（真实签名）：const Weather = local("example.weather", { version: 1, params: {}, members: { celsius: int() } });
// 典型运行：启动 weather 未被服务；forecast 的 failed cause 显示 waiting for example.weather。
// 注意：契约文件本身不声明 setup，不会被当作 facet 加载；只有导入它的 server facet 才会服务 Weather。
// 建议阅读顺序：导入 -> Weather 契约。
// The weather plugin's contract; the forecast plugin imports (copies) it.

// int 声明整数成员 schema；local 声明仅本主机可见的契约。
import { int, local } from "@earendil-works/chord";

/** Today's temperature. */
// 独立的契约文件没有工厂/请求；forecast 把它复制进自己的脚本，以名称、版本、形状向 provider 绑定。
// 空 params 的 local 对象具有主机生命周期；celsius 整数状态不是在此计算的温度。
// 这里的 int() 只描述成员 schema，不产生值时也不会被逐次校验。
export const Weather = local("example.weather", { version: 1, params: {}, members: { celsius: int() } });
